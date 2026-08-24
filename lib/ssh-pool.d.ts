import type { Client } from 'ssh2';
import type { HostEntry } from './hosts.js';
import type { KnownHosts } from './known-hosts.js';
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
/** Promisified SFTP subset consumed directly by the P3 file layer. */
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
}
export interface PoolOptions {
    hostKeyPolicy: 'accept-new' | 'strict' | 'off';
    knownHosts: KnownHosts;
    connectTimeoutMs: number;
    /** Channel/subsystem open timeout (default 10s): bounds the wait on a silently dead connection. */
    channelOpenTimeoutMs?: number;
    commandTimeoutMs: number;
    maxOutputChars: number;
    /** Test hook; defaults to () => new ssh2.Client(). */
    clientFactory?: () => Client;
}
export declare class SshPool {
    private readonly opts;
    private readonly factory;
    private readonly pool;
    private readonly readyAliases;
    constructor(opts: PoolOptions);
    /**
     * Run a remote command. opts.cwd prefixes `cd <cwd> &&`. Command timeouts
     * do not reject — they resolve with timedOut: true (signal 'TIMEOUT').
     * Connection/auth/host-key failures reject with RwError. When the channel
     * open fails on a connection that has already dropped out of the pool (it
     * died), the operation is retried once on a fresh connection; stream
     * failures after a successful open are never retried (the command may have
     * partially run).
     */
    exec(entry: HostEntry, command: string, opts?: {
        cwd?: string;
        timeoutMs?: number;
    }): Promise<ExecResult>;
    /** Single exec attempt on an already-connected client. */
    private execOn;
    /**
     * Acquire the SFTP subsystem. The open is bounded by channelOpenTimeoutMs
     * and retried once when it fails or times out on a dead connection, and
     * each returned op re-acquires the subsystem and retries once when its
     * connection died after acquisition. Remote business errors (the client
     * stays pooled) surface unchanged.
     */
    sftp(entry: HostEntry): Promise<SftpLike>;
    /** Round-trip probe: resolves with the latency in ms, rejects with RwError. */
    testConnect(entry: HostEntry): Promise<number>;
    disconnect(alias: string): void;
    /**
     * Connection-level retry discriminator: the pool no longer holds this
     * client, i.e. ssh2 signalled its death and it dropped out. Remote business
     * errors keep the client pooled, so they never pass this check.
     */
    private dropped;
    dispose(): void;
    /** Aliases with an established (ready) connection — for status display. */
    connected(): string[];
    private ensureConnected;
    private buildConfig;
    private verifyHostKey;
}
export {};
