import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlaceholderMeta } from '../src/placeholder.js'
import { ensurePlaceholder, placeholderDirFor, readPlaceholderMeta } from '../src/placeholder.js'

const ENTRY = { host: 'example.com', port: 22, user: 'deploy' }

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dsh-rw-ph-'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function modeOf(p: string): number {
  return statSync(p).mode & 0o777
}

describe('placeholderDirFor', () => {
  it('builds <base>/<alias>/<base>-<8 hex chars> deterministically', () => {
    const dir = placeholderDirFor('myhost', '/data/app', base)
    expect(dir).toBe(placeholderDirFor('myhost', '/data/app', base))
    expect(dir.startsWith(join(base, 'myhost') + '/')).toBe(true)
    expect(dir.split('/').pop()).toMatch(/^app-[0-9a-f]{8}$/)
  })

  it('sanitizes illegal alias characters to _', () => {
    const dir = placeholderDirFor('my host!@#x', '/data', base)
    expect(dir).toContain(join(base, 'my_host___x'))
  })

  it('keeps dots, dashes and underscores in the alias', () => {
    const dir = placeholderDirFor('a.b-c_d', '/data', base)
    expect(dir).toContain(join(base, 'a.b-c_d'))
  })

  it('maps the same alias+path to the same dir, distinct paths to distinct dirs', () => {
    expect(placeholderDirFor('h', '/data', base)).toBe(placeholderDirFor('h', '/data', base))
    expect(placeholderDirFor('h', '/data', base)).not.toBe(placeholderDirFor('h', '/data2', base))
    // same basename, different parents → hash disambiguates
    expect(placeholderDirFor('h', '/a/app', base)).not.toBe(placeholderDirFor('h', '/b/app', base))
  })

  it('normalizes the remote path before hashing (trailing slashes, dots)', () => {
    expect(placeholderDirFor('h', '/data/', base)).toBe(placeholderDirFor('h', '/data', base))
    expect(placeholderDirFor('h', '/data/./app', base)).toBe(placeholderDirFor('h', '/data/app', base))
  })

  it('uses the root basename fallback for "/"', () => {
    expect(placeholderDirFor('h', '/', base).split('/').pop()).toMatch(/^workspace-[0-9a-f]{8}$/)
  })

  it('defaults to ~/.dsh/remote-workspaces', () => {
    const dir = placeholderDirFor('h', '/data')
    expect(dir.startsWith(join(homedir(), '.dsh', 'remote-workspaces', 'h') + '/')).toBe(true)
  })
})

describe('ensurePlaceholder', () => {
  it('creates the directory and a complete meta file', () => {
    const dir = ensurePlaceholder('myhost', ENTRY, '/srv/app/', base)
    const meta = readPlaceholderMeta(dir)
    expect(meta).not.toBeNull()
    expect(meta).toMatchObject({
      plugin: 'dsh-rw',
      alias: 'myhost',
      host: 'example.com',
      port: 22,
      user: 'deploy',
      remotePath: '/srv/app', // normalized
      note: 'placeholder only — not a copy of remote files',
    })
    expect(Number.isNaN(Date.parse(meta!.createdAt))).toBe(false)
  })

  it('round-trips through readPlaceholderMeta', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    const meta = readPlaceholderMeta(dir)
    const raw = JSON.parse(readFileSync(join(dir, '.dsh-rw-meta.json'), 'utf8')) as PlaceholderMeta
    expect(meta).toEqual(raw)
  })

  it('is idempotent: a consistent second call rewrites nothing', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    const before = readFileSync(join(dir, '.dsh-rw-meta.json'), 'utf8')
    const beforeMtime = statSync(join(dir, '.dsh-rw-meta.json')).mtimeMs
    const again = ensurePlaceholder('h', ENTRY, '/x', base)
    expect(again).toBe(dir)
    expect(readFileSync(join(dir, '.dsh-rw-meta.json'), 'utf8')).toBe(before)
    expect(statSync(join(dir, '.dsh-rw-meta.json')).mtimeMs).toBe(beforeMtime)
  })

  it('rewrites an inconsistent meta but preserves createdAt', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    const original = readPlaceholderMeta(dir)!
    const rewritten = ensurePlaceholder('h', { ...ENTRY, port: 2222 }, '/x', base)
    expect(rewritten).toBe(dir)
    const meta = readPlaceholderMeta(dir)!
    expect(meta.port).toBe(2222)
    expect(meta.createdAt).toBe(original.createdAt)
  })

  it('recovers from a corrupt meta file by rewriting it', () => {
    const dir = placeholderDirFor('h', '/x', base)
    ensurePlaceholder('h', ENTRY, '/x', base)
    writeFileSync(join(dir, '.dsh-rw-meta.json'), 'not json{')
    expect(readPlaceholderMeta(dir)).toBeNull()
    ensurePlaceholder('h', ENTRY, '/x', base)
    expect(readPlaceholderMeta(dir)).toMatchObject({ alias: 'h', remotePath: '/x' })
  })

  it('sets 0700 on the directory and 0600 on the meta file', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    expect(modeOf(dir)).toBe(0o700)
    expect(modeOf(join(dir, '.dsh-rw-meta.json'))).toBe(0o600)
  })

  it('hardens permissions on a re-created (inconsistent) placeholder', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    // simulate a tampered/inconsistent meta with loose permissions
    writeFileSync(join(dir, '.dsh-rw-meta.json'), '{"plugin":"other"}', { mode: 0o644 })
    ensurePlaceholder('h', ENTRY, '/x', base)
    expect(modeOf(join(dir, '.dsh-rw-meta.json'))).toBe(0o600)
    expect(readPlaceholderMeta(dir)).toMatchObject({ alias: 'h' })
  })
})

describe('readPlaceholderMeta', () => {
  it('returns null for a missing directory or file', () => {
    expect(readPlaceholderMeta(join(base, 'nope'))).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    writeFileSync(join(dir, '.dsh-rw-meta.json'), '{{{')
    expect(readPlaceholderMeta(dir)).toBeNull()
  })

  it('returns null for a wrong-shaped meta', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    writeFileSync(join(dir, '.dsh-rw-meta.json'), JSON.stringify({ plugin: 'other-plugin' }))
    expect(readPlaceholderMeta(dir)).toBeNull()
  })
})
