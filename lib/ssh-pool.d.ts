import type { Client } from 'ssh2';
import type { HostEntry } from './hosts.js';
import type { KnownHosts } from './known-hosts.js';
import type { RemoteIoOptions } from './io-context.js';
export type { RemoteIoOptions } from './io-context.js';
export interface ExecResult {
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}
interface StatLike {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtime: number;
}
export interface SftpLike {
    readdir(p: string): Promise<{
        filename: string;
        longname: string;
        attrs: StatLike;
    }[]>;
    stat(p: string): Promise<StatLike>;
    lstat(p: string): Promise<StatLike>;
    realpath(p: string): Promise<string>;
    readFile(p: string): Promise<Buffer>;
    writeFile(p: string, data: Buffer): Promise<void>;
    mkdir(p: string): Promise<void>;
    rename(src: string, dst: string): Promise<void>;
    unlink(p: string): Promise<void>;
    rmdir(p: string): Promise<void>;
    /** Terminal local release of this facade and its own subsystem. */
    close?(): void | Promise<void>;
}
export interface RemoteShellChannel {
    write(data: string): void;
    onData(cb: (chunk: Buffer) => void): void | (() => void);
    onError(cb: (err: Error) => void): void | (() => void);
    onClose(cb: () => void): void | (() => void);
    close(): void;
}
export interface PoolOptions {
    hostKeyPolicy: 'accept-new' | 'strict' | 'off';
    knownHosts: KnownHosts;
    connectTimeoutMs: number;
    channelOpenTimeoutMs?: number;
    commandTimeoutMs: number;
    /** Default deadline for each SFTP business operation (30s). */
    operationTimeoutMs?: number;
    maxOutputChars: number;
    clientFactory?: () => Client;
}
export declare class SshPool {
    private readonly opts;
    private readonly factory;
    private readonly pool;
    private readonly readyAliases;
    private readonly retired;
    private readonly retirementListeners;
    constructor(opts: PoolOptions);
    private listenRetired;
    /** Retire the exact generation; an old event can never close a replacement. */
    private retire;
    private waitReady;
    /** The command budget includes connect/open/run. After dispatch, no replay. */
    exec(entry: HostEntry, command: string, options?: RemoteIoOptions & {
        cwd?: string;
    }): Promise<ExecResult>;
    private execOn;
    sftp(entry: HostEntry, options?: RemoteIoOptions): Promise<SftpLike>;
    private openSftp;
    testConnect(entry: HostEntry, options?: RemoteIoOptions): Promise<number>;
    disconnect(alias: string): void;
    dispose(): void;
    connected(): string[];
    /** Opening is caller-bounded; a successful channel transfers to its manager. */
    openShell(entry: HostEntry, command?: string, options?: RemoteIoOptions): Promise<RemoteShellChannel>;
    /** A shared dial is pool-owned; one cancelled waiter cannot cancel other waiters. */
    private ensureConnected;
    private buildConfig;
    private verifyHostKey;
}
