// dsh-rw — bounded ssh2 connection/channel lifetimes. A caller deadline covers
// connect, open and business I/O; dispatched mutations are never replayed.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import ssh2 from 'ssh2';
import { mapConnectError, mapSftpError, RwError } from './errors.js';
import { expandHome } from './hosts.js';
import { assertRemoteIoActive, currentRemoteIoOptions, ownRemoteIoResource } from './io-context.js';
const { Client: Ssh2Client, utils } = ssh2;
const MAX_TIMER_DELAY = 2_147_483_647;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const acquisitionFailures = new WeakMap();
const guardedSftp = new WeakSet();
const guardedStreams = new WeakSet();
function positiveTimeout(ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        throw new RwError('INVALID_INPUT', 'remote I/O timeout must be a positive finite number');
    return ms;
}
function constrain(options, inherited) {
    const ambient = currentRemoteIoOptions();
    const now = performance.now();
    const wall = Date.now();
    let end = inherited?.end ?? Infinity;
    const signals = new Set(inherited?.signals ?? []);
    for (const opt of [ambient, options]) {
        if (opt?.signal !== undefined)
            signals.add(opt.signal);
        if (opt?.timeoutMs !== undefined)
            end = Math.min(end, now + positiveTimeout(opt.timeoutMs));
        if (opt?.deadlineMs !== undefined) {
            if (!Number.isFinite(opt.deadlineMs))
                throw new RwError('INVALID_INPUT', 'remote I/O deadline must be finite');
            end = Math.min(end, now + opt.deadlineMs - wall);
        }
    }
    return { end, signals: [...signals] };
}
function budget(options, fallbackMs, inherited) {
    const bound = constrain(options, inherited);
    const relative = options?.timeoutMs ?? fallbackMs;
    return { ...bound, end: Math.min(bound.end, performance.now() + positiveTimeout(relative)) };
}
function phaseBound(bound, maximumMs) {
    return { ...bound, end: Math.min(bound.end, performance.now() + positiveTimeout(maximumMs)) };
}
function ioError(bound, label, outcome) {
    const stopped = bound.signals.find(signal => signal.aborted);
    const reason = stopped?.reason;
    const timeout = stopped === undefined ||
        reason instanceof RwError && reason.code === 'OPERATION_TIMEOUT' ||
        reason?.code === 'TOOL_TIMEOUT';
    return new RwError(timeout ? 'OPERATION_TIMEOUT' : 'OPERATION_ABORTED', `${label} ${timeout ? 'deadline elapsed' : 'cancelled'}; ` +
        (outcome === 'unknown' ? 'remote outcome is unknown; it may already have executed and was not retried' : 'remote business operation was not started'), { cause: reason, outcome });
}
function assertBound(bound, label, outcome = 'not-started') {
    if (bound.signals.some(signal => signal.aborted) || bound.end <= performance.now())
        throw ioError(bound, label, outcome);
}
/** Fixed elapsed-time chunks: clock corrections never renew a running deadline. */
function watchBound(bound, stopped) {
    let timer;
    let disposed = false;
    const cleanup = () => {
        disposed = true;
        if (timer !== undefined)
            clearTimeout(timer);
        for (const signal of bound.signals)
            signal.removeEventListener('abort', fire);
    };
    const fire = () => { if (!disposed) {
        cleanup();
        stopped();
    } };
    const arm = (remaining) => {
        if (remaining <= 0) {
            fire();
            return;
        }
        const chunk = Math.min(remaining, MAX_TIMER_DELAY);
        timer = setTimeout(() => arm(remaining - chunk), chunk);
    };
    for (const signal of bound.signals)
        signal.addEventListener('abort', fire, { once: true });
    if (bound.signals.some(signal => signal.aborted))
        fire();
    else if (Number.isFinite(bound.end))
        arm(bound.end - performance.now());
    return cleanup;
}
function notStartedFailure(error) {
    const mapped = error instanceof RwError ? error : mapConnectError(error);
    return new RwError(mapped.code, mapped.message, { cause: error, outcome: 'not-started' });
}
function unknownFailure(error, label) {
    const mapped = error instanceof RwError ? error : mapConnectError(error);
    return new RwError(mapped.code, `${label}: ${mapped.message}; remote outcome is unknown and was not retried`, { cause: error, outcome: 'unknown' });
}
function guardSftpAcquisition(raw) {
    if (guardedSftp.has(raw))
        return;
    guardedSftp.add(raw);
    // ssh2 removes its ready-phase listeners before invoking our callback. Guard
    // the short promise-handoff window as well as late errors after local close.
    raw.on?.('error', (error) => acquisitionFailures.set(raw, mapSftpError(error)));
    raw.once?.('end', () => acquisitionFailures.set(raw, new RwError('NOT_CONNECTED', 'SFTP ended during handoff')));
    raw.once?.('close', () => acquisitionFailures.set(raw, new RwError('NOT_CONNECTED', 'SFTP closed during handoff')));
    if (raw.readable === false)
        acquisitionFailures.set(raw, new RwError('NOT_CONNECTED', 'SFTP is already closed'));
}
function closeSftp(raw) {
    guardSftpAcquisition(raw);
    try {
        raw.end();
    }
    catch {
        try {
            raw.destroy();
        }
        catch { /* already gone */ }
    }
}
function closeStream(stream) {
    if (!guardedStreams.has(stream)) {
        guardedStreams.add(stream);
        stream.on('error', () => undefined);
    }
    try {
        stream.close();
    }
    catch { /* already closed */ }
    try {
        stream.destroy();
    }
    catch { /* already destroyed */ }
}
function shellQuote(s) { return `'${s.replace(/'/g, `'\\''`)}'`; }
function toStatLike(stats) {
    return { isDirectory: () => stats.isDirectory(), isSymbolicLink: () => stats.isSymbolicLink(), size: stats.size, mtime: stats.mtime };
}
class SafeOpenFailure extends Error {
    error;
    constructor(error) {
        super(error.message);
        this.error = error;
        this.name = 'SafeOpenFailure';
    }
}
/** This facade, not the shared Client, owns SFTP callbacks and cancellation. */
function wrapSftp(raw, lifetime, timeoutMs, alias, onRetired) {
    let closed = false;
    let closedCause;
    const pending = new Set();
    let unwatch = () => undefined;
    let disown = () => undefined;
    let detachClient = () => undefined;
    const terminate = (error) => {
        if (closed)
            return;
        closed = true;
        closedCause = error;
        unwatch();
        disown();
        detachClient();
        for (const fail of [...pending])
            fail(error);
        pending.clear();
        closeSftp(raw);
    };
    // Kept attached after local close so a late ssh2 error cannot crash the Host.
    raw.on?.('error', (error) => { if (!closed)
        terminate(mapSftpError(error)); });
    raw.once?.('end', () => terminate(new RwError('NOT_CONNECTED', `SFTP channel for ${alias} ended`)));
    raw.once?.('close', () => terminate(new RwError('NOT_CONNECTED', `SFTP channel for ${alias} closed`)));
    detachClient = onRetired(error => terminate(error));
    disown = ownRemoteIoResource(() => terminate(new RwError('NOT_CONNECTED', `SFTP facade for ${alias} released`)));
    unwatch = watchBound(lifetime, () => terminate(ioError(lifetime, `SFTP facade for ${alias}`, 'unknown')));
    if (closed)
        unwatch();
    const invoke = async (name, mutating, dispatch) => {
        assertRemoteIoActive();
        const bound = budget(undefined, timeoutMs, lifetime);
        if (closed)
            return Promise.reject(new RwError('NOT_CONNECTED', `${name}: SFTP facade for ${alias} is closed`, { cause: closedCause, outcome: 'not-started' }));
        try {
            assertBound(bound, `${name} on ${alias}`);
        }
        catch (error) {
            terminate(error);
            return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            let dispatched = false;
            let stop = () => undefined;
            const finish = (error, value) => {
                if (settled)
                    return;
                settled = true;
                stop();
                pending.delete(fail);
                if (error !== undefined && error !== null) {
                    const mapped = error instanceof RwError ? error : mapSftpError(error);
                    reject(dispatched && mutating ? unknownFailure(mapped, `${name} on ${alias}`) : mapped);
                }
                else
                    resolve(value);
            };
            const fail = (error) => finish(dispatched
                ? unknownFailure(error, `${name} on ${alias}`)
                : new RwError(error.code, `${name} on ${alias}: ${error.message}`, { cause: error, outcome: 'not-started' }));
            pending.add(fail);
            stop = watchBound(bound, () => terminate(ioError(bound, `${name} on ${alias}`, dispatched ? 'unknown' : 'not-started')));
            if (settled) {
                stop();
                return;
            }
            try {
                assertBound(bound, `${name} on ${alias}`);
                dispatched = true;
                dispatch((error, value) => {
                    if (settled)
                        return;
                    try {
                        assertBound(bound, `${name} on ${alias}`, 'unknown');
                    }
                    catch (late) {
                        terminate(late);
                        return;
                    }
                    finish(error, value);
                });
            }
            catch (error) {
                finish(error);
            }
        });
    };
    return {
        readdir: p => invoke('readdir', false, done => raw.readdir(p, (err, list) => {
            if (err) {
                done(err);
                return;
            }
            try {
                done(undefined, list.map(f => ({ filename: f.filename, longname: f.longname, attrs: toStatLike(f.attrs) })));
            }
            catch (error) {
                done(error);
            }
        })),
        stat: p => invoke('stat', false, done => raw.stat(p, (err, stats) => {
            if (err) {
                done(err);
                return;
            }
            try {
                done(undefined, toStatLike(stats));
            }
            catch (error) {
                done(error);
            }
        })),
        lstat: p => invoke('lstat', false, done => raw.lstat(p, (err, stats) => {
            if (err) {
                done(err);
                return;
            }
            try {
                done(undefined, toStatLike(stats));
            }
            catch (error) {
                done(error);
            }
        })),
        realpath: p => invoke('realpath', false, done => raw.realpath(p, (err, value) => done(err, value))),
        readFile: p => invoke('readFile', false, done => raw.readFile(p, (err, value) => done(err, value))),
        writeFile: (p, data) => invoke('writeFile', true, done => raw.writeFile(p, data, err => done(err))),
        mkdir: p => invoke('mkdir', true, done => raw.mkdir(p, err => done(err))),
        rename: (src, dst) => invoke('rename', true, done => raw.rename(src, dst, err => done(err))),
        unlink: p => invoke('unlink', true, done => raw.unlink(p, err => done(err))),
        rmdir: p => invoke('rmdir', true, done => raw.rmdir(p, err => done(err))),
        close: () => terminate(new RwError('NOT_CONNECTED', `SFTP facade for ${alias} released`)),
    };
}
export class SshPool {
    opts;
    factory;
    pool = new Map();
    readyAliases = new Set();
    retired = new WeakSet();
    retirementListeners = new WeakMap();
    constructor(opts) {
        this.opts = opts;
        positiveTimeout(opts.connectTimeoutMs);
        positiveTimeout(opts.commandTimeoutMs);
        positiveTimeout(opts.channelOpenTimeoutMs ?? 10000);
        positiveTimeout(opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
        this.factory = opts.clientFactory ?? (() => new Ssh2Client());
    }
    listenRetired(client, listener) {
        if (this.retired.has(client)) {
            listener(new RwError('NOT_CONNECTED', 'SSH client was retired'));
            return () => undefined;
        }
        const listeners = this.retirementListeners.get(client) ?? new Set();
        this.retirementListeners.set(client, listeners);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }
    /** Retire the exact generation; an old event can never close a replacement. */
    retire(alias, client, error = new RwError('NOT_CONNECTED', `connection to ${alias} retired`)) {
        if (this.retired.has(client))
            return;
        this.retired.add(client);
        const own = this.pool.get(alias);
        if (own?.client === client) {
            this.pool.delete(alias);
            this.readyAliases.delete(alias);
            own.cancelReady?.(error);
        }
        const listeners = this.retirementListeners.get(client);
        if (listeners !== undefined) {
            for (const listener of [...listeners]) {
                try {
                    listener(error);
                }
                catch { /* one consumer cannot strand the others */ }
            }
            listeners.clear();
        }
        try {
            if (typeof client.destroy === 'function')
                client.destroy();
            else
                client.end();
        }
        catch { /* already gone */ }
    }
    waitReady(entry, bound) {
        assertBound(bound, `SSH connect to ${entry.alias}`);
        const ready = this.ensureConnected(entry);
        return new Promise((resolve, reject) => {
            let settled = false;
            let stop = () => undefined;
            const finish = (error, client) => {
                if (settled)
                    return;
                settled = true;
                stop();
                if (error !== undefined)
                    reject(notStartedFailure(error));
                else
                    resolve(client);
            };
            stop = watchBound(bound, () => finish(ioError(bound, `SSH connect to ${entry.alias}`, 'not-started')));
            ready.then(client => {
                try {
                    assertBound(bound, `SSH connect to ${entry.alias}`);
                    finish(undefined, client);
                }
                catch (error) {
                    finish(error);
                }
            }, error => finish(error));
        });
    }
    /** The command budget includes connect/open/run. After dispatch, no replay. */
    async exec(entry, command, options) {
        assertRemoteIoActive();
        const bound = budget(options, this.opts.commandTimeoutMs);
        const cmd = options?.cwd ? `cd ${shellQuote(options.cwd)} && ${command}` : command;
        for (let retried = false;; retried = true) {
            assertBound(bound, `exec on ${entry.alias}`);
            const client = await this.waitReady(entry, bound);
            try {
                return await this.execOn(entry, client, cmd, bound);
            }
            catch (error) {
                if (!(error instanceof SafeOpenFailure))
                    throw error;
                if (retried || !this.retired.has(client))
                    throw error.error;
                assertBound(bound, `exec retry on ${entry.alias}`);
            }
        }
    }
    execOn(entry, client, cmd, bound) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let dispatched = false;
            let stream;
            let stop = () => undefined;
            let detach = () => undefined;
            let stdout = '', stderr = '', outTrunc = false, errTrunc = false;
            let code = null, signal = null;
            const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
            const finish = (error) => {
                if (settled)
                    return;
                if (error === undefined) {
                    try {
                        assertBound(bound, `exec on ${entry.alias}`, 'unknown');
                    }
                    catch (late) {
                        error = late;
                    }
                    if (error === undefined && code === null && signal === null) {
                        error = new RwError('REMOTE_ERROR', `exec on ${entry.alias} closed without an exit status or signal; remote outcome is unknown and was not retried`, { outcome: 'unknown' });
                    }
                }
                settled = true;
                stop();
                detach();
                if (error !== undefined) {
                    reject(error);
                    if (stream !== undefined)
                        closeStream(stream);
                }
                else
                    resolve({ code, signal, stdout: outTrunc ? `${stdout}\n…[truncated]` : stdout,
                        stderr: errTrunc ? `${stderr}\n…[truncated]` : stderr, timedOut: false });
            };
            const stopOpenOrRun = (active) => {
                const error = ioError(active, `exec on ${entry.alias}`, dispatched ? 'unknown' : 'not-started');
                finish(error);
                // ssh2 hides the channel until its EXEC acknowledgement. If that never
                // arrives, exact-client retirement is the only public cleanup API; it
                // can interrupt other RPCs on this same generation, which also settle.
                if (stream === undefined && dispatched)
                    this.retire(entry.alias, client);
            };
            detach = this.listenRetired(client, error => finish(dispatched ? unknownFailure(error, `exec on ${entry.alias}`) : error));
            const opening = phaseBound(bound, this.opts.channelOpenTimeoutMs ?? 10000);
            stop = watchBound(opening, () => stopOpenOrRun(opening));
            if (settled) {
                stop();
                return;
            }
            try {
                assertBound(opening, `exec open on ${entry.alias}`);
                dispatched = true;
                client.exec(cmd, (error, opened) => {
                    if (settled) {
                        if (opened !== undefined)
                            closeStream(opened);
                        return;
                    }
                    if (error) {
                        // A CHANNEL_OPEN_FAILURE reason proves the command was not sent.
                        // Healthy quota refusals fail in place and do not kill the Client.
                        if (typeof error.reason === 'number') {
                            finish(new SafeOpenFailure(new RwError(mapConnectError(error).code, error.message, { cause: error, outcome: 'not-started' })));
                        }
                        else
                            finish(unknownFailure(error, `exec open on ${entry.alias}`));
                        return;
                    }
                    stream = opened;
                    if (stream === undefined) {
                        finish(new RwError('REMOTE_ERROR', 'exec returned no channel', { outcome: 'unknown' }));
                        return;
                    }
                    try {
                        assertBound(opening, `exec open on ${entry.alias}`, 'unknown');
                    }
                    catch (late) {
                        finish(late);
                        return;
                    }
                    stop();
                    const collect = (current, chunk, decoder, truncated) => {
                        if (truncated || current.length >= this.opts.maxOutputChars)
                            return [current, true];
                        let piece = decoder.write(chunk);
                        if (current.length + piece.length > this.opts.maxOutputChars) {
                            piece = piece.slice(0, this.opts.maxOutputChars - current.length);
                            truncated = true;
                        }
                        return [current + piece, truncated];
                    };
                    stream.on('data', (chunk) => { if (!settled)
                        [stdout, outTrunc] = collect(stdout, chunk, outDecoder, outTrunc); });
                    stream.stderr.on('data', (chunk) => { if (!settled)
                        [stderr, errTrunc] = collect(stderr, chunk, errDecoder, errTrunc); });
                    stream.once('exit', (exitCode, exitSignal) => { code = exitCode; signal = exitSignal ?? null; });
                    stream.once('close', () => finish());
                    // Remains attached while a late close/destroy may emit an error.
                    stream.on('error', (error) => { if (!settled)
                        finish(unknownFailure(error, `exec on ${entry.alias}`)); });
                    stop = watchBound(bound, () => stopOpenOrRun(bound));
                    try {
                        assertBound(bound, `exec on ${entry.alias}`, 'unknown');
                    }
                    catch (error) {
                        finish(error);
                    }
                });
            }
            catch (error) {
                // A synchronous ssh2 Not-connected guard runs before channel dispatch.
                if (error instanceof Error && /not connected/i.test(error.message)) {
                    finish(new SafeOpenFailure(new RwError('NOT_CONNECTED', error.message, { cause: error, outcome: 'not-started' })));
                    this.retire(entry.alias, client);
                }
                else
                    finish(dispatched ? unknownFailure(error, `exec on ${entry.alias}`) : error);
            }
        });
    }
    async sftp(entry, options) {
        assertRemoteIoActive();
        const lifetime = constrain(options);
        const bound = budget(options, this.opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS, lifetime);
        for (let retried = false;; retried = true) {
            assertBound(bound, `SFTP acquire on ${entry.alias}`);
            const client = await this.waitReady(entry, bound);
            try {
                const raw = await this.openSftp(entry, client, bound);
                if (this.retired.has(client)) {
                    closeSftp(raw);
                    throw new RwError('NOT_CONNECTED', 'SFTP client retired during handoff', { outcome: 'not-started' });
                }
                const earlyFailure = acquisitionFailures.get(raw);
                if (earlyFailure !== undefined) {
                    closeSftp(raw);
                    throw notStartedFailure(earlyFailure);
                }
                try {
                    assertBound(bound, `SFTP acquire on ${entry.alias}`);
                }
                catch (error) {
                    closeSftp(raw);
                    throw error;
                }
                return wrapSftp(raw, lifetime, options?.timeoutMs ?? this.opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS, entry.alias, listener => this.listenRetired(client, listener));
            }
            catch (error) {
                if (error instanceof RwError && (error.code === 'OPERATION_TIMEOUT' || error.code === 'OPERATION_ABORTED'))
                    throw error;
                if (retried || !this.retired.has(client))
                    throw error;
                // The subsystem was never handed out, so no file operation started.
                assertBound(bound, `SFTP acquire retry on ${entry.alias}`);
            }
        }
    }
    openSftp(entry, client, bound) {
        const opening = phaseBound(bound, this.opts.channelOpenTimeoutMs ?? 10000);
        return new Promise((resolve, reject) => {
            let settled = false, requested = false;
            let stop = () => undefined, detach = () => undefined;
            const finish = (error, raw) => {
                if (settled) {
                    if (raw !== undefined)
                        closeSftp(raw);
                    return;
                }
                settled = true;
                stop();
                detach();
                if (error !== undefined)
                    reject(notStartedFailure(error));
                else
                    resolve(raw);
            };
            detach = this.listenRetired(client, error => finish(error));
            stop = watchBound(opening, () => {
                finish(ioError(opening, `SFTP open on ${entry.alias}`, 'not-started'));
                // No raw handle is exposed before callback. Do not leave an unknown
                // hidden channel alive indefinitely; retire only this exact Client.
                if (requested)
                    this.retire(entry.alias, client);
            });
            if (settled) {
                stop();
                return;
            }
            try {
                assertBound(opening, `SFTP open on ${entry.alias}`);
                requested = true;
                client.sftp((error, raw) => {
                    if (raw !== undefined)
                        guardSftpAcquisition(raw);
                    if (settled) {
                        if (raw !== undefined)
                            closeSftp(raw);
                        return;
                    }
                    if (error) {
                        finish(mapConnectError(error));
                        return;
                    }
                    if (raw === undefined) {
                        finish(new RwError('SFTP_UNAVAILABLE', 'SFTP returned no subsystem', { outcome: 'not-started' }));
                        return;
                    }
                    try {
                        assertBound(opening, `SFTP open on ${entry.alias}`);
                        finish(undefined, raw);
                    }
                    catch (error) {
                        closeSftp(raw);
                        finish(error);
                    }
                });
            }
            catch (error) {
                finish(mapConnectError(error));
                if (error instanceof Error && /not connected/i.test(error.message))
                    this.retire(entry.alias, client);
            }
        });
    }
    async testConnect(entry, options) {
        const started = performance.now();
        await this.exec(entry, 'true', options);
        return performance.now() - started;
    }
    disconnect(alias) {
        const pooled = this.pool.get(alias);
        if (pooled !== undefined)
            this.retire(alias, pooled.client);
        else
            this.readyAliases.delete(alias);
    }
    dispose() { for (const alias of [...this.pool.keys()])
        this.disconnect(alias); }
    connected() { return [...this.readyAliases]; }
    /** Opening is caller-bounded; a successful channel transfers to its manager. */
    async openShell(entry, command = 'bash --noprofile --norc', options) {
        assertRemoteIoActive();
        const bound = budget(options, this.opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
        const client = await this.waitReady(entry, bound);
        const opening = phaseBound(bound, this.opts.channelOpenTimeoutMs ?? 10000);
        return await new Promise((resolve, reject) => {
            let settled = false, requested = false;
            let stop = () => undefined, detach = () => undefined;
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                stop();
                detach();
                reject(error);
            };
            detach = this.listenRetired(client, error => fail(unknownFailure(error, `shell open on ${entry.alias}`)));
            stop = watchBound(opening, () => {
                fail(ioError(opening, `shell open on ${entry.alias}`, requested ? 'unknown' : 'not-started'));
                if (requested)
                    this.retire(entry.alias, client);
            });
            if (settled) {
                stop();
                return;
            }
            try {
                assertBound(opening, `shell open on ${entry.alias}`);
                requested = true;
                client.exec(command, (error, stream) => {
                    if (settled) {
                        if (stream !== undefined)
                            closeStream(stream);
                        return;
                    }
                    if (error) {
                        fail(unknownFailure(error, `shell open on ${entry.alias}`));
                        return;
                    }
                    if (stream === undefined) {
                        fail(new RwError('REMOTE_ERROR', 'shell returned no channel', { outcome: 'unknown' }));
                        return;
                    }
                    try {
                        assertBound(opening, `shell open on ${entry.alias}`, 'unknown');
                    }
                    catch (error) {
                        closeStream(stream);
                        fail(error);
                        return;
                    }
                    settled = true;
                    stop();
                    detach();
                    let closed = false, lastError;
                    const errors = new Set(), closers = new Set();
                    let detachLifetime = () => undefined;
                    const close = () => {
                        if (closed)
                            return;
                        closed = true;
                        detachLifetime();
                        closeStream(stream);
                        for (const cb of [...closers]) {
                            try {
                                cb();
                            }
                            catch { /* keep releasing other subscribers */ }
                        }
                        closers.clear();
                        errors.clear();
                    };
                    // Inert after close; never expose late errors as unhandled events.
                    stream.on('error', (error) => { if (closed)
                        return; lastError = error; for (const cb of [...errors]) {
                        try {
                            cb(error);
                        }
                        catch { /* keep notifying other subscribers */ }
                    } ; close(); });
                    stream.once('close', close);
                    detachLifetime = this.listenRetired(client, error => { lastError = error; for (const cb of [...errors]) {
                        try {
                            cb(error);
                        }
                        catch { /* keep notifying other subscribers */ }
                    } ; close(); });
                    resolve({
                        write: data => {
                            if (closed)
                                throw new RwError('NOT_CONNECTED', 'remote shell is closed', { outcome: 'not-started' });
                            stream.write(data);
                        },
                        onData: cb => { stream.on('data', cb); return () => { stream.removeListener('data', cb); }; },
                        onError: cb => { if (lastError !== undefined)
                            queueMicrotask(() => cb(lastError));
                        else
                            errors.add(cb); return () => { errors.delete(cb); }; },
                        onClose: cb => { if (closed)
                            queueMicrotask(cb);
                        else
                            closers.add(cb); return () => { closers.delete(cb); }; },
                        close,
                    });
                });
            }
            catch (error) {
                fail(requested ? unknownFailure(error, `shell open on ${entry.alias}`) : error);
            }
        });
    }
    /** A shared dial is pool-owned; one cancelled waiter cannot cancel other waiters. */
    ensureConnected(entry) {
        const existing = this.pool.get(entry.alias);
        if (existing !== undefined)
            return existing.ready;
        const client = this.factory();
        let resolveReady, rejectReady;
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        const pooled = { client, ready };
        this.pool.set(entry.alias, pooled);
        let settled = false, hostKeyFailure;
        const connectBound = { end: performance.now() + positiveTimeout(this.opts.connectTimeoutMs), signals: [] };
        let stop = () => undefined;
        const reject = (error) => {
            if (!settled) {
                settled = true;
                stop();
                rejectReady(error);
            }
            this.retire(entry.alias, client, error instanceof RwError ? error : mapConnectError(error));
        };
        pooled.cancelReady = error => {
            if (!settled) {
                settled = true;
                stop();
                rejectReady(error);
            }
        };
        client.once('ready', () => {
            if (settled || this.retired.has(client) || this.pool.get(entry.alias)?.client !== client)
                return;
            settled = true;
            stop();
            this.readyAliases.add(entry.alias);
            resolveReady(client);
        });
        // Attached for this client's entire lifetime; every mutation is generation-aware.
        client.on('error', (error) => reject(hostKeyFailure ?? mapConnectError(error)));
        client.on('close', () => reject(hostKeyFailure ?? new RwError('NOT_CONNECTED', `connection to ${entry.alias} closed`)));
        stop = watchBound(connectBound, () => reject(new RwError('CONN_TIMEOUT', `connection to ${entry.alias} timed out`, { outcome: 'not-started' })));
        try {
            client.connect(this.buildConfig(entry, error => { hostKeyFailure = error; }));
        }
        catch (error) {
            reject(error instanceof RwError ? error : mapConnectError(error));
        }
        // Consume this housekeeping branch without touching a replacement generation.
        ready.catch(() => { if (this.pool.get(entry.alias)?.client === client)
            this.retire(entry.alias, client); });
        return ready;
    }
    buildConfig(entry, recordHostKeyFailure) {
        const config = { host: entry.host, port: entry.port, username: entry.user,
            readyTimeout: this.opts.connectTimeoutMs, keepaliveInterval: 15000, keepaliveCountMax: 3 };
        if (entry.auth.kind === 'password') {
            if (!entry.auth.password)
                throw new RwError('AUTH_FAILED', `no credentials configured for host "${entry.alias}"`);
            config.password = entry.auth.password;
        }
        else {
            if (!entry.auth.keyPath)
                throw new RwError('AUTH_FAILED', `no credentials configured for host "${entry.alias}"`);
            try {
                config.privateKey = readFileSync(expandHome(entry.auth.keyPath));
            }
            catch {
                throw new RwError('AUTH_FAILED', `private key not readable: ${entry.auth.keyPath}`);
            }
            if (entry.auth.passphrase)
                config.passphrase = entry.auth.passphrase;
        }
        if (this.opts.hostKeyPolicy !== 'off')
            config.hostVerifier = (key) => this.verifyHostKey(entry, key, recordHostKeyFailure);
        return config;
    }
    verifyHostKey(entry, key, record) {
        const parsed = utils.parseKey(key);
        if (parsed instanceof Error) {
            record(new RwError('HOSTKEY_VERIFY_FAILED', `cannot parse host key presented by ${entry.host}:${entry.port}`));
            return false;
        }
        const base64 = key.toString('base64'), where = `${entry.host}:${entry.port}`;
        switch (this.opts.knownHosts.verify(entry.host, entry.port, parsed.type, base64)) {
            case 'match': return true;
            case 'unknown':
                if (this.opts.hostKeyPolicy === 'accept-new') {
                    this.opts.knownHosts.accept(entry.host, entry.port, parsed.type, base64);
                    return true;
                }
                record(new RwError('HOSTKEY_UNKNOWN', `host key for ${where} is not in known_hosts (policy: strict)`));
                return false;
            case 'changed':
                record(new RwError('HOSTKEY_CHANGED', `host key for ${where} has CHANGED — possible MITM or host rebuild; review and fix the entry in ${this.opts.knownHosts.path} manually`));
                return false;
        }
    }
}
