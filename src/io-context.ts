// One admitted remote operation owns its deadline, cancellation and transient
// SFTP channels. This is caller-local context, never session/profile state.
import { AsyncLocalStorage } from 'node:async_hooks'
import { RwError } from './errors.js'
import type { RemoteOperationOutcome } from './errors.js'

export interface RemoteIoOptions {
  readonly signal?: AbortSignal
  /** Total caller budget; channel acquisition and business I/O share it. */
  readonly timeoutMs?: number
  /** Absolute Date.now() deadline; nested operations may only tighten it. */
  readonly deadlineMs?: number
}

type Cleanup = () => void | Promise<void>
interface IoScope {
  readonly options: Readonly<RemoteIoOptions>
  readonly controller: AbortController
  readonly resources: Set<Cleanup>
  closed: boolean
}
const scopes = new AsyncLocalStorage<IoScope>()
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const MAX_TIMER_DELAY = 2_147_483_647

function timeoutOf(value: number | undefined): number {
  const ms = value ?? DEFAULT_OPERATION_TIMEOUT_MS
  if (!Number.isFinite(ms) || ms <= 0) throw new RwError('INVALID_INPUT', 'remote operation timeout must be a positive finite number')
  return ms
}

/** Read the effective caller signal/deadline; never widen or mutate its scope. */
export function currentRemoteIoOptions(): Readonly<RemoteIoOptions> | undefined {
  return scopes.getStore()?.options
}

/** Stop before a new dispatch or local state mutation when the caller is gone. */
export function assertRemoteIoActive(outcome: RemoteOperationOutcome = 'not-started'): void {
  const scope = scopes.getStore()
  if (scope === undefined) return
  const reason = scope.options.signal?.reason
  const timedOut = (scope.options.deadlineMs ?? Infinity) <= Date.now() ||
    reason instanceof RwError && reason.code === 'OPERATION_TIMEOUT' ||
    (reason as { code?: unknown } | undefined)?.code === 'TOOL_TIMEOUT'
  const uncertainty = outcome === 'unknown' ? '; earlier operations may already have executed — do not automatically repeat mutations' : ''
  if (timedOut) {
    throw new RwError('OPERATION_TIMEOUT', `remote operation deadline elapsed; no further work will be dispatched${uncertainty}`, { outcome, cause: reason })
  }
  if (scope.closed || scope.options.signal?.aborted) {
    throw new RwError('OPERATION_ABORTED', `remote operation cancelled; no further work will be dispatched${uncertainty}`, { outcome, cause: reason })
  }
}

/** Register transient cleanup. The returned function only disowns it. */
export function ownRemoteIoResource(cleanup: Cleanup): () => void {
  const scope = scopes.getStore()
  if (scope === undefined) return () => undefined
  if (scope.closed) {
    // A late acquisition cannot transfer itself into an ended caller scope.
    void Promise.resolve().then(cleanup).catch(() => undefined)
    return () => undefined
  }
  scope.resources.add(cleanup)
  return () => { scope.resources.delete(cleanup) }
}

/** Background jobs/shared initialization belong to their own lifetime, not a completed tool. */
export function detachedRemoteIo<T>(body: () => T): T {
  return scopes.exit(body)
}

/**
 * Send deadline/cancellation to the started I/O and await its quiescence.
 * Deliberately no Promise.race: abandoning the body could run mutations later.
 * Cleanup callbacks must themselves be synchronous or bounded (pool.close is).
 */
export async function runRemoteIo<T>(options: RemoteIoOptions, body: () => Promise<T>): Promise<T> {
  const parent = scopes.getStore()
  const timeoutMs = timeoutOf(options.timeoutMs ?? parent?.options.timeoutMs)
  if (options.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs)) throw new RwError('INVALID_INPUT', 'remote operation deadline must be finite')
  const requested = Math.min(options.deadlineMs ?? Infinity, Date.now() + timeoutMs)
  const deadlineMs = Math.min(requested, parent?.options.deadlineMs ?? Infinity)
  const controller = new AbortController()
  const scope: IoScope = {
    options: Object.freeze({ signal: controller.signal, timeoutMs, deadlineMs }),
    controller,
    resources: new Set(),
    closed: false,
  }
  const unlink: (() => void)[] = []
  for (const signal of new Set([options.signal, parent?.options.signal])) {
    if (signal === undefined) continue
    const onAbort = () => { if (!controller.signal.aborted) controller.abort(signal.reason) }
    if (signal.aborted) onAbort()
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      unlink.push(() => signal.removeEventListener('abort', onAbort))
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (remaining: number) => {
    if (remaining <= 0) {
      if (!controller.signal.aborted) controller.abort(new RwError('OPERATION_TIMEOUT', 'remote operation deadline elapsed', { outcome: 'unknown' }))
      return
    }
    const chunk = Math.min(remaining, MAX_TIMER_DELAY)
    // Timer elapsed time is monotonic: wall-clock corrections must not reset it.
    timer = setTimeout(() => arm(remaining - chunk), chunk)
  }
  arm(deadlineMs - Date.now())
  return await scopes.run(scope, async () => {
    let bodyFailed = false
    try {
      assertRemoteIoActive()
      const result = await body()
      assertRemoteIoActive('unknown')
      return result
    } catch (error) {
      bodyFailed = true
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      for (const detach of unlink) detach()
      scope.closed = true
      if (!controller.signal.aborted) controller.abort(new RwError('OPERATION_ABORTED', 'remote operation scope ended', { outcome: 'unknown' }))
      const results = await Promise.allSettled([...scope.resources].map(cleanup => Promise.resolve().then(cleanup)))
      scope.resources.clear()
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed !== undefined && !bodyFailed) {
        throw new RwError('REMOTE_ERROR', 'remote operation finished but channel cleanup failed; state may already have changed', { cause: failed.reason, outcome: 'unknown' })
      }
    }
  })
}
