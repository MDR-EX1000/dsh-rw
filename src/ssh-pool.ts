// dsh-rw — bounded ssh2 connection/channel lifetimes. A caller deadline covers
// connect, open and business I/O; dispatched mutations are never replayed.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import ssh2 from 'ssh2'
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper, Stats } from 'ssh2'
import { mapConnectError, mapSftpError, RwError } from './errors.js'
import type { RemoteOperationOutcome } from './errors.js'
import { expandHome } from './hosts.js'
import type { HostEntry } from './hosts.js'
import type { KnownHosts } from './known-hosts.js'
import { assertRemoteIoActive, currentRemoteIoOptions, ownRemoteIoResource } from './io-context.js'
import type { RemoteIoOptions } from './io-context.js'
export type { RemoteIoOptions } from './io-context.js'

const { Client: Ssh2Client, utils } = ssh2
const MAX_TIMER_DELAY = 2_147_483_647
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const acquisitionFailures = new WeakMap<SFTPWrapper, RwError>()
const guardedSftp = new WeakSet<SFTPWrapper>()
const guardedStreams = new WeakSet<ClientChannel>()

export interface ExecResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
}
interface StatLike {
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
  mtime: number
}
export interface SftpLike {
  readdir(p: string): Promise<{ filename: string; longname: string; attrs: StatLike }[]>
  stat(p: string): Promise<StatLike>
  lstat(p: string): Promise<StatLike>
  realpath(p: string): Promise<string>
  readFile(p: string): Promise<Buffer>
  writeFile(p: string, data: Buffer): Promise<void>
  mkdir(p: string): Promise<void>
  rename(src: string, dst: string): Promise<void>
  unlink(p: string): Promise<void>
  rmdir(p: string): Promise<void>
  /** Terminal local release of this facade and its own subsystem. */
  close?(): void | Promise<void>
}
export interface RemoteShellChannel {
  write(data: string): void
  onData(cb: (chunk: Buffer) => void): void | (() => void)
  onError(cb: (err: Error) => void): void | (() => void)
  onClose(cb: () => void): void | (() => void)
  close(): void
}
export interface PoolOptions {
  hostKeyPolicy: 'accept-new' | 'strict' | 'off'
  knownHosts: KnownHosts
  connectTimeoutMs: number
  channelOpenTimeoutMs?: number
  commandTimeoutMs: number
  /** Default deadline for each SFTP business operation (30s). */
  operationTimeoutMs?: number
  maxOutputChars: number
  clientFactory?: () => Client
}
interface Pooled { client: Client; ready: Promise<Client>; cancelReady?: (error: RwError) => void }
interface IoBound { readonly end: number; readonly signals: readonly AbortSignal[] }

function positiveTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) throw new RwError('INVALID_INPUT', 'remote I/O timeout must be a positive finite number')
  return ms
}
function constrain(options?: RemoteIoOptions, inherited?: IoBound): IoBound {
  const ambient = currentRemoteIoOptions()
  const now = performance.now()
  const wall = Date.now()
  let end = inherited?.end ?? Infinity
  const signals = new Set(inherited?.signals ?? [])
  for (const opt of [ambient, options]) {
    if (opt?.signal !== undefined) signals.add(opt.signal)
    if (opt?.timeoutMs !== undefined) end = Math.min(end, now + positiveTimeout(opt.timeoutMs))
    if (opt?.deadlineMs !== undefined) {
      if (!Number.isFinite(opt.deadlineMs)) throw new RwError('INVALID_INPUT', 'remote I/O deadline must be finite')
      end = Math.min(end, now + opt.deadlineMs - wall)
    }
  }
  return { end, signals: [...signals] }
}
function budget(options: RemoteIoOptions | undefined, fallbackMs: number, inherited?: IoBound): IoBound {
  const bound = constrain(options, inherited)
  const relative = options?.timeoutMs ?? fallbackMs
  return { ...bound, end: Math.min(bound.end, performance.now() + positiveTimeout(relative)) }
}
function phaseBound(bound: IoBound, maximumMs: number): IoBound {
  return { ...bound, end: Math.min(bound.end, performance.now() + positiveTimeout(maximumMs)) }
}
function ioError(bound: IoBound, label: string, outcome: RemoteOperationOutcome): RwError {
  const stopped = bound.signals.find(signal => signal.aborted)
  const reason = stopped?.reason
  const timeout = stopped === undefined ||
    reason instanceof RwError && reason.code === 'OPERATION_TIMEOUT' ||
    (reason as { code?: unknown } | undefined)?.code === 'TOOL_TIMEOUT'
  return new RwError(timeout ? 'OPERATION_TIMEOUT' : 'OPERATION_ABORTED',
    `${label} ${timeout ? 'deadline elapsed' : 'cancelled'}; ` +
    (outcome === 'unknown' ? 'remote outcome is unknown; it may already have executed and was not retried' : 'remote business operation was not started'),
    { cause: reason, outcome })
}
function assertBound(bound: IoBound, label: string, outcome: RemoteOperationOutcome = 'not-started'): void {
  if (bound.signals.some(signal => signal.aborted) || bound.end <= performance.now()) throw ioError(bound, label, outcome)
}
/** Fixed elapsed-time chunks: clock corrections never renew a running deadline. */
function watchBound(bound: IoBound, stopped: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const cleanup = () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    for (const signal of bound.signals) signal.removeEventListener('abort', fire)
  }
  const fire = () => { if (!disposed) { cleanup(); stopped() } }
  const arm = (remaining: number) => {
    if (remaining <= 0) { fire(); return }
    const chunk = Math.min(remaining, MAX_TIMER_DELAY)
    timer = setTimeout(() => arm(remaining - chunk), chunk)
  }
  for (const signal of bound.signals) signal.addEventListener('abort', fire, { once: true })
  if (bound.signals.some(signal => signal.aborted)) fire()
  else if (Number.isFinite(bound.end)) arm(bound.end - performance.now())
  return cleanup
}
function notStartedFailure(error: unknown): RwError {
  const mapped = error instanceof RwError ? error : mapConnectError(error)
  return new RwError(mapped.code, mapped.message, { cause: error, outcome: 'not-started' })
}
function unknownFailure(error: unknown, label: string): RwError {
  const mapped = error instanceof RwError ? error : mapConnectError(error)
  return new RwError(mapped.code, `${label}: ${mapped.message}; remote outcome is unknown and was not retried`, { cause: error, outcome: 'unknown' })
}
function guardSftpAcquisition(raw: SFTPWrapper): void {
  if (guardedSftp.has(raw)) return
  guardedSftp.add(raw)
  // ssh2 removes its ready-phase listeners before invoking our callback. Guard
  // the short promise-handoff window as well as late errors after local close.
  raw.on?.('error', (error: Error) => acquisitionFailures.set(raw, mapSftpError(error)))
  raw.once?.('end', () => acquisitionFailures.set(raw, new RwError('NOT_CONNECTED', 'SFTP ended during handoff')))
  raw.once?.('close', () => acquisitionFailures.set(raw, new RwError('NOT_CONNECTED', 'SFTP closed during handoff')))
  if ((raw as SFTPWrapper & { readable?: boolean }).readable === false) acquisitionFailures.set(raw, new RwError('NOT_CONNECTED', 'SFTP is already closed'))
}
function closeSftp(raw: SFTPWrapper): void {
  guardSftpAcquisition(raw)
  try { raw.end() } catch { try { raw.destroy() } catch { /* already gone */ } }
}
function closeStream(stream: ClientChannel): void {
  if (!guardedStreams.has(stream)) { guardedStreams.add(stream); stream.on('error', () => undefined) }
  try { stream.close() } catch { /* already closed */ }
  try { stream.destroy() } catch { /* already destroyed */ }
}
function shellQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }
function toStatLike(stats: Stats): StatLike {
  return { isDirectory: () => stats.isDirectory(), isSymbolicLink: () => stats.isSymbolicLink(), size: stats.size, mtime: stats.mtime }
}
class SafeOpenFailure extends Error {
  constructor(readonly error: RwError) { super(error.message); this.name = 'SafeOpenFailure' }
}

/** This facade, not the shared Client, owns SFTP callbacks and cancellation. */
function wrapSftp(
  raw: SFTPWrapper, lifetime: IoBound, timeoutMs: number, alias: string,
  onRetired: (listener: (error: RwError) => void) => () => void,
): SftpLike {
  let closed = false
  let closedCause: RwError | undefined
  const pending = new Set<(error: RwError) => void>()
  let unwatch: () => void = () => undefined
  let disown: () => void = () => undefined
  let detachClient: () => void = () => undefined
  const terminate = (error: RwError) => {
    if (closed) return
    closed = true
    closedCause = error
    unwatch(); disown(); detachClient()
    for (const fail of [...pending]) fail(error)
    pending.clear()
    closeSftp(raw)
  }
  // Kept attached after local close so a late ssh2 error cannot crash the Host.
  raw.on?.('error', (error: Error) => { if (!closed) terminate(mapSftpError(error)) })
  raw.once?.('end', () => terminate(new RwError('NOT_CONNECTED', `SFTP channel for ${alias} ended`)))
  raw.once?.('close', () => terminate(new RwError('NOT_CONNECTED', `SFTP channel for ${alias} closed`)))
  detachClient = onRetired(error => terminate(error))
  disown = ownRemoteIoResource(() => terminate(new RwError('NOT_CONNECTED', `SFTP facade for ${alias} released`)))
  unwatch = watchBound(lifetime, () => terminate(ioError(lifetime, `SFTP facade for ${alias}`, 'unknown')))
  if (closed) unwatch()

  const invoke = async <T>(name: string, mutating: boolean, dispatch: (done: (error?: unknown, value?: T) => void) => void): Promise<T> => {
    assertRemoteIoActive()
    const bound = budget(undefined, timeoutMs, lifetime)
    if (closed) return Promise.reject(new RwError('NOT_CONNECTED', `${name}: SFTP facade for ${alias} is closed`, { cause: closedCause, outcome: 'not-started' }))
    try { assertBound(bound, `${name} on ${alias}`) } catch (error) {
      terminate(error as RwError)
      return Promise.reject(error)
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let dispatched = false
      let stop: () => void = () => undefined
      const finish = (error?: unknown, value?: T) => {
        if (settled) return
        settled = true
        stop(); pending.delete(fail)
        if (error !== undefined && error !== null) {
          const mapped = error instanceof RwError ? error : mapSftpError(error)
          reject(dispatched && mutating ? unknownFailure(mapped, `${name} on ${alias}`) : mapped)
        } else resolve(value as T)
      }
      const fail = (error: RwError) => finish(dispatched
        ? unknownFailure(error, `${name} on ${alias}`)
        : new RwError(error.code, `${name} on ${alias}: ${error.message}`, { cause: error, outcome: 'not-started' }))
      pending.add(fail)
      stop = watchBound(bound, () => terminate(ioError(bound, `${name} on ${alias}`, dispatched ? 'unknown' : 'not-started')))
      if (settled) { stop(); return }
      try {
        assertBound(bound, `${name} on ${alias}`)
        dispatched = true
        dispatch((error, value) => {
          if (settled) return
          try { assertBound(bound, `${name} on ${alias}`, 'unknown') } catch (late) { terminate(late as RwError); return }
          finish(error, value)
        })
      } catch (error) { finish(error) }
    })
  }
  return {
    readdir: p => invoke('readdir', false, done => raw.readdir(p, (err, list) => {
      if (err) { done(err); return }
      try { done(undefined, list.map(f => ({ filename: f.filename, longname: f.longname, attrs: toStatLike(f.attrs) }))) } catch (error) { done(error) }
    })),
    stat: p => invoke('stat', false, done => raw.stat(p, (err, stats) => {
      if (err) { done(err); return }
      try { done(undefined, toStatLike(stats)) } catch (error) { done(error) }
    })),
    lstat: p => invoke('lstat', false, done => raw.lstat(p, (err, stats) => {
      if (err) { done(err); return }
      try { done(undefined, toStatLike(stats)) } catch (error) { done(error) }
    })),
    realpath: p => invoke('realpath', false, done => raw.realpath(p, (err, value) => done(err, value))),
    readFile: p => invoke('readFile', false, done => raw.readFile(p, (err, value) => done(err, value))),
    writeFile: (p, data) => invoke<void>('writeFile', true, done => raw.writeFile(p, data, err => done(err))),
    mkdir: p => invoke<void>('mkdir', true, done => raw.mkdir(p, err => done(err))),
    rename: (src, dst) => invoke<void>('rename', true, done => raw.rename(src, dst, err => done(err))),
    unlink: p => invoke<void>('unlink', true, done => raw.unlink(p, err => done(err))),
    rmdir: p => invoke<void>('rmdir', true, done => raw.rmdir(p, err => done(err))),
    close: () => terminate(new RwError('NOT_CONNECTED', `SFTP facade for ${alias} released`)),
  }
}

export class SshPool {
  private readonly factory: () => Client
  private readonly pool = new Map<string, Pooled>()
  private readonly readyAliases = new Set<string>()
  private readonly retired = new WeakSet<Client>()
  private readonly retirementListeners = new WeakMap<Client, Set<(error: RwError) => void>>()

  constructor(private readonly opts: PoolOptions) {
    positiveTimeout(opts.connectTimeoutMs)
    positiveTimeout(opts.commandTimeoutMs)
    positiveTimeout(opts.channelOpenTimeoutMs ?? 10000)
    positiveTimeout(opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS)
    this.factory = opts.clientFactory ?? (() => new Ssh2Client())
  }

  private listenRetired(client: Client, listener: (error: RwError) => void): () => void {
    if (this.retired.has(client)) {
      listener(new RwError('NOT_CONNECTED', 'SSH client was retired'))
      return () => undefined
    }
    const listeners = this.retirementListeners.get(client) ?? new Set()
    this.retirementListeners.set(client, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /** Retire the exact generation; an old event can never close a replacement. */
  private retire(alias: string, client: Client, error = new RwError('NOT_CONNECTED', `connection to ${alias} retired`)): void {
    if (this.retired.has(client)) return
    this.retired.add(client)
    const own = this.pool.get(alias)
    if (own?.client === client) {
      this.pool.delete(alias)
      this.readyAliases.delete(alias)
      own.cancelReady?.(error)
    }
    const listeners = this.retirementListeners.get(client)
    if (listeners !== undefined) {
      for (const listener of [...listeners]) { try { listener(error) } catch { /* one consumer cannot strand the others */ } }
      listeners.clear()
    }
    try {
      if (typeof client.destroy === 'function') client.destroy()
      else client.end()
    } catch { /* already gone */ }
  }

  private waitReady(entry: HostEntry, bound: IoBound): Promise<Client> {
    assertBound(bound, `SSH connect to ${entry.alias}`)
    const ready = this.ensureConnected(entry)
    return new Promise<Client>((resolve, reject) => {
      let settled = false
      let stop: () => void = () => undefined
      const finish = (error?: unknown, client?: Client) => {
        if (settled) return
        settled = true; stop()
        if (error !== undefined) reject(notStartedFailure(error))
        else resolve(client!)
      }
      stop = watchBound(bound, () => finish(ioError(bound, `SSH connect to ${entry.alias}`, 'not-started')))
      ready.then(client => {
        try { assertBound(bound, `SSH connect to ${entry.alias}`); finish(undefined, client) } catch (error) { finish(error) }
      }, error => finish(error))
    })
  }

  /** The command budget includes connect/open/run. After dispatch, no replay. */
  async exec(entry: HostEntry, command: string, options?: RemoteIoOptions & { cwd?: string }): Promise<ExecResult> {
    assertRemoteIoActive()
    const bound = budget(options, this.opts.commandTimeoutMs)
    const cmd = options?.cwd ? `cd ${shellQuote(options.cwd)} && ${command}` : command
    for (let retried = false; ; retried = true) {
      assertBound(bound, `exec on ${entry.alias}`)
      const client = await this.waitReady(entry, bound)
      try { return await this.execOn(entry, client, cmd, bound) } catch (error) {
        if (!(error instanceof SafeOpenFailure)) throw error
        if (retried || !this.retired.has(client)) throw error.error
        assertBound(bound, `exec retry on ${entry.alias}`)
      }
    }
  }

  private execOn(entry: HostEntry, client: Client, cmd: string, bound: IoBound): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false
      let dispatched = false
      let stream: ClientChannel | undefined
      let stop: () => void = () => undefined
      let detach: () => void = () => undefined
      let stdout = '', stderr = '', outTrunc = false, errTrunc = false
      let code: number | null = null, signal: string | null = null
      const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8')
      const finish = (error?: unknown) => {
        if (settled) return
        if (error === undefined) {
          try { assertBound(bound, `exec on ${entry.alias}`, 'unknown') } catch (late) { error = late }
          if (error === undefined && code === null && signal === null) {
            error = new RwError('REMOTE_ERROR', `exec on ${entry.alias} closed without an exit status or signal; remote outcome is unknown and was not retried`, { outcome: 'unknown' })
          }
        }
        settled = true; stop(); detach()
        if (error !== undefined) {
          reject(error)
          if (stream !== undefined) closeStream(stream)
        } else resolve({ code, signal, stdout: outTrunc ? `${stdout}\n…[truncated]` : stdout,
          stderr: errTrunc ? `${stderr}\n…[truncated]` : stderr, timedOut: false })
      }
      const stopOpenOrRun = (active: IoBound) => {
        const error = ioError(active, `exec on ${entry.alias}`, dispatched ? 'unknown' : 'not-started')
        finish(error)
        // ssh2 hides the channel until its EXEC acknowledgement. If that never
        // arrives, exact-client retirement is the only public cleanup API; it
        // can interrupt other RPCs on this same generation, which also settle.
        if (stream === undefined && dispatched) this.retire(entry.alias, client)
      }
      detach = this.listenRetired(client, error => finish(dispatched ? unknownFailure(error, `exec on ${entry.alias}`) : error))
      const opening = phaseBound(bound, this.opts.channelOpenTimeoutMs ?? 10000)
      stop = watchBound(opening, () => stopOpenOrRun(opening))
      if (settled) { stop(); return }
      try {
        assertBound(opening, `exec open on ${entry.alias}`)
        dispatched = true
        client.exec(cmd, (error, opened) => {
          if (settled) { if (opened !== undefined) closeStream(opened); return }
          if (error) {
            // A CHANNEL_OPEN_FAILURE reason proves the command was not sent.
            // Healthy quota refusals fail in place and do not kill the Client.
            if (typeof (error as Error & { reason?: unknown }).reason === 'number') {
              finish(new SafeOpenFailure(new RwError(mapConnectError(error).code, error.message, { cause: error, outcome: 'not-started' })))
            } else finish(unknownFailure(error, `exec open on ${entry.alias}`))
            return
          }
          stream = opened
          if (stream === undefined) { finish(new RwError('REMOTE_ERROR', 'exec returned no channel', { outcome: 'unknown' })); return }
          try { assertBound(opening, `exec open on ${entry.alias}`, 'unknown') } catch (late) { finish(late); return }
          stop()
          const collect = (current: string, chunk: Buffer, decoder: StringDecoder, truncated: boolean): [string, boolean] => {
            if (truncated || current.length >= this.opts.maxOutputChars) return [current, true]
            let piece = decoder.write(chunk)
            if (current.length + piece.length > this.opts.maxOutputChars) { piece = piece.slice(0, this.opts.maxOutputChars - current.length); truncated = true }
            return [current + piece, truncated]
          }
          stream.on('data', (chunk: Buffer) => { if (!settled) [stdout, outTrunc] = collect(stdout, chunk, outDecoder, outTrunc) })
          stream.stderr.on('data', (chunk: Buffer) => { if (!settled) [stderr, errTrunc] = collect(stderr, chunk, errDecoder, errTrunc) })
          stream.once('exit', (exitCode: number | null, exitSignal?: string) => { code = exitCode; signal = exitSignal ?? null })
          stream.once('close', () => finish())
          // Remains attached while a late close/destroy may emit an error.
          stream.on('error', (error: Error) => { if (!settled) finish(unknownFailure(error, `exec on ${entry.alias}`)) })
          stop = watchBound(bound, () => stopOpenOrRun(bound))
          try { assertBound(bound, `exec on ${entry.alias}`, 'unknown') } catch (error) { finish(error) }
        })
      } catch (error) {
        // A synchronous ssh2 Not-connected guard runs before channel dispatch.
        if (error instanceof Error && /not connected/i.test(error.message)) {
          finish(new SafeOpenFailure(new RwError('NOT_CONNECTED', error.message, { cause: error, outcome: 'not-started' })))
          this.retire(entry.alias, client)
        } else finish(dispatched ? unknownFailure(error, `exec on ${entry.alias}`) : error)
      }
    })
  }

  async sftp(entry: HostEntry, options?: RemoteIoOptions): Promise<SftpLike> {
    assertRemoteIoActive()
    const lifetime = constrain(options)
    const bound = budget(options, this.opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS, lifetime)
    for (let retried = false; ; retried = true) {
      assertBound(bound, `SFTP acquire on ${entry.alias}`)
      const client = await this.waitReady(entry, bound)
      try {
        const raw = await this.openSftp(entry, client, bound)
        if (this.retired.has(client)) { closeSftp(raw); throw new RwError('NOT_CONNECTED', 'SFTP client retired during handoff', { outcome: 'not-started' }) }
        const earlyFailure = acquisitionFailures.get(raw)
        if (earlyFailure !== undefined) { closeSftp(raw); throw notStartedFailure(earlyFailure) }
        try { assertBound(bound, `SFTP acquire on ${entry.alias}`) } catch (error) { closeSftp(raw); throw error }
        return wrapSftp(raw, lifetime, options?.timeoutMs ?? this.opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
          entry.alias, listener => this.listenRetired(client, listener))
      } catch (error) {
        if (error instanceof RwError && (error.code === 'OPERATION_TIMEOUT' || error.code === 'OPERATION_ABORTED')) throw error
        if (retried || !this.retired.has(client)) throw error
        // The subsystem was never handed out, so no file operation started.
        assertBound(bound, `SFTP acquire retry on ${entry.alias}`)
      }
    }
  }

  private openSftp(entry: HostEntry, client: Client, bound: IoBound): Promise<SFTPWrapper> {
    const opening = phaseBound(bound, this.opts.channelOpenTimeoutMs ?? 10000)
    return new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false, requested = false
      let stop: () => void = () => undefined, detach: () => void = () => undefined
      const finish = (error?: unknown, raw?: SFTPWrapper) => {
        if (settled) { if (raw !== undefined) closeSftp(raw); return }
        settled = true; stop(); detach()
        if (error !== undefined) reject(notStartedFailure(error))
        else resolve(raw!)
      }
      detach = this.listenRetired(client, error => finish(error))
      stop = watchBound(opening, () => {
        finish(ioError(opening, `SFTP open on ${entry.alias}`, 'not-started'))
        // No raw handle is exposed before callback. Do not leave an unknown
        // hidden channel alive indefinitely; retire only this exact Client.
        if (requested) this.retire(entry.alias, client)
      })
      if (settled) { stop(); return }
      try {
        assertBound(opening, `SFTP open on ${entry.alias}`)
        requested = true
        client.sftp((error, raw) => {
          if (raw !== undefined) guardSftpAcquisition(raw)
          if (settled) { if (raw !== undefined) closeSftp(raw); return }
          if (error) { finish(mapConnectError(error)); return }
          if (raw === undefined) { finish(new RwError('SFTP_UNAVAILABLE', 'SFTP returned no subsystem', { outcome: 'not-started' })); return }
          try { assertBound(opening, `SFTP open on ${entry.alias}`); finish(undefined, raw) } catch (error) { closeSftp(raw); finish(error) }
        })
      } catch (error) {
        finish(mapConnectError(error))
        if (error instanceof Error && /not connected/i.test(error.message)) this.retire(entry.alias, client)
      }
    })
  }

  async testConnect(entry: HostEntry, options?: RemoteIoOptions): Promise<number> {
    const started = performance.now()
    await this.exec(entry, 'true', options)
    return performance.now() - started
  }

  disconnect(alias: string): void {
    const pooled = this.pool.get(alias)
    if (pooled !== undefined) this.retire(alias, pooled.client)
    else this.readyAliases.delete(alias)
  }
  dispose(): void { for (const alias of [...this.pool.keys()]) this.disconnect(alias) }
  connected(): string[] { return [...this.readyAliases] }

  /** Opening is caller-bounded; a successful channel transfers to its manager. */
  async openShell(entry: HostEntry, command = 'bash --noprofile --norc', options?: RemoteIoOptions): Promise<RemoteShellChannel> {
    assertRemoteIoActive()
    const bound = budget(options, this.opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS)
    const client = await this.waitReady(entry, bound)
    const opening = phaseBound(bound, this.opts.channelOpenTimeoutMs ?? 10000)
    return await new Promise<RemoteShellChannel>((resolve, reject) => {
      let settled = false, requested = false
      let stop: () => void = () => undefined, detach: () => void = () => undefined
      const fail = (error: unknown) => {
        if (settled) return
        settled = true; stop(); detach(); reject(error)
      }
      detach = this.listenRetired(client, error => fail(unknownFailure(error, `shell open on ${entry.alias}`)))
      stop = watchBound(opening, () => {
        fail(ioError(opening, `shell open on ${entry.alias}`, requested ? 'unknown' : 'not-started'))
        if (requested) this.retire(entry.alias, client)
      })
      if (settled) { stop(); return }
      try {
        assertBound(opening, `shell open on ${entry.alias}`)
        requested = true
        client.exec(command, (error, stream) => {
          if (settled) { if (stream !== undefined) closeStream(stream); return }
          if (error) { fail(unknownFailure(error, `shell open on ${entry.alias}`)); return }
          if (stream === undefined) { fail(new RwError('REMOTE_ERROR', 'shell returned no channel', { outcome: 'unknown' })); return }
          try { assertBound(opening, `shell open on ${entry.alias}`, 'unknown') } catch (error) { closeStream(stream); fail(error); return }
          settled = true; stop(); detach()
          let closed = false, lastError: Error | undefined
          const errors = new Set<(error: Error) => void>(), closers = new Set<() => void>()
          let detachLifetime: () => void = () => undefined
          const close = () => {
            if (closed) return
            closed = true; detachLifetime(); closeStream(stream)
            for (const cb of [...closers]) { try { cb() } catch { /* keep releasing other subscribers */ } }
            closers.clear(); errors.clear()
          }
          // Inert after close; never expose late errors as unhandled events.
          stream.on('error', (error: Error) => { if (closed) return; lastError = error; for (const cb of [...errors]) { try { cb(error) } catch { /* keep notifying other subscribers */ } }; close() })
          stream.once('close', close)
          detachLifetime = this.listenRetired(client, error => { lastError = error; for (const cb of [...errors]) { try { cb(error) } catch { /* keep notifying other subscribers */ } }; close() })
          resolve({
            write: data => {
              if (closed) throw new RwError('NOT_CONNECTED', 'remote shell is closed', { outcome: 'not-started' })
              stream.write(data)
            },
            onData: cb => { stream.on('data', cb); return () => { stream.removeListener('data', cb) } },
            onError: cb => { if (lastError !== undefined) queueMicrotask(() => cb(lastError!)); else errors.add(cb); return () => { errors.delete(cb) } },
            onClose: cb => { if (closed) queueMicrotask(cb); else closers.add(cb); return () => { closers.delete(cb) } },
            close,
          })
        })
      } catch (error) { fail(requested ? unknownFailure(error, `shell open on ${entry.alias}`) : error) }
    })
  }

  /** A shared dial is pool-owned; one cancelled waiter cannot cancel other waiters. */
  private ensureConnected(entry: HostEntry): Promise<Client> {
    const existing = this.pool.get(entry.alias)
    if (existing !== undefined) return existing.ready
    const client = this.factory()
    let resolveReady!: (client: Client) => void, rejectReady!: (error: unknown) => void
    const ready = new Promise<Client>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const pooled: Pooled = { client, ready }
    this.pool.set(entry.alias, pooled)
    let settled = false, hostKeyFailure: RwError | undefined
    const connectBound: IoBound = { end: performance.now() + positiveTimeout(this.opts.connectTimeoutMs), signals: [] }
    let stop: () => void = () => undefined
    const reject = (error: unknown) => {
      if (!settled) { settled = true; stop(); rejectReady(error) }
      this.retire(entry.alias, client, error instanceof RwError ? error : mapConnectError(error))
    }
    pooled.cancelReady = error => {
      if (!settled) { settled = true; stop(); rejectReady(error) }
    }
    client.once('ready', () => {
      if (settled || this.retired.has(client) || this.pool.get(entry.alias)?.client !== client) return
      settled = true; stop(); this.readyAliases.add(entry.alias); resolveReady(client)
    })
    // Attached for this client's entire lifetime; every mutation is generation-aware.
    client.on('error', (error: Error) => reject(hostKeyFailure ?? mapConnectError(error)))
    client.on('close', () => reject(hostKeyFailure ?? new RwError('NOT_CONNECTED', `connection to ${entry.alias} closed`)))
    stop = watchBound(connectBound, () => reject(new RwError('CONN_TIMEOUT', `connection to ${entry.alias} timed out`, { outcome: 'not-started' })))
    try { client.connect(this.buildConfig(entry, error => { hostKeyFailure = error })) } catch (error) { reject(error instanceof RwError ? error : mapConnectError(error)) }
    // Consume this housekeeping branch without touching a replacement generation.
    ready.catch(() => { if (this.pool.get(entry.alias)?.client === client) this.retire(entry.alias, client) })
    return ready
  }

  private buildConfig(entry: HostEntry, recordHostKeyFailure: (error: RwError) => void): ConnectConfig {
    const config: ConnectConfig = { host: entry.host, port: entry.port, username: entry.user,
      readyTimeout: this.opts.connectTimeoutMs, keepaliveInterval: 15000, keepaliveCountMax: 3 }
    if (entry.auth.kind === 'password') {
      if (!entry.auth.password) throw new RwError('AUTH_FAILED', `no credentials configured for host "${entry.alias}"`)
      config.password = entry.auth.password
    } else {
      if (!entry.auth.keyPath) throw new RwError('AUTH_FAILED', `no credentials configured for host "${entry.alias}"`)
      try { config.privateKey = readFileSync(expandHome(entry.auth.keyPath)) } catch {
        throw new RwError('AUTH_FAILED', `private key not readable: ${entry.auth.keyPath}`)
      }
      if (entry.auth.passphrase) config.passphrase = entry.auth.passphrase
    }
    if (this.opts.hostKeyPolicy !== 'off') config.hostVerifier = (key: Buffer) => this.verifyHostKey(entry, key, recordHostKeyFailure)
    return config
  }

  private verifyHostKey(entry: HostEntry, key: Buffer, record: (error: RwError) => void): boolean {
    const parsed = utils.parseKey(key)
    if (parsed instanceof Error) { record(new RwError('HOSTKEY_VERIFY_FAILED', `cannot parse host key presented by ${entry.host}:${entry.port}`)); return false }
    const base64 = key.toString('base64'), where = `${entry.host}:${entry.port}`
    switch (this.opts.knownHosts.verify(entry.host, entry.port, parsed.type, base64)) {
      case 'match': return true
      case 'unknown':
        if (this.opts.hostKeyPolicy === 'accept-new') { this.opts.knownHosts.accept(entry.host, entry.port, parsed.type, base64); return true }
        record(new RwError('HOSTKEY_UNKNOWN', `host key for ${where} is not in known_hosts (policy: strict)`)); return false
      case 'changed':
        record(new RwError('HOSTKEY_CHANGED', `host key for ${where} has CHANGED — possible MITM or host rebuild; review and fix the entry in ${this.opts.knownHosts.path} manually`)); return false
    }
  }
}
