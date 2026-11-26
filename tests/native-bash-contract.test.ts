// Exercise dsh-rw values against the actually installed Native bash definition.
// The fixture alone accesses ASAR, under Electron; it only captures definitions
// and invokes the shipped validator, never a Native command or SSH connection.
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ensurePlaceholder } from '../src/placeholder.js'
import { SessionStore } from '../src/session.js'
import { makeShim } from '../src/shim.js'
import type { ShimDeps } from '../src/shim.js'
import { runRemoteIo } from '../src/io-context.js'
import type { JobsRegistryLike } from '../src/jobs.js'
import { ENTRY_PROD, FakeHosts, FakePool } from './p4-fakes.js'

const runtime = process.env.DSH_NODE_EXECUTABLE
const install = process.env.DSH_INSTALL_DIR
const available = Boolean(runtime && install)
const fixture = fileURLToPath(new URL('./fixtures/native-bash-definition.mjs', import.meta.url))
interface Captured {
  nativeVersion: string
  executionAttempts: number
  parameters: Record<string, unknown>
  outputSchema: { oneOf: Record<string, unknown>[] }
}
interface Validation { nativeVersion: string; executionAttempts: number; results: { errors: string[]; presentationMeta?: { cwd: string } }[] }
function invoke(mode: 'capture' | 'validate', values?: unknown[]): Captured | Validation {
  if (!runtime || !install) throw new Error('the installed Native contract runtime is unavailable')
  return JSON.parse(execFileSync(runtime, [fixture, mode], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    input: mode === 'validate' ? JSON.stringify(values) : undefined, encoding: 'utf8', timeout: 10_000,
    maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })) as Captured | Validation
}
let native: Captured
let dir: string
let h: { pool: FakePool; root: string; deps: ShimDeps }
const LOCAL: ToolExecutionResult = { isError: false, value: 'local', content: [{ type: 'text', text: 'local' }] }
function call(args: Record<string, unknown>, signal = new AbortController().signal): ToolDispatchExecution {
  return { name: 'bash', arguments: args, signal, agent: { id: 'agent-contract', session: { header: { cwd: h.root } } } } as unknown as ToolDispatchExecution
}
async function valueFor(args: Record<string, unknown>) {
  const result = await makeShim(h.deps).onExecute(call(args), async () => LOCAL)
  if (result.isError) throw new Error(JSON.stringify(result.error))
  return { value: result.value as Record<string, unknown>, text: result.content[0]?.type === 'text' ? result.content[0].text : '' }
}
function valid(value: unknown, cwd: string) {
  const result = invoke('validate', [value]) as Validation
  expect(result.nativeVersion).toBe(native.nativeVersion)
  expect(result.executionAttempts).toBe(0)
  expect(result.results[0]?.errors).toEqual([])
  expect(result.results[0]?.presentationMeta).toEqual({ cwd })
}

describe.runIf(available)('installed Native bash output contract', () => {
  beforeAll(() => { native = invoke('capture') as Captured })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-rw-native-contract-'))
    const pool = new FakePool()
    pool.fs.addDir('/srv/app/src')
    const sessions = new SessionStore(join(dir, 'sessions.json'))
    const root = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', { root: join(dir, 'placeholders') })
    h = { pool, root, deps: { hosts: new FakeHosts(), pool, session: sessions,
      placeholderRoot: join(dir, 'placeholders'), placeholderBaseDir: join(dir, 'legacy'),
      config: { shim: true, shimBash: true, shimBashApproval: 'native', commandTimeoutMs: 30_000, maxOutputChars: 100_000 },
      getTool: () => ({ parameters: native.parameters }) } }
  })
  afterEach(() => {
    if (!basename(dir).startsWith('dsh-rw-native-contract-') || lstatSync(dir).isSymbolicLink() || !realpathSync(dir).startsWith(realpathSync(tmpdir()) + sep)) throw new Error('unexpected contract fixture cleanup target')
    rmSync(dir, { recursive: true, force: true })
  })

  it('captures the shipped definition and rejects the old missing-cwd DTO with its full validator', async () => {
    expect(native.nativeVersion).toMatch(/^0\.2\.2(?:-|$)/)
    expect(native.executionAttempts).toBe(0)
    expect(native.outputSchema.oneOf).toHaveLength(3)
    const { value, text } = await valueFor({ command: 'pwd', description: 'Inspect mapped working directory' })
    expect(value.cwd).toBe(h.root)
    expect(text).toContain('remote cwd: /srv/app')
    valid(value, h.root)
    const oldValue = { ...value }
    delete oldValue.cwd
    const rejected = invoke('validate', [oldValue]) as Validation
    expect(rejected.results[0]?.errors.length).toBeGreaterThan(0)
  })

  it.each(['src', 'absolute'])('maps %s workdir override back for Native path presentation', async mode => {
    const override = mode === 'absolute' ? join(h.root, 'src') : 'src'
    const { value, text } = await valueFor({ command: 'pwd', description: 'Inspect override directory', workdir: override })
    expect(h.pool.execCalls[0]?.opts?.cwd).toBe('/srv/app/src')
    expect(text).toContain('remote cwd: /srv/app/src')
    valid(value, join(h.root, 'src'))
  })

  it('keeps an outside workdir local rather than forcing a remote value', async () => {
    let passed = false
    const controller = new AbortController()
    controller.abort()
    const result = await makeShim(h.deps).onExecute(call({ command: 'pwd', description: 'Local path', workdir: '/outside-contract' }, controller.signal), async () => { passed = true; return LOCAL })
    expect(result).toBe(LOCAL)
    expect(passed).toBe(true)
    expect(h.pool.execCalls).toEqual([])
  })

  it.each([
    { code: 3, signal: null, timedOut: false, stdout: 'partial\n', stderr: 'failure\n' },
    { code: null, signal: 'TIMEOUT', timedOut: true, stdout: 'partial\n', stderr: '' },
    { code: null, signal: 'SIGTERM', timedOut: false, stdout: '', stderr: 'terminated\n' },
  ])('validates nonzero/timeout/signal foreground outcomes: $signal $code', async outcome => {
    h.pool.execQueue.push(outcome)
    const { value } = await valueFor({ command: 'fixture-command', description: 'Validate terminal outcome', timeoutMs: 20_000 })
    expect(value.exitCode).toBe(outcome.code)
    expect(value.signal).toBe(outcome.signal)
    expect(value.timedOut).toBe(outcome.timedOut)
    expect(value.timeoutMs).toBe(20_000)
    valid(value, h.root)
  })

  it('validates truncation flags and stdout/stderr against the complete Native branch', async () => {
    h.pool.execQueue.push({ code: 0, signal: null, timedOut: false, stdout: 'out\n…[truncated]', stderr: 'err\n…[truncated]' })
    const { value } = await valueFor({ command: 'fixture-command', description: 'Validate capped output' })
    expect(value.stdout).toEqual({ text: 'out\n…[truncated]', truncated: true })
    expect(value.stderr).toEqual({ text: 'err\n…[truncated]', truncated: true })
    valid(value, h.root)
  })

  it('maps background cwd and runs a delayed registry starter outside the ended parent scope', async () => {
    let captured: Parameters<JobsRegistryLike['start']>[0] | undefined
    const registry: JobsRegistryLike = { start: spec => { captured = spec; return 'bash-contract' } }
    h.deps.jobs = registry
    const parent = new AbortController()
    const result = await makeShim(h.deps).onExecute(call({ command: 'fixture-background', description: 'Start detached fixture', workdir: join(h.root, 'src'), run_in_background: true }, parent.signal), async () => LOCAL)
    if (result.isError) throw new Error(JSON.stringify(result.error))
    expect(result.value).toEqual({ kind: 'background', jobId: 'bash-contract', cwd: join(h.root, 'src') })
    valid(result.value, join(h.root, 'src'))
    expect(captured).toBeDefined()
    h.pool.execQueue.push({ code: 0, signal: null, timedOut: false, stdout: '123\n', stderr: '' })
    h.pool.fs.addDir('/tmp').addFile('/tmp/.dsh-rw-job-bash-contract.log', 'job output\n__DSH_RW_EXIT__:0\n')
    parent.abort(new Error('caller scope finished'))
    const hooks = await runRemoteIo({ timeoutMs: 1000 }, async () => captured!.run({ id: 'bash-contract', append: () => {}, updateProgress: () => {} }))
    await expect(hooks.done).resolves.toMatchObject({ status: 'completed' })
    expect(h.pool.execCalls[0]?.command).toContain("cd '/srv/app/src' || exit")
  })
})
