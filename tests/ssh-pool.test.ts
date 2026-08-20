import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper, Stats } from 'ssh2'
import ssh2 from 'ssh2'

const { utils } = ssh2
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RwError } from '../src/errors.js'
import type { RwErrorCode } from '../src/errors.js'
import type { HostEntry } from '../src/hosts.js'
import { KnownHosts } from '../src/known-hosts.js'
import type { PoolOptions } from '../src/ssh-pool.js'
import { SshPool } from '../src/ssh-pool.js'

// ---------------------------------------------------------------------------
// FakeClient: an EventEmitter scripted to behave like ssh2.Client.
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter {
  stderr = new EventEmitter()
  closed = false
  close(): void {
    this.closed = true
    queueMicrotask(() => this.emit('close'))
  }
}

interface FakeScript {
  /** host key blob offered during the handshake (triggers hostVerifier) */
  hostKey?: Buffer
  /** error emitted instead of 'ready' */
  connectError?: Error
  /** what to do with an exec'd stream */
  onStream?: (stream: FakeStream, command: string) => void
  /** custom sftp responder */
  onSftp?: (cb: (err: Error | undefined, sftp?: SFTPWrapper) => void) => void
}

class FakeClient extends EventEmitter {
  config: ConnectConfig | undefined
  ended = false
  commands: string[] = []
  private script: FakeScript

  constructor(script: FakeScript = {}) {
    super()
    this.script = script
  }

  connect(config: ConnectConfig): void {
    this.config = config
    queueMicrotask(() => {
      const verifier = config.hostVerifier as ((key: Buffer) => boolean) | undefined
      if (this.script.hostKey !== undefined && verifier) {
        // this is what ssh2 does when the verifier rejects: generic error
        if (!verifier(this.script.hostKey)) {
          this.emit('error', new Error('Host denied (verification failed)'))
          return
        }
      }
      if (this.script.connectError) this.emit('error', this.script.connectError)
      else this.emit('ready')
    })
  }

  exec(command: string, cb: (err: Error | undefined, stream?: ClientChannel) => void): void {
    this.commands.push(command)
    const stream = new FakeStream()
    cb(undefined, stream as unknown as ClientChannel)
    queueMicrotask(() => {
      if (this.script.onStream) this.script.onStream(stream, command)
      else {
        stream.emit('exit', 0)
        stream.emit('close')
      }
    })
  }

  sftp(cb: (err: Error | undefined, sftp?: SFTPWrapper) => void): void {
    queueMicrotask(() => {
      if (this.script.onSftp) this.script.onSftp(cb)
      else cb(new Error('sftp not scripted'))
    })
  }

  end(): void {
    this.ended = true
    queueMicrotask(() => this.emit('close'))
  }
}

// ---------------------------------------------------------------------------

let dir: string
let knownHosts: KnownHosts
let fakes: FakeClient[]
let factoryCalls: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-pool-'))
  knownHosts = new KnownHosts(join(dir, 'known_hosts'))
  fakes = []
  factoryCalls = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function pushFake(script: FakeScript = {}): FakeClient {
  const f = new FakeClient(script)
  fakes.push(f)
  return f
}

function makePool(opts: Partial<PoolOptions> = {}): SshPool {
  return new SshPool({
    hostKeyPolicy: 'accept-new',
    knownHosts,
    connectTimeoutMs: 1000,
    commandTimeoutMs: 1000,
    maxOutputChars: 200000,
    ...opts,
    clientFactory: () => {
      factoryCalls++
      const f = fakes[fakes.length - 1]
      if (!f) throw new Error('no fake scripted')
      return f as unknown as Client
    },
  })
}

function entry(over: Partial<HostEntry> = {}): HostEntry {
  return {
    alias: 'h',
    host: 'example.com',
    port: 22,
    user: 'u',
    auth: { kind: 'password', password: 'pw' },
    source: 'manual',
    ...over,
  }
}

async function expectRw(p: Promise<unknown>, code: RwErrorCode): Promise<RwError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(RwError)
    expect((err as RwError).code).toBe(code)
    return err as RwError
  }
  throw new Error(`expected rejection with ${code}`)
}

/** A real ed25519 public key blob, as ssh2 hands it to hostVerifier. */
function makeHostKey(): { blob: Buffer; base64: string; type: string } {
  const kp = utils.generateKeyPairSync('ed25519')
  const [type, base64] = kp.public.split(' ') as [string, string]
  return { blob: Buffer.from(base64, 'base64'), base64, type }
}

describe('connection lifecycle', () => {
  it('connects once and reuses the connection per alias', async () => {
    const fake = pushFake()
    const pool = makePool()
    const r1 = await pool.exec(entry(), 'true')
    const r2 = await pool.exec(entry(), 'id')
    expect(r1.code).toBe(0)
    expect(r2.code).toBe(0)
    expect(factoryCalls).toBe(1)
    expect(fake.commands).toEqual(['true', 'id'])
    expect(pool.connected()).toEqual(['h'])
    pool.dispose()
  })

  it('dedupes concurrent connects', async () => {
    pushFake()
    const pool = makePool()
    const [a, b] = await Promise.all([pool.exec(entry(), 'true'), pool.exec(entry(), 'true')])
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    expect(factoryCalls).toBe(1)
    pool.dispose()
  })

  it('passes auth and keepalive settings through', async () => {
    const fake = pushFake()
    const pool = makePool({ connectTimeoutMs: 4321 })
    await pool.exec(entry(), 'true')
    expect(fake.config).toMatchObject({
      host: 'example.com',
      port: 22,
      username: 'u',
      password: 'pw',
      readyTimeout: 4321,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    })
    pool.dispose()
  })

  it('reconnects lazily after the connection closes', async () => {
    const first = pushFake()
    const pool = makePool()
    await pool.exec(entry(), 'true')
    first.end()
    await new Promise((r) => setImmediate(r))
    expect(pool.connected()).toEqual([])

    pushFake()
    await pool.exec(entry(), 'true')
    expect(factoryCalls).toBe(2)
    expect(pool.connected()).toEqual(['h'])
    pool.dispose()
  })

  it('forgets failed connections so the next attempt dials fresh', async () => {
    pushFake({ connectError: new Error('All configured authentication methods failed') })
    const pool = makePool()
    await expectRw(pool.exec(entry(), 'true'), 'AUTH_FAILED')
    expect(pool.connected()).toEqual([])

    pushFake()
    await pool.exec(entry(), 'true')
    expect(factoryCalls).toBe(2)
    pool.dispose()
  })

  it('disconnect() ends the client and drops the alias', async () => {
    const fake = pushFake()
    const pool = makePool()
    await pool.exec(entry(), 'true')
    pool.disconnect('h')
    expect(fake.ended).toBe(true)
    expect(pool.connected()).toEqual([])
    pool.dispose()
  })

  it('testConnect resolves with a latency in ms', async () => {
    pushFake()
    const pool = makePool()
    const ms = await pool.testConnect(entry())
    expect(typeof ms).toBe('number')
    expect(ms).toBeGreaterThanOrEqual(0)
    pool.dispose()
  })
})

describe('auth errors', () => {
  it('maps handshake auth failure to AUTH_FAILED', async () => {
    pushFake({ connectError: new Error('All configured authentication methods failed') })
    const pool = makePool()
    await expectRw(pool.exec(entry(), 'true'), 'AUTH_FAILED')
    pool.dispose()
  })

  it('rejects key auth without a keyPath as AUTH_FAILED before dialing', async () => {
    const fake = pushFake()
    const pool = makePool()
    const err = await expectRw(pool.exec(entry({ auth: { kind: 'key', keyPath: '' } }), 'true'), 'AUTH_FAILED')
    expect(err.message).toContain('no credentials')
    expect(fake.config).toBeUndefined() // connect() never called
    pool.dispose()
  })

  it('rejects password auth without a stored password', async () => {
    pushFake()
    const pool = makePool()
    await expectRw(pool.exec(entry({ auth: { kind: 'password' } }), 'true'), 'AUTH_FAILED')
    pool.dispose()
  })

  it('rejects an unreadable private key as AUTH_FAILED without leaking material', async () => {
    pushFake()
    const pool = makePool()
    const missing = join(dir, 'no-such-key')
    const err = await expectRw(pool.exec(entry({ auth: { kind: 'key', keyPath: missing } }), 'true'), 'AUTH_FAILED')
    expect(err.message).toContain(missing)
    pool.dispose()
  })

  it('reads the private key file for key auth', async () => {
    const keyPath = join(dir, 'id_test')
    writeFileSync(keyPath, 'KEY MATERIAL')
    const fake = pushFake()
    const pool = makePool()
    await pool.exec(entry({ auth: { kind: 'key', keyPath, passphrase: 'pp' } }), 'true')
    expect(fake.config?.privateKey?.toString()).toBe('KEY MATERIAL')
    expect(fake.config?.passphrase).toBe('pp')
    expect(fake.config?.password).toBeUndefined()
    pool.dispose()
  })
})

describe('host key verification', () => {
  it('accept-new learns an unknown host key and lets the connection through', async () => {
    const key = makeHostKey()
    pushFake({ hostKey: key.blob })
    const pool = makePool({ hostKeyPolicy: 'accept-new' })
    await pool.exec(entry(), 'true')
    expect(knownHosts.verify('example.com', 22, 'ssh-ed25519', key.base64)).toBe('match')
    expect(readFileSync(knownHosts.path, 'utf8')).toContain(`example.com ssh-ed25519 ${key.base64}`)
    pool.dispose()
  })

  it('strict rejects an unknown host key with HOSTKEY_UNKNOWN', async () => {
    pushFake({ hostKey: makeHostKey().blob })
    const pool = makePool({ hostKeyPolicy: 'strict' })
    await expectRw(pool.exec(entry(), 'true'), 'HOSTKEY_UNKNOWN')
    expect(pool.connected()).toEqual([])
    pool.dispose()
  })

  it('rejects a changed host key with HOSTKEY_CHANGED and does not touch known_hosts', async () => {
    const old = makeHostKey()
    knownHosts.accept('example.com', 22, 'ssh-ed25519', old.base64)
    const before = readFileSync(knownHosts.path, 'utf8')

    pushFake({ hostKey: makeHostKey().blob }) // different key
    const pool = makePool({ hostKeyPolicy: 'accept-new' })
    const err = await expectRw(pool.exec(entry(), 'true'), 'HOSTKEY_CHANGED')
    expect(err.message).toContain(knownHosts.path)
    expect(readFileSync(knownHosts.path, 'utf8')).toBe(before)
    pool.dispose()
  })

  it('accepts a matching host key', async () => {
    const key = makeHostKey()
    knownHosts.accept('example.com', 22, 'ssh-ed25519', key.base64)
    pushFake({ hostKey: key.blob })
    const pool = makePool({ hostKeyPolicy: 'strict' })
    await pool.exec(entry(), 'true')
    expect(pool.connected()).toEqual(['h'])
    pool.dispose()
  })

  it('records [host]:port for non-default ports', async () => {
    const key = makeHostKey()
    pushFake({ hostKey: key.blob })
    const pool = makePool({ hostKeyPolicy: 'accept-new' })
    await pool.exec(entry({ port: 2222 }), 'true')
    expect(knownHosts.verify('example.com', 2222, 'ssh-ed25519', key.base64)).toBe('match')
    pool.dispose()
  })

  it('fails closed with HOSTKEY_VERIFY_FAILED when the key blob is unparseable', async () => {
    pushFake({ hostKey: Buffer.from('not a key blob') })
    const pool = makePool({ hostKeyPolicy: 'accept-new' })
    await expectRw(pool.exec(entry(), 'true'), 'HOSTKEY_VERIFY_FAILED')
    pool.dispose()
  })

  it('policy off skips hostVerifier entirely', async () => {
    const fake = pushFake({ hostKey: makeHostKey().blob })
    const pool = makePool({ hostKeyPolicy: 'off' })
    await pool.exec(entry(), 'true')
    expect(fake.config?.hostVerifier).toBeUndefined()
    expect(pool.connected()).toEqual(['h'])
    pool.dispose()
  })
})

describe('exec', () => {
  it('prefixes a shell-escaped cd when cwd is given', async () => {
    const fake = pushFake()
    const pool = makePool()
    await pool.exec(entry(), 'ls -la', { cwd: `/srv/a'b` })
    expect(fake.commands[0]).toBe(`cd '/srv/a'\\''b' && ls -la`)
    pool.dispose()
  })

  it('collects stdout and stderr separately', async () => {
    pushFake({
      onStream: (s) => {
        s.emit('data', Buffer.from('hello '))
        s.emit('data', Buffer.from('world'))
        s.stderr.emit('data', Buffer.from('oops'))
        s.emit('exit', 3)
        s.emit('close')
      },
    })
    const pool = makePool()
    const r = await pool.exec(entry(), 'x')
    expect(r).toMatchObject({ code: 3, signal: null, stdout: 'hello world', stderr: 'oops', timedOut: false })
    pool.dispose()
  })

  it('reports signal-based termination', async () => {
    pushFake({
      onStream: (s) => {
        s.emit('exit', null, 'SIGKILL')
        s.emit('close')
      },
    })
    const pool = makePool()
    const r = await pool.exec(entry(), 'x')
    expect(r).toMatchObject({ code: null, signal: 'SIGKILL' })
    pool.dispose()
  })

  it('caps output at maxOutputChars and marks truncation', async () => {
    pushFake({
      onStream: (s) => {
        s.emit('data', Buffer.from('x'.repeat(50)))
        s.stderr.emit('data', Buffer.from('y'.repeat(50)))
        s.emit('exit', 0)
        s.emit('close')
      },
    })
    const pool = makePool({ maxOutputChars: 10 })
    const r = await pool.exec(entry(), 'x')
    expect(r.stdout).toBe(`${'x'.repeat(10)}\n…[truncated]`)
    expect(r.stderr).toBe(`${'y'.repeat(10)}\n…[truncated]`)
    pool.dispose()
  })

  it('resolves (not rejects) with timedOut on command timeout', async () => {
    let stream: FakeStream | undefined
    pushFake({
      onStream: (s) => {
        stream = s // never emits: the remote command hangs
      },
    })
    const pool = makePool()
    const r = await pool.exec(entry(), 'sleep 999', { timeoutMs: 25 })
    expect(r.timedOut).toBe(true)
    expect(r.signal).toBe('TIMEOUT')
    expect(r.code).toBeNull()
    expect(stream?.closed).toBe(true)
    pool.dispose()
  })

  it('rejects stream errors via mapConnectError', async () => {
    pushFake({
      onStream: (s) => {
        s.emit('error', new Error('channel open failure'))
      },
    })
    const pool = makePool()
    await expectRw(pool.exec(entry(), 'x'), 'REMOTE_ERROR')
    pool.dispose()
  })

  it('rejects exec callback errors via mapConnectError', async () => {
    class ExecFailClient extends FakeClient {
      override exec(_cmd: string, cb: (err: Error | undefined, stream?: ClientChannel) => void): void {
        queueMicrotask(() => cb(new Error('Timed out while opening channel')))
      }
    }
    fakes.push(new ExecFailClient())
    const pool = makePool()
    await expectRw(pool.exec(entry(), 'x'), 'CONN_TIMEOUT')
    pool.dispose()
  })
})

describe('sftp', () => {
  const fakeStats = (dir: boolean): Stats =>
    ({
      isDirectory: () => dir,
      isSymbolicLink: () => false,
      isFile: () => !dir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      mode: 0o100644,
      uid: 0,
      gid: 0,
      size: 42,
      atime: 1,
      mtime: 2,
    }) as Stats

  it('promisifies the SFTP surface used by P3', async () => {
    pushFake({
      onSftp: (cb) => {
        const raw = {
          readdir: (p: string, cb2: (err: Error | undefined, list?: unknown[]) => void) =>
            cb2(undefined, [{ filename: 'f.txt', longname: '-rw-r--r-- f.txt', attrs: fakeStats(false) }]),
          stat: (p: string, cb2: (err: Error | undefined, s?: Stats) => void) => cb2(undefined, fakeStats(false)),
          lstat: (p: string, cb2: (err: Error | undefined, s?: Stats) => void) => cb2(undefined, fakeStats(true)),
          realpath: (p: string, cb2: (err: Error | undefined, abs?: string) => void) => cb2(undefined, `/real${p}`),
          readFile: (p: string, cb2: (err: Error | undefined, data?: Buffer) => void) =>
            cb2(undefined, Buffer.from('content')),
          writeFile: (p: string, data: Buffer, cb2: (err?: Error) => void) => cb2(),
          mkdir: (p: string, cb2: (err?: Error) => void) => cb2(),
          rename: (a: string, b: string, cb2: (err?: Error) => void) => cb2(),
          unlink: (p: string, cb2: (err?: Error) => void) => cb2(),
          rmdir: (p: string, cb2: (err?: Error) => void) => cb2(),
        } as unknown as SFTPWrapper
        cb(undefined, raw)
      },
    })
    const pool = makePool()
    const sftp = await pool.sftp(entry())

    const list = await sftp.readdir('/w')
    expect(list).toHaveLength(1)
    expect(list[0]?.filename).toBe('f.txt')
    expect(list[0]?.attrs.size).toBe(42)
    expect(list[0]?.attrs.isDirectory()).toBe(false)

    expect((await sftp.stat('/w/f')).size).toBe(42)
    expect((await sftp.lstat('/w')).isDirectory()).toBe(true)
    expect(await sftp.realpath('/w/../w')).toBe('/real/w/../w')
    expect((await sftp.readFile('/w/f')).toString()).toBe('content')
    await sftp.writeFile('/w/f', Buffer.from('x'))
    await sftp.mkdir('/w/d')
    await sftp.rename('/w/f', '/w/g')
    await sftp.unlink('/w/g')
    await sftp.rmdir('/w/d')
    pool.dispose()
  })

  it('propagates SFTP operation errors', async () => {
    pushFake({
      onSftp: (cb) => {
        const raw = {
          readFile: (p: string, cb2: (err: Error | undefined, data?: Buffer) => void) =>
            cb2(Object.assign(new Error('No such file'), { code: 2 })),
        } as unknown as SFTPWrapper
        cb(undefined, raw)
      },
    })
    const pool = makePool()
    const sftp = await pool.sftp(entry())
    await expect(sftp.readFile('/nope')).rejects.toThrowError('No such file')
    pool.dispose()
  })

  it('rejects when the SFTP subsystem is unavailable', async () => {
    pushFake({ onSftp: (cb) => cb(new Error('Unable to start SFTP subsystem')) })
    const pool = makePool()
    await expectRw(pool.sftp(entry()), 'REMOTE_ERROR')
    pool.dispose()
  })
})

describe('reconnect retry', () => {
  // Unlike makePool (which always serves the last pushed fake), the retry
  // tests need a deterministic dial order: fakes are served from a queue.
  function makeQueuedPool(queue: FakeClient[], opts: Partial<PoolOptions> = {}): SshPool {
    return new SshPool({
      hostKeyPolicy: 'accept-new',
      knownHosts,
      connectTimeoutMs: 1000,
      commandTimeoutMs: 1000,
      maxOutputChars: 200000,
      ...opts,
      clientFactory: () => {
        factoryCalls++
        const f = queue.shift()
        if (!f) throw new Error('no fake scripted')
        return f as unknown as Client
      },
    })
  }

  /** The connection dies exactly as the channel is opened. */
  class DeadExecClient extends FakeClient {
    override exec(_cmd: string, cb: (err: Error | undefined, stream?: ClientChannel) => void): void {
      this.emit('close')
      queueMicrotask(() => cb(new Error('Not connected')))
    }
  }

  /** The connection dies exactly as the SFTP subsystem is opened. */
  class DeadSftpClient extends FakeClient {
    override sftp(cb: (err: Error | undefined, sftp?: SFTPWrapper) => void): void {
      this.emit('close')
      queueMicrotask(() => cb(new Error('Not connected')))
    }
  }

  const okSftpScript: FakeScript = {
    onSftp: (cb) => {
      const raw = {
        readFile: (_p: string, cb2: (err: Error | undefined, data?: Buffer) => void) =>
          cb2(undefined, Buffer.from('content')),
      } as unknown as SFTPWrapper
      cb(undefined, raw)
    },
  }

  it('redials and retries exec once when the channel open fails on a dropped connection', async () => {
    const dead = new DeadExecClient()
    const good = new FakeClient()
    const pool = makeQueuedPool([dead, good])
    const r = await pool.exec(entry(), 'true')
    expect(r.code).toBe(0)
    expect(factoryCalls).toBe(2)
    expect(good.commands).toEqual(['true'])
    expect(pool.connected()).toEqual(['h'])
    pool.dispose()
  })

  it('surfaces the exec error when the retry attempt also fails (at most one retry)', async () => {
    const pool = makeQueuedPool([new DeadExecClient(), new DeadExecClient()])
    await expectRw(pool.exec(entry(), 'true'), 'REMOTE_ERROR')
    expect(factoryCalls).toBe(2) // no third dial
    expect(pool.connected()).toEqual([])
    pool.dispose()
  })

  it('does not retry a channel-open failure on a live connection', async () => {
    class LiveExecFailClient extends FakeClient {
      override exec(_cmd: string, cb: (err: Error | undefined, stream?: ClientChannel) => void): void {
        queueMicrotask(() => cb(new Error('Timed out while opening channel')))
      }
    }
    const pool = makeQueuedPool([new LiveExecFailClient()])
    await expectRw(pool.exec(entry(), 'x'), 'CONN_TIMEOUT')
    expect(factoryCalls).toBe(1)
    expect(pool.connected()).toEqual(['h']) // the connection itself is fine
    pool.dispose()
  })

  it('does not retry a stream failure after the channel opened, even when the connection dies', async () => {
    class DyingStreamClient extends FakeClient {
      override exec(_cmd: string, cb: (err: Error | undefined, stream?: ClientChannel) => void): void {
        const stream = new FakeStream()
        cb(undefined, stream as unknown as ClientChannel)
        queueMicrotask(() => {
          this.emit('close') // connection drops mid-command
          stream.emit('error', new Error('channel broke'))
        })
      }
    }
    const pool = makeQueuedPool([new DyingStreamClient()])
    await expectRw(pool.exec(entry(), 'x'), 'REMOTE_ERROR')
    expect(factoryCalls).toBe(1) // the command may have partially run — never retried
    pool.dispose()
  })

  it('redials and retries sftp once when the subsystem open fails on a dropped connection', async () => {
    const pool = makeQueuedPool([new DeadSftpClient(), new FakeClient(okSftpScript)])
    const sftp = await pool.sftp(entry())
    expect((await sftp.readFile('/w/f')).toString()).toBe('content')
    expect(factoryCalls).toBe(2)
    pool.dispose()
  })

  it('surfaces the sftp open error when the retry attempt also fails (at most one retry)', async () => {
    const pool = makeQueuedPool([new DeadSftpClient(), new DeadSftpClient()])
    await expectRw(pool.sftp(entry()), 'REMOTE_ERROR')
    expect(factoryCalls).toBe(2)
    pool.dispose()
  })

  it('re-acquires and retries an sftp op once when the connection dropped after acquisition', async () => {
    const stale = new FakeClient({
      onSftp: (cb) => {
        const raw = {
          readFile: (_p: string, cb2: (err: Error | undefined, data?: Buffer) => void) =>
            cb2(new Error('Not connected')),
        } as unknown as SFTPWrapper
        cb(undefined, raw)
      },
    })
    const pool = makeQueuedPool([stale, new FakeClient(okSftpScript)])
    const sftp = await pool.sftp(entry())
    stale.end() // the connection drops after the wrapper was acquired
    await new Promise((r) => setImmediate(r))
    expect(pool.connected()).toEqual([])

    const data = await sftp.readFile('/w/f')
    expect(data.toString()).toBe('content')
    expect(factoryCalls).toBe(2)
    pool.dispose()
  })

  it('does not retry sftp business errors (the client stays pooled)', async () => {
    const live = new FakeClient({
      onSftp: (cb) => {
        const raw = {
          readFile: (_p: string, cb2: (err: Error | undefined, data?: Buffer) => void) =>
            cb2(Object.assign(new Error('No such file'), { code: 2 })),
        } as unknown as SFTPWrapper
        cb(undefined, raw)
      },
    })
    const pool = makeQueuedPool([live])
    const sftp = await pool.sftp(entry())
    await expect(sftp.readFile('/nope')).rejects.toThrowError('No such file')
    expect(factoryCalls).toBe(1)
    pool.dispose()
  })

  // ── silently dead connections (half-open TCP: no error, no close, no
  // answer) — the channel/subsystem open is bounded by channelOpenTimeoutMs,
  // then dropped and retried on a fresh connection.

  /** The exec callback never fires — a silently dead connection. */
  class SilentExecClient extends FakeClient {
    override exec(_cmd: string, _cb: (err: Error | undefined, stream?: ClientChannel) => void): void {
      // half-open TCP: nothing ever comes back
    }
  }

  /** The sftp callback never fires — a silently dead connection. */
  class SilentSftpClient extends FakeClient {
    override sftp(_cb: (err: Error | undefined, sftp?: SFTPWrapper) => void): void {
      // half-open TCP: nothing ever comes back
    }
  }

  it('bounds the exec channel-open wait and retries on a fresh connection when the open never answers', async () => {
    const good = new FakeClient()
    const pool = makeQueuedPool([new SilentExecClient(), good], { channelOpenTimeoutMs: 30 })
    const r = await pool.exec(entry(), 'true')
    expect(r.code).toBe(0)
    expect(factoryCalls).toBe(2)
    expect(good.commands).toEqual(['true'])
    pool.dispose()
  })

  it('surfaces CONN_TIMEOUT when the exec retry attempt also times out (at most one retry)', async () => {
    const pool = makeQueuedPool([new SilentExecClient(), new SilentExecClient()], { channelOpenTimeoutMs: 30 })
    await expectRw(pool.exec(entry(), 'true'), 'CONN_TIMEOUT')
    expect(factoryCalls).toBe(2) // no third dial
    pool.dispose()
  })

  it('bounds the sftp open wait and retries on a fresh connection when the open never answers', async () => {
    const pool = makeQueuedPool([new SilentSftpClient(), new FakeClient(okSftpScript)], { channelOpenTimeoutMs: 30 })
    const sftp = await pool.sftp(entry())
    expect((await sftp.readFile('/w/f')).toString()).toBe('content')
    expect(factoryCalls).toBe(2)
    pool.dispose()
  })

  it('drops the pooled client on a post-ready error (not only on close), so the subsequent open failure retries', async () => {
    class ErrorThenDeadExecClient extends FakeClient {
      override exec(_cmd: string, cb: (err: Error | undefined, stream?: ClientChannel) => void): void {
        this.emit('error', new Error('socket blew up')) // 'close' may lag behind or never arrive
        queueMicrotask(() => cb(new Error('Not connected')))
      }
    }
    const good = new FakeClient()
    const pool = makeQueuedPool([new ErrorThenDeadExecClient(), good])
    const r = await pool.exec(entry(), 'true')
    expect(r.code).toBe(0)
    expect(factoryCalls).toBe(2)
    expect(good.commands).toEqual(['true'])
    pool.dispose()
  })
})
