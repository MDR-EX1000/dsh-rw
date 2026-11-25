import type { HostEntry, HostSummary } from './hosts.js';
import type { SessionStore } from './session.js';
import type { NativeRoutingTable } from './shim.js';
import type { ExecResult, RemoteShellChannel, SftpLike } from './ssh-pool.js';
/**
 * Structural subset of HostTable consumed by the tools/routes. HostTable has
 * private fields (nominally typed), so depending on this interface is what
 * lets tests supply an in-memory fake without casts; the real HostTable
 * satisfies it unchanged.
 */
export interface HostTableLike {
    list(): HostEntry[];
    find(alias: string): HostEntry | undefined;
    summarize(entry: HostEntry): HostSummary;
    summaries(): HostSummary[];
    addManual(payload: {
        alias: string;
        host: string;
        port?: number;
        user: string;
        password?: string;
        keyPath?: string;
        passphrase?: string;
    }): HostEntry;
    removeManual(alias: string): void;
    /** Drop an ssh-config alias from the list (never edits ~/.ssh/config). */
    hide?(alias: string): void;
    /** Put a hidden alias back. */
    unhide?(alias: string): void;
    /** Aliases currently hidden from the list. */
    hiddenAliases?(): string[];
    /**
     * Replace one manual host's connection details. Optional so a structural
     * double stays valid; the route reports 501 when a table cannot edit.
     */
    updateManual?(alias: string, payload: {
        host: string;
        port?: number;
        user: string;
        password?: string;
        keyPath?: string;
        passphrase?: string;
    }): HostEntry;
    /** The host's main remote directory (its default workspace in the picker), if set. */
    mainDir?(alias: string): string | undefined;
    /** Set (or with null, clear) the host's main remote directory. */
    setMainDir?(alias: string, path: string | null): void;
}
/** Structural subset of SshPool (same rationale as HostTableLike). */
export interface PoolLike {
    exec(entry: HostEntry, command: string, opts?: {
        cwd?: string;
        timeoutMs?: number;
    }): Promise<ExecResult>;
    sftp(entry: HostEntry): Promise<SftpLike>;
    /**
     * Open a long-lived shell channel. Optional so structural test doubles stay
     * valid; the persistent-shell manager reports a clear error when a pool
     * cannot provide one.
     */
    openShell?(entry: HostEntry): Promise<RemoteShellChannel>;
    testConnect(entry: HostEntry): Promise<number>;
    disconnect(alias: string): void;
    connected(): string[];
    dispose(): void;
}
export interface ToolsDeps {
    hosts: HostTableLike;
    pool: PoolLike;
    /** Per-session connection records (2.0: keyed by the DSH session id). */
    session: SessionStore;
    config: {
        commandTimeoutMs: number;
        maxOutputChars: number;
        /** Shown by rw_info; optional so minimal test configs still typecheck. */
        hostKeyPolicy?: string;
    };
    /** Mirror-layout placeholder root (plugin config placeholderRoot; tests inject a tmp dir). */
    placeholderRoot?: string;
    /**
     * Main directory of hosts that have none of their own (plugin config
     * defaultMainDir, '/'); '' or undefined means none.
     */
    defaultMainDir?: string;
    /** Legacy (≤ 1.6) placeholder base dir, searched by lookups only (tests inject a tmp dir). */
    placeholderBaseDir?: string;
    /** Where native tools actually go, as observed by the shim, per session id. */
    routing?: NativeRoutingTable;
    /** Whether the shim is currently on (a live getter: the settings layer can flip it). */
    shimEnabled?: () => boolean;
}
/**
 * The slice of the tool execution context this module reads. Structural on
 * purpose: the real value is a `ToolRunContext`, and tests drive plain objects.
 */
interface ExecLike {
    /** The calling agent; its `session.header` carries `id`, `cwd` and `parentSession`. */
    agent?: unknown;
}
/**
 * Resolve a remote directory the way a workspace pick does: `~` expansion
 * against the SFTP home, realpath (symlinks resolved), must be a directory.
 * Returns the normalized real path. Shared by the workspace pick and the
 * host main-directory route.
 */
export declare function resolveRemoteDir(deps: ToolsDeps, entry: HostEntry, path: string): Promise<string>;
/**
 * Shared pick-workspace validation used by rw_pick_workspace and the
 * /api/dsh-rw/workspace route: resolve the remote directory, then create its
 * local placeholder (mirror layout, plus the host-root placeholder). Returns
 * the real workspace path and the placeholder directory. Touches neither the
 * session records nor the DSH workspace registry.
 */
export declare function resolveWorkspaceDir(deps: ToolsDeps, alias: string, path: string): Promise<{
    workspace: string;
    placeholderDir: string;
}>;
/** Sync status lines shared by rw_info and the /rw slash command. */
export declare function statusText(deps: ToolsDeps, exec?: ExecLike): string;
/** The fixed number of rw_* tools, exported so the registration-order tests track it. */
export declare const RW_TOOL_COUNT = 16;
/** The twelve rw_* tools in their fixed registration order. */
export declare function makeTools(deps: ToolsDeps): unknown[];
export {};
