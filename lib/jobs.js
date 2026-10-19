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
import { shq } from './guard.js';
/** The line the wrapper writes once the command finishes; carries the exit code. */
const EXIT_MARK = '__DSH_RW_EXIT__';
/** Build the detached launch line: the command runs in its own session and its
 *  log gets an exit marker, so one log read tells us both output and status. */
function launchCommand(command, logPath, cwd) {
    const inner = `{ ${command}\n} > ${shq(logPath)} 2>&1\nprintf '\\n${EXIT_MARK}:%d\\n' "$?" >> ${shq(logPath)}`;
    const cd = cwd !== undefined ? `cd ${shq(cwd)} 2>/dev/null; ` : '';
    // `setsid` detaches from the SSH channel so closing it cannot kill the job;
    // the trailing `echo $!` reports the pid we later signal.
    return `${cd}setsid sh -c ${shq(inner)} >/dev/null 2>&1 & echo $!`;
}
/** Split a log body into its narration and (once present) the exit code. */
function parseLog(body) {
    const at = body.lastIndexOf(`${EXIT_MARK}:`);
    if (at < 0)
        return { output: body, exitCode: null };
    const after = body.slice(at + EXIT_MARK.length + 1);
    const match = /^(-?\d+)/.exec(after);
    if (match === null)
        return { output: body, exitCode: null };
    // Drop the newline that introduced the marker, not a byte the command wrote.
    const output = body.slice(0, at).replace(/\n$/, '');
    return { output, exitCode: Number.parseInt(match[1], 10) };
}
/**
 * Start one command on the host as a registry job and return the job id.
 *
 * The starter is synchronous (the registry's contract), so the async launch and
 * the polling loop run in a floating task that narrates through `job.append`;
 * `done` settles exactly once, from the exit marker, from a cancellation, or
 * from the lifetime cap.
 */
export function startRemoteJob(deps, jobs, opts) {
    const pollMs = deps.pollMs ?? 500;
    const maxLifetimeMs = deps.maxLifetimeMs ?? 12 * 60 * 60 * 1000;
    const logDir = deps.logDir ?? '/tmp';
    return jobs.start({
        kind: 'bash',
        label: opts.label,
        ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
        run(job) {
            const logPath = `${logDir}/.dsh-rw-job-${job.id}.log`;
            let pid = null;
            let cancelled = null;
            let settle = () => undefined;
            const done = new Promise((resolve) => {
                let settled = false;
                settle = (outcome) => {
                    if (settled)
                        return;
                    settled = true;
                    resolve(outcome);
                };
            });
            const cancel = (reason) => {
                if (cancelled !== null)
                    return;
                cancelled = { reason };
                if (pid !== null) {
                    // Best effort: the job is already settled from the model's side.
                    void deps.exec(opts.entry, `kill -TERM ${pid} 2>/dev/null; exit 0`, {}).catch(() => undefined);
                }
                settle({ status: 'killed', ...(reason !== undefined ? { detail: reason } : {}) });
            };
            void (async () => {
                const launch = await deps.exec(opts.entry, launchCommand(opts.command, logPath, opts.cwd), {});
                if (cancelled !== null)
                    return;
                if (launch.code !== 0) {
                    settle({
                        status: 'failed',
                        detail: `could not start the remote job (exit ${launch.code ?? 'null'})${launch.stderr.trim() ? `: ${launch.stderr.trim()}` : ''}`,
                    });
                    return;
                }
                const reported = Number.parseInt(launch.stdout.trim().split('\n').pop() ?? '', 10);
                pid = Number.isFinite(reported) ? reported : null;
                job.updateProgress(`running on ${opts.entry.alias}`);
                const startedAt = Date.now();
                let sent = 0;
                for (;;) {
                    if (cancelled !== null)
                        return;
                    if (Date.now() - startedAt > maxLifetimeMs) {
                        settle({ status: 'failed', detail: `stopped narrating after ${Math.round(maxLifetimeMs / 60000)} min; the process may still be running` });
                        return;
                    }
                    await new Promise((resolve) => setTimeout(resolve, pollMs));
                    let body;
                    try {
                        body = await deps.readFile(opts.entry, logPath);
                    }
                    catch (err) {
                        settle({ status: 'failed', detail: `lost the job log: ${err instanceof Error ? err.message : String(err)}` });
                        return;
                    }
                    if (body === null)
                        continue;
                    const { output, exitCode } = parseLog(body);
                    if (output.length > sent) {
                        job.append(output.slice(sent));
                        sent = output.length;
                    }
                    if (exitCode !== null) {
                        settle({
                            status: exitCode === 0 ? 'completed' : 'failed',
                            detail: `exit code: ${exitCode}`,
                        });
                        return;
                    }
                }
            })().catch((err) => {
                settle({ status: 'failed', detail: err instanceof Error ? err.message : String(err) });
            });
            return { cancel, done };
        },
    });
}
