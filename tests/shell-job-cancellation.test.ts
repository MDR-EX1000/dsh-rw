// No SSH or OS signals are executed: exec only records mocked owned-PID commands.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RwError } from '../src/errors.js'
import { runRemoteIo } from '../src/io-context.js'
import type { RemoteIoOptions } from '../src/io-context.js'
import { startRemoteJob } from '../src/jobs.js'
import type { JobHandleLike, JobHooksLike, JobsRegistryLike, RemoteJobDeps } from '../src/jobs.js'
import type { ExecResult } from '../src/ssh-pool.js'
import { ENTRY_PROD } from './p4-fakes.js'

const ok = (stdout = ''): ExecResult => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
/** Mock transport: observes cancellation, performs finite teardown, then
 * rejects. It never delivers a late success after cancellation. */
function ioAware<T>(promise: Promise<T>, options: RemoteIoOptions | undefined, teardownMs = 20): Promise<T> {
  const signal = options?.signal
  if (!signal) throw new Error('mock transport did not receive its owned signal')
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let aborting = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => { signal.removeEventListener('abort', abort); if (timer) clearTimeout(timer) }
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error) }
    const abort = () => {
      if (settled || aborting) return
      aborting = true
      timer = setTimeout(() => fail(new RwError(
        signal.reason instanceof RwError && signal.reason.code === 'OPERATION_TIMEOUT' ? 'OPERATION_TIMEOUT' : 'OPERATION_ABORTED',
        'mock transport quiesced after cancellation', { cause: signal.reason, outcome: 'unknown' },
      )), teardownMs)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(value => {
      if (settled || aborting) return
      settled = true; cleanup(); resolve(value)
    }, error => { if (!aborting) fail(error) })
  })
}
function pendingIo<T>(options: RemoteIoOptions | undefined): Promise<T> { return ioAware(new Promise<T>(() => {}), options) }
class Registry implements JobsRegistryLike {
  id = 'mock-owned-job'
  spec!: Parameters<JobsRegistryLike['start']>[0]
  hooks!: JobHooksLike
  outputs: string[] = []
  constructor(private readonly delayed = false) {}
  start(spec: Parameters<JobsRegistryLike['start']>[0]): string {
    this.spec = spec
    if (!this.delayed) this.activate()
    return this.id
  }
  activate(): JobHooksLike {
    const handle: JobHandleLike = { id: this.id, append: text => { this.outputs.push(text) }, updateProgress: () => {} }
    this.hooks = this.spec.run(handle)
    return this.hooks
  }
}
function start(registry: Registry, deps: RemoteJobDeps) {
  return startRemoteJob(deps, registry, { entry: ENTRY_PROD, command: 'mock command', cwd: '/srv/app', label: 'mock job' })
}
afterEach(() => { vi.useRealTimers() })

describe('remote job owned budgets and cancellation', () => {
  it('starts a delayed registry callback outside a completed/aborted foreground scope', async () => {
    const registry = new Registry(true)
    const caller = new AbortController()
    const seen: RemoteIoOptions[] = []
    const deps: RemoteJobDeps = {
      exec: async (_entry, _command, options) => { seen.push(options!); expect(options?.signal?.aborted).toBe(false); return ok('4242\n') },
      readFile: async (_entry, _path, options) => { seen.push(options!); expect(options?.signal?.aborted).toBe(false); return '__DSH_RW_EXIT__:0\n' },
      pollMs: 25, maxLifetimeMs: 1000,
    }
    await runRemoteIo({ signal: caller.signal, timeoutMs: 10 }, async () => { start(registry, deps) })
    caller.abort()
    await runRemoteIo({ timeoutMs: 1000 }, async () => { registry.activate() })
    expect(await registry.hooks.done).toEqual({ status: 'completed', detail: 'exit code: 0' })
    expect(seen).toHaveLength(2)
    expect(seen.every(x => x.signal !== caller.signal)).toBe(true)
  })

  it('clamps each poll budget independently of the longer job lifetime', async () => {
    const registry = new Registry()
    let launchedAt = 0, polledAt = 0
    let launchOptions: RemoteIoOptions | undefined, pollOptions: RemoteIoOptions | undefined
    start(registry, {
      exec: async (_entry, _command, options) => { launchedAt = Date.now(); launchOptions = options; return ok('4242') },
      readFile: async (_entry, _path, options) => { polledAt = Date.now(); pollOptions = options; return '__DSH_RW_EXIT__:0\n' },
      pollMs: 1, maxLifetimeMs: 60_000,
    })
    await registry.hooks.done
    expect(launchOptions?.deadlineMs).toBeLessThanOrEqual(launchedAt + 30_000)
    expect(pollOptions?.deadlineMs).toBeLessThanOrEqual(polledAt + 10_000)
    expect(pollOptions?.timeoutMs).toBe(10_000)
  })

  it('waits for log transport teardown at the poll deadline, not at the job lifetime', async () => {
    vi.useFakeTimers()
    const registry = new Registry()
    let reads = 0, finished = false
    start(registry, {
      exec: async () => ok('4242'),
      readFile: async (_entry, _path, options) => { reads++; return pendingIo<string | null>(options) },
      pollMs: 1, maxLifetimeMs: 60_000,
    })
    void registry.hooks.done.then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(1)
    expect(reads).toBe(1)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    const result = await registry.hooks.done
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('lost the job log')
    expect(result.detail).toContain('process may still be running')
    expect(reads).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not let a pending log read overrun the lifetime cap', async () => {
    vi.useFakeTimers()
    const registry = new Registry()
    start(registry, {
      exec: async () => ok('4242'), readFile: async (_entry, _path, options) => pendingIo<string | null>(options),
      pollMs: 1, maxLifetimeMs: 30,
    })
    let finished = false
    void registry.hooks.done.then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(31)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    const result = await registry.hooks.done
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('stopped narrating')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a pending log read and only signals the known guarded PID', async () => {
    const registry = new Registry()
    const commands: string[] = []
    let readSignal: AbortSignal | undefined
    start(registry, {
      exec: async (_entry, command) => { commands.push(command); return ok(command.includes('setsid') ? '4242' : '') },
      readFile: async (_entry, _path, options) => { readSignal = options?.signal; return pendingIo<string | null>(options) },
      pollMs: 1, maxLifetimeMs: 1000,
    })
    await vi.waitFor(() => expect(readSignal).toBeDefined())
    let finished = false
    void registry.hooks.done.then(() => { finished = true })
    registry.hooks.cancel('user stop')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(finished).toBe(false)
    const result = await registry.hooks.done
    expect(readSignal?.aborted).toBe(true)
    expect(result.status).toBe('killed')
    expect(result.detail).toContain('process exit is not confirmed')
    expect(commands).toHaveLength(2)
    expect(commands[1]).toContain('ps -ww -p 4242')
    expect(commands[1]).toContain("'/tmp/.dsh-rw-job-mock-owned-job.log'")
    expect(commands[1]).toContain('kill -TERM 4242')
    expect(commands[1]).not.toContain('killall')
  })

  it('does not dispatch a launch cancelled before its microtask begins', async () => {
    const registry = new Registry()
    const exec = vi.fn(async () => ok('4242'))
    start(registry, { exec, readFile: async () => null })
    registry.hooks.cancel('before launch')
    const result = await registry.hooks.done
    expect(result.status).toBe('killed')
    expect(result.detail).toContain('before remote launch was dispatched')
    expect(exec).not.toHaveBeenCalled()
  })

  it.each(['connect', 'open'])('cancels a launch waiting at %s without dispatching it after late readiness', async phase => {
    const registry = new Registry()
    let ready!: () => void
    const readiness = new Promise<void>(resolve => { ready = resolve })
    const requests: string[] = []
    let actualDispatches = 0, polls = 0, settled = false
    start(registry, {
      exec: async (_entry, command, options) => {
        requests.push(command)
        const signal = options?.signal
        if (!signal) throw new Error('missing launch signal')
        return new Promise<ExecResult>((resolve, reject) => {
          let stopped = false
          const abort = () => {
            stopped = true
            setTimeout(() => {
              signal.removeEventListener('abort', abort)
              reject(new RwError('OPERATION_ABORTED', `quiesced while waiting for ${phase}`, { cause: signal.reason, outcome: 'not-started' }))
            }, 20)
          }
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
          void readiness.then(() => {
            if (stopped || signal.aborted) return
            signal.removeEventListener('abort', abort)
            actualDispatches++
            resolve(ok('4242'))
          })
        })
      },
      readFile: async () => { polls++; return null }, maxLifetimeMs: 1000,
    })
    void registry.hooks.done.then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(requests).toHaveLength(1) // requested exec is not an EXEC-send acknowledgement
    registry.hooks.cancel('cancel before dispatch')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(settled).toBe(false) // provider teardown must quiesce first
    const result = await registry.hooks.done
    expect(result.status).toBe('killed')
    expect(result.detail).toContain('remote launch was not dispatched')
    ready()
    await new Promise(resolve => setImmediate(resolve))
    expect(actualDispatches).toBe(0)
    expect(requests.filter(x => x.includes('kill -TERM'))).toHaveLength(0)
    expect(polls).toBe(0)
  })

  it('retains an already acknowledged PID when cancellation races scope completion', async () => {
    const registry = new Registry()
    const commands: string[] = []
    start(registry, {
      exec: async (_entry, command) => {
        commands.push(command)
        if (command.includes('setsid')) {
          queueMicrotask(() => queueMicrotask(() => registry.hooks.cancel('after acknowledgement')))
          return ok('4242')
        }
        return ok()
      },
      readFile: async () => null, maxLifetimeMs: 1000,
    })
    const result = await registry.hooks.done
    expect(result.status).toBe('killed')
    expect(result.detail).toContain('TERM acknowledged')
    expect(result.detail).toContain('process exit is not confirmed')
    expect(commands.filter(x => x.includes('setsid'))).toHaveLength(1)
    expect(commands.filter(x => x.includes('kill -TERM 4242'))).toHaveLength(1)
  })

  it('reports an unknown cancelled launch rather than claiming a kill or replaying it', async () => {
    const registry = new Registry()
    let reject!: (error: Error) => void
    const launch = new Promise<ExecResult>((_resolve, fail) => { reject = fail })
    const commands: string[] = []
    start(registry, { exec: async (_entry, command, options) => { commands.push(command); return ioAware(launch, options) }, readFile: async () => null })
    await new Promise(resolve => setImmediate(resolve))
    registry.hooks.cancel('cancel')
    reject(new RwError('OPERATION_TIMEOUT', 'response lost', { outcome: 'unknown' }))
    const result = await registry.hooks.done
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('launch outcome unknown')
    expect(result.detail).toContain('may have started')
    expect(result.detail).toContain('inspect launch token /tmp/.dsh-rw-job-mock-owned-job.log')
    expect(commands).toHaveLength(1)
  })

  it('does not claim killed when the owned-PID stop response is unknown', async () => {
    const registry = new Registry()
    const commands: string[] = []
    let reads = 0
    start(registry, {
      exec: async (_entry, command) => {
        commands.push(command)
        if (command.includes('setsid')) return ok('4242')
        throw new RwError('OPERATION_TIMEOUT', 'kill response lost', { outcome: 'unknown' })
      },
      readFile: async () => { reads++; return null }, pollMs: 1,
    })
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0))
    registry.hooks.cancel('cancel')
    const result = await registry.hooks.done
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('stop outcome unknown')
    expect(commands.filter(x => x.includes('kill -TERM 4242'))).toHaveLength(1)
  })

  it('does not report killed when the PID command-line ownership guard refuses', async () => {
    const registry = new Registry()
    let reads = 0
    const commands: string[] = []
    start(registry, {
      exec: async (_entry, command) => { commands.push(command); return command.includes('setsid') ? ok('4242') : { ...ok(), code: 73 } },
      readFile: async () => { reads++; return null }, pollMs: 1,
    })
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0))
    registry.hooks.cancel('cancel')
    const outcome = await registry.hooks.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('signal/identity was not acknowledged')
    expect(commands[1]).toContain('case')
    expect(commands[1]).toContain('exit 73')
  })

  it.each([0, -1, NaN, Infinity])('rejects invalid observer budgets %j before starting a registry job', value => {
    const registry = new Registry()
    const exec = vi.fn(async () => ok('4242'))
    const deps = { exec, readFile: async () => null }
    expect(() => start(registry, { ...deps, pollMs: value })).toThrow(RwError)
    expect(() => start(registry, { ...deps, maxLifetimeMs: value })).toThrow(RwError)
    expect(exec).not.toHaveBeenCalled()
    expect(registry.spec).toBeUndefined()
  })

  it.each(['0', '1', '-1', '4242junk', ''])('never signals an invalid or unproven PID %j', async stdout => {
    const registry = new Registry()
    const commands: string[] = []
    start(registry, { exec: async (_entry, command) => { commands.push(command); return ok(stdout) }, readFile: async () => null })
    const result = await registry.hooks.done
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('no valid owned PID')
    registry.hooks.cancel('late cancel')
    expect(commands).toHaveLength(1)
  })

  it('bounds a missing launch callback and never retries the detached launch', async () => {
    vi.useFakeTimers()
    const registry = new Registry()
    const exec = vi.fn(async (_entry: unknown, _command: string, options?: RemoteIoOptions) => pendingIo<ExecResult>(options))
    start(registry, { exec, readFile: async () => null, maxLifetimeMs: 60_000 })
    let finished = false
    void registry.hooks.done.then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    const result = await registry.hooks.done
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('launch outcome unknown')
    expect(exec).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('quiesces a timed-out launch and refuses a success which arrives after its deadline', async () => {
    vi.useFakeTimers()
    const registry = new Registry()
    let answer!: (result: ExecResult) => void
    const launch = new Promise<ExecResult>(resolve => { answer = resolve })
    const commands: string[] = []
    start(registry, {
      exec: async (_entry, command, options) => { commands.push(command); return command.includes('setsid') ? ioAware(launch, options) : ok() },
      readFile: async () => null, maxLifetimeMs: 60_000,
    })
    let finished = false
    void registry.hooks.done.then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(finished).toBe(false)
    answer(ok('4242'))
    await vi.advanceTimersByTimeAsync(20)
    const result = await registry.hooks.done
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('launch outcome unknown')
    expect(commands.filter(x => x.includes('setsid'))).toHaveLength(1)
    expect(commands.filter(x => x.includes('kill -TERM 4242'))).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a missing kill response without replaying the owned signal', async () => {
    vi.useFakeTimers()
    const registry = new Registry()
    const commands: string[] = []
    start(registry, {
      exec: async (_entry, command, options) => { commands.push(command); return command.includes('setsid') ? ok('4242') : pendingIo<ExecResult>(options) },
      readFile: async () => null, pollMs: 1, maxLifetimeMs: 60_000,
    })
    let finished = false
    void registry.hooks.done.then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(1)
    registry.hooks.cancel('cancel')
    await vi.advanceTimersByTimeAsync(5_001)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    const result = await registry.hooks.done
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('stop outcome unknown')
    expect(commands.filter(x => x.includes('kill -TERM 4242'))).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
