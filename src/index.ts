// dsh-rw — Remote-SSH-style workspace for DeepSeek Harness.
//
// Host half. The remote filesystem is the source of truth: the agent works on
// a remote directory through rw_* tools (SFTP/exec over a persistent ssh2
// pool). The local directory registered with DSH is only a placeholder so the
// native workspace flow accepts it — it never holds a copy of remote files.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { HostTable } from './hosts.js'
import { RwError } from './errors.js'
import { KnownHosts } from './known-hosts.js'
import { makeRoutes } from './routes.js'
import type { WorkspaceRegistryLike } from './routes.js'
import { SessionStore, sessionHeaderOf, sessionKeysOf } from './session.js'
import { createNativeRouting, makeShim } from './shim.js'
import type { ShimConfig } from './shim.js'
import { findPlaceholderByPath, placeholderLocationsOf, resolvePlaceholderDir } from './placeholder.js'
import { SshPool } from './ssh-pool.js'
import { DEFAULT_OPERATION_TIMEOUT_MS } from './io-context.js'
import { PersistentShellManager } from './persistent-shell.js'
import type { JobsRegistryLike } from './jobs.js'
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
  /**
   * Which `~/.ssh/config` aliases become hosts. Empty = every alias (the
   * historical behaviour); shell-style globs, matched case-insensitively.
   * Use this to stop a machine full of build/test entries from flooding the
   * host list — `exclude` always wins over `include`.
   */
  sshConfigInclude: z.array(z.string()).default([]),
  sshConfigExclude: z.array(z.string()).default([]),
  /** Per remote command timeout. */
  commandTimeoutMs: z.number().step(1).min(1000).default(30000),
  /** Total remote file-operation budget, including acquisition and cleanup. */
  operationTimeoutMs: z.number().step(1).min(1000).default(30000),
  /** SSH connection establishment timeout. */
  connectTimeoutMs: z.number().step(1).min(1000).default(15000),
  /** Channel/subsystem open timeout: bounds the wait on a silently dead connection before it is dropped and retried. */
  channelOpenTimeoutMs: z.number().step(1).min(1000).default(10000),
  /** Hard ceiling on collected remote output per call. */
  maxOutputChars: z.number().step(1).min(1024).default(200000),
  /** Shim mode: intercept DSH's native tools and translate them to remote execution. Default true: the agent uses native tools against the remote workspace out of the box. Set false in cordis config or in ~/.dsh/settings.yaml (`dsh-rw: shim: false`) to fall back to rw_*-only. */
  shim: z.boolean().default(true),
  /** With shim on, also intercept bash (session cwd must be the placeholder workspace). */
  shimBash: z.boolean().default(true),
  /** Shimmed bash approval: 'ask' escalates to the DSH approval dialog, 'native' defers to the native policy. */
  shimBashApproval: z.union(['ask', 'native']).default('ask'),
  /** Run the persistent-bash flavor on one long-lived remote shell per (host, workspace) instead of a fresh one-shot exec. Default true. */
  persistentShell: z.boolean().default(true),
  /** Close a persistent shell after this many ms without a command (default 10 minutes). */
  persistentShellIdleMs: z.number().step(1).min(0).default(600000),
  /** Run native background bash calls as REMOTE jobs registered with ctx.jobs (default true). Off → such a call is refused rather than run locally. */
  backgroundJobs: z.boolean().default(true),
  /** Poll cadence for a remote job's log (default 500 ms). */
  jobPollMs: z.number().step(1).min(50).default(500),
  /** Remote directory holding background-job logs (default /tmp). */
  jobDir: z.string().default('/tmp'),
  /**
   * Local directory holding the placeholder directories (one mirror tree per
   * host). Empty = the default: /Users/Shared/dsh-rw-<user> on macOS (outside
   * ~, so each host is a top-level node in DSH's workspace tree), else
   * ~/.dsh/rw-workspaces. Must be a real directory owned by you; it is kept 0700.
   */
  placeholderRoot: z.string().default(''),
  /**
   * Main directory of every host that has none of its own (set per host in the
   * picker). The picker opens a host there, and the workspace picked there is
   * titled by the bare host alias, i.e. it is the host's node in the sidebar.
   * Empty = none (the picker opens the remote home).
   */
  defaultMainDir: z.string().default('/'),
})

export interface Config {
  hostKeyPolicy: HostKeyPolicy
  knownHostsPath: string
  sshConfigInclude?: readonly string[]
  sshConfigExclude?: readonly string[]
  commandTimeoutMs: number
  operationTimeoutMs?: number
  connectTimeoutMs: number
  channelOpenTimeoutMs: number
  maxOutputChars: number
  /** Optional so hand-built test configs still typecheck; apply() re-normalizes with the schema defaults. */
  shim?: boolean
  shimBash?: boolean
  shimBashApproval?: 'ask' | 'native'
  /** Optional so hand-built test configs still typecheck (schema default: true). */
  persistentShell?: boolean
  persistentShellIdleMs?: number
  backgroundJobs?: boolean
  jobPollMs?: number
  jobDir?: string
  /** Placeholder root ('' or absent = the platform default). */
  placeholderRoot?: string
  /** Main directory of hosts without their own (absent = '/'; '' = none). */
  defaultMainDir?: string
}

/**
 * Settings-layer schema for the DSH 0.1.2 namespace API only: it declares which
 * of `Config`'s keys the `dsh-rw` namespace may carry, resolved as schema
 * defaults → the cordis entry config (register `base`) → the user's `dsh-rw:`
 * section in ~/.dsh/settings.yaml. DSH 0.1.7+ derives namespaces from the
 * plugin's own `Config` schema instead and never calls this — see the settings
 * inject below.
 */
const ShimSettingsSchema = z.object({
  shim: z.boolean().default(true),
  shimBash: z.boolean().default(true),
  shimBashApproval: z.union(['ask', 'native']).default('ask'),
})

/** The resolved shim switches, as carried by the settings layer. */
interface ShimSwitches {
  shim: boolean
  shimBash: boolean
  shimBashApproval: 'ask' | 'native'
}

/**
 * The DSH 0.1.2 settings-namespace API, declared structurally on purpose: DSH
 * 0.1.7+ (and 0.2) dropped `register` from the `settings` service, so this has
 * to compile against a runtime whose service does not have the method at all.
 */
interface LegacySettingsRegistrar {
  register(
    ns: string,
    schema: unknown,
    options: { base: ShimSwitches },
  ): {
    get(): ShimSwitches
    watch(onChange: (next: ShimSwitches) => void): () => void
  }
}

/**
 * Test seams for apply(): the DSH loader calls apply(ctx, config); tests pass
 * in-memory fakes plus tmp paths so nothing touches the real ~/.ssh or ~/.dsh.
 */
export interface ApplyOverrides {
  hosts?: HostTableLike
  pool?: PoolLike
  /** Per-session record store (tests inject one over a tmp file). */
  session?: SessionStore
  /** Mirror-layout placeholder root (wins over config.placeholderRoot). */
  placeholderRoot?: string
  /** Legacy (≤ 1.6) placeholder base, searched by lookups only. */
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
 * endpoint) into a plain pick function. The service is resolved per call:
 * the web app's directory-picker row mounts its backend asynchronously during
 * boot (a nested loader.create), so a snapshot taken when this plugin applies
 * can miss a service that registers moments later. The returned function
 * throws a friendly Error when the service is absent or the backend is not
 * the native picker, and resolves null on cancel.
 */
function adaptDirectoryPicker(ctx: Context): () => Promise<string | null> {
  // Use ctx.get('directoryPicker') only: property access ctx.directoryPicker
  // throws when the service is absent and 'directoryPicker' is not in inject.
  // The service is optional (provided by @deepseek-ai/dsh-host-directory-picker-*);
  // when absent the pick function degrades to a friendly Error.
  return async () => {
    const dp = ctx.get('directoryPicker') as
      | DirectoryPickerLike
      | null
      | undefined
    if (!dp || typeof dp.capability !== 'function') {
      throw new Error(
        'local directory picker service is unavailable (no DSH directory-picker backend) — use the in-app local browser',
      )
    }
    const cap = await dp.capability()
    if (!cap || cap.kind !== 'native' || typeof cap.pick !== 'function') {
      throw new Error('local directory picker needs the native backend (this DSH composes a different one) — use the in-app local browser')
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
  const hosts =
    overrides.hosts ??
    new HostTable({
      sshConfigInclude: config.sshConfigInclude ?? [],
      sshConfigExclude: config.sshConfigExclude ?? [],
    })
  const pool =
    overrides.pool ??
    new SshPool({
      hostKeyPolicy: config.hostKeyPolicy,
      knownHosts: new KnownHosts(config.knownHostsPath || KnownHosts.defaultPath()),
      connectTimeoutMs: config.connectTimeoutMs,
      channelOpenTimeoutMs: config.channelOpenTimeoutMs,
      commandTimeoutMs: config.commandTimeoutMs,
      operationTimeoutMs: config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      maxOutputChars: config.maxOutputChars,
    })
  const session = overrides.session ?? new SessionStore()
  // Placeholder locations: the mirror root (overrides → plugin config → the
  // platform default inside placeholder.ts) and the legacy base for lookups.
  const configuredRoot =
    config.placeholderRoot !== undefined && config.placeholderRoot !== '' ? config.placeholderRoot : undefined
  const placeholderRoot = overrides.placeholderRoot ?? configuredRoot
  const placeholderPaths: { placeholderRoot?: string; placeholderBaseDir?: string } = {
    ...(placeholderRoot !== undefined ? { placeholderRoot } : {}),
    ...(overrides.placeholderBaseDir !== undefined ? { placeholderBaseDir: overrides.placeholderBaseDir } : {}),
  }
  // Per-session observation of where native tools actually go: the shim writes
  // it on every dispatch, rw_info reads the caller's entry.
  const nativeRouting = createNativeRouting()
  // One long-lived remote shell per (host, workspace) backs the persistent-bash
  // flavor; ids are the pool's own so channel opens behave like every other op.
  const shells = new PersistentShellManager({
    open: (entry, io) => {
      if (pool.openShell === undefined) throw new Error('this pool cannot open a persistent shell')
      return pool.openShell(entry, undefined, io)
    },
    idleMs: config.persistentShellIdleMs ?? 600000,
  })

  const deps: ToolsDeps = {
    hosts,
    pool,
    session,
    config: {
      commandTimeoutMs: config.commandTimeoutMs,
      operationTimeoutMs: config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      maxOutputChars: config.maxOutputChars,
      hostKeyPolicy: config.hostKeyPolicy,
    },
    routing: nativeRouting,
    shimEnabled: () => shimSettings.shim,
    defaultMainDir: config.defaultMainDir ?? '/',
    ...placeholderPaths,
  }

  const tools = makeTools(deps)
  const routes = makeRoutes({
    ...deps,
    pickDirectory: overrides.pickDirectory ?? adaptDirectoryPicker(ctx),
    // Resolved per call: the registry is optional and may mount after us.
    workspaceRegistry: () => {
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | null | undefined
      return registry !== null && registry !== undefined && typeof registry.create === 'function' ? registry : undefined
    },
  })

  // The shim switches are mutable on purpose: the middlewares read them per
  // dispatch, so a settings-layer commit (or its absence) applies immediately
  // without re-registering anything. Initial values are the cordis entry
  // config — the base layer the settings overlay may later replace.
  const shimSettings: ShimConfig = {
    shim: config.shim ?? true,
    shimBash: config.shimBash ?? true,
    shimBashApproval: config.shimBashApproval ?? 'ask',
    commandTimeoutMs: config.commandTimeoutMs,
    operationTimeoutMs: config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    maxOutputChars: config.maxOutputChars,
    persistentShell: config.persistentShell ?? true,
    backgroundJobs: config.backgroundJobs ?? true,
  }
  // The host job registry is optional (no jobs plugin → no background jobs).
  // Its absence is reported per call; it never falls back to running locally.
  const jobs = ctx.get('jobs') as JobsRegistryLike | undefined
  const logShimConfig = (source: string): void => {
    console.log(
      `[dsh-rw] shim config resolved (${source}): shim=${String(shimSettings.shim)} ` +
        `shimBash=${String(shimSettings.shimBash)} shimBashApproval=${shimSettings.shimBashApproval}`,
    )
  }

  // The prompt section is a function of the assembling agent: DSH passes the
  // Agent itself as `context.scope`, whose session header carries the session
  // id, cwd and parentSession. The text depends only on that session's cwd and
  // dsh-rw record — never on the last native call — so it stays stable for the
  // whole session instead of flipping between assemblies.
  const promptText = (context?: AssembleContext): string => {
    const header = sessionHeaderOf(context?.scope)
    const heading = '## Remote workspace (dsh-rw)'
    const rwTools =
      'The rw_* tools (rw_list_dir / rw_read_file / rw_write_file / rw_mkdir / rw_move / rw_delete / rw_exec / ' +
      'rw_apply_patch …) always address the remote host and are confined to the workspace root. ' +
      'A timed-out, cancelled or disconnected write/edit/delete/patch/command can have executed already: ' +
      'treat its outcome as unknown and verify remote state before retrying any mutation.'
    const nativeList = shimSettings.shimBash
      ? 'read/write/edit/str_replace_editor/glob/grep/bash'
      : 'read/write/edit/str_replace_editor/glob/grep'
    const whoOf = (alias: string): string => {
      const entry = hosts.find(alias)
      return entry ? `${entry.user}@${entry.host}:${entry.port}` : `${alias} (no longer configured)`
    }

    // 1) The session works inside a placeholder: it IS a remote workspace.
    let found: ReturnType<typeof findPlaceholderByPath> = null
    try {
      found = header.cwd !== undefined ? findPlaceholderByPath(header.cwd, placeholderLocationsOf(placeholderPaths)) : null
    } catch (err) {
      if (!(err instanceof RwError)) throw err
      return [heading, `This remote workspace is blocked: ${err.message}`,
        'Do not run native file/command tools in this placeholder until its host namespace is fixed. ' +
        'Choose a distinct SSH alias or placeholderRoot; unrelated local tools remain available.'].join('\n')
    }
    if (found !== null) {
      const { meta, dir } = found
      if (hosts.find(meta.alias) === undefined) {
        return [
          heading,
          `This session's working directory is the dsh-rw placeholder ${dir} for host alias '${meta.alias}' ` +
            `(remote ${meta.remotePath}), but that host is no longer configured. Native tools and rw_* refuse to run ` +
            `against the empty local stand-in — re-add the host (rw_hosts) and rw_connect('${meta.alias}').`,
        ].join('\n')
      }
      const native = shimSettings.shim
        ? `The native ${nativeList} tools are translated to the remote host automatically: paths inside ${dir} map ` +
          `to ${meta.remotePath} on the host, and commands run there. Use them exactly as if the workspace were local.`
        : `The dsh-rw shim is off, so the native tools act on the EMPTY local placeholder — use the rw_* tools for ` +
          'every file and command operation.'
      return [
        heading,
        `This session is a remote workspace: host alias '${meta.alias}' (${whoOf(meta.alias)}), remote root ` +
          `${meta.remotePath}. The local working directory ${dir} is only an empty placeholder (no copy of remote files).`,
        `${native} ${rwTools} The remote filesystem is the single source of truth.`,
      ].join('\n')
    }

    // 2) A local session that connected via rw_connect / rw_pick_workspace.
    const record = session.get(sessionKeysOf(context?.scope))
    if (record.alias !== null) {
      const where =
        record.workspace !== null
          ? `workspace ${record.workspace}`
          : 'no workspace picked yet (call rw_pick_workspace(path); file tools need one)'
      let placeholder: string | null = null
      let recordWarning = ''
      try {
        placeholder = record.workspace !== null
          ? resolvePlaceholderDir(record.alias, record.workspace, placeholderLocationsOf(placeholderPaths)) : null
      } catch (err) {
        if (!(err instanceof RwError)) throw err
        recordWarning = ` The stored remote namespace is blocked: ${err.message}`
      }
      const native = shimSettings.shim
        ? `The native ${nativeList} tools run on the LOCAL machine in this session, except calls whose path ` +
          'argument lies inside a dsh-rw placeholder directory' +
          (placeholder !== null ? ` (e.g. ${placeholder})` : '') +
          ', which are translated to the remote host.'
        : 'The native tools run on the LOCAL machine (the dsh-rw shim is off).'
      return [
        heading,
        `Current remote workspace: ${whoOf(record.alias)}:${record.workspace ?? '(none)'}`,
        `This session's rw_* tools are connected to host alias '${record.alias}' (${whoOf(record.alias)}), ${where}.`,
        `${native} ${rwTools} Use the rw_* tools for remote work; the remote filesystem is the source of truth (no local mirror).${recordWarning}`,
      ].join('\n')
    }

    // 3) Nothing remote in this session.
    return [
      heading,
      'No remote workspace is active in this session. When the task involves an SSH host, start with rw_hosts (list ' +
        'configured hosts), rw_connect(alias), then rw_pick_workspace(path) to choose the remote directory. Afterwards ' +
        'all rw_* file tools operate inside that remote workspace; native tools keep running locally unless the ' +
        'session is opened in a dsh-rw workspace.',
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
    // Shim middlewares: registered unconditionally — with shim=false they are
    // a pure pass-through (first line is next()), which keeps the settings
    // hot-reload path registration-free. They live in this same effect so
    // plugin teardown unregisters them together with the tools.
    const shim = makeShim({
      hosts,
      pool,
      session,
      config: shimSettings,
      routing: nativeRouting,
      shells,
      ...(jobs !== undefined ? { jobs } : {}),
      jobPollMs: config.jobPollMs,
      jobDir: config.jobDir,
      ...placeholderPaths,
      getTool: (toolName, agent) => ctx.tools.get(toolName, agent as Parameters<Context['tools']['get']>[1]),
      // Never-ask detection for the pre-execute gate; absent/legacy approval
      // service → undefined → plain 'ask' behavior.
      approvalPolicyOf: (agentSession) => {
        const approval = ctx.get('approval') as { effectivePolicy?: (session: unknown) => string } | undefined
        if (approval === undefined || typeof approval.effectivePolicy !== 'function') return undefined
        try {
          return approval.effectivePolicy(agentSession)
        } catch {
          return undefined
        }
      },
    })
    disposers.push(ctx.on('tools/execute', shim.onExecute))
    disposers.push(ctx.on('tools/pre-execute', shim.onPreExecute))
    // Startup log is unconditional so a mis-delivered config shows up as shim=false here.
    logShimConfig('cordis base')
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-rw: surfaces')

  // Settings layer, and the only place the two DSH settings models diverge.
  //
  // DSH 0.1.2: a per-plugin settings NAMESPACE. `settings.register(ns, schema,
  // { base })` returns a scope resolved as schema defaults → the cordis entry
  // config → the user's `dsh-rw:` section in ~/.dsh/settings.yaml, with a
  // watcher that hot-reloads a commit into the live switches.
  //
  // DSH 0.1.7+ / 0.2: that API is gone. Namespaces are DERIVED from the
  // plugin's own `Config` schema (below) and edited through the profile
  // composition, which is the cordis entry config this apply() already
  // received — so there is no second layer to overlay and nothing to watch.
  //
  // Both lines still mount a `settings` service, so the inject callback fires
  // either way: the model is selected by the method, never by a version check.
  // With no settings service, or with one that dropped `register`, the cordis
  // entry config logged above stays in charge.
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings as unknown as Partial<LegacySettingsRegistrar>
    const register = settings.register
    if (typeof register !== 'function') {
      logShimConfig('cordis base — no settings namespace API on this DSH')
      return undefined
    }
    try {
      const scope = register.call(settings, 'dsh-rw', ShimSettingsSchema, {
        base: {
          shim: config.shim ?? true,
          shimBash: config.shimBash ?? true,
          shimBashApproval: config.shimBashApproval ?? 'ask',
        },
      })
      const overlay = (value: ShimSwitches, source: string): void => {
        shimSettings.shim = value.shim
        shimSettings.shimBash = value.shimBash
        shimSettings.shimBashApproval = value.shimBashApproval
        logShimConfig(source)
      }
      overlay(scope.get(), 'cordis base + settings overlay')
      // The returned disposer rides the inject sub-fiber: unloading dsh-rw
      // disposes it, which also drops the namespace registration itself.
      return scope.watch((next) => overlay(next, 'settings overlay update'))
    } catch (err) {
      console.warn(
        `[dsh-rw] settings registration failed (${err instanceof Error ? err.message : String(err)}) — ` +
          'shim switches stay at the cordis entry config',
      )
      return undefined
    }
  })

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

  ctx.effect(
    () => () => {
      shells.dispose()
      pool.dispose()
    },
    'dsh-rw: pool',
  )
}
