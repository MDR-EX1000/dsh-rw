// dsh-rw — remote background jobs.
//
// The shim used to pass `run_in_background` through to the NATIVE bash tool.
// When the session's workspace was remote, that ran the command on the LOCAL
// machine: the last place dsh-rw silently lied about where work happens.
//
// A remote background job is now started detached on the host and narrated
// into the DSH host job registry (ctx.jobs), so the model collects and stops it
// with the SAME `job_output` / `job_kill` tools it uses for a local job — no
// second tool family, no second mental model.
import { shq } from './guard.js'
import type { HostEntry } from './hosts.js'
import type { ExecResult } from './ssh-pool.js'

/** The slice of `ctx.jobs` this module drives (structural, so tests can fake it). */
export interface JobsRegistryLike {
  start(spec: {
    kind: string
    label: string
    owner?: string
    run(job: JobHandleLike): JobHooksLike
  }): string
}

/** Producer face handed to `run` by the registry. */
export interface JobHandleLike {
  readonly id: string
  append(text: string, options?: { channel?: string }): void
  updateProgress(line: string): void
}

/** Terminal outcome the registry consumes. */
export interface JobOutcomeLike {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
}

/** Control face returned by `run`. */
export interface JobHooksLike {
  cancel(reason?: string): void
  done: Promise<JobOutcomeLike>
}

/** Everything the launcher needs from the remote side (injected for unit tests). */
export interface RemoteJobDeps {
  /** Run one remote command on the host. */
  exec(entry: HostEntry, command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>
  /** Read a remote file as UTF-8, or null when it does not exist yet. */
  readFile(entry: HostEntry, path: string): Promise<string | null>
  /** Poll cadence for the job log (default 500 ms). */
  pollMs?: number
  /** Give up narrating after this long (default 12 h) so a wedged host cannot pin a poller. */
  maxLifetimeMs?: number
  /** Remote directory holding job logs (default /tmp). */
  logDir?: string
}

/** The line the wrapper writes once the command finishes; carries the exit code. */
const EXIT_MARK = '__DSH_RW_EXIT__'

export interface StartRemoteJobOptions {
  entry: HostEntry
  /** Shell command exactly as the model wrote it (already path-rewritten). */
  command: string
  /** Remote working directory, or undefined for the SSH default. */
  cwd?: string
  /** One-line model-facing label. */
  label: string
  /** Owning session id, so the registry fences access to that agent. */
  owner?: string
}

/** Build the detached launch line: the command runs in its own session and its
 *  log gets an exit marker, so one log read tells us both output and status. */
function launchCommand(command: string, logPath: string, cwd: string | undefined): string {
  const inner = `{ ${command}\n} > ${shq(logPath)} 2>&1\nprintf '\\n${EXIT_MARK}:%d\\n' "$?" >> ${shq(logPath)}`
  const cd = cwd !== undefined ? `cd ${shq(cwd)} 2>/dev/null; ` : ''
  // `setsid` detaches from the SSH channel so closing it cannot kill the job;
  // the trailing `echo $!` reports the pid we later signal.
  return `${cd}setsid sh -c ${shq(inner)} >/dev/null 2>&1 & echo $!`
}

/** Split a log body into its narration and (once present) the exit code. */
function parseLog(body: string): { output: string; exitCode: number | null } {
  const at = body.lastIndexOf(`${EXIT_MARK}:`)
  if (at < 0) return { output: body, exitCode: null }
  const after = body.slice(at + EXIT_MARK.length + 1)
  const match = /^(-?\d+)/.exec(after)
  if (match === null) return { output: body, exitCode: null }
  // Drop the newline that introduced the marker, not a byte the command wrote.
  const output = body.slice(0, at).replace(/\n$/, '')
  return { output, exitCode: Number.parseInt(match[1] as string, 10) }
}

/**
 * Start one command on the host as a registry job and return the job id.
 *
 * The starter is synchronous (the registry's contract), so the async launch and
 * the polling loop run in a floating task that narrates through `job.append`;
 * `done` settles exactly once, from the exit marker, from a cancellation, or
 * from the lifetime cap.
 */
export function startRemoteJob(deps: RemoteJobDeps, jobs: JobsRegistryLike, opts: StartRemoteJobOptions): string {
  const pollMs = deps.pollMs ?? 500
  const maxLifetimeMs = deps.maxLifetimeMs ?? 12 * 60 * 60 * 1000
  const logDir = deps.logDir ?? '/tmp'

  return jobs.start({
    kind: 'bash',
    label: opts.label,
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
    run(job) {
      const logPath = `${logDir}/.dsh-rw-job-${job.id}.log`
      let pid: number | null = null
      let cancelled: { reason: string | undefined } | null = null
      let settle: (outcome: JobOutcomeLike) => void = () => undefined
      const done = new Promise<JobOutcomeLike>((resolve) => {
        let settled = false
        settle = (outcome) => {
          if (settled) return
          settled = true
          resolve(outcome)
        }
      })

      const cancel = (reason?: string): void => {
        if (cancelled !== null) return
        cancelled = { reason }
        if (pid !== null) {
          // Best effort: the job is already settled from the model's side.
          void deps.exec(opts.entry, `kill -TERM ${pid} 2>/dev/null; exit 0`, {}).catch(() => undefined)
        }
        settle({ status: 'killed', ...(reason !== undefined ? { detail: reason } : {}) })
      }

      void (async (): Promise<void> => {
        const launch = await deps.exec(opts.entry, launchCommand(opts.command, logPath, opts.cwd), {})
        if (cancelled !== null) return
        if (launch.code !== 0) {
          settle({
            status: 'failed',
            detail: `could not start the remote job (exit ${launch.code ?? 'null'})${launch.stderr.trim() ? `: ${launch.stderr.trim()}` : ''}`,
          })
          return
        }
        const reported = Number.parseInt(launch.stdout.trim().split('\n').pop() ?? '', 10)
        pid = Number.isFinite(reported) ? reported : null
        job.updateProgress(`running on ${opts.entry.alias}`)

        const startedAt = Date.now()
        let sent = 0
        for (;;) {
          if (cancelled !== null) return
          if (Date.now() - startedAt > maxLifetimeMs) {
            settle({ status: 'failed', detail: `stopped narrating after ${Math.round(maxLifetimeMs / 60000)} min; the process may still be running` })
            return
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs))
          let body: string | null
          try {
            body = await deps.readFile(opts.entry, logPath)
          } catch (err) {
            settle({ status: 'failed', detail: `lost the job log: ${err instanceof Error ? err.message : String(err)}` })
            return
          }
          if (body === null) continue
          const { output, exitCode } = parseLog(body)
          if (output.length > sent) {
            job.append(output.slice(sent))
            sent = output.length
          }
          if (exitCode !== null) {
            settle({
              status: exitCode === 0 ? 'completed' : 'failed',
              detail: `exit code: ${exitCode}`,
            })
            return
          }
        }
      })().catch((err: unknown) => {
        settle({ status: 'failed', detail: err instanceof Error ? err.message : String(err) })
      })

      return { cancel, done }
    },
  })
}
