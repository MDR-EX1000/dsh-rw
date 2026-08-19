// dsh-rw — Remote-SSH-style workspace for DeepSeek Harness.
//
// Host half. The remote filesystem is the source of truth: the agent works on
// a remote directory through rw_* tools (SFTP/exec over a persistent ssh2
// pool). The local directory registered with DSH is only a placeholder so the
// native workspace flow accepts it — it never holds a copy of remote files.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { HostTable } from './hosts.js'
import { KnownHosts } from './known-hosts.js'
import { makeRoutes } from './routes.js'
import { Session } from './session.js'
import { SshPool } from './ssh-pool.js'
import { makeTools, statusText } from './tools.js'
import type { HostTableLike, PoolLike, ToolsDeps } from './tools.js'

export const name = 'dsh-rw'

// webServer is INJECTED so apply() runs only after the web server is up and
// the /api/dsh-rw/* routes actually register.
export const inject = ['tools', 'systemPrompt', 'webServer']

/** Host key verification policy for outbound SSH connections. */
export type HostKeyPolicy = 'accept-new' | 'strict' | 'off'

export const Config = z.object({
  /** Host key policy: verify against ~/.ssh/known_hosts (accept-new learns on first connect). */
  hostKeyPolicy: z.string().default('accept-new'),
  /** known_hosts file path (default ~/.ssh/known_hosts). */
  knownHostsPath: z.string().default(''),
  /** Per remote command timeout. */
  commandTimeoutMs: z.number().step(1).min(1000).default(30000),
  /** SSH connection establishment timeout. */
  connectTimeoutMs: z.number().step(1).min(1000).default(15000),
  /** Hard ceiling on collected remote output per call. */
  maxOutputChars: z.number().step(1).min(1024).default(200000),
})

export interface Config {
  hostKeyPolicy: HostKeyPolicy
  knownHostsPath: string
  commandTimeoutMs: number
  connectTimeoutMs: number
  maxOutputChars: number
}

/**
 * Test seams for apply(): the DSH loader calls apply(ctx, config); tests pass
 * in-memory fakes plus tmp paths so nothing touches the real ~/.ssh or ~/.dsh.
 */
export interface ApplyOverrides {
  hosts?: HostTableLike
  pool?: PoolLike
  session?: Session
  placeholderBaseDir?: string
  pickDirectory?: () => Promise<string | null>
}

/** Minimal shape of the optional DSH commands service (slash commands). */
interface CommandsLike {
  register(command: { name: string; description: string; handler: () => { kind: string; text: string } }):
    | (() => void)
    | void
}

/** Minimal shape of the optional DSH directoryPicker service. */
interface DirectoryPickerLike {
  capability?: () =>
    | Promise<{ kind?: string; pick?: (signal?: AbortSignal) => Promise<unknown> } | null | undefined>
    | { kind?: string; pick?: (signal?: AbortSignal) => Promise<unknown> }
    | null
    | undefined
}

/**
 * Adapt the ctx directoryPicker service (as used by dsh-remote's local-pick
 * endpoint) into a plain pick function. Undefined when the service is absent;
 * the returned function throws a friendly Error when the backend is not the
 * native picker, resolves null on cancel.
 */
function adaptDirectoryPicker(ctx: Context): (() => Promise<string | null>) | undefined {
  const dp = (ctx.get('directoryPicker') ?? (ctx as unknown as { directoryPicker?: unknown }).directoryPicker) as
    | DirectoryPickerLike
    | null
    | undefined
  if (!dp || typeof dp.capability !== 'function') return undefined
  return async () => {
    const cap = await dp.capability!()
    if (!cap || cap.kind !== 'native' || typeof cap.pick !== 'function') {
      throw new Error('local directory picker is unavailable (non-native backend) — enter the local path manually')
    }
    const pickAbort = new AbortController()
    try {
      const picked = await cap.pick(pickAbort.signal)
      return typeof picked === 'string' && picked !== '' ? picked : null
    } finally {
      pickAbort.abort()
    }
  }
}

export function apply(ctx: Context, config: Config, overrides: ApplyOverrides = {}): void {
  const hosts = overrides.hosts ?? new HostTable()
  const pool =
    overrides.pool ??
    new SshPool({
      hostKeyPolicy: config.hostKeyPolicy,
      knownHosts: new KnownHosts(config.knownHostsPath || KnownHosts.defaultPath()),
      connectTimeoutMs: config.connectTimeoutMs,
      commandTimeoutMs: config.commandTimeoutMs,
      maxOutputChars: config.maxOutputChars,
    })
  const session = overrides.session ?? new Session()

  const deps: ToolsDeps = {
    hosts,
    pool,
    session,
    config: {
      commandTimeoutMs: config.commandTimeoutMs,
      maxOutputChars: config.maxOutputChars,
      hostKeyPolicy: config.hostKeyPolicy,
    },
    ...(overrides.placeholderBaseDir !== undefined ? { placeholderBaseDir: overrides.placeholderBaseDir } : {}),
  }

  const tools = makeTools(deps)
  const routes = makeRoutes({ ...deps, pickDirectory: overrides.pickDirectory ?? adaptDirectoryPicker(ctx) })

  const promptText = (): string => {
    const alias = session.alias
    const workspace = session.workspace
    if (alias === null || workspace === null) {
      return [
        '## Remote workspace (dsh-rw)',
        'No remote workspace is active. When the task involves an SSH host, start with rw_hosts (list configured ' +
          'hosts), rw_connect(alias), then rw_pick_workspace(path) to choose the remote directory. Afterwards all ' +
          'rw_* file tools operate inside that remote workspace.',
      ].join('\n')
    }
    const entry = hosts.find(alias)
    const who = entry ? `${entry.user}@${entry.host}:${entry.port}` : alias
    return [
      '## Remote workspace (dsh-rw)',
      `Current remote workspace: ${who}:${workspace}`,
      'Use the rw_* tools (rw_list_dir / rw_read_file / rw_write_file / rw_mkdir / rw_move / rw_delete / rw_exec) ' +
        'to inspect and modify the remote host directly; the remote filesystem is the source of truth (no local ' +
        'mirror). All rw_* file paths are confined to the workspace root.',
    ].join('\n')
  }

  // Tools + routes + slash command under one effect so teardown unregisters
  // every surface in one pass.
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    for (const tool of tools) disposers.push(ctx.tools.register(tool as ToolDefinition))
    for (const route of routes) disposers.push(ctx.webServer.register(route))
    const commands = ctx.get('commands') as CommandsLike | undefined
    if (commands !== undefined && typeof commands.register === 'function') {
      const dispose = commands.register({
        name: 'rw',
        description: 'Show the dsh-rw remote workspace status (hosts, connection, workspace).',
        handler: () => ({ kind: 'success', text: statusText(deps) }),
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-rw: surfaces')

  // Prompt section: registered through effect so the section disappears with
  // the plugin fiber (section() returns its exact disposer).
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'dsh-rw',
        order: 88,
        text: promptText,
      }),
    'dsh-rw: prompt',
  )

  ctx.effect(() => () => pool.dispose(), 'dsh-rw: pool')
}
