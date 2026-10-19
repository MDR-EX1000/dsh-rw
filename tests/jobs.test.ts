// Remote background jobs: the launcher is driven through a fake registry and
// fake transport, so the framing (setsid launch, exit marker, delta narration,
// cancel, lifetime cap) is covered without an SSH server.
import { describe, expect, it } from 'vitest'
import { startRemoteJob } from '../src/jobs.js'
import type { JobHandleLike, JobHooksLike, JobOutcomeLike, JobsRegistryLike, RemoteJobDeps } from '../src/jobs.js'
import type { ExecResult } from '../src/ssh-pool.js'
import { ENTRY_PROD } from './p4-fakes.js'

/** Captures the spec, hands out a job handle, and keeps the returned hooks. */
class FakeJobs implements JobsRegistryLike {
  id = 'bash-test1'
  spec: Parameters<JobsRegistryLike['start']>[0] | null = null
  hooks: JobHooksLike | null = null
  readonly appended: string[] = []
  readonly progress: string[] = []

  start(spec: Parameters<JobsRegistryLike['start']>[0]): string {
    this.spec = spec
    const job: JobHandleLike = {
      id: this.id,
      append: (text) => {
        this.appended.push(text)
      },
      updateProgress: (line) => {
        this.progress.push(line)
      },
    }
    this.hooks = spec.run(job)
    return this.id
  }

  get output(): string {
    return this.appended.join('')
  }
}

function ok(stdout = ''): ExecResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

/** Deps whose log body advances along `bodies`; the last body repeats. */
function makeDeps(bodies: (string | null)[], opts: Partial<RemoteJobDeps> = {}): {
  deps: RemoteJobDeps
  execCalls: { command: string }[]
  reads: () => number
} {
  const execCalls: { command: string }[] = []
  let reads = 0
  const deps: RemoteJobDeps = {
    exec: async (_entry, command) => {
      execCalls.push({ command })
      return ok('4242\n')
    },
    readFile: async () => {
      const body = bodies[Math.min(reads, bodies.length - 1)] ?? null
      reads += 1
      return body
    },
    pollMs: 1,
    maxLifetimeMs: 5000,
    ...opts,
  }
  return { deps, execCalls, reads: () => reads }
}

function start(jobs: FakeJobs, deps: RemoteJobDeps, command = 'make test'): string {
  return startRemoteJob(deps, jobs, { entry: ENTRY_PROD, command, label: command, cwd: '/srv/app' })
}

describe('remote background jobs', () => {
  it('launches detached with a log redirect and an exit marker, then narrates deltas', async () => {
    const jobs = new FakeJobs()
    const { deps, execCalls } = makeDeps([null, 'hello\n', 'hello\nworld\n\n__DSH_RW_EXIT__:0\n'])
    const id = start(jobs, deps)
    expect(id).toBe('bash-test1')
    expect(jobs.spec?.kind).toBe('bash')
    expect(jobs.spec?.label).toBe('make test')

    const outcome = await jobs.hooks!.done
    const launch = execCalls[0]!.command
    expect(launch).toContain('setsid sh -c')
    expect(launch).toContain(`cd '/srv/app'`)
    expect(launch).toContain('__DSH_RW_EXIT__')
    expect(launch.trimEnd().endsWith('echo $!')).toBe(true)

    expect(outcome).toEqual({ status: 'completed', detail: 'exit code: 0' })
    // Only new bytes are appended, and the marker never leaks into the output.
    expect(jobs.output).toBe('hello\nworld\n')
    expect(jobs.output).not.toContain('__DSH_RW_EXIT__')
  })

  it('settles failed with the exit code of a non-zero command', async () => {
    const jobs = new FakeJobs()
    const { deps } = makeDeps(['oops\n\n__DSH_RW_EXIT__:3\n'])
    start(jobs, deps)
    expect(await jobs.hooks!.done).toEqual({ status: 'failed', detail: 'exit code: 3' })
    expect(jobs.output).toBe('oops\n')
  })

  it('settles failed when the launch itself fails', async () => {
    const jobs = new FakeJobs()
    const deps: RemoteJobDeps = {
      exec: async () => ({ code: 127, signal: null, stdout: '', stderr: 'sh: setsid: not found', timedOut: false }),
      readFile: async () => null,
      pollMs: 1,
    }
    start(jobs, deps)
    const outcome = await jobs.hooks!.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('could not start the remote job')
    expect(outcome.detail).toContain('setsid')
  })

  it('cancel signals the pid and settles killed with the reason', async () => {
    const jobs = new FakeJobs()
    const { deps, execCalls } = makeDeps([null])
    start(jobs, deps)
    // Let the launch settle so the pid is known.
    await new Promise((resolve) => setTimeout(resolve, 10))
    jobs.hooks!.cancel('user asked')
    const outcome = await jobs.hooks!.done
    expect(outcome).toEqual({ status: 'killed', detail: 'user asked' })
    expect(execCalls.some((c) => c.command.includes('kill -TERM 4242'))).toBe(true)
  })

  it('gives up narrating after the lifetime cap instead of polling forever', async () => {
    const jobs = new FakeJobs()
    const { deps } = makeDeps([null], { maxLifetimeMs: 30, pollMs: 5 })
    start(jobs, deps)
    const outcome = await jobs.hooks!.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('stopped narrating')
  })

  it('reports a log read failure instead of hanging', async () => {
    const jobs = new FakeJobs()
    const deps: RemoteJobDeps = {
      exec: async () => ok('4242\n'),
      readFile: async () => {
        throw new Error('sftp channel closed')
      },
      pollMs: 1,
      maxLifetimeMs: 2000,
    }
    start(jobs, deps)
    const outcome: JobOutcomeLike = await jobs.hooks!.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('lost the job log')
  })
})
