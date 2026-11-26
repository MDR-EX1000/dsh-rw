import type { RemoteIoOptions } from './io-context.js';
import type { HostEntry } from './hosts.js';
import type { ExecResult, RemoteShellChannel } from './ssh-pool.js';
export interface ShellManagerOptions {
    /** The manager-owned opener must honor options and quiesce on cancellation. */
    open(entry: HostEntry, options?: RemoteIoOptions): Promise<RemoteShellChannel>;
    idleMs?: number;
}
export interface ShellManagerLike {
    run(entry: HostEntry, cwd: string, command: string, opts: {
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<ExecResult>;
    dispose(): void;
}
export declare class PersistentShellManager implements ShellManagerLike {
    private readonly opts;
    private readonly shells;
    private readonly controller;
    private readonly idleMs;
    private disposed;
    constructor(opts: ShellManagerOptions);
    run(entry: HostEntry, cwd: string, command: string, opts: {
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<ExecResult>;
    dispose(): void;
    get size(): number;
    private shellFor;
    private reopen;
}
