import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RwError } from '../src/errors.js'
import type { PlaceholderLocations, PlaceholderMeta } from '../src/placeholder.js'
import {
  defaultPlaceholderRoot,
  ensurePlaceholder,
  ensurePlaceholderRoot,
  findPlaceholderByPath,
  hostRootDir,
  locatePlaceholder,
  mirrorPlaceholderDir,
  readPlaceholderMeta,
  resolvePlaceholderDir,
} from '../src/placeholder.js'

const ENTRY = { host: 'example.com', port: 22, user: 'deploy' }

let base: string
let root: string
let legacy: string
let loc: PlaceholderLocations

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dsh-rw-ph-'))
  root = join(base, 'root')
  legacy = join(base, 'legacy')
  loc = { root, legacyBaseDir: legacy }
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function modeOf(p: string): number {
  return statSync(p).mode & 0o777
}

/** Write a raw meta file into a (pre-created) directory: legacy / misplaced / foreign fixtures. */
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

/** The thrown RwError (fails the test when nothing is thrown). */
function thrown(fn: () => unknown): RwError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RwError)
    return err as RwError
  }
  throw new Error('expected an RwError')
}

/** Whether the tmp file system folds case (macOS default APFS does). */
function caseInsensitiveFs(): boolean {
  const probe = join(base, 'CaseProbe')
  writeFileSync(probe, '')
  return existsSync(join(base, 'caseprobe'))
}

describe('default locations', () => {
  it('macOS defaults to a per-user directory under /Users/Shared (outside ~)', () => {
    const dir = defaultPlaceholderRoot('darwin')
    expect(dir.startsWith('/Users/Shared/dsh-rw-')).toBe(true)
    expect(dir.slice('/Users/Shared/dsh-rw-'.length)).toMatch(/^[a-zA-Z0-9._-]+$/)
  })

  it('other platforms default to ~/.dsh/rw-workspaces', () => {
    expect(defaultPlaceholderRoot('linux')).toBe(join(homedir(), '.dsh', 'rw-workspaces'))
  })
})

describe('ensurePlaceholderRoot', () => {
  it('creates a configured root recursively, 0700', () => {
    const deep = join(base, 'a', 'b', 'root')
    expect(ensurePlaceholderRoot({ root: deep })).toBe(deep)
    expect(modeOf(deep)).toBe(0o700)
  })

  it('tightens a loose existing root back to 0700', () => {
    mkdirSync(root, { mode: 0o755 })
    chmodSync(root, 0o755)
    ensurePlaceholderRoot(loc)
    expect(modeOf(root)).toBe(0o700)
  })

  it('refuses a symlinked root', () => {
    const real = join(base, 'real')
    mkdirSync(real)
    symlinkSync(real, root)
    expect(thrown(() => ensurePlaceholderRoot(loc)).code).toBe('UNSAFE_PLACEHOLDER_ROOT')
    expect(thrown(() => ensurePlaceholder('h', ENTRY, '/data', loc)).code).toBe('UNSAFE_PLACEHOLDER_ROOT')
  })

  it('refuses a root that is not a directory', () => {
    writeFileSync(root, 'x')
    expect(thrown(() => ensurePlaceholderRoot(loc)).code).toBe('UNSAFE_PLACEHOLDER_ROOT')
  })

  it('refuses a root owned by someone else (simulated uid)', () => {
    mkdirSync(root)
    const foreign = (typeof process.getuid === 'function' ? process.getuid() : 0) + 4242
    const err = thrown(() => ensurePlaceholderRoot({ ...loc, currentUid: () => foreign }))
    expect(err.code).toBe('UNSAFE_PLACEHOLDER_ROOT')
    expect(err.message).toContain('owned by uid')
    // Nothing was created below it.
    expect(() => ensurePlaceholder('h', ENTRY, '/data', { ...loc, currentUid: () => foreign })).toThrow(RwError)
    expect(existsSync(join(root, 'h'))).toBe(false)
  })

  it('accepts a root owned by the current user', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    expect(ensurePlaceholderRoot({ ...loc, currentUid: () => uid })).toBe(root)
  })
})

describe('ensurePlaceholder mirror layout', () => {
  it('mirrors the remote path under <root>/<alias>; the host dir and intermediates carry no meta', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/data/app', loc)
    expect(dir).toBe(join(root, 'h', 'data', 'app'))
    expect(readPlaceholderMeta(dir)).toMatchObject({ alias: 'h', remotePath: '/data/app' })
    // No meta for remote '/' is created as a side effect: it would make every
    // path of the host remote-backed …
    expect(readPlaceholderMeta(join(root, 'h'))).toBeNull()
    expect(existsSync(join(root, 'h', '.dsh-rw-meta.json'))).toBe(false)
    // … and the intermediate directory is a plain, private, meta-less dir.
    expect(readPlaceholderMeta(join(root, 'h', 'data'))).toBeNull()
    expect(existsSync(join(root, 'h', 'data', '.dsh-rw-meta.json'))).toBe(false)
    expect(modeOf(join(root, 'h', 'data'))).toBe(0o700)
  })

  it("places remote '/' at the host dir itself, with a meta only when '/' is picked", () => {
    expect(ensurePlaceholder('h', ENTRY, '/', loc)).toBe(join(root, 'h'))
    expect(readPlaceholderMeta(join(root, 'h'))).toMatchObject({ alias: 'h', remotePath: '/', host: 'example.com' })
    expect(hostRootDir('h', loc)).toBe(join(root, 'h'))
    expect(mirrorPlaceholderDir('h', '/srv/x/', loc)).toBe(join(root, 'h', 'srv', 'x'))
  })

  it('nests workspaces exactly as the remote tree does', () => {
    const outer = ensurePlaceholder('h', ENTRY, '/data', loc)
    const inner = ensurePlaceholder('h', ENTRY, '/data/app', loc)
    expect(inner.startsWith(`${outer}/`)).toBe(true)
    expect(readPlaceholderMeta(outer)).toMatchObject({ remotePath: '/data' })
    expect(readPlaceholderMeta(inner)).toMatchObject({ remotePath: '/data/app' })
  })

  it('an existing meta-less intermediate directory becomes a placeholder when picked', () => {
    ensurePlaceholder('h', ENTRY, '/home/me/proj', loc)
    expect(readPlaceholderMeta(join(root, 'h', 'home'))).toBeNull()
    expect(ensurePlaceholder('h', ENTRY, '/home', loc)).toBe(join(root, 'h', 'home'))
    expect(readPlaceholderMeta(join(root, 'h', 'home'))).toMatchObject({ remotePath: '/home' })
  })

  it('sanitizes illegal alias characters, keeps dots/dashes/underscores, never climbs out', () => {
    expect(ensurePlaceholder('my host!@#x', ENTRY, '/data', loc)).toBe(join(root, 'my_host___x', 'data'))
    expect(ensurePlaceholder('a.b-c_d', ENTRY, '/data', loc)).toBe(join(root, 'a.b-c_d', 'data'))
    expect(ensurePlaceholder('..', ENTRY, '/data', loc)).toBe(join(root, '__', 'data'))
  })

  it('normalizes the remote path (trailing slashes, dots)', () => {
    expect(ensurePlaceholder('h', ENTRY, '/data/', loc)).toBe(ensurePlaceholder('h', ENTRY, '/data', loc))
    expect(ensurePlaceholder('h', ENTRY, '/data/./x/../app', loc)).toBe(join(root, 'h', 'data', 'app'))
  })

  it('is idempotent: a consistent second call rewrites nothing', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', loc)
    const file = join(dir, '.dsh-rw-meta.json')
    const before = readFileSync(file, 'utf8')
    const beforeMtime = statSync(file).mtimeMs
    expect(ensurePlaceholder('h', ENTRY, '/x', loc)).toBe(dir)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(statSync(file).mtimeMs).toBe(beforeMtime)
  })

  it('rewrites changed host/port/user in place, preserving createdAt', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', loc)
    const original = readPlaceholderMeta(dir)!
    expect(ensurePlaceholder('h', { ...ENTRY, port: 2222 }, '/x', loc)).toBe(dir)
    expect(readPlaceholderMeta(dir)).toMatchObject({ port: 2222, createdAt: original.createdAt })
  })

  it('sets 0700 on directories and 0600 on meta files', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', loc)
    expect(modeOf(root)).toBe(0o700)
    expect(modeOf(join(root, 'h'))).toBe(0o700)
    expect(modeOf(dir)).toBe(0o700)
    expect(modeOf(join(dir, '.dsh-rw-meta.json'))).toBe(0o600)
    ensurePlaceholder('h', ENTRY, '/', loc)
    expect(modeOf(join(root, 'h', '.dsh-rw-meta.json'))).toBe(0o600)
  })

  it('rewrites a corrupt meta at the mirror position (location decides ownership)', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/x', loc)
    writeFileSync(join(dir, '.dsh-rw-meta.json'), 'not json{', { mode: 0o644 })
    expect(ensurePlaceholder('h', ENTRY, '/x', loc)).toBe(dir)
    expect(readPlaceholderMeta(dir)).toMatchObject({ alias: 'h', remotePath: '/x' })
    expect(modeOf(join(dir, '.dsh-rw-meta.json'))).toBe(0o600)
  })

  it('never hash-suffixes: a mirror position claimed by another workspace is an error', () => {
    seedMeta(join(root, 'h', 'data', 'app'), { remotePath: '/somewhere/else' })
    const err = thrown(() => ensurePlaceholder('h', ENTRY, '/data/app', loc))
    expect(err.code).toBe('INVALID_INPUT')
    expect(err.message).toContain('/somewhere/else')
  })

  it('two aliases that sanitize to the same directory name collide loudly on the same workspace', () => {
    ensurePlaceholder('my host', ENTRY, '/data', loc)
    const err = thrown(() => ensurePlaceholder('my_host', ENTRY, '/data', loc))
    expect(err.code).toBe('INVALID_INPUT')
    expect(err.message).toContain('"my host"')
    // The first workspace is intact.
    expect(readPlaceholderMeta(join(root, 'my_host', 'data'))).toMatchObject({ alias: 'my host' })
  })

  it('refuses to build through a non-directory', () => {
    ensurePlaceholder('h', ENTRY, '/', loc)
    writeFileSync(join(root, 'h', 'data'), 'a file')
    expect(thrown(() => ensurePlaceholder('h', ENTRY, '/data/app', loc)).code).toBe('INVALID_INPUT')
  })

  it('rejects a remote segment that would shadow the meta file', () => {
    expect(thrown(() => ensurePlaceholder('h', ENTRY, '/.dsh-rw-meta.json/x', loc)).code).toBe('INVALID_INPUT')
  })

  it('reports a case-only collision with both spellings (case-insensitive file systems)', () => {
    ensurePlaceholder('h', ENTRY, '/Data', loc)
    if (caseInsensitiveFs()) {
      const err = thrown(() => ensurePlaceholder('h', ENTRY, '/data', loc))
      expect(err.code).toBe('INVALID_INPUT')
      expect(err.message).toContain('"Data"')
      expect(err.message).toContain('"data"')
      expect(err.message).toContain('case-insensitive')
    } else {
      // Case-sensitive: the two spellings are genuinely different directories.
      expect(ensurePlaceholder('h', ENTRY, '/data', loc)).toBe(join(root, 'h', 'data'))
    }
  })

  it('rejects segments Windows cannot store (win32 rules)', () => {
    const win: PlaceholderLocations = { ...loc, platform: 'win32' }
    for (const bad of ['/data/a:b', '/data/q?', '/data/x.', '/data/x ', '/data/CON', '/data/lpt1', '/data/nul.txt', '/data/a\u0001b']) {
      expect(thrown(() => ensurePlaceholder('h', ENTRY, bad, win)).code).toBe('INVALID_INPUT')
    }
    expect(thrown(() => ensurePlaceholder('con', ENTRY, '/data', win)).code).toBe('INVALID_INPUT')
    // Nothing was written for a rejected path.
    expect(existsSync(join(root, 'h'))).toBe(false)
    // The same names are fine on POSIX.
    expect(ensurePlaceholder('h', ENTRY, '/data/a:b', loc)).toBe(join(root, 'h', 'data', 'a:b'))
  })
})

describe('findPlaceholderByPath', () => {
  it('finds a mirror placeholder from its directory, a nested path, and a not-yet-existing file', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/data/app', loc)
    for (const p of [dir, join(dir, 'src'), join(dir, 'src', 'new', 'file.ts')]) {
      const hit = findPlaceholderByPath(p, loc)
      expect(hit).toMatchObject({ dir, layout: 'mirror', hostRoot: join(root, 'h') })
      expect(hit?.meta.remotePath).toBe('/data/app')
    }
  })

  it('takes the deepest valid meta', () => {
    ensurePlaceholder('h', ENTRY, '/data', loc)
    ensurePlaceholder('h', ENTRY, '/data/app', loc)
    expect(findPlaceholderByPath(join(root, 'h', 'data', 'app', 'x'), loc)?.meta.remotePath).toBe('/data/app')
    expect(findPlaceholderByPath(join(root, 'h', 'data', 'other'), loc)?.meta.remotePath).toBe('/data')
    // Outside every picked workspace of the host: not remote-backed …
    expect(findPlaceholderByPath(join(root, 'h', 'home', 'me'), loc)).toBeNull()
    expect(findPlaceholderByPath(join(root, 'h'), loc)).toBeNull()
    // … unless remote '/' itself was picked.
    ensurePlaceholder('h', ENTRY, '/', loc)
    expect(findPlaceholderByPath(join(root, 'h', 'home', 'me'), loc)?.meta.remotePath).toBe('/')
    expect(findPlaceholderByPath(join(root, 'h', 'data', 'other'), loc)?.meta.remotePath).toBe('/data')
  })

  it('ignores a meta that does not sit at its own mirror position', () => {
    ensurePlaceholder('h', ENTRY, '/data', loc)
    // A copied/misplaced meta: claims /elsewhere but lives under /data/bogus.
    seedMeta(join(root, 'h', 'data', 'bogus'), { remotePath: '/elsewhere' })
    // Another alias's meta inside this host's tree is ignored the same way.
    seedMeta(join(root, 'h', 'data', 'foreign'), { alias: 'other', remotePath: '/data/foreign' })
    expect(findPlaceholderByPath(join(root, 'h', 'data', 'bogus', 'f'), loc)?.meta.remotePath).toBe('/data')
    expect(findPlaceholderByPath(join(root, 'h', 'data', 'foreign', 'f'), loc)?.meta).toMatchObject({ alias: 'h', remotePath: '/data' })
  })

  it('matches through the realpath form of the root (macOS /var ↔ /private/var)', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/data', loc)
    const real = realpathSync(dir)
    expect(findPlaceholderByPath(join(real, 'missing', 'file'), loc)?.meta.remotePath).toBe('/data')
    // And with the root configured in its real form, the lexical path still matches.
    const realLoc = { ...loc, root: realpathSync(root) }
    expect(findPlaceholderByPath(join(dir, 'missing'), realLoc)?.meta.remotePath).toBe('/data')
  })

  it('falls back to legacy placeholders (≤ 1.6 layout)', () => {
    const old = join(legacy, 'h', 'app-9472932a')
    seedMeta(old, { remotePath: '/data/app' })
    const hit = findPlaceholderByPath(join(old, 'src', 'x.ts'), loc)
    expect(hit).toMatchObject({ dir: old, layout: 'legacy' })
    expect(hit?.hostRoot).toBeUndefined()
  })

  it('returns null outside every placeholder, and for meta-less directories', () => {
    ensurePlaceholder('h', ENTRY, '/data', loc)
    expect(findPlaceholderByPath(join(base, 'elsewhere'), loc)).toBeNull()
    expect(findPlaceholderByPath(root, loc)).toBeNull()
    mkdirSync(join(root, 'ghost', 'dir'), { recursive: true })
    expect(findPlaceholderByPath(join(root, 'ghost', 'dir'), loc)).toBeNull()
  })
})

describe('resolvePlaceholderDir / locatePlaceholder', () => {
  it('finds the mirror placeholder by its meta', () => {
    const dir = ensurePlaceholder('h', ENTRY, '/data/app', loc)
    expect(resolvePlaceholderDir('h', '/data/app/', loc)).toBe(dir)
    expect(resolvePlaceholderDir('h', '/', loc)).toBeNull()
    ensurePlaceholder('h', ENTRY, '/', loc)
    expect(resolvePlaceholderDir('h', '/', loc)).toBe(join(root, 'h'))
    expect(locatePlaceholder('h', '/data/app', loc)).toMatchObject({ dir, layout: 'mirror', hostRoot: join(root, 'h') })
  })

  it('finds legacy hash-suffixed and display-named directories', () => {
    const hashed = join(legacy, 'h', 'app-9472932a')
    seedMeta(hashed, { remotePath: '/data/app' })
    const named = join(legacy, 'h', 'work_stuff')
    seedMeta(named, { remotePath: '/srv/work' })
    expect(resolvePlaceholderDir('h', '/data/app', loc)).toBe(hashed)
    expect(resolvePlaceholderDir('h', '/srv/work', loc)).toBe(named)
    expect(locatePlaceholder('h', '/srv/work', loc)?.layout).toBe('legacy')
  })

  it('prefers the mirror placeholder once the workspace is picked again', () => {
    seedMeta(join(legacy, 'h', 'app'), { remotePath: '/data/app' })
    const dir = ensurePlaceholder('h', ENTRY, '/data/app', loc)
    expect(resolvePlaceholderDir('h', '/data/app', loc)).toBe(dir)
    // The legacy one still works for a session whose cwd lives there.
    expect(findPlaceholderByPath(join(legacy, 'h', 'app'), loc)?.layout).toBe('legacy')
  })

  it('returns null for a wrong alias, wrong path, missing tree, or corrupt meta', () => {
    ensurePlaceholder('h', ENTRY, '/data/app', loc)
    expect(resolvePlaceholderDir('other', '/data/app', loc)).toBeNull()
    expect(resolvePlaceholderDir('h', '/data/other', loc)).toBeNull()
    expect(resolvePlaceholderDir('h', '/data', loc)).toBeNull() // intermediate dir, no meta
    const dir = ensurePlaceholder('h', ENTRY, '/x', loc)
    writeFileSync(join(dir, '.dsh-rw-meta.json'), '{{{')
    expect(resolvePlaceholderDir('h', '/x', loc)).toBeNull()
  })
})

describe('readPlaceholderMeta', () => {
  it('round-trips the written meta', () => {
    const dir = ensurePlaceholder('myhost', ENTRY, '/srv/app/', loc)
    const meta = readPlaceholderMeta(dir)
    expect(meta).toMatchObject({
      plugin: 'dsh-rw',
      alias: 'myhost',
      host: 'example.com',
      port: 22,
      user: 'deploy',
      remotePath: '/srv/app',
      note: 'placeholder only — not a copy of remote files',
    })
    expect(Number.isNaN(Date.parse(meta!.createdAt))).toBe(false)
    expect(meta).toEqual(JSON.parse(readFileSync(join(dir, '.dsh-rw-meta.json'), 'utf8')))
  })

  it('returns null for a missing directory, corrupt JSON, or a wrong-shaped meta', () => {
    expect(readPlaceholderMeta(join(base, 'nope'))).toBeNull()
    const dir = ensurePlaceholder('h', ENTRY, '/x', loc)
    writeFileSync(join(dir, '.dsh-rw-meta.json'), '{{{')
    expect(readPlaceholderMeta(dir)).toBeNull()
    writeFileSync(join(dir, '.dsh-rw-meta.json'), JSON.stringify({ plugin: 'other-plugin' }))
    expect(readPlaceholderMeta(dir)).toBeNull()
  })
})
