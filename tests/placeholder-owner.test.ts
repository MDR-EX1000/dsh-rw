import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RwError } from '../src/errors.js'
import { ensurePlaceholder, findPlaceholderByPath, HOST_OWNER_FILE, hostRootDir, locatePlaceholder, readPlaceholderMeta } from '../src/placeholder.js'

const ENTRY = { host: 'example.com', port: 22, user: 'deploy' }
let base: string
let root: string
let legacy: string
const locations = () => ({ root, legacyBaseDir: legacy })

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dsh-rw-owner-'))
  root = join(base, 'root')
  legacy = join(base, 'legacy')
})
afterEach(() => {
  if (!basename(base).startsWith('dsh-rw-owner-') || !realpathSync(base).startsWith(realpathSync(tmpdir()) + sep)) {
    throw new Error('unexpected fixture cleanup path')
  }
  rmSync(base, { recursive: true, force: true })
})

function seed(dir: string, alias: string, remotePath: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.dsh-rw-meta.json'), JSON.stringify({
    plugin: 'dsh-rw', alias, ...ENTRY, remotePath, createdAt: '2026-11-25T00:00:00.000Z',
    note: 'placeholder only — not a copy of remote files',
  }))
}
function invalid(fn: () => unknown) {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(RwError)
    expect((error as RwError).code).toBe('INVALID_INPUT')
    return
  }
  throw new Error('expected an ownership error')
}

describe('host namespace ownership', () => {
  it('claims a private host namespace without making remote root a workspace', () => {
    ensurePlaceholder('a+b', ENTRY, '/one', locations())
    const host = hostRootDir('a+b', locations())
    expect(JSON.parse(readFileSync(join(host, HOST_OWNER_FILE), 'utf8'))).toEqual({ plugin: 'dsh-rw', version: 1, alias: 'a+b' })
    expect(statSync(join(host, HOST_OWNER_FILE)).mode & 0o777).toBe(0o600)
    expect(readPlaceholderMeta(host)).toBeNull()
    expect(findPlaceholderByPath(host, locations())).toBeNull()
  })

  it('rejects sanitized aliases even when they select different remote directories', () => {
    const original = ensurePlaceholder('a+b', ENTRY, '/one', locations())
    const host = hostRootDir('a+b', locations())
    const ownerBefore = readFileSync(join(host, HOST_OWNER_FILE), 'utf8')
    invalid(() => ensurePlaceholder('a_b', ENTRY, '/two', locations()))
    expect(existsSync(join(host, 'two'))).toBe(false)
    expect(readPlaceholderMeta(original)?.alias).toBe('a+b')
    expect(readFileSync(join(host, HOST_OWNER_FILE), 'utf8')).toBe(ownerBefore)
  })

  it('does not rewrite a consistent owner record on re-pick or address changes', () => {
    ensurePlaceholder('h', ENTRY, '/one', locations())
    const owner = join(hostRootDir('h', locations()), HOST_OWNER_FILE)
    const before = statSync(owner).mtimeMs
    const bytes = readFileSync(owner, 'utf8')
    ensurePlaceholder('h', { ...ENTRY, port: 2222 }, '/two', locations())
    expect(statSync(owner).mtimeMs).toBe(before)
    expect(readFileSync(owner, 'utf8')).toBe(bytes)
  })

  it('preserves a clean unmarked 2.0 tree and claims it only on explicit pick', () => {
    const host = hostRootDir('a+b', locations())
    const dir = join(host, 'one')
    seed(dir, 'a+b', '/one')
    expect(findPlaceholderByPath(dir, locations())?.meta.alias).toBe('a+b')
    expect(locatePlaceholder('a+b', '/one', locations())?.dir).toBe(dir)
    expect(existsSync(join(host, HOST_OWNER_FILE))).toBe(false)
    expect(ensurePlaceholder('a+b', ENTRY, '/one', locations())).toBe(dir)
    expect(existsSync(join(host, HOST_OWNER_FILE))).toBe(true)
  })

  it('rejects reuse of an old unmarked tree by another sanitized alias', () => {
    const host = hostRootDir('a+b', locations())
    seed(join(host, 'one'), 'a+b', '/one')
    invalid(() => ensurePlaceholder('a_b', ENTRY, '/two', locations()))
    expect(existsSync(join(host, 'two'))).toBe(false)
    expect(existsSync(join(host, HOST_OWNER_FILE))).toBe(false)
  })

  it('blocks both lookup and creation in an already mixed unmarked tree', () => {
    const host = hostRootDir('a+b', locations())
    const one = join(host, 'one')
    seed(one, 'a+b', '/one')
    seed(join(host, 'two'), 'a_b', '/two')
    // A valid legacy fallback must not hide the ambiguous mirror record.
    seed(join(legacy, 'a_b', 'old-one'), 'a+b', '/one')
    invalid(() => findPlaceholderByPath(one, locations()))
    invalid(() => locatePlaceholder('a+b', '/one', locations()))
    invalid(() => ensurePlaceholder('a+b', ENTRY, '/three', locations()))
    expect(existsSync(join(host, 'three'))).toBe(false)
  })

  it('also detects a foreign leaf added by an older process after the marker exists', () => {
    const one = ensurePlaceholder('a+b', ENTRY, '/one', locations())
    seed(join(hostRootDir('a+b', locations()), 'two'), 'a_b', '/two')
    invalid(() => findPlaceholderByPath(one, locations()))
    invalid(() => locatePlaceholder('a+b', '/one', locations()))
  })

  it('does not follow directory symlinks while auditing the namespace', () => {
    const one = ensurePlaceholder('a+b', ENTRY, '/one', locations())
    const external = join(base, 'external')
    seed(external, 'a_b', '/external')
    symlinkSync(external, join(hostRootDir('a+b', locations()), 'external'))
    expect(findPlaceholderByPath(one, locations())?.meta.alias).toBe('a+b')
  })

  it('rejects a corrupt owner record instead of silently recovering or running locally', () => {
    const one = ensurePlaceholder('h', ENTRY, '/one', locations())
    writeFileSync(join(hostRootDir('h', locations()), HOST_OWNER_FILE), '{broken')
    invalid(() => findPlaceholderByPath(one, locations()))
    invalid(() => ensurePlaceholder('h', ENTRY, '/two', locations()))
  })

  it('rejects a symlinked owner record without following it', () => {
    const host = hostRootDir('h', locations())
    seed(join(host, 'one'), 'h', '/one')
    const external = join(base, 'external-owner.json')
    writeFileSync(external, JSON.stringify({ plugin: 'dsh-rw', version: 1, alias: 'h' }))
    symlinkSync(external, join(host, HOST_OWNER_FILE))
    expect(lstatSync(join(host, HOST_OWNER_FILE)).isSymbolicLink()).toBe(true)
    invalid(() => findPlaceholderByPath(join(host, 'one'), locations()))
  })

  it('reserves the host owner filename against remote path collisions', () => {
    invalid(() => ensurePlaceholder('h', ENTRY, '/' + HOST_OWNER_FILE + '/x', locations()))
    expect(existsSync(root)).toBe(false)
  })

  it('accepts NFC/NFD equivalence only when the filesystem proves the same directory', () => {
    ensurePlaceholder('h', ENTRY, '/', locations())
    const host = hostRootDir('h', locations())
    const decomposed = join(host, 'cafe\u0301')
    const canonical = join(host, 'caf\u00e9')
    seed(decomposed, 'h', '/caf\u00e9')
    const equivalent = existsSync(canonical) && statSync(canonical).ino === statSync(decomposed).ino
    expect(findPlaceholderByPath(decomposed, locations())?.meta.remotePath).toBe(equivalent ? '/caf\u00e9' : '/')
  })
})
