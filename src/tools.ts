// dsh-rw — the twelve rw_* agent tools. They give the model direct access to
// the remote host that the user picked: every file path goes through RemoteFs
// and is therefore confined (lexically + via realpath) to the current remote
// workspace root; rw_exec is the only tool that runs shell commands.
//
// Schema DSL rules honored here (violations crash DSH boot): requiredness is a
// per-leaf `required: true`, never a top-level required array; every output
// schema is the single { text } object rendered as one text ContentBlock.
//
// Error convention: anything thrown inside execute is normalized via
// toRwError and rethrown as `Error("[CODE] message")` — RwError messages do
// not carry their code, and the agent needs the code to classify failures.
// Messages must never contain passwords, key material, or passphrases.
import { createHash, randomBytes } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mapSftpError, RwError, toRwError } from './errors.js'
import { normalizeRemote, expandRemoteHome, resolveInWorkspace, assertRealpathInside, shq } from './guard.js'
import type { HostEntry, HostSummary } from './hosts.js'
import { ensurePlaceholder, findPlaceholderByPath, resolvePlaceholderDir } from './placeholder.js'
import { RemoteFs } from './remote-fs.js'
import type { Session } from './session.js'
import type { NativeRouting } from './shim.js'
import type { ExecResult, RemoteShellChannel, SftpLike } from './ssh-pool.js'
import { applyUnifiedDiff, looksBinary, patchTargets, unifiedDiff } from './patch.js'
import { WatchManager } from './watch.js'
import type { WatchFs, WatchSnapshotResult } from './watch.js'

/**
 * Structural subset of HostTable consumed by the tools/routes. HostTable has
 * private fields (nominally typed), so depending on this interface is what
 * lets tests supply an in-memory fake without casts; the real HostTable
 * satisfies it unchanged.
 */
export interface HostTableLike {
  list(): HostEntry[]
  find(alias: string): HostEntry | undefined
  summarize(entry: HostEntry): HostSummary
  summaries(): HostSummary[]
  addManual(payload: {
    alias: string
    host: string
    port?: number
    user: string
    password?: string
    keyPath?: string
    passphrase?: string
  }): HostEntry
  removeManual(alias: string): void
  /**
   * Replace one manual host's connection details. Optional so a structural
   * double stays valid; the route reports 501 when a table cannot edit.
   */
  updateManual?(
    alias: string,
    payload: {
      host: string
      port?: number
      user: string
      password?: string
      keyPath?: string
      passphrase?: string
    },
  ): HostEntry
}

/** Structural subset of SshPool (same rationale as HostTableLike). */
export interface PoolLike {
  exec(entry: HostEntry, command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>
  sftp(entry: HostEntry): Promise<SftpLike>
  /**
   * Open a long-lived shell channel. Optional so structural test doubles stay
   * valid; the persistent-shell manager reports a clear error when a pool
   * cannot provide one.
   */
  openShell?(entry: HostEntry): Promise<RemoteShellChannel>
  testConnect(entry: HostEntry): Promise<number>
  disconnect(alias: string): void
  connected(): string[]
  dispose(): void
}

export interface ToolsDeps {
  hosts: HostTableLike
  pool: PoolLike
  session: Session
  config: {
    commandTimeoutMs: number
    maxOutputChars: number
    /** Shown by rw_info; optional so minimal test configs still typecheck. */
    hostKeyPolicy?: string
  }
  /** Base dir for placeholder dirs (tests inject a tmp dir). */
  placeholderBaseDir?: string
  /** Where native tools actually go, as observed by the shim (plugin-load scope). */
  routing?: NativeRouting
  /** Whether the shim is currently on (a live getter: the settings layer can flip it). */
  shimEnabled?: () => boolean
}

const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', required: true } },
} as const

/** Uniform failure shape for the model: `[CODE] message`. */
function toToolError(err: unknown): Error {
  const e = toRwError(err)
  return new Error(`[${e.code}] ${e.message}`)
}

function unknownAliasError(deps: ToolsDeps, alias: string): RwError {
  const available = deps.hosts.summaries().map((h) => h.alias)
  return new RwError(
    'INVALID_INPUT',
    `unknown host alias: ${JSON.stringify(alias)} — available: ${available.length > 0 ? available.join(', ') : '(none configured)'}`,
  )
}

/**
 * The slice of the tool execution context this module reads. Structural on
 * purpose: the real value is a `ToolRunContext`, and tests drive plain objects.
 */
interface ExecLike {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** The calling agent's session cwd — where the agent is ACTUALLY working. */
function agentCwdOf(exec: ExecLike | undefined): string | undefined {
  const cwd: unknown = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Where this session actually works, resolved from the AGENT CWD first.
 *
 * The session record (`alias` + `workspace`) is only a fallback. If the agent
 * is working inside a dsh-rw placeholder, that placeholder's host and remote
 * root are the truth — the record can be stale, can point at another machine
 * after a reconnect, or can be a leftover from a previous pick. Making the
 * actual workspace win is what keeps `rw_*` and the shimmed native tools from
 * disagreeing about which machine is in play.
 *
 * `broken` means the cwd is placeholder-backed but its host is no longer
 * configured: the caller must fail loudly, never silently use the record.
 */
type WorkspaceTarget =
  | { kind: 'ok'; entry: HostEntry; workspace: string; source: 'cwd' | 'session' }
  /** Connected, but no remote directory picked yet — host tools work, file tools do not. */
  | { kind: 'no-workspace'; entry: HostEntry }
  | { kind: 'broken'; alias: string; workspace: string; dir: string }

function activeWorkspace(deps: ToolsDeps, exec?: ExecLike): WorkspaceTarget | null {
  const cwd = agentCwdOf(exec)
  if (cwd !== undefined) {
    const found = findPlaceholderByPath(cwd, deps.placeholderBaseDir)
    if (found !== null) {
      const entry = deps.hosts.find(found.meta.alias)
      if (entry === undefined) {
        return { kind: 'broken', alias: found.meta.alias, workspace: found.meta.remotePath, dir: found.dir }
      }
      return { kind: 'ok', entry, workspace: found.meta.remotePath, source: 'cwd' }
    }
  }
  const alias = deps.session.alias
  if (alias === null) return null
  const entry = deps.hosts.find(alias)
  if (!entry) return null
  const workspace = deps.session.workspace
  // Connected but unpicked is its own state: rw_exec legitimately runs in the
  // SSH default directory, while every file tool must say NO_WORKSPACE.
  if (workspace === null) return { kind: 'no-workspace', entry }
  return { kind: 'ok', entry, workspace, source: 'session' }
}

/** The host this call must target, or a thrown NOT_CONNECTED / INVALID_INPUT. */
function requireEntry(deps: ToolsDeps, exec?: ExecLike): HostEntry {
  const target = activeWorkspace(deps, exec)
  if (target === null) {
    throw new RwError('NOT_CONNECTED', 'no host connected — call rw_connect(alias) first (rw_hosts lists aliases)')
  }
  if (target.kind === 'broken') {
    throw new RwError(
      'NOT_CONNECTED',
      `this session works in ${target.dir} (host alias '${target.alias}', remote ${target.workspace}) but that ` +
        'host is no longer configured — re-add it (rw_hosts) and rw_connect again',
    )
  }
  return target.entry
}

/** A RemoteFs bound to the ACTUAL workspace, or a thrown NO_WORKSPACE. */
async function requireWorkspaceFs(deps: ToolsDeps, exec?: ExecLike): Promise<RemoteFs> {
  const target = activeWorkspace(deps, exec)
  const entry = requireEntry(deps, exec)
  if (target === null || target.kind === 'broken') {
    // requireEntry already threw for both cases; this keeps the type honest.
    throw new RwError('NO_WORKSPACE', 'no remote workspace picked — call rw_pick_workspace(path) first')
  }
  if (target.kind === 'no-workspace') {
    throw new RwError('NO_WORKSPACE', 'no remote workspace picked — call rw_pick_workspace(path) first')
  }
  const sftp = await deps.pool.sftp(entry)
  return new RemoteFs(sftp, target.workspace)
}

/**
 * Shared pick-workspace validation used by rw_pick_workspace and the
 * /api/dsh-rw/workspace route: resolve symlinks via realpath, require a
 * directory, create the local placeholder. Returns the real workspace path
 * and the placeholder directory. Does not touch the session. `name` (picker
 * only) names a fresh placeholder; the tool flow omits it (basename default).
 */
export async function resolveWorkspaceDir(
  deps: ToolsDeps,
  alias: string,
  path: string,
  name?: string,
): Promise<{ workspace: string; placeholderDir: string }> {
  const entry = deps.hosts.find(alias)
  if (!entry) throw unknownAliasError(deps, alias)
  if (!path.startsWith('/') && path !== '~' && !path.startsWith('~/')) {
    throw new RwError('INVALID_INPUT', `workspace path must be absolute (or ~/…): ${JSON.stringify(path)}`)
  }
  const sftp = await deps.pool.sftp(entry)
  const expanded = await expandRemoteHome(sftp, path)
  let real: string
  try {
    real = normalizeRemote(await sftp.realpath(expanded))
  } catch (err) {
    throw mapSftpError(err, expanded)
  }
  let isDir: boolean
  try {
    isDir = (await sftp.stat(real)).isDirectory()
  } catch (err) {
    throw mapSftpError(err, real)
  }
  if (!isDir) throw new RwError('NOT_A_DIRECTORY', `not a directory: ${real}`)
  const placeholderDir = ensurePlaceholder(alias, entry, real, deps.placeholderBaseDir, name)
  return { workspace: real, placeholderDir }
}

/**
 * Where the native read/write/edit/glob/grep/bash calls actually go, reported
 * from the shim's own observation rather than from the session record. This is
 * the line that makes a disagreement between the two tool families visible: a
 * recorded remote workspace is not evidence that native calls are reaching it.
 */
function nativeRoutingLine(deps: ToolsDeps, placeholderDir: string | null): string {
  if (deps.shimEnabled !== undefined && !deps.shimEnabled()) {
    return (
      'Native tools: shim off — read/write/edit/str_replace_editor/glob/grep/bash stay on the local machine; ' +
      'use rw_* for the remote'
    )
  }
  const routing = deps.routing
  const where = routing?.placeholder ?? placeholderDir ?? 'the placeholder directory'
  if (routing?.mode === 'remote') {
    if (routing.reason === 'path') {
      return (
        `Native tools: remote (by path) — the last translated call named a path inside ${where}, which works ` +
        "from any working directory; bash and pathless glob/grep still need this session's cwd inside it"
      )
    }
    return `Native tools: remote — this session's cwd is inside ${where}, so native calls are translated to the host`
  }
  if (routing?.mode === 'local') {
    return (
      `Native tools: LOCAL — this call's paths were outside ${where} and this session's cwd ` +
      `(${routing.cwd ?? 'unknown'}) is not inside it, so it ran on the local machine; a call naming a path ` +
      `inside ${where} IS translated, and rw_* always addresses the remote — use rw_* for the remote`
    )
  }
  return (
    'Native tools: not observed yet — translation starts with the first native tool call in this session; ' +
    'rw_* always addresses the remote'
  )
}

/** Sync status lines shared by rw_info and the /rw slash command. */
export function statusText(deps: ToolsDeps, exec?: ExecLike): string {
  const { hosts, pool, session } = deps
  const summaries = hosts.summaries()
  // The ACTUAL workspace wins: when the agent cwd is inside a placeholder, that
  // placeholder's host/root are what every rw_* call will use — the session
  // record is only a fallback and is reported as such.
  const target = activeWorkspace(deps, exec)
  const resolved = target !== null && target.kind === 'ok' ? target : null
  const alias = resolved !== null ? resolved.entry.alias : session.alias
  const entry = resolved !== null ? resolved.entry : alias !== null ? hosts.find(alias) : undefined
  const connected = alias !== null && pool.connected().includes(alias)
  const workspace = resolved !== null ? resolved.workspace : session.workspace
  const lines: string[] = []
  lines.push(`Hosts configured: ${summaries.length}`)
  if (alias !== null && entry) {
    lines.push(`Current host: ${entry.user}@${entry.host}:${entry.port} (alias: ${alias})`)
  } else if (alias !== null) {
    lines.push(`Current host: ${alias} (no longer configured)`)
  } else {
    lines.push('Current host: (none — call rw_connect with an alias from rw_hosts)')
  }
  lines.push(`Connected: ${connected ? 'yes' : 'no'}`)
  const source =
    resolved === null
      ? ''
      : resolved.source === 'cwd'
        ? ' (from this session\'s working directory)'
        : ' (from the plugin session record)'
  lines.push(`Current workspace: ${workspace ?? '(none — call rw_pick_workspace to set one)'}${source}`)
  if (alias !== null && workspace !== null) {
    const placeholderDir = resolvePlaceholderDir(alias, workspace, deps.placeholderBaseDir)
    lines.push(
      placeholderDir !== null
        ? `Placeholder dir (register this as the DSH workspace): ${placeholderDir}`
        : 'Placeholder dir: (none found — call rw_pick_workspace to (re)create it)',
    )
    lines.push(nativeRoutingLine(deps, placeholderDir))
  }
  lines.push(
    `Host key policy: ${deps.config.hostKeyPolicy ?? 'accept-new'} (plugin config hostKeyPolicy; keys verified against known_hosts)`,
  )
  return lines.join('\n')
}

function renderHostsTable(summaries: HostSummary[]): string {
  if (summaries.length === 0) return 'no hosts configured (add one via the dsh-rw settings UI or ~/.ssh/config)'
  const rows = summaries.map((h) =>
    [
      h.alias,
      h.host,
      String(h.port),
      h.user,
      h.authKind,
      h.authKind === 'key' ? (h.keyReady ? 'key-ready' : 'key-missing') : h.passwordSet ? 'password-set' : 'password-missing',
      h.source,
    ].join(' | '),
  )
  return ['alias | host | port | user | auth | credentials | source', '--- | --- | --- | --- | --- | --- | ---', ...rows].join(
    '\n',
  )
}

function formatMtime(mtimeSeconds: number): string {
  return new Date(mtimeSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function renderExecResult(command: string, cwd: string | undefined, res: ExecResult, timeoutMs: number): string {
  const parts: string[] = []
  parts.push(`$ ${command}`)
  parts.push(cwd !== undefined ? `cwd: ${cwd}` : 'cwd: (none — no workspace picked; ran in the SSH default directory)')
  parts.push(res.timedOut ? `[timed out after ${timeoutMs}ms]` : `[exit code: ${res.code ?? 'null'}${res.signal ? `, signal: ${res.signal}` : ''}]`)
  if (res.stdout !== '') parts.push(`stdout:\n${res.stdout.replace(/\s+$/, '')}`)
  if (res.stderr !== '') parts.push(`stderr:\n${res.stderr.replace(/\s+$/, '')}`)
  return parts.join('\n')
}

/** One rw_exec_many call: a remote shell command on one host. */
interface ExecManyCall {
  alias: string
  command: string
  cwd?: string
  timeoutMs?: number
}

/** One rw_exec_many outcome, in input order. */
interface ExecManyResult extends ExecManyCall {
  ok: boolean
  code: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** Set when the call never reached the host (connect/channel failure). */
  error?: string
}

/** Hard ceiling on one fan-out: enough for a fleet, small enough to bound output. */
const EXEC_MANY_MAX_CALLS = 32
const EXEC_MANY_MAX_CONCURRENCY = 16
const EXEC_MANY_DEFAULT_CONCURRENCY = 4

/**
 * Run `fn` over `items` with a fixed number of workers, preserving input order.
 * One worker failing cannot cancel the others — the caller records per-item
 * errors, which is the whole point of a fan-out.
 */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return out
}

/** Render one rw_exec_many outcome as its own section; bodies are already capped. */
function renderExecManyResult(result: ExecManyResult, index: number): string {
  const head =
    `--- [${index + 1}] ${result.alias}` +
    (result.error !== undefined
      ? ' (not reached)'
      : result.timedOut
        ? ' (timed out)'
        : ` (exit ${result.code ?? 'null'}${result.signal ? `, signal: ${result.signal}` : ''})`) +
    ' ---'
  const parts = [head, `$ ${result.command}`]
  parts.push(result.cwd !== undefined ? `cwd: ${result.cwd}` : 'cwd: (SSH default directory)')
  if (result.error !== undefined) parts.push(`error: ${result.error}`)
  if (result.stdout !== '') parts.push(`stdout:\n${result.stdout.replace(/\s+$/, '')}`)
  if (result.stderr !== '') parts.push(`stderr:\n${result.stderr.replace(/\s+$/, '')}`)
  return parts.join('\n')
}

/**
 * Read a workspace file as raw utf-8 text with its trailing newline preserved.
 * RemoteFs.read() returns joined LINES (the terminator is dropped), which would
 * make every rw_diff show a phantom "no newline at end of file" change.
 */
async function readWorkspaceText(fs: RemoteFs, path: string): Promise<string> {
  const p = resolveInWorkspace(fs.root, path)
  const real = await assertRealpathInside(fs.sftp, fs.root, p)
  let buf: Buffer
  try {
    buf = await fs.sftp.readFile(real)
  } catch (err) {
    throw mapSftpError(err, p)
  }
  if (buf.length > 2 * 1024 * 1024) throw new RwError('INVALID_INPUT', `file too large to diff: ${p}`)
  return buf.toString('utf8')
}

/** Adapt the SFTP listing to the watcher's single-method interface. */
function watchFsOf(sftp: SftpLike): WatchFs {
  return {
    async readdir(path: string) {
      const entries = await sftp.readdir(path)
      return entries.map((entry) => {
        const kind: 'file' | 'dir' | 'other' = entry.attrs.isDirectory()
          ? 'dir'
          : entry.attrs.isSymbolicLink()
            ? 'other'
            : 'file'
        return { name: entry.filename, kind, size: entry.attrs.size, mtimeMs: entry.attrs.mtime * 1000 }
      })
    },
  }
}

/** Render one watcher snapshot: what changed and whether the scan was complete. */
function renderWatchSnapshot(action: 'start' | 'poll', name: string, snapshot: WatchSnapshotResult): string {
  const head =
    action === 'start'
      ? `watching '${name}': baseline of ${snapshot.entries} entries` +
        (snapshot.truncated ? ' (truncated: maxEntries/maxDepth reached)' : '')
      : `watcher '${name}': ${snapshot.changes.length} change(s), ${snapshot.entries} entries scanned` +
        (snapshot.truncated ? ' (truncated: maxEntries/maxDepth reached)' : '')
  if (action === 'start' || snapshot.changes.length === 0) return `${head}\n(no changes to report)`
  const lines = snapshot.changes.map((change) =>
    change.kind === 'removed'
      ? `  removed  ${change.path}`
      : `  ${change.kind === 'added' ? 'added   ' : 'changed '}${change.path} (${change.size ?? 0} B)`,
  )
  return [head, ...lines].join('\n')
}

/** The fixed number of rw_* tools, exported so the registration-order tests track it. */
export const RW_TOOL_COUNT = 16

/** The twelve rw_* tools in their fixed registration order. */
export function makeTools(deps: ToolsDeps): unknown[] {
  const { hosts, pool, session, config } = deps
  const text = (value: { text: string }): { type: 'text'; text: string }[] => [{ type: 'text', text: value.text }]
  // One watcher registry per plugin instance. It holds no timers and no remote
  // state, so plugin teardown simply drops it with the rest of this closure.
  const managers = new WatchManager()

  return [
    // ------------------------------------------------------------- rw_info
    defineTool({
      name: 'rw_info',
      description:
        'Show the dsh-rw remote-workspace state: configured SSH host count, current host (user@host:port), ' +
        'connection health, current remote workspace, its local placeholder directory, where the native ' +
        'read/write/bash tools actually run right now, and the host-key policy. ' +
        'Call this first to orient, or when an rw_* call fails to check connectivity. ' +
        'Triggers: remote workspace, SSH host, server status, where am I working, are my tools remote.',
      parameters: {},
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(_args, exec) {
        try {
          return { text: statusText(deps, exec) }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ------------------------------------------------------------ rw_hosts
    defineTool({
      name: 'rw_hosts',
      description:
        'List the configured SSH hosts (from ~/.ssh/config plus manually added ones) with alias, host, port, user, ' +
        'auth kind and credential readiness — never the credentials themselves. Use the alias with rw_connect. ' +
        'Triggers: list servers/hosts, which machines can I reach, SSH config.',
      parameters: {},
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(_args, exec) {
        try {
          return { text: renderHostsTable(hosts.summaries()) }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ---------------------------------------------------------- rw_connect
    defineTool({
      name: 'rw_connect',
      description:
        'Connect (probe) one configured SSH host by alias and make it the current dsh-rw host. Verifies ' +
        'connectivity/authentication and the host key before succeeding. Afterwards call rw_pick_workspace to ' +
        'choose the remote directory. Triggers: connect to server, log in to host, use machine X.',
      parameters: {
        alias: { type: 'string', required: true, description: 'Host alias from rw_hosts.' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const entry = hosts.find(args.alias)
          if (!entry) throw unknownAliasError(deps, args.alias)
          const latencyMs = await pool.testConnect(entry)
          // A workspace is only meaningful on the host it was picked on:
          // keep it when reconnecting the same alias, clear it when switching.
          session.set({ alias: entry.alias, workspace: session.alias === entry.alias ? session.workspace : null })
          return {
            text:
              `Connected to ${entry.user}@${entry.host}:${entry.port} (alias: ${entry.alias}) in ${latencyMs}ms.\n` +
              'Next: rw_pick_workspace(path) to choose the remote workspace directory.',
          }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // --------------------------------------------------- rw_pick_workspace
    defineTool({
      name: 'rw_pick_workspace',
      description:
        'Pick the remote directory that becomes this session’s workspace root on the connected host. The path is ' +
        'canonicalized (symlinks resolved) and must be an existing directory. Afterwards all rw_* file tools are ' +
        'confined to this workspace root, and a local placeholder directory is created that the DSH UI registers ' +
        'as the workspace (it never holds a copy of remote files). ' +
        'Triggers: open remote folder, set workspace/project directory, work in /path on the server.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path, e.g. /home/dev/project.' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const alias = session.alias
          if (alias === null) {
            throw new RwError('NOT_CONNECTED', 'no host connected — call rw_connect(alias) first')
          }
          const { workspace, placeholderDir } = await resolveWorkspaceDir(deps, alias, args.path)
          session.set({ workspace })
          return {
            text:
              `Remote workspace set to ${workspace} on ${alias}.\n` +
              `Local placeholder directory: ${placeholderDir}\n` +
              '(The DSH workspace points at this empty placeholder; the remote filesystem stays the source of truth. ' +
              'All rw_* file paths are confined to the workspace root.)',
          }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ---------------------------------------------------------- rw_list_dir
    defineTool({
      name: 'rw_list_dir',
      description:
        'List a directory on the connected remote host (default: the workspace root). Paths are confined to the ' +
        'current remote workspace; relative paths resolve against it. Returns name/type/size/mtime rows. ' +
        'Triggers: ls, show files, explore the remote project.',
      parameters: {
        path: { type: 'string', description: 'Directory path (absolute, or relative to the workspace root; default: the root).' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const fs = await requireWorkspaceFs(deps, exec)
          const entries = await fs.list(args.path)
          if (entries.length === 0) return { text: `(empty directory: ${args.path ?? fs.root})` }
          const rows = entries.map((e) => [e.type, String(e.size), formatMtime(e.mtime), e.name].join(' | '))
          return { text: ['type | size | modified | name', '--- | --- | --- | ---', ...rows].join('\n') }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // --------------------------------------------------------- rw_read_file
    defineTool({
      name: 'rw_read_file',
      description:
        'Read a text file on the connected remote host with 1-based line numbers. Supports paging via startLine ' +
        'and maxLines. Paths are confined to the current remote workspace; relative paths resolve against it. ' +
        'Triggers: cat, view/show file, inspect remote config or source.',
      parameters: {
        path: { type: 'string', required: true, description: 'File path (absolute, or relative to the workspace root).' },
        startLine: { type: 'integer', description: '1-based first line to return (default 1).' },
        maxLines: { type: 'integer', description: 'Max lines to return (default 2000, cap 10000).' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const fs = await requireWorkspaceFs(deps, exec)
          const res = await fs.read(args.path, {
            startLine: args.startLine,
            maxLines: args.maxLines,
            maxBytes: config.maxOutputChars,
          })
          const lines = res.content === '' ? [] : res.content.split('\n')
          const numbered = lines.map((l, i) => `${String(res.startLine + i).padStart(6)}\t${l}`).join('\n')
          const header = `${args.path} — lines ${res.startLine}-${res.endLine} of ${res.totalLines}${res.truncated ? ' (file exceeded the byte cap; content truncated)' : ''}`
          const hints: string[] = []
          if (res.endLine < res.totalLines) hints.push(`use startLine: ${res.endLine + 1} to continue paging`)
          return { text: numbered === '' ? `${header}\n(empty or out of range)` : `${header}\n${numbered}${hints.length > 0 ? `\n(${hints.join('; ')})` : ''}` }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // -------------------------------------------------------- rw_write_file
    defineTool({
      name: 'rw_write_file',
      description:
        'Write (create or overwrite) a text file on the connected remote host, creating missing parent directories ' +
        'by default. Paths are confined to the current remote workspace; relative paths resolve against it. The ' +
        'write happens on the remote host directly — there is no local copy. ' +
        'Triggers: create/edit/save file on the server, write remote config.',
      parameters: {
        path: { type: 'string', required: true, description: 'File path (absolute, or relative to the workspace root).' },
        content: { type: 'string', required: true, description: 'Full file content (overwrites any existing file).' },
        mkdir: { type: 'boolean', description: 'Create missing parent directories (default true).' },
        ifHash: {
          type: 'string',
          description:
            'Optimistic concurrency: write only if the current remote content hashes to this sha256 (hex), ' +
            'or pass "absent" to only create a file that does not exist yet. A mismatch fails with RW_WRITE_CONFLICT.',
        },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const fs = await requireWorkspaceFs(deps, exec)
          if (args.ifHash !== undefined) {
            // Read the raw bytes: the guard is about content identity, so the
            // trailing newline must be part of the hash.
            let current: Buffer | null = null
            try {
              current = await fs.sftp.readFile(resolveInWorkspace(fs.root, args.path))
            } catch (err) {
              // A missing file is the "absent" case, everything else is a real failure.
              if (!(err instanceof Error && /no such file/i.test(err.message))) throw mapSftpError(err, args.path)
            }
            const expected = args.ifHash
            const actual = current === null ? 'absent' : createHash('sha256').update(current).digest('hex')
            if (expected !== actual) {
              throw new RwError(
                'RW_WRITE_CONFLICT',
                `refusing to write ${args.path}: expected ${JSON.stringify(expected)} but the remote is ${JSON.stringify(actual)}`,
              )
            }
          }
          const { bytes } = await fs.write(args.path, args.content, { mkdir: args.mkdir })
          return { text: `wrote ${bytes} bytes to ${args.path}` }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ------------------------------------------------------------- rw_mkdir
    defineTool({
      name: 'rw_mkdir',
      description:
        'Create a directory (recursively, like mkdir -p) on the connected remote host. Paths are confined to the ' +
        'current remote workspace; relative paths resolve against it. Triggers: create folder/directory on the server.',
      parameters: {
        path: { type: 'string', required: true, description: 'Directory path (absolute, or relative to the workspace root).' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const fs = await requireWorkspaceFs(deps, exec)
          await fs.mkdir(args.path)
          return { text: `created directory ${args.path}` }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ------------------------------------------------------------- rw_move
    defineTool({
      name: 'rw_move',
      description:
        'Move/rename a file or directory on the connected remote host. Both paths are confined to the current ' +
        'remote workspace. An existing destination is rejected unless overwrite is true. ' +
        'Triggers: rename/move remote file, reorganize the remote project.',
      parameters: {
        src: { type: 'string', required: true, description: 'Source path (absolute, or relative to the workspace root).' },
        dst: { type: 'string', required: true, description: 'Destination path (absolute, or relative to the workspace root).' },
        overwrite: { type: 'boolean', description: 'Replace an existing destination (default false).' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const fs = await requireWorkspaceFs(deps, exec)
          await fs.move(args.src, args.dst, { overwrite: args.overwrite })
          return { text: `moved ${args.src} -> ${args.dst}` }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ----------------------------------------------------------- rw_delete
    defineTool({
      name: 'rw_delete',
      description:
        'Delete a file, symlink, or directory on the connected remote host. WARNING: this is a real, irreversible ' +
        'remote deletion — there is no trash and no local copy to restore from. Directories require recursive: ' +
        'true. Paths are confined to the current remote workspace. Triggers: remove/delete remote file or folder.',
      parameters: {
        path: { type: 'string', required: true, description: 'Path to delete (absolute, or relative to the workspace root).' },
        recursive: { type: 'boolean', description: 'Required to delete a directory: deletes its children first (default false).' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const fs = await requireWorkspaceFs(deps, exec)
          await fs.delete(args.path, { recursive: args.recursive })
          return { text: `deleted ${args.path}` }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ------------------------------------------------------------- rw_exec
    defineTool({
      name: 'rw_exec',
      description:
        'Run a shell command on the connected remote host — builds, tests, git, grep, package installs. When a ' +
        'workspace is picked the command runs with the workspace root as cwd; otherwise it runs in the SSH default ' +
        'directory (the command itself is NOT workspace-confined — only rw_* file paths are). Output is capped. ' +
        'Triggers: run command/script on the server, build, test, deploy, tail logs.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command to run on the remote host.' },
        timeoutMs: { type: 'integer', description: `Timeout in milliseconds (default ${config.commandTimeoutMs}).` },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          if (args.command.trim() === '') throw new RwError('INVALID_INPUT', 'command must not be empty')
          const entry = requireEntry(deps, exec)
          const cwd = session.workspace ?? undefined
          const timeoutMs = args.timeoutMs ?? config.commandTimeoutMs
          const res = await pool.exec(entry, args.command, { cwd, timeoutMs })
          return { text: renderExecResult(args.command, cwd, res, timeoutMs) }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ------------------------------------------------------ rw_exec_many
    defineTool({
      name: 'rw_exec_many',
      description:
        'Run shell commands on several hosts in one call, in parallel (bounded concurrency), and get one result ' +
        'section per call in input order — the fan-out primitive for "do the same thing on every machine". Give ' +
        'either `calls` (independent command per host) or `command` + `hosts` (one command across hosts). A ' +
        'failure or timeout in one call never cancels the others; each section reports its own exit code. ' +
        'Like rw_exec, commands are NOT workspace-confined; cwd defaults to the current host workspace, else the ' +
        'SSH default directory. Triggers: run on all servers, upgrade every host, fleet-wide check.',
      parameters: {
        calls: {
          type: 'array',
          description: 'Independent calls, one per entry. Mutually exclusive with command + hosts.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              alias: { type: 'string', description: 'Host alias from rw_hosts (default: the current host).' },
              command: { type: 'string', required: true, description: 'Shell command to run on that host.' },
              cwd: { type: 'string', description: 'Remote working directory for this call.' },
              timeoutMs: { type: 'integer', description: `Timeout in milliseconds (default ${config.commandTimeoutMs}).` },
            },
          },
        },
        command: { type: 'string', description: 'One command to run on every alias in `hosts`.' },
        hosts: {
          type: 'array',
          description: 'Host aliases to fan `command` out to.',
          items: { type: 'string' },
        },
        concurrency: {
          type: 'integer',
          description: `Max parallel calls (default ${EXEC_MANY_DEFAULT_CONCURRENCY}, ceiling ${EXEC_MANY_MAX_CONCURRENCY}).`,
        },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const callsArg = args.calls
          const hasCalls = callsArg !== undefined
          const hasFanout = args.command !== undefined || args.hosts !== undefined
          if (hasCalls && hasFanout) {
            throw new RwError('INVALID_INPUT', 'give either `calls` or `command` + `hosts`, not both')
          }
          let calls: ExecManyCall[]
          if (callsArg !== undefined) {
            if (callsArg.length === 0) throw new RwError('INVALID_INPUT', 'calls must not be empty')
            calls = callsArg.map((call, index) => {
              const alias = call.alias ?? session.alias
              if (alias === null) {
                throw new RwError(
                  'NOT_CONNECTED',
                  `calls[${index}] has no alias and no host is connected — call rw_connect(alias) or name the alias`,
                )
              }
              if (call.command.trim() === '') {
                throw new RwError('INVALID_INPUT', `calls[${index}].command must not be empty`)
              }
              return {
                alias,
                command: call.command,
                ...(call.cwd !== undefined ? { cwd: call.cwd } : {}),
                ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
              }
            })
          } else if (args.command !== undefined && args.hosts !== undefined) {
            if (args.command.trim() === '') throw new RwError('INVALID_INPUT', 'command must not be empty')
            if (args.hosts.length === 0) throw new RwError('INVALID_INPUT', 'hosts must not be empty')
            calls = args.hosts.map((alias) => ({ alias, command: args.command! }))
          } else {
            throw new RwError('INVALID_INPUT', 'give `calls`, or `command` + `hosts`')
          }
          if (calls.length > EXEC_MANY_MAX_CALLS) {
            throw new RwError('INVALID_INPUT', `at most ${EXEC_MANY_MAX_CALLS} calls per fan-out (got ${calls.length})`)
          }
          // Resolve every alias up front: a typo fails the whole call before any
          // remote side effect runs, which is safer than a partial fan-out.
          const entries = calls.map((call) => {
            const entry = hosts.find(call.alias)
            if (!entry) throw unknownAliasError(deps, call.alias)
            return entry
          })
          const concurrency = Math.min(
            EXEC_MANY_MAX_CONCURRENCY,
            Math.max(1, args.concurrency ?? EXEC_MANY_DEFAULT_CONCURRENCY),
          )
          const results = await mapBounded(calls, concurrency, async (call, index) => {
            const entry = entries[index]!
            // Same rule as rw_exec: the workspace cwd only applies to the host
            // that owns it; every other host starts in its SSH default dir
            // unless the call names one.
            const cwd = call.cwd ?? (call.alias === session.alias ? (session.workspace ?? undefined) : undefined)
            const timeoutMs = call.timeoutMs ?? config.commandTimeoutMs
            const base: ExecManyCall = { ...call, ...(cwd !== undefined ? { cwd } : {}) }
            try {
              const res = await pool.exec(entry, call.command, cwd !== undefined ? { cwd, timeoutMs } : { timeoutMs })
              return {
                ...base,
                ok: !res.timedOut && res.code === 0,
                code: res.code,
                signal: res.signal,
                timedOut: res.timedOut,
                stdout: res.stdout,
                stderr: res.stderr,
              }
            } catch (err) {
              // One unreachable host must not void the rest of the fan-out.
              return {
                ...base,
                ok: false,
                code: null,
                signal: null,
                timedOut: false,
                stdout: '',
                stderr: '',
                error: err instanceof Error ? err.message : String(err),
              }
            }
          })
          const okCount = results.reduce((n, r) => n + (r.ok ? 1 : 0), 0)
          const header = `rw_exec_many: ${okCount}/${results.length} succeeded (concurrency ${concurrency})`
          return { text: [header, ...results.map(renderExecManyResult)].join('\n\n') }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ---------------------------------------------------------- rw_watch
    defineTool({
      name: 'rw_watch',
      description:
        'Watch a remote directory for changes by polling it on demand. `start` establishes a baseline (optional ' +
        'path relative to the workspace root, and an include glob), `poll` reports what was added, changed ' +
        '(size or mtime) or removed since the previous snapshot, `stop` drops a watcher, `list` shows them. ' +
        'Nothing runs on the remote between polls — the snapshot lives in this plugin process — so one poll ' +
        'costs one recursive SFTP listing. Triggers: watch files, detect remote changes, what changed on the ' +
        'server.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['start', 'poll', 'stop', 'list'],
          description: 'start a watcher, poll it, stop it, or list the registered watchers.',
        },
        name: { type: 'string', description: 'Watcher name (default "default").' },
        path: { type: 'string', description: 'Directory to watch, relative to the workspace root (default: the root).' },
        include: {
          type: 'string',
          description: 'One glob filter: "*.ts" matches a basename at any depth, "src/**" matches the relative path.',
        },
        maxEntries: { type: 'integer', description: 'Cap on tracked entries (default 20000).' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const name = args.name ?? 'default'
          if (args.action === 'list') {
            const watchers = managers.list()
            return {
              text:
                watchers.length === 0
                  ? 'no watchers registered'
                  : watchers
                      .map(
                        (watcher) =>
                          `${watcher.name}: ${watcher.root}` +
                          (watcher.include !== undefined ? ` (include ${watcher.include})` : ''),
                      )
                      .join('\n'),
            }
          }
          if (args.action === 'stop') {
            return { text: managers.stop(name) ? `stopped watcher '${name}'` : `no watcher named '${name}'` }
          }
          const fs = await requireWorkspaceFs(deps, exec)
          if (args.action === 'start') {
            const root = resolveInWorkspace(fs.root, args.path)
            const real = await assertRealpathInside(fs.sftp, fs.root, root)
            const snapshot = await managers.start(name, watchFsOf(fs.sftp), {
              root: real,
              ...(args.include !== undefined ? { include: args.include } : {}),
              ...(args.maxEntries !== undefined ? { maxEntries: args.maxEntries } : {}),
            })
            return { text: renderWatchSnapshot('start', name, snapshot) }
          }
          if (!managers.list().some((watcher) => watcher.name === name)) {
            throw new RwError('INVALID_INPUT', `no watcher named ${JSON.stringify(name)} — start one first`)
          }
          return { text: renderWatchSnapshot('poll', name, await managers.poll(name)) }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ----------------------------------------------------------- rw_diff
    defineTool({
      name: 'rw_diff',
      description:
        'Show a unified diff for one remote file: compare it against a text you supply (`content`, the after ' +
        'side) or against another remote file (`against`). Read-only — nothing is written. Binary files are ' +
        'rejected rather than diffed as mojibake. Triggers: diff a file, what changed, compare with the server.',
      parameters: {
        path: { type: 'string', required: true, description: 'File to diff (absolute, or relative to the workspace root).' },
        content: { type: 'string', description: 'Compare the file against this text (the "after" side).' },
        against: { type: 'string', description: 'Compare the file against this other remote file (the "after" side).' },
        context: { type: 'integer', description: 'Context lines per hunk (default 3).' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          const hasContent = args.content !== undefined
          const hasAgainst = args.against !== undefined
          if (hasContent === hasAgainst) {
            throw new RwError('INVALID_INPUT', 'give exactly one of `content` or `against` as the after side')
          }
          const fs = await requireWorkspaceFs(deps, exec)
          const before = await readWorkspaceText(fs, args.path)
          const after = hasContent ? (args.content ?? '') : await readWorkspaceText(fs, args.against!)
          if (looksBinary(before) || looksBinary(after)) {
            throw new RwError('INVALID_INPUT', 'binary file — rw_diff only diffs text')
          }
          const context = args.context ?? 3
          if (!Number.isInteger(context) || context < 0) throw new RwError('INVALID_INPUT', 'context must be an integer >= 0')
          const diff = unifiedDiff(args.path, before, after, context)
          if (diff === '') return { text: `no differences in ${args.path}` }
          const cap = config.maxOutputChars
          return { text: diff.length > cap ? `${diff.slice(0, cap)}\n…[truncated]` : diff }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ----------------------------------------------------- rw_apply_patch
    defineTool({
      name: 'rw_apply_patch',
      description:
        'Apply a unified diff inside the remote workspace. Every path the patch would touch is validated ' +
        'against the workspace root FIRST (a patch can never escape it), then the patch is staged on the host ' +
        'and run with `patch -pN` — with `--dry-run` first, so a mismatch changes nothing. Use `dryRun: true` ' +
        'to only check. Triggers: apply patch, apply diff, land a git patch on the server.',
      parameters: {
        patch: {
          type: 'string',
          required: true,
          description: 'Unified diff text (as produced by diff -u / git diff).',
        },
        strip: { type: 'integer', description: 'Strip N leading path components (default 1, like patch -p1).' },
        dryRun: { type: 'boolean', description: 'Only check that the patch applies (default false).' },
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args, exec) {
        try {
          if (args.patch.trim() === '') throw new RwError('INVALID_INPUT', 'patch must not be empty')
          const strip = args.strip ?? 1
          if (!Number.isInteger(strip) || strip < 0) throw new RwError('INVALID_INPUT', 'strip must be an integer >= 0')
          const fs = await requireWorkspaceFs(deps, exec)
          // Confinement is decided here, before anything runs on the host.
          let targets: string[]
          try {
            targets = patchTargets(args.patch, fs.root, strip)
          } catch (err) {
            // PathEscapeError / PatchFormatError are validation failures, not
            // internal errors: report them as actionable input problems.
            throw new RwError('INVALID_INPUT', err instanceof Error ? err.message : String(err))
          }
          const entry = requireEntry(deps, exec)
          const staged = `${fs.root}/.dsh-rw-patch-${randomBytes(6).toString('hex')}`
          await fs.sftp.writeFile(staged, Buffer.from(args.patch, 'utf8'))
          const runPatch = async (dryRun: boolean): Promise<ExecResult> =>
            await deps.pool.exec(entry, `patch -p${strip}${dryRun ? ' --dry-run' : ''} -i ${shq(staged)}`, {
              cwd: fs.root,
              timeoutMs: config.commandTimeoutMs,
            })
          try {
            const dry = await runPatch(true)
            if (dry.code !== 0) {
              throw new RwError(
                'INVALID_INPUT',
                `patch does not apply cleanly (patch -p${strip} --dry-run exited ${dry.code ?? 'null'}): ${(dry.stderr || dry.stdout).trim()}`,
              )
            }
            if (args.dryRun === true) {
              return { text: `patch applies cleanly to ${targets.length} file(s):\n${targets.map((t) => `  ${t}`).join('\n')}` }
            }
            const applied = await runPatch(false)
            if (applied.code !== 0) {
              throw new RwError(
                'INVALID_INPUT',
                `patch failed while applying (exit ${applied.code ?? 'null'}): ${(applied.stderr || applied.stdout).trim()}`,
              )
            }
            const body = (applied.stdout || applied.stderr).trim()
            return {
              text:
                `applied patch to ${targets.length} file(s):\n${targets.map((t) => `  ${t}`).join('\n')}` +
                (body === '' ? '' : `\n\n${body}`),
            }
          } finally {
            // The staged file is an implementation detail, never a workspace artifact.
            await fs.sftp.unlink(staged).catch(() => undefined)
          }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),

    // ------------------------------------------------------- rw_disconnect
    defineTool({
      name: 'rw_disconnect',
      description:
        'Close the SSH connection to the current host and clear the current-host session state (the workspace ' +
        'record is kept and re-applies when the same alias is connected again). Triggers: disconnect, drop the ' +
        'SSH session, switch servers.',
      parameters: {},
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(_args, exec) {
        try {
          const alias = session.alias
          if (alias === null) return { text: 'not connected — nothing to disconnect' }
          pool.disconnect(alias)
          session.set({ alias: null })
          return { text: `disconnected from ${alias}` }
        } catch (err) {
          throw toToolError(err)
        }
      },
    }),
  ]
}
