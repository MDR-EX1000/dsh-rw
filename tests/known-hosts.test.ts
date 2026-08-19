import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnownHosts } from '../src/known-hosts.js'

const KEY_A = Buffer.from('host-key-a').toString('base64')
const KEY_B = Buffer.from('host-key-b').toString('base64')

let dir: string
let khPath: string
let kh: KnownHosts

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-kh-'))
  khPath = join(dir, 'known_hosts')
  kh = new KnownHosts(khPath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function hashedLine(host: string, keyType: string, b64: string): string {
  const salt = randomBytes(20)
  const hash = createHmac('sha1', salt).update(host, 'utf8').digest()
  return `|1|${salt.toString('base64')}|${hash.toString('base64')} ${keyType} ${b64}`
}

describe('verify', () => {
  it('returns "unknown" when the file does not exist', () => {
    expect(kh.verify('example.com', 22, 'ssh-ed25519', KEY_A)).toBe('unknown')
  })

  it('matches a plain entry on port 22', () => {
    writeFileSync(khPath, `example.com ssh-ed25519 ${KEY_A}\n`)
    expect(kh.verify('example.com', 22, 'ssh-ed25519', KEY_A)).toBe('match')
  })

  it('returns "changed" when host and keyType match but the key differs', () => {
    writeFileSync(khPath, `example.com ssh-ed25519 ${KEY_A}\n`)
    expect(kh.verify('example.com', 22, 'ssh-ed25519', KEY_B)).toBe('changed')
  })

  it('returns "unknown" when the host matches only under a different keyType', () => {
    writeFileSync(khPath, `example.com ssh-rsa ${KEY_A}\n`)
    expect(kh.verify('example.com', 22, 'ssh-ed25519', KEY_A)).toBe('unknown')
  })

  it('returns "unknown" for an absent host', () => {
    writeFileSync(khPath, `other.example.com ssh-ed25519 ${KEY_A}\n`)
    expect(kh.verify('example.com', 22, 'ssh-ed25519', KEY_A)).toBe('unknown')
  })

  it('matches [host]:port entries for non-default ports', () => {
    writeFileSync(khPath, `[example.com]:2222 ssh-ed25519 ${KEY_A}\n`)
    expect(kh.verify('example.com', 2222, 'ssh-ed25519', KEY_A)).toBe('match')
    expect(kh.verify('example.com', 22, 'ssh-ed25519', KEY_A)).toBe('unknown')
  })

  it('also accepts a plain-name entry for a non-default port', () => {
    writeFileSync(khPath, `example.com ssh-ed25519 ${KEY_A}\n`)
    expect(kh.verify('example.com', 2222, 'ssh-ed25519', KEY_A)).toBe('match')
  })

  it('matches any host in a comma-separated list', () => {
    writeFileSync(khPath, `one.example.com,two.example.com ssh-ed25519 ${KEY_A}\n`)
    expect(kh.verify('two.example.com', 22, 'ssh-ed25519', KEY_A)).toBe('match')
  })

  it('matches hashed entries (HMAC-SHA1)', () => {
    writeFileSync(khPath, `${hashedLine('secret.example.com', 'ssh-ed25519', KEY_A)}\n`)
    expect(kh.verify('secret.example.com', 22, 'ssh-ed25519', KEY_A)).toBe('match')
    expect(kh.verify('secret.example.com', 22, 'ssh-ed25519', KEY_B)).toBe('changed')
    expect(kh.verify('other.example.com', 22, 'ssh-ed25519', KEY_A)).toBe('unknown')
  })

  it('matches hashed [host]:port entries', () => {
    writeFileSync(khPath, `${hashedLine('[example.com]:2222', 'ssh-ed25519', KEY_A)}\n`)
    expect(kh.verify('example.com', 2222, 'ssh-ed25519', KEY_A)).toBe('match')
  })

  it('skips marker lines, comments and blanks', () => {
    writeFileSync(
      khPath,
      [
        '# a comment',
        '',
        `@cert-authority *.example.com ssh-rsa ${KEY_B}`,
        `@revoked bad.example.com ssh-rsa ${KEY_B}`,
        `example.com ssh-ed25519 ${KEY_A}`,
        '',
      ].join('\n'),
    )
    expect(kh.verify('example.com', 22, 'ssh-ed25519', KEY_A)).toBe('match')
    expect(kh.verify('bad.example.com', 22, 'ssh-rsa', KEY_B)).toBe('unknown')
    expect(kh.verify('x.example.com', 22, 'ssh-rsa', KEY_B)).toBe('unknown')
  })

  it('tolerates lines with a trailing comment', () => {
    writeFileSync(khPath, `example.com ssh-ed25519 ${KEY_A} my old laptop\n`)
    expect(kh.verify('example.com', 22, 'ssh-ed25519', KEY_A)).toBe('match')
  })
})

describe('accept', () => {
  it('creates the file (and parent dirs) and makes the host verify', () => {
    const deep = new KnownHosts(join(dir, 'sub', 'dir', 'known_hosts'))
    deep.accept('example.com', 22, 'ssh-ed25519', KEY_A)
    expect(deep.verify('example.com', 22, 'ssh-ed25519', KEY_A)).toBe('match')
    expect(readFileSync(join(dir, 'sub', 'dir', 'known_hosts'), 'utf8')).toBe(
      `example.com ssh-ed25519 ${KEY_A}\n`,
    )
  })

  it('sets 0600 on the file and 0700 on a directory it creates', () => {
    const nested = new KnownHosts(join(dir, 'fresh', 'known_hosts'))
    nested.accept('example.com', 22, 'ssh-ed25519', KEY_A)
    expect(statSync(nested.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'fresh')).mode & 0o777).toBe(0o700)
  })

  it('is idempotent for exact duplicates', () => {
    kh.accept('example.com', 22, 'ssh-ed25519', KEY_A)
    kh.accept('example.com', 22, 'ssh-ed25519', KEY_A)
    expect(readFileSync(khPath, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('appends distinct entries', () => {
    kh.accept('example.com', 22, 'ssh-ed25519', KEY_A)
    kh.accept('example.com', 22, 'ssh-rsa', KEY_B)
    kh.accept('example.com', 2222, 'ssh-ed25519', KEY_A)
    expect(readFileSync(khPath, 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('writes [host]:port form for non-default ports', () => {
    kh.accept('example.com', 2222, 'ssh-ed25519', KEY_A)
    expect(readFileSync(khPath, 'utf8')).toBe(`[example.com]:2222 ssh-ed25519 ${KEY_A}\n`)
    expect(kh.verify('example.com', 2222, 'ssh-ed25519', KEY_A)).toBe('match')
  })

  it('mends a missing trailing newline before appending', () => {
    writeFileSync(khPath, `old.example.com ssh-rsa ${KEY_B}`) // no trailing \n
    kh.accept('new.example.com', 22, 'ssh-ed25519', KEY_A)
    expect(readFileSync(khPath, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(kh.verify('old.example.com', 22, 'ssh-rsa', KEY_B)).toBe('match')
  })
})

describe('defaultPath', () => {
  it('points at ~/.ssh/known_hosts', () => {
    expect(KnownHosts.defaultPath()).toMatch(/\.ssh[/\\]known_hosts$/)
  })
})
