import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RwError } from '../src/errors.js'
import { ownRemoteIoResource } from '../src/io-context.js'
import type { RemoteIoOptions } from '../src/io-context.js'
import { makeRoutes } from '../src/routes.js'
import { makeTools } from '../src/tools.js'
import type { SftpLike } from '../src/ssh-pool.js'
import { makeHarness } from './p4-fakes.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-rw-tool-io-')); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

function ioHarness(overrides?: (base: SftpLike, options: RemoteIoOptions) => Partial<SftpLike>) {
  const h = makeHarness(dir)
  h.connect()
  h.deps.config.operationTimeoutMs = 50
  const leases: { options: RemoteIoOptions; close: ReturnType<typeof vi.fn> }[] = []
  h.pool.sftp = async (_entry, options?: RemoteIoOptions) => {
    expect(options?.signal).toBeDefined()
    expect(options?.deadlineMs).toBeGreaterThanOrEqual(Date.now())
    let closed = false
    const close = vi.fn(() => { closed = true })
    ownRemoteIoResource(close)
    const methods = overrides?.(h.pool.fs, options!) ?? {}
    const facade = new Proxy(h.pool.fs, { get(target, key) {
      if (key === 'close') return close
      const value = methods[key as keyof SftpLike] ?? Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (closed) return Promise.reject(new RwError('SFTP_UNAVAILABLE', 'used closed test facade'))
        return value.apply(target, args)
      }
    } })
    leases.push({ options: options!, close })
    return facade
  }
  const tools = makeTools(h.deps) as { name: string; execute(args: unknown, exec?: { signal?: AbortSignal }): Promise<{ text: string }> }[]
  const call = (name: string, args: unknown, signal?: AbortSignal) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw Error('missing tool ' + name)
    return tool.execute(args, { signal })
  }
  return { h, leases, call }
}

function response() {
  const r = Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false, writableEnded: false, status: 0, body: '',
    writeHead(status: number) { r.status = status; r.headersSent = true; return r },
    end(body?: string) { r.body = body ?? ''; r.writableEnded = true; return r },
  })
  return r
}
function request(url: string, method = 'GET', body?: unknown) {
  return Object.assign(new EventEmitter(), { method, url, headers: { host: '127.0.0.1:8080' },
    socket: { remoteAddress: '127.0.0.1' }, aborted: false,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }) as unknown as IncomingMessage
}

describe('rw tool remote IO ownership', () => {
  it('forwards an effective signal/deadline and releases a successful file lease', async () => {
    const { call, leases } = ioHarness()
    const parent = new AbortController()
    expect((await call('rw_read_file', { path: 'README.md' }, parent.signal)).text).toContain('line1')
    expect(leases).toHaveLength(1)
    expect(leases[0]!.options.signal).not.toBe(parent.signal)
    expect(leases[0]!.options.signal!.aborted).toBe(true)
    expect(leases[0]!.close).toHaveBeenCalledOnce()
    expect(parent.signal.aborted).toBe(false)
  })

  it('waits for cooperative read teardown on cancellation rather than abandoning it', async () => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const { call, leases } = ioHarness((_base, options) => ({ readFile: async () => {
      started()
      return await new Promise<Buffer>((_resolve, reject) => {
        const abort = () => setTimeout(() => reject(new RwError('OPERATION_ABORTED', 'read teardown finished', { outcome: 'unknown' })), 20)
        options.signal!.addEventListener('abort', abort, { once: true })
        if (options.signal!.aborted) abort()
      })
    } }))
    const controller = new AbortController()
    let settled = false
    const operation = call('rw_read_file', { path: 'README.md' }, controller.signal)
    const checked = expect(operation).rejects.toThrow('OPERATION_ABORTED')
    void operation.then(() => { settled = true }, () => { settled = true })
    await ready
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    await checked
    expect(leases[0]!.close).toHaveBeenCalledOnce()
  })

  it('does not run staged writes or patch commands twice when cleanup fails', async () => {
    const { call, h, leases } = ioHarness(() => ({ unlink: async () => {
      throw new RwError('OPERATION_TIMEOUT', 'cleanup did not answer', { outcome: 'unknown' })
    } }))
    const patch = '--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-line1\n+new\n'
    await expect(call('rw_apply_patch', { patch, strip: 1 })).rejects.toThrow('verify remote file state before retrying')
    expect(h.pool.execCalls).toHaveLength(2)
    expect(leases[0]!.close).toHaveBeenCalledOnce()
  })

  it('cancels a pending staged write without dispatching or replaying the patch', async () => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let writes = 0
    const { call, h, leases } = ioHarness((_base, options) => ({ writeFile: async () => {
      writes++
      started()
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new RwError('OPERATION_ABORTED', 'staged write outcome unknown', { outcome: 'unknown' }))
        options.signal!.addEventListener('abort', abort, { once: true })
        if (options.signal!.aborted) abort()
      })
    } }))
    const controller = new AbortController()
    const patch = '--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-line1\n+new\n'
    const operation = call('rw_apply_patch', { patch, strip: 1 }, controller.signal)
    const checked = expect(operation).rejects.toThrow('OPERATION_ABORTED')
    await ready
    controller.abort()
    await checked
    expect(writes).toBe(1)
    expect(h.pool.execCalls).toEqual([])
    expect(leases[0]!.close).toHaveBeenCalledOnce()
  })

  it('does not turn a deep watch timeout into a successful incomplete baseline', async () => {
    const { call, h } = ioHarness(base => ({ readdir: async path => {
      if (path.endsWith('/src')) throw new RwError('OPERATION_TIMEOUT', 'subtree did not answer')
      return await base.readdir(path)
    } }))
    await expect(call('rw_watch', { action: 'start', name: 'bad-scan' })).rejects.toThrow('OPERATION_TIMEOUT')
    expect((await call('rw_watch', { action: 'list' })).text).toBe('no watchers registered')
    expect(h.pool.execCalls).toEqual([])
  })

  it('retains the last complete watch baseline after a cancelled subtree scan', async () => {
    let fail = false
    const { call, h } = ioHarness(base => ({ readdir: async path => {
      if (fail && path.endsWith('/src')) throw new RwError('OPERATION_ABORTED', 'scan cancelled')
      return await base.readdir(path)
    } }))
    await call('rw_watch', { action: 'start', name: 'stable-scan' })
    h.pool.fs.addFile('/srv/app/src/new.ts', 'new')
    fail = true
    await expect(call('rw_watch', { action: 'poll', name: 'stable-scan' })).rejects.toThrow('OPERATION_ABORTED')
    fail = false
    expect((await call('rw_watch', { action: 'poll', name: 'stable-scan' })).text).toContain('new.ts')
  })

  it('reopens a fresh watch lease after start instead of reusing its closed facade', async () => {
    const { call, h, leases } = ioHarness()
    await call('rw_watch', { action: 'start', name: 'io-watch' })
    expect(leases[0]!.close).toHaveBeenCalledOnce()
    h.pool.fs.addFile('/srv/app/added.txt', 'new')
    expect((await call('rw_watch', { action: 'poll', name: 'io-watch' })).text).toContain('added.txt')
    expect(leases).toHaveLength(2)
    expect(leases[1]!.close).toHaveBeenCalledOnce()
  })

  it('rejects watcher polling from another host without silently reusing the old target', async () => {
    const { call, h } = ioHarness()
    await call('rw_watch', { action: 'start', name: 'owned-watch' })
    h.session.set({ alias: 'dev', workspace: '/srv/app' })
    await expect(call('rw_watch', { action: 'poll', name: 'owned-watch' })).rejects.toThrow('another host/workspace')
  })
})

describe('remote picker route IO lifetime', () => {
  function setup() {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const fixture = ioHarness((_base, options) => ({ readdir: async () => {
      started()
      return await new Promise<Awaited<ReturnType<SftpLike['readdir']>>>((_resolve, reject) => {
        const abort = () => reject(options.signal!.reason)
        options.signal!.addEventListener('abort', abort, { once: true })
        if (options.signal!.aborted) abort()
      })
    } }))
    fixture.h.deps.config.operationTimeoutMs = 20
    const route = makeRoutes(fixture.h.deps).find(r => r.path === '/api/dsh-rw/ls')!
    return { ...fixture, ready, route }
  }

  it('answers a remote listing timeout with 504 and releases the facade', async () => {
    const { route, ready, leases } = setup()
    const res = response()
    const operation = route.handler(request('/api/dsh-rw/ls?alias=prod&path=/srv/app'), res as unknown as ServerResponse)
    await ready
    await vi.advanceTimersByTimeAsync(20)
    await operation
    expect(res.status).toBe(504)
    expect(JSON.parse(res.body).code).toBe('OPERATION_TIMEOUT')
    expect(leases[0]!.close).toHaveBeenCalledOnce()
  })

  it('ends an aborted browser request without writing another response or retaining listeners', async () => {
    const { route, ready, leases } = setup()
    const req = request('/api/dsh-rw/ls?alias=prod&path=/srv/app')
    const res = response()
    const operation = route.handler(req, res as unknown as ServerResponse)
    await ready
    res.destroyed = true
    res.emit('close')
    await operation
    expect(res.body).toBe('')
    expect(res.listenerCount('close')).toBe(0)
    expect(req.listenerCount('aborted')).toBe(0)
    expect(leases[0]!.close).toHaveBeenCalledOnce()
  })
})

describe('workspace picker late-stage cancellation', () => {
  function lateMain() {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let acquisition = 0
    const fixture = ioHarness((_base, options) => ++acquisition !== 2 ? {} : {
      realpath: async () => {
        started()
        return await new Promise<string>((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
        })
      },
    })
    fixture.h.deps.defaultMainDir = '/'
    fixture.h.sessions.setLastAlias('dev')
    const rename = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({ title: 'old title', setTitle: rename }))
    const route = makeRoutes({ ...fixture.h.deps, workspaceRegistry: () => ({ create }) }).find(r => r.path === '/api/dsh-rw/workspace')!
    const req = request('/api/dsh-rw/workspace', 'POST', { alias: 'prod', path: '/srv/app', name: 'New title' })
    return { ...fixture, ready, create, rename, route, req }
  }

  it.each(['cancel', 'timeout'] as const)('does not swallow %s during the second main-directory resolver', async mode => {
    const { route, req, ready, h, create, rename, leases } = lateMain()
    const res = response()
    const operation = route.handler(req, res as unknown as ServerResponse)
    await ready
    if (mode === 'cancel') req.emit('aborted')
    else await vi.advanceTimersByTimeAsync(50)
    await operation
    expect(res.status).toBe(mode === 'cancel' ? 499 : 504)
    expect(create).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    expect(h.sessions.lastAlias).toBe('dev')
    expect(leases).toHaveLength(2)
    expect(leases.every(lease => lease.close.mock.calls.length === 1)).toBe(true)
  })

  it('does not rename or change lastAlias after cancellation during registry.create', async () => {
    const { h } = ioHarness()
    h.deps.defaultMainDir = '/srv/app'
    h.sessions.setLastAlias('dev')
    const req = request('/api/dsh-rw/workspace', 'POST', { alias: 'prod', path: '/srv/app', name: 'New title' })
    const rename = vi.fn(async () => undefined)
    const create = vi.fn(async () => {
      req.emit('aborted')
      return { title: 'Old title', setTitle: rename }
    })
    const route = makeRoutes({ ...h.deps, workspaceRegistry: () => ({ create }) }).find(r => r.path === '/api/dsh-rw/workspace')!
    const res = response()
    await route.handler(req, res as unknown as ServerResponse)
    expect(create).toHaveBeenCalledOnce()
    expect(rename).not.toHaveBeenCalled()
    expect(h.sessions.lastAlias).toBe('dev')
    expect(res.status).toBe(499)
  })

  it('does not update preferences after cancellation during an accepted setTitle', async () => {
    const { h } = ioHarness()
    h.deps.defaultMainDir = '/srv/app'
    h.sessions.setLastAlias('dev')
    const req = request('/api/dsh-rw/workspace', 'POST', { alias: 'prod', path: '/srv/app', name: 'New title' })
    const rename = vi.fn(async () => { req.emit('aborted') })
    const create = vi.fn(async () => ({ title: 'Old title', setTitle: rename }))
    const route = makeRoutes({ ...h.deps, workspaceRegistry: () => ({ create }) }).find(r => r.path === '/api/dsh-rw/workspace')!
    const res = response()
    await route.handler(req, res as unknown as ServerResponse)
    expect(rename).toHaveBeenCalledOnce()
    expect(h.sessions.lastAlias).toBe('dev')
    expect(res.status).toBe(499)
  })

  it('quiesces a POST body that never finishes when its operation deadline expires', async () => {
    const { h, leases } = ioHarness()
    h.deps.config.operationTimeoutMs = 20
    const req = Object.assign(new PassThrough(), { method: 'POST', url: '/api/dsh-rw/workspace',
      headers: { host: '127.0.0.1:8080' }, socket: { remoteAddress: '127.0.0.1' }, aborted: false })
    req.write('{"alias":"prod"')
    const create = vi.fn()
    const route = makeRoutes({ ...h.deps, workspaceRegistry: () => ({ create }) }).find(r => r.path === '/api/dsh-rw/workspace')!
    const res = response()
    const operation = route.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    await vi.advanceTimersByTimeAsync(20)
    await operation
    expect(req.destroyed).toBe(true)
    expect(res.status).toBe(504)
    expect(create).not.toHaveBeenCalled()
    expect(leases).toEqual([])
  })
})
