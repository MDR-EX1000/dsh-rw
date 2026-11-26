import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
import { SessionStore } from './session.js';
import type { HostTableLike, PoolLike } from './tools.js';
export declare const name = "dsh-rw";
export declare const inject: string[];
/** Host key verification policy for outbound SSH connections. */
export type HostKeyPolicy = 'accept-new' | 'strict' | 'off';
export declare const Config: z<Schemastery.ObjectS<{
    /** Host key policy: verify against ~/.ssh/known_hosts (accept-new learns on first connect). */
    hostKeyPolicy: z<string, string>;
    /** known_hosts file path (default ~/.ssh/known_hosts). */
    knownHostsPath: z<string, string>;
    /**
     * Which `~/.ssh/config` aliases become hosts. Empty = every alias (the
     * historical behaviour); shell-style globs, matched case-insensitively.
     * Use this to stop a machine full of build/test entries from flooding the
     * host list — `exclude` always wins over `include`.
     */
    sshConfigInclude: z<string[], string[]>;
    sshConfigExclude: z<string[], string[]>;
    /** Per remote command timeout. */
    commandTimeoutMs: z<number, number>;
    /** Total remote file-operation budget, including acquisition and cleanup. */
    operationTimeoutMs: z<number, number>;
    /** SSH connection establishment timeout. */
    connectTimeoutMs: z<number, number>;
    /** Channel/subsystem open timeout: bounds the wait on a silently dead connection before it is dropped and retried. */
    channelOpenTimeoutMs: z<number, number>;
    /** Hard ceiling on collected remote output per call. */
    maxOutputChars: z<number, number>;
    /** Shim mode: intercept DSH's native tools and translate them to remote execution. Default true: the agent uses native tools against the remote workspace out of the box. Set false in cordis config or in ~/.dsh/settings.yaml (`dsh-rw: shim: false`) to fall back to rw_*-only. */
    shim: z<boolean, boolean>;
    /** With shim on, also intercept bash (session cwd must be the placeholder workspace). */
    shimBash: z<boolean, boolean>;
    /** Shimmed bash approval: 'ask' escalates to the DSH approval dialog, 'native' defers to the native policy. */
    shimBashApproval: z<"ask" | "native", "ask" | "native">;
    /** Run the persistent-bash flavor on one long-lived remote shell per (host, workspace) instead of a fresh one-shot exec. Default true. */
    persistentShell: z<boolean, boolean>;
    /** Close a persistent shell after this many ms without a command (default 10 minutes). */
    persistentShellIdleMs: z<number, number>;
    /** Run native background bash calls as REMOTE jobs registered with ctx.jobs (default true). Off → such a call is refused rather than run locally. */
    backgroundJobs: z<boolean, boolean>;
    /** Poll cadence for a remote job's log (default 500 ms). */
    jobPollMs: z<number, number>;
    /** Remote directory holding background-job logs (default /tmp). */
    jobDir: z<string, string>;
    /**
     * Local directory holding the placeholder directories (one mirror tree per
     * host). Empty = the default: /Users/Shared/dsh-rw-<user> on macOS (outside
     * ~, so each host is a top-level node in DSH's workspace tree), else
     * ~/.dsh/rw-workspaces. Must be a real directory owned by you; it is kept 0700.
     */
    placeholderRoot: z<string, string>;
    /**
     * Main directory of every host that has none of its own (set per host in the
     * picker). The picker opens a host there, and the workspace picked there is
     * titled by the bare host alias, i.e. it is the host's node in the sidebar.
     * Empty = none (the picker opens the remote home).
     */
    defaultMainDir: z<string, string>;
}>, Schemastery.ObjectT<{
    /** Host key policy: verify against ~/.ssh/known_hosts (accept-new learns on first connect). */
    hostKeyPolicy: z<string, string>;
    /** known_hosts file path (default ~/.ssh/known_hosts). */
    knownHostsPath: z<string, string>;
    /**
     * Which `~/.ssh/config` aliases become hosts. Empty = every alias (the
     * historical behaviour); shell-style globs, matched case-insensitively.
     * Use this to stop a machine full of build/test entries from flooding the
     * host list — `exclude` always wins over `include`.
     */
    sshConfigInclude: z<string[], string[]>;
    sshConfigExclude: z<string[], string[]>;
    /** Per remote command timeout. */
    commandTimeoutMs: z<number, number>;
    /** Total remote file-operation budget, including acquisition and cleanup. */
    operationTimeoutMs: z<number, number>;
    /** SSH connection establishment timeout. */
    connectTimeoutMs: z<number, number>;
    /** Channel/subsystem open timeout: bounds the wait on a silently dead connection before it is dropped and retried. */
    channelOpenTimeoutMs: z<number, number>;
    /** Hard ceiling on collected remote output per call. */
    maxOutputChars: z<number, number>;
    /** Shim mode: intercept DSH's native tools and translate them to remote execution. Default true: the agent uses native tools against the remote workspace out of the box. Set false in cordis config or in ~/.dsh/settings.yaml (`dsh-rw: shim: false`) to fall back to rw_*-only. */
    shim: z<boolean, boolean>;
    /** With shim on, also intercept bash (session cwd must be the placeholder workspace). */
    shimBash: z<boolean, boolean>;
    /** Shimmed bash approval: 'ask' escalates to the DSH approval dialog, 'native' defers to the native policy. */
    shimBashApproval: z<"ask" | "native", "ask" | "native">;
    /** Run the persistent-bash flavor on one long-lived remote shell per (host, workspace) instead of a fresh one-shot exec. Default true. */
    persistentShell: z<boolean, boolean>;
    /** Close a persistent shell after this many ms without a command (default 10 minutes). */
    persistentShellIdleMs: z<number, number>;
    /** Run native background bash calls as REMOTE jobs registered with ctx.jobs (default true). Off → such a call is refused rather than run locally. */
    backgroundJobs: z<boolean, boolean>;
    /** Poll cadence for a remote job's log (default 500 ms). */
    jobPollMs: z<number, number>;
    /** Remote directory holding background-job logs (default /tmp). */
    jobDir: z<string, string>;
    /**
     * Local directory holding the placeholder directories (one mirror tree per
     * host). Empty = the default: /Users/Shared/dsh-rw-<user> on macOS (outside
     * ~, so each host is a top-level node in DSH's workspace tree), else
     * ~/.dsh/rw-workspaces. Must be a real directory owned by you; it is kept 0700.
     */
    placeholderRoot: z<string, string>;
    /**
     * Main directory of every host that has none of its own (set per host in the
     * picker). The picker opens a host there, and the workspace picked there is
     * titled by the bare host alias, i.e. it is the host's node in the sidebar.
     * Empty = none (the picker opens the remote home).
     */
    defaultMainDir: z<string, string>;
}>>;
export interface Config {
    hostKeyPolicy: HostKeyPolicy;
    knownHostsPath: string;
    sshConfigInclude?: readonly string[];
    sshConfigExclude?: readonly string[];
    commandTimeoutMs: number;
    operationTimeoutMs?: number;
    connectTimeoutMs: number;
    channelOpenTimeoutMs: number;
    maxOutputChars: number;
    /** Optional so hand-built test configs still typecheck; apply() re-normalizes with the schema defaults. */
    shim?: boolean;
    shimBash?: boolean;
    shimBashApproval?: 'ask' | 'native';
    /** Optional so hand-built test configs still typecheck (schema default: true). */
    persistentShell?: boolean;
    persistentShellIdleMs?: number;
    backgroundJobs?: boolean;
    jobPollMs?: number;
    jobDir?: string;
    /** Placeholder root ('' or absent = the platform default). */
    placeholderRoot?: string;
    /** Main directory of hosts without their own (absent = '/'; '' = none). */
    defaultMainDir?: string;
}
/**
 * Test seams for apply(): the DSH loader calls apply(ctx, config); tests pass
 * in-memory fakes plus tmp paths so nothing touches the real ~/.ssh or ~/.dsh.
 */
export interface ApplyOverrides {
    hosts?: HostTableLike;
    pool?: PoolLike;
    /** Per-session record store (tests inject one over a tmp file). */
    session?: SessionStore;
    /** Mirror-layout placeholder root (wins over config.placeholderRoot). */
    placeholderRoot?: string;
    /** Legacy (≤ 1.6) placeholder base, searched by lookups only. */
    placeholderBaseDir?: string;
    pickDirectory?: () => Promise<string | null>;
}
export declare function apply(ctx: Context, config: Config, overrides?: ApplyOverrides): void;
