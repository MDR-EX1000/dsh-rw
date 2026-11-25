import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RwError } from '../src/errors.js'
import { makeRoutes } from '../src/routes.js'
import type { Route, RoutesDeps } from '../src/routes.js'
import { makeHarness, SECRET_PASSWORD } from './p4-fakes.js'
import type { FakeHarness } from './p4-fakes.js'

interface FakeRes {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function fakeReq(method: string, url: string, body?: unknown, remoteAddress = '127.0.0.1'): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:8080' },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  } as unknown as IncomingMessage
}

function fakeRes(): FakeRes {
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
  return res
}

async function call(
  routes: Route[],
  path: string,
  method: string,
  opts: { url?: string; body?: unknown; remoteAddress?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routes.find((r) => r.path === path)
  if (!route) throw new Error(`route not registered: ${path}`)
  const res = fakeRes()
  await route.handler(fakeReq(method, opts.url ?? path, opts.body, opts.remoteAddress), res as unknown as ServerResponse)
  expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
  return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> }
}

let dir: string
let harness: FakeHarness & { connect(): void }
let routes: Route[]

function buildRoutes(extra?: Partial<RoutesDeps>): Route[] {
  return makeRoutes({ ...harness.deps, ...extra })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-routes-'))
  harness = makeHarness(dir)
  routes = buildRoutes()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loopback fence', () => {
  it('rejects non-loopback remote addresses with 403 on every route', async () => {
    const cases: [string, string][] = [
      ['/api/dsh-rw/status', 'GET'],
      ['/api/dsh-rw/hosts', 'GET'],
      ['/api/dsh-rw/hosts', 'POST'],
      ['/api/dsh-rw/test', 'POST'],
      ['/api/dsh-rw/ls', 'GET'],
      ['/api/dsh-rw/ls-local', 'GET'],
      ['/api/dsh-rw/workspace', 'POST'],
      ['/api/dsh-rw/local-pick', 'POST'],
      ['/api/dsh-rw/hosts/hide', 'POST'],
      ['/api/dsh-rw/hosts/main', 'POST'],
    ]
    for (const [path, method] of cases) {
      const { status, json } = await call(routes, path, method, { body: {}, remoteAddress: '10.1.2.3' })
      expect(status).toBe(403)
      expect(json.error).toContain('loopback-only')
    }
  })

  it('accepts IPv6 loopback and IPv4-mapped loopback', async () => {
    for (const addr of ['::1', '::ffff:127.0.0.1']) {
      const { status } = await call(routes, '/api/dsh-rw/status', 'GET', { remoteAddress: addr })
      expect(status).toBe(200)
    }
  })

  it('rejects a cross-site browser marker', async () => {
    const route = routes.find((r) => r.path === '/api/dsh-rw/status')!
    const req = fakeReq('GET', '/api/dsh-rw/status')
    ;(req.headers as Record<string, string>)['sec-fetch-site'] = 'cross-site'
    const res = fakeRes()
    await route.handler(req, res as unknown as ServerResponse)
    expect(res.statusCode).toBe(403)
  })
})

describe('status / hosts', () => {
  it('GET status summarizes hosts and reports only the last picker host (no global session)', async () => {
    const empty = await call(routes, '/api/dsh-rw/status', 'GET')
    expect(empty.status).toBe(200)
    expect(empty.json.current).toEqual({ alias: null })
    expect(Array.isArray(empty.json.hosts)).toBe(true)

    // Session records are per DSH session and never surface here.
    harness.connect()
    harness.sessions.set('some-session', { alias: 'dev', workspace: '/x' })
    expect((await call(routes, '/api/dsh-rw/status', 'GET')).json.current).toEqual({ alias: null })

    harness.sessions.setLastAlias('prod')
    const picked = await call(routes, '/api/dsh-rw/status', 'GET')
    expect(picked.json.current).toEqual({ alias: 'prod' })
    expect(JSON.stringify(picked.json)).not.toContain(SECRET_PASSWORD)
  })

  it('GET status carries each host main directory in its summary', async () => {
    harness.hosts.setMainDir('prod', '/srv/app')
    const { json } = await call(routes, '/api/dsh-rw/status', 'GET')
    const hosts = json.hosts as { alias: string; mainDir?: string }[]
    expect(hosts.find((h) => h.alias === 'prod')?.mainDir).toBe('/srv/app')
    expect(hosts.find((h) => h.alias === 'dev')?.mainDir).toBeUndefined()
  })

  it('GET hosts lists summaries only (no credentials)', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/hosts', 'GET')
    expect(status).toBe(200)
    const hosts = json.hosts as { alias: string; passwordSet: boolean }[]
    expect(hosts.map((h) => h.alias)).toEqual(['prod', 'dev'])
    expect(hosts[0]).toMatchObject({ alias: 'prod', authKind: 'password', passwordSet: true })
    expect(JSON.stringify(json)).not.toContain(SECRET_PASSWORD)
  })

  it('POST hosts adds a manual entry and echoes only its summary', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/hosts', 'POST', {
      body: { alias: 'staging', host: 'staging.internal', user: 'ops', password: 'staging-secret' },
    })
    expect(status).toBe(201)
    expect(json.host).toMatchObject({ alias: 'staging', source: 'manual', passwordSet: true })
    expect(JSON.stringify(json)).not.toContain('staging-secret')
    expect(harness.hosts.find('staging')).toBeDefined()

    const dup = await call(routes, '/api/dsh-rw/hosts', 'POST', {
      body: { alias: 'staging', host: 'x', user: 'u', password: 'p' },
    })
    expect(dup.status).toBe(400)
    expect(dup.json.code).toBe('INVALID_INPUT')

    const invalid = await call(routes, '/api/dsh-rw/hosts', 'POST', { body: { alias: 'x' } })
    expect(invalid.status).toBe(400)
  })

  it('DELETE hosts removes manual entries only', async () => {
    const sshConfig = await call(routes, '/api/dsh-rw/hosts', 'DELETE', { body: { alias: 'dev' } })
    expect(sshConfig.status).toBe(400)
    expect(sshConfig.json.code).toBe('INVALID_INPUT')

    const missing = await call(routes, '/api/dsh-rw/hosts', 'DELETE', { body: { alias: 'ghost' } })
    expect(missing.status).toBe(404)

    harness.sessions.set('A', { alias: 'prod', workspace: '/srv/app' })
    harness.sessions.set('B', { alias: 'dev', workspace: '/w' })
    harness.sessions.setLastAlias('prod')
    harness.hosts.setMainDir('prod', '/srv/app')
    const ok = await call(routes, '/api/dsh-rw/hosts', 'DELETE', { body: { alias: 'prod' } })
    expect(ok.status).toBe(200)
    expect(harness.hosts.find('prod')).toBeUndefined()
    expect(harness.pool.disconnected).toContain('prod')
    // Every session record pointing at the host, and the picker memory, are cleared.
    expect(harness.sessions.get('A')).toEqual({ alias: null, workspace: null })
    expect(harness.sessions.get('B')).toEqual({ alias: 'dev', workspace: '/w' })
    expect(harness.sessions.lastAlias).toBeNull()
    expect(harness.hosts.mainDir('prod')).toBeUndefined()
  })

  it('rejects other methods with 405', async () => {
    const { status } = await call(routes, '/api/dsh-rw/status', 'POST', { body: {} })
    expect(status).toBe(405)
  })
})

describe('test / ls', () => {
  it('POST test reports latency on success', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/test', 'POST', { body: { alias: 'prod' } })
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true, latencyMs: 42 })
  })

  it('POST test reports failures with the RwError code and no credentials', async () => {
    harness.pool.testConnectError = new RwError('AUTH_FAILED', 'All configured authentication methods failed')
    const { status, json } = await call(routes, '/api/dsh-rw/test', 'POST', { body: { alias: 'prod' } })
    expect(status).toBe(200)
    expect(json.ok).toBe(false)
    expect(json.code).toBe('AUTH_FAILED')
    expect(JSON.stringify(json)).not.toContain(SECRET_PASSWORD)
  })

  it('POST test validates the alias', async () => {
    expect((await call(routes, '/api/dsh-rw/test', 'POST', { body: {} })).status).toBe(400)
    expect((await call(routes, '/api/dsh-rw/test', 'POST', { body: { alias: 'ghost' } })).status).toBe(400)
  })

  it('POST test with full fields probes without persisting the host', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/test', 'POST', {
      body: { host: 'newbox.internal', user: 'ops', password: 'probe-secret' },
    })
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true, latencyMs: 42 })
    // Nothing registered, and the throwaway connection is dropped from the pool.
    expect(harness.hosts.find('')).toBeUndefined()
    expect(harness.hosts.list().some((e) => e.host === 'newbox.internal')).toBe(false)
    expect(harness.pool.disconnected).toContain('')
    expect(JSON.stringify(json)).not.toContain('probe-secret')
  })

  it('POST test with full fields prefers key auth and maps probe failures', async () => {
    harness.pool.testConnectError = new RwError('AUTH_FAILED', 'All configured authentication methods failed')
    const { status, json } = await call(routes, '/api/dsh-rw/test', 'POST', {
      body: { host: 'h', user: 'u', keyPath: '/tmp/k', passphrase: 'pp-secret', password: 'ignored' },
    })
    expect(status).toBe(200)
    expect(json.ok).toBe(false)
    expect(json.code).toBe('AUTH_FAILED')
    expect(JSON.stringify(json)).not.toContain('pp-secret')
    expect(harness.pool.disconnected).toContain('')
  })

  it('POST test with full fields validates host/user/port/auth', async () => {
    const noHost = await call(routes, '/api/dsh-rw/test', 'POST', { body: { user: 'u', password: 'p' } })
    expect(noHost.status).toBe(400)
    expect(noHost.json.code).toBe('INVALID_INPUT')
    const noUser = await call(routes, '/api/dsh-rw/test', 'POST', { body: { host: 'h', password: 'p' } })
    expect(noUser.status).toBe(400)
    const noAuth = await call(routes, '/api/dsh-rw/test', 'POST', { body: { host: 'h', user: 'u' } })
    expect(noAuth.status).toBe(400)
    expect(noAuth.json.error).toContain('keyPath or password')
    const badPort = await call(routes, '/api/dsh-rw/test', 'POST', { body: { host: 'h', user: 'u', port: 0, password: 'p' } })
    expect(badPort.status).toBe(400)
    expect(badPort.json.error).toContain('invalid port')
  })

  it('GET ls lists any absolute path for a connectable alias (dirs first)', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/ls', 'GET', {
      url: '/api/dsh-rw/ls?alias=prod&path=/srv',
    })
    expect(status).toBe(200)
    expect(json.path).toBe('/srv')
    expect(json.items).toEqual([{ name: 'app', type: 'dir' }])
  })

  it('GET ls expands ~ against the session home (realpath ".")', async () => {
    // FakeSftp canonicalizes realpath('.') to '/', so ~ → '/' and ~/srv → /srv.
    const home = await call(routes, '/api/dsh-rw/ls', 'GET', { url: '/api/dsh-rw/ls?alias=prod&path=~' })
    expect(home.status).toBe(200)
    expect(home.json.path).toBe('/')
    const sub = await call(routes, '/api/dsh-rw/ls', 'GET', { url: '/api/dsh-rw/ls?alias=prod&path=~/srv' })
    expect(sub.status).toBe(200)
    expect(sub.json.path).toBe('/srv')
    expect(sub.json.items).toEqual([{ name: 'app', type: 'dir' }])
  })

  it('GET ls maps errors to status + { error, code }', async () => {
    const noAlias = await call(routes, '/api/dsh-rw/ls', 'GET', { url: '/api/dsh-rw/ls?path=/' })
    expect(noAlias.status).toBe(400)
    const ghost = await call(routes, '/api/dsh-rw/ls', 'GET', { url: '/api/dsh-rw/ls?alias=ghost&path=/' })
    expect(ghost.status).toBe(400)
    const missing = await call(routes, '/api/dsh-rw/ls', 'GET', { url: '/api/dsh-rw/ls?alias=prod&path=/nope' })
    expect(missing.status).toBe(404)
    expect(missing.json.code).toBe('NO_SUCH_PATH')
    const file = await call(routes, '/api/dsh-rw/ls', 'GET', { url: '/api/dsh-rw/ls?alias=prod&path=/etc/passwd' })
    expect(file.status).toBe(400)
    expect(file.json.code).toBe('NOT_A_DIRECTORY')
    const relative = await call(routes, '/api/dsh-rw/ls', 'GET', { url: '/api/dsh-rw/ls?alias=prod&path=srv' })
    expect(relative.status).toBe(400)
  })
})

describe('workspace / local-pick', () => {
  /** A recording WorkspaceRegistryLike that keeps titles like DSH does (first create wins). */
  function fakeRegistry(fail?: (path: string) => boolean) {
    const created: { path: string; title: string | undefined }[] = []
    const records = new Map<string, { title: string; setTitle(t: string): Promise<void> }>()
    return {
      created,
      records,
      registry: {
        async create(path: string, title?: string) {
          if (fail?.(path)) throw new Error(`registry refused ${path}`)
          created.push({ path, title })
          let rec = records.get(path)
          if (rec === undefined) {
            const fresh = {
              title: title ?? path,
              async setTitle(t: string) {
                fresh.title = t
              },
            }
            rec = fresh
            records.set(path, rec)
          }
          return rec
        },
      },
    }
  }

  const rwRoot = (): string => join(`${dir}/rw-root`)

  it('POST workspace creates the mirror placeholder, records only lastAlias, and writes no session record', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/workspace', 'POST', {
      body: { alias: 'prod', path: '/srv/app/' },
    })
    expect(status).toBe(200)
    expect(json).toEqual({
      ok: true,
      workspace: '/srv/app',
      placeholderDir: join(rwRoot(), 'prod', 'srv', 'app'),
      title: 'app',
      registered: false, // no registry composed
    })
    expect(existsSync(json.placeholderDir as string)).toBe(true)
    // No meta for remote '/' is created as a side effect.
    expect(existsSync(join(rwRoot(), 'prod', '.dsh-rw-meta.json'))).toBe(false)
    expect(harness.sessions.ids()).toEqual([])
    expect(harness.session.alias).toBeNull()
    expect(harness.sessions.lastAlias).toBe('prod')
  })

  it('POST workspace registers only the picked directory, titled by basename', async () => {
    const { created, registry } = fakeRegistry()
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry })
    const res = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
    expect(res.json).toMatchObject({ ok: true, registered: true, title: 'app' })
    expect(created).toEqual([{ path: join(rwRoot(), 'prod', 'srv', 'app'), title: 'app' }])
    // A title does not create or remote-back an unpicked host-root workspace.
    expect(existsSync(join(rwRoot(), 'prod', '.dsh-rw-meta.json'))).toBe(false)
  })

  it("titles the host's main directory by the bare alias (own setting, else defaultMainDir)", async () => {
    const { created, records, registry } = fakeRegistry()
    harness.hosts.setMainDir('prod', '/srv/app')
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry, defaultMainDir: '/srv' })
    const own = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app/' } })
    expect(own.json).toMatchObject({ ok: true, title: 'prod', registered: true })
    // prod has its own main, so the default does not make /srv its main.
    const notMain = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv' } })
    expect(notMain.json.title).toBe('srv')
    // dev has none of its own: the plugin default applies.
    const byDefault = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'dev', path: '/srv' } })
    expect(byDefault.json.title).toBe('dev')
    expect(created.map((c) => c.title)).toEqual(['prod', 'srv', 'dev'])
    // An explicit title also renames an existing record, not just the response.
    const named = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'dev', path: '/srv', name: 'Build box' } })
    expect(named.json.title).toBe('Build box')
    expect(records.get(join(rwRoot(), 'dev', 'srv'))?.title).toBe('Build box')
  })

  it('recognizes a symlinked default main directory by its canonical path', async () => {
    const { registry } = fakeRegistry()
    harness.pool.fs.addSymlink('/srv/main-link', '/srv/app')
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry, defaultMainDir: '/srv/main-link' })
    const linked = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/main-link' } })
    expect(linked.json).toMatchObject({ workspace: '/srv/app', title: 'prod', registered: true })
    const canonical = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'dev', path: '/srv/app' } })
    expect(canonical.json).toMatchObject({ workspace: '/srv/app', title: 'dev', registered: true })
  })

  it('does not let a missing main directory block picking a valid project', async () => {
    const { registry } = fakeRegistry()
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry, defaultMainDir: '/missing-main' })
    const res = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ workspace: '/srv/app', title: 'app', registered: true })
  })

  it('migrates old automatic titles on re-pick, for projects and main workspaces', async () => {
    const { records, registry } = fakeRegistry()
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry })
    const placeholder = join(rwRoot(), 'prod', 'srv', 'app')
    await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
    await records.get(placeholder)!.setTitle('prod · /srv/app')
    const project = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
    expect(project.json.title).toBe('app')
    expect(records.get(placeholder)?.title).toBe('app')

    await records.get(placeholder)!.setTitle('prod · /srv/app')
    harness.hosts.setMainDir('prod', '/srv/app')
    const main = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
    expect(main.json.title).toBe('prod')
    expect(records.get(placeholder)?.title).toBe('prod')
  })

  it('preserves existing custom titles with a blank name and returns the actual title', async () => {
    const { records, registry } = fakeRegistry()
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry })
    const placeholder = join(rwRoot(), 'prod', 'srv', 'app')
    await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app', name: '  My App  ' } })
    const blank = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app', name: '   ' } })
    expect(blank.json.title).toBe('My App')
    expect(records.get(placeholder)?.title).toBe('My App')
    harness.hosts.setMainDir('prod', '/srv/app')
    const main = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
    expect(main.json.title).toBe('My App')
    expect(records.get(placeholder)?.title).toBe('My App')
  })

  it('keeps equal basenames in different directories as distinct workspaces', async () => {
    const { created, records, registry } = fakeRegistry()
    harness.pool.fs.addDir('/opt/app')
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry })
    const first = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
    const second = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/opt/app' } })
    expect(first.json.title).toBe('app')
    expect(second.json.title).toBe('app')
    expect(first.json.placeholderDir).not.toBe(second.json.placeholderDir)
    expect(created).toEqual([
      { path: join(rwRoot(), 'prod', 'srv', 'app'), title: 'app' },
      { path: join(rwRoot(), 'prod', 'opt', 'app'), title: 'app' },
    ])
    expect(records.size).toBe(2)
  })

  it('uses canonical POSIX basenames after trailing-slash and symlink resolution', async () => {
    const { created, registry } = fakeRegistry()
    harness.pool.fs.addSymlink('/srv/link', '/srv/app')
    harness.pool.fs.addDir('/srv/中文 project')
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry })
    const link = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/link/' } })
    expect(link.json).toMatchObject({ workspace: '/srv/app', title: 'app' })
    const unicode = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/中文 project///' } })
    expect(unicode.json.title).toBe('中文 project')
    expect(created[1]?.path).toBe(join(rwRoot(), 'prod', 'srv', '中文 project'))
  })

  it('keeps renamed projects in the same mirror tree under their registered main workspace', async () => {
    const { created, registry } = fakeRegistry()
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry, defaultMainDir: '/' })
    await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/' } })
    const child = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app', name: 'My App' } })
    expect(created).toEqual([
      { path: join(rwRoot(), 'prod'), title: 'prod' },
      { path: join(rwRoot(), 'prod', 'srv', 'app'), title: 'My App' },
    ])
    expect(child.json.placeholderDir).toBe(join(rwRoot(), 'prod', 'srv', 'app'))
    const otherHost = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'dev', path: '/srv/app' } })
    expect(otherHost.json).toMatchObject({ title: 'app', placeholderDir: join(rwRoot(), 'dev', 'srv', 'app') })
    // Equal basenames on different hosts never share a workspace record.
    expect(created[1]?.path).not.toBe(created[2]?.path)
  })

  it('defaults a newly picked workspace with a whitespace-only name to basename', async () => {
    const { created, registry } = fakeRegistry()
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry })
    const blank = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app', name: '   ' } })
    expect(blank.json).toMatchObject({ title: 'app', placeholderDir: join(rwRoot(), 'prod', 'srv', 'app') })
    expect(created[0]?.title).toBe('app')
  })

  it('reports the actual existing title if an older registry cannot rename records', async () => {
    const create = vi.fn(async () => ({ title: 'Existing title' }))
    const withRegistry = buildRoutes({ workspaceRegistry: () => ({ create }) })
    const res = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app', name: 'New title' } })
    expect(res.json).toMatchObject({ registered: true, title: 'Existing title' })
    expect(create).toHaveBeenCalledWith(join(rwRoot(), 'prod', 'srv', 'app'), 'New title')
  })

  it("uses the alias for remote '/' even when the main directory is elsewhere", async () => {
    const { created, registry } = fakeRegistry()
    const withRegistry = buildRoutes({ workspaceRegistry: () => registry, defaultMainDir: '/srv' })
    const res = await call(withRegistry, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/' } })
    expect(res.json).toMatchObject({ ok: true, workspace: '/', placeholderDir: join(rwRoot(), 'prod'), title: 'prod', registered: true })
    expect(created).toEqual([{ path: join(rwRoot(), 'prod'), title: 'prod' }])
  })

  it('GET status reports the plugin-wide default main directory', async () => {
    const withDefault = buildRoutes({ defaultMainDir: '/' })
    expect((await call(withDefault, '/api/dsh-rw/status', 'GET')).json.defaultMainDir).toBe('/')
    const none = buildRoutes({ defaultMainDir: '' })
    expect((await call(none, '/api/dsh-rw/status', 'GET')).json.defaultMainDir).toBe('')
  })

  it('POST workspace degrades to registered:false when the registry throws (the pick still succeeds)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { registry } = fakeRegistry((path) => path.endsWith('app'))
      const failing = buildRoutes({ workspaceRegistry: () => registry })
      const res = await call(failing, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
      expect(res.status).toBe(200)
      expect(res.json).toMatchObject({ ok: true, workspace: '/srv/app', registered: false })
      expect(existsSync(res.json.placeholderDir as string)).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not register'))

      const throwingGetter = buildRoutes({
        workspaceRegistry: () => {
          throw new Error('service lookup failed')
        },
      })
      const res2 = await call(throwingGetter, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
      expect(res2.json).toMatchObject({ ok: true, registered: false })

      const absent = buildRoutes({ workspaceRegistry: () => undefined })
      const res3 = await call(absent, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
      expect(res3.json).toMatchObject({ ok: true, registered: false })
    } finally {
      warn.mockRestore()
    }
  })

  it('POST workspace rejects a mirror position owned by another workspace (no hash suffix)', async () => {
    mkdirSync(join(rwRoot(), 'prod', 'srv', 'app'), { recursive: true })
    writeFileSync(
      join(rwRoot(), 'prod', 'srv', 'app', '.dsh-rw-meta.json'),
      JSON.stringify({
        plugin: 'dsh-rw',
        alias: 'prod',
        host: 'example.com',
        port: 22,
        user: 'deploy',
        remotePath: '/other',
        createdAt: '2026-01-01T00:00:00.000Z',
        note: 'placeholder only — not a copy of remote files',
      }),
    )
    const res = await call(routes, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })

  it('POST workspace reports an unsafe placeholder root as 500 UNSAFE_PLACEHOLDER_ROOT', async () => {
    const real = join(dir, 'real-root')
    mkdirSync(real)
    symlinkSync(real, rwRoot())
    const res = await call(routes, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/srv/app' } })
    expect(res.status).toBe(500)
    expect(res.json).toMatchObject({ ok: false, code: 'UNSAFE_PLACEHOLDER_ROOT' })
  })

  it('POST workspace rejects files, unknown aliases and bad bodies', async () => {
    const file = await call(routes, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/etc/passwd' } })
    expect(file.status).toBe(400)
    expect(file.json.code).toBe('NOT_A_DIRECTORY')
    const ghost = await call(routes, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'ghost', path: '/srv/app' } })
    expect(ghost.status).toBe(400)
    const empty = await call(routes, '/api/dsh-rw/workspace', 'POST', { body: {} })
    expect(empty.status).toBe(400)
    expect(harness.sessions.lastAlias).toBeNull()
  })

  it('POST local-pick returns 400 when no picker service is available', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/local-pick', 'POST', { body: {} })
    expect(status).toBe(400)
    expect(json.ok).toBe(false)
    expect(json.error).toContain('unavailable')
  })

  it('POST local-pick covers picked / cancelled / failed', async () => {
    const picked = buildRoutes({ pickDirectory: async () => '/Users/me/project' })
    expect(await call(picked, '/api/dsh-rw/local-pick', 'POST', { body: {} })).toEqual({
      status: 200,
      json: { ok: true, path: '/Users/me/project' },
    })

    const cancelled = buildRoutes({ pickDirectory: async () => null })
    expect(await call(cancelled, '/api/dsh-rw/local-pick', 'POST', { body: {} })).toEqual({
      status: 200,
      json: { ok: true, cancelled: true },
    })

    const failed = buildRoutes({ pickDirectory: async () => Promise.reject(new Error('non-native backend')) })
    const res = await call(failed, '/api/dsh-rw/local-pick', 'POST', { body: {} })
    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({ ok: false, error: 'non-native backend' })
  })
})

describe('GET /api/dsh-rw/ls-local', () => {
  let tree: string

  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 'dsh-rw-lslocal-'))
    mkdirSync(join(tree, 'alpha'))
    mkdirSync(join(tree, 'beta'))
    writeFileSync(join(tree, 'plain.txt'), 'x')
  })

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true })
  })

  it('lists only drillable directories, sorted, with parent and home', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/ls-local', 'GET', {
      url: `/api/dsh-rw/ls-local?path=${encodeURIComponent(tree)}`,
    })
    expect(status).toBe(200)
    expect(json.path).toBe(tree)
    expect(json.parent).toBe(join(tree, '..'))
    expect(typeof json.home).toBe('string')
    const names = (json.items as { name: string }[]).map((i) => i.name)
    expect(names).toEqual(['alpha', 'beta'])
  })

  it('resolves ~ and ~/… against the home directory', async () => {
    const home = homedir()
    const bare = await call(routes, '/api/dsh-rw/ls-local', 'GET', { url: '/api/dsh-rw/ls-local?path=~' })
    expect(bare.status).toBe(200)
    expect(bare.json.path).toBe(home)
    const nested = await call(routes, '/api/dsh-rw/ls-local', 'GET', { url: '/api/dsh-rw/ls-local?path=~/' })
    expect(nested.json.path).toBe(home)
  })

  it('defaults to the home directory when path is absent', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/ls-local', 'GET')
    expect(status).toBe(200)
    expect(json.path).toBe(homedir())
  })

  it('rejects relative paths and non-directories with structured codes', async () => {
    const relative = await call(routes, '/api/dsh-rw/ls-local', 'GET', { url: '/api/dsh-rw/ls-local?path=nope' })
    expect(relative.status).toBe(400)
    expect(relative.json.code).toBe('INVALID_INPUT')
    const file = await call(routes, '/api/dsh-rw/ls-local', 'GET', {
      url: `/api/dsh-rw/ls-local?path=${encodeURIComponent(join(tree, 'plain.txt'))}`,
    })
    expect(file.status).toBe(400)
    expect(file.json.code).toBe('NOT_A_DIRECTORY')
    const missing = await call(routes, '/api/dsh-rw/ls-local', 'GET', { url: '/api/dsh-rw/ls-local?path=/no/such/dir' })
    expect(missing.status).toBe(404)
    expect(missing.json.code).toBe('NO_SUCH_PATH')
  })
})

describe('PATCH /api/dsh-rw/hosts (edit a manual host)', () => {
  it('replaces the connection details and returns the summary (never the secret)', async () => {
    const created = await call(routes, '/api/dsh-rw/hosts', 'POST', {
      body: { alias: 'box', host: 'old.example.com', user: 'u', password: 'pw-one' },
    })
    expect(created.status).toBe(201)

    const updated = await call(routes, '/api/dsh-rw/hosts', 'PATCH', {
      body: { alias: 'box', host: 'new.example.com', port: 2222, user: 'v', keyPath: '/tmp/id_ed25519' },
    })
    expect(updated.status).toBe(200)
    expect((updated.json.host as { host: string }).host).toBe('new.example.com')
    expect((updated.json.host as { port: number }).port).toBe(2222)
    expect((updated.json.host as { authKind: string }).authKind).toBe('key')
    expect(JSON.stringify(updated.json)).not.toContain('pw-one')

    const list = await call(routes, '/api/dsh-rw/hosts', 'GET')
    const box = (list.json.hosts as { alias: string; host: string; port: number }[]).find((h) => h.alias === 'box')
    expect(box).toMatchObject({ host: 'new.example.com', port: 2222 })
  })

  it('refuses unknown aliases, ssh-config hosts, and invalid payloads', async () => {
    const ghost = await call(routes, '/api/dsh-rw/hosts', 'PATCH', { body: { alias: 'ghost', host: 'h', user: 'u', password: 'p' } })
    expect(ghost.status).toBe(404)
    // 'dev' comes from ~/.ssh/config in the fake table; 'prod' is manual.
    const fromConfig = await call(routes, '/api/dsh-rw/hosts', 'PATCH', { body: { alias: 'dev', host: 'h', user: 'u', password: 'p' } })
    expect(fromConfig.status).toBe(400)
    expect(fromConfig.json.error).toContain('ssh config')

    const created = await call(routes, '/api/dsh-rw/hosts', 'POST', { body: { alias: 'box2', host: 'a', user: 'u', password: 'p' } })
    expect(created.status).toBe(201)
    // An address-only edit keeps the stored credential instead of wiping it.
    const kept = await call(routes, '/api/dsh-rw/hosts', 'PATCH', { body: { alias: 'box2', host: 'b', user: 'u' } })
    expect(kept.status).toBe(200)
    expect(kept.json.host).toMatchObject({ host: 'b', authKind: 'password', passwordSet: true })
    // A genuinely invalid payload still fails.
    const noHost = await call(routes, '/api/dsh-rw/hosts', 'PATCH', { body: { alias: 'box2', user: 'u' } })
    expect(noHost.status).toBe(400)
    expect(noHost.json.code).toBe('INVALID_INPUT')
  })
})

describe('POST /api/dsh-rw/hosts/hide', () => {
  it('hides an ssh-config host, reports it in status, and puts it back', async () => {
    const hidden = await call(routes, '/api/dsh-rw/hosts/hide', 'POST', { body: { alias: 'dev' } })
    expect(hidden.status).toBe(200)
    expect(hidden.json.hiddenAliases).toEqual(['dev'])

    const status = await call(routes, '/api/dsh-rw/status', 'GET')
    expect((status.json.hosts as { alias: string }[]).map((h) => h.alias)).not.toContain('dev')
    expect(status.json.hiddenAliases).toEqual(['dev'])

    const back = await call(routes, '/api/dsh-rw/hosts/hide', 'POST', { body: { alias: 'dev', hidden: false } })
    expect(back.status).toBe(200)
    expect(back.json.hiddenAliases).toEqual([])
  })

  it('rejects a manual host and a missing alias', async () => {
    const manual = await call(routes, '/api/dsh-rw/hosts/hide', 'POST', { body: { alias: 'prod' } })
    expect(manual.status).toBe(400)
    const missing = await call(routes, '/api/dsh-rw/hosts/hide', 'POST', { body: { alias: 'ghost' } })
    expect(missing.status).toBe(400)
    expect(missing.json.code).toBe('INVALID_INPUT')
  })
})

describe('POST /api/dsh-rw/hosts/main', () => {
  it('stores the canonical remote directory (~ expanded, symlinks resolved) and echoes the summary', async () => {
    harness.pool.fs.addSymlink('/srv/link', '/srv/app')
    const res = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'prod', path: '/srv/link/' } })
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.host).toMatchObject({ alias: 'prod', mainDir: '/srv/app' })
    expect(JSON.stringify(res.json)).not.toContain(SECRET_PASSWORD)
    expect(harness.hosts.mainDir('prod')).toBe('/srv/app')

    // FakeSftp's home is '/', so ~/srv → /srv.
    const home = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'dev', path: '~/srv' } })
    expect(home.json.host).toMatchObject({ alias: 'dev', mainDir: '/srv' })
  })

  it('clears with path: null', async () => {
    harness.hosts.setMainDir('prod', '/srv/app')
    const res = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'prod', path: null } })
    expect(res.status).toBe(200)
    expect((res.json.host as { mainDir?: string }).mainDir).toBeUndefined()
    expect(harness.hosts.mainDir('prod')).toBeUndefined()
  })

  it('validates alias, path and the remote directory with { error, code }', async () => {
    const noAlias = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { path: '/srv' } })
    expect(noAlias.status).toBe(400)
    expect(noAlias.json.code).toBe('INVALID_INPUT')
    const noPath = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'prod' } })
    expect(noPath.status).toBe(400)
    const badPath = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'prod', path: 42 } })
    expect(badPath.status).toBe(400)
    const ghost = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'ghost', path: '/srv' } })
    expect(ghost.status).toBe(404)
    const relative = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'prod', path: 'srv' } })
    expect(relative.status).toBe(400)
    expect(relative.json.code).toBe('INVALID_INPUT')
    const missing = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'prod', path: '/nope' } })
    expect(missing.status).toBe(404)
    expect(missing.json.code).toBe('NO_SUCH_PATH')
    const file = await call(routes, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'prod', path: '/etc/passwd' } })
    expect(file.status).toBe(400)
    expect(file.json.code).toBe('NOT_A_DIRECTORY')
    expect(harness.hosts.mainDir('prod')).toBeUndefined()
    const wrongMethod = await call(routes, '/api/dsh-rw/hosts/main', 'GET')
    expect(wrongMethod.status).toBe(405)
  })

  it('answers 501 when the host table cannot store main directories', async () => {
    const bare = Object.create(harness.hosts) as typeof harness.hosts
    Object.defineProperty(bare, 'setMainDir', { value: undefined })
    const limited = buildRoutes({ hosts: bare })
    const res = await call(limited, '/api/dsh-rw/hosts/main', 'POST', { body: { alias: 'prod', path: '/srv' } })
    expect(res.status).toBe(501)
  })
})
