// dsh-rw — persistent remote shell.
//
// Before 1.0 the persistent-bash tool degraded to a fresh one-shot exec on
// every call: `cd` and `export` never survived, so every command had to
// re-establish its own environment. This module keeps one `bash` process per
// (alias, workspace) instead, framing each command with a per-call random
// sentinel that carries the exit code.
//
// Streams are merged (`2>&1`) on purpose. A shell channel is ONE ordered
// stream; preserving that ordering is worth more than keeping stdout and
// stderr separate at the cost of a cross-channel race. That is what a terminal
// gives you, and the rendered result says so.
//
// Known limit: framing is line-based, so a command that leaves a quote, a
// here-doc or a `{` unclosed desynchronises the frame; the timeout then closes
// the shell (the next call gets a fresh one) rather than reading stale output.
import { randomBytes } from 'node:crypto'
import { shq } from './guard.js'
import type { HostEntry } from './hosts.js'
import type { ExecResult, RemoteShellChannel } from './ssh-pool.js'

/** ASCII record separator: a control character normal command output does not contain. */
const RS = '\u001e'

export interface ShellManagerOptions {
  /** Open a channel for one host (wired to `SshPool.openShell`). */
  open(entry: HostEntry): Promise<RemoteShellChannel>
  /** Close a shell after this long without a command (default 10 minutes). */
  idleMs?: number
}

/** The shim-facing contract, kept structural so tests can substitute it. */
export interface ShellManagerLike {
  run(entry: HostEntry, cwd: string, command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult>
  dispose(): void
}

/** One in-flight framed command. */
interface Pending {
  mark: string
  resolve(result: ExecResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** One live `bash` process plus its framing buffer and serialised command tail. */
class LiveShell {
  private buffer = ''
  private closed = false
  private tail: Promise<unknown> = Promise.resolve()
  private pending: Pending | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly channel: RemoteShellChannel,
    private readonly idleMs: number,
    private readonly onGone: () => void,
  ) {
    channel.onData((chunk) => this.onData(chunk))
    channel.onError(() => this.fail(new Error('remote shell reported an error')))
    channel.onClose(() => this.fail(new Error('remote shell closed')))
  }

  get alive(): boolean {
    return !this.closed
  }

  /** Queue one command behind the previous one: a shell is inherently serial. */
  run(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
    const next = this.tail.then(() => this.frame(command, timeoutMs, signal))
    this.tail = next.catch(() => undefined)
    return next
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.clearIdle()
    try {
      this.channel.close()
    } catch {
      // already closed
    }
    this.fail(new Error('remote shell closed'))
    this.onGone()
  }

  private frame(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
    if (this.closed) return Promise.reject(new Error('remote shell is closed'))
    if (signal?.aborted === true) return Promise.reject(new Error('command aborted (remote execution interrupted)'))
    const mark = randomBytes(8).toString('hex')
    return new Promise<ExecResult>((resolve, reject) => {
      const finish = (result: ExecResult): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const timer = setTimeout(() => {
        // A stuck command cannot be interrupted without a pty, so the shell is
        // killed instead of being reused with unread output on its stream.
        const body = this.takeBuffer()
        this.pending = null
        this.close()
        finish({ code: null, signal: 'TIMEOUT', stdout: body, stderr: '', timedOut: true })
      }, timeoutMs)
      const onAbort = (): void => {
        clearTimeout(timer)
        this.pending = null
        this.close()
        reject(new Error('command aborted (remote execution interrupted)'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending = {
        mark,
        resolve: (result) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(result)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      }
      // `{ command }` runs in the current shell context, so `cd` and exports
      // persist. `2>&1` merges the streams; the printf is the only sentinel we
      // parse and reports the block's exit status.
      this.channel.write(`{ ${command}\n} 2>&1\nprintf '\\n\\036%s:%d\\036\\n' '${mark}' "$?"\n`)
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    const pending = this.pending
    if (pending === null) return
    const marker = `${RS}${pending.mark}:`
    const at = this.buffer.indexOf(marker)
    if (at < 0) return
    const end = this.buffer.indexOf(RS, at + marker.length)
    if (end < 0) return // the sentinel has not fully arrived yet
    const codeText = this.buffer.slice(at + marker.length, end)
    const body = this.buffer.slice(0, at)
    // The frame is [output]\n[RS mark:code RS]\n; the printf's own newlines are
    // framing, not command output, so one is dropped on each side.
    this.buffer = this.buffer.slice(end + 1)
    if (this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1)
    const code = Number.parseInt(codeText, 10)
    this.pending = null
    clearTimeout(pending.timer)
    this.resetIdle()
    // The frame writes one newline before the sentinel; it is framing, not output.
    pending.resolve({
      code: Number.isNaN(code) ? null : code,
      signal: null,
      stdout: body.endsWith('\n') ? body.slice(0, -1) : body,
      stderr: '',
      timedOut: false,
    })
  }

  private takeBuffer(): string {
    const body = this.buffer
    this.buffer = ''
    return body
  }

  private fail(error: Error): void {
    const pending = this.pending
    if (pending === null) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private resetIdle(): void {
    this.clearIdle()
    if (this.idleMs <= 0) return
    this.idleTimer = setTimeout(() => this.close(), this.idleMs)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}

/**
 * Keeps one persistent shell per (alias, workspace). A shell that dies is
 * dropped and reopened transparently: the caller only ever sees the command
 * result, never a stale stream.
 */
export class PersistentShellManager implements ShellManagerLike {
  private readonly shells = new Map<string, Promise<LiveShell>>()
  private readonly idleMs: number
  private disposed = false

  constructor(private readonly opts: ShellManagerOptions) {
    this.idleMs = opts.idleMs ?? 600_000
  }

  async run(
    entry: HostEntry,
    cwd: string,
    command: string,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    if (this.disposed) throw new Error('persistent shell manager is disposed')
    const shell = await this.shellFor(entry, cwd)
    return await shell.run(command, opts.timeoutMs, opts.signal)
  }

  /** Close every shell (plugin teardown, or a disconnect). */
  dispose(): void {
    this.disposed = true
    for (const pending of this.shells.values()) {
      void pending.then((shell) => shell.close()).catch(() => undefined)
    }
    this.shells.clear()
  }

  /** How many live shells are tracked — used by status reporting and tests. */
  get size(): number {
    return this.shells.size
  }

  private shellFor(entry: HostEntry, cwd: string): Promise<LiveShell> {
    const key = `${entry.alias}\u0000${cwd}`
    const existing = this.shells.get(key)
    if (existing !== undefined) return existing
    return this.reopen(key, entry, cwd)
  }

  private reopen(key: string, entry: HostEntry, cwd: string): Promise<LiveShell> {
    const created = (async (): Promise<LiveShell> => {
      const channel = await this.opts.open(entry)
      const shell = new LiveShell(channel, this.idleMs, () => {
        if (this.shells.get(key) === created) this.shells.delete(key)
      })
      // The workspace is the shell's starting cwd, mirroring exec's `cd <cwd> &&`.
      const init = await shell.run(`cd ${shq(cwd)}`, 10_000)
      if (init.code !== 0) {
        shell.close()
        throw new Error(`could not enter workspace ${cwd} in the persistent shell`)
      }
      return shell
    })()
    this.shells.set(key, created)
    created.catch(() => {
      if (this.shells.get(key) === created) this.shells.delete(key)
    })
    return created
  }
}
