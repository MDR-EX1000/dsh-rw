import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
import { Session } from './session.js';
import type { HostTableLike, PoolLike } from './tools.js';
export declare const name = "dsh-rw";
export declare const inject: string[];
/** Host key verification policy for outbound SSH connections. */
export type HostKeyPolicy = 'accept-new' | 'strict' | 'off';
export declare const Config: z<Schemastery.ObjectS<{
    /** Host key policy: verify against ~/.ssh/known_hosts (accept-new learns on first connect). */
    hostKeyPolicy: z<string, string>;
    /** known_hosts file path (default ~/.ssh/known_hosts). */
    knownHostsPath: z<string, string>;
    /** Per remote command timeout. */
    commandTimeoutMs: z<number, number>;
    /** SSH connection establishment timeout. */
    connectTimeoutMs: z<number, number>;
    /** Channel/subsystem open timeout: bounds the wait on a silently dead connection before it is dropped and retried. */
    channelOpenTimeoutMs: z<number, number>;
    /** Hard ceiling on collected remote output per call. */
    maxOutputChars: z<number, number>;
    /** Shim mode: intercept DSH's native tools and translate them to remote execution. Default true: the agent uses native tools against the remote workspace out of the box. Set false in cordis config or in ~/.dsh/settings.yaml (`dsh-rw: shim: false`) to fall back to rw_*-only. */
    shim: z<boolean, boolean>;
    /** With shim on, also intercept bash (session cwd must be the placeholder workspace). */
    shimBash: z<boolean, boolean>;
    /** Shimmed bash approval: 'ask' escalates to the DSH approval dialog, 'native' defers to the native policy. */
    shimBashApproval: z<"ask" | "native", "ask" | "native">;
}>, Schemastery.ObjectT<{
    /** Host key policy: verify against ~/.ssh/known_hosts (accept-new learns on first connect). */
    hostKeyPolicy: z<string, string>;
    /** known_hosts file path (default ~/.ssh/known_hosts). */
    knownHostsPath: z<string, string>;
    /** Per remote command timeout. */
    commandTimeoutMs: z<number, number>;
    /** SSH connection establishment timeout. */
    connectTimeoutMs: z<number, number>;
    /** Channel/subsystem open timeout: bounds the wait on a silently dead connection before it is dropped and retried. */
    channelOpenTimeoutMs: z<number, number>;
    /** Hard ceiling on collected remote output per call. */
    maxOutputChars: z<number, number>;
    /** Shim mode: intercept DSH's native tools and translate them to remote execution. Default true: the agent uses native tools against the remote workspace out of the box. Set false in cordis config or in ~/.dsh/settings.yaml (`dsh-rw: shim: false`) to fall back to rw_*-only. */
    shim: z<boolean, boolean>;
    /** With shim on, also intercept bash (session cwd must be the placeholder workspace). */
    shimBash: z<boolean, boolean>;
    /** Shimmed bash approval: 'ask' escalates to the DSH approval dialog, 'native' defers to the native policy. */
    shimBashApproval: z<"ask" | "native", "ask" | "native">;
}>>;
export interface Config {
    hostKeyPolicy: HostKeyPolicy;
    knownHostsPath: string;
    commandTimeoutMs: number;
    connectTimeoutMs: number;
    channelOpenTimeoutMs: number;
    maxOutputChars: number;
    /** Optional so hand-built test configs still typecheck; apply() re-normalizes with the schema defaults. */
    shim?: boolean;
    shimBash?: boolean;
    shimBashApproval?: 'ask' | 'native';
}
/**
 * Test seams for apply(): the DSH loader calls apply(ctx, config); tests pass
 * in-memory fakes plus tmp paths so nothing touches the real ~/.ssh or ~/.dsh.
 */
export interface ApplyOverrides {
    hosts?: HostTableLike;
    pool?: PoolLike;
    session?: Session;
    placeholderBaseDir?: string;
    pickDirectory?: () => Promise<string | null>;
}
export declare function apply(ctx: Context, config: Config, overrides?: ApplyOverrides): void;
