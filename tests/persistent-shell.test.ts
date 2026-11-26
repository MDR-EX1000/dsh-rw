// Persistent-shell framing tests: a fake channel speaks the same sentinel
// protocol the real `bash` process does, so these cover framing, serialisation,
// timeouts, reconnects and idle teardown without an SSH server.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersistentShellManager } from '../src/persistent-shell.js'
import { RwError } from '../src/errors.js'
import type { RemoteIoOptions } from '../src/io-context.js'
import type { RemoteShellChannel } from '../src/ssh-pool.js'
import { ENTRY_PROD } from './p4-fakes.js'

const RS = String.fromCharCode(30)

/** Mock opener honors its manager signal, takes finite teardown to quiesce,
 * and owns cleanup of a raw channel which arrives after cancellation. */
function managedOpen(raw: Promise<RemoteShellChannel>, options?: RemoteIoOptions): Promise<RemoteShellChannel> {
  const signal = options?.signal
  if (!signal) throw new Error('opener did not receive manager signal')
  return new Promise((resolve, reject) => {
    let cancelled = false, settled = false
    const abort = () => {
      if (settled || cancelled) return
      cancelled = true
      setTimeout(() => {
        settled = true
        signal.removeEventListener('abort', abort)
        reject(new RwError(signal.reason instanceof RwError && signal.reason.code === 'OPERATION_TIMEOUT' ? 'OPERATION_TIMEOUT' : 'OPERATION_ABORTED',
          'mock opener quiesced', { cause: signal.reason, outcome: 'not-started' }))
      }, 20)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void raw.then(channel => {
      if (cancelled || settled) { try { channel.close() } catch { /* already closed */ }; return }
      settled = true; signal.removeEventListener('abort', abort); resolve(channel)
    }, error => {
      if (!cancelled && !settled) { settled = true; signal.removeEventListener('abort', abort); reject(error) }
    })
  })
}

/** What the fake shell should do with one (non-init) command. */
type Handler = (command: string) => { out?: string; code?: number; silent?: boolean }

/**
 * A channel that parses the framing, then answers with output + the sentinel.
 * `cd …` (the manager's workspace entry) is always answered so tests only have
 * to script the command they care about; override `initResult` to fail it.
 */
class FakeChannel implements RemoteShellChannel {
  readonly commands: string[] = []
  readonly writes: string[] = []
  closed = false
  initResult: { code?: number; silent?: boolean } = {}
  private dataCb: ((chunk: Buffer) => void) | null = null
  private closeCb: (() => void) | null = null
  private errorCb: ((err: Error) => void) | null = null

  constructor(private handler: Handler = () => ({})) {}

  write(data: string): void {
    this.writes.push(data)
    const mark = /'([0-9a-f]{16})' "\$\?"/.exec(data)?.[1]
    const command = /^\{ ([\s\S]*?)\n\} 2>&1\n/.exec(data)?.[1]
    if (mark === undefined || command === undefined) return
    this.commands.push(command)
    const isInit = command.startsWith('cd ')
    const result: ReturnType<Handler> = isInit ? { code: this.initResult.code ?? 0, silent: this.initResult.silent } : this.handler(command)
    if (result.silent === true) return
    setImmediate(() => {
      if (this.closed) return
      this.emit(`${result.out ?? ''}\n${RS}${mark}:${result.code ?? 0}${RS}\n`)
    })
  }

  onData(cb: (chunk: Buffer) => void): () => void {
    this.dataCb = cb
    return () => { if (this.dataCb === cb) this.dataCb = null }
  }

  onError(cb: (err: Error) => void): () => void {
    this.errorCb = cb
    return () => { if (this.errorCb === cb) this.errorCb = null }
  }

  onClose(cb: () => void): () => void {
    this.closeCb = cb
    return () => { if (this.closeCb === cb) this.closeCb = null }
  }

  get listenerCount(): number { return Number(this.dataCb !== null) + Number(this.errorCb !== null) + Number(this.closeCb !== null) }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.closeCb?.()
  }

  /** Push raw output (partial frames included). */
  emit(text: string): void {
    this.dataCb?.(Buffer.from(text, 'utf8'))
  }

  /** Simulate the remote side dying mid-command. */
  die(error?: Error): void {
    this.closed = true
    if (error !== undefined) this.errorCb?.(error)
    this.closeCb?.()
  }

  /** The mark of the most recently written frame (init frames included). */
  markOf(index: number): string | undefined {
    return /'([0-9a-f]{16})' "\$\?"/.exec(this.writes[index] ?? '')?.[1]
  }
}

afterEach(() => {
  vi.useRealTimers()
})

function makeManager(handler: Handler = () => ({}), idleMs = 0): { manager: PersistentShellManager; channel: FakeChannel } {
  const channel = new FakeChannel(handler)
  const manager = new PersistentShellManager({ open: async () => channel, idleMs })
  return { manager, channel }
}

describe('persistent shell framing', () => {
  it('enters the workspace, then returns stdout and the exit code', async () => {
    const { manager, channel } = makeManager(() => ({ out: 'hello', code: 3 }))
    const res = await manager.run(ENTRY_PROD, '/srv/app', 'echo hello', { timeoutMs: 1000 })
    expect(channel.commands[0]).toBe(`cd '/srv/app'`)
    expect(channel.commands[1]).toBe('echo hello')
    expect(res).toEqual({ code: 3, signal: null, stdout: 'hello', stderr: '', timedOut: false })
    manager.dispose()
  })

  it('keeps the merged stream intact (no [stderr] split)', async () => {
    const { manager } = makeManager(() => ({ out: 'out\n[stderr]\nerr', code: 0 }))
    const res = await manager.run(ENTRY_PROD, '/srv/app', 'x', { timeoutMs: 1000 })
    expect(res.stdout).toBe('out\n[stderr]\nerr')
    expect(res.stderr).toBe('')
    manager.dispose()
  })

  it('reuses one shell per (alias, workspace) and opens a separate one per cwd', async () => {
    const { manager, channel } = makeManager(() => ({ out: 'ok' }))
    await manager.run(ENTRY_PROD, '/srv/app', 'a', { timeoutMs: 1000 })
    await manager.run(ENTRY_PROD, '/srv/app', 'b', { timeoutMs: 1000 })
    expect(channel.commands).toEqual([`cd '/srv/app'`, 'a', 'b'])

    const other = new FakeChannel(() => ({ out: 'ok' }))
    const second = new PersistentShellManager({ open: async () => other, idleMs: 0 })
    await second.run(ENTRY_PROD, '/srv/app', 'a', { timeoutMs: 1000 })
    await second.run(ENTRY_PROD, '/srv/other', 'b', { timeoutMs: 1000 })
    expect(other.commands).toEqual([`cd '/srv/app'`, 'a', `cd '/srv/other'`, 'b'])
    manager.dispose()
    second.dispose()
  })

  it('serialises concurrent calls on the same shell, in submission order', async () => {
    const seen: string[] = []
    const { manager } = makeManager((command) => {
      seen.push(command)
      return { out: command }
    })
    const [first, second] = await Promise.all([
      manager.run(ENTRY_PROD, '/srv/app', 'one', { timeoutMs: 1000 }),
      manager.run(ENTRY_PROD, '/srv/app', 'two', { timeoutMs: 1000 }),
    ])
    expect(seen).toEqual(['one', 'two'])
    expect(first.stdout).toBe('one')
    expect(second.stdout).toBe('two')
    manager.dispose()
  })

  it('tolerates output split across chunks, including a partial sentinel', async () => {
    const channel = new FakeChannel(() => ({ silent: true }))
    const manager = new PersistentShellManager({ open: async () => channel, idleMs: 0 })
    const pending = manager.run(ENTRY_PROD, '/srv/app', 'x', { timeoutMs: 2000 })
    await vi.waitFor(() => expect(channel.commands.length).toBe(2))
    const mark = channel.markOf(1)
    channel.emit('par')
    channel.emit('tial')
    channel.emit(`\n${RS}${mark}:0${RS}\n`)
    const res = await pending
    expect(res.stdout).toBe('partial')
    manager.dispose()
  })
})

describe('persistent shell failure handling', () => {
  it('kills the shell on timeout and reports it, so the next call starts clean', async () => {
    const { manager, channel } = makeManager(() => ({ silent: true }))
    await expect(manager.run(ENTRY_PROD, '/srv/app', 'sleep 99', { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'OPERATION_TIMEOUT', outcome: 'unknown',
    })
    expect(channel.closed).toBe(true)
    await vi.waitFor(() => expect(manager.size).toBe(0))
    manager.dispose()
  })

  it('rejects an in-flight command when the remote side dies', async () => {
    const { manager, channel } = makeManager(() => ({ silent: true }))
    const pending = manager.run(ENTRY_PROD, '/srv/app', 'x', { timeoutMs: 2000 })
    await vi.waitFor(() => expect(channel.commands.length).toBe(2))
    channel.die()
    await expect(pending).rejects.toThrow(/closed/)
    manager.dispose()
  })

  it('reports a clear error when the workspace cannot be entered', async () => {
    const { manager, channel } = makeManager(() => ({ out: 'unused' }))
    channel.initResult = { code: 1 }
    await expect(manager.run(ENTRY_PROD, '/nope', 'ls', { timeoutMs: 1000 })).rejects.toThrow(/could not enter workspace/)
    expect(channel.closed).toBe(true)
    manager.dispose()
  })

  it('rejects when the caller aborts', async () => {
    const { manager, channel } = makeManager(() => ({ silent: true }))
    const controller = new AbortController()
    const pending = manager.run(ENTRY_PROD, '/srv/app', 'x', { timeoutMs: 5000, signal: controller.signal })
    await vi.waitFor(() => expect(channel.commands.length).toBe(2))
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)
    expect(channel.closed).toBe(true)
    manager.dispose()
  })

  it('refuses to run after dispose', async () => {
    const { manager } = makeManager()
    manager.dispose()
    await expect(manager.run(ENTRY_PROD, '/srv/app', 'ls', { timeoutMs: 1000 })).rejects.toThrow(/disposed/)
  })

  it('closes an idle shell after the idle window', async () => {
    const { manager, channel } = makeManager(() => ({ out: 'ok' }), 30)
    const res = await manager.run(ENTRY_PROD, '/srv/app', 'ls', { timeoutMs: 1000 })
    expect(res.stdout).toBe('ok')
    expect(channel.closed).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(channel.closed).toBe(true)
    manager.dispose()
  })
})

describe('persistent shell caller budgets and owned cleanup', () => {
  it('times out while opening without cancelling shared manager initialization', async () => {
    let ready!: (channel: RemoteShellChannel) => void
    let openedSignal: AbortSignal | undefined
    let opens = 0
    const opening = new Promise<RemoteShellChannel>(resolve => { ready = resolve })
    const channel = new FakeChannel(command => ({ out: command }))
    const manager = new PersistentShellManager({
      open: async (_entry, options) => { opens++; openedSignal = options?.signal; return managedOpen(opening, options) }, idleMs: 0,
    })
    await expect(manager.run(ENTRY_PROD, '/srv/app', 'expired', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'not-started' })
    expect(openedSignal?.aborted).toBe(false)
    const next = manager.run(ENTRY_PROD, '/srv/app', 'next', { timeoutMs: 1000 })
    ready(channel)
    expect((await next).stdout).toBe('next')
    expect(opens).toBe(1)
    expect(channel.commands).toEqual([`cd '/srv/app'`, 'next'])
    expect(channel.closed).toBe(false)
    expect(channel.listenerCount).toBe(3)
    manager.dispose()
    await vi.waitFor(() => expect(channel.listenerCount).toBe(0))
  })

  it('counts silent shell initialization against the caller budget and disposes the manager-owned init', async () => {
    const channel = new FakeChannel()
    channel.initResult = { silent: true }
    const manager = new PersistentShellManager({ open: async () => channel, idleMs: 0 })
    await expect(manager.run(ENTRY_PROD, '/srv/app', 'never-dispatched', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'not-started' })
    expect(channel.commands).toEqual([`cd '/srv/app'`])
    manager.dispose()
    await vi.waitFor(() => expect(channel.closed).toBe(true))
    expect(channel.listenerCount).toBe(0)
  })

  it('cancels a queued successor immediately without interrupting its running predecessor', async () => {
    const { manager, channel } = makeManager(command => command === 'front' ? { silent: true } : { out: command })
    const front = manager.run(ENTRY_PROD, '/srv/app', 'front', { timeoutMs: 2000 })
    await vi.waitFor(() => expect(channel.commands).toHaveLength(2))
    const controller = new AbortController()
    const queued = manager.run(ENTRY_PROD, '/srv/app', 'cancelled', { timeoutMs: 1000, signal: controller.signal })
    const rejection = expect(queued).rejects.toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'not-started' })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    await rejection
    expect(channel.closed).toBe(false)
    channel.emit(`front-output\n${RS}${channel.markOf(1)}:0${RS}\n`)
    expect((await front).stdout).toBe('front-output')
    expect((await manager.run(ENTRY_PROD, '/srv/app', 'after', { timeoutMs: 1000 })).stdout).toBe('after')
    expect(channel.commands).toEqual([`cd '/srv/app'`, 'front', 'after'])
    manager.dispose()
  })

  it('expires a queued caller before its frame is dispatched without closing the front command', async () => {
    const { manager, channel } = makeManager(command => command === 'front' ? { silent: true } : { out: command })
    const front = manager.run(ENTRY_PROD, '/srv/app', 'front', { timeoutMs: 2000 })
    await vi.waitFor(() => expect(channel.commands).toHaveLength(2))
    await expect(manager.run(ENTRY_PROD, '/srv/app', 'expired', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'not-started' })
    expect(channel.closed).toBe(false)
    channel.emit(`ok\n${RS}${channel.markOf(1)}:0${RS}\n`)
    await front
    await manager.run(ENTRY_PROD, '/srv/app', 'after', { timeoutMs: 1000 })
    expect(channel.commands).not.toContain('expired')
    manager.dispose()
  })

  it('drops an idle shell on remote error and removes all old subscriptions', async () => {
    const channels: FakeChannel[] = []
    const manager = new PersistentShellManager({ open: async () => { const channel = new FakeChannel(() => ({ out: 'ok' })); channels.push(channel); return channel }, idleMs: 0 })
    await manager.run(ENTRY_PROD, '/srv/app', 'first', { timeoutMs: 1000 })
    channels[0]!.die(new Error('lost transport'))
    expect(manager.size).toBe(0)
    expect(channels[0]!.listenerCount).toBe(0)
    await manager.run(ENTRY_PROD, '/srv/app', 'second', { timeoutMs: 1000 })
    expect(channels).toHaveLength(2)
    manager.dispose()
  })

  it('rejects queued work when the active channel closes rather than waiting for its own timeout', async () => {
    const { manager, channel } = makeManager(() => ({ silent: true }))
    const front = manager.run(ENTRY_PROD, '/srv/app', 'front', { timeoutMs: 2000 })
    const frontError = expect(front).rejects.toMatchObject({ code: 'REMOTE_ERROR', outcome: 'unknown' })
    await vi.waitFor(() => expect(channel.commands).toHaveLength(2))
    const queued = manager.run(ENTRY_PROD, '/srv/app', 'queued', { timeoutMs: 2000 })
    const queueError = expect(queued).rejects.toMatchObject({ code: 'REMOTE_ERROR', outcome: 'not-started' })
    await new Promise(resolve => setImmediate(resolve))
    channel.die()
    await Promise.all([frontError, queueError])
    expect(channel.commands).not.toContain('queued')
    expect(manager.size).toBe(0)
    expect(channel.listenerCount).toBe(0)
    manager.dispose()
  })

  it('closes a late channel returned after the manager was disposed without writing initialization', async () => {
    let ready!: (channel: RemoteShellChannel) => void
    const opening = new Promise<RemoteShellChannel>(resolve => { ready = resolve })
    const channel = new FakeChannel()
    const manager = new PersistentShellManager({ open: async (_entry, options) => managedOpen(opening, options), idleMs: 0 })
    const pending = manager.run(ENTRY_PROD, '/srv/app', 'never', { timeoutMs: 2000 })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'not-started' })
    await new Promise(resolve => setImmediate(resolve))
    let finished = false
    void pending.then(() => { finished = true }, () => { finished = true })
    manager.dispose()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(finished).toBe(false)
    await rejected
    ready(channel)
    await vi.waitFor(() => expect(channel.closed).toBe(true))
    expect(channel.writes).toEqual([])
    expect(manager.size).toBe(0)
  })

  it('keeps shared initialization finite even when its caller has a longer budget', async () => {
    vi.useFakeTimers()
    const opening = new Promise<RemoteShellChannel>(() => {})
    const manager = new PersistentShellManager({ open: async (_entry, options) => managedOpen(opening, options), idleMs: 0 })
    const pending = manager.run(ENTRY_PROD, '/srv/app', 'never', { timeoutMs: 60_000 })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'not-started' })
    let finished = false
    void pending.then(() => { finished = true }, () => { finished = true })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(manager.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    manager.dispose()
  })

  it('cleans a synchronously failed frame write and does not leave a poisoned cache', async () => {
    const { manager, channel } = makeManager(() => { throw new Error('write failed') })
    await expect(manager.run(ENTRY_PROD, '/srv/app', 'bad', { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'REMOTE_ERROR', outcome: 'unknown' })
    expect(channel.closed).toBe(true)
    expect(channel.listenerCount).toBe(0)
    expect(manager.size).toBe(0)
    manager.dispose()
  })
})
