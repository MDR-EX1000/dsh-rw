import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Session } from '../src/session.js'

let dir: string
let storePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-session-'))
  storePath = join(dir, 'state', 'session.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function modeOf(p: string): number {
  return statSync(p).mode & 0o777
}

describe('Session', () => {
  it('starts empty when the store file is missing', () => {
    const s = new Session(storePath)
    expect(s.alias).toBeNull()
    expect(s.workspace).toBeNull()
  })

  it('persists set() and restores it in a fresh instance (round trip)', () => {
    const s = new Session(storePath)
    s.set({ alias: 'prod', workspace: '/srv/app' })
    const again = new Session(storePath)
    expect(again.alias).toBe('prod')
    expect(again.workspace).toBe('/srv/app')
  })

  it('merges partial patches and clears fields set to null', () => {
    const s = new Session(storePath)
    s.set({ alias: 'prod', workspace: '/srv/app' })
    s.set({ alias: 'dev' })
    expect(s.workspace).toBe('/srv/app')
    s.set({ workspace: null })
    expect(new Session(storePath).workspace).toBeNull()
    expect(new Session(storePath).alias).toBe('dev')
  })

  it('ignores a corrupt store file and recovers on the next set()', () => {
    const s = new Session(storePath)
    s.set({ alias: 'prod' })
    writeFileSync(storePath, 'not json {{{')
    const broken = new Session(storePath)
    expect(broken.alias).toBeNull()
    expect(broken.workspace).toBeNull()
    broken.set({ alias: 'dev', workspace: '/w' })
    expect(new Session(storePath).alias).toBe('dev')
  })

  it('ignores a well-formed file with the wrong shape', () => {
    const s = new Session(storePath)
    s.set({ alias: 'prod' })
    writeFileSync(storePath, JSON.stringify({ version: 1, alias: 42, workspace: {} }))
    const loaded = new Session(storePath)
    expect(loaded.alias).toBeNull()
    expect(loaded.workspace).toBeNull()
  })

  it('writes the store 0600 inside a 0700 directory, atomically (no tmp left)', () => {
    const s = new Session(storePath)
    s.set({ alias: 'prod', workspace: '/srv/app' })
    expect(modeOf(storePath)).toBe(0o600)
    expect(modeOf(join(dir, 'state'))).toBe(0o700)
    expect(readdirSync(join(dir, 'state'))).toEqual(['session.json'])
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>
    expect(parsed).toMatchObject({ version: 1, alias: 'prod', workspace: '/srv/app' })
  })
})
