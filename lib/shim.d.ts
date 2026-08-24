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
export interface ShimDeps {
    hosts: HostTableLike;
    pool: PoolLike;
    session: Session;
    config: ShimConfig;
    /** Base dir for placeholder dirs (tests inject a tmp dir). */
    placeholderBaseDir?: string;
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
