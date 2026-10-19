import type { HostEntry } from './hosts.js';
import type { ExecResult, RemoteShellChannel } from './ssh-pool.js';
export interface ShellManagerOptions {
    /** Open a channel for one host (wired to `SshPool.openShell`). */
    open(entry: HostEntry): Promise<RemoteShellChannel>;
    /** Close a shell after this long without a command (default 10 minutes). */
    idleMs?: number;
}
/** The shim-facing contract, kept structural so tests can substitute it. */
export interface ShellManagerLike {
    run(entry: HostEntry, cwd: string, command: string, opts: {
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<ExecResult>;
    dispose(): void;
}
/**
 * Keeps one persistent shell per (alias, workspace). A shell that dies is
 * dropped and reopened transparently: the caller only ever sees the command
 * result, never a stale stream.
 */
export declare class PersistentShellManager implements ShellManagerLike {
    private readonly opts;
    private readonly shells;
    private readonly idleMs;
    private disposed;
    constructor(opts: ShellManagerOptions);
    run(entry: HostEntry, cwd: string, command: string, opts: {
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<ExecResult>;
    /** Close every shell (plugin teardown, or a disconnect). */
    dispose(): void;
    /** How many live shells are tracked — used by status reporting and tests. */
    get size(): number;
    private shellFor;
    private reopen;
}
