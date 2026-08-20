import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlaceholderMeta } from '../src/placeholder.js'
import { ensurePlaceholder, readPlaceholderMeta, resolvePlaceholderDir } from '../src/placeholder.js'

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

/** Write a raw meta file into a pre-created directory (legacy/corrupt fixtures). */
function seedMeta(dir: string, meta: Partial<PlaceholderMeta>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '.dsh-rw-meta.json'),
    `${JSON.stringify({
      plugin: 'dsh-rw',
      alias: 'h',
      host: 'example.com',
      port: 22,
      user: 'deploy',
      remotePath: '/data/app',
      createdAt: '2026-01-01T00:00:00.000Z',
      note: 'placeholder only — not a copy of remote files',
      ...meta,
    })}\n`,
  )
}

describe('ensurePlaceholder naming', () => {
  it('uses the clean remote basename by default — no hash suffix', () => {
    expect(ensurePlaceholder('h', ENTRY, '/data/app', base)).toBe(join(base, 'h', 'app'))
    expect(ensurePlaceholder('h', ENTRY, '/srv/clean-best-practice', base)).toBe(join(base, 'h', 'clean-best-practice'))
  })

  it('falls back to "workspace" for the root path', () => {
    expect(ensurePlaceholder('h', ENTRY, '/', base)).toBe(join(base, 'h', 'workspace'))
  })

  it('uses the display name (trimmed, sanitized) when given', () => {
    expect(ensurePlaceholder('h', ENTRY, '/data/app', base, '  My App!  ')).toBe(join(base, 'h', 'My_App_'))
    // blank display name falls back to the basename
    expect(ensurePlaceholder('h2', ENTRY, '/data/app', base, '   ')).toBe(join(base, 'h2', 'app'))
  })

  it('sanitizes illegal alias characters, keeps dots/dashes/underscores', () => {
    expect(ensurePlaceholder('my host!@#x', ENTRY, '/data', base)).toBe(join(base, 'my_host___x', 'data'))
    expect(ensurePlaceholder('a.b-c_d', ENTRY, '/data', base)).toBe(join(base, 'a.b-c_d', 'data'))
  })

  it('appends the hash suffix only when the clean name is occupied by another workspace', () => {
    const first = ensurePlaceholder('h', ENTRY, '/a/app', base)
    expect(first).toBe(join(base, 'h', 'app'))
    // Same basename, different remote path: the clean name is taken.
    const second = ensurePlaceholder('h', ENTRY, '/b/app', base)
    expect(second).toMatch(/^.*app-[0-9a-f]{8}$/)
    expect(second).not.toBe(first)
    // Both stay resolvable and idempotent.
    expect(ensurePlaceholder('h', ENTRY, '/a/app', base)).toBe(first)
    expect(ensurePlaceholder('h', ENTRY, '/b/app', base)).toBe(second)
  })

  it('appends the hash suffix when the clean name is an unnamed (meta-less) directory', () => {
    mkdirSync(join(base, 'h', 'app'), { recursive: true })
    const dir = ensurePlaceholder('h', ENTRY, '/data/app', base)
    expect(dir).toMatch(/^.*app-[0-9a-f]{8}$/)
    expect(readPlaceholderMeta(dir)).toMatchObject({ alias: 'h', remotePath: '/data/app' })
  })

  it('treats a corrupt meta as occupation (cannot prove ownership) and moves to the hash variant', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    expect(dir).toBe(join(base, 'h', 'x'))
    writeFileSync(join(dir, '.dsh-rw-meta.json'), 'not json{')
    const moved = ensurePlaceholder('h', ENTRY, '/x', base)
    expect(moved).toMatch(/^.*x-[0-9a-f]{8}$/)
    expect(readPlaceholderMeta(moved)).toMatchObject({ alias: 'h', remotePath: '/x' })
  })

  it('normalizes the remote path before naming (trailing slashes, dots)', () => {
    expect(ensurePlaceholder('h', ENTRY, '/data/', base)).toBe(ensurePlaceholder('h', ENTRY, '/data', base))
    expect(ensurePlaceholder('h', ENTRY, '/data/./app', base)).toBe(join(base, 'h', 'app'))
  })
})

describe('resolvePlaceholderDir', () => {
  it('finds a clean-named placeholder by its meta', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/data/app', base)
    expect(resolvePlaceholderDir('h', '/data/app', base)).toBe(dir)
  })

  it('finds legacy hash-suffixed directories (v0.1/v0.2 naming)', () => {
    const legacy = join(base, 'h', 'app-9472932a')
    seedMeta(legacy, { remotePath: '/data/app' })
    expect(resolvePlaceholderDir('h', '/data/app', base)).toBe(legacy)
  })

  it('finds display-named placeholders', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/data/app', base, 'work stuff')
    expect(dir).toBe(join(base, 'h', 'work_stuff'))
    expect(resolvePlaceholderDir('h', '/data/app', base)).toBe(dir)
  })

  it('returns null for a wrong alias, wrong path, missing tree, or corrupt meta', () => {
    ensurePlaceholder('h', ENTRY, '/data/app', base)
    expect(resolvePlaceholderDir('other', '/data/app', base)).toBeNull()
    expect(resolvePlaceholderDir('h', '/data/other', base)).toBeNull()
    expect(resolvePlaceholderDir('ghost', '/data/app', base)).toBeNull()
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    writeFileSync(join(dir, '.dsh-rw-meta.json'), '{{{')
    expect(resolvePlaceholderDir('h', '/x', base)).toBeNull()
  })
})

describe('ensurePlaceholder meta handling', () => {
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

  it('rewrites an inconsistent meta in place but preserves createdAt', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    const original = readPlaceholderMeta(dir)!
    const rewritten = ensurePlaceholder('h', { ...ENTRY, port: 2222 }, '/x', base)
    expect(rewritten).toBe(dir)
    const meta = readPlaceholderMeta(dir)!
    expect(meta.port).toBe(2222)
    expect(meta.createdAt).toBe(original.createdAt)
  })

  it('sets 0700 on the directory and 0600 on the meta file', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    expect(modeOf(dir)).toBe(0o700)
    expect(modeOf(join(dir, '.dsh-rw-meta.json'))).toBe(0o600)
  })

  it('hardens permissions on the fresh placeholder when the old meta is unreadable', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', base)
    // simulate a tampered meta with loose permissions: no longer provably ours,
    // so the fresh placeholder moves to the hash variant (with proper modes)
    writeFileSync(join(dir, '.dsh-rw-meta.json'), '{"plugin":"other"}', { mode: 0o644 })
    const moved = ensurePlaceholder('h', ENTRY, '/x', base)
    expect(moved).not.toBe(dir)
    expect(modeOf(join(moved, '.dsh-rw-meta.json'))).toBe(0o600)
    expect(readPlaceholderMeta(moved)).toMatchObject({ alias: 'h' })
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
