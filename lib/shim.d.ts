import type { PreToolDecision, ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { Session } from './session.js';
import type { HostTableLike, PoolLike } from './tools.js';
/** The shim configuration after apply() normalization (schema defaults applied). */
export interface ShimConfig {
    shim: boolean;
    shimBash: boolean;
    shimBashApproval: 'ask' | 'native';
    commandTimeoutMs: number;
    maxOutputChars: number;
}
/**
 * Where the native read/write/edit/str_replace_editor/glob/grep/bash tools
 * actually go in the CURRENT agent session. This is an OBSERVATION the shim
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
    /** Placeholder directory the session must live in for native translation. */
    placeholder?: string;
}
/** A fresh, unobserved routing record (one per plugin load). */
export declare function createNativeRouting(): NativeRouting;
export interface ShimDeps {
    hosts: HostTableLike;
    pool: PoolLike;
    session: Session;
    config: ShimConfig;
    /** Base dir for placeholder dirs (tests inject a tmp dir). */
    placeholderBaseDir?: string;
    /** Observation record shared with the prompt section and rw_info. */
    routing?: NativeRouting;
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
}
/** The two middlewares apply() wires onto the tool pipeline. */
export interface Shim {
    onExecute(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>;
    onPreExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
}
export declare function makeShim(deps: ShimDeps): Shim;
