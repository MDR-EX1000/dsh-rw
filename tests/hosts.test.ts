import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RwError } from '../src/errors.js'
import { expandHome, HostTable, parseSshConfig } from '../src/hosts.js'

let dir: string
let home: string
let savedHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-hosts-'))
  home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  savedHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(dir, { recursive: true, force: true })
})

describe('expandHome', () => {
  it('expands ~ and ~/ against HOME', () => {
    expect(expandHome('~')).toBe(home)
    expect(expandHome('~/.ssh/id_ed25519')).toBe(join(home, '.ssh', 'id_ed25519'))
    expect(expandHome('/abs/path')).toBe('/abs/path')
  })
})

describe('parseSshConfig', () => {
  it('parses a full host block', () => {
    const [e] = parseSshConfig(
      ['Host web', '  HostName example.com', '  User alice', '  Port 2222', '  IdentityFile ~/.ssh/id_web', ''].join('\n'),
    )
    expect(e).toMatchObject({
      alias: 'web',
      host: 'example.com',
      port: 2222,
      user: 'alice',
      source: 'ssh-config',
    })
    expect(e?.auth).toEqual({ kind: 'key', keyPath: join(home, '.ssh', 'id_web') })
  })

  it.each(['Host *', 'Host web*', 'Host web?', 'Host !excluded example.com'])('skips wildcard/negated blocks: %s', (line) => {
    const entries = parseSshConfig(`${line}\n  HostName example.com\nHost ok\n  HostName ok.example.com\n`)
    expect(entries.map((e) => e.alias)).toEqual(['ok'])
  })

  it('uses only the first pattern of a Host line', () => {
    const [e] = parseSshConfig('Host web web2\n  HostName example.com\n')
    expect(e?.alias).toBe('web')
  })

  it('skips blocks without HostName', () => {
    const entries = parseSshConfig('Host nouser\n  User alice\nHost named\n  HostName x.example.com\n')
    expect(entries.map((e) => e.alias)).toEqual(['named'])
  })

  it('ignores comments and blank lines', () => {
    const entries = parseSshConfig(
      ['# leading comment', '', 'Host web', '  # inside comment', '  HostName example.com  # trailing comment', ''].join('\n'),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.host).toBe('example.com')
  })

  it('is case-insensitive for directives', () => {
    const [e] = parseSshConfig('Host web\n  hostname example.com\n  USER bob\n  pOrT 2200\n')
    expect(e).toMatchObject({ host: 'example.com', user: 'bob', port: 2200 })
  })

  it.each(['abc', '99999', '0', '-1'])('falls back to 22 for invalid ports: %s', (port) => {
    const [e] = parseSshConfig(`Host web\n  HostName example.com\n  Port ${port}\n`)
    expect(e?.port).toBe(22)
  })

  it('uses defaultUser when User is missing, root as last resort', () => {
    const text = 'Host web\n  HostName example.com\n'
    expect(parseSshConfig(text, 'carol')[0]?.user).toBe('carol')
    expect(parseSshConfig(text)[0]?.user).toBe('root')
  })

  it('probes default private keys when no IdentityFile is given (ssh(1) order)', () => {
    const sshDir = join(home, '.ssh')
    mkdirSync(sshDir)
    writeFileSync(join(sshDir, 'id_rsa'), 'x')
    const [e] = parseSshConfig('Host web\n  HostName example.com\n')
    expect(e?.auth).toEqual({ kind: 'key', keyPath: join(sshDir, 'id_rsa') })
  })

  it('prefers id_ed25519 over id_rsa', () => {
    const sshDir = join(home, '.ssh')
    mkdirSync(sshDir)
    writeFileSync(join(sshDir, 'id_rsa'), 'x')
    writeFileSync(join(sshDir, 'id_ed25519'), 'x')
    const [e] = parseSshConfig('Host web\n  HostName example.com\n')
    expect(e?.auth).toEqual({ kind: 'key', keyPath: join(sshDir, 'id_ed25519') })
  })

  it('yields keyPath "" when no default key exists', () => {
    const [e] = parseSshConfig('Host web\n  HostName example.com\n')
    expect(e?.auth).toEqual({ kind: 'key', keyPath: '' })
  })

  it('skips Match blocks until the next Host', () => {
    const entries = parseSshConfig(
      [
        'Host web',
        '  HostName example.com',
        'Match user git',
        '  HostName should-not-leak.example.com',
        '  User git',
        'Host other',
        '  HostName other.example.com',
        '',
      ].join('\n'),
    )
    expect(entries).toHaveLength(2)
    expect(entries[0]?.host).toBe('example.com')
    expect(entries[1]).toMatchObject({ alias: 'other', host: 'other.example.com' })
  })

  it('ignores Include directives', () => {
    const entries = parseSshConfig('Include ~/.ssh/conf.d/*\nHost web\n  HostName example.com\n')
    expect(entries).toHaveLength(1)
  })

  it('parses multiple blocks in order', () => {
    const entries = parseSshConfig(
      'Host a\n  HostName a.example.com\nHost b\n  HostName b.example.com\n  User u\n',
    )
    expect(entries.map((e) => e.alias)).toEqual(['a', 'b'])
    expect(entries[1]?.user).toBe('u')
  })
})

describe('HostTable', () => {
  const storePath = (): string => join(dir, 'dsh', 'dsh-rw.json')
  const sshConfigPath = (): string => join(dir, 'sshconfig')
  const table = (): HostTable => new HostTable({ sshConfigPath: sshConfigPath(), storePath: storePath() })

  it('adds, lists, finds and removes manual hosts; persists across instances', () => {
    const t = table()
    t.addManual({ alias: 'nas', host: 'nas.lan', user: 'admin', password: 'pw', port: 2222 })
    expect(t.find('nas')).toMatchObject({ alias: 'nas', host: 'nas.lan', port: 2222, source: 'manual' })
    expect(t.list().map((e) => e.alias)).toEqual(['nas'])

    const t2 = table()
    expect(t2.find('nas')?.auth).toEqual({ kind: 'password', password: 'pw' })

    t2.removeManual('nas')
    expect(t2.find('nas')).toBeUndefined()
    expect(table().find('nas')).toBeUndefined()
  })

  it('stores key auth with passphrase', () => {
    const t = table()
    t.addManual({ alias: 'k', host: 'h', user: 'u', keyPath: '/tmp/k', passphrase: 'pp' })
    expect(table().find('k')?.auth).toEqual({ kind: 'key', keyPath: '/tmp/k', passphrase: 'pp' })
  })

  it('prefers key auth when both keyPath and password are given', () => {
    const t = table()
    const e = t.addManual({ alias: 'k', host: 'h', user: 'u', keyPath: '/tmp/k', password: 'pw' })
    expect(e.auth.kind).toBe('key')
  })

  it('writes the store atomically with 0600 inside a 0700 directory', () => {
    const t = table()
    t.addManual({ alias: 'a', host: 'h', user: 'u', password: 'pw' })
    expect(statSync(storePath()).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'dsh')).mode & 0o777).toBe(0o700)
    // atomic tmp+rename leaves no temp files behind
    expect(readdirSync(join(dir, 'dsh'))).toEqual(['dsh-rw.json'])
    const stored = JSON.parse(readFileSync(storePath(), 'utf8')) as { version: number; hosts: unknown[] }
    expect(stored.version).toBe(1)
    expect(stored.hosts).toHaveLength(1)
  })

  it('moves a corrupt store aside instead of overwriting it', () => {
    mkdirSync(join(dir, 'dsh'), { recursive: true })
    writeFileSync(storePath(), 'not json{')
    const t = table()
    expect(t.list()).toEqual([])
    const leftovers = readdirSync(join(dir, 'dsh'))
    expect(leftovers.some((f) => /dsh-rw\.json\.corrupt-\d+/.test(f))).toBe(true)
    expect(leftovers).not.toContain('dsh-rw.json')
    // and the table recovers: new writes produce a fresh valid store
    t.addManual({ alias: 'a', host: 'h', user: 'u', password: 'pw' })
    expect(table().find('a')).toBeDefined()
  })

  it('rejects invalid aliases, ports and missing credentials', () => {
    const t = table()
    expect(() => t.addManual({ alias: ' bad', host: 'h', user: 'u', password: 'p' })).toThrowError(RwError)
    expect(() => t.addManual({ alias: 'a/b', host: 'h', user: 'u', password: 'p' })).toThrowError(RwError)
    expect(() => t.addManual({ alias: 'ok', host: 'h', user: 'u', password: 'p', port: 0 })).toThrowError(RwError)
    expect(() => t.addManual({ alias: 'ok', host: 'h', user: 'u', password: 'p', port: 70000 })).toThrowError(RwError)
    expect(() => t.addManual({ alias: 'ok', host: 'h', user: 'u' })).toThrowError(RwError)
    try {
      t.addManual({ alias: 'ok', host: 'h', user: 'u' })
      expect.unreachable()
    } catch (err) {
      expect((err as RwError).code).toBe('INVALID_INPUT')
    }
  })

  it('rejects duplicate manual aliases', () => {
    const t = table()
    t.addManual({ alias: 'dup', host: 'h1', user: 'u', password: 'p' })
    expect(() => t.addManual({ alias: 'dup', host: 'h2', user: 'u', password: 'p' })).toThrowError(RwError)
    expect(t.find('dup')?.host).toBe('h1')
  })

  it('lets manual entries shadow ssh-config entries with the same alias', () => {
    writeFileSync(sshConfigPath(), 'Host web\n  HostName config.example.com\n  User alice\n')
    const t = table()
    expect(t.find('web')?.host).toBe('config.example.com')
    t.addManual({ alias: 'web', host: 'manual.example.com', user: 'bob', password: 'p' })
    expect(t.find('web')?.host).toBe('manual.example.com')
    expect(t.list().filter((e) => e.alias === 'web')).toHaveLength(1)
    t.removeManual('web')
    expect(t.find('web')?.host).toBe('config.example.com')
  })

  it('treats a missing ssh config as empty', () => {
    const t = table()
    expect(t.list()).toEqual([])
    t.addManual({ alias: 'm', host: 'h', user: 'u', password: 'p' })
    expect(t.list().map((e) => e.alias)).toEqual(['m'])
  })

  it('re-reads ssh config when mtime changes, caches otherwise', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z') // integer-ms, survives utimesSync exactly
    writeFileSync(sshConfigPath(), 'Host one\n  HostName one.example.com\n  User u\n')
    utimesSync(sshConfigPath(), t0, t0)
    const t = table()
    expect(t.list().map((e) => e.alias)).toEqual(['one'])

    // same mtime → cached, content change invisible
    writeFileSync(sshConfigPath(), 'Host two\n  HostName two.example.com\n  User u\n')
    utimesSync(sshConfigPath(), t0, t0)
    expect(t.list().map((e) => e.alias)).toEqual(['one'])

    // bumped mtime → re-read
    const t1 = new Date(t0.getTime() + 5000)
    utimesSync(sshConfigPath(), t1, t1)
    expect(t.list().map((e) => e.alias)).toEqual(['two'])
  })

  it('summarizes entries without leaking secrets', () => {
    const keyFile = join(dir, 'key')
    writeFileSync(keyFile, 'not-a-real-key')
    const t = table()
    t.addManual({ alias: 'pw', host: 'h', user: 'u', password: 'secret' })
    t.addManual({ alias: 'k-ok', host: 'h', user: 'u', keyPath: keyFile })
    t.addManual({ alias: 'k-missing', host: 'h', user: 'u', keyPath: join(dir, 'nope') })

    const s = t.summaries()
    expect(s.find((x) => x.alias === 'pw')).toMatchObject({ authKind: 'password', passwordSet: true, keyReady: false })
    expect(s.find((x) => x.alias === 'k-ok')).toMatchObject({ authKind: 'key', keyReady: true, passwordSet: false })
    expect(s.find((x) => x.alias === 'k-missing')).toMatchObject({ authKind: 'key', keyReady: false })
    expect(JSON.stringify(s)).not.toContain('secret')
  })

  it('summarize() works on ssh-config entries', () => {
    writeFileSync(sshConfigPath(), 'Host web\n  HostName example.com\n  User alice\n')
    const t = table()
    const e = t.find('web')
    expect(e).toBeDefined()
    const s = t.summarize(e!)
    expect(s).toMatchObject({ alias: 'web', authKind: 'key', keyReady: false, source: 'ssh-config' })
  })
})
