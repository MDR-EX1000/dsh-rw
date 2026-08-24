import type { HostEntry, HostSummary } from './hosts.js';
import type { Session } from './session.js';
import type { ExecResult, SftpLike } from './ssh-pool.js';
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
}
/** Structural subset of SshPool (same rationale as HostTableLike). */
export interface PoolLike {
    exec(entry: HostEntry, command: string, opts?: {
        cwd?: string;
        timeoutMs?: number;
    }): Promise<ExecResult>;
    sftp(entry: HostEntry): Promise<SftpLike>;
    testConnect(entry: HostEntry): Promise<number>;
    disconnect(alias: string): void;
    connected(): string[];
    dispose(): void;
}
export interface ToolsDeps {
    hosts: HostTableLike;
    pool: PoolLike;
    session: Session;
    config: {
        commandTimeoutMs: number;
        maxOutputChars: number;
        /** Shown by rw_info; optional so minimal test configs still typecheck. */
        hostKeyPolicy?: string;
    };
    /** Base dir for placeholder dirs (tests inject a tmp dir). */
    placeholderBaseDir?: string;
}
/**
 * Shared pick-workspace validation used by rw_pick_workspace and the
 * /api/dsh-rw/workspace route: resolve symlinks via realpath, require a
 * directory, create the local placeholder. Returns the real workspace path
 * and the placeholder directory. Does not touch the session. `name` (picker
 * only) names a fresh placeholder; the tool flow omits it (basename default).
 */
export declare function resolveWorkspaceDir(deps: ToolsDeps, alias: string, path: string, name?: string): Promise<{
    workspace: string;
    placeholderDir: string;
}>;
/** Sync status lines shared by rw_info and the /rw slash command. */
export declare function statusText(deps: ToolsDeps): string;
/** The twelve rw_* tools in their fixed registration order. */
export declare function makeTools(deps: ToolsDeps): unknown[];
