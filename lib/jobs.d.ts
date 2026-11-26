import type { RemoteIoOptions } from './io-context.js';
import type { HostEntry } from './hosts.js';
import type { ExecResult } from './ssh-pool.js';
export interface JobsRegistryLike {
    start(spec: {
        kind: string;
        label: string;
        owner?: string;
        run(job: JobHandleLike): JobHooksLike;
    }): string;
}
export interface JobHandleLike {
    readonly id: string;
    append(text: string, options?: {
        channel?: string;
    }): void;
    updateProgress(line: string): void;
}
export interface JobOutcomeLike {
    status: 'completed' | 'killed' | 'failed';
    detail?: string;
}
export interface JobHooksLike {
    cancel(reason?: string): void;
    done: Promise<JobOutcomeLike>;
}
export interface RemoteJobDeps {
    /** Providers must observe forwarded cancellation/deadlines and quiesce before
     * settling. Unsupported injected providers are not made safe by abandoning
     * their started Promise. Neither launch nor mutation may be replayed. */
    exec(entry: HostEntry, command: string, opts?: RemoteIoOptions & {
        cwd?: string;
    }): Promise<ExecResult>;
    readFile(entry: HostEntry, path: string, options?: RemoteIoOptions): Promise<string | null>;
    pollMs?: number;
    maxLifetimeMs?: number;
    logDir?: string;
}
export interface StartRemoteJobOptions {
    entry: HostEntry;
    command: string;
    cwd?: string;
    label: string;
    owner?: string;
}
export declare function startRemoteJob(deps: RemoteJobDeps, jobs: JobsRegistryLike, opts: StartRemoteJobOptions): string;
