// Persistent-shell framing tests: a fake channel speaks the same sentinel
// protocol the real `bash` process does, so these cover framing, serialisation,
// timeouts, reconnects and idle teardown without an SSH server.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersistentShellManager } from '../src/persistent-shell.js'
import type { RemoteShellChannel } from '../src/ssh-pool.js'
import { ENTRY_PROD } from './p4-fakes.js'

const RS = String.fromCharCode(30)

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
  initResult: { code?: number } = {}
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
    const result = isInit ? { code: this.initResult.code ?? 0 } : this.handler(command)
    if (result.silent === true) return
    setImmediate(() => {
      if (this.closed) return
      this.emit(`${result.out ?? ''}\n${RS}${mark}:${result.code ?? 0}${RS}\n`)
    })
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCb = cb
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb
  }

  onClose(cb: () => void): void {
    this.closeCb = cb
  }

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
    const res = await manager.run(ENTRY_PROD, '/srv/app', 'sleep 99', { timeoutMs: 20 })
    expect(res.timedOut).toBe(true)
    expect(res.signal).toBe('TIMEOUT')
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
