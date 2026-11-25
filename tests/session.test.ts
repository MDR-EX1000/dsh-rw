import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_RECORD_LIMIT, SessionStore, sessionHeaderOf, sessionKeysOf } from '../src/session.js'

let dir: string
let storePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-session-'))
  storePath = join(dir, 'state', 'sessions.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function modeOf(p: string): number {
  return statSync(p).mode & 0o777
}

describe('SessionStore', () => {
  it('starts empty when the store file is missing', () => {
    const s = new SessionStore(storePath)
    expect(s.get('a')).toEqual({ alias: null, workspace: null })
    expect(s.lookup('a').source).toBe('none')
    expect(s.lastAlias).toBeNull()
  })

  it('defaults to ~/.dsh/dsh-rw-sessions.json (the ≤ 1.6 dsh-rw-session.json is not reused)', () => {
    expect(SessionStore.defaultPath().endsWith(join('.dsh', 'dsh-rw-sessions.json'))).toBe(true)
  })

  it('isolates sessions: two sessions on different hosts never overwrite each other', () => {
    const s = new SessionStore(storePath)
    s.set({ id: 'one' }, { alias: 'prod', workspace: '/srv/app' })
    s.set({ id: 'two' }, { alias: 'dev', workspace: '/data' })
    expect(s.get({ id: 'one' })).toEqual({ alias: 'prod', workspace: '/srv/app' })
    expect(s.get({ id: 'two' })).toEqual({ alias: 'dev', workspace: '/data' })
    // A call without a session id uses its own '' key and sees neither.
    expect(s.get()).toEqual({ alias: null, workspace: null })
  })

  it('persists per-session records and lastAlias across instances', () => {
    const s = new SessionStore(storePath)
    s.set('one', { alias: 'prod', workspace: '/srv/app' })
    s.setLastAlias('prod')
    const again = new SessionStore(storePath)
    expect(again.get('one')).toEqual({ alias: 'prod', workspace: '/srv/app' })
    expect(again.lastAlias).toBe('prod')
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, unknown>
    expect(parsed).toMatchObject({ version: 2, lastAlias: 'prod', sessions: { one: { alias: 'prod', workspace: '/srv/app' } } })
    expect(typeof (parsed.sessions as Record<string, { updatedAt: unknown }>).one!.updatedAt).toBe('string')
  })

  it('merges partial patches and clears fields set to null', () => {
    const s = new SessionStore(storePath)
    s.set('a', { alias: 'prod', workspace: '/srv/app' })
    s.set('a', { alias: 'dev' })
    expect(s.get('a').workspace).toBe('/srv/app')
    s.set('a', { workspace: null })
    expect(new SessionStore(storePath).get('a')).toEqual({ alias: 'dev', workspace: null })
  })

  it('a subagent without its own record inherits the parent record, then writes copy-on-write', () => {
    const s = new SessionStore(storePath)
    s.set('parent', { alias: 'prod', workspace: '/srv/app' })
    const child = { id: 'child', parentId: 'parent' }
    expect(s.get(child)).toEqual({ alias: 'prod', workspace: '/srv/app' })
    expect(s.lookup(child).source).toBe('parent')

    s.set(child, { workspace: '/srv/other' })
    expect(s.record('child')).toMatchObject({ alias: 'prod', workspace: '/srv/other' })
    expect(s.lookup(child).source).toBe('own')
    // The parent is untouched.
    expect(s.get('parent')).toEqual({ alias: 'prod', workspace: '/srv/app' })
    // Without a parent link nothing is inherited.
    expect(s.get('orphan')).toEqual({ alias: null, workspace: null })
  })

  it('views bind one session and resolve through its parent', () => {
    const s = new SessionStore(storePath)
    s.set('p', { alias: 'prod', workspace: '/w' })
    const view = s.view({ id: 'c', parentId: 'p' })
    expect(view.alias).toBe('prod')
    view.set({ alias: null })
    expect(view.alias).toBeNull()
    expect(view.workspace).toBe('/w')
    expect(s.get('p').alias).toBe('prod')
  })

  it('keeps only the most recently updated records (limit)', () => {
    let tick = 0
    const now = (): Date => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000)
    const s = new SessionStore(storePath, { limit: 3, now })
    for (const id of ['a', 'b', 'c']) s.set(id, { alias: 'h' })
    s.set('a', { workspace: '/fresh' }) // a becomes the newest
    s.set('d', { alias: 'h' }) // evicts the least recently updated: b
    expect(s.ids().sort()).toEqual(['a', 'c', 'd'])
    expect(new SessionStore(storePath, { limit: 3 }).ids().sort()).toEqual(['a', 'c', 'd'])
  })

  it(`caps the file at ${SESSION_RECORD_LIMIT} records by default`, () => {
    let tick = 0
    const now = (): Date => new Date(Date.UTC(2026, 0, 1) + tick++)
    const s = new SessionStore(storePath, { now })
    for (let i = 0; i <= SESSION_RECORD_LIMIT; i++) s.set(`s${i}`, { alias: 'h' })
    expect(s.ids().length).toBe(SESSION_RECORD_LIMIT)
    expect(s.record('s0')).toBeUndefined()
    expect(s.record(`s${SESSION_RECORD_LIMIT}`)).toBeDefined()
    const sessions = (JSON.parse(readFileSync(storePath, 'utf8')) as { sessions: Record<string, unknown> }).sessions
    expect(Object.keys(sessions).length).toBe(SESSION_RECORD_LIMIT)
  })

  it('forgetAlias clears the host from every record and from lastAlias', () => {
    const s = new SessionStore(storePath)
    s.set('a', { alias: 'gone', workspace: '/x' })
    s.set('b', { alias: 'kept', workspace: '/y' })
    s.setLastAlias('gone')
    s.forgetAlias('gone')
    expect(s.get('a')).toEqual({ alias: null, workspace: null })
    expect(s.get('b')).toEqual({ alias: 'kept', workspace: '/y' })
    expect(s.lastAlias).toBeNull()
    expect(new SessionStore(storePath).get('a')).toEqual({ alias: null, workspace: null })
  })

  it('moves a corrupt store aside and recovers on the next write', () => {
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(storePath, 'not json {{{')
    const s = new SessionStore(storePath)
    expect(s.get('a')).toEqual({ alias: null, workspace: null })
    const leftovers = readdirSync(join(dir, 'state'))
    expect(leftovers.some((f) => /sessions\.json\.corrupt-\d+/.test(f))).toBe(true)
    expect(existsSync(storePath)).toBe(false)
    s.set('a', { alias: 'dev', workspace: '/w' })
    expect(new SessionStore(storePath).get('a').alias).toBe('dev')
  })

  it('treats a wrong-version file as corrupt and skips malformed records', () => {
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(storePath, JSON.stringify({ version: 1, alias: 'prod', workspace: '/srv/app' }))
    expect(new SessionStore(storePath).get('').alias).toBeNull()
    expect(readdirSync(join(dir, 'state')).some((f) => f.includes('.corrupt-'))).toBe(true)

    writeFileSync(
      storePath,
      JSON.stringify({
        version: 2,
        lastAlias: 42,
        sessions: { ok: { alias: 'a', workspace: '/w', updatedAt: '2026-01-01T00:00:00.000Z' }, bad: 'x', noTime: { alias: 'b' } },
      }),
    )
    const s = new SessionStore(storePath)
    expect(s.ids()).toEqual(['ok'])
    expect(s.lastAlias).toBeNull()
  })

  it('writes the store 0600 inside a 0700 directory, atomically (no tmp left)', () => {
    const s = new SessionStore(storePath)
    s.set('a', { alias: 'prod', workspace: '/srv/app' })
    expect(modeOf(storePath)).toBe(0o600)
    expect(modeOf(join(dir, 'state'))).toBe(0o700)
    expect(readdirSync(join(dir, 'state'))).toEqual(['sessions.json'])
  })
})

describe('session header helpers', () => {
  it('read id, cwd and parentSession structurally', () => {
    const agent = { session: { header: { id: 's1', cwd: '/w', parentSession: 'p0', other: 1 } } }
    expect(sessionHeaderOf(agent)).toEqual({ id: 's1', cwd: '/w', parentSession: 'p0' })
    expect(sessionKeysOf(agent)).toEqual({ id: 's1', parentId: 'p0' })
  })

  it('tolerate missing or malformed headers', () => {
    expect(sessionKeysOf(undefined)).toEqual({})
    expect(sessionKeysOf({ session: { header: { id: 7, cwd: '' } } })).toEqual({})
    expect(sessionHeaderOf({ session: null })).toEqual({})
  })
})
