// Real ssh2 over an owned 127.0.0.1:0 server. No user hosts, user credentials,
// OS commands, profile state, or filesystem SFTP writes are involved.
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import ssh2 from 'ssh2'
import type { Connection, SFTPWrapper } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnownHosts } from '../src/known-hosts.js'
import { SshPool } from '../src/ssh-pool.js'
import type { HostEntry } from '../src/hosts.js'

const { Server } = ssh2
const attrs = { mode: 0o100644, uid: 0, gid: 0, size: 4, atime: 1, mtime: 1 }
let fixture: string
let server: InstanceType<typeof Server>
let pool: SshPool
let entry: HostEntry
let peers: Set<Connection>
let channels: Array<{ raw: SFTPWrapper; closed: Promise<void>; isClosed: boolean }>
let connections: number
let listening = false
let writes: number
let readEntered: Promise<void>
let markReadEntered: () => void

function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('owned loopback fixture did not settle')), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
beforeEach(async () => {
  fixture = mkdtempSync(join(tmpdir(), 'dsh-rw-ssh-loopback-'))
  peers = new Set(); channels = []; connections = 0; writes = 0; listening = false
  readEntered = new Promise(resolve => { markReadEntered = resolve })
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
  server = new Server({ hostKeys: [key.privateKey] }, peer => {
    peers.add(peer); connections++
    peer.on('error', () => undefined)
    peer.on('close', () => peers.delete(peer))
    peer.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'fixture-password') ctx.accept()
      else ctx.reject()
    })
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept()
      session.on('exec', acceptExec => {
        // Do not execute the supplied command on this machine.
        const stream = acceptExec()
        stream.exit(0); stream.end('fixture-exec-ok')
      })
      session.on('sftp', acceptSftp => {
        const raw = acceptSftp()
        raw.on('error', () => undefined)
        let path = '/ok'
        let markClosed!: () => void
        const record = { raw, closed: new Promise<void>(resolve => { markClosed = resolve }), isClosed: false }
        channels.push(record)
        raw.once('close', () => { record.isClosed = true; markClosed() })
        raw.on('REALPATH', (id, requested) => raw.name(id, [{ filename: requested, longname: requested, attrs }]))
        raw.on('STAT', id => raw.attrs(id, attrs))
        raw.on('LSTAT', id => raw.attrs(id, attrs))
        raw.on('FSTAT', id => raw.attrs(id, attrs))
        raw.on('OPEN', (id, requested) => { path = requested; raw.handle(id, Buffer.from('owned-handle')) })
        raw.on('READ', (id, _handle, offset, length) => {
          markReadEntered()
          if (path === '/hang') return
          if (path === '/close-read') { raw.end(); return }
          const data = Buffer.from('data')
          if (offset >= data.length) raw.status(id, 1) // EOF
          else raw.data(id, data.subarray(offset, offset + length))
        })
        raw.on('WRITE', (id, _handle, _offset, _data) => {
          writes++
          if (path === '/close-write') { raw.end(); return }
          raw.status(id, 0)
        })
        raw.on('CLOSE', id => raw.status(id, 0))
      })
    }))
  })
  await bounded(new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }))
  listening = true
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('unexpected loopback address')
  entry = { alias: 'owned-loopback', host: '127.0.0.1', port: address.port, user: 'fixture', auth: { kind: 'password', password: 'fixture-password' }, source: 'manual' }
  pool = new SshPool({ hostKeyPolicy: 'off', knownHosts: new KnownHosts(join(fixture, 'known_hosts')),
    connectTimeoutMs: 2000, channelOpenTimeoutMs: 2000, commandTimeoutMs: 2000, operationTimeoutMs: 2000, maxOutputChars: 1000 })
})
afterEach(async () => {
  pool?.dispose()
  for (const peer of peers ?? []) peer.end()
  if (server && listening) await bounded(new Promise<void>(resolve => { server.close(() => resolve()) }))
  if (fixture) {
    if (!basename(fixture).startsWith('dsh-rw-ssh-loopback-') || !realpathSync(fixture).startsWith(realpathSync(tmpdir()) + sep)) throw Error('unexpected loopback cleanup path')
    rmSync(fixture, { recursive: true, force: true })
  }
})

describe('owned real ssh2 loopback SFTP lifecycle', () => {
  it('releases successful subsystems instead of accumulating them', async () => {
    for (let i = 0; i < 3; i++) {
      const facade = await pool.sftp(entry)
      const channel = channels.at(-1)!
      expect((await facade.stat('/ok')).size).toBe(4)
      await facade.close?.()
      await bounded(channel.closed)
      expect(channels.filter(c => !c.isClosed)).toHaveLength(0)
    }
    expect(connections).toBe(1)
    expect(pool.connected()).toEqual(['owned-loopback'])
  }, 10000)

  it('settles a real composite readFile when its READ channel closes', async () => {
    const facade = await pool.sftp(entry)
    await expect(bounded(facade.readFile('/close-read'))).rejects.toMatchObject({ code: 'NOT_CONNECTED', outcome: 'unknown' })
    expect(connections).toBe(1)
    expect((await pool.exec(entry, 'not executed by fixture')).code).toBe(0)
  }, 10000)

  it('does not repeat a real write after its response channel is lost', async () => {
    const facade = await pool.sftp(entry)
    await expect(bounded(facade.writeFile('/close-write', Buffer.from('one write')))).rejects.toMatchObject({ outcome: 'unknown' })
    expect(writes).toBe(1)
    expect(connections).toBe(1)
    expect((await pool.exec(entry, 'not executed by fixture')).stdout).toBe('fixture-exec-ok')
  }, 10000)

  it('cancels its own live read channel without breaking a sibling facade', async () => {
    const ctl = new AbortController()
    const blocked = await pool.sftp(entry, { signal: ctl.signal })
    const blockedChannel = channels.at(-1)!
    const healthy = await pool.sftp(entry)
    const healthyChannel = channels.at(-1)!
    const rejected = expect(bounded(blocked.readFile('/hang'))).rejects.toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'unknown' })
    await bounded(readEntered)
    ctl.abort(); await rejected
    await bounded(blockedChannel.closed)
    expect(healthyChannel.isClosed).toBe(false)
    expect((await healthy.readFile('/ok')).toString()).toBe('data')
    expect(connections).toBe(1)
    await healthy.close?.()
    await bounded(healthyChannel.closed)
  }, 10000)
})
