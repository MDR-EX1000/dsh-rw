// dsh-rw — one manager-owned persistent bash per (alias, workspace).
// Commands keep shell state, but each caller's budget covers creation, queueing
// and its frame. A cancelled queued caller never writes and cannot close the
// command already running ahead of it.
import { randomBytes } from 'node:crypto'
import { shq } from './guard.js'
import { RwError } from './errors.js'
import {
  assertRemoteIoActive,
  currentRemoteIoOptions,
  detachedRemoteIo,
  ownRemoteIoResource,
  runRemoteIo,
} from './io-context.js'
import type { RemoteIoOptions } from './io-context.js'
import type { HostEntry } from './hosts.js'
import type { ExecResult, RemoteShellChannel } from './ssh-pool.js'

const RS = '\u001e'
/** Independent finite manager budget, never inherited from the first caller. */
const SHELL_INIT_TIMEOUT_MS = 30_000

type Outcome = 'not-started' | 'unknown'

export interface ShellManagerOptions {
  /** The manager-owned opener must honor options and quiesce on cancellation. */
  open(entry: HostEntry, options?: RemoteIoOptions): Promise<RemoteShellChannel>
  idleMs?: number
}
export interface ShellManagerLike {
  run(entry: HostEntry, cwd: string, command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult>
  dispose(): void
}

function stoppedError(options: RemoteIoOptions, outcome: Outcome): RwError {
  const cause = options.signal?.reason
  const timedOut = (cause instanceof RwError && cause.code === 'OPERATION_TIMEOUT') ||
    (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)
  return new RwError(
    timedOut ? 'OPERATION_TIMEOUT' : 'OPERATION_ABORTED',
    timedOut ? 'persistent shell call timed out' : 'command aborted (remote execution interrupted)',
    { cause, outcome },
  )
}

/** Stop waiting on shared creation; the finite manager-owned creation keeps its own ownership. */
function waitFor<T>(promise: Promise<T>, options: RemoteIoOptions, outcome: Outcome): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(stoppedError(options, outcome))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (body: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      body()
    }
    const onAbort = () => finish(() => reject(stoppedError(options, outcome)))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
  })
}

interface QueueTask {
  started: boolean
  cancelled: boolean
}
interface Pending {
  mark: string
  task: QueueTask
  options: RemoteIoOptions
  resolve(result: ExecResult): void
  reject(error: Error): void
}

class LiveShell {
  private buffer = ''
  private closed = false
  private tail: Promise<unknown> = Promise.resolve()
  private pending: Pending | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly closedController = new AbortController()
  private readonly subscriptions: Array<() => void> = []

  constructor(
    private readonly channel: RemoteShellChannel,
    private readonly idleMs: number,
    private readonly onGone: () => void,
  ) {
    this.retainSubscription(channel.onData(chunk => this.onData(chunk)))
    this.retainSubscription(channel.onError(error => this.close(new RwError('REMOTE_ERROR', 'remote shell reported an error', { cause: error, outcome: 'unknown' }))))
    this.retainSubscription(channel.onClose(() => this.close(new RwError('REMOTE_ERROR', 'remote shell closed', { outcome: 'unknown' }))))
  }

  get alive(): boolean { return !this.closed }

  run(command: string, options: RemoteIoOptions): Promise<ExecResult> {
    if (this.closed) return Promise.reject(new RwError('REMOTE_ERROR', 'remote shell is closed', { outcome: 'not-started' }))
    const task: QueueTask = { started: false, cancelled: false }
    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false
      let disown: (() => void) | undefined
      const finish = (body: () => void) => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener('abort', onAbort)
        this.closedController.signal.removeEventListener('abort', onClosed)
        disown?.()
        body()
      }
      const onAbort = () => {
        task.cancelled = true
        const error = stoppedError(options, task.started ? 'unknown' : 'not-started')
        finish(() => reject(error))
        // Only this task's active frame may close the shared shell. A queued
        // successor must never interrupt the predecessor's command.
        if (task.started && this.pending?.task === task) this.close(error)
      }
      const onClosed = () => {
        task.cancelled = true
        finish(() => reject(new RwError('REMOTE_ERROR', 'remote shell closed', {
          cause: this.closedController.signal.reason, outcome: task.started ? 'unknown' : 'not-started',
        })))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.closedController.signal.addEventListener('abort', onClosed, { once: true })
      if (options.signal?.aborted) { onAbort(); return }

      const next = this.tail.then(async () => {
        if (task.cancelled || settled) return
        if (this.closed) { onClosed(); return }
        if (options.signal?.aborted) { onAbort(); return }
        assertRemoteIoActive()
        this.clearIdle()
        task.started = true
        const mark = randomBytes(8).toString('hex')
        await new Promise<void>((advance) => {
          const complete = (body: () => void) => { body(); advance() }
          this.pending = {
            mark, task, options,
            resolve: result => complete(() => finish(() => resolve(result))),
            reject: error => complete(() => finish(() => reject(error))),
          }
          disown = ownRemoteIoResource(() => this.close(stoppedError(options, 'unknown')))
          try {
            // Runs in the current shell context so cd/exports survive. One
            // merged stream preserves order; only this random sentinel is parsed.
            this.channel.write(`{ ${command}\n} 2>&1\nprintf '\\n\\036%s:%d\\036\\n' '${mark}' "$?"\n`)
          } catch (error) {
            this.close(new RwError('REMOTE_ERROR', 'could not write the remote shell frame', { cause: error, outcome: 'unknown' }))
          }
        })
      })
      // Queue bookkeeping always drains, including cancelled no-op entries.
      this.tail = next.catch(error => finish(() => reject(error instanceof Error ? error : new Error(String(error)))))
    })
  }

  close(error: Error = new RwError('REMOTE_ERROR', 'remote shell closed', { outcome: 'unknown' })): void {
    if (this.closed) return
    this.closed = true
    this.clearIdle()
    const pending = this.pending
    this.pending = null
    this.buffer = ''
    pending?.reject(error)
    this.closedController.abort(error)
    for (const unsubscribe of this.subscriptions.splice(0)) {
      try { unsubscribe() } catch { /* close all remaining subscriptions */ }
    }
    try { this.channel.close() } catch { /* already closed */ }
    this.onGone()
  }

  private retainSubscription(value: unknown): void {
    if (typeof value !== 'function') return
    const unsubscribe = value as () => void
    if (this.closed) unsubscribe()
    else this.subscriptions.push(unsubscribe)
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    this.buffer += chunk.toString('utf8')
    const pending = this.pending
    if (!pending) return
    const marker = `${RS}${pending.mark}:`
    const at = this.buffer.indexOf(marker)
    if (at < 0) return
    const end = this.buffer.indexOf(RS, at + marker.length)
    if (end < 0) return
    if (pending.options.signal?.aborted ||
        (pending.options.deadlineMs !== undefined && Date.now() >= pending.options.deadlineMs)) {
      this.close(stoppedError(pending.options, 'unknown'))
      return
    }
    const code = Number.parseInt(this.buffer.slice(at + marker.length, end), 10)
    const body = this.buffer.slice(0, at)
    this.buffer = this.buffer.slice(end + 1)
    if (this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1)
    this.pending = null
    this.resetIdle()
    pending.resolve({
      code: Number.isNaN(code) ? null : code, signal: null,
      stdout: body.endsWith('\n') ? body.slice(0, -1) : body,
      stderr: '', timedOut: false,
    })
  }

  private resetIdle(): void {
    this.clearIdle()
    if (this.idleMs <= 0) return
    this.idleTimer = setTimeout(() => this.close(), this.idleMs)
    this.idleTimer.unref?.()
  }
  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

export class PersistentShellManager implements ShellManagerLike {
  private readonly shells = new Map<string, Promise<LiveShell>>()
  private readonly controller = new AbortController()
  private readonly idleMs: number
  private disposed = false

  constructor(private readonly opts: ShellManagerOptions) { this.idleMs = opts.idleMs ?? 600_000 }

  async run(entry: HostEntry, cwd: string, command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult> {
    if (this.disposed) throw new Error('persistent shell manager is disposed')
    return runRemoteIo(opts, async () => {
      assertRemoteIoActive()
      const options = currentRemoteIoOptions()
      if (options === undefined) throw new Error('persistent shell caller has no I/O scope')
      let shell: LiveShell
      try {
        shell = await waitFor(this.shellFor(entry, cwd), options, 'not-started')
      } catch (error) {
        if (error instanceof RwError) throw new RwError(error.code, error.message, { cause: error, outcome: 'not-started' })
        throw error
      }
      assertRemoteIoActive()
      if (this.disposed) throw new Error('persistent shell manager is disposed')
      return shell.run(command, options)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort(new RwError('OPERATION_ABORTED', 'persistent shell manager is disposed', { outcome: 'not-started' }))
    for (const pending of this.shells.values()) void pending.then(shell => shell.close()).catch(() => undefined)
    this.shells.clear()
  }
  get size(): number { return this.shells.size }

  private shellFor(entry: HostEntry, cwd: string): Promise<LiveShell> {
    const key = `${entry.alias}\u0000${cwd}`
    const existing = this.shells.get(key)
    return existing ?? this.reopen(key, entry, cwd)
  }

  private reopen(key: string, entry: HostEntry, cwd: string): Promise<LiveShell> {
    let acquiredShell: LiveShell | undefined
    const created = detachedRemoteIo(() => runRemoteIo({ signal: this.controller.signal, timeoutMs: SHELL_INIT_TIMEOUT_MS }, async () => {
      const options = currentRemoteIoOptions()
      if (options === undefined) throw new Error('persistent shell creation has no I/O scope')
      assertRemoteIoActive()
      const opening = this.opts.open(entry, options)
      let shell: LiveShell | undefined
      let channel: RemoteShellChannel | undefined
      let disown: (() => void) | undefined
      try {
        channel = await opening
        assertRemoteIoActive()
        shell = new LiveShell(channel, this.idleMs, () => {
          if (this.shells.get(key) === created) this.shells.delete(key)
        })
        acquiredShell = shell
        disown = ownRemoteIoResource(() => shell?.close())
        const init = await shell.run(`cd ${shq(cwd)}`, options)
        if (init.code !== 0 || !shell.alive) throw new Error(`could not enter workspace ${cwd} in the persistent shell`)
        assertRemoteIoActive()
        if (this.disposed) throw new Error('persistent shell manager is disposed')
        // The initialized shell outlives this finite init scope; manager owns it.
        disown()
        return shell
      } catch (error) {
        shell?.close()
        if (!shell && channel) { try { channel.close() } catch { /* already closed */ } }
        throw error
      }
    }))
    this.shells.set(key, created)
    void created.catch(() => {
      // runRemoteIo may reject in its post-body admission check after ownership
      // was transferred. Failed creation must still close this exact shell.
      acquiredShell?.close()
      if (this.shells.get(key) === created) this.shells.delete(key)
    })
    return created
  }
}
