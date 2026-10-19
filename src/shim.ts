// dsh-rw — shim mode: run DSH's NATIVE tools against the remote workspace.
//
// With `shim: true` and an active remote session, two cordis middlewares
// translate native read / write / edit / str_replace_editor / glob / grep /
// bash calls on the `tools/execute` waterfall into SFTP/exec operations on the
// remote host, so the agent can ignore rw_* and work as if the workspace were
// local. The placeholder directory is the only path space the agent ever
// sees: argument paths map placeholder → remote on the way in, and every path
// in results (and in composed error messages) maps back remote → placeholder.
// A call whose path — or, for bash, whose session cwd — falls outside the
// placeholder passes through via next() unchanged; with shim off every call
// passes through, so the default behavior is identical to v0.1.
//
// Approvals: shimmed bash calls escalate on the `tools/pre-execute` waterfall
// with { kind: 'ask', reason } (the DSH approval dialog, reason naming the
// remote host alias) when shimBashApproval is 'ask'; fs tools never escalate
// — the workspace guard confines them. bash flavor: dsh-tool-bash and
// dsh-tool-bash-persistent BOTH register a tool named "bash"; they are told
// apart by their parameter schema (only the one-shot schema declares
// workdir/timeoutMs/description). A persistent call runs as a one-shot remote
// exec and the result says shell state is not preserved.
import { realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type {
  PreToolDecision,
  ToolDispatchExecution,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import { mapSftpError, RwError } from './errors.js'
import { assertRealpathInside, normalizeRemote, resolveInWorkspace, shq } from './guard.js'
import { findPlaceholderByPath, resolvePlaceholderDir } from './placeholder.js'
import type { PlaceholderMeta } from './placeholder.js'
import { RemoteFs } from './remote-fs.js'
import type { Session } from './session.js'
import type { HostEntry } from './hosts.js'
import type { ExecResult, SftpLike } from './ssh-pool.js'
import type { ShellManagerLike } from './persistent-shell.js'
import { startRemoteJob } from './jobs.js'
import type { JobsRegistryLike, RemoteJobDeps } from './jobs.js'
import type { HostTableLike, PoolLike } from './tools.js'

/** Canonical success value, derived from the public execution result contract. */
type CanonicalToolValue = Extract<ToolExecutionResult, { isError: false }>['value']

/** The shim configuration after apply() normalization (schema defaults applied). */
export interface ShimConfig {
  shim: boolean
  shimBash: boolean
  shimBashApproval: 'ask' | 'native'
  commandTimeoutMs: number
  maxOutputChars: number
  /** Run the persistent-bash flavor on a long-lived remote shell (default true). */
  persistentShell?: boolean
  /** Run native background bash calls as remote jobs (default true). */
  backgroundJobs?: boolean
}

/**
 * Where the native read/write/edit/str_replace_editor/glob/grep/bash tools
 * actually go in the CURRENT agent session. This is an OBSERVATION the shim
 * updates on every dispatch, never an inference from the rw_* session record:
 * a recorded remote workspace does not by itself tell anyone whether the
 * agent's working directory lives inside its placeholder (translated) or on a
 * real local directory (pass-through). The prompt section and rw_info report
 * this record so a session cannot be told its native tools are remote while
 * they are quietly running on the local machine.
 */
export interface NativeRouting {
  /** 'unknown' until the first shimmed call of this plugin load is observed. */
  mode: 'unknown' | 'remote' | 'local'
  /** The agent cwd the observation was made at (in `local` mode: the offending directory). */
  cwd?: string
  /** The remote workspace active when the observation was made. */
  alias?: string
  workspace?: string
  /** Placeholder directory the translated call was rooted at. */
  placeholder?: string
  /**
   * How the last translated call was anchored: its own path argument
   * (`'path'` — works from any working directory) or the agent session cwd
   * (`'cwd'` — the pre-1.0 rule). Absent in `local`/`unknown` mode.
   */
  reason?: 'cwd' | 'path'
}

/** A fresh, unobserved routing record (one per plugin load). */
export function createNativeRouting(): NativeRouting {
  return { mode: 'unknown' }
}

export interface ShimDeps {
  hosts: HostTableLike
  pool: PoolLike
  session: Session
  config: ShimConfig
  /** Base dir for placeholder dirs (tests inject a tmp dir). */
  placeholderBaseDir?: string
  /** Observation record shared with the prompt section and rw_info. */
  routing?: NativeRouting
  /**
   * Resolve the caller-visible tool definition (ctx.tools.get in production).
   * Only used for the bash flavor check; undefined → bash is treated as
   * one-shot.
   */
  getTool?(name: string, agent: unknown): { parameters?: unknown } | undefined
  /**
   * The calling session's effective approval policy (ctx.approval's
   * effectivePolicy in production). When it reports 'never' (e.g. the
   * danger-full-access preset), an 'ask' escalation would be auto-rejected
   * without a dialog — the pre-execute gate then stands down and lets the
   * call run, matching that preset's "don't ask me" contract. Undefined
   * (no approval service) keeps the plain 'ask' behavior.
   */
  approvalPolicyOf?(session: unknown): string | undefined
  /**
   * The persistent-shell manager (index.ts wires it to the pool). Undefined
   * keeps the pre-1.0 behavior: the persistent-bash flavor degrades to a
   * one-shot exec and the result says so.
   */
  shells?: ShellManagerLike
  /**
   * The host job registry (`ctx.jobs`). A remote background bash call is
   * registered here so the model collects it with the SAME job_output /
   * job_kill tools as a local job. Absent → such a call is REFUSED rather than
   * passed through, because passing it through runs it on the local machine.
   */
  jobs?: JobsRegistryLike
  /** Poll cadence for a remote job's log (default 500 ms). */
  jobPollMs?: number
  /** Remote directory holding job logs (default /tmp). */
  jobDir?: string
}

/** The two middlewares apply() wires onto the tool pipeline. */
export interface Shim {
  onExecute(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
  onPreExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
}

// Native-tool caps mirrored from the DSH tool plugins so shimmed results read
// like local ones: dsh-tool-fs readLimit/readMaxBytes/readMaxLineLength and
// dsh-tool-fs-search globMaxResults/grepMaxMatches.
const READ_LIMIT = 2000
const READ_MAX_BYTES = 50 * 1024
const READ_MAX_LINE_LENGTH = 2000
const GLOB_MAX_RESULTS = 100
const GREP_MAX_MATCHES = 250

// --- result envelopes ---------------------------------------------------------

function ok(text: string): ToolExecutionResult {
  return { isError: false, value: text, content: [{ type: 'text', text }] }
}

/**
 * Success envelope with a structured value. The registry validates `value`
 * against the native tool's declared output schema (additionalProperties:
 * false), so it must carry exactly the native fields; the rendered text stays
 * the model-facing content.
 */
function okValue(value: CanonicalToolValue, text: string): ToolExecutionResult {
  return { isError: false, value, content: [{ type: 'text', text }] }
}

/** Mirror of the registry's error envelope: `Error: message` text plus the structured failure. */
function fail(message: string, info?: { name: string; code: string }): ToolExecutionResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, ...(info !== undefined ? { info } : {}) },
  }
}

/** Native-vocabulary error (message + code) for edit/editor fidelity with dsh-tool-fs. */
class FsStyleError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'FsError'
  }
}

/** Run one intercepted call: RwError and FsStyleError keep their codes, anything else is a plain failure. */
async function guarded(fn: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RwError) return fail(`[${err.code}] ${err.message}`, { name: 'RwError', code: err.code })
    if (err instanceof FsStyleError) return fail(err.message, { name: 'FsError', code: err.code })
    return fail(err instanceof Error ? err.message : String(err))
  }
}

// --- active target and the placeholder ↔ remote path bridge -------------------

interface ActiveTarget {
  entry: HostEntry
  /** Normalized remote workspace root. */
  remoteRoot: string
  /** Placeholder directory in display form (results are rendered against it). */
  localRoot: string
  /** Containment forms of the placeholder: resolved, plus realpath (macOS /var ↔ /private/var). */
  localRoots: string[]
}

/** The placeholder's local root forms (lexical + realpath), as insideLocal expects them. */
function localRootsOf(localRoot: string): string[] {
  const roots = [resolve(localRoot)]
  try {
    const real = realpathSync(localRoot)
    if (!roots.includes(real)) roots.push(real)
  } catch {
    // placeholder missing on disk: lexical containment still applies
  }
  return roots
}

/** Build an ActiveTarget from a resolved host entry, remote root, and placeholder dir. */
function buildTarget(entry: HostEntry, remotePath: string, localRoot: string): ActiveTarget {
  return { entry, remoteRoot: normalizeRemote(remotePath), localRoot, localRoots: localRootsOf(localRoot) }
}

/**
 * The live target for native tools. The agent's session cwd is authoritative:
 * when DSH registered a remote-backed placeholder as the workspace, the agent
 * cwd lives inside that placeholder, so native tools must target ITS remote —
 * not the mutable rw_* "current host" (null after rw_disconnect, or a different
 * host the user reconnected for rw_* work). The rw_* session is a fast path
 * when it matches the cwd; otherwise the cwd's placeholder is resolved by
 * scanning meta files (the pool redials lazily on the next op, so native tools
 * even survive a disconnect). Null when the cwd is a real local directory
 * (legitimate local pass-through) or a placeholder whose host is gone
 * (onExecute turns that into a clear error instead of a silent local fallback).
 */
function activeTarget(deps: ShimDeps, exec: ToolExecution | ToolDispatchExecution): ActiveTarget | null {
  const cwd = agentCwd(exec)

  // Fast path: the rw_* session's (alias, workspace), in-memory. Used when it
  // matches the agent cwd (the common case — the user picked this workspace
  // and stayed), so the hot path does no placeholder scan.
  const alias = deps.session.alias
  const workspace = deps.session.workspace
  if (alias !== null && workspace !== null) {
    const entry = deps.hosts.find(alias)
    if (entry !== undefined) {
      const localRoot = resolvePlaceholderDir(alias, workspace, deps.placeholderBaseDir)
      if (localRoot !== null) {
        const target = buildTarget(entry, workspace, localRoot)
        if (cwd === undefined || insideLocal(target.localRoots, resolve(cwd))) return target
      }
    }
  }

  // Authoritative slow path: the agent cwd itself. The placeholder meta
  // carries the host alias + remote path; the HostTable supplies credentials.
  if (cwd !== undefined) {
    const found = findPlaceholderByPath(cwd, deps.placeholderBaseDir)
    if (found !== null) {
      const entry = deps.hosts.find(found.meta.alias)
      if (entry !== undefined) return buildTarget(entry, found.meta.remotePath, found.dir)
      // cwd is a dsh-rw placeholder whose host is no longer configured: never
      // silently fall back to the local empty placeholder — onExecute reports
      // it as a clear error.
    }
  }

  return null
}

/**
 * The blocked state: the agent cwd sits inside a dsh-rw placeholder whose
 * host is no longer configured. Returns the placeholder + meta, or null when
 * the cwd is not placeholder-backed (legitimate local pass-through) or its
 * host is configured (activeTarget then handles it).
 */
function brokenPlaceholder(deps: ShimDeps, exec: ToolExecution | ToolDispatchExecution): { dir: string; meta: PlaceholderMeta } | null {
  const cwd = agentCwd(exec)
  if (cwd === undefined) return null
  const found = findPlaceholderByPath(cwd, deps.placeholderBaseDir)
  if (found === null) return null
  if (deps.hosts.find(found.meta.alias) !== undefined) return null
  return found
}

/** The clear, actionable error for a call that touches a broken placeholder. */
function blockedMessage(found: { dir: string; meta: PlaceholderMeta }): string {
  return (
    `the workspace ${found.dir} is remote-backed (host alias '${found.meta.alias}', remote ` +
    `${found.meta.remotePath}) but that host is no longer configured — re-add it (rw_hosts) ` +
    `and rw_connect('${found.meta.alias}') to operate on the remote; native tools will not ` +
    `use the local placeholder`
  )
}

/**
 * The explicit path argument a native call can be anchored by, or null when the
 * call carries no usable path (`bash` never has one; `glob`/`grep` may omit it).
 */
function callPathArg(name: string, args: Record<string, unknown>): { key: string; value: string } | null {
  const key =
    name === 'read' || name === 'write' || name === 'edit'
      ? 'file_path'
      : name === 'str_replace_editor' || name === 'glob' || name === 'grep'
        ? 'path'
        : null
  if (key === null) return null
  const value = strArg(args, key)
  if (value === undefined || value === '') return null
  return { key, value }
}

/** Where one native call resolved to: a remote target (with its anchor) or a host-less placeholder. */
type CallResolution =
  | { kind: 'target'; target: ActiveTarget; reason: 'cwd' | 'path'; args: Record<string, unknown> }
  | { kind: 'broken'; found: { dir: string; meta: PlaceholderMeta } }

/**
 * Resolve where a native call must run. Two independent anchors, in this order:
 *
 *  1. the call's own path argument — an explicit path inside a dsh-rw
 *     placeholder is remote by definition, wherever the session's cwd lives.
 *     This lets a session started in a local directory reach the remote simply
 *     by naming a placeholder path: the anchor travels with the call, so it can
 *     never be confused with ambient session state.
 *  2. the agent session cwd (the pre-1.0 rule) — used for calls that carry no
 *     path (`bash`, pathless `glob`/`grep`) and for paths outside every
 *     placeholder.
 *
 * A path inside a placeholder whose host is no longer configured resolves to
 * `broken`; the caller turns that into an actionable error when the call really
 * touches the placeholder — it must never fall back to the local stand-in.
 * Null means the call is not ours: pass it through to the native tool.
 */
function resolveCall(deps: ShimDeps, exec: ToolDispatchExecution): CallResolution | null {
  const args = objectArgs(exec.arguments)
  if (args === null) return null

  // 1) Explicit path anchor.
  const anchor = callPathArg(exec.name, args)
  if (anchor !== null) {
    const cwd = agentCwd(exec)
    const abs = isAbsolute(anchor.value)
      ? resolve(anchor.value)
      : cwd !== undefined
        ? resolve(cwd, anchor.value)
        : undefined
    if (abs !== undefined) {
      const found = findPlaceholderByPath(abs, deps.placeholderBaseDir)
      if (found !== null) {
        const entry = deps.hosts.find(found.meta.alias)
        if (entry === undefined) return { kind: 'broken', found }
        return {
          kind: 'target',
          target: buildTarget(entry, found.meta.remotePath, found.dir),
          reason: 'path',
          // Normalize to the absolute local form the anchor was resolved at, so
          // toRemotePath and the workspace guard see exactly the anchored path.
          args: { ...args, [anchor.key]: abs },
        }
      }
    }
  }

  // 2) Session-cwd anchor.
  const target = activeTarget(deps, exec)
  if (target !== null) return { kind: 'target', target, reason: 'cwd', args }

  return null
}

/**
 * Whether a native-tool call would actually touch the placeholder at `root`:
 * bash always (it runs with the session cwd); glob/grep without a path arg
 * too (they default to the session cwd); file tools only when their path
 * argument resolves inside. Calls that stay elsewhere pass through to the
 * local tool even in the blocked state — same rule the shim applies when the
 * remote is healthy.
 */
function callTouchesPlaceholder(name: string, args: Record<string, unknown> | null, roots: string[], root: string): boolean {
  if (name === 'bash') return true
  const inside = (raw: string): boolean => insideLocal(roots, isAbsolute(raw) ? resolve(raw) : resolve(root, raw))
  switch (name) {
    case 'read':
    case 'write':
    case 'edit': {
      const raw = args?.file_path
      // Missing/invalid path → pass through; native validation reports it.
      return typeof raw === 'string' && raw !== '' && inside(raw)
    }
    case 'str_replace_editor': {
      const raw = args?.path
      return typeof raw === 'string' && raw !== '' && inside(raw)
    }
    case 'glob':
    case 'grep': {
      const raw = args?.path
      if (typeof raw !== 'string' || raw === '') return true // cwd-bound
      return inside(raw)
    }
    default:
      return false // not a shimmed tool: do not interfere
  }
}

/** p (already resolve()d) sits inside one of the placeholder root forms. */
function insideLocal(roots: string[], p: string): boolean {
  return roots.some((r) => p === r || p.startsWith(`${r}${sep}`))
}

/**
 * Map a native-tool path argument to an absolute remote path inside the
 * workspace: relative input resolves against the placeholder root, the
 * matching placeholder prefix is stripped, and the remainder is re-rooted at
 * the remote root (still through the guard's lexical confinement). Null when
 * the resolved path falls outside the placeholder → the call passes through
 * to the local tool.
 */
function toRemotePath(target: ActiveTarget, input: string): string | null {
  const abs = isAbsolute(input) ? resolve(input) : resolve(target.localRoot, input)
  if (!insideLocal(target.localRoots, abs)) return null
  const root = target.localRoots.find((r) => abs === r || abs.startsWith(`${r}${sep}`))!
  const rel = abs
    .slice(root.length)
    .split(sep)
    .filter((s) => s !== '')
    .join('/')
  return resolveInWorkspace(target.remoteRoot, rel)
}

/**
 * Map an absolute remote path back to placeholder form. Paths outside the
 * workspace root are returned unchanged (they can appear in grep output when
 * the remote tool follows an escaping symlink; the guard already confines
 * file IO).
 */
function toLocalPath(target: ActiveTarget, remote: string): string {
  const r = normalizeRemote(remote)
  if (r === target.remoteRoot) return target.localRoot
  if (!r.startsWith(`${target.remoteRoot}/`)) return remote
  return join(target.localRoot, ...r.slice(target.remoteRoot.length + 1).split('/'))
}

/** The calling agent's session cwd — where DSH put the workspace (dsh-agent-loop reads it the same way). */
function agentCwd(exec: ToolExecution | ToolDispatchExecution): string | undefined {
  const cwd: unknown = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** The bash interception gate: the agent session must live inside the placeholder (cwd unknown → pass through). */
function sessionInsidePlaceholder(target: ActiveTarget, exec: ToolExecution | ToolDispatchExecution): boolean {
  const cwd = agentCwd(exec)
  return cwd !== undefined && insideLocal(target.localRoots, resolve(cwd))
}

// --- small argument/exec helpers ----------------------------------------------

/** exec.arguments as a plain record; null for anything else (→ pass through to native validation). */
function objectArgs(args: unknown): Record<string, unknown> | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  return args as Record<string, unknown>
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' ? v : undefined
}

/** Native-style positive-integer validation for read's offset/limit. */
function parsePositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * pool.exec has no signal channel, so abort races the call and — on winning —
 * drops the whole SSH connection: the only way to actually interrupt the
 * remote process through PoolLike. The pool reconnects lazily on next use.
 */
async function execRemote(
  deps: ShimDeps,
  target: ActiveTarget,
  command: string,
  opts: { cwd?: string; timeoutMs?: number },
  signal: AbortSignal,
): Promise<ExecResult | 'aborted'> {
  if (signal.aborted) return 'aborted'
  let onAbort: (() => void) | undefined
  const aborted = new Promise<'aborted'>((resolveAbort) => {
    onAbort = () => resolveAbort('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const res = await Promise.race([deps.pool.exec(target.entry, command, opts), aborted])
    if (res === 'aborted') deps.pool.disconnect(target.entry.alias)
    return res
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

// --- remote file primitives (read whole + guarded write-back) ------------------

interface RemoteTextFile {
  /** utf-8 content with \r\n normalized to \n (matching the native fs backend). */
  content: string
  mtime: number
}

/** Guarded whole-file read: realpath confinement, not-a-directory, utf-8 decode. */
async function readRemoteText(sftp: SftpLike, root: string, p: string, display: string): Promise<RemoteTextFile> {
  await assertRealpathInside(sftp, root, p)
  let st: Awaited<ReturnType<SftpLike['stat']>>
  try {
    st = await sftp.stat(p)
  } catch (err) {
    throw mapSftpError(err, display)
  }
  if (st.isDirectory()) throw new RwError('NOT_A_DIRECTORY', `is a directory: ${display}`)
  let buf: Buffer
  try {
    buf = await sftp.readFile(p)
  } catch (err) {
    throw mapSftpError(err, display)
  }
  return { content: buf.toString('utf8').replaceAll('\r\n', '\n'), mtime: st.mtime }
}

/**
 * Conflict-guarded write-back for edit-class operations: re-stat right before
 * writing and refuse with RW_EDIT_CONFLICT when the file moved since the read
 * — the remote is shared mutable state and there is no local copy to diff.
 */
async function writeRemoteText(
  sftp: SftpLike,
  p: string,
  content: string,
  expectedMtime: number,
  display: string,
): Promise<void> {
  let st: Awaited<ReturnType<SftpLike['stat']>>
  try {
    st = await sftp.stat(p)
  } catch (err) {
    throw mapSftpError(err, display)
  }
  if (st.mtime !== expectedMtime) {
    throw new RwError(
      'RW_EDIT_CONFLICT',
      `file changed on the remote since it was read (mtime ${expectedMtime} -> ${st.mtime}): ${display} — re-read it and retry the edit`,
    )
  }
  try {
    await sftp.writeFile(p, Buffer.from(content, 'utf8'))
  } catch (err) {
    throw mapSftpError(err, display)
  }
}

// --- read ---------------------------------------------------------------------

interface ReadWindow {
  lines: { number: number; text: string }[]
  totalLines: number
  truncatedByBytes: boolean
}

function truncateLine(line: string): string {
  return line.length > READ_MAX_LINE_LENGTH
    ? `${line.substring(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
    : line
}

/** Synchronous port of dsh-tool-fs buildWindow: exact total count, offset/limit window, byte cap. */
function buildReadWindow(content: string, offset: number, limit: number, display: string): ReadWindow {
  const rawLines = content.split('\n')
  // A trailing newline terminates the last line; it does not start a new one.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()
  const lines: { number: number; text: string }[] = []
  let outputBytes = 0
  let truncatedByBytes = false
  let totalLines = 0
  for (const raw of rawLines) {
    totalLines += 1
    if (truncatedByBytes || totalLines < offset || lines.length >= limit) continue
    const text = truncateLine(raw)
    const bytes = Buffer.byteLength(text, 'utf8') + (lines.length > 0 ? 1 : 0)
    if (outputBytes + bytes > READ_MAX_BYTES) {
      truncatedByBytes = true
      continue
    }
    outputBytes += bytes
    lines.push({ number: totalLines, text })
  }
  if (!truncatedByBytes && offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw new Error(`offset ${offset} is out of range for "${display}" (${totalLines} lines)`)
  }
  return { lines, totalLines, truncatedByBytes }
}

/** Native read envelope: <path>/<type>/<content> with numbered lines and a continuation footer. */
function formatReadOutput(display: string, offset: number, window: ReadWindow): string {
  const endLine = window.lines.at(-1)?.number ?? Math.max(0, offset - 1)
  let footer: string
  if (window.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < window.totalLines) {
    footer = `(Showing lines ${offset}-${endLine} of ${window.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${window.totalLines} lines)`
  }
  const body =
    window.lines.length > 0 ? `${window.lines.map((line) => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}` : footer
  return `<path>${display}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

/** Native `read` (dsh-tool-fs): { file_path, offset?, limit? }. */
async function shimRead(deps: ShimDeps, target: ActiveTarget, args: Record<string, unknown>): Promise<ToolExecutionResult | null> {
  const filePath = strArg(args, 'file_path')
  if (filePath === undefined) return null
  const remote = toRemotePath(target, filePath)
  if (remote === null) return null
  return guarded(async () => {
    if (filePath.trim().length === 0) throw new Error('file_path must be a non-empty string')
    const offset = parsePositiveInteger(args.offset, 'offset') ?? 1
    const limit = parsePositiveInteger(args.limit, 'limit') ?? READ_LIMIT
    if (limit > READ_LIMIT) throw new Error(`limit must be less than or equal to ${READ_LIMIT}`)
    const display = toLocalPath(target, remote)
    const sftp = await deps.pool.sftp(target.entry)
    const { content } = await readRemoteText(sftp, target.remoteRoot, remote, display)
    const window = buildReadWindow(content, offset, limit, display)
    // Native read output: { path, offset, lines: [{ number, text }], totalLines }.
    return okValue(
      { path: display, offset, lines: window.lines, totalLines: window.totalLines },
      formatReadOutput(display, offset, window),
    )
  })
}

// --- write --------------------------------------------------------------------

/** Native `write` (dsh-tool-fs): { file_path, content }. Parent directories are created. */
async function shimWrite(deps: ShimDeps, target: ActiveTarget, args: Record<string, unknown>): Promise<ToolExecutionResult | null> {
  const filePath = strArg(args, 'file_path')
  const content = strArg(args, 'content')
  if (filePath === undefined || content === undefined) return null
  const remote = toRemotePath(target, filePath)
  if (remote === null) return null
  return guarded(async () => {
    const display = toLocalPath(target, remote)
    const sftp = await deps.pool.sftp(target.entry)
    const fs = new RemoteFs(sftp, target.remoteRoot)
    // Native write output carries the previous content (`before`, null on
    // create) and the new content (`after`), so read the file first when it
    // exists. A directory skips the read: the write below fails either way.
    let before: string | null = null
    let operation: 'create' | 'update'
    try {
      const st = await fs.stat(remote)
      operation = 'update'
      if (st.type !== 'dir') before = (await readRemoteText(sftp, target.remoteRoot, remote, display)).content
    } catch (err) {
      if (err instanceof RwError && err.code === 'NO_SUCH_PATH') operation = 'create'
      else throw err
    }
    await fs.write(remote, content, { mkdir: true })
    // Native write output: { path, operation, before, after }.
    return okValue(
      { path: display, operation, before, after: content },
      `<path>${display}</path>\n<type>file</type>\n<content>\n${operation === 'create' ? 'Created' : 'Updated'} file\n</content>`,
    )
  })
}

// --- edit ---------------------------------------------------------------------

function countOccurrences(content: string, search: string): number {
  let count = 0
  let offset = 0
  for (;;) {
    const at = content.indexOf(search, offset)
    if (at < 0) return count
    count += 1
    offset = at + search.length
  }
}

/** Native `edit` (dsh-tool-fs): { file_path, old_string, new_string, replace_all? } with an mtime conflict gate. */
async function shimEdit(deps: ShimDeps, target: ActiveTarget, args: Record<string, unknown>): Promise<ToolExecutionResult | null> {
  const filePath = strArg(args, 'file_path')
  const oldString = strArg(args, 'old_string')
  const newString = strArg(args, 'new_string')
  if (filePath === undefined || oldString === undefined || newString === undefined) return null
  const remote = toRemotePath(target, filePath)
  if (remote === null) return null
  return guarded(async () => {
    if (filePath.trim().length === 0) throw new Error('file_path must be a non-empty string')
    if (oldString.length === 0) throw new Error('old_string must be a non-empty string')
    if (oldString === newString) throw new Error('old_string and new_string must differ')
    const replaceAll = args.replace_all === true
    const display = toLocalPath(target, remote)
    const sftp = await deps.pool.sftp(target.entry)
    const state = await readRemoteText(sftp, target.remoteRoot, remote, display)
    const replacements = countOccurrences(state.content, oldString)
    if (replacements === 0) {
      return fail(`old_string was not found in "${display}"`, { name: 'FsError', code: 'FS_EDIT_NOT_FOUND' })
    }
    if (!replaceAll && replacements > 1) {
      return fail(`old_string matched ${replacements} times in "${display}"; provide a more specific old_string or set replace_all to true`, {
        name: 'FsError',
        code: 'FS_AMBIGUOUS_EDIT',
      })
    }
    const at = state.content.indexOf(oldString)
    const after = replaceAll
      ? state.content.split(oldString).join(newString)
      : state.content.slice(0, at) + newString + state.content.slice(at + oldString.length)
    await writeRemoteText(sftp, remote, after, state.mtime, display)
    // Native edit output: { path, before, after }.
    return okValue(
      { path: display, before: state.content, after },
      replaceAll
        ? `The file ${display} has been updated. All occurrences were successfully replaced.`
        : `The file ${display} has been updated successfully.`,
    )
  })
}

// --- str_replace_editor --------------------------------------------------------

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = []
  let offset = 0
  for (;;) {
    const match = content.indexOf(search, offset)
    if (match < 0) return offsets
    offsets.push(match)
    offset = match + search.length
  }
}

function lineNumbersAt(content: string, offsets: number[]): number[] {
  let line = 1
  let cursor = 0
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === '\n') line += 1
      cursor += 1
    }
    return line
  })
}

function requiredForCommand(value: string | undefined, parameter: string, command: string, allowEmpty = true): string {
  if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`)
  if (!allowEmpty && value.length === 0) throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`)
  return value
}

function maybeTruncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n<response clipped>` : text
}

/** The native statExisting: missing path and directory-for-non-view map to FsStyleError. */
async function statExisting(fs: RemoteFs, remote: string, display: string, command: string): Promise<'dir' | 'file' | 'other'> {
  let info: { type: 'dir' | 'file' | 'symlink' | 'other' }
  try {
    info = await fs.stat(remote)
  } catch (err) {
    if (err instanceof RwError && err.code === 'NO_SUCH_PATH') {
      throw new FsStyleError(`The path ${display} does not exist. Please provide a valid path.`, 'FS_NOT_FOUND')
    }
    throw err
  }
  const type = info.type === 'dir' ? 'dir' : info.type === 'file' ? 'file' : 'other'
  if (type === 'dir' && command !== 'view') {
    throw new FsStyleError(`The path ${display} is a directory and only the \`view\` command can be used on directories`, 'FS_NOT_REGULAR_FILE')
  }
  return type
}

/** Native formatFileView: padStart(6) + two spaces numbering, total counted from a raw split. */
function formatEditorFileView(display: string, content: string, maxChars: number, viewRange: unknown): string {
  const allLines = content.split('\n')
  let lines = allLines
  let initialLine = 1
  let prompt = `Here's the content of ${display} with line numbers (which has a total of ${allLines.length} lines)`
  if (viewRange !== undefined) {
    if (!Array.isArray(viewRange) || viewRange.length !== 2 || !viewRange.every(Number.isInteger)) {
      throw new Error('Invalid `view_range`. It should be a list of two integers.')
    }
    const [requestedInitialLine, requestedFinalLine] = viewRange as [number, number]
    initialLine = requestedInitialLine
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
      )
    }
    if (requestedFinalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${requestedFinalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
      )
    }
    if (requestedFinalLine !== -1 && requestedFinalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${requestedFinalLine}\` should be larger or equal than its first \`${initialLine}\``,
      )
    }
    lines = requestedFinalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, requestedFinalLine)
    prompt += ` with view_range=[${initialLine}, ${requestedFinalLine}]`
  }
  const numbered = lines.map((line, index) => `${String(initialLine + index).padStart(6, ' ')}  ${line}`).join('\n')
  return maybeTruncate(`${prompt}:\n${numbered}\n`, maxChars)
}

function joinRemote(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/** Native directory view: two levels deep, excluding hidden entries, node_modules and __pycache__. */
async function editorListDir(deps: ShimDeps, fs: RemoteFs, remote: string, display: string): Promise<string> {
  const rows: string[] = [`d\t${display}`]
  const visit = async (dirRemote: string, dirDisplay: string, depth: number): Promise<void> => {
    for (const entry of await fs.list(dirRemote)) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const childDisplay = join(dirDisplay, entry.name)
      const type = entry.type === 'dir' ? 'd' : entry.type === 'file' ? 'f' : '?'
      rows.push(`${type}\t${childDisplay}`)
      if (entry.type === 'dir' && depth < 2) await visit(joinRemote(dirRemote, entry.name), childDisplay, depth + 1)
    }
  }
  await visit(remote, display, 1)
  rows.sort((left, right) => {
    const lp = left.slice(left.indexOf('\t') + 1)
    const rp = right.slice(right.indexOf('\t') + 1)
    return lp < rp ? -1 : lp > rp ? 1 : 0
  })
  const listing = maybeTruncate(`${rows.join('\n')}\n`, deps.config.maxOutputChars)
  return `Here're the files and directories up to 2 levels deep in ${display}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`
}

/** Native `str_replace_editor` (Anthropic editor): { command, path, file_text?, insert_line?, new_str?, old_str?, view_range? }. */
async function shimStrReplaceEditor(
  deps: ShimDeps,
  target: ActiveTarget,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | null> {
  const command = strArg(args, 'command')
  const pathArg = strArg(args, 'path')
  if (command === undefined || pathArg === undefined) return null
  if (!['view', 'create', 'str_replace', 'insert'].includes(command)) return null
  const remote = toRemotePath(target, pathArg)
  if (remote === null) return null
  return guarded(async () => {
    const display = toLocalPath(target, remote)
    const sftp = await deps.pool.sftp(target.entry)
    const fs = new RemoteFs(sftp, target.remoteRoot)
    switch (command) {
      case 'view': {
        const type = await statExisting(fs, remote, display, 'view')
        if (type === 'dir') {
          if (args.view_range !== undefined) {
            throw new Error('The `view_range` parameter is not allowed when `path` points to a directory.')
          }
          return ok(await editorListDir(deps, fs, remote, display))
        }
        if (type !== 'file') throw new FsStyleError(`cannot view "${display}": not a regular file or directory`, 'FS_NOT_REGULAR_FILE')
        const state = await readRemoteText(sftp, target.remoteRoot, remote, display)
        return ok(formatEditorFileView(display, state.content, deps.config.maxOutputChars, args.view_range))
      }
      case 'create': {
        const fileText = requiredForCommand(strArg(args, 'file_text'), 'file_text', 'create')
        let exists = true
        try {
          await fs.stat(remote)
        } catch (err) {
          if (err instanceof RwError && err.code === 'NO_SUCH_PATH') exists = false
          else throw err
        }
        if (exists) throw new Error(`File already exists at: ${display}. Cannot overwrite files using command \`create\`.`)
        await fs.write(remote, fileText, { mkdir: true })
        return ok(`New file created successfully at: ${display}`)
      }
      case 'str_replace': {
        const oldValue = requiredForCommand(strArg(args, 'old_str'), 'old_str', 'str_replace', false)
        const newValue = strArg(args, 'new_str') ?? ''
        const type = await statExisting(fs, remote, display, 'str_replace')
        if (type !== 'file') throw new FsStyleError(`cannot edit "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        const state = await readRemoteText(sftp, target.remoteRoot, remote, display)
        const offsets = matchOffsets(state.content, oldValue)
        const offset = offsets[0]
        if (offset === undefined) {
          throw new FsStyleError(`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${display}.`, 'FS_EDIT_NOT_FOUND')
        }
        if (offsets.length > 1) {
          throw new FsStyleError(
            `No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lineNumbersAt(state.content, offsets).join(', ')}]. Please ensure it is unique`,
            'FS_AMBIGUOUS_EDIT',
          )
        }
        const after = state.content.slice(0, offset) + newValue + state.content.slice(offset + oldValue.length)
        await writeRemoteText(sftp, remote, after, state.mtime, display)
        return ok(`The file ${display} has been edited successfully.`)
      }
      case 'insert': {
        const insertLine = args.insert_line
        if (insertLine === undefined) throw new Error('Parameter `insert_line` is required for command: insert')
        const value = requiredForCommand(strArg(args, 'new_str'), 'new_str', 'insert')
        const type = await statExisting(fs, remote, display, 'insert')
        if (type !== 'file') throw new FsStyleError(`cannot insert into "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        const state = await readRemoteText(sftp, target.remoteRoot, remote, display)
        const lines = state.content.split('\n')
        if (typeof insertLine !== 'number' || !Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
          throw new Error(`Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`)
        }
        const after = [...lines.slice(0, insertLine), ...value.split('\n'), ...lines.slice(insertLine)].join('\n')
        await writeRemoteText(sftp, remote, after, state.mtime, display)
        return ok(`The file ${display} has been edited successfully.`)
      }
    }
    throw new Error(`unknown command: ${command}`) // unreachable — command is validated above
  })
}

// --- glob / grep ----------------------------------------------------------------

/**
 * Resolve the search directory for glob/grep: an explicit path maps like any
 * fs path (outside → null → pass through); no path means the session
 * workspace, which is only ours when the agent session lives in the
 * placeholder. 'search' distinguishes the two in error messages.
 */
function searchDir(
  target: ActiveTarget,
  exec: ToolDispatchExecution,
  args: Record<string, unknown>,
): { remoteDir: string } | null {
  const rawPath = args.path
  if (rawPath !== undefined && typeof rawPath !== 'string') return null // invalid → native validation
  if (typeof rawPath === 'string') {
    const mapped = toRemotePath(target, rawPath)
    return mapped === null ? null : { remoteDir: mapped }
  }
  if (!sessionInsidePlaceholder(target, exec)) return null
  return { remoteDir: target.remoteRoot }
}

/**
 * Marker every remote search prints as its first line, so the shim knows which
 * engine actually ran. `rg` and the `find`/`grep` fallbacks do not have
 * identical semantics (ignore rules, hidden files, ordering), and a silent
 * difference would make the same call return different results depending on
 * which binary a host happens to have installed.
 */
const ENGINE_MARK = '__DSH_RW_ENGINE__='

/** VCS metadata directories the native glob tool excludes — mirrored verbatim. */
const VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

/** Split the engine marker off a remote search's stdout. */
function readEngine(stdout: string): { engine: 'rg' | 'fallback'; body: string } {
  if (!stdout.startsWith(ENGINE_MARK)) return { engine: 'fallback', body: stdout }
  const nl = stdout.indexOf('\n')
  const name = stdout.slice(ENGINE_MARK.length, nl < 0 ? undefined : nl)
  return { engine: name === 'rg' ? 'rg' : 'fallback', body: nl < 0 ? '' : stdout.slice(nl + 1) }
}

/** The note appended to a rendered fallback search: never silently different semantics. */
function engineNote(kind: 'glob' | 'grep'): string {
  return kind === 'glob'
    ? '(dsh-rw shim: ripgrep is not installed on this host, so this glob ran `find` — ignore rules, hidden ' +
        'files and mtime ordering differ from the native tool)'
    : '(dsh-rw shim: ripgrep is not installed on this host, so this grep ran `grep -rnE` — .gitignore and ' +
        'hidden-file rules differ from the native tool)'
}

/**
 * Remote glob with the native tool's exact ripgrep semantics: `--files
 * --glob=<pattern> --sort=modified --no-ignore --hidden` plus the VCS
 * excludes. The `find` fallback is labelled in the rendered text because it
 * cannot reproduce those semantics.
 */
async function shimGlob(
  deps: ShimDeps,
  target: ActiveTarget,
  exec: ToolDispatchExecution,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | null> {
  const pattern = strArg(args, 'pattern')
  if (pattern === undefined) return null
  const dir = searchDir(target, exec, args)
  if (dir === null) return null
  return guarded(async () => {
    if (pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
    const root = dir.remoteDir
    const excludes = VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]).map(shq).join(' ')
    const rg = `rg --files --glob=${shq(pattern)} --sort=modified --no-ignore --hidden ${excludes} -- ${shq(root)}`
    const fallback = pattern.includes('/')
      ? `find ${shq(root)} -type f -path ${shq(`${root}/${pattern}`)}`
      : `find ${shq(root)} -type f -name ${shq(pattern)}`
    const command =
      `if command -v rg >/dev/null 2>&1; then printf '${ENGINE_MARK}rg\\n'; ${rg}; ` +
      `else printf '${ENGINE_MARK}fallback\\n'; ${fallback}; fi`
    const res = await execRemote(deps, target, command, { cwd: root, timeoutMs: deps.config.commandTimeoutMs }, exec.signal)
    if (res === 'aborted') return fail('command aborted (remote execution interrupted)')
    if (res.code !== 0 && res.code !== 1) {
      throw new Error(`remote glob failed (exit code ${res.code ?? 'null'}): ${(res.stderr || res.stdout).trim()}`)
    }
    const { engine, body } = readEngine(res.stdout)
    const displayDir = toLocalPath(target, root)
    const paths = body
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => toLocalPath(target, line))
    // Native glob output: { root, paths } — the complete list; the rendered
    // text stays capped at GLOB_MAX_RESULTS.
    const shown = paths.slice(0, GLOB_MAX_RESULTS)
    const rendered = shown.length === 0 ? 'No files found' : shown.join('\n')
    return okValue({ root: displayDir, paths }, engine === 'rg' ? rendered : `${rendered}\n${engineNote('glob')}`)
  })
}

/** One parsed grep row (a type alias, so it remains a canonical JSON object value). */
type GrepMatch = {
  path: string
  lineNumber: number
  line: string
}

/** Decode an `rg --json` string field, which is either `{ text }` or base64 `{ bytes }`. */
function jsonField(field: { text?: string; bytes?: string } | undefined): string | undefined {
  if (field === undefined) return undefined
  if (typeof field.text === 'string') return field.text
  if (typeof field.bytes === 'string') return Buffer.from(field.bytes, 'base64').toString('utf8')
  return undefined
}

/**
 * Parse `rg --json` NDJSON — the same transport the native grep tool uses, so a
 * path containing colons or newlines can never be mis-split. Only `match`
 * records are hits; `begin`/`end`/`context`/`summary` are ignored.
 */
function parseRgJson(target: ActiveTarget, stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  for (const raw of stdout.split('\n')) {
    if (raw === '') continue
    let record: unknown
    try {
      record = JSON.parse(raw)
    } catch {
      continue
    }
    const rec = record as {
      type?: string
      data?: {
        path?: { text?: string; bytes?: string }
        line_number?: number
        lines?: { text?: string; bytes?: string }
      }
    }
    if (rec.type !== 'match' || rec.data === undefined) continue
    const path = jsonField(rec.data.path)
    const line = jsonField(rec.data.lines)
    const lineNumber = rec.data.line_number
    if (path === undefined || line === undefined || lineNumber === undefined) continue
    matches.push({ path: toLocalPath(target, path), lineNumber, line: line.replace(/\r?\n$/, '') })
  }
  return matches
}

/** Parse `path:line:text` rows from the grep fallback; the greedy path keeps colons inside file names working. */
function parseGrepStdout(target: ActiveTarget, stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  for (const raw of stdout.split('\n')) {
    if (raw === '') continue
    const m = /^(.*):(\d+):(.*)$/.exec(raw)
    const path = m?.[1]
    const lineNumber = m?.[2]
    const line = m?.[3]
    if (path === undefined || lineNumber === undefined || line === undefined) continue
    matches.push({ path: toLocalPath(target, path), lineNumber: Number(lineNumber), line })
  }
  return matches
}

/** Native grep render: found-count header, matches grouped by file (`Line N: text`). */
function renderGrepMatches(matches: GrepMatch[], engine: 'rg' | 'fallback'): string {
  const note = engine === 'fallback' ? `\n\n${engineNote('grep')}` : ''
  if (matches.length === 0) return `No matches found${note}`
  const kept = matches.slice(0, GREP_MAX_MATCHES)
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of kept) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    sections.push(`${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  const header =
    matches.length > GREP_MAX_MATCHES
      ? `Found ${kept.length} of ${matches.length} matches`
      : `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`
  return `${header}\n\n${sections.join('\n\n')}${note}`
}

/**
 * Remote grep with the native tool's semantics: `rg --json` (the native argv,
 * so default ignore rules match) and a labelled `grep -rnE` fallback.
 */
async function shimGrep(
  deps: ShimDeps,
  target: ActiveTarget,
  exec: ToolDispatchExecution,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | null> {
  const pattern = strArg(args, 'pattern')
  if (pattern === undefined) return null
  const include = strArg(args, 'include')
  if (args.include !== undefined && include === undefined) return null // invalid → native validation
  const dir = searchDir(target, exec, args)
  if (dir === null) return null
  return guarded(async () => {
    if (pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
    if (include !== undefined && include.trim().length === 0) throw new Error('include must be a non-empty glob when given')
    const root = dir.remoteDir
    const rgArgs = `rg --json --regexp=${shq(pattern)}${include !== undefined ? ` --glob=${shq(include)}` : ''} -- ${shq(root)}`
    const grepArgs =
      `grep -rnI -E${include !== undefined ? ` --include=${shq(include)}` : ''} -e ${shq(pattern)} -- ${shq(root)}`
    const command =
      `if command -v rg >/dev/null 2>&1; then printf '${ENGINE_MARK}rg\\n'; ${rgArgs}; ` +
      `else printf '${ENGINE_MARK}fallback\\n'; ${grepArgs}; fi`
    const res = await execRemote(deps, target, command, { cwd: root, timeoutMs: deps.config.commandTimeoutMs }, exec.signal)
    if (res === 'aborted') return fail('command aborted (remote execution interrupted)')
    if (res.code !== 0 && res.code !== 1) {
      throw new Error(`remote grep failed (exit code ${res.code ?? 'null'}): ${(res.stderr || res.stdout).trim()}`)
    }
    // Native grep output: { matches: [{ path, lineNumber, line }] } — the
    // complete list; the rendered text stays capped at GREP_MAX_MATCHES.
    const { engine, body } = readEngine(res.stdout)
    const matches = engine === 'rg' ? parseRgJson(target, body) : parseGrepStdout(target, body)
    return okValue({ matches }, renderGrepMatches(matches, engine))
  })
}

// --- bash -----------------------------------------------------------------------

/** ssh-pool appends this to a capped stream; the structured result reports it as the truncated flag. */
const TRUNC_SUFFIX = '\n…[truncated]'

/** Native bash result body: stdout, an optional [stderr] section, then status markers. */
function renderBashResult(res: ExecResult, timeoutMs: number, note?: string): string {
  const out = res.stdout.replace(/\n+$/, '')
  const err = res.stderr.replace(/\n+$/, '')
  let body = out
  if (err.length > 0) {
    if (body.length > 0) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (res.timedOut) markers.push(`[timed out after ${timeoutMs}ms]`)
  if (res.signal !== null) markers.push(`[killed by signal: ${res.signal}]`)
  else if (res.code !== 0) markers.push(`[exit code: ${res.code ?? 'null'}]`)
  // One shim note is allowed here: the model must know when shell state does
  // not carry over, and when the two streams are merged.
  if (note !== undefined) markers.push(note)
  if (markers.length === 0) return body
  return `${body}\n${markers.join('\n')}`
}

/**
 * Both bash plugins register as "bash": dsh-tool-bash (one-shot) declares
 * workdir/timeoutMs/description parameters, dsh-tool-bash-persistent declares
 * only command. The caller-visible definition decides the flavor.
 */
function isPersistentBash(deps: ShimDeps, exec: ToolDispatchExecution): boolean {
  const def = deps.getTool?.('bash', exec.agent)
  const props = (def?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  if (props === undefined || props === null || typeof props !== 'object') return false
  return !('workdir' in props) && !('timeoutMs' in props) && !('description' in props)
}

/** Wire the job launcher to the pool: exec for control, SFTP for the log. */
function remoteJobDeps(deps: ShimDeps): RemoteJobDeps {
  return {
    exec: async (entry, command, opts) => await deps.pool.exec(entry, command, opts),
    readFile: async (entry, path) => {
      const sftp = await deps.pool.sftp(entry)
      try {
        return (await sftp.readFile(path)).toString('utf8')
      } catch (err) {
        // "not created yet" is normal for a job that just started; anything
        // else is a real failure the poller must report.
        const mapped = mapSftpError(err, path)
        if (mapped instanceof RwError && mapped.code === 'NO_SUCH_PATH') return null
        throw mapped
      }
    },
    ...(deps.jobPollMs !== undefined ? { pollMs: deps.jobPollMs } : {}),
    ...(deps.jobDir !== undefined ? { logDir: deps.jobDir } : {}),
  }
}

/** The owning agent's id, as `ctx.jobs` fences access with it. */
function agentIdOf(exec: ToolDispatchExecution): string | undefined {
  const id = (exec.agent as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Replace every placeholder path form in the command with the remote root. */
function rewriteCommand(target: ActiveTarget, command: string): string {
  const roots = [...new Set([target.localRoot, ...target.localRoots])].sort((a, b) => b.length - a.length)
  let rewritten = command
  for (const root of roots) rewritten = rewritten.split(root).join(target.remoteRoot)
  return rewritten
}

/**
 * Native `bash` (either flavor): gated on shimBash and the session cwd living
 * in the placeholder. The command is rewritten to remote paths and runs with
 * the remote workspace root as cwd; an explicit workdir maps like any fs path
 * (outside → conservative pass-through). exec.signal aborts interrupt the
 * remote execution.
 */
async function shimBash(
  deps: ShimDeps,
  target: ActiveTarget,
  exec: ToolDispatchExecution,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | null> {
  if (!deps.config.shimBash) return null
  if (!sessionInsidePlaceholder(target, exec)) return null
  const command = strArg(args, 'command')
  if (command === undefined) return null
  if (args.workdir !== undefined && typeof args.workdir !== 'string') return null // invalid → native validation
  let cwd = target.remoteRoot
  if (typeof args.workdir === 'string') {
    const mapped = toRemotePath(target, args.workdir)
    if (mapped === null) return null
    cwd = mapped
  }
  if (args.run_in_background === true) {
    // Reaching here means the session cwd IS a remote placeholder, so a
    // pass-through would run the command on the LOCAL machine while every
    // other signal says it is remote. Start it on the host instead and let the
    // host job registry narrate it (job_output / job_kill work unchanged).
    if (deps.jobs === undefined || deps.config.backgroundJobs === false) {
      return fail(
        'background jobs are unavailable for remote workspaces in this deployment — run the command in the ' +
          'foreground (it would otherwise run on the LOCAL machine, not the host)',
      )
    }
    return guarded(async () => {
      if (command.trim().length === 0) throw new Error('command must be a non-empty string')
      const owner = agentIdOf(exec)
      const jobId = startRemoteJob(remoteJobDeps(deps), deps.jobs as JobsRegistryLike, {
        entry: target.entry,
        command: rewriteCommand(target, command),
        cwd,
        label: command.trim().split('\n')[0] ?? command,
        ...(owner !== undefined ? { owner } : {}),
      })
      return {
        isError: false,
        // The native background result is exactly { kind, jobId, cwd }.
        value: { kind: 'background', jobId, cwd },
        content: [
          {
            type: 'text',
            text:
              `started background job ${jobId} on ${target.entry.alias} (cwd: ${cwd})\n` +
              'collect its output with job_output, stop it with job_kill',
          },
        ],
      }
    })
  }
  return guarded(async () => {
    if (command.trim().length === 0) throw new Error('command must be a non-empty string')
    const timeoutMs =
      typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
        ? Math.floor(args.timeoutMs)
        : deps.config.commandTimeoutMs
    const rewritten = rewriteCommand(target, command)
    // The persistent-bash flavor gets a real long-lived shell so `cd` and
    // exports survive; without a manager (or with persistentShell: false) it
    // degrades to the one-shot exec and the result says so.
    const persistent = isPersistentBash(deps, exec)
    const shells = deps.shells
    const usePersistent = persistent && shells !== undefined && deps.config.persistentShell !== false
    let res: ExecResult | 'aborted'
    try {
      res =
        usePersistent && shells !== undefined
          ? await shells.run(target.entry, cwd, rewritten, {
              timeoutMs,
              ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            })
          : await execRemote(deps, target, rewritten, { cwd, timeoutMs }, exec.signal)
    } catch (err) {
      if (exec.signal.aborted) return fail('command aborted (remote execution interrupted)')
      throw err
    }
    if (res === 'aborted') return fail('command aborted (remote execution interrupted)')
    const note = usePersistent
      ? 'persistent shell: stdout and stderr are merged into one ordered stream'
      : persistent
        ? 'dsh-rw shim: persistent bash ran as a one-shot remote command — shell state (cwd, exports) is NOT preserved between calls'
        : undefined
    // The registry validates bash results against the native tool's oneOf
    // output schema (foreground/background), so value must be the structured
    // foreground object; the rendered text stays the model-facing content.
    return {
      isError: false,
      value: {
        kind: 'foreground',
        exitCode: res.code,
        signal: res.signal,
        timedOut: res.timedOut,
        aborted: false,
        timeoutMs,
        stdout: { text: res.stdout, truncated: res.stdout.endsWith(TRUNC_SUFFIX) },
        stderr: { text: res.stderr, truncated: res.stderr.endsWith(TRUNC_SUFFIX) },
      },
      content: [{ type: 'text', text: renderBashResult(res, timeoutMs, note) }],
    }
  })
}

// --- the middlewares --------------------------------------------------------------

export function makeShim(deps: ShimDeps): Shim {
  /** One console line per distinct (alias, workspace, local cwd) mismatch — never per call. */
  const warnedRouting = new Set<string>()

  /**
   * Record where this dispatch actually went, and — for the case that used to
   * fail silently — say so once on the console. `resolved` is the shim's own
   * resolution result, so `remote` means this call was translated, and with
   * 1.0 it also carries WHICH anchor did it: `path` (the call named a
   * placeholder path, so it reaches the remote from any working directory) or
   * `cwd` (the session cwd lives inside a placeholder — the pre-1.0 rule).
   * `local` means a remote workspace is recorded while this call was rooted
   * elsewhere: legitimate pass-through by design, but indistinguishable from a
   * working remote session unless it is reported.
   */
  const recordRouting = (
    exec: ToolDispatchExecution,
    resolved: { target: ActiveTarget; reason: 'cwd' | 'path' } | null,
  ): void => {
    const routing = deps.routing
    if (routing === undefined) return
    if (resolved !== null) {
      routing.mode = 'remote'
      routing.alias = resolved.target.entry.alias
      routing.workspace = resolved.target.remoteRoot
      routing.placeholder = resolved.target.localRoot
      routing.reason = resolved.reason
      delete routing.cwd
      return
    }
    const alias = deps.session.alias
    const workspace = deps.session.workspace
    if (alias === null || workspace === null) {
      // No remote workspace recorded: the prompt section's idle guidance owns
      // this state and there is nothing native calls could be translated to.
      routing.mode = 'unknown'
      delete routing.cwd
      delete routing.alias
      delete routing.workspace
      delete routing.placeholder
      delete routing.reason
      return
    }
    const placeholder = resolvePlaceholderDir(alias, workspace, deps.placeholderBaseDir)
    const cwd = agentCwd(exec)
    if (cwd === undefined || placeholder === null) return // cannot tell: keep the last observation
    if (insideLocal(localRootsOf(placeholder), resolve(cwd))) return // the shim would have translated
    routing.mode = 'local'
    routing.cwd = cwd
    routing.alias = alias
    routing.workspace = workspace
    routing.placeholder = placeholder
    delete routing.reason
    const key = `${alias}\u0000${workspace}\u0000${cwd}`
    if (warnedRouting.has(key)) return
    warnedRouting.add(key)
    console.warn(
      `[dsh-rw] this call ran LOCALLY, not on the remote host: it was rooted outside the dsh-rw placeholder ` +
        `for ${alias}:${workspace} (${placeholder}) and this session's working directory (${cwd}) is not inside ` +
        'that placeholder either. Native file calls that name a placeholder path ARE translated from any ' +
        'working directory; bash and pathless glob/grep need the session cwd to be the placeholder. Use the ' +
        'rw_* tools for remote work, or open the placeholder directory as this session\'s workspace.',
    )
  }

  const onExecute = async (
    exec: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> => {
    if (!deps.config.shim) return next()
    const resolved = resolveCall(deps, exec)
    if (process.env.DSH_RW_DEBUG) {
      console.log('[dsh-rw shim] dispatch', {
        name: exec.name,
        target:
          resolved !== null && resolved.kind === 'target'
            ? `${resolved.target.entry.alias}:${resolved.target.localRoot}`
            : null,
        anchor: resolved === null ? null : resolved.kind === 'target' ? resolved.reason : 'broken',
        hasAgent: exec.agent !== undefined && exec.agent !== null,
        cwd: agentCwd(exec) ?? null,
        inside:
          resolved !== null && resolved.kind === 'target'
            ? sessionInsidePlaceholder(resolved.target, exec)
            : null,
      })
    }
    if (resolved === null) {
      // The agent cwd pointing at a dsh-rw placeholder whose host is gone
      // means the user expects remote-backed native tools; never silently run
      // them on the local empty placeholder. But the block is path-aware:
      // only calls that would actually TOUCH the broken placeholder fail —
      // calls whose paths live elsewhere still pass through to the local
      // tool, exactly as they do when the remote is healthy.
      const broken = brokenPlaceholder(deps, exec)
      if (broken !== null && callTouchesPlaceholder(exec.name, objectArgs(exec.arguments), localRootsOf(broken.dir), broken.dir)) {
        return fail(blockedMessage(broken), { name: 'RwError', code: 'NOT_CONNECTED' })
      }
      // Pass-through by design (local cwd, or a call rooted outside the
      // placeholder): record it, so the prompt and rw_info can report that
      // this session's native tools are not reaching the remote.
      recordRouting(exec, null)
      return next()
    }
    if (resolved.kind === 'broken') {
      // The call names a path inside a placeholder whose host is no longer
      // configured: fail loud rather than run against the local stand-in.
      if (callTouchesPlaceholder(exec.name, objectArgs(exec.arguments), localRootsOf(resolved.found.dir), resolved.found.dir)) {
        return fail(blockedMessage(resolved.found), { name: 'RwError', code: 'NOT_CONNECTED' })
      }
      recordRouting(exec, null)
      return next()
    }
    const { target, args } = resolved
    recordRouting(exec, { target, reason: resolved.reason })
    switch (exec.name) {
      case 'read':
        return (await shimRead(deps, target, args)) ?? next()
      case 'write':
        return (await shimWrite(deps, target, args)) ?? next()
      case 'edit':
        return (await shimEdit(deps, target, args)) ?? next()
      case 'str_replace_editor':
        return (await shimStrReplaceEditor(deps, target, args)) ?? next()
      case 'glob':
        return (await shimGlob(deps, target, exec, args)) ?? next()
      case 'grep':
        return (await shimGrep(deps, target, exec, args)) ?? next()
      case 'bash':
        return (await shimBash(deps, target, exec, args)) ?? next()
      default:
        return next()
    }
  }

  const onPreExecute = async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (!deps.config.shim || !deps.config.shimBash || deps.config.shimBashApproval !== 'ask') return next()
    if (exec.name !== 'bash') return next()
    const target = activeTarget(deps, exec)
    if (target === null) return next()
    if (!sessionInsidePlaceholder(target, exec)) return next()
    const args = objectArgs(exec.arguments)
    // A background command now runs on the HOST (registered as a job), so it
    // needs the same approval as a foreground remote command.
    // Never-ask presets (danger-full-access): an ask would auto-reject without
    // a dialog, so stand down — onExecute still intercepts and runs remotely.
    if (deps.approvalPolicyOf?.(exec.agent?.session) === 'never') return next()
    if (process.env.DSH_RW_DEBUG) {
      console.log(`[dsh-rw shim] pre-execute: ask approval for bash on remote host '${target.entry.alias}'`)
    }
    return { kind: 'ask', reason: `run on remote host '${target.entry.alias}' (dsh-rw shim)` }
  }

  return { onExecute, onPreExecute }
}
