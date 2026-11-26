// dsh-rw — remote registry jobs own their launch/poll/cancel lifetime, not the
// short foreground tool that returned their id. Every I/O attempt is finite.
import { shq } from './guard.js'
import { RwError } from './errors.js'
import { assertRemoteIoActive, currentRemoteIoOptions, detachedRemoteIo, runRemoteIo } from './io-context.js'
import type { RemoteIoOptions } from './io-context.js'
import type { HostEntry } from './hosts.js'
import type { ExecResult } from './ssh-pool.js'

export interface JobsRegistryLike {
  start(spec: { kind: string; label: string; owner?: string; run(job: JobHandleLike): JobHooksLike }): string
}
export interface JobHandleLike {
  readonly id: string
  append(text: string, options?: { channel?: string }): void
  updateProgress(line: string): void
}
export interface JobOutcomeLike { status: 'completed' | 'killed' | 'failed'; detail?: string }
export interface JobHooksLike { cancel(reason?: string): void; done: Promise<JobOutcomeLike> }
export interface RemoteJobDeps {
  /** Providers must observe forwarded cancellation/deadlines and quiesce before
   * settling. Unsupported injected providers are not made safe by abandoning
   * their started Promise. Neither launch nor mutation may be replayed. */
  exec(entry: HostEntry, command: string, opts?: RemoteIoOptions & { cwd?: string }): Promise<ExecResult>
  readFile(entry: HostEntry, path: string, options?: RemoteIoOptions): Promise<string | null>
  pollMs?: number
  maxLifetimeMs?: number
  logDir?: string
}
export interface StartRemoteJobOptions {
  entry: HostEntry
  command: string
  cwd?: string
  label: string
  owner?: string
}

const EXIT_MARK = '__DSH_RW_EXIT__'
const LAUNCH_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 10_000
const CLEANUP_TIMEOUT_MS = 5_000
const MAX_TIMER_DELAY = 2_147_483_647

function launchCommand(command: string, logPath: string, cwd: string | undefined): string {
  const inner = `{ ${command}\n} > ${shq(logPath)} 2>&1\nprintf '\\n${EXIT_MARK}:%d\\n' "$?" >> ${shq(logPath)}`
  // A missing workspace/setsid is a launch failure, never a silent fallback cwd.
  const cd = cwd !== undefined ? `cd ${shq(cwd)} || exit $?; ` : ''
  return `${cd}command -v setsid >/dev/null 2>&1 || exit 127; setsid sh -c ${shq(inner)} >/dev/null 2>&1 & echo $!`
}
function parseLog(body: string): { output: string; exitCode: number | null } {
  const at = body.lastIndexOf(`${EXIT_MARK}:`)
  if (at < 0) return { output: body, exitCode: null }
  const match = /^(-?\d+)/.exec(body.slice(at + EXIT_MARK.length + 1))
  if (!match) return { output: body, exitCode: null }
  return { output: body.slice(0, at).replace(/\n$/, ''), exitCode: Number.parseInt(match[1]!, 10) }
}
function parsePid(result: ExecResult): number | null {
  if (result.code !== 0 || result.timedOut) return null
  const line = result.stdout.trim().split('\n').pop() ?? ''
  if (!/^\d+$/.test(line)) return null
  const pid = Number(line)
  // Never signal pid 0/1 or an unparsed string; $! is one positive owned pid.
  return Number.isSafeInteger(pid) && pid > 1 && pid <= 2_147_483_647 ? pid : null
}
function stopError(options: RemoteIoOptions): RwError {
  const cause = options.signal?.reason
  const timedOut = cause instanceof RwError && cause.code === 'OPERATION_TIMEOUT' ||
    options.deadlineMs !== undefined && Date.now() >= options.deadlineMs
  return new RwError(timedOut ? 'OPERATION_TIMEOUT' : 'OPERATION_ABORTED',
    timedOut ? 'remote job I/O deadline elapsed' : 'remote job I/O cancelled', { cause, outcome: 'unknown' })
}
async function scopedIo<T>(options: RemoteIoOptions, body: (effective: Readonly<RemoteIoOptions>) => Promise<T>): Promise<T> {
  const bounded = { ...options, deadlineMs: Math.min(options.deadlineMs ?? Infinity, Date.now() + (options.timeoutMs ?? LAUNCH_TIMEOUT_MS)) }
  return detachedRemoteIo(() => runRemoteIo(bounded, async () => {
    assertRemoteIoActive()
    const effective = currentRemoteIoOptions()
    if (!effective) throw new Error('remote job I/O has no owned scope')
    return await body(effective)
  }))
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(stopError({ signal }))
  return new Promise<void>((resolve, reject) => {
    const finish = (body: () => void) => { clearTimeout(timer); signal.removeEventListener('abort', abort); body() }
    const timer = setTimeout(() => finish(resolve), Math.min(ms, MAX_TIMER_DELAY))
    const abort = () => finish(() => reject(stopError({ signal })))
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function startRemoteJob(deps: RemoteJobDeps, jobs: JobsRegistryLike, opts: StartRemoteJobOptions): string {
  const pollMs = deps.pollMs ?? 500
  const maxLifetimeMs = deps.maxLifetimeMs ?? 12 * 60 * 60 * 1000
  if (!Number.isFinite(pollMs) || pollMs <= 0 || !Number.isFinite(maxLifetimeMs) || maxLifetimeMs <= 0) {
    throw new RwError('INVALID_INPUT', 'remote job polling and lifetime budgets must be positive finite numbers', { outcome: 'not-started' })
  }
  const logDir = deps.logDir ?? '/tmp'
  const entry: HostEntry = { ...opts.entry, auth: { ...opts.entry.auth } }
  return jobs.start({
    kind: 'bash', label: opts.label,
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
    run(job) {
      // Registry callbacks can run after the admitting tool's scope has ended.
      return detachedRemoteIo(() => {
        const logPath = `${logDir}/.dsh-rw-job-${job.id}.log`
        const deadlineMs = Date.now() + maxLifetimeMs
        const controller = new AbortController()
        let expired = false
        let cancelled: { reason?: string } | null = null
        let terminal = false
        let pid: number | null = null
        let sent = 0
        let lifetimeTimer: ReturnType<typeof setTimeout> | undefined
        const cleanup = new Map<number, Promise<JobOutcomeLike>>()
        let resolveDone!: (outcome: JobOutcomeLike) => void
        const done = new Promise<JobOutcomeLike>(resolve => { resolveDone = resolve })
        const finish = (outcome: JobOutcomeLike) => {
          if (terminal) return
          terminal = true
          if (lifetimeTimer) clearTimeout(lifetimeTimer)
          resolveDone(outcome)
        }
        const armLifetime = (remaining: number) => {
          if (remaining <= 0) {
            expired = true
            controller.abort(new RwError('OPERATION_TIMEOUT', 'remote job lifetime elapsed', { outcome: 'unknown' }))
            return
          }
          const chunk = Math.min(remaining, MAX_TIMER_DELAY)
          lifetimeTimer = setTimeout(() => armLifetime(remaining - chunk), chunk)
          lifetimeTimer.unref?.()
        }
        armLifetime(maxLifetimeMs)
        const cancel = (reason?: string) => {
          if (terminal || cancelled) return
          cancelled = { ...(reason !== undefined ? { reason } : {}) }
          controller.abort(new RwError('OPERATION_ABORTED', 'remote job cancellation requested', { outcome: 'unknown' }))
        }
        const cancellationPrefix = () => cancelled?.reason ?? 'cancellation requested'
        const stopKnownPid = (ownedPid: number): Promise<JobOutcomeLike> => {
          const old = cleanup.get(ownedPid)
          if (old) return old
          const attempt = (async (): Promise<JobOutcomeLike> => {
            try {
              // PID reuse must not signal an unrelated process. This exact log
              // token belongs to this launch's sh command line; never killall or
              // guess a process group. TERM acknowledgement is not exit proof.
              const command = `case "$(ps -ww -p ${ownedPid} -o args= 2>/dev/null)" in *${shq(logPath)}*) kill -TERM ${ownedPid} ;; *) exit 73 ;; esac`
              const result = await scopedIo({ timeoutMs: CLEANUP_TIMEOUT_MS }, effective => deps.exec(entry, command, effective))
              if (result.code !== 0 || result.timedOut) {
                return { status: 'failed', detail: `${cancellationPrefix()}; stop outcome unknown for owned PID ${ownedPid}; signal/identity was not acknowledged` }
              }
              return { status: 'killed', detail: `${cancellationPrefix()}; TERM acknowledged for owned PID ${ownedPid}; process exit is not confirmed` }
            } catch (error) {
              return { status: 'failed', detail: `${cancellationPrefix()}; stop outcome unknown for owned PID ${ownedPid}; ${error instanceof Error ? error.message : String(error)}` }
            }
          })()
          cleanup.set(ownedPid, attempt)
          return attempt
        }
        const lifetimeFailure = (): JobOutcomeLike => ({ status: 'failed', detail: `stopped narrating after ${Math.round(maxLifetimeMs / 60000)} min; the process may still be running` })

        const task = Promise.resolve().then(async (): Promise<JobOutcomeLike> => {
          if (cancelled) return { status: 'killed', detail: `${cancellationPrefix()}; cancelled before remote launch was dispatched` }
          if (expired) return lifetimeFailure()
          let launch: ExecResult
          try {
            // Caller cancellation reaches connect/open/dispatch. Do not keep
            // launching a detached command merely to collect a PID after Stop.
            // An acknowledged PID is still retained for bounded owned cleanup.
            launch = await scopedIo({ signal: controller.signal, timeoutMs: LAUNCH_TIMEOUT_MS, deadlineMs }, effective =>
              deps.exec(entry, launchCommand(opts.command, logPath, opts.cwd), effective).then(result => {
                // Keep an acknowledged PID even if the enclosing deadline check
                // rejects immediately afterwards. This continuation is awaited;
                // no hidden launch/cleanup remains after the provider quiesces.
                pid = parsePid(result)
                return result
              }))
          } catch (error) {
            if (cancelled && pid !== null) return stopKnownPid(pid)
            if (expired) return lifetimeFailure()
            const notStarted = error instanceof RwError && error.outcome === 'not-started'
            if (cancelled && notStarted) return { status: 'killed', detail: `${cancellationPrefix()}; remote launch was not dispatched` }
            return { status: 'failed', detail: `remote launch outcome ${notStarted ? 'not-started' : 'unknown'}; ${error instanceof Error ? error.message : String(error)}; the process may have started; launch was not retried; inspect launch token ${logPath} before further action` }
          }
          if (launch.code !== 0 || launch.timedOut) {
            return { status: 'failed', detail: `could not start the remote job (exit ${launch.code ?? 'null'})${launch.stderr.trim() ? `: ${launch.stderr.trim()}` : ''}` }
          }
          pid = parsePid(launch)
          if (pid === null) return { status: 'failed', detail: 'remote launch returned no valid owned PID; launch/stop outcome unknown; the process may have started' }
          if (cancelled) return stopKnownPid(pid)
          if (expired) return lifetimeFailure()
          job.updateProgress(`running on ${entry.alias}`)
          for (;;) {
            try {
              await pause(pollMs, controller.signal)
              const body = await scopedIo({ signal: controller.signal, timeoutMs: POLL_TIMEOUT_MS, deadlineMs }, effective => deps.readFile(entry, logPath, effective))
              if (body !== null) {
                const { output, exitCode } = parseLog(body)
                if (output.length > sent) { job.append(output.slice(sent)); sent = output.length }
                // A recorded exit is stronger than a simultaneous cancel intent;
                // do not signal a pid which may already have been recycled.
                if (exitCode !== null) return { status: exitCode === 0 ? 'completed' : 'failed', detail: `exit code: ${exitCode}` }
              }
              if (cancelled) return stopKnownPid(pid)
              if (expired) return lifetimeFailure()
            } catch (error) {
              if (cancelled) return stopKnownPid(pid)
              if (expired || Date.now() >= deadlineMs) return lifetimeFailure()
              return { status: 'failed', detail: `lost the job log: ${error instanceof Error ? error.message : String(error)}; the process may still be running` }
            }
          }
        })
        void task.then(finish, error => finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) }))
        return { cancel, done }
      })
    },
  })
}
