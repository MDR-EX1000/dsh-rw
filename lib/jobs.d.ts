import type { HostEntry } from './hosts.js';
import type { ExecResult } from './ssh-pool.js';
/** The slice of `ctx.jobs` this module drives (structural, so tests can fake it). */
export interface JobsRegistryLike {
    start(spec: {
        kind: string;
        label: string;
        owner?: string;
        run(job: JobHandleLike): JobHooksLike;
    }): string;
}
/** Producer face handed to `run` by the registry. */
export interface JobHandleLike {
    readonly id: string;
    append(text: string, options?: {
        channel?: string;
    }): void;
    updateProgress(line: string): void;
}
/** Terminal outcome the registry consumes. */
export interface JobOutcomeLike {
    status: 'completed' | 'killed' | 'failed';
    detail?: string;
}
/** Control face returned by `run`. */
export interface JobHooksLike {
    cancel(reason?: string): void;
    done: Promise<JobOutcomeLike>;
}
/** Everything the launcher needs from the remote side (injected for unit tests). */
export interface RemoteJobDeps {
    /** Run one remote command on the host. */
    exec(entry: HostEntry, command: string, opts?: {
        cwd?: string;
        timeoutMs?: number;
    }): Promise<ExecResult>;
    /** Read a remote file as UTF-8, or null when it does not exist yet. */
    readFile(entry: HostEntry, path: string): Promise<string | null>;
    /** Poll cadence for the job log (default 500 ms). */
    pollMs?: number;
    /** Give up narrating after this long (default 12 h) so a wedged host cannot pin a poller. */
    maxLifetimeMs?: number;
    /** Remote directory holding job logs (default /tmp). */
    logDir?: string;
}
export interface StartRemoteJobOptions {
    entry: HostEntry;
    /** Shell command exactly as the model wrote it (already path-rewritten). */
    command: string;
    /** Remote working directory, or undefined for the SSH default. */
    cwd?: string;
    /** One-line model-facing label. */
    label: string;
    /** Owning session id, so the registry fences access to that agent. */
    owner?: string;
}
/**
 * Start one command on the host as a registry job and return the job id.
 *
 * The starter is synchronous (the registry's contract), so the async launch and
 * the polling loop run in a floating task that narrates through `job.append`;
 * `done` settles exactly once, from the exit marker, from a cancellation, or
 * from the lifetime cap.
 */
export declare function startRemoteJob(deps: RemoteJobDeps, jobs: JobsRegistryLike, opts: StartRemoteJobOptions): string;
