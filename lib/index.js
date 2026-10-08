import z from 'schemastery';
import { HostTable } from './hosts.js';
import { KnownHosts } from './known-hosts.js';
import { makeRoutes } from './routes.js';
import { Session } from './session.js';
import { createNativeRouting, makeShim } from './shim.js';
import { resolvePlaceholderDir } from './placeholder.js';
import { SshPool } from './ssh-pool.js';
import { makeTools, statusText } from './tools.js';
export const name = 'dsh-rw';
// webServer is INJECTED so apply() runs only after the web server is up and
// the /api/dsh-rw/* routes actually register.
export const inject = ['tools', 'systemPrompt', 'webServer'];
export const Config = z.object({
    /** Host key policy: verify against ~/.ssh/known_hosts (accept-new learns on first connect). */
    hostKeyPolicy: z.string().default('accept-new'),
    /** known_hosts file path (default ~/.ssh/known_hosts). */
    knownHostsPath: z.string().default(''),
    /** Per remote command timeout. */
    commandTimeoutMs: z.number().step(1).min(1000).default(30000),
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
});
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
});
/**
 * Adapt the ctx directoryPicker service (as used by dsh-remote's local-pick
 * endpoint) into a plain pick function. The service is resolved per call:
 * the web app's directory-picker row mounts its backend asynchronously during
 * boot (a nested loader.create), so a snapshot taken when this plugin applies
 * can miss a service that registers moments later. The returned function
 * throws a friendly Error when the service is absent or the backend is not
 * the native picker, and resolves null on cancel.
 */
function adaptDirectoryPicker(ctx) {
    // Use ctx.get('directoryPicker') only: property access ctx.directoryPicker
    // throws when the service is absent and 'directoryPicker' is not in inject.
    // The service is optional (provided by @deepseek-ai/dsh-host-directory-picker-*);
    // when absent the pick function degrades to a friendly Error.
    return async () => {
        const dp = ctx.get('directoryPicker');
        if (!dp || typeof dp.capability !== 'function') {
            throw new Error('local directory picker service is unavailable (no DSH directory-picker backend) — enter the path manually');
        }
        const cap = await dp.capability();
        if (!cap || cap.kind !== 'native' || typeof cap.pick !== 'function') {
            throw new Error('local directory picker is unavailable (non-native backend) — enter the local path manually');
        }
        const pickAbort = new AbortController();
        try {
            const picked = await cap.pick(pickAbort.signal);
            return typeof picked === 'string' && picked !== '' ? picked : null;
        }
        finally {
            pickAbort.abort();
        }
    };
}
export function apply(ctx, config, overrides = {}) {
    const hosts = overrides.hosts ?? new HostTable();
    const pool = overrides.pool ??
        new SshPool({
            hostKeyPolicy: config.hostKeyPolicy,
            knownHosts: new KnownHosts(config.knownHostsPath || KnownHosts.defaultPath()),
            connectTimeoutMs: config.connectTimeoutMs,
            channelOpenTimeoutMs: config.channelOpenTimeoutMs,
            commandTimeoutMs: config.commandTimeoutMs,
            maxOutputChars: config.maxOutputChars,
        });
    const session = overrides.session ?? new Session();
    // Shared observation of where native tools actually go; the shim writes it on
    // every dispatch, the prompt section and rw_info read it. Never inferred from
    // the session record alone — see promptText.
    const nativeRouting = createNativeRouting();
    const deps = {
        hosts,
        pool,
        session,
        config: {
            commandTimeoutMs: config.commandTimeoutMs,
            maxOutputChars: config.maxOutputChars,
            hostKeyPolicy: config.hostKeyPolicy,
        },
        routing: nativeRouting,
        shimEnabled: () => shimSettings.shim,
        ...(overrides.placeholderBaseDir !== undefined ? { placeholderBaseDir: overrides.placeholderBaseDir } : {}),
    };
    const tools = makeTools(deps);
    const routes = makeRoutes({ ...deps, pickDirectory: overrides.pickDirectory ?? adaptDirectoryPicker(ctx) });
    // The shim switches are mutable on purpose: the middlewares read them per
    // dispatch, so a settings-layer commit (or its absence) applies immediately
    // without re-registering anything. Initial values are the cordis entry
    // config — the base layer the settings overlay may later replace.
    const shimSettings = {
        shim: config.shim ?? true,
        shimBash: config.shimBash ?? true,
        shimBashApproval: config.shimBashApproval ?? 'ask',
        commandTimeoutMs: config.commandTimeoutMs,
        maxOutputChars: config.maxOutputChars,
    };
    const logShimConfig = (source) => {
        console.log(`[dsh-rw] shim config resolved (${source}): shim=${String(shimSettings.shim)} ` +
            `shimBash=${String(shimSettings.shimBash)} shimBashApproval=${shimSettings.shimBashApproval}`);
    };
    const promptText = () => {
        const alias = session.alias;
        const workspace = session.workspace;
        if (alias === null || workspace === null) {
            return [
                '## Remote workspace (dsh-rw)',
                'No remote workspace is active. When the task involves an SSH host, start with rw_hosts (list configured ' +
                    'hosts), rw_connect(alias), then rw_pick_workspace(path) to choose the remote directory. Afterwards all ' +
                    'rw_* file tools operate inside that remote workspace.',
            ].join('\n');
        }
        const entry = hosts.find(alias);
        const who = entry ? `${entry.user}@${entry.host}:${entry.port}` : alias;
        if (shimSettings.shim) {
            const native = shimSettings.shimBash
                ? 'read/write/edit/str_replace_editor/glob/grep/bash'
                : 'read/write/edit/str_replace_editor/glob/grep';
            const rwTools = 'The rw_* tools (rw_list_dir / rw_read_file / rw_write_file / rw_mkdir / rw_move / rw_delete / rw_exec) ' +
                'always address the remote host and are confined to the workspace root.';
            const placeholder = nativeRouting.placeholder ??
                resolvePlaceholderDir(alias, workspace, overrides.placeholderBaseDir) ??
                '(placeholder directory not found)';
            if (nativeRouting.mode === 'local') {
                // This session's cwd is a real local directory, so the shim passes the
                // native tools through to the local machine. Saying anything else here
                // is how a session ends up editing local files while believing it is
                // working on the remote.
                return [
                    '## Remote workspace (dsh-rw)',
                    `Current remote workspace: ${who}:${workspace}`,
                    `WARNING — the native ${native} tools are running on the LOCAL machine, not on the remote host: ` +
                        `this session's working directory (${nativeRouting.cwd ?? 'unknown'}) is not inside the dsh-rw ` +
                        `placeholder for that workspace (${placeholder}). Remote work needs the rw_* tools; to make the ` +
                        'native tools reach the remote, open the placeholder directory as this session\'s workspace. ' +
                        rwTools,
                ].join('\n');
            }
            if (nativeRouting.mode === 'remote') {
                // Observed: the session cwd lives inside the placeholder, so native
                // calls are translated. Steer the model to them — pushing rw_* here
                // would keep the shim dormant.
                return [
                    '## Remote workspace (dsh-rw)',
                    `Current remote workspace: ${who}:${workspace}`,
                    `This session's workspace is remote-backed: the native ${native} tools are translated to the remote ` +
                        'host automatically — use them exactly as if the workspace were local. ' +
                        `${rwTools} The remote filesystem is the source of truth (no local mirror).`,
                ].join('\n');
            }
            // Nothing observed yet (the plugin loaded after the last dispatch, or no
            // tool has run in this session): state the rule instead of claiming an
            // outcome, and point at the one call that reports it.
            return [
                '## Remote workspace (dsh-rw)',
                `Current remote workspace: ${who}:${workspace}`,
                `The native ${native} tools are translated to the remote host only while this session's working ` +
                    `directory is inside the dsh-rw placeholder directory (${placeholder}); calls rooted anywhere else run ` +
                    'on the local machine. No native tool call has been observed since the plugin loaded, so which of the ' +
                    'two is in effect is not known yet — call rw_info to see where the native tools actually go. ' +
                    rwTools,
            ].join('\n');
        }
        return [
            '## Remote workspace (dsh-rw)',
            `Current remote workspace: ${who}:${workspace}`,
            'Use the rw_* tools (rw_list_dir / rw_read_file / rw_write_file / rw_mkdir / rw_move / rw_delete / rw_exec) ' +
                'to inspect and modify the remote host directly; the remote filesystem is the source of truth (no local ' +
                'mirror). All rw_* file paths are confined to the workspace root.',
        ].join('\n');
    };
    // Tools + routes + slash command under one effect so teardown unregisters
    // every surface in one pass.
    ctx.effect(() => {
        const disposers = [];
        for (const tool of tools)
            disposers.push(ctx.tools.register(tool));
        for (const route of routes)
            disposers.push(ctx.webServer.register(route));
        const commands = ctx.get('commands');
        if (commands !== undefined && typeof commands.register === 'function') {
            const dispose = commands.register({
                name: 'rw',
                description: 'Show the dsh-rw remote workspace status (hosts, connection, workspace).',
                handler: () => ({ kind: 'success', text: statusText(deps) }),
            });
            if (typeof dispose === 'function')
                disposers.push(dispose);
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
            ...(overrides.placeholderBaseDir !== undefined ? { placeholderBaseDir: overrides.placeholderBaseDir } : {}),
            getTool: (toolName, agent) => ctx.tools.get(toolName, agent),
            // Never-ask detection for the pre-execute gate; absent/legacy approval
            // service → undefined → plain 'ask' behavior.
            approvalPolicyOf: (agentSession) => {
                const approval = ctx.get('approval');
                if (approval === undefined || typeof approval.effectivePolicy !== 'function')
                    return undefined;
                try {
                    return approval.effectivePolicy(agentSession);
                }
                catch {
                    return undefined;
                }
            },
        });
        disposers.push(ctx.on('tools/execute', shim.onExecute));
        disposers.push(ctx.on('tools/pre-execute', shim.onPreExecute));
        // Startup log is unconditional so a mis-delivered config shows up as shim=false here.
        logShimConfig('cordis base');
        return () => {
            for (const dispose of disposers)
                dispose();
        };
    }, 'dsh-rw: surfaces');
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
        const settings = sctx.settings;
        const register = settings.register;
        if (typeof register !== 'function') {
            logShimConfig('cordis base — no settings namespace API on this DSH');
            return undefined;
        }
        try {
            const scope = register.call(settings, 'dsh-rw', ShimSettingsSchema, {
                base: {
                    shim: config.shim ?? true,
                    shimBash: config.shimBash ?? true,
                    shimBashApproval: config.shimBashApproval ?? 'ask',
                },
            });
            const overlay = (value, source) => {
                shimSettings.shim = value.shim;
                shimSettings.shimBash = value.shimBash;
                shimSettings.shimBashApproval = value.shimBashApproval;
                logShimConfig(source);
            };
            overlay(scope.get(), 'cordis base + settings overlay');
            // The returned disposer rides the inject sub-fiber: unloading dsh-rw
            // disposes it, which also drops the namespace registration itself.
            return scope.watch((next) => overlay(next, 'settings overlay update'));
        }
        catch (err) {
            console.warn(`[dsh-rw] settings registration failed (${err instanceof Error ? err.message : String(err)}) — ` +
                'shim switches stay at the cordis entry config');
            return undefined;
        }
    });
    // Prompt section: registered through effect so the section disappears with
    // the plugin fiber (section() returns its exact disposer).
    ctx.effect(() => ctx.systemPrompt.section({
        name: 'dsh-rw',
        order: 88,
        text: promptText,
    }), 'dsh-rw: prompt');
    ctx.effect(() => () => pool.dispose(), 'dsh-rw: pool');
}
