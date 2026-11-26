import type { PreToolDecision, ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { SessionStore } from './session.js';
import type { ShellManagerLike } from './persistent-shell.js';
import type { JobsRegistryLike } from './jobs.js';
import type { HostTableLike, PoolLike } from './tools.js';
/** The shim configuration after apply() normalization (schema defaults applied). */
export interface ShimConfig {
    shim: boolean;
    shimBash: boolean;
    shimBashApproval: 'ask' | 'native';
    commandTimeoutMs: number;
    maxOutputChars: number;
    /** End-to-end file-operation deadline (default 30s), separate from command budgets. */
    operationTimeoutMs?: number;
    /** Run the persistent-bash flavor on a long-lived remote shell (default true). */
    persistentShell?: boolean;
    /** Run native background bash calls as remote jobs (default true). */
    backgroundJobs?: boolean;
}
/**
 * Where the native read/write/edit/str_replace_editor/glob/grep/bash tools
 * actually go in ONE agent session (2.0: one record per session id). This is an OBSERVATION the shim
 * updates on every dispatch, never an inference from the rw_* session record:
 * a recorded remote workspace does not by itself tell anyone whether the
 * agent's working directory lives inside its placeholder (translated) or on a
 * real local directory (pass-through). The prompt section and rw_info report
 * this record so a session cannot be told its native tools are remote while
 * they are quietly running on the local machine.
 */
export interface NativeRouting {
    /** 'unknown' until the first shimmed call of this plugin load is observed. */
    mode: 'unknown' | 'remote' | 'local';
    /** The agent cwd the observation was made at (in `local` mode: the offending directory). */
    cwd?: string;
    /** The remote workspace active when the observation was made. */
    alias?: string;
    workspace?: string;
    /** Placeholder directory the translated call was rooted at. */
    placeholder?: string;
    /**
     * How the last translated call was anchored: its own path argument
     * (`'path'` — works from any working directory) or the agent session cwd
     * (`'cwd'` — the pre-1.0 rule). Absent in `local`/`unknown` mode.
     */
    reason?: 'cwd' | 'path';
}
/** Sessions whose routing observation is kept; the least recently observed beyond this is dropped. */
export declare const NATIVE_ROUTING_LIMIT = 256;
/**
 * The per-session observation table (plugin-load scope). Keyed by the DSH
 * session id ('' when a call carries none), bounded LRU so a long-running host
 * does not accumulate one record per session forever.
 */
export declare class NativeRoutingTable {
    readonly limit: number;
    private readonly records;
    constructor(limit?: number);
    /** The observation for one session, or undefined when nothing was observed (never creates). */
    peek(sessionId: string): NativeRouting | undefined;
    /** The mutable record for one session — created on demand, marked most recent, oldest evicted. */
    touch(sessionId: string): NativeRouting;
    /** Seed (or replace) one session's observation — for tests and diagnostics. */
    set(sessionId: string, routing: NativeRouting): void;
    get size(): number;
}
/** A fresh, unobserved routing table (one per plugin load). */
export declare function createNativeRouting(limit?: number): NativeRoutingTable;
export interface ShimDeps {
    hosts: HostTableLike;
    pool: PoolLike;
    /** Per-session connection records (the fast path reads the CALLER's record). */
    session: SessionStore;
    config: ShimConfig;
    /** Mirror-layout placeholder root (plugin config placeholderRoot; tests inject a tmp dir). */
    placeholderRoot?: string;
    /** Legacy (≤ 1.6) placeholder base dir, searched by lookups only (tests inject a tmp dir). */
    placeholderBaseDir?: string;
    /** Per-session observation table shared with rw_info. */
    routing?: NativeRoutingTable;
    /**
     * Resolve the caller-visible tool definition (ctx.tools.get in production).
     * Only used for the bash flavor check; undefined → bash is treated as
     * one-shot.
     */
    getTool?(name: string, agent: unknown): {
        parameters?: unknown;
    } | undefined;
    /**
     * The calling session's effective approval policy (ctx.approval's
     * effectivePolicy in production). When it reports 'never' (e.g. the
     * danger-full-access preset), an 'ask' escalation would be auto-rejected
     * without a dialog — the pre-execute gate then stands down and lets the
     * call run, matching that preset's "don't ask me" contract. Undefined
     * (no approval service) keeps the plain 'ask' behavior.
     */
    approvalPolicyOf?(session: unknown): string | undefined;
    /**
     * The persistent-shell manager (index.ts wires it to the pool). Undefined
     * keeps the pre-1.0 behavior: the persistent-bash flavor degrades to a
     * one-shot exec and the result says so.
     */
    shells?: ShellManagerLike;
    /**
     * The host job registry (`ctx.jobs`). A remote background bash call is
     * registered here so the model collects it with the SAME job_output /
     * job_kill tools as a local job. Absent → such a call is REFUSED rather than
     * passed through, because passing it through runs it on the local machine.
     */
    jobs?: JobsRegistryLike;
    /** Poll cadence for a remote job's log (default 500 ms). */
    jobPollMs?: number;
    /** Remote directory holding job logs (default /tmp). */
    jobDir?: string;
}
/** The two middlewares apply() wires onto the tool pipeline. */
export interface Shim {
    onExecute(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>;
    onPreExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
}
export declare function makeShim(deps: ShimDeps): Shim;
