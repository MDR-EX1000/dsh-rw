// dsh-rw — the /api/dsh-rw route family serving the settings/picker UI:
// status, host CRUD (manual entries only), connection test, remote directory
// listing for the picker, workspace selection, and the native local-directory
// picker bridge. Every route sits behind the loopback trust fence copied from
// dsh-ssh (socket address + Host header + browser same-origin markers): these
// endpoints open SSH connections, so LAN-exposed DSH deployments must not
// serve them. Responses are JSON UTF-8; failures carry { error, code } with
// the RwError code — and never passwords or key material (host payloads are
// only ever echoed back through HostTable.summarize).
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { mapSftpError, RwError, toRwError } from './errors.js'
import type { RwErrorCode } from './errors.js'
import { normalizeRemote } from './guard.js'
import type { HostEntry } from './hosts.js'
import { resolvePlaceholderDir } from './placeholder.js'
import { resolveWorkspaceDir } from './tools.js'
import type { ToolsDeps } from './tools.js'

/** Re-exported so index.ts builds routes without importing dsh-host-webserver. */
export type Route = WebRoute

export interface RoutesDeps extends ToolsDeps {
  /**
   * Native local-directory picker (adapted from the ctx directoryPicker
   * service by index.ts). Absent → /local-pick answers 400.
   */
  pickDirectory?: () => Promise<string | null>
}

/** Cap on JSON request bodies (host entries and workspace payloads are small). */
const MAX_JSON_BODY_BYTES = 64 * 1024

// --- loopback trust fence (verbatim copy of dsh-ssh/src/loopback.ts) --------

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return (
    parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. The socket address is
 * authoritative; X-Forwarded-For is never trusted.
 */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// --- helpers -----------------------------------------------------------------

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** RwError code → HTTP status for error responses. */
function statusFor(code: RwErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT':
    case 'NOT_A_DIRECTORY':
      return 400
    case 'NO_SUCH_PATH':
      return 404
    case 'PERMISSION_DENIED':
      return 403
    case 'NOT_CONNECTED':
    case 'NO_WORKSPACE':
      return 409
    default:
      return 500
  }
}

/** Normalized JSON error response: `{ error, code }` at the mapped status. */
function writeError(res: ServerResponse, err: unknown): void {
  const e = toRwError(err)
  writeJson(res, statusFor(e.code), { error: e.message, code: e.code })
}

// --- routes ------------------------------------------------------------------

/** Build every /api/dsh-rw route (exact paths). */
export function makeRoutes(deps: RoutesDeps): Route[] {
  const { hosts, pool, session } = deps

  /** Fence + method check; returns false after writing the error response. */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only', code: 'PERMISSION_DENIED' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}`, code: 'INVALID_INPUT' })
      return false
    }
    return true
  }

  return [
    // ------------------------------------------------- GET /api/dsh-rw/status
    {
      kind: 'exact',
      path: '/api/dsh-rw/status',
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return
        const alias = session.alias
        const workspace = session.workspace
        writeJson(res, 200, {
          hosts: hosts.summaries(),
          current: {
            alias,
            workspace,
            placeholderDir: alias !== null && workspace !== null ? resolvePlaceholderDir(alias, workspace, deps.placeholderBaseDir) : null,
            connected: alias !== null && pool.connected().includes(alias),
          },
        })
      },
    },

    // ------------------------------------------------- * /api/dsh-rw/hosts
    {
      kind: 'exact',
      path: '/api/dsh-rw/hosts',
      // One handler per path (duplicate (kind, path) registrations throw), so
      // GET/POST/DELETE dispatch here.
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only', code: 'PERMISSION_DENIED' })
          return
        }
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          writeJson(res, 200, { hosts: hosts.summaries() })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body', code: 'INVALID_INPUT' })
            return
          }
          try {
            const entry = hosts.addManual({
              alias: typeof body.alias === 'string' ? body.alias : '',
              host: typeof body.host === 'string' ? body.host : '',
              ...(typeof body.port === 'number' ? { port: body.port } : {}),
              user: typeof body.user === 'string' ? body.user : '',
              ...(typeof body.password === 'string' && body.password !== '' ? { password: body.password } : {}),
              ...(typeof body.keyPath === 'string' && body.keyPath !== '' ? { keyPath: body.keyPath } : {}),
              ...(typeof body.passphrase === 'string' && body.passphrase !== '' ? { passphrase: body.passphrase } : {}),
            })
            // The summary is the only echo of the entry — never the password.
            writeJson(res, 201, { ok: true, host: hosts.summarize(entry) })
          } catch (err) {
            writeError(res, err)
          }
          return
        }
        if (method === 'DELETE') {
          const body = await readJsonBody(req)
          const alias = typeof body?.alias === 'string' ? body.alias : ''
          if (alias === '') {
            writeJson(res, 400, { error: 'alias is required', code: 'INVALID_INPUT' })
            return
          }
          const entry = hosts.find(alias)
          if (!entry) {
            writeJson(res, 404, { error: `unknown host alias: ${JSON.stringify(alias)}`, code: 'INVALID_INPUT' })
            return
          }
          if (entry.source !== 'manual') {
            writeJson(res, 400, {
              error: `host ${JSON.stringify(alias)} comes from ssh config and cannot be removed here — edit ~/.ssh/config`,
              code: 'INVALID_INPUT',
            })
            return
          }
          hosts.removeManual(alias)
          pool.disconnect(alias)
          if (session.alias === alias) session.set({ alias: null, workspace: null })
          writeJson(res, 200, { ok: true })
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}`, code: 'INVALID_INPUT' })
      },
    },

    // ------------------------------------------------- POST /api/dsh-rw/test
    {
      kind: 'exact',
      path: '/api/dsh-rw/test',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        // Two forms sharing pool.testConnect: { alias } probes a registered
        // host; { host, user, password?|keyPath?, … } (no alias) builds a
        // throwaway entry so the add-host form can probe before saving —
        // nothing is persisted, and the temp connection (pooled under the ''
        // key) is dropped right after the probe.
        let entry: HostEntry
        let temp = false
        if (alias !== '') {
          const found = hosts.find(alias)
          if (!found) {
            writeJson(res, 400, { ok: false, error: `unknown host alias: ${JSON.stringify(alias)}`, code: 'INVALID_INPUT' })
            return
          }
          entry = found
        } else {
          const host = typeof body?.host === 'string' ? body.host : ''
          const user = typeof body?.user === 'string' ? body.user : ''
          const port = typeof body?.port === 'number' ? body.port : 22
          const password = typeof body?.password === 'string' && body.password !== '' ? body.password : undefined
          const keyPath = typeof body?.keyPath === 'string' && body.keyPath !== '' ? body.keyPath : undefined
          const passphrase = typeof body?.passphrase === 'string' && body.passphrase !== '' ? body.passphrase : undefined
          if (host === '' || user === '') {
            writeJson(res, 400, { ok: false, error: 'host and user are required', code: 'INVALID_INPUT' })
            return
          }
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            writeJson(res, 400, { ok: false, error: `invalid port: ${port}`, code: 'INVALID_INPUT' })
            return
          }
          if (password === undefined && keyPath === undefined) {
            writeJson(res, 400, { ok: false, error: 'either keyPath or password is required', code: 'INVALID_INPUT' })
            return
          }
          // Same key-wins-when-both-given rule as HostTable.addManual.
          entry = {
            alias: '',
            host,
            port,
            user,
            auth: keyPath !== undefined ? { kind: 'key', keyPath, ...(passphrase ? { passphrase } : {}) } : { kind: 'password', password },
            source: 'manual',
          }
          temp = true
        }
        try {
          const latencyMs = await pool.testConnect(entry)
          writeJson(res, 200, { ok: true, latencyMs })
        } catch (err) {
          // A failed probe is a result, not an HTTP error: the UI renders it.
          const e = toRwError(err)
          writeJson(res, 200, { ok: false, code: e.code, error: e.message })
        } finally {
          if (temp) pool.disconnect('')
        }
      },
    },

    // --------------------------------------------------- GET /api/dsh-rw/ls
    {
      kind: 'exact',
      path: '/api/dsh-rw/ls',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const path = queryParam(url, 'path') ?? '/'
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required', code: 'INVALID_INPUT' })
          return
        }
        const entry = hosts.find(alias)
        if (!entry) {
          writeJson(res, 400, { error: `unknown host alias: ${JSON.stringify(alias)}`, code: 'INVALID_INPUT' })
          return
        }
        if (!path.startsWith('/')) {
          writeJson(res, 400, { error: `path must be absolute: ${JSON.stringify(path)}`, code: 'INVALID_INPUT' })
          return
        }
        // Picker browsing is deliberately NOT workspace-confined: no workspace
        // exists yet at this stage. It still requires a connectable alias.
        try {
          const sftp = await pool.sftp(entry)
          let isDir: boolean
          try {
            isDir = (await sftp.stat(path)).isDirectory()
          } catch (err) {
            throw mapSftpError(err, path)
          }
          if (!isDir) throw new RwError('NOT_A_DIRECTORY', `not a directory: ${path}`)
          let items: Awaited<ReturnType<typeof sftp.readdir>>
          try {
            items = await sftp.readdir(path)
          } catch (err) {
            throw mapSftpError(err, path)
          }
          const entries = items
            .filter((it) => it.filename !== '.' && it.filename !== '..')
            .map((it) => ({
              name: it.filename,
              type: (it.attrs.isSymbolicLink() ? 'symlink' : it.attrs.isDirectory() ? 'dir' : 'file') as
                | 'dir'
                | 'file'
                | 'symlink',
            }))
            // dirs first, then files, then symlinks; alphabetical within a kind
            .sort((a, b) => {
              const rank = (t: string): number => (t === 'dir' ? 0 : t === 'file' ? 1 : 2)
              return rank(a.type) - rank(b.type) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
            })
          writeJson(res, 200, { path: normalizeRemote(path), items: entries })
        } catch (err) {
          writeError(res, err)
        }
      },
    },

    // -------------------------------------------- POST /api/dsh-rw/workspace
    {
      kind: 'exact',
      path: '/api/dsh-rw/workspace',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const path = typeof body?.path === 'string' ? body.path : ''
        if (alias === '' || path === '') {
          writeJson(res, 400, { ok: false, error: 'alias and path are required', code: 'INVALID_INPUT' })
          return
        }
        // Optional display name for a fresh placeholder (blank trims to absent).
        const name = typeof body?.name === 'string' && body.name.trim() !== '' ? body.name.trim() : undefined
        try {
          const { workspace, placeholderDir } = await resolveWorkspaceDir(deps, alias, path, name)
          session.set({ alias, workspace })
          writeJson(res, 200, { ok: true, workspace, placeholderDir })
        } catch (err) {
          const e = toRwError(err)
          writeJson(res, statusFor(e.code), { ok: false, error: e.message, code: e.code })
        }
      },
    },

    // ------------------------------------------- POST /api/dsh-rw/local-pick
    {
      kind: 'exact',
      path: '/api/dsh-rw/local-pick',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (deps.pickDirectory === undefined) {
          writeJson(res, 400, {
            ok: false,
            error: 'local directory picker service is unavailable (no DSH directory-picker backend) — enter the path manually',
            code: 'INVALID_INPUT',
          })
          return
        }
        try {
          const picked = await deps.pickDirectory()
          if (picked === null) {
            writeJson(res, 200, { ok: true, cancelled: true })
            return
          }
          writeJson(res, 200, { ok: true, path: picked })
        } catch (err) {
          writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err), code: 'INVALID_INPUT' })
        }
      },
    },
  ]
}
