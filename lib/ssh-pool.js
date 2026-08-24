// dsh-rw — persistent ssh2 connection pool with host key verification.
//
// One long-lived connection per host alias; concurrent connects are deduped
// through an in-flight promise; a closed (or errored) connection drops out of
// the pool and the next use reconnects lazily. On top of that lazy reconnect,
// an operation whose channel/subsystem open fails on a client that has
// already dropped out of the pool (i.e. the connection died) is retried once
// on a fresh connection instead of surfacing a transient error. Channel opens
// are bounded by channelOpenTimeoutMs, so a silently dead connection
// (half-open TCP: no error, no close, no answer) is killed and retried within
// that window instead of hanging until keepalive detection. Host key policy
// is enforced via ssh2's sync hostVerifier hook against a KnownHosts store
// ('off' disables the hook entirely, matching ssh -o
// StrictHostKeyChecking=no).
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import ssh2 from 'ssh2';
const { Client: Ssh2Client, utils } = ssh2;
import { mapConnectError, RwError } from './errors.js';
import { expandHome } from './hosts.js';
/** Shell single-quote escaping: 'a'b' → 'a'\''b' */
function shellQuote(s) {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
function toStatLike(stats) {
    return {
        isDirectory: () => stats.isDirectory(),
        isSymbolicLink: () => stats.isSymbolicLink(),
        size: stats.size,
        mtime: stats.mtime,
    };
}
function wrapSftp(raw) {
    return {
        readdir: (p) => new Promise((resolve, reject) => {
            raw.readdir(p, (err, list) => {
                if (err)
                    reject(err);
                else
                    resolve(list.map((f) => ({ filename: f.filename, longname: f.longname, attrs: toStatLike(f.attrs) })));
            });
        }),
        stat: (p) => new Promise((resolve, reject) => {
            raw.stat(p, (err, stats) => (err ? reject(err) : resolve(toStatLike(stats))));
        }),
        lstat: (p) => new Promise((resolve, reject) => {
            raw.lstat(p, (err, stats) => (err ? reject(err) : resolve(toStatLike(stats))));
        }),
        realpath: (p) => new Promise((resolve, reject) => {
            raw.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)));
        }),
        readFile: (p) => new Promise((resolve, reject) => {
            raw.readFile(p, (err, data) => (err ? reject(err) : resolve(data)));
        }),
        writeFile: (p, data) => new Promise((resolve, reject) => {
            raw.writeFile(p, data, (err) => (err ? reject(err) : resolve()));
        }),
        mkdir: (p) => new Promise((resolve, reject) => {
            raw.mkdir(p, (err) => (err ? reject(err) : resolve()));
        }),
        rename: (src, dst) => new Promise((resolve, reject) => {
            raw.rename(src, dst, (err) => (err ? reject(err) : resolve()));
        }),
        unlink: (p) => new Promise((resolve, reject) => {
            raw.unlink(p, (err) => (err ? reject(err) : resolve()));
        }),
        rmdir: (p) => new Promise((resolve, reject) => {
            raw.rmdir(p, (err) => (err ? reject(err) : resolve()));
        }),
    };
}
/**
 * Internal marker for exec(): the channel never opened, so the command did
 * not run remotely and the attempt is safe to retry on a fresh connection.
 * `error` is the mapped error to surface when no retry happens.
 */
class ChannelOpenError extends Error {
    error;
    constructor(error) {
        super(error.message);
        this.name = 'ChannelOpenError';
        this.error = error;
    }
}
/**
 * Internal marker: the channel/subsystem open did not answer within
 * channelOpenTimeoutMs. On a silently dead connection (half-open TCP —
 * network gone without RST) the open neither succeeds nor fails promptly;
 * without this bound the call would hang until keepalive detection (~45s).
 * The open never completed, so nothing ran remotely and a retry on a fresh
 * connection is safe.
 */
class OpenTimeoutError extends Error {
    constructor() {
        super('channel open timed out');
        this.name = 'OpenTimeoutError';
    }
}
export class SshPool {
    opts;
    factory;
    pool = new Map();
    readyAliases = new Set();
    constructor(opts) {
        this.opts = opts;
        this.factory = opts.clientFactory ?? (() => new Ssh2Client());
    }
    /**
     * Run a remote command. opts.cwd prefixes `cd <cwd> &&`. Command timeouts
     * do not reject — they resolve with timedOut: true (signal 'TIMEOUT').
     * Connection/auth/host-key failures reject with RwError. When the channel
     * open fails on a connection that has already dropped out of the pool (it
     * died), the operation is retried once on a fresh connection; stream
     * failures after a successful open are never retried (the command may have
     * partially run).
     */
    async exec(entry, command, opts) {
        const cmd = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ${command}` : command;
        const timeoutMs = opts?.timeoutMs ?? this.opts.commandTimeoutMs;
        const openTimeoutMs = this.opts.channelOpenTimeoutMs ?? 10000;
        const max = this.opts.maxOutputChars;
        for (let retried = false;; retried = true) {
            const client = await this.ensureConnected(entry);
            try {
                return await this.execOn(client, cmd, timeoutMs, openTimeoutMs, max);
            }
            catch (err) {
                // A silently dead connection is dropped on open timeout (we kill it
                // ourselves below), so both failure kinds converge: not-yet-retried +
                // known-dead connection → one redial + retry. Anything else surfaces
                // exactly as before (business errors, post-open stream failures).
                if (err instanceof OpenTimeoutError) {
                    if (retried)
                        throw new RwError('CONN_TIMEOUT', `channel open timed out after ${openTimeoutMs}ms (connection to ${entry.alias} is unresponsive)`);
                    this.disconnect(entry.alias);
                    continue;
                }
                if (!(err instanceof ChannelOpenError))
                    throw err;
                if (retried || !this.dropped(entry.alias, client))
                    throw err.error;
                this.disconnect(entry.alias);
            }
        }
    }
    /** Single exec attempt on an already-connected client. */
    execOn(client, cmd, timeoutMs, openTimeoutMs, max) {
        return new Promise((resolve, reject) => {
            // Open-phase guard: if the exec callback does not fire within
            // openTimeoutMs (silently dead connection), fail the attempt. The late
            // callback — fired when the pool kills the client — is ignored via
            // openSettled.
            let openSettled = false;
            const openTimer = setTimeout(() => {
                if (openSettled)
                    return;
                openSettled = true;
                reject(new OpenTimeoutError());
            }, openTimeoutMs);
            client.exec(cmd, (execErr, stream) => {
                if (openSettled)
                    return;
                openSettled = true;
                clearTimeout(openTimer);
                if (execErr) {
                    reject(new ChannelOpenError(mapConnectError(execErr)));
                    return;
                }
                let stdout = '';
                let stderr = '';
                let stdoutTrunc = false;
                let stderrTrunc = false;
                let timedOut = false;
                let settled = false;
                // 'exit' carries code/signal but is optional per the SSH spec; 'close'
                // always fires. Record on exit, resolve on close.
                let exitCode = null;
                let exitSignal = null;
                const outDecoder = new StringDecoder('utf8');
                const errDecoder = new StringDecoder('utf8');
                const timer = setTimeout(() => {
                    timedOut = true;
                    try {
                        stream.close();
                    }
                    catch {
                        // stream may already be half-closed; the result stands either way
                    }
                    finish(null, 'TIMEOUT');
                }, timeoutMs);
                const finish = (code, signal) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    resolve({
                        code,
                        signal,
                        stdout: stdoutTrunc ? `${stdout}\n…[truncated]` : stdout,
                        stderr: stderrTrunc ? `${stderr}\n…[truncated]` : stderr,
                        timedOut,
                    });
                };
                const collect = (cur, chunk, decoder, truncated) => {
                    if (truncated || cur.length >= max)
                        return [cur, true];
                    let piece = decoder.write(chunk);
                    if (cur.length + piece.length > max) {
                        piece = piece.slice(0, max - cur.length);
                        truncated = true;
                    }
                    return [cur + piece, truncated];
                };
                stream.on('data', (chunk) => {
                    ;
                    [stdout, stdoutTrunc] = collect(stdout, chunk, outDecoder, stdoutTrunc);
                });
                stream.stderr.on('data', (chunk) => {
                    ;
                    [stderr, stderrTrunc] = collect(stderr, chunk, errDecoder, stderrTrunc);
                });
                stream.once('exit', (code, signal) => {
                    exitCode = code;
                    exitSignal = signal ?? null;
                });
                stream.on('close', () => {
                    finish(exitCode, exitSignal);
                });
                stream.on('error', (streamErr) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    reject(mapConnectError(streamErr));
                });
            });
        });
    }
    /**
     * Acquire the SFTP subsystem. The open is bounded by channelOpenTimeoutMs
     * and retried once when it fails or times out on a dead connection, and
     * each returned op re-acquires the subsystem and retries once when its
     * connection died after acquisition. Remote business errors (the client
     * stays pooled) surface unchanged.
     */
    async sftp(entry) {
        const alias = entry.alias;
        const openTimeoutMs = this.opts.channelOpenTimeoutMs ?? 10000;
        /** Open the subsystem on a pooled connection, redialing once on a dropped one. */
        const acquire = async () => {
            for (let retried = false;; retried = true) {
                const client = await this.ensureConnected(entry);
                try {
                    const raw = await new Promise((resolve, reject) => {
                        // Same open-phase bound as execOn: a silently dead connection
                        // neither answers nor fails promptly without it.
                        let settled = false;
                        const openTimer = setTimeout(() => {
                            if (settled)
                                return;
                            settled = true;
                            reject(new OpenTimeoutError());
                        }, openTimeoutMs);
                        client.sftp((err, sftp) => {
                            if (settled)
                                return;
                            settled = true;
                            clearTimeout(openTimer);
                            if (err)
                                reject(mapConnectError(err));
                            else
                                resolve(sftp);
                        });
                    });
                    return { client, like: wrapSftp(raw) };
                }
                catch (err) {
                    if (err instanceof OpenTimeoutError) {
                        if (retried)
                            throw new RwError('CONN_TIMEOUT', `sftp open timed out after ${openTimeoutMs}ms (connection to ${alias} is unresponsive)`);
                        this.disconnect(alias);
                        continue;
                    }
                    if (retried || !this.dropped(alias, client))
                        throw err;
                    this.disconnect(alias);
                }
            }
        };
        let current = await acquire();
        /** Run one op, re-acquiring the subsystem once when its connection died. */
        const withReconnect = async (op) => {
            try {
                return await op(current.like);
            }
            catch (err) {
                if (!this.dropped(alias, current.client))
                    throw err;
                this.disconnect(alias);
                current = await acquire();
                return await op(current.like); // a second failure surfaces as-is
            }
        };
        return {
            readdir: (p) => withReconnect((s) => s.readdir(p)),
            stat: (p) => withReconnect((s) => s.stat(p)),
            lstat: (p) => withReconnect((s) => s.lstat(p)),
            realpath: (p) => withReconnect((s) => s.realpath(p)),
            readFile: (p) => withReconnect((s) => s.readFile(p)),
            writeFile: (p, data) => withReconnect((s) => s.writeFile(p, data)),
            mkdir: (p) => withReconnect((s) => s.mkdir(p)),
            rename: (src, dst) => withReconnect((s) => s.rename(src, dst)),
            unlink: (p) => withReconnect((s) => s.unlink(p)),
            rmdir: (p) => withReconnect((s) => s.rmdir(p)),
        };
    }
    /** Round-trip probe: resolves with the latency in ms, rejects with RwError. */
    async testConnect(entry) {
        const start = Date.now();
        await this.exec(entry, 'true');
        return Date.now() - start;
    }
    disconnect(alias) {
        const pooled = this.pool.get(alias);
        this.pool.delete(alias);
        this.readyAliases.delete(alias);
        if (pooled) {
            try {
                pooled.client.end();
            }
            catch {
                // already dead — nothing to do
            }
        }
    }
    /**
     * Connection-level retry discriminator: the pool no longer holds this
     * client, i.e. ssh2 signalled its death and it dropped out. Remote business
     * errors keep the client pooled, so they never pass this check.
     */
    dropped(alias, client) {
        return this.pool.get(alias)?.client !== client;
    }
    dispose() {
        for (const alias of [...this.pool.keys()])
            this.disconnect(alias);
    }
    /** Aliases with an established (ready) connection — for status display. */
    connected() {
        return [...this.readyAliases];
    }
    ensureConnected(entry) {
        const pooled = this.pool.get(entry.alias);
        if (pooled)
            return pooled.ready;
        const client = this.factory();
        let settled = false;
        // When hostVerifier rejects a key ssh2 only raises a generic error, so the
        // verifier records the precise reason here and the 'error' handler
        // prefers it over ssh2's message.
        let hostKeyFailure;
        const ready = new Promise((resolve, reject) => {
            let config;
            try {
                config = this.buildConfig(entry, (e) => {
                    hostKeyFailure = e;
                });
            }
            catch (err) {
                reject(err); // credential problems: no point dialing at all
                return;
            }
            client.once('ready', () => {
                settled = true;
                this.readyAliases.add(entry.alias);
                resolve(client);
            });
            // Kept attached for the connection's lifetime so late errors cannot
            // become unhandled 'error' events; pre-ready it decides the handshake.
            // Post-ready, an error means the connection is dying: drop it from the
            // pool immediately (like 'close' does) so the retry discriminator never
            // depends on 'error'/'close' arrival order.
            client.on('error', (err) => {
                if (this.pool.get(entry.alias)?.client === client)
                    this.pool.delete(entry.alias);
                this.readyAliases.delete(entry.alias);
                if (settled)
                    return;
                settled = true;
                reject(hostKeyFailure ?? mapConnectError(err));
            });
            client.on('close', () => {
                if (this.pool.get(entry.alias)?.client === client)
                    this.pool.delete(entry.alias);
                this.readyAliases.delete(entry.alias);
                if (!settled) {
                    settled = true;
                    reject(hostKeyFailure ?? new RwError('NOT_CONNECTED', `connection to ${entry.alias} closed before ready`));
                }
            });
            try {
                client.connect(config);
            }
            catch (err) {
                settled = true;
                reject(mapConnectError(err));
            }
        });
        this.pool.set(entry.alias, { client, ready });
        // A failed handshake must not poison the pool: drop the entry so the next
        // caller dials fresh. (Also swallows the rejection for this branch; the
        // caller still receives it via `ready`.)
        ready.catch(() => {
            if (this.pool.get(entry.alias)?.client === client)
                this.pool.delete(entry.alias);
            this.readyAliases.delete(entry.alias);
        });
        return ready;
    }
    buildConfig(entry, recordHostKeyFailure) {
        const config = {
            host: entry.host,
            port: entry.port,
            username: entry.user,
            readyTimeout: this.opts.connectTimeoutMs,
            keepaliveInterval: 15000,
            keepaliveCountMax: 3,
        };
        if (entry.auth.kind === 'password') {
            if (!entry.auth.password) {
                throw new RwError('AUTH_FAILED', `no credentials configured for host "${entry.alias}"`);
            }
            config.password = entry.auth.password;
        }
        else {
            if (!entry.auth.keyPath) {
                throw new RwError('AUTH_FAILED', `no credentials configured for host "${entry.alias}"`);
            }
            try {
                // Expand `~` at the point of use: ssh-config entries arrive expanded
                // already, but manual entries and /test ad-hoc payloads may not be.
                config.privateKey = readFileSync(expandHome(entry.auth.keyPath));
            }
            catch {
                // The path is safe to disclose; the key material obviously never is.
                throw new RwError('AUTH_FAILED', `private key not readable: ${entry.auth.keyPath}`);
            }
            if (entry.auth.passphrase)
                config.passphrase = entry.auth.passphrase;
        }
        if (this.opts.hostKeyPolicy !== 'off') {
            config.hostVerifier = (key) => this.verifyHostKey(entry, key, recordHostKeyFailure);
        }
        return config;
    }
    verifyHostKey(entry, key, record) {
        const parsed = utils.parseKey(key);
        if (parsed instanceof Error) {
            record(new RwError('HOSTKEY_VERIFY_FAILED', `cannot parse host key presented by ${entry.host}:${entry.port}`));
            return false;
        }
        const keyBase64 = key.toString('base64');
        const where = `${entry.host}:${entry.port}`;
        switch (this.opts.knownHosts.verify(entry.host, entry.port, parsed.type, keyBase64)) {
            case 'match':
                return true;
            case 'unknown':
                if (this.opts.hostKeyPolicy === 'accept-new') {
                    this.opts.knownHosts.accept(entry.host, entry.port, parsed.type, keyBase64);
                    return true;
                }
                record(new RwError('HOSTKEY_UNKNOWN', `host key for ${where} is not in known_hosts (policy: strict)`));
                return false;
            case 'changed':
                record(new RwError('HOSTKEY_CHANGED', `host key for ${where} has CHANGED — possible MITM or host rebuild; ` +
                    `review and fix the entry in ${this.opts.knownHosts.path} manually`));
                return false;
        }
    }
}
