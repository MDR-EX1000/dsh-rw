import type { RemoteOperationOutcome } from './errors.js';
export interface RemoteIoOptions {
    readonly signal?: AbortSignal;
    /** Total caller budget; channel acquisition and business I/O share it. */
    readonly timeoutMs?: number;
    /** Absolute Date.now() deadline; nested operations may only tighten it. */
    readonly deadlineMs?: number;
}
type Cleanup = () => void | Promise<void>;
export declare const DEFAULT_OPERATION_TIMEOUT_MS = 30000;
/** Read the effective caller signal/deadline; never widen or mutate its scope. */
export declare function currentRemoteIoOptions(): Readonly<RemoteIoOptions> | undefined;
/** Stop before a new dispatch or local state mutation when the caller is gone. */
export declare function assertRemoteIoActive(outcome?: RemoteOperationOutcome): void;
/** Register transient cleanup. The returned function only disowns it. */
export declare function ownRemoteIoResource(cleanup: Cleanup): () => void;
/** Background jobs/shared initialization belong to their own lifetime, not a completed tool. */
export declare function detachedRemoteIo<T>(body: () => T): T;
/**
 * Send deadline/cancellation to the started I/O and await its quiescence.
 * Deliberately no Promise.race: abandoning the body could run mutations later.
 * Cleanup callbacks must themselves be synchronous or bounded (pool.close is).
 */
export declare function runRemoteIo<T>(options: RemoteIoOptions, body: () => Promise<T>): Promise<T>;
export {};
