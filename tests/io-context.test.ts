import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertRemoteIoActive, currentRemoteIoOptions, detachedRemoteIo, ownRemoteIoResource, runRemoteIo } from '../src/io-context.js'
import { RwError } from '../src/errors.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('remote operation scope', () => {
  it('owns cleanup through normal completion without leaking the caller signal', async () => {
    const parent = new AbortController()
    const close = vi.fn()
    let signal: AbortSignal | undefined
    expect(await runRemoteIo({ signal: parent.signal, timeoutMs: 100 }, async () => {
      signal = currentRemoteIoOptions()?.signal
      expect(signal).not.toBe(parent.signal)
      ownRemoteIoResource(close)
      return 42
    })).toBe(42)
    expect(close).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
    expect(currentRemoteIoOptions()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disowning transfers cleanup without executing it', async () => {
    const close = vi.fn()
    await runRemoteIo({ timeoutMs: 100 }, async () => {
      ownRemoteIoResource(close)()
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('keeps the shorter timeout even when a far-future deadline is supplied', async () => {
    const close = vi.fn()
    const operation = runRemoteIo({ timeoutMs: 20, deadlineMs: Date.now() + 12 * 60 * 60 * 1000 }, async () => {
      ownRemoteIoResource(close)
      const signal = currentRemoteIoOptions()!.signal!
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const checked = expect(operation).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(20)
    await checked
    expect(close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not widen a parent deadline or let an inner scope cancel its parent', async () => {
    const parent = new AbortController()
    await runRemoteIo({ signal: parent.signal, timeoutMs: 100 }, async () => {
      const outer = currentRemoteIoOptions()!
      await runRemoteIo({ timeoutMs: 1000 }, async () => {
        expect(currentRemoteIoOptions()!.deadlineMs).toBe(outer.deadlineMs)
      })
      expect(outer.signal!.aborted).toBe(false)
      expect(currentRemoteIoOptions()).toBe(outer)
    })
    expect(parent.signal.aborted).toBe(false)
  })

  it('sends cancellation but does not abandon a started body before teardown', async () => {
    const controller = new AbortController()
    const close = vi.fn()
    let release!: () => void
    let settled = false
    const operation = runRemoteIo({ signal: controller.signal, timeoutMs: 100 }, async () => {
      ownRemoteIoResource(close)
      await new Promise<void>(resolve => { release = resolve })
      assertRemoteIoActive('unknown')
    })
    const checked = operation.then(() => { settled = true }, error => {
      settled = true
      expect(error).toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'unknown' })
    })
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(close).not.toHaveBeenCalled()
    release()
    await checked
    expect(close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not falsely report success when the body swallowed a deadline error', async () => {
    const operation = runRemoteIo({ timeoutMs: 20 }, async () => {
      const signal = currentRemoteIoOptions()!.signal!
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return 'swallowed'
    })
    const checked = expect(operation).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'unknown' })
    await vi.advanceTimersByTimeAsync(20)
    await checked
  })

  it('does not reset its elapsed-time budget after a backward wall-clock correction', async () => {
    vi.setSystemTime(100_000)
    const operation = runRemoteIo({ timeoutMs: 20 }, async () => {
      const signal = currentRemoteIoOptions()!.signal!
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const checked = expect(operation).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    vi.setSystemTime(1_000)
    await vi.advanceTimersByTimeAsync(20)
    await checked
  })

  it('gives detached jobs/init a separate lifetime from the completed tool', async () => {
    await runRemoteIo({ timeoutMs: 100 }, async () => {
      expect(await detachedRemoteIo(async () => {
        await Promise.resolve()
        return currentRemoteIoOptions()
      })).toBeUndefined()
      expect(currentRemoteIoOptions()).toBeDefined()
    })
  })

  it('rejects an already-aborted caller before running its body', async () => {
    const controller = new AbortController()
    controller.abort()
    const body = vi.fn(async () => 1)
    await expect(runRemoteIo({ signal: controller.signal, timeoutMs: 100 }, body)).rejects.toMatchObject({ code: 'OPERATION_ABORTED', outcome: 'not-started' })
    expect(body).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves body failure while still releasing owned resources', async () => {
    const close = vi.fn()
    const error = new RwError('INVALID_INPUT', 'original')
    await expect(runRemoteIo({ timeoutMs: 100 }, async () => {
      ownRemoteIoResource(close)
      throw error
    })).rejects.toBe(error)
    expect(close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports cleanup failure as outcome unknown instead of false success', async () => {
    await expect(runRemoteIo({ timeoutMs: 100 }, async () => {
      ownRemoteIoResource(() => { throw new Error('close failed') })
      return 1
    })).rejects.toMatchObject({ code: 'REMOTE_ERROR', outcome: 'unknown' })
  })
})
