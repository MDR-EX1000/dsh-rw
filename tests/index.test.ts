import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config as ConfigSchema } from '../src/index.js'
import type { Config } from '../src/index.js'
import { SessionStore } from '../src/session.js'
import { ensurePlaceholder, HOST_OWNER_FILE } from '../src/placeholder.js'
import { ENTRY_PROD, FakeHosts, FakePool } from './p4-fakes.js'

const CONFIG: Config = {
  hostKeyPolicy: 'accept-new',
  knownHostsPath: '',
  commandTimeoutMs: 30000,
  connectTimeoutMs: 15000,
  channelOpenTimeoutMs: 10000,
  maxOutputChars: 200000,
}

describe('main directory configuration', () => {
  it('defaults to the remote filesystem root in the Config schema', () => {
    expect(ConfigSchema({}).defaultMainDir).toBe('/')
  })

  it('preserves an explicitly configured directory or disabled default', () => {
    expect(ConfigSchema({ defaultMainDir: '/data' }).defaultMainDir).toBe('/data')
    expect(ConfigSchema({ defaultMainDir: '' }).defaultMainDir).toBe('')
  })
})

interface CapturedSection {
  name: string
  order: number
  /** DSH calls it with the AssembleContext; `scope` is the assembling Agent. */
  text: (context?: unknown) => string
}

/** The AssembleContext of an agent whose session header is `header`. */
function scopeOf(header: { id?: string; cwd?: string; parentSession?: string }): unknown {
  return { scope: { session: { header } } }
}

interface CapturedRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/** Hand-built cordis Context stand-in: registries capture, effects collect. */
function makeCtx() {
  const tools: { name: string }[] = []
  const routes: CapturedRoute[] = []
  const commands: { name: string; handler: () => { kind: string; text: string } }[] = []
  let section: CapturedSection | undefined
  /** Absent until a test mounts it, mirroring the web app's async mount. */
  let directoryPicker: unknown
  let workspaceRegistry: unknown
  const effectDisposers: (() => void)[] = []
  const effectLabels: string[] = []

  const remove = <T>(list: T[], item: T): void => {
    const i = list.indexOf(item)
    if (i >= 0) list.splice(i, 1)
  }

  const ctx = {
    tools: {
      register(t: { name: string }) {
        tools.push(t)
        return () => remove(tools, t)
      },
    },
    webServer: {
      register(r: CapturedRoute) {
        routes.push(r)
        return () => remove(routes, r)
      },
    },
    systemPrompt: {
      section(s: CapturedSection) {
        section = s
        return () => {
          section = undefined
        }
      },
    },
    get(name: string): unknown {
      if (name === 'commands') {
        return {
          register(c: (typeof commands)[number]) {
            commands.push(c)
            return () => remove(commands, c)
          },
        }
      }
      if (name === 'directoryPicker') return directoryPicker
      if (name === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    /** No settings service in this context: the inject callback never fires. */
    inject(): unknown {
      return undefined
    },
    /** Middleware registrations are captured nowhere; the disposer is a no-op. */
    on(): () => void {
      return () => {}
    },
    effect(fn: () => (() => void) | void, label?: string) {
      effectLabels.push(label ?? '')
      const dispose = fn()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
  }
  return {
    ctx,
    tools,
    routes,
    commands,
    effectDisposers,
    effectLabels,
    getSection: () => section,
    mountDirectoryPicker: (dp: unknown): void => {
      directoryPicker = dp
    },
    mountWorkspaceRegistry: (registry: unknown): void => {
      workspaceRegistry = registry
    },
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-index-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeOverrides() {
  const hosts = new FakeHosts()
  const pool = new FakePool()
  const session = new SessionStore(join(dir, 'sessions.json'))
  return { hosts, pool, session, placeholderBaseDir: join(dir, 'placeholders'), placeholderRoot: join(dir, 'rw-root') }
}

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  } as unknown as IncomingMessage
}

/** Invoke the captured local-pick route and parse its JSON response. */
async function callLocalPick(routes: CapturedRoute[]): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routes.find((r) => r.path === '/api/dsh-rw/local-pick')
  if (!route) throw new Error('local-pick route is not registered')
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status
      if (headers) Object.assign(res.headers, headers)
      return res
    },
    end(data?: string) {
      res.body = typeof data === 'string' ? data : ''
      return res
    },
  }
  await route.handler(fakeReq('POST', '/api/dsh-rw/local-pick'), res as unknown as ServerResponse)
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> }
}

/** Invoke a captured route with a JSON body. */
async function callRoute(
  routes: CapturedRoute[],
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routes.find((r) => r.path === path)
  if (!route) throw new Error(`route not registered: ${path}`)
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status: number) {
      res.statusCode = status
      return res
    },
    end(data?: string) {
      res.body = typeof data === 'string' ? data : ''
      return res
    },
  }
  await route.handler(fakeReq(method, path, body), res as unknown as ServerResponse)
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> }
}

describe('apply', () => {
  it('registers the sixteen rw_* tools, the nine routes, and the /rw command', () => {
    const { ctx, tools, routes, commands, effectLabels } = makeCtx()
    apply(ctx as unknown as Context, CONFIG, makeOverrides())

    expect(tools.map((t) => t.name)).toEqual([
      'rw_info',
      'rw_hosts',
      'rw_connect',
      'rw_pick_workspace',
      'rw_list_dir',
      'rw_read_file',
      'rw_write_file',
      'rw_mkdir',
      'rw_move',
      'rw_delete',
      'rw_exec',
      'rw_exec_many',
      'rw_watch',
      'rw_diff',
      'rw_apply_patch',
      'rw_disconnect',
    ])
    expect(routes.map((r) => r.path)).toEqual([
      '/api/dsh-rw/status',
      '/api/dsh-rw/hosts',
      '/api/dsh-rw/test',
      '/api/dsh-rw/ls',
      '/api/dsh-rw/ls-local',
      '/api/dsh-rw/hosts/hide',
      '/api/dsh-rw/hosts/main',
      '/api/dsh-rw/workspace',
      '/api/dsh-rw/local-pick',
    ])
    expect(routes.every((r) => r.kind === 'exact')).toBe(true)
    expect(commands.map((c) => c.name)).toEqual(['rw'])
    expect(effectLabels).toEqual(['dsh-rw: surfaces', 'dsh-rw: prompt', 'dsh-rw: pool'])
  })

  it('the prompt section is generated per session (guidance → connected → remote workspace)', () => {
    const { ctx, getSection } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, CONFIG, overrides)

    const section = getSection()
    expect(section).toBeDefined()
    expect(section?.name).toBe('dsh-rw')
    expect(section?.order).toBe(88)

    // No scope (or a scope without a header): generic guidance, never a throw.
    for (const context of [undefined, {}, { scope: {} }, { scope: { session: null } }]) {
      const idle = section!.text(context)
      expect(idle).toContain('No remote workspace is active')
      expect(idle).toContain('rw_hosts')
      expect(idle).toContain('rw_pick_workspace')
    }

    // A local session with its own rw_* record.
    overrides.session.set({ id: 's1' }, { alias: 'prod', workspace: '/srv/app' })
    const connected = section!.text(scopeOf({ id: 's1', cwd: dir }))
    expect(connected).toContain('Current remote workspace: deploy@example.com:22:/srv/app')
    expect(connected).toContain('confined to the workspace root')
    expect(connected).toContain('run on the LOCAL machine')
    // … which is not another session's.
    expect(section!.text(scopeOf({ id: 's2', cwd: dir }))).toContain('No remote workspace is active')
    // A subagent of s1 inherits it.
    expect(section!.text(scopeOf({ id: 'c', parentSession: 's1', cwd: dir }))).toContain('deploy@example.com:22:/srv/app')
  })

  it('the prompt section says "remote workspace" when the session cwd is a placeholder (new or legacy)', () => {
    const { ctx, getSection } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, CONFIG, overrides)
    const placeholder = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', {
      root: overrides.placeholderRoot,
      legacyBaseDir: overrides.placeholderBaseDir,
    })
    const text = getSection()!.text(scopeOf({ id: 'x', cwd: join(placeholder, 'src') }))
    expect(text).toContain("This session is a remote workspace: host alias 'prod' (deploy@example.com:22), remote root /srv/app")
    expect(text).toContain(placeholder)
    expect(text).toContain('read/write/edit/str_replace_editor/glob/grep/bash tools are translated to the remote host automatically')
    expect(text).toContain('rw_exec')
    expect(text).toContain('single source of truth')

    // A ≤ 1.6 placeholder still counts.
    const legacy = join(overrides.placeholderBaseDir, 'prod', 'app-legacy')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, '.dsh-rw-meta.json'),
      JSON.stringify({
        plugin: 'dsh-rw',
        alias: 'prod',
        host: 'example.com',
        port: 22,
        user: 'deploy',
        remotePath: '/srv/legacy',
        createdAt: '2026-01-01T00:00:00.000Z',
        note: 'placeholder only — not a copy of remote files',
      }),
    )
    expect(getSection()!.text(scopeOf({ id: 'y', cwd: legacy }))).toContain('remote root /srv/legacy')
  })

  it('the prompt section steers to rw_* while shim is off', () => {
    const { ctx, getSection } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, { ...CONFIG, shim: false }, overrides)
    overrides.session.set({ id: 's1' }, { alias: 'prod', workspace: '/srv/app' })
    const local = getSection()!.text(scopeOf({ id: 's1', cwd: dir }))
    expect(local).toContain('Current remote workspace: deploy@example.com:22:/srv/app')
    expect(local).toContain('Use the rw_* tools')
    expect(local).toContain('shim is off')

    const placeholder = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', { root: overrides.placeholderRoot })
    const inside = getSection()!.text(scopeOf({ id: 's2', cwd: placeholder }))
    expect(inside).toContain('This session is a remote workspace')
    expect(inside).toContain('use the rw_* tools for every file and command operation')
    expect(inside).not.toContain('translated to the remote host automatically')
  })

  it('POST /workspace registers the picked directory via ctx workspaceRegistry; / is the default main', async () => {
    const { ctx, routes, mountWorkspaceRegistry } = makeCtx()
    const overrides = makeOverrides()
    overrides.pool.fs.addDir('/srv/app')
    overrides.pool.fs.addDir('/data')
    apply(ctx as unknown as Context, CONFIG, overrides)

    // Not mounted: still a successful pick, just not registered.
    const before = await callRoute(routes, '/api/dsh-rw/workspace', 'POST', { alias: 'prod', path: '/srv/app' })
    expect(before.status).toBe(200)
    expect(before.json.registered).toBe(false)

    const created: [string, string | undefined][] = []
    mountWorkspaceRegistry({
      create: async (path: string, title?: string) => {
        created.push([path, title])
        return { path, title }
      },
    })
    const after = await callRoute(routes, '/api/dsh-rw/workspace', 'POST', { alias: 'prod', path: '/srv/app' })
    expect(after.json).toMatchObject({ ok: true, registered: true, title: 'app' })
    // / is the main directory of a host without its own (config default).
    const main = await callRoute(routes, '/api/dsh-rw/workspace', 'POST', { alias: 'prod', path: '/' })
    expect(main.json).toMatchObject({ ok: true, workspace: '/', registered: true, title: 'prod' })
    // /data is an ordinary child workspace, not the default main directory.
    const child = await callRoute(routes, '/api/dsh-rw/workspace', 'POST', { alias: 'prod', path: '/data' })
    expect(child.json).toMatchObject({ ok: true, registered: true, title: 'data' })
    const status = await callRoute(routes, '/api/dsh-rw/status', 'GET', {})
    expect(status.json.defaultMainDir).toBe('/')
    expect(created).toEqual([
      [join(overrides.placeholderRoot, 'prod', 'srv', 'app'), 'app'],
      [join(overrides.placeholderRoot, 'prod'), 'prod'],
      [join(overrides.placeholderRoot, 'prod', 'data'), 'data'],
    ])
  })

  it('reports namespace conflicts without breaking prompt assembly or unrelated local sessions', () => {
    const { ctx, getSection } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, CONFIG, overrides)
    const placeholder = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', { root: overrides.placeholderRoot })
    writeFileSync(join(overrides.placeholderRoot, 'prod', HOST_OWNER_FILE), JSON.stringify({ plugin: 'dsh-rw', version: 1, alias: 'other' }))
    const remote = getSection()!.text(scopeOf({ id: 'remote', cwd: placeholder }))
    expect(remote).toContain('This remote workspace is blocked')
    expect(remote).toContain('Do not run native file/command tools')
    overrides.session.set('local', { alias: 'prod', workspace: '/srv/app' })
    const local = getSection()!.text(scopeOf({ id: 'local', cwd: dir }))
    expect(local).toContain('run on the LOCAL machine')
    expect(local).toContain('stored remote namespace is blocked')
  })

  it('the /rw command renders the live status without credentials', () => {
    const { ctx, commands } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, CONFIG, overrides)
    overrides.session.set('', { alias: 'prod', workspace: '/srv/app' })
    overrides.pool.connectedAliases.add('prod')

    const result = commands[0]!.handler()
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Current host: deploy@example.com:22 (alias: prod)')
    expect(result.text).toContain('Connected: yes')
    expect(result.text).toContain('Current workspace: /srv/app')
    expect(result.text).not.toContain('t0p-secret-pw')
  })

  it('resolves the directoryPicker service per local-pick call (async backend mount)', async () => {
    const { ctx, routes, mountDirectoryPicker } = makeCtx()
    apply(ctx as unknown as Context, CONFIG, makeOverrides())

    // The backend mounts asynchronously during boot: before it exists the
    // route must answer the friendly 400 — and must not cache that absence.
    const before = await callLocalPick(routes)
    expect(before.status).toBe(400)
    expect(before.json.error).toContain('no DSH directory-picker backend')

    // Non-native backends are rejected at call time too.
    mountDirectoryPicker({ capability: () => Promise.resolve({ kind: 'browser' }) })
    const nonNative = await callLocalPick(routes)
    expect(nonNative.status).toBe(400)
    expect(nonNative.json.error).toContain('needs the native backend')

    // Simulate the late mount (the web app's nested loader.create) …
    mountDirectoryPicker({
      capability: () => Promise.resolve({ kind: 'native', pick: () => Promise.resolve('/Users/me/picked') }),
    })
    // … and the route that answered 400 above now succeeds.
    const after = await callLocalPick(routes)
    expect(after.status).toBe(200)
    expect(after.json).toEqual({ ok: true, path: '/Users/me/picked' })

    // An empty pick (cancel) is an ok response with cancelled: true.
    mountDirectoryPicker({
      capability: () => Promise.resolve({ kind: 'native', pick: () => Promise.resolve('') }),
    })
    const cancelled = await callLocalPick(routes)
    expect(cancelled.status).toBe(200)
    expect(cancelled.json).toEqual({ ok: true, cancelled: true })
  })

  it('disposers unregister every surface and dispose the pool', () => {
    const { ctx, tools, routes, commands, effectDisposers, getSection } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, CONFIG, overrides)
    expect(tools.length).toBe(16)
    expect(routes.length).toBe(9)

    for (const dispose of effectDisposers) dispose()
    expect(tools).toEqual([])
    expect(routes).toEqual([])
    expect(commands).toEqual([])
    expect(getSection()).toBeUndefined()
    expect(overrides.pool.disposed).toBe(true)
  })
})
