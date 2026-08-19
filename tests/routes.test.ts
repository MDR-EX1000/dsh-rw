import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RwError } from '../src/errors.js'
import { placeholderDirFor } from '../src/placeholder.js'
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
      ['/api/dsh-rw/workspace', 'POST'],
      ['/api/dsh-rw/local-pick', 'POST'],
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
  it('GET status reflects the session and summarizes hosts', async () => {
    const empty = await call(routes, '/api/dsh-rw/status', 'GET')
    expect(empty.status).toBe(200)
    expect(empty.json.current).toEqual({ alias: null, workspace: null, placeholderDir: null, connected: false })
    expect(Array.isArray(empty.json.hosts)).toBe(true)

    harness.connect()
    const picked = await call(routes, '/api/dsh-rw/status', 'GET')
    expect(picked.json.current).toEqual({
      alias: 'prod',
      workspace: '/srv/app',
      placeholderDir: placeholderDirFor('prod', '/srv/app', `${dir}/placeholders`),
      connected: true,
    })
    expect(JSON.stringify(picked.json)).not.toContain(SECRET_PASSWORD)
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

    const ok = await call(routes, '/api/dsh-rw/hosts', 'DELETE', { body: { alias: 'prod' } })
    expect(ok.status).toBe(200)
    expect(harness.hosts.find('prod')).toBeUndefined()
    expect(harness.pool.disconnected).toContain('prod')
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
  it('POST workspace validates, stores the session and creates the placeholder', async () => {
    const { status, json } = await call(routes, '/api/dsh-rw/workspace', 'POST', {
      body: { alias: 'prod', path: '/srv/app/' },
    })
    expect(status).toBe(200)
    expect(json).toEqual({
      ok: true,
      workspace: '/srv/app',
      placeholderDir: placeholderDirFor('prod', '/srv/app', `${dir}/placeholders`),
    })
    expect(harness.session.alias).toBe('prod')
    expect(harness.session.workspace).toBe('/srv/app')
    expect(existsSync(json.placeholderDir as string)).toBe(true)
  })

  it('POST workspace rejects files, unknown aliases and bad bodies', async () => {
    const file = await call(routes, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'prod', path: '/etc/passwd' } })
    expect(file.status).toBe(400)
    expect(file.json.code).toBe('NOT_A_DIRECTORY')
    const ghost = await call(routes, '/api/dsh-rw/workspace', 'POST', { body: { alias: 'ghost', path: '/srv/app' } })
    expect(ghost.status).toBe(400)
    const empty = await call(routes, '/api/dsh-rw/workspace', 'POST', { body: {} })
    expect(empty.status).toBe(400)
    expect(harness.session.workspace).toBeNull()
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
