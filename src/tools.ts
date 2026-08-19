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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mapSftpError, RwError, toRwError } from './errors.js'
import { normalizeRemote } from './guard.js'
import type { HostEntry, HostSummary } from './hosts.js'
import { ensurePlaceholder, placeholderDirFor } from './placeholder.js'
import { RemoteFs } from './remote-fs.js'
import type { Session } from './session.js'
import type { ExecResult, SftpLike } from './ssh-pool.js'

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
}

/** Structural subset of SshPool (same rationale as HostTableLike). */
export interface PoolLike {
  exec(entry: HostEntry, command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>
  sftp(entry: HostEntry): Promise<SftpLike>
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

/** The connected host entry, or a thrown NOT_CONNECTED / INVALID_INPUT. */
function requireEntry(deps: ToolsDeps): HostEntry {
  const alias = deps.session.alias
  if (alias === null) {
    throw new RwError('NOT_CONNECTED', 'no host connected — call rw_connect(alias) first (rw_hosts lists aliases)')
  }
  const entry = deps.hosts.find(alias)
  if (!entry) {
    throw new RwError('NOT_CONNECTED', `session host ${JSON.stringify(alias)} is no longer configured — rw_connect again`)
  }
  return entry
}

/** A RemoteFs bound to the current workspace, or a thrown NO_WORKSPACE. */
async function requireWorkspaceFs(deps: ToolsDeps): Promise<RemoteFs> {
  const entry = requireEntry(deps)
  const workspace = deps.session.workspace
  if (workspace === null) {
    throw new RwError('NO_WORKSPACE', 'no remote workspace picked — call rw_pick_workspace(path) first')
  }
  const sftp = await deps.pool.sftp(entry)
  return new RemoteFs(sftp, workspace)
}

/**
 * Shared pick-workspace validation used by rw_pick_workspace and the
 * /api/dsh-rw/workspace route: resolve symlinks via realpath, require a
 * directory, create the local placeholder. Returns the real workspace path
 * and the placeholder directory. Does not touch the session.
 */
export async function resolveWorkspaceDir(
  deps: ToolsDeps,
  alias: string,
  path: string,
): Promise<{ workspace: string; placeholderDir: string }> {
  const entry = deps.hosts.find(alias)
  if (!entry) throw unknownAliasError(deps, alias)
  if (!path.startsWith('/')) {
    throw new RwError('INVALID_INPUT', `workspace path must be absolute: ${JSON.stringify(path)}`)
  }
  const sftp = await deps.pool.sftp(entry)
  let real: string
  try {
    real = normalizeRemote(await sftp.realpath(path))
  } catch (err) {
    throw mapSftpError(err, path)
  }
  let isDir: boolean
  try {
    isDir = (await sftp.stat(real)).isDirectory()
  } catch (err) {
    throw mapSftpError(err, real)
  }
  if (!isDir) throw new RwError('NOT_A_DIRECTORY', `not a directory: ${real}`)
  const placeholderDir = ensurePlaceholder(alias, entry, real, deps.placeholderBaseDir)
  return { workspace: real, placeholderDir }
}

/** Sync status lines shared by rw_info and the /rw slash command. */
export function statusText(deps: ToolsDeps): string {
  const { hosts, pool, session } = deps
  const summaries = hosts.summaries()
  const alias = session.alias
  const entry = alias !== null ? hosts.find(alias) : undefined
  const connected = alias !== null && pool.connected().includes(alias)
  const workspace = session.workspace
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
  lines.push(`Current workspace: ${workspace ?? '(none — call rw_pick_workspace to set one)'}`)
  if (alias !== null && workspace !== null) {
    lines.push(`Placeholder dir (register this as the DSH workspace): ${placeholderDirFor(alias, workspace, deps.placeholderBaseDir)}`)
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

/** The twelve rw_* tools in their fixed registration order. */
export function makeTools(deps: ToolsDeps): unknown[] {
  const { hosts, pool, session, config } = deps
  const text = (value: { text: string }): { type: 'text'; text: string }[] => [{ type: 'text', text: value.text }]

  return [
    // ------------------------------------------------------------- rw_info
    defineTool({
      name: 'rw_info',
      description:
        'Show the dsh-rw remote-workspace state: configured SSH host count, current host (user@host:port), ' +
        'connection health, current remote workspace, its local placeholder directory, and the host-key policy. ' +
        'Call this first to orient, or when an rw_* call fails to check connectivity. ' +
        'Triggers: remote workspace, SSH host, server status, where am I working.',
      parameters: {},
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute() {
        try {
          return { text: statusText(deps) }
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
      async execute() {
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
      async execute(args) {
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
      async execute(args) {
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
      async execute(args) {
        try {
          const fs = await requireWorkspaceFs(deps)
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
      async execute(args) {
        try {
          const fs = await requireWorkspaceFs(deps)
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
      },
      output: { schema: TEXT_OUTPUT_SCHEMA, render: (_args, value) => text(value) },
      async execute(args) {
        try {
          const fs = await requireWorkspaceFs(deps)
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
      async execute(args) {
        try {
          const fs = await requireWorkspaceFs(deps)
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
      async execute(args) {
        try {
          const fs = await requireWorkspaceFs(deps)
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
      async execute(args) {
        try {
          const fs = await requireWorkspaceFs(deps)
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
      async execute(args) {
        try {
          if (args.command.trim() === '') throw new RwError('INVALID_INPUT', 'command must not be empty')
          const entry = requireEntry(deps)
          const cwd = session.workspace ?? undefined
          const timeoutMs = args.timeoutMs ?? config.commandTimeoutMs
          const res = await pool.exec(entry, args.command, { cwd, timeoutMs })
          return { text: renderExecResult(args.command, cwd, res, timeoutMs) }
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
      async execute() {
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
