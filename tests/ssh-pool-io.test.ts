import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper, Stats } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RwError } from '../src/errors.js'
import { runRemoteIo } from '../src/io-context.js'
import { KnownHosts } from '../src/known-hosts.js'
import type { HostEntry } from '../src/hosts.js'
import { SshPool } from '../src/ssh-pool.js'
import type { PoolOptions, SftpLike } from '../src/ssh-pool.js'

const ENTRY: HostEntry = { alias: 'h', host: 'example.invalid', port: 22, user: 'test', auth: { kind: 'password', password: 'fixture' }, source: 'manual' }
const STATS = { size: 4, mtime: 1, isDirectory: () => false, isSymbolicLink: () => false } as Stats
class Stream extends EventEmitter {
  stderr = new EventEmitter()
  closed = false
  writes: string[] = []
  close() { this.closed = true; this.emit('close') }
  destroy() { this.close() }
  write(value: string) { this.writes.push(value) }
}
class Raw extends EventEmitter {
  ended = false
  ends = 0
  hangs = new Set<string>()
  calls: string[] = []
  callbacks: Array<(error?: Error, value?: unknown) => void> = []
  private respond(name: string, cb: (error?: Error, value?: unknown) => void, value?: unknown) {
    this.calls.push(name)
    if (this.hangs.has(name)) this.callbacks.push(cb)
    else cb(undefined, value)
  }
  stat(_p: string, cb: (error?: Error, value?: unknown) => void) { this.respond('stat', cb, STATS) }
  lstat(_p: string, cb: (error?: Error, value?: unknown) => void) { this.respond('lstat', cb, STATS) }
  realpath(p: string, cb: (error?: Error, value?: unknown) => void) { this.respond('realpath', cb, p) }
  readdir(_p: string, cb: (error?: Error, value?: unknown) => void) { this.respond('readdir', cb, []) }
  readFile(_p: string, cb: (error?: Error, value?: unknown) => void) { this.respond('readFile', cb, Buffer.from('data')) }
  writeFile(_p: string, _data: Buffer, cb: (error?: Error, value?: unknown) => void) { this.respond('writeFile', cb) }
  mkdir(_p: string, cb: (error?: Error, value?: unknown) => void) { this.respond('mkdir', cb) }
  rename(_a: string, _b: string, cb: (error?: Error, value?: unknown) => void) { this.respond('rename', cb) }
  unlink(_p: string, cb: (error?: Error, value?: unknown) => void) { this.respond('unlink', cb) }
  rmdir(_p: string, cb: (error?: Error, value?: unknown) => void) { this.respond('rmdir', cb) }
  // Deliberately no peer close event: local facade settlement must not wait for ACK.
  end() { this.ended = true; this.ends++ }
  destroy() { this.end() }
}
class Transport extends EventEmitter {
  config?: ConnectConfig
  destroyed = false
  connects = 0
  commands: string[] = []
  streams: Stream[] = []
  raws: Raw[] = []
  connectFn?: () => void
  execFn?: (cb: (error?: Error, stream?: ClientChannel) => void, command: string) => void
  sftpFn?: (cb: (error?: Error, raw?: SFTPWrapper) => void) => void
  connect(config: ConnectConfig) { this.config = config; this.connects++; if (this.connectFn) this.connectFn(); else queueMicrotask(() => this.emit('ready')) }
  exec(command: string, cb: (error?: Error, stream?: ClientChannel) => void) {
    this.commands.push(command)
    if (this.execFn) { this.execFn(cb, command); return }
    const stream = new Stream()
    this.streams.push(stream)
    cb(undefined, stream as unknown as ClientChannel)
    queueMicrotask(() => { stream.emit('exit', 0); stream.close() })
  }
  sftp(cb: (error?: Error, raw?: SFTPWrapper) => void) {
    if (this.sftpFn) { this.sftpFn(cb); return }
    const raw = this.raws.shift() ?? new Raw()
    queueMicrotask(() => cb(undefined, raw as unknown as SFTPWrapper))
  }
  // Late actual events are explicitly controlled by each test.
  destroy() { this.destroyed = true }
  end() { this.destroy() }
}
let fixture: string
let pools: SshPool[]
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'dsh-rw-pool-io-')); pools = [] })
afterEach(() => {
  for (const pool of pools) pool.dispose()
  vi.restoreAllMocks(); vi.useRealTimers()
  if (!basename(fixture).startsWith('dsh-rw-pool-io-') || !realpathSync(fixture).startsWith(realpathSync(tmpdir()) + sep)) throw Error('unexpected fixture cleanup path')
  rmSync(fixture, { recursive: true, force: true })
})
function makePool(clients: Transport[], options: Partial<PoolOptions> = {}) {
  let dials = 0
  const pool = new SshPool({ hostKeyPolicy: 'off', knownHosts: new KnownHosts(join(fixture, 'known_hosts')),
    connectTimeoutMs: 1000, commandTimeoutMs: 1000, operationTimeoutMs: 20, channelOpenTimeoutMs: 1000, maxOutputChars: 1000,
    ...options, clientFactory: () => {
      const client = clients[dials++]
      if (!client) throw Error('unexpected redial')
      return client as unknown as Client
    } })
  pools.push(pool)
  return { pool, dials: () => dials }
}
function clock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
}
const flush = () => vi.advanceTimersByTimeAsync(0)
function invoke(sftp: SftpLike, method: string): Promise<unknown> {
  switch (method) {
    case 'readdir': return sftp.readdir('/p')
    case 'stat': return sftp.stat('/p')
    case 'lstat': return sftp.lstat('/p')
    case 'realpath': return sftp.realpath('/p')
    case 'readFile': return sftp.readFile('/p')
    case 'writeFile': return sftp.writeFile('/p', Buffer.from('x'))
    case 'mkdir': return sftp.mkdir('/p')
    case 'rename': return sftp.rename('/a', '/b')
    case 'unlink': return sftp.unlink('/p')
    default: return sftp.rmdir('/p')
  }
}

describe('SFTP operation lifetimes', () => {
  it.each(['readdir', 'stat', 'lstat', 'realpath', 'readFile', 'writeFile', 'mkdir', 'rename', 'unlink', 'rmdir'])('bounds a %s callback that never arrives', async method => {
    clock()
    const raw = new Raw(); raw.hangs.add(method)
    const client = new Transport(); client.raws.push(raw)
    const { pool, dials } = makePool([client])
    const facade = await pool.sftp(ENTRY)
    const promise = invoke(facade, method)
    const rejected = expect(promise).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'unknown' })
    await vi.advanceTimersByTimeAsync(21); await rejected
    expect(raw.ended).toBe(true)
    expect(client.destroyed).toBe(false)
    expect(raw.calls).toEqual([method])
    expect(dials()).toBe(1)
    await expect(facade.stat('/later')).rejects.toMatchObject({ outcome: 'not-started' })
  })

  it('rejects a late SFTP success even when the event loop has not dispatched the timer', async () => {
    clock()
    let mono = 0
    vi.spyOn(performance, 'now').mockImplementation(() => mono)
    const raw = new Raw()
    raw.stat = (_p, cb) => { mono = 21; cb(undefined, STATS) }
    const client = new Transport(); client.raws.push(raw)
    const { pool } = makePool([client])
    const facade = await pool.sftp(ENTRY)
    await expect(facade.stat('/p')).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'unknown' })
    expect(raw.ended).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('scope completion releases its facade exactly once without retiring the Client', async () => {
    clock()
    const raw = new Raw(), client = new Transport(); client.raws.push(raw)
    const { pool } = makePool([client])
    await runRemoteIo({ timeoutMs: 100 }, async () => {
      const facade = await pool.sftp(ENTRY)
      expect((await facade.stat('/p')).size).toBe(4)
      expect(raw.ended).toBe(false)
    })
    expect(raw.ends).toBe(1)
    expect(client.destroyed).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels only its own facade while another facade stays usable', async () => {
    clock()
    const first = new Raw(), second = new Raw(); first.hangs.add('readFile')
    const client = new Transport(); client.raws.push(first, second)
    const { pool } = makePool([client])
    const controller = new AbortController()
    const a = await pool.sftp(ENTRY, { signal: controller.signal })
    const b = await pool.sftp(ENTRY)
    const rejected = expect(a.readFile('/p')).rejects.toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'unknown' })
    controller.abort(); await rejected
    expect(first.ends).toBe(1); expect(second.ended).toBe(false)
    expect(client.destroyed).toBe(false)
    expect((await b.stat('/p')).size).toBe(4)
    b.close?.()
  })

  it('settles a composite callback on channel end even without the final callback', async () => {
    clock()
    const raw = new Raw(); raw.hangs.add('readFile')
    const client = new Transport(); client.raws.push(raw)
    const { pool } = makePool([client])
    const facade = await pool.sftp(ENTRY)
    const rejected = expect(facade.readFile('/p')).rejects.toMatchObject({ code: 'NOT_CONNECTED', outcome: 'unknown' })
    raw.emit('end'); await rejected
    expect(raw.ended).toBe(true)
    expect(() => raw.emit('error', new Error('late error'))).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retires one transport and settles all its facades without waiting on raw callbacks', async () => {
    clock()
    const a = new Raw(), b = new Raw(); a.hangs.add('readFile'); b.hangs.add('writeFile')
    const client = new Transport(); client.raws.push(a, b)
    const { pool } = makePool([client])
    const fa = await pool.sftp(ENTRY), fb = await pool.sftp(ENTRY)
    const ra = expect(fa.readFile('/p')).rejects.toMatchObject({ outcome: 'unknown' })
    const rb = expect(fb.writeFile('/p', Buffer.from('x'))).rejects.toMatchObject({ outcome: 'unknown' })
    pool.disconnect('h'); await Promise.all([ra, rb])
    expect(a.ended && b.ended).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not replay a write after a lost transport response', async () => {
    clock()
    const raw = new Raw(); raw.hangs.add('writeFile')
    const first = new Transport(), second = new Transport(); first.raws.push(raw)
    const { pool, dials } = makePool([first, second])
    const facade = await pool.sftp(ENTRY)
    const rejected = expect(facade.writeFile('/p', Buffer.from('one write'))).rejects.toMatchObject({ outcome: 'unknown' })
    first.emit('error', new Error('transport lost')); await rejected
    expect(raw.calls).toEqual(['writeFile']); expect(dials()).toBe(1)
  })

  it('keeps a healthy shared transport during a quota refusal on another acquire', async () => {
    clock()
    const raw = new Raw(); raw.hangs.add('writeFile')
    const client = new Transport(); let opens = 0
    client.sftpFn = cb => { if (opens++ === 0) cb(undefined, raw as unknown as SFTPWrapper); else cb(Object.assign(new Error('quota'), { reason: 1 })) }
    const { pool, dials } = makePool([client])
    const facade = await pool.sftp(ENTRY)
    const writing = facade.writeFile('/p', Buffer.from('x'))
    await expect(pool.sftp(ENTRY)).rejects.toMatchObject({ code: 'REMOTE_ERROR' })
    expect(client.destroyed).toBe(false); expect(dials()).toBe(1)
    raw.callbacks[0]?.(); await writing
    facade.close?.()
  })

  it('cleans a late SFTP callback after an opening cancellation, without redial', async () => {
    clock()
    const client = new Transport(); let callback: ((error?: Error, raw?: SFTPWrapper) => void) | undefined
    client.sftpFn = cb => { callback = cb }
    const { pool, dials } = makePool([client])
    const ctl = new AbortController()
    const rejected = expect(pool.sftp(ENTRY, { signal: ctl.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'not-started' })
    await flush(); ctl.abort(); await rejected
    expect(client.destroyed).toBe(true); expect(dials()).toBe(1)
    const late = new Raw(); callback?.(undefined, late as unknown as SFTPWrapper)
    expect(late.ended).toBe(true); expect(late.calls).toEqual([])
    expect(() => late.emit('error', new Error('late closed SFTP error'))).not.toThrow()
  })

  it('guards SFTP error during the ready-to-facade handoff', async () => {
    clock()
    const client = new Transport(), raw = new Raw()
    client.sftpFn = cb => {
      cb(undefined, raw as unknown as SFTPWrapper)
      queueMicrotask(() => raw.emit('error', new Error('handoff error')))
    }
    const { pool } = makePool([client])
    await expect(pool.sftp(ENTRY)).rejects.toMatchObject({ code: 'REMOTE_ERROR', outcome: 'not-started' })
    expect(raw.ended).toBe(true)
    expect(client.destroyed).toBe(false)
  })

  it('cannot widen an ambient scope deadline with longer explicit facade options', async () => {
    clock()
    const raw = new Raw(); raw.hangs.add('readFile')
    const client = new Transport(); client.raws.push(raw)
    const { pool } = makePool([client], { operationTimeoutMs: 1000 })
    const operation = runRemoteIo({ timeoutMs: 20 }, async () => {
      const facade = await pool.sftp(ENTRY, { timeoutMs: 1000, deadlineMs: Date.now() + 1000 })
      await facade.readFile('/p')
    })
    const rejected = expect(operation).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'unknown' })
    await vi.advanceTimersByTimeAsync(21); await rejected
    expect(raw.ended).toBe(true); expect(client.destroyed).toBe(false)
  })

  it('a longer ambient scope cannot renew the default SFTP operation timeout', async () => {
    clock()
    const raw = new Raw(); raw.hangs.add('readFile')
    const client = new Transport(); client.raws.push(raw)
    const { pool } = makePool([client], { operationTimeoutMs: 20 })
    const operation = runRemoteIo({ timeoutMs: 1000 }, async () => {
      const facade = await pool.sftp(ENTRY)
      await facade.readFile('/p')
    })
    const rejected = expect(operation).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(21); await rejected
    expect(raw.ended).toBe(true)
  })

  it('uses the explicit facade deadline across acquisition and business I/O', async () => {
    clock()
    const raw = new Raw(); raw.hangs.add('readFile')
    const client = new Transport()
    client.sftpFn = cb => { setTimeout(() => cb(undefined, raw as unknown as SFTPWrapper), 10) }
    const { pool } = makePool([client], { operationTimeoutMs: 1000 })
    const started = pool.sftp(ENTRY, { timeoutMs: 30 })
    await vi.advanceTimersByTimeAsync(10)
    const facade = await started
    const rejected = expect(facade.readFile('/p')).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(21); await rejected
    expect(raw.ended).toBe(true)
  })
})

describe('exec cancellation and generation isolation', () => {
  it('does not dial or dispatch when already cancelled', async () => {
    clock()
    const client = new Transport(), ctl = new AbortController(); ctl.abort()
    const { pool, dials } = makePool([client])
    await expect(pool.exec(ENTRY, 'must-not-run', { signal: ctl.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'not-started' })
    expect(dials()).toBe(0); expect(client.commands).toEqual([])
  })

  it('cancels one shared-connect waiter without killing another waiter', async () => {
    clock()
    const client = new Transport(); client.connectFn = () => undefined
    const { pool, dials } = makePool([client])
    const ctl = new AbortController()
    const first = expect(pool.exec(ENTRY, 'first', { signal: ctl.signal })).rejects.toMatchObject({ outcome: 'not-started' })
    const second = pool.exec(ENTRY, 'second')
    ctl.abort(); await first
    expect(client.destroyed).toBe(false)
    client.emit('ready'); expect((await second).code).toBe(0)
    expect(client.commands).toEqual(['second']); expect(dials()).toBe(1)
  })

  it('pool disposal immediately settles an owned handshake even without a close event', async () => {
    clock()
    const client = new Transport(); client.connectFn = () => undefined
    const { pool } = makePool([client])
    const rejected = expect(pool.exec(ENTRY, 'never sent')).rejects.toMatchObject({ code: 'NOT_CONNECTED', outcome: 'not-started' })
    await flush(); pool.dispose(); await rejected
    expect(client.destroyed).toBe(true)
    expect(client.commands).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels hidden exec open and closes a late channel without replaying it', async () => {
    clock()
    const old = new Transport(), next = new Transport()
    let callback: ((error?: Error, stream?: ClientChannel) => void) | undefined
    old.execFn = cb => { callback = cb }
    const { pool, dials } = makePool([old, next])
    const ctl = new AbortController()
    const rejected = expect(pool.exec(ENTRY, 'uncertain', { signal: ctl.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'unknown' })
    await flush(); ctl.abort(); await rejected
    expect(old.destroyed).toBe(true); expect(dials()).toBe(1)
    const late = new Stream(); callback?.(undefined, late as unknown as ClientChannel)
    expect(late.closed).toBe(true)
    expect(() => late.emit('error', new Error('late closed exec error'))).not.toThrow()
    expect((await pool.exec(ENTRY, 'next operation')).code).toBe(0)
    old.emit('close'); old.emit('error', new Error('late old error')); old.emit('ready')
    expect(pool.connected()).toEqual(['h']); expect(next.destroyed).toBe(false)
    expect(next.commands).toEqual(['next operation'])
  })

  it('cancels an exposed stream without closing another command on the Client', async () => {
    clock()
    const client = new Transport(), firstStream = new Stream()
    let calls = 0
    client.execFn = cb => {
      if (calls++ === 0) cb(undefined, firstStream as unknown as ClientChannel)
      else { const s = new Stream(); cb(undefined, s as unknown as ClientChannel); queueMicrotask(() => { s.emit('exit', 0); s.close() }) }
    }
    const { pool } = makePool([client])
    const ctl = new AbortController()
    const rejected = expect(pool.exec(ENTRY, 'cancel me', { signal: ctl.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'unknown' })
    await flush(); ctl.abort(); await rejected
    expect(firstStream.closed).toBe(true); expect(client.destroyed).toBe(false)
    expect((await pool.exec(ENTRY, 'other command')).code).toBe(0)
  })

  it('keeps one total deadline through connect, open, and command execution', async () => {
    clock()
    const client = new Transport()
    client.connectFn = () => { setTimeout(() => client.emit('ready'), 20) }
    client.execFn = cb => { setTimeout(() => cb(undefined, new Stream() as unknown as ClientChannel), 20) }
    const { pool } = makePool([client])
    let settled = false
    const command = pool.exec(ENTRY, 'long', { timeoutMs: 50 }).catch(error => { settled = true; throw error })
    const rejected = expect(command).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'unknown' })
    await vi.advanceTimersByTimeAsync(49); expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2); await rejected
  })

  it('rejects a late exposed exec-open callback and closes only that channel', async () => {
    clock()
    let mono = 0
    vi.spyOn(performance, 'now').mockImplementation(() => mono)
    const client = new Transport(), stream = new Stream()
    client.execFn = cb => { mono = 11; cb(undefined, stream as unknown as ClientChannel) }
    const { pool } = makePool([client], { channelOpenTimeoutMs: 10 })
    await expect(pool.exec(ENTRY, 'late open')).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'unknown' })
    expect(stream.closed).toBe(true)
    expect(client.destroyed).toBe(false)
  })

  it('rejects command close after deadline instead of accepting a late success', async () => {
    clock()
    let mono = 0
    vi.spyOn(performance, 'now').mockImplementation(() => mono)
    const client = new Transport(), stream = new Stream()
    client.execFn = cb => {
      cb(undefined, stream as unknown as ClientChannel)
      mono = 21; stream.emit('exit', 0); stream.close()
    }
    const { pool } = makePool([client])
    await expect(pool.exec(ENTRY, 'late close', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'unknown' })
    expect(client.destroyed).toBe(false)
  })

  it('does not report success when exec closes without exit-status or signal', async () => {
    clock()
    const client = new Transport(), stream = new Stream()
    client.execFn = cb => {
      cb(undefined, stream as unknown as ClientChannel)
      queueMicrotask(() => { stream.emit('data', Buffer.from('partial')); stream.close() })
    }
    const { pool, dials } = makePool([client])
    await expect(pool.exec(ENTRY, 'unknown completion')).rejects.toMatchObject({ code: 'REMOTE_ERROR', outcome: 'unknown' })
    expect(dials()).toBe(1)
    expect(client.destroyed).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('old ready/error/close cannot change a replacement Client generation', async () => {
    clock()
    const old = new Transport(), next = new Transport()
    const { pool, dials } = makePool([old, next])
    await pool.exec(ENTRY, 'first'); pool.disconnect('h')
    await pool.exec(ENTRY, 'second')
    old.emit('error', new Error('late')); old.emit('close'); old.emit('ready')
    expect(pool.connected()).toEqual(['h']); expect(next.destroyed).toBe(false)
    await pool.exec(ENTRY, 'third'); expect(dials()).toBe(2)
  })

  it('hands an opened shell to its manager and offers subscription disposers', async () => {
    clock()
    const client = new Transport(), stream = new Stream()
    client.execFn = cb => cb(undefined, stream as unknown as ClientChannel)
    const { pool } = makePool([client])
    const ctl = new AbortController()
    const channel = await pool.openShell(ENTRY, 'bash', { signal: ctl.signal })
    const seen = vi.fn(), closed = vi.fn()
    const off = channel.onData(seen), offClose = channel.onClose(closed)
    stream.emit('data', Buffer.from('a')); if (typeof off === 'function') off()
    stream.emit('data', Buffer.from('b')); expect(seen).toHaveBeenCalledTimes(1)
    if (typeof offClose === 'function') offClose()
    ctl.abort(); expect(stream.closed).toBe(false)
    channel.write('safe handoff')
    channel.close(); expect(closed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
