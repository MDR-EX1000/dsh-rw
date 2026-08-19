// Shared in-memory fakes for the P4 tests (tools/routes/index): a HostTableLike
// with fixed entries (one carrying a password, to prove it never leaks) and a
// PoolLike returning a FakeSftp plus scripted exec/testConnect results.
import { RwError } from '../src/errors.js'
import type { HostEntry, HostSummary } from '../src/hosts.js'
import type { ExecResult, SftpLike } from '../src/ssh-pool.js'
import type { HostTableLike, PoolLike, ToolsDeps } from '../src/tools.js'
import { Session } from '../src/session.js'
import { FakeSftp } from './fakes.js'

/** The password-bearing entry: assertions scan every output for this string. */
export const SECRET_PASSWORD = 't0p-secret-pw'

export const ENTRY_PROD: HostEntry = {
  alias: 'prod',
  host: 'example.com',
  port: 22,
  user: 'deploy',
  auth: { kind: 'password', password: SECRET_PASSWORD },
  source: 'manual',
}

export const ENTRY_DEV: HostEntry = {
  alias: 'dev',
  host: 'devbox.local',
  port: 2222,
  user: 'root',
  auth: { kind: 'key', keyPath: '/tmp/id_fake' },
  source: 'ssh-config',
}

export class FakeHosts implements HostTableLike {
  readonly entries: HostEntry[]

  constructor(entries: HostEntry[] = [ENTRY_PROD, ENTRY_DEV]) {
    this.entries = [...entries]
  }

  list(): HostEntry[] {
    return [...this.entries]
  }

  find(alias: string): HostEntry | undefined {
    return this.entries.find((e) => e.alias === alias)
  }

  summarize(entry: HostEntry): HostSummary {
    return {
      alias: entry.alias,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      authKind: entry.auth.kind,
      keyReady: entry.auth.kind === 'key' && entry.auth.keyPath !== '',
      passwordSet: entry.auth.kind === 'password' && !!entry.auth.password,
      source: entry.source,
    }
  }

  summaries(): HostSummary[] {
    return this.entries.map((e) => this.summarize(e))
  }

  addManual(payload: {
    alias: string
    host: string
    port?: number
    user: string
    password?: string
    keyPath?: string
    passphrase?: string
  }): HostEntry {
    if (!payload.alias) throw new RwError('INVALID_INPUT', 'invalid alias: ""')
    if (!payload.host) throw new RwError('INVALID_INPUT', 'host is required')
    if (!payload.keyPath && !payload.password) throw new RwError('INVALID_INPUT', 'either keyPath or password is required')
    if (this.entries.some((e) => e.alias === payload.alias)) {
      throw new RwError('INVALID_INPUT', `manual host already exists: ${payload.alias}`)
    }
    const entry: HostEntry = {
      alias: payload.alias,
      host: payload.host,
      port: payload.port ?? 22,
      user: payload.user,
      auth: payload.keyPath
        ? { kind: 'key', keyPath: payload.keyPath, ...(payload.passphrase ? { passphrase: payload.passphrase } : {}) }
        : { kind: 'password', password: payload.password },
      source: 'manual',
    }
    this.entries.push(entry)
    return entry
  }

  removeManual(alias: string): void {
    const i = this.entries.findIndex((e) => e.alias === alias && e.source === 'manual')
    if (i >= 0) this.entries.splice(i, 1)
  }
}

export class FakePool implements PoolLike {
  /** The in-memory remote filesystem every alias shares. */
  readonly fs = new FakeSftp()
  readonly execCalls: { alias: string; command: string; opts?: { cwd?: string; timeoutMs?: number } }[] = []
  readonly execQueue: ExecResult[] = []
  execError: unknown
  testConnectLatency = 42
  testConnectError: unknown
  sftpError: unknown
  readonly disconnected: string[] = []
  readonly connectedAliases = new Set<string>()
  disposed = false

  async exec(entry: HostEntry, command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    this.execCalls.push({ alias: entry.alias, command, ...(opts !== undefined ? { opts } : {}) })
    if (this.execError !== undefined) throw this.execError
    return this.execQueue.shift() ?? { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
  }

  async sftp(entry: HostEntry): Promise<SftpLike> {
    if (this.sftpError !== undefined) throw this.sftpError
    this.connectedAliases.add(entry.alias)
    return this.fs
  }

  async testConnect(entry: HostEntry): Promise<number> {
    if (this.testConnectError !== undefined) throw this.testConnectError
    this.connectedAliases.add(entry.alias)
    return this.testConnectLatency
  }

  disconnect(alias: string): void {
    this.disconnected.push(alias)
    this.connectedAliases.delete(alias)
  }

  connected(): string[] {
    return [...this.connectedAliases]
  }

  dispose(): void {
    this.disposed = true
  }
}

export interface FakeHarness {
  deps: ToolsDeps
  hosts: FakeHosts
  pool: FakePool
  session: Session
  /** Remote fixture root, seeded as a directory with a couple of files. */
  workspace: string
}

/**
 * Wire deps against a tmp session store + tmp placeholder base. The FakeSftp
 * is seeded with /srv/app/{README.md,src/index.ts} and /etc/passwd (the
 * symlink-escape target). connect() flips the session into the picked state.
 */
export function makeHarness(dir: string): FakeHarness & { connect(): void } {
  const hosts = new FakeHosts()
  const pool = new FakePool()
  const session = new Session(`${dir}/session.json`)
  pool.fs
    .addDir('/srv/app/src')
    .addFile('/srv/app/README.md', 'line1\nline2\nline3\n')
    .addFile('/srv/app/src/index.ts', 'export {}\n')
    .addDir('/etc')
    .addFile('/etc/passwd', 'root:x:0:0\n')
  const deps: ToolsDeps = {
    hosts,
    pool,
    session,
    config: { commandTimeoutMs: 30000, maxOutputChars: 200000, hostKeyPolicy: 'accept-new' },
    placeholderBaseDir: `${dir}/placeholders`,
  }
  return {
    deps,
    hosts,
    pool,
    session,
    workspace: '/srv/app',
    connect() {
      pool.connectedAliases.add('prod')
      session.set({ alias: 'prod', workspace: '/srv/app' })
    },
  }
}
