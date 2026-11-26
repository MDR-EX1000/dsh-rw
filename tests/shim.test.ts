// Shim-mode tests: the middlewares are driven directly with fake exec/next
// pairs (same mock discipline as tests/index.test.ts), plus one apply() wiring
// test with a hand-built ctx that captures ctx.on registrations.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'
import type { Config } from '../src/index.js'
import { ensurePlaceholder, HOST_OWNER_FILE } from '../src/placeholder.js'
import { SessionStore } from '../src/session.js'
import { createNativeRouting, makeShim } from '../src/shim.js'
import type { ShimConfig, ShimDeps } from '../src/shim.js'
import { currentRemoteIoOptions, ownRemoteIoResource } from '../src/io-context.js'
import type { RemoteIoOptions } from '../src/io-context.js'
import { RwError } from '../src/errors.js'
import type { ExecResult } from '../src/ssh-pool.js'
import type { HostEntry } from '../src/hosts.js'
import { FAKE_MTIME, FakeSftp } from './fakes.js'
import type { FakeStat } from './fakes.js'
import { ENTRY_DEV, ENTRY_PROD, FakeHosts, FakePool } from './p4-fakes.js'

const SHIM_CONFIG: ShimConfig = {
  shim: true,
  shimBash: true,
  shimBashApproval: 'ask',
  commandTimeoutMs: 30000,
  maxOutputChars: 200000,
}

/** dsh-tool-bash parameter shape: only the one-shot flavor declares workdir/timeoutMs/description. */
const ONE_SHOT_BASH = { parameters: { properties: { command: {}, description: {}, timeoutMs: {}, workdir: {} } } }
const PERSISTENT_BASH = { parameters: { properties: { command: {} } } }

const LOCAL_RESULT: ToolExecutionResult = { isError: false, value: 'local', content: [{ type: 'text', text: 'local' }] }

function execResult(stdout: string, extra?: Partial<ExecResult>): ExecResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false, ...extra }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-shim-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeHarness() {
  const hosts = new FakeHosts()
  const pool = new FakePool()
  const sessions = new SessionStore(join(dir, 'sessions.json'))
  const session = sessions.view('')
  const placeholderBaseDir = join(dir, 'placeholders')
  const placeholderRoot = join(dir, 'rw-root')
  pool.fs.addDir('/srv/app/src').addFile('/srv/app/README.md', 'line1\nline2\nline3\n').addFile('/srv/app/src/index.ts', 'export {}\n')
  return { hosts, pool, sessions, session, placeholderBaseDir, placeholderRoot }
}

type Harness = ReturnType<typeof makeHarness>

/** Activate the 'prod' @ /srv/app session and create its on-disk placeholder; returns the placeholder dir. */
function connect(h: Harness): string {
  h.session.set({ alias: 'prod', workspace: '/srv/app' })
  return ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', { root: h.placeholderRoot, legacyBaseDir: h.placeholderBaseDir })
}

function makeDeps(h: Harness, overrides?: Partial<ShimDeps>): ShimDeps {
  return {
    hosts: h.hosts,
    pool: h.pool,
    session: h.sessions,
    config: { ...SHIM_CONFIG },
    placeholderBaseDir: h.placeholderBaseDir,
    placeholderRoot: h.placeholderRoot,
    getTool: () => ONE_SHOT_BASH,
    ...overrides,
  }
}

function execOf(name: string, args: Record<string, unknown>, cwd?: string, signal?: AbortSignal): ToolDispatchExecution {
  return {
    name,
    arguments: args,
    signal: signal ?? new AbortController().signal,
    ...(cwd !== undefined ? { agent: { session: { header: { cwd } } } } : {}),
  } as unknown as ToolDispatchExecution
}

/** A next() that records whether the call passed through to the local tool. */
function makeNext() {
  let calls = 0
  const next = async (): Promise<ToolExecutionResult> => {
    calls += 1
    return LOCAL_RESULT
  }
  return { next, passedThrough: () => calls > 0 }
}

function bashText(body: string, cwd = '/srv/app', alias = 'prod'): string {
  return `[dsh-rw: ${alias}; remote cwd: ${cwd}]\n${body}`
}

function text(result: ToolExecutionResult): string {
  const block = result.content[0]
  return block !== undefined && block.type === 'text' ? block.text : ''
}

describe('shim pass-through', () => {
  it('shim: false passes every native call through with zero pool activity', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h, { config: { ...SHIM_CONFIG, shim: false } }))
    const cases: [string, Record<string, unknown>][] = [
      ['read', { file_path: join(root, 'README.md') }],
      ['write', { file_path: join(root, 'x.txt'), content: 'x' }],
      ['edit', { file_path: join(root, 'README.md'), old_string: 'a', new_string: 'b' }],
      ['str_replace_editor', { command: 'view', path: root }],
      ['glob', { pattern: '*' }],
      ['grep', { pattern: 'line' }],
      ['bash', { command: 'ls', description: 'list files' }],
    ]
    for (const [name, args] of cases) {
      const { next, passedThrough } = makeNext()
      const res = await shim.onExecute(execOf(name, args, root), next)
      expect(res).toBe(LOCAL_RESULT)
      expect(passedThrough()).toBe(true)
    }
    const pre = await shim.onPreExecute(execOf('bash', { command: 'ls' }, root) as unknown as ToolExecution, async () => ({
      kind: 'allow',
    }))
    expect(pre).toEqual({ kind: 'allow' })
    expect(h.pool.execCalls).toEqual([])
    expect(h.pool.connectedAliases.size).toBe(0)
  })

  it('passes through when no remote session is active', async () => {
    const h = makeHarness()
    // No session.set: the remote workspace is not active.
    const shim = makeShim(makeDeps(h))
    const { next, passedThrough } = makeNext()
    const res = await shim.onExecute(execOf('read', { file_path: '/anywhere/file.txt' }, '/anywhere'), next)
    expect(res).toBe(LOCAL_RESULT)
    expect(passedThrough()).toBe(true)
    expect(h.pool.connectedAliases.size).toBe(0)
  })

  it('passes through paths outside the placeholder workspace', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    // Outside the whole mirror root. (A sibling like join(root, '..', 'x') is
    // remote only when some picked workspace — e.g. remote '/' — contains it.)
    for (const args of [{ file_path: '/etc/passwd' }, { file_path: join(h.placeholderRoot, '..', 'escape.txt') }]) {
      const { next, passedThrough } = makeNext()
      const res = await shim.onExecute(execOf('read', args, root), next)
      expect(res).toBe(LOCAL_RESULT)
      expect(passedThrough()).toBe(true)
    }
    expect(h.pool.connectedAliases.size).toBe(0)
  })

  it('passes bash through when the session cwd is outside the placeholder (or unknown)', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    for (const cwd of ['/tmp/elsewhere', undefined]) {
      const { next, passedThrough } = makeNext()
      const res = await shim.onExecute(execOf('bash', { command: 'ls', description: 'list' }, cwd), next)
      expect(res).toBe(LOCAL_RESULT)
      expect(passedThrough()).toBe(true)
    }
  })

  it('refuses a background bash call instead of running it on the local machine', async () => {
    const h = makeHarness()
    const root = connect(h)
    // No job registry composed: the pre-1.3 behaviour was to pass the call
    // through, which ran it LOCALLY while the session's workspace was remote.
    const shim = makeShim(makeDeps(h))
    const { next, passedThrough } = makeNext()
    const res = await shim.onExecute(execOf('bash', { command: 'make test', run_in_background: true }, root), next)
    expect(passedThrough()).toBe(false)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('background jobs are unavailable')
    expect(text(res)).toContain('LOCAL machine')
    expect(h.pool.execCalls).toEqual([])
  })

  it('starts a background bash call as a REMOTE job when the registry is composed', async () => {
    const h = makeHarness()
    const root = connect(h)
    const started: { kind: string; label: string; owner?: string }[] = []
    const jobs = {
      start(spec: {
        kind: string
        label: string
        owner?: string
        run(job: { id: string; append: () => void; updateProgress: () => void }): {
          cancel: () => void
          done: Promise<{ status: 'completed' | 'killed' | 'failed' }>
        }
      }): string {
        started.push({ kind: spec.kind, label: spec.label, ...(spec.owner !== undefined ? { owner: spec.owner } : {}) })
        spec.run({ id: 'bash-x1', append: () => undefined, updateProgress: () => undefined })
        return 'bash-x1'
      },
    }
    const shim = makeShim(makeDeps(h, { jobs, jobPollMs: 1000 }))
    const { next, passedThrough } = makeNext()
    const res = await shim.onExecute(execOf('bash', { command: 'make test', run_in_background: true }, root), next)
    expect(passedThrough()).toBe(false)
    expect(res.isError).toBe(false)
    expect(res.value).toEqual({ kind: 'background', jobId: 'bash-x1', cwd: root })
    expect(text(res)).toContain('job_output')
    expect(started).toEqual([{ kind: 'bash', label: 'make test' }])
    // The launch went to the host, not the local machine.
    expect(h.pool.execCalls[0]?.alias).toBe('prod')
    expect(h.pool.execCalls[0]?.command).toContain('setsid sh -c')
  })

  it('bash passes through when shimBash is false', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h, { config: { ...SHIM_CONFIG, shimBash: false } }))
    const { next, passedThrough } = makeNext()
    const res = await shim.onExecute(execOf('bash', { command: 'ls', description: 'list' }, root), next)
    expect(res).toBe(LOCAL_RESULT)
    expect(passedThrough()).toBe(true)
    expect(h.pool.execCalls).toEqual([])
  })
})

describe('shim fs tools', () => {
  it('read maps absolute and relative placeholder paths, with native paging semantics', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))

    const abs = await shim.onExecute(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(abs.isError).toBe(false)
    expect(text(abs)).toBe(
      `<path>${join(root, 'README.md')}</path>\n<type>file</type>\n<content>\n1: line1\n2: line2\n3: line3\n\n(End of file - total 3 lines)\n</content>`,
    )

    // Relative paths resolve against the placeholder root.
    const rel = await shim.onExecute(execOf('read', { file_path: 'README.md', offset: 2, limit: 1 }, root), makeNext().next)
    expect(text(rel)).toContain('2: line2')
    expect(text(rel)).toContain('(Showing lines 2-2 of 3. Use offset=3 to continue.)')
  })

  it('read returns the native schema-shaped value the registry validates against', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(res.value).toEqual({
      path: join(root, 'README.md'),
      offset: 1,
      lines: [
        { number: 1, text: 'line1' },
        { number: 2, text: 'line2' },
        { number: 3, text: 'line3' },
      ],
      totalLines: 3,
    })
  })

  it('write creates parents and reports Created/Updated like the native tool', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))

    const created = await shim.onExecute(execOf('write', { file_path: join(root, 'sub', 'new.txt'), content: 'hello\n' }, root), makeNext().next)
    expect(created.isError).toBe(false)
    expect(text(created)).toBe(`<path>${join(root, 'sub', 'new.txt')}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`)
    expect(h.pool.fs.fileContent('/srv/app/sub/new.txt')).toBe('hello\n')

    const updated = await shim.onExecute(execOf('write', { file_path: 'README.md', content: 'replaced\n' }, root), makeNext().next)
    expect(text(updated)).toContain('Updated file')
    expect(h.pool.fs.fileContent('/srv/app/README.md')).toBe('replaced\n')
  })

  it('write returns the native schema-shaped value the registry validates against', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))

    const created = await shim.onExecute(execOf('write', { file_path: join(root, 'new.txt'), content: 'hello\n' }, root), makeNext().next)
    expect(created.value).toEqual({ path: join(root, 'new.txt'), operation: 'create', before: null, after: 'hello\n' })

    const updated = await shim.onExecute(execOf('write', { file_path: join(root, 'README.md'), content: 'replaced\n' }, root), makeNext().next)
    expect(updated.value).toEqual({
      path: join(root, 'README.md'),
      operation: 'update',
      before: 'line1\nline2\nline3\n',
      after: 'replaced\n',
    })
  })

  it('edit replaces a unique match, enforces uniqueness, and supports replace_all', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))

    const okRes = await shim.onExecute(
      execOf('edit', { file_path: join(root, 'README.md'), old_string: 'line2', new_string: 'LINE2' }, root),
      makeNext().next,
    )
    expect(okRes.isError).toBe(false)
    expect(text(okRes)).toBe(`The file ${join(root, 'README.md')} has been updated successfully.`)
    expect(h.pool.fs.fileContent('/srv/app/README.md')).toBe('line1\nLINE2\nline3\n')

    const ambiguous = await shim.onExecute(
      execOf('edit', { file_path: join(root, 'README.md'), old_string: 'line', new_string: 'row' }, root),
      makeNext().next,
    )
    expect(ambiguous.isError).toBe(true)
    expect(text(ambiguous)).toContain('old_string matched 2 times')

    const all = await shim.onExecute(
      execOf('edit', { file_path: join(root, 'README.md'), old_string: 'line', new_string: 'row', replace_all: true }, root),
      makeNext().next,
    )
    expect(all.isError).toBe(false)
    expect(text(all)).toContain('All occurrences were successfully replaced.')
    expect(h.pool.fs.fileContent('/srv/app/README.md')).toBe('row1\nLINE2\nrow3\n')

    const missing = await shim.onExecute(
      execOf('edit', { file_path: join(root, 'README.md'), old_string: 'nope', new_string: 'x' }, root),
      makeNext().next,
    )
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('old_string was not found')
  })

  it('edit returns the native schema-shaped value the registry validates against', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(
      execOf('edit', { file_path: join(root, 'README.md'), old_string: 'line2', new_string: 'LINE2' }, root),
      makeNext().next,
    )
    expect(res.isError).toBe(false)
    expect(res.value).toEqual({
      path: join(root, 'README.md'),
      before: 'line1\nline2\nline3\n',
      after: 'line1\nLINE2\nline3\n',
    })
  })

  it('edit fails with RW_EDIT_CONFLICT when the remote file moved after the read', async () => {
    /** First stat on the target bumps its mtime, simulating a concurrent remote writer. */
    class ConflictSftp extends FakeSftp {
      private bumped = false

      override async stat(p: string): Promise<FakeStat> {
        const st = await super.stat(p)
        if (!this.bumped && p === '/srv/app/README.md') {
          this.bumped = true
          this.addFile('/srv/app/README.md', 'line1\nline2\nline3\n', FAKE_MTIME + 60)
        }
        return st
      }
    }
    const h = makeHarness()
    const root = connect(h)
    const conflictFs = new ConflictSftp()
    conflictFs.addDir('/srv/app/src').addFile('/srv/app/README.md', 'line1\nline2\nline3\n')
    ;(h.pool as unknown as { fs: FakeSftp }).fs = conflictFs
    const shim = makeShim(makeDeps(h))

    const res = await shim.onExecute(
      execOf('edit', { file_path: join(root, 'README.md'), old_string: 'line2', new_string: 'X' }, root),
      makeNext().next,
    )
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('RW_EDIT_CONFLICT')
    expect(res.isError === true ? res.error?.info?.code : undefined).toBe('RW_EDIT_CONFLICT')
    // The write-back never happened.
    expect(conflictFs.fileContent('/srv/app/README.md')).toBe('line1\nline2\nline3\n')
  })

  it('str_replace_editor view and str_replace follow the Anthropic editor contract', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))

    const view = await shim.onExecute(execOf('str_replace_editor', { command: 'view', path: join(root, 'README.md') }, root), makeNext().next)
    expect(view.isError).toBe(false)
    expect(text(view)).toContain(`Here's the content of ${join(root, 'README.md')} with line numbers (which has a total of 4 lines)`)
    expect(text(view)).toContain('     1  line1')

    const ranged = await shim.onExecute(
      execOf('str_replace_editor', { command: 'view', path: join(root, 'README.md'), view_range: [2, -1] }, root),
      makeNext().next,
    )
    expect(text(ranged)).toContain('with view_range=[2, -1]')
    expect(text(ranged)).toContain('     2  line2')
    expect(text(ranged)).not.toContain('     1  line1')

    const replaced = await shim.onExecute(
      execOf('str_replace_editor', { command: 'str_replace', path: join(root, 'README.md'), old_str: 'line2', new_str: 'LINE2' }, root),
      makeNext().next,
    )
    expect(replaced.isError).toBe(false)
    expect(text(replaced)).toBe(`The file ${join(root, 'README.md')} has been edited successfully.`)
    expect(h.pool.fs.fileContent('/srv/app/README.md')).toBe('line1\nLINE2\nline3\n')

    const ambiguous = await shim.onExecute(
      execOf('str_replace_editor', { command: 'str_replace', path: join(root, 'README.md'), old_str: 'line', new_str: 'x' }, root),
      makeNext().next,
    )
    expect(ambiguous.isError).toBe(true)
    expect(text(ambiguous)).toContain('Multiple occurrences of old_str')
  })

  it('str_replace_editor returns the native string value the registry validates against', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(
      execOf('str_replace_editor', { command: 'str_replace', path: join(root, 'README.md'), old_str: 'line2', new_str: 'LINE2' }, root),
      makeNext().next,
    )
    expect(res.isError).toBe(false)
    // The native output schema is a plain string: value IS the rendered text.
    expect(res.value).toBe(text(res))
    expect(res.value).toBe(`The file ${join(root, 'README.md')} has been edited successfully.`)
  })

  it('str_replace_editor create and insert work against the remote file', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))

    const created = await shim.onExecute(
      execOf('str_replace_editor', { command: 'create', path: join(root, 'new.txt'), file_text: 'a\nb\n' }, root),
      makeNext().next,
    )
    expect(created.isError).toBe(false)
    expect(text(created)).toBe(`New file created successfully at: ${join(root, 'new.txt')}`)
    expect(h.pool.fs.fileContent('/srv/app/new.txt')).toBe('a\nb\n')

    const clash = await shim.onExecute(
      execOf('str_replace_editor', { command: 'create', path: join(root, 'README.md'), file_text: 'x' }, root),
      makeNext().next,
    )
    expect(clash.isError).toBe(true)
    expect(text(clash)).toContain('File already exists at:')

    const inserted = await shim.onExecute(
      execOf('str_replace_editor', { command: 'insert', path: join(root, 'README.md'), insert_line: 1, new_str: 'INSERTED' }, root),
      makeNext().next,
    )
    expect(inserted.isError).toBe(false)
    expect(h.pool.fs.fileContent('/srv/app/README.md')).toBe('line1\nINSERTED\nline2\nline3\n')
  })

  it('str_replace_editor view on a directory lists two levels deep with placeholder paths', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('str_replace_editor', { command: 'view', path: root }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(text(res)).toContain(`Here're the files and directories up to 2 levels deep in ${root}`)
    expect(text(res)).toContain(`f\t${join(root, 'README.md')}`)
    expect(text(res)).toContain(`f\t${join(root, 'src', 'index.ts')}`)
  })
})

describe('shim glob/grep', () => {
  /** rg-branch stdout: the engine marker first, then the tool's own lines. */
  const rgOut = (body: string): string => `__DSH_RW_ENGINE__=rg\n${body}`
  const fallbackOut = (body: string): string => `__DSH_RW_ENGINE__=fallback\n${body}`

  it('glob runs remote rg and maps results back to placeholder paths', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult(rgOut('/srv/app/README.md\n/srv/app/src/index.ts\n')))
    const shim = makeShim(makeDeps(h))

    const res = await shim.onExecute(execOf('glob', { pattern: '*' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(text(res)).toBe(`${join(root, 'README.md')}\n${join(root, 'src', 'index.ts')}`)
    expect(h.pool.execCalls.length).toBe(1)
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app')
  })

  it('glob mirrors the native ripgrep semantics and keeps the find fallback labelled', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult(rgOut('')))
    const shim = makeShim(makeDeps(h))

    await shim.onExecute(execOf('glob', { pattern: '*.ts' }, root), makeNext().next)
    const command = h.pool.execCalls[0]!.command
    // The native argv: sorted, ignoring .gitignore, including hidden files, VCS dirs pruned.
    expect(command).toContain('rg --files')
    expect(command).toContain('--sort=modified')
    expect(command).toContain('--no-ignore')
    expect(command).toContain('--hidden')
    expect(command).toContain(`--glob=!**/.git`)
    expect(command).toContain(`-- '/srv/app'`)
    expect(command).toContain(`find '/srv/app' -type f -name '*.ts'`)

    // A host without ripgrep says so, instead of silently returning find semantics.
    h.pool.execQueue.push(execResult(fallbackOut('/srv/app/src/index.ts\n')))
    const fallback = await shim.onExecute(execOf('glob', { pattern: '*.ts' }, root), makeNext().next)
    expect(text(fallback)).toContain(join(root, 'src', 'index.ts'))
    expect(text(fallback)).toContain('ripgrep is not installed')
  })

  it('glob with an explicit path searches there; a path outside the placeholder passes through', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult(rgOut('/srv/app/src/index.ts\n')))
    const shim = makeShim(makeDeps(h))

    const res = await shim.onExecute(execOf('glob', { pattern: '*.ts', path: join(root, 'src') }, root), makeNext().next)
    expect(text(res)).toBe(join(root, 'src', 'index.ts'))
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app/src')

    const { next, passedThrough } = makeNext()
    const outside = await shim.onExecute(execOf('glob', { pattern: '*', path: '/usr/lib' }, root), next)
    expect(outside).toBe(LOCAL_RESULT)
    expect(passedThrough()).toBe(true)
    expect(h.pool.execCalls.length).toBe(1)
  })

  it('glob returns the native schema-shaped value the registry validates against', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult(rgOut('/srv/app/README.md\n/srv/app/src/index.ts\n')))
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('glob', { pattern: '*' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(res.value).toEqual({
      root,
      paths: [join(root, 'README.md'), join(root, 'src', 'index.ts')],
    })
  })

  it('grep parses rg --json, maps paths back to placeholders, and groups by file', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(
      execResult(
        rgOut(
          '{"type":"begin","data":{"path":{"text":"/srv/app/src/index.ts"}}}\n' +
            '{"type":"match","data":{"path":{"text":"/srv/app/src/index.ts"},"line_number":1,"lines":{"text":"export {}\\n"}}}\n' +
            '{"type":"match","data":{"path":{"text":"/srv/app/README.md"},"line_number":2,"lines":{"text":"line2\\n"}}}\n',
        ),
      ),
    )
    const shim = makeShim(makeDeps(h))

    const res = await shim.onExecute(execOf('grep', { pattern: 'e', path: root }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(text(res)).toBe(
      `Found 2 matches\n\n${join(root, 'src', 'index.ts')}\nLine 1: export {}\n\n${join(root, 'README.md')}\nLine 2: line2`,
    )
    expect(h.pool.execCalls[0]!.command).toContain('rg --json --regexp=')
    expect(h.pool.execCalls[0]!.command).toContain(`grep -rnI -E -e 'e' -- '/srv/app'`)

    h.pool.execQueue.push(execResult(rgOut(''), { code: 1 }))
    const none = await shim.onExecute(execOf('grep', { pattern: 'zzz', path: root }, root), makeNext().next)
    expect(text(none)).toBe('No matches found')
  })

  it('grep keeps a colon-bearing path intact (rg --json transport, not colon splitting)', async () => {
    const h = makeHarness()
    const root = connect(h)
    // A path that would be mis-split by a `path:line:text` parser.
    h.pool.execQueue.push(
      execResult(
        rgOut(
          '{"type":"match","data":{"path":{"text":"/srv/app/a:1:b.ts"},"line_number":7,"lines":{"text":"hit\\n"}}}\n',
        ),
      ),
    )
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('grep', { pattern: 'hit', path: root }, root), makeNext().next)
    expect(res.value).toEqual({ matches: [{ path: join(root, 'a:1:b.ts'), lineNumber: 7, line: 'hit' }] })
  })

  it('grep labels the grep fallback so differing ignore rules are never silent', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult(fallbackOut('/srv/app/README.md:2:line2\n')))
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('grep', { pattern: 'line', path: root }, root), makeNext().next)
    expect(text(res)).toContain(`Line 2: line2`)
    expect(text(res)).toContain('ripgrep is not installed')
  })

  it('grep returns the native schema-shaped value the registry validates against', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(
      execResult(
        rgOut(
          '{"type":"match","data":{"path":{"text":"/srv/app/src/index.ts"},"line_number":1,"lines":{"text":"export {}\\n"}}}\n' +
            '{"type":"match","data":{"path":{"text":"/srv/app/README.md"},"line_number":2,"lines":{"text":"line2\\n"}}}\n',
        ),
      ),
    )
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('grep', { pattern: 'e', path: root }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(res.value).toEqual({
      matches: [
        { path: join(root, 'src', 'index.ts'), lineNumber: 1, line: 'export {}' },
        { path: join(root, 'README.md'), lineNumber: 2, line: 'line2' },
      ],
    })
  })
})

describe('shim bash', () => {
  it('rewrites placeholder paths in the command and runs with the remote workspace as cwd', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('total 3\n'))
    const shim = makeShim(makeDeps(h))

    const res = await shim.onExecute(
      execOf('bash', { command: `ls -la '${join(root, 'src')}' && cat ${join(root, 'README.md')}`, description: 'inspect files' }, root),
      makeNext().next,
    )
    expect(res.isError).toBe(false)
    expect(text(res)).toBe(bashText('total 3'))
    expect(h.pool.execCalls.length).toBe(1)
    // Quoted and bare placeholder forms both rewrite to the remote root.
    expect(h.pool.execCalls[0]!.command).toBe(`ls -la '/srv/app/src' && cat /srv/app/README.md`)
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app')
  })

  it('maps an explicit workdir inside the placeholder; a workdir outside passes through', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('ok\n'))
    const shim = makeShim(makeDeps(h))

    await shim.onExecute(execOf('bash', { command: 'pwd', workdir: join(root, 'src') }, root), makeNext().next)
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app/src')

    const { next, passedThrough } = makeNext()
    const outside = await shim.onExecute(execOf('bash', { command: 'pwd', workdir: '/tmp' }, root), next)
    expect(outside).toBe(LOCAL_RESULT)
    expect(passedThrough()).toBe(true)
    expect(h.pool.execCalls.length).toBe(1)
  })

  it('renders stderr and exit markers like the native bash tool', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('out\n', { code: 3, stderr: 'bad\n' }))
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('bash', { command: 'false-ish', description: 'fail' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(text(res)).toBe(bashText('out\n[stderr]\nbad\n[exit code: 3]'))
  })

  it('returns the native foreground-shaped value the registry validates against', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('out\n', { code: 3, stderr: 'bad\n' }))
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('bash', { command: 'false-ish' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(res.value).toEqual({
      kind: 'foreground',
      cwd: root,
      exitCode: 3,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 30000,
      stdout: { text: 'out\n', truncated: false },
      stderr: { text: 'bad\n', truncated: false },
    })
  })

  it('forwards cancellation and awaits core quiescence without disconnecting a shared alias', async () => {
    const h = makeHarness()
    const root = connect(h)
    let started!: () => void
    const dispatched = new Promise<void>(resolve => { started = resolve })
    let quiesced = false
    h.pool.exec = async (entry: HostEntry, command: string, opts?: RemoteIoOptions & { cwd?: string }): Promise<ExecResult> => {
      h.pool.execCalls.push({ alias: entry.alias, command, ...(opts !== undefined ? { opts } : {}) })
      if (opts?.signal === undefined) throw new Error('caller signal was not forwarded')
      const signal = opts.signal
      return await new Promise<ExecResult>((_resolve, reject) => {
        const abort = () => setTimeout(() => {
          quiesced = true
          signal.removeEventListener('abort', abort)
          reject(new RwError('OPERATION_ABORTED', 'command aborted; remote outcome unknown', { outcome: 'unknown' }))
        }, 20)
        signal.addEventListener('abort', abort, { once: true })
        started()
      })
    }
    const shim = makeShim(makeDeps(h))
    const controller = new AbortController()
    const { next, passedThrough } = makeNext()
    const pending = shim.onExecute(execOf('bash', { command: 'sleep 999', description: 'sleep' }, root, controller.signal), next)
    await dispatched
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(quiesced).toBe(false)
    const res = await pending
    expect(quiesced).toBe(true)
    expect(passedThrough()).toBe(false)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('OPERATION_ABORTED')
    expect(text(res)).toContain('do not automatically repeat')
    expect(h.pool.disconnected).toEqual([])
  })

  it('a persistent bash degrades to a one-shot remote exec with a state note', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('done\n'))
    const shim = makeShim(makeDeps(h, { getTool: () => PERSISTENT_BASH }))
    const res = await shim.onExecute(execOf('bash', { command: 'cd src && ls' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(text(res)).toContain('done')
    expect(text(res)).toContain('NOT preserved between calls')
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app')
  })
})

// Regression for the silent-local-fallback bug (see ISSUE-native-tool-silent-
// local-fallback.md): native tools used to pass through to the local empty
// placeholder whenever the rw_* session alias was null (after rw_disconnect)
// or pointed at a different host than the agent-cwd placeholder. They must
// instead target the remote the workspace (cwd) actually points at — the pool
// redials lazily — and must never silently run on the local placeholder.
describe('shim cwd-anchored target', () => {
  it('Bug A: after disconnect (alias null, workspace kept) native tools still hit the remote, not the local placeholder', async () => {
    const h = makeHarness()
    const root = connect(h) // session: prod @ /srv/app; cwd lives in the prod placeholder
    // rw_disconnect clears alias and keeps workspace (tools.ts:513).
    h.session.set({ alias: null })
    const shim = makeShim(makeDeps(h))

    const res = await shim.onExecute(execOf('read', { file_path: 'README.md' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(res).not.toBe(LOCAL_RESULT)
    expect(text(res)).toContain('line1') // remote content, not the local placeholder
    expect(text(res)).toContain(`<path>${join(root, 'README.md')}</path>`)
    // The pool re-established the remote (lazily) — never touched the local fs.
    expect(h.pool.connectedAliases.has('prod')).toBe(true)
  })

  it('Bug B: when the rw_* host differs from the cwd placeholder, native tools target the cwd host, not the rw_* host and not local', async () => {
    const h = makeHarness()
    const root = connect(h) // cwd = prod placeholder; session: prod @ /srv/app
    // A second workspace on disk; the user reconnected `dev` for rw_* work.
    ensurePlaceholder('dev', ENTRY_DEV, '/srv/dev', { root: h.placeholderRoot, legacyBaseDir: h.placeholderBaseDir })
    h.session.set({ alias: 'dev', workspace: '/srv/dev' })
    h.pool.execQueue.push(execResult('ok\n'))

    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('bash', { command: 'ls', description: 'list' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(text(res)).toBe(bashText('ok'))
    // Targeted the cwd's host (prod @ /srv/app), not dev, and never went local.
    expect(h.pool.execCalls.length).toBe(1)
    expect(h.pool.execCalls[0]!.alias).toBe('prod')
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app')
  })

  it('fails loudly when the cwd is a placeholder whose host is no longer configured (no silent local fallback)', async () => {
    const h = makeHarness()
    connect(h) // establishes the prod placeholder and session
    // A second workspace on disk whose host is NOT in the (overridden) table.
    const devRoot = ensurePlaceholder('dev', ENTRY_DEV, '/srv/dev', { root: h.placeholderRoot, legacyBaseDir: h.placeholderBaseDir })
    const shim = makeShim(makeDeps(h, { hosts: new FakeHosts([ENTRY_PROD]) }))
    // Disconnected: alias null.
    h.session.set({ alias: null })

    const { next, passedThrough } = makeNext()
    const res = await shim.onExecute(execOf('read', { file_path: 'README.md' }, devRoot), next)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('remote-backed')
    expect(text(res)).toContain("'dev'")
    expect(passedThrough()).toBe(false)
    expect(h.pool.execCalls.length).toBe(0)
  })

  // The block is path-aware: in the broken-placeholder state only calls that
  // would touch the placeholder fail; calls rooted elsewhere pass through to
  // the local tool, same as when the remote is healthy.
  describe('path-aware blocking', () => {
    /** Broken-placeholder state: prod connected earlier, dev placeholder on disk, dev's host not configured, session disconnected. */
    function brokenState() {
      const h = makeHarness()
      connect(h)
      const devRoot = ensurePlaceholder('dev', ENTRY_DEV, '/srv/dev', { root: h.placeholderRoot, legacyBaseDir: h.placeholderBaseDir })
      const shim = makeShim(makeDeps(h, { hosts: new FakeHosts([ENTRY_PROD]) }))
      h.session.set({ alias: null })
      return { h, devRoot, shim }
    }

    it('blocks bash (it runs with the session cwd)', async () => {
      const { devRoot, shim } = brokenState()
      const { next, passedThrough } = makeNext()
      const res = await shim.onExecute(execOf('bash', { command: 'ls', description: 'x' }, devRoot), next)
      expect(res.isError).toBe(true)
      expect(text(res)).toContain('remote-backed')
      expect(passedThrough()).toBe(false)
    })

    it('blocks cwd-bound glob (no path arg)', async () => {
      const { devRoot, shim } = brokenState()
      const { next, passedThrough } = makeNext()
      const res = await shim.onExecute(execOf('glob', { pattern: '*.ts' }, devRoot), next)
      expect(res.isError).toBe(true)
      expect(text(res)).toContain('remote-backed')
      expect(passedThrough()).toBe(false)
    })

    it('passes through file calls rooted outside the broken placeholder', async () => {
      const { devRoot, shim } = brokenState()
      const { next, passedThrough } = makeNext()
      const res = await shim.onExecute(execOf('read', { file_path: join(dir, 'elsewhere.txt') }, devRoot), next)
      expect(res.isError).toBe(false)
      expect(passedThrough()).toBe(true)
    })

    it('passes through grep rooted outside the broken placeholder', async () => {
      const { devRoot, shim } = brokenState()
      const { next, passedThrough } = makeNext()
      const res = await shim.onExecute(execOf('grep', { pattern: 'x', path: dir }, devRoot), next)
      expect(res.isError).toBe(false)
      expect(passedThrough()).toBe(true)
    })
  })

  it('targets the remote when the cwd is a nested subdirectory of the placeholder', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('ok\n'))
    const shim = makeShim(makeDeps(h))
    const nested = join(root, 'src') // need not exist on disk — lexical containment applies
    const res = await shim.onExecute(execOf('bash', { command: 'ls', description: 'x' }, nested), makeNext().next)
    expect(res.isError).toBe(false)
    expect(h.pool.execCalls.length).toBe(1)
    expect(h.pool.execCalls[0]!.alias).toBe('prod')
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app')
  })

  it('falls back to the rw_* session target when the agent cwd is unknown', async () => {
    const h = makeHarness()
    connect(h)
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('read', { file_path: 'README.md' }), makeNext().next) // no agent cwd
    expect(res.isError).toBe(false)
    expect(text(res)).toContain('line1')
  })

  it('treats a placeholder-shaped directory without a meta file as local (pass-through)', async () => {
    const h = makeHarness()
    connect(h)
    const ghost = join(h.placeholderBaseDir, 'prod', 'meta-less-dir')
    mkdirSync(ghost, { recursive: true })
    const shim = makeShim(makeDeps(h))
    const { next, passedThrough } = makeNext()
    const res = await shim.onExecute(execOf('read', { file_path: join(ghost, 'x.txt') }, ghost), next)
    expect(res.isError).toBe(false)
    expect(passedThrough()).toBe(true)
    expect(h.pool.execCalls.length).toBe(0)
  })
})

describe('shim pre-execute approval', () => {
  const allowNext = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

  it('escalates shimmed bash to ask with the remote alias in the reason', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    const decision = await shim.onPreExecute(execOf('bash', { command: 'ls' }, root) as unknown as ToolExecution, allowNext)
    expect(decision).toEqual({ kind: 'ask', reason: `run on remote host 'prod' (dsh-rw shim)` })
  })

  it('never escalates fs tools, and defers when approval is native or the cwd is outside', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))

    const fsDecision = await shim.onPreExecute(
      execOf('read', { file_path: join(root, 'README.md') }, root) as unknown as ToolExecution,
      allowNext,
    )
    expect(fsDecision).toEqual({ kind: 'allow' })

    const outside = await shim.onPreExecute(execOf('bash', { command: 'ls' }, '/tmp/elsewhere') as unknown as ToolExecution, allowNext)
    expect(outside).toEqual({ kind: 'allow' })

    const native = makeShim(makeDeps(h, { config: { ...SHIM_CONFIG, shimBashApproval: 'native' } }))
    const deferred = await native.onPreExecute(execOf('bash', { command: 'ls' }, root) as unknown as ToolExecution, allowNext)
    expect(deferred).toEqual({ kind: 'allow' })

    const off = makeShim(makeDeps(h, { config: { ...SHIM_CONFIG, shim: false } }))
    const passthrough = await off.onPreExecute(execOf('bash', { command: 'ls' }, root) as unknown as ToolExecution, allowNext)
    expect(passthrough).toEqual({ kind: 'allow' })
  })

  it('stands down on never-ask presets (danger-full-access) instead of asking into an auto-reject', async () => {
    const h = makeHarness()
    const root = connect(h)

    const never = makeShim(makeDeps(h, { approvalPolicyOf: () => 'never' }))
    const stoodDown = await never.onPreExecute(execOf('bash', { command: 'ls' }, root) as unknown as ToolExecution, allowNext)
    expect(stoodDown).toEqual({ kind: 'allow' })

    const askPolicy = makeShim(makeDeps(h, { approvalPolicyOf: () => 'ask' }))
    const asked = await askPolicy.onPreExecute(execOf('bash', { command: 'ls' }, root) as unknown as ToolExecution, allowNext)
    expect(asked).toEqual({ kind: 'ask', reason: `run on remote host 'prod' (dsh-rw shim)` })
  })
})

describe('shim wiring in apply', () => {
  interface CapturedSection {
    name: string
    order: number
    text: () => string
  }

  interface ShimSwitches {
    shim: boolean
    shimBash: boolean
    shimBashApproval: 'ask' | 'native'
  }

  /** In-memory dsh-settings stand-in: schema defaults → base → user layer, watcher fan-out on commit. */
  class FakeSettings {
    readonly registerCalls: { ns: string; options?: { base?: Partial<ShimSwitches> } }[] = []
    failOnRegister: Error | undefined
    private user: Partial<ShimSwitches>
    private base: Partial<ShimSwitches> = {}
    private readonly watchers: ((next: ShimSwitches, prev: ShimSwitches) => void)[] = []

    constructor(user: Partial<ShimSwitches> = {}) {
      this.user = { ...user }
    }

    private resolved(): ShimSwitches {
      return { shim: true, shimBash: true, shimBashApproval: 'ask', ...this.base, ...this.user }
    }

    register(ns: string, _schema: unknown, options?: { base?: Partial<ShimSwitches> }) {
      this.registerCalls.push({ ns, ...(options !== undefined ? { options } : {}) })
      if (this.failOnRegister !== undefined) throw this.failOnRegister
      this.base = options?.base ?? {}
      return {
        get: (): ShimSwitches => this.resolved(),
        watch: (cb: (next: ShimSwitches, prev: ShimSwitches) => void): (() => void) => {
          this.watchers.push(cb)
          return () => {
            const i = this.watchers.indexOf(cb)
            if (i >= 0) this.watchers.splice(i, 1)
          }
        },
      }
    }

    get watcherCount(): number {
      return this.watchers.length
    }

    /** Simulate a settings.yaml commit: merge the user layer and notify watchers. */
    commit(patch: Partial<ShimSwitches>): void {
      const prev = this.resolved()
      this.user = { ...this.user, ...patch }
      const next = this.resolved()
      for (const cb of [...this.watchers]) cb(next, prev)
    }
  }

  type ExecuteListener = (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>

  /** The index.test.ts ctx stand-in, extended with ctx.on + ctx.inject capture. */
  function makeCtx() {
    const tools: { name: string }[] = []
    const routes: { kind: string; path: string }[] = []
    const listeners: { event: string; fn: unknown }[] = []
    const injectCalls: { deps: string[]; cb: (sctx: unknown) => unknown }[] = []
    const injectDisposers: (() => void)[] = []
    let section: CapturedSection | undefined
    const effectDisposers: (() => void)[] = []
    const effectLabels: string[] = []

    const remove = <T,>(list: T[], item: T): void => {
      const i = list.indexOf(item)
      if (i >= 0) list.splice(i, 1)
    }

    const ctx = {
      tools: {
        register(t: { name: string }) {
          tools.push(t)
          return () => remove(tools, t)
        },
        get() {
          return ONE_SHOT_BASH
        },
      },
      webServer: {
        register(r: { kind: string; path: string }) {
          routes.push(r)
          return () => remove(routes, r)
        },
      },
      systemPrompt: {
        section(s: CapturedSection) {
          section = s
          return () => {
            section = undefined
          }
        },
      },
      get(): unknown {
        return undefined
      },
      on(event: string, fn: unknown) {
        listeners.push({ event, fn })
        return () => remove(listeners, listeners.find((l) => l.fn === fn)!)
      },
      inject(deps: string[], cb: (sctx: unknown) => unknown) {
        injectCalls.push({ deps, cb })
        return undefined
      },
      effect(fn: () => (() => void) | void, label?: string) {
        effectLabels.push(label ?? '')
        const dispose = fn()
        if (typeof dispose === 'function') effectDisposers.push(dispose)
        return () => {}
      },
    }
    /** Fire the captured inject callbacks with a settings service, collecting their disposers. */
    const attachSettings = (settings: FakeSettings | Record<string, unknown>): void => {
      for (const { cb } of injectCalls) {
        const dispose = cb({ settings })
        if (typeof dispose === 'function') injectDisposers.push(dispose as () => void)
      }
    }
    const executeListener = (): ExecuteListener =>
      listeners.find((l) => l.event === 'tools/execute')!.fn as ExecuteListener
    return {
      ctx,
      listeners,
      injectCalls,
      injectDisposers,
      effectDisposers,
      effectLabels,
      attachSettings,
      executeListener,
      getSection: () => section,
    }
  }

  const BASE_CONFIG: Config = {
    hostKeyPolicy: 'accept-new',
    knownHostsPath: '',
    commandTimeoutMs: 30000,
    connectTimeoutMs: 15000,
    channelOpenTimeoutMs: 10000,
    maxOutputChars: 200000,
  }

  function applyTo(ctx: unknown, h: Harness, config: Config = BASE_CONFIG): void {
    apply(ctx as Context, config, {
      hosts: h.hosts,
      pool: h.pool,
      session: h.sessions,
      placeholderBaseDir: h.placeholderBaseDir,
      placeholderRoot: h.placeholderRoot,
    })
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('always registers both middlewares inside the surfaces effect, whatever the shim flag', () => {
    const { ctx, listeners, injectCalls, effectDisposers, effectLabels } = makeCtx()
    const h = makeHarness()
    applyTo(ctx, h, { ...BASE_CONFIG, shim: true })
    applyTo(makeCtx().ctx, makeHarness()) // shim unset: same registration
    expect(listeners.map((l) => l.event)).toEqual(['tools/execute', 'tools/pre-execute'])
    // The middlewares share the tools/routes effect: labels are unchanged from v0.1.
    expect(effectLabels).toEqual(['dsh-rw: surfaces', 'dsh-rw: prompt', 'dsh-rw: pool'])
    expect(injectCalls.map((c) => c.deps)).toEqual([['settings']])

    for (const dispose of effectDisposers) dispose()
    expect(listeners).toEqual([])
  })

  it('settings service absent → cordis entry config is authoritative (default shim=true intercepts)', async () => {
    const { ctx, executeListener } = makeCtx()
    const h = makeHarness()
    const root = connect(h)
    applyTo(ctx, h) // shim unset in the cordis config; no settings service ever attaches — schema default true wins

    const res = await executeListener()(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(res).not.toBe(LOCAL_RESULT)
    expect(text(res)).toContain(`<path>${join(root, 'README.md')}</path>`)
    // The shim acquired the placeholder's remote connection to fulfil the read.
    expect(h.pool.connectedAliases.size).toBeGreaterThan(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('shim config resolved (cordis base): shim=true'))
  })

  it('settings service without register (DSH 0.1.7+/0.2) → Config-derived model, cordis config stays authoritative', async () => {
    const { ctx, attachSettings, executeListener } = makeCtx()
    const h = makeHarness()
    const root = connect(h)
    applyTo(ctx, h, { ...BASE_CONFIG, shim: false }) // cordis entry config says shim off

    // 0.2's SettingsForms: no per-plugin namespace registration — namespaces are
    // derived from the plugin's own Config schema and edited through the profile
    // composition, so the entry config apply() received is the only layer.
    attachSettings({ describe: () => [], update: () => Promise.resolve() })
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'shim config resolved (cordis base — no settings namespace API on this DSH): shim=false',
      ),
    )

    // No overlay was applied, so the cordis config stands: the read stays local.
    const res = await executeListener()(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(res).toBe(LOCAL_RESULT)
  })

  it('settings user layer overrides the cordis base (base shim=false, user shim=true → intercepts)', async () => {
    const { ctx, attachSettings, executeListener } = makeCtx()
    const h = makeHarness()
    const root = connect(h)
    applyTo(ctx, h, { ...BASE_CONFIG, shim: false }) // cordis base: shim=false

    const settings = new FakeSettings({ shim: true })
    attachSettings(settings)
    expect(settings.registerCalls.length).toBe(1)
    expect(settings.registerCalls[0]!.options?.base).toEqual({ shim: false, shimBash: true, shimBashApproval: 'ask' })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('shim config resolved (cordis base + settings overlay): shim=true'))

    const res = await executeListener()(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(res).not.toBe(LOCAL_RESULT)
    expect(text(res)).toContain(`<path>${join(root, 'README.md')}</path>`)

    // The watch disposer rides the inject fiber: one disposer, and it unregisters the watcher.
    expect(settings.watcherCount).toBe(1)
  })

  it('settings hot reload applies immediately, without re-registration', async () => {
    const { ctx, listeners, attachSettings, executeListener } = makeCtx()
    const h = makeHarness()
    const root = connect(h)
    applyTo(ctx, h, { ...BASE_CONFIG, shim: false }) // start from a known-off base so the toggle is visible
    const settings = new FakeSettings()
    attachSettings(settings)

    // shim=false initially: the read passes through to the local tool.
    const before = await executeListener()(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(before).toBe(LOCAL_RESULT)

    settings.commit({ shim: true })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('shim config resolved (settings overlay update): shim=true'))
    const after = await executeListener()(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(text(after)).toContain(`<path>${join(root, 'README.md')}</path>`)

    settings.commit({ shim: false })
    const offAgain = await executeListener()(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(offAgain).toBe(LOCAL_RESULT)
    // Same two listeners throughout: no re-registration happened.
    expect(listeners.length).toBe(2)
  })

  it('a rejected settings registration falls back to the cordis config and the plugin still loads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, attachSettings, executeListener } = makeCtx()
    const h = makeHarness()
    const root = connect(h)
    applyTo(ctx, h, { ...BASE_CONFIG, shim: true }) // cordis config says shim on

    const settings = new FakeSettings()
    settings.failOnRegister = new Error('invalid dsh-rw section')
    attachSettings(settings)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[dsh-rw] settings registration failed'))

    // The cordis entry config stays in charge: shim=true still intercepts.
    const res = await executeListener()(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(text(res)).toContain(`<path>${join(root, 'README.md')}</path>`)
    expect(settings.watcherCount).toBe(0)
  })

  // 2.0: the prompt section is a function of the ASSEMBLING session (DSH passes
  // the Agent as context.scope). It no longer reflects the last native call,
  // so it is stable within a session; the observation still drives the
  // one-time console warning and rw_info.
  describe('prompt section is per session, routing observation is per session', () => {
    /** The AssembleContext DSH passes: scope is the Agent, whose header names the session. */
    const scopeOf = (header: { id?: string; cwd?: string; parentSession?: string }) => ({ scope: { session: { header } } })
    type SectionFn = (context?: unknown) => string

    it('a session working inside a placeholder is told it IS a remote workspace', async () => {
      const { ctx, executeListener, getSection } = makeCtx()
      const h = makeHarness()
      const root = connect(h)
      applyTo(ctx, h, { ...BASE_CONFIG, shim: true })
      const text = getSection()!.text as unknown as SectionFn

      const before = text(scopeOf({ id: 's1', cwd: root }))
      expect(before).toContain("This session is a remote workspace: host alias 'prod' (deploy@example.com:22)")
      expect(before).toContain('remote root /srv/app')
      expect(before).toContain(root)
      expect(before).toContain('translated to the remote host automatically')
      expect(before).toContain('single source of truth')

      // A native call does not change the text: it is stable for the session.
      await executeListener()(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
      expect(text(scopeOf({ id: 's1', cwd: root }))).toBe(before)
    })

    it('a local session with an rw_* record is told native tools stay local', () => {
      const { ctx, getSection } = makeCtx()
      const h = makeHarness()
      const root = connect(h)
      applyTo(ctx, h, { ...BASE_CONFIG, shim: true })
      h.sessions.set({ id: 'local-1' }, { alias: 'prod', workspace: '/srv/app' })
      const text = (getSection()!.text as unknown as SectionFn)(scopeOf({ id: 'local-1', cwd: dir }))
      expect(text).toContain("rw_* tools are connected to host alias 'prod'")
      expect(text).toContain('workspace /srv/app')
      expect(text).toContain('run on the LOCAL machine')
      expect(text).toContain(root) // the placeholder a path may name to reach the remote
      expect(text).not.toContain('This session is a remote workspace')
    })

    it('each session gets its own text; a subagent inherits its parent record', () => {
      const { ctx, getSection } = makeCtx()
      const h = makeHarness()
      connect(h)
      applyTo(ctx, h, { ...BASE_CONFIG, shim: true })
      h.sessions.set({ id: 'A' }, { alias: 'prod', workspace: '/srv/app' })
      h.sessions.set({ id: 'B' }, { alias: 'dev', workspace: '/data' })
      const text = getSection()!.text as unknown as SectionFn
      expect(text(scopeOf({ id: 'A', cwd: dir }))).toContain("host alias 'prod'")
      expect(text(scopeOf({ id: 'B', cwd: dir }))).toContain("host alias 'dev'")
      expect(text(scopeOf({ id: 'child', parentSession: 'B', cwd: dir }))).toContain("host alias 'dev'")
      expect(text(scopeOf({ id: 'C', cwd: dir }))).toContain('No remote workspace is active in this session')
      // No scope at all: generic guidance (the '' record is empty here).
      h.session.set({ alias: null })
      expect(text(undefined)).toContain('No remote workspace is active')
      expect(text({})).toContain('rw_pick_workspace')
    })

    it('a placeholder cwd whose host is gone is reported, never claimed as working', () => {
      const { ctx, getSection } = makeCtx()
      const h = makeHarness()
      const root = connect(h)
      applyTo(ctx, h, { ...BASE_CONFIG, shim: true })
      h.hosts.entries.length = 0
      const text = (getSection()!.text as unknown as SectionFn)(scopeOf({ id: 's', cwd: root }))
      expect(text).toContain('no longer configured')
      expect(text).not.toContain('translated to the remote host automatically')
    })

    it('a local session cwd warns once and keeps the call local; routing is recorded per session', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const h = makeHarness()
      connect(h) // the '' record names a remote workspace …
      const routing = createNativeRouting()
      const shim = makeShim(makeDeps(h, { routing }))
      const localDir = dir // … but this call works in a real local directory

      const first = makeNext()
      await shim.onExecute(execOf('read', { file_path: 'local.txt' }, localDir), first.next)
      expect(first.passedThrough()).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ran LOCALLY'))
      expect(routing.peek('')).toMatchObject({ mode: 'local', cwd: localDir })

      const second = makeNext()
      await shim.onExecute(execOf('read', { file_path: 'local.txt' }, localDir), second.next)
      expect(second.passedThrough()).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('observations are keyed by session id and bounded', async () => {
      const h = makeHarness()
      const root = connect(h)
      const routing = createNativeRouting(2)
      const shim = makeShim(makeDeps(h, { routing }))
      const execIn = (id: string, cwd: string, name = 'read', args: Record<string, unknown> = { file_path: join(root, 'README.md') }) =>
        ({
          name,
          arguments: args,
          signal: new AbortController().signal,
          agent: { session: { header: { id, cwd } } },
        }) as unknown as ToolDispatchExecution
      // A pathless glob is anchored by the cwd; a read naming a placeholder path by that path.
      await shim.onExecute(execIn('s1', root, 'glob', { pattern: '*' }), makeNext().next)
      await shim.onExecute(execIn('s2', dir), makeNext().next)
      expect(routing.peek('s1')).toMatchObject({ mode: 'remote', reason: 'cwd' })
      expect(routing.peek('s2')).toMatchObject({ mode: 'remote', reason: 'path' })
      await shim.onExecute(execIn('s3', root), makeNext().next)
      expect(routing.size).toBe(2)
      expect(routing.peek('s1')).toBeUndefined() // least recently observed: evicted
      expect(routing.peek('s3')).toBeDefined()
    })
  })
})

describe('shim path-anchored target', () => {
  it('translates a file call that names a placeholder path from a local working directory', async () => {
    const h = makeHarness()
    const root = connect(h) // remote workspace recorded: prod:/srv/app
    const shim = makeShim(makeDeps(h))
    const localDir = dir // a real local directory, outside every placeholder

    const read = makeNext()
    const res = await shim.onExecute(execOf('read', { file_path: join(root, 'README.md') }, localDir), read.next)
    expect(read.passedThrough()).toBe(false)
    expect(text(res)).toContain('line1')
    expect(text(res)).toContain(join(root, 'README.md'))
    expect(h.pool.connectedAliases.has('prod')).toBe(true)
  })

  it('writes and edits by placeholder path from a local working directory', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    const localDir = dir

    const w = makeNext()
    await shim.onExecute(execOf('write', { file_path: join(root, 'src', 'new.ts'), content: 'x=1\n' }, localDir), w.next)
    expect(w.passedThrough()).toBe(false)
    expect(h.pool.fs.fileContent('/srv/app/src/new.ts')).toBe('x=1\n')

    const e = makeNext()
    await shim.onExecute(
      execOf('edit', { file_path: join(root, 'README.md'), old_string: 'line1', new_string: 'LINE1' }, localDir),
      e.next,
    )
    expect(e.passedThrough()).toBe(false)
    expect(h.pool.fs.fileContent('/srv/app/README.md')).toContain('LINE1')
  })

  it('translates grep/glob that carry a placeholder path from a local working directory', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    const localDir = dir

    h.pool.execQueue.push(execResult('/srv/app/README.md:1:line1\n'))
    const g = makeNext()
    await shim.onExecute(execOf('grep', { pattern: 'line', path: join(root, 'src') }, localDir), g.next)
    expect(g.passedThrough()).toBe(false)
    expect(h.pool.execCalls.length).toBe(1)
    expect(h.pool.execCalls[0]!.command).toContain('rg ')
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app/src')

    h.pool.execQueue.push(execResult('a.ts\n'))
    const gl = makeNext()
    await shim.onExecute(execOf('glob', { pattern: '*.ts', path: join(root, 'src') }, localDir), gl.next)
    expect(gl.passedThrough()).toBe(false)
    expect(h.pool.execCalls.length).toBe(2)
    expect(h.pool.execCalls[1]!.opts?.cwd).toBe('/srv/app/src')
  })

  it('does not path-anchor bash: a command naming a placeholder path still runs locally', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    const bash = makeNext()
    const res = await shim.onExecute(execOf('bash', { command: `ls ${root}`, description: 'list' }, dir), bash.next)
    expect(res).toBe(LOCAL_RESULT)
    expect(bash.passedThrough()).toBe(true)
    expect(h.pool.execCalls).toEqual([])
  })

  it('fails loud when the anchored placeholder host is gone (never the local stand-in)', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    h.hosts.entries.length = 0 // the host was removed from the config

    const read = makeNext()
    const res = await shim.onExecute(execOf('read', { file_path: join(root, 'README.md') }, dir), read.next)
    expect(read.passedThrough()).toBe(false)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('no longer configured')
  })

  it('a path outside every placeholder still runs locally', async () => {
    const h = makeHarness()
    connect(h)
    const shim = makeShim(makeDeps(h))
    const read = makeNext()
    const res = await shim.onExecute(execOf('read', { file_path: join(dir, 'local.txt') }, dir), read.next)
    expect(res).toBe(LOCAL_RESULT)
    expect(read.passedThrough()).toBe(true)
  })

  it('resolves a relative path against the agent cwd before anchoring', async () => {
    const h = makeHarness()
    const root = connect(h)
    const shim = makeShim(makeDeps(h))
    const read = makeNext()
    const res = await shim.onExecute(execOf('read', { file_path: 'index.ts' }, join(root, 'src')), read.next)
    expect(read.passedThrough()).toBe(false)
    expect(text(res)).toContain('export {}')
  })
})

// 2.0 mirror layout: a host's placeholders mirror its remote paths under
// <root>/<alias>, so the host root (remote '/') contains every other
// placeholder of that host. The same local path must map to the same remote
// path whichever placeholder it is reached through.
describe('shim mirror layout', () => {
  /** prod's host root (remote '/') plus a nested /srv/app workspace. */
  function nested(h: Harness) {
    const loc = { root: h.placeholderRoot, legacyBaseDir: h.placeholderBaseDir }
    const app = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', loc)
    const hostRoot = ensurePlaceholder('prod', ENTRY_PROD, '/', loc)
    return { app, hostRoot, loc }
  }

  /** Exec with a session id (header.id) and cwd. */
  function execAs(name: string, args: Record<string, unknown>, header: { id?: string; cwd?: string; parentSession?: string }): ToolDispatchExecution {
    return {
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { session: { header } },
    } as unknown as ToolDispatchExecution
  }

  it('reads the same local file to the same remote path via the host root and via the nested workspace', async () => {
    const h = makeHarness()
    const { app, hostRoot } = nested(h)
    expect(app).toBe(join(hostRoot, 'srv', 'app'))
    const shim = makeShim(makeDeps(h))
    const file = join(app, 'README.md')

    const viaApp = await shim.onExecute(execOf('read', { file_path: file }, app), makeNext().next)
    const viaHost = await shim.onExecute(execOf('read', { file_path: file }, hostRoot), makeNext().next)
    const viaRelative = await shim.onExecute(execOf('read', { file_path: 'srv/app/README.md' }, hostRoot), makeNext().next)
    for (const res of [viaApp, viaHost, viaRelative]) {
      expect(res.isError).toBe(false)
      expect(text(res)).toContain('1: line1')
      expect(text(res)).toContain(`<path>${file}</path>`)
    }
  })

  it('writes through either placeholder land on the same remote file', async () => {
    const h = makeHarness()
    const { app, hostRoot } = nested(h)
    const shim = makeShim(makeDeps(h))
    await shim.onExecute(execOf('write', { file_path: join(app, 'a.txt'), content: 'one\n' }, hostRoot), makeNext().next)
    expect(h.pool.fs.fileContent('/srv/app/a.txt')).toBe('one\n')
    await shim.onExecute(execOf('write', { file_path: join(hostRoot, 'srv', 'app', 'a.txt'), content: 'two\n' }, app), makeNext().next)
    expect(h.pool.fs.fileContent('/srv/app/a.txt')).toBe('two\n')
    // From the host root, paths outside /srv/app are remote too (remote '/').
    await shim.onExecute(execOf('write', { file_path: join(hostRoot, 'tmp', 'x.txt'), content: 'x\n' }, hostRoot), makeNext().next)
    expect(h.pool.fs.fileContent('/tmp/x.txt')).toBe('x\n')
  })

  it('bash rewrites both spellings to the same remote path, with the deepest placeholder as cwd', async () => {
    const h = makeHarness()
    const { app, hostRoot } = nested(h)
    const shim = makeShim(makeDeps(h))

    h.pool.execQueue.push(execResult('ok\n'), execResult('ok\n'))
    const command = `cat ${join(app, 'README.md')} ${join(hostRoot, 'srv', 'app', 'README.md')} ${join(hostRoot, 'etc', 'hosts')} ${hostRoot}`
    await shim.onExecute(execOf('bash', { command }, app), makeNext().next)
    await shim.onExecute(execOf('bash', { command }, hostRoot), makeNext().next)
    const expected = 'cat /srv/app/README.md /srv/app/README.md /etc/hosts /'
    expect(h.pool.execCalls.map((c) => c.command)).toEqual([expected, expected])
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app')
    expect(h.pool.execCalls[1]!.opts?.cwd).toBe('/')
  })

  it('a cwd below a nested placeholder anchors on the DEEPEST placeholder, even with a host-root record', async () => {
    const h = makeHarness()
    const { app } = nested(h)
    h.session.set({ alias: 'prod', workspace: '/' }) // the record names the host root
    h.pool.execQueue.push(execResult('__DSH_RW_ENGINE__=rg\n/srv/app/src/index.ts\n'))
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('glob', { pattern: '*.ts' }, join(app, 'src')), makeNext().next)
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app') // not '/'
    expect(text(res)).toBe(join(app, 'src', 'index.ts'))
  })

  it("maps results back correctly when the workspace root is remote '/'", async () => {
    const h = makeHarness()
    const { hostRoot } = nested(h)
    const shim = makeShim(makeDeps(h))
    h.pool.execQueue.push(execResult('__DSH_RW_ENGINE__=rg\n/srv/app/README.md\n/etc/hosts\n'))
    const res = await shim.onExecute(execOf('glob', { pattern: '*' }, hostRoot), makeNext().next)
    expect(res.value).toEqual({
      root: hostRoot,
      paths: [join(hostRoot, 'srv', 'app', 'README.md'), join(hostRoot, 'etc', 'hosts')],
    })
    expect(text(res)).not.toContain('//')
    const read = await shim.onExecute(execOf('read', { file_path: join(hostRoot, 'srv', 'app', 'README.md') }, hostRoot), makeNext().next)
    expect(text(read)).toContain(`<path>${join(hostRoot, 'srv', 'app', 'README.md')}</path>`)
  })

  it("never produces '//' when rewriting a '/' workspace root", async () => {
    const h = makeHarness()
    const { hostRoot } = nested(h)
    const shim = makeShim(makeDeps(h))
    h.pool.execQueue.push(execResult(''))
    await shim.onExecute(
      execOf('bash', { command: `ls ${hostRoot}/ ${hostRoot}/srv '${hostRoot}' && cd ${hostRoot}/srv/app/` }, hostRoot),
      makeNext().next,
    )
    expect(h.pool.execCalls[0]!.command).toBe(`ls / /srv '/' && cd /srv/app/`)
  })

  it('a host-root prefix only matches at a path boundary (prod ≠ production)', async () => {
    const h = makeHarness()
    const production: HostEntry = { ...ENTRY_PROD, alias: 'production', host: 'production.example.com' }
    h.hosts.entries.push(production)
    const loc = { root: h.placeholderRoot, legacyBaseDir: h.placeholderBaseDir }
    const prodRoot = ensurePlaceholder('prod', ENTRY_PROD, '/', loc)
    const productionRoot = ensurePlaceholder('production', production, '/', loc)
    const shim = makeShim(makeDeps(h))
    h.pool.execQueue.push(execResult(''))
    await shim.onExecute(
      execOf('bash', { command: `diff ${join(prodRoot, 'a')} ${join(productionRoot, 'a')} ${prodRoot}.bak` }, prodRoot),
      makeNext().next,
    )
    expect(h.pool.execCalls[0]!.alias).toBe('prod')
    expect(h.pool.execCalls[0]!.command).toBe(`diff /a ${join(productionRoot, 'a')} ${prodRoot}.bak`)
  })

  it('sibling placeholders of the same host are rewritten through the host-root prefix', async () => {
    const h = makeHarness()
    const loc = { root: h.placeholderRoot, legacyBaseDir: h.placeholderBaseDir }
    const app = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', loc)
    h.pool.fs.addDir('/data')
    const data = ensurePlaceholder('prod', ENTRY_PROD, '/data', loc)
    const shim = makeShim(makeDeps(h))
    h.pool.execQueue.push(execResult(''))
    await shim.onExecute(execOf('bash', { command: `cp ${join(data, 'in.csv')} ${join(app, 'in.csv')}` }, app), makeNext().next)
    expect(h.pool.execCalls[0]!.command).toBe('cp /data/in.csv /srv/app/in.csv')
  })

  it('legacy (≤ 1.6) placeholders keep working: read and bash map to their remote root', async () => {
    const h = makeHarness()
    const legacy = join(h.placeholderBaseDir, 'prod', 'app-9472932a')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, '.dsh-rw-meta.json'),
      JSON.stringify({
        plugin: 'dsh-rw',
        alias: 'prod',
        host: 'example.com',
        port: 22,
        user: 'deploy',
        remotePath: '/srv/app',
        createdAt: '2026-01-01T00:00:00.000Z',
        note: 'placeholder only — not a copy of remote files',
      }),
    )
    const shim = makeShim(makeDeps(h))
    const read = await shim.onExecute(execOf('read', { file_path: 'README.md' }, legacy), makeNext().next)
    expect(text(read)).toContain('1: line1')
    expect(text(read)).toContain(`<path>${join(legacy, 'README.md')}</path>`)
    h.pool.execQueue.push(execResult(''))
    await shim.onExecute(execOf('bash', { command: `ls ${join(legacy, 'src')}` }, legacy), makeNext().next)
    expect(h.pool.execCalls[0]).toMatchObject({ alias: 'prod', command: 'ls /srv/app/src', opts: { cwd: '/srv/app' } })
  })

  it("uses the CALLER's session record when there is no cwd; a subagent falls back to its parent's", async () => {
    const h = makeHarness()
    const loc = { root: h.placeholderRoot, legacyBaseDir: h.placeholderBaseDir }
    ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', loc)
    h.sessions.set({ id: 'parent' }, { alias: 'prod', workspace: '/srv/app' })
    const shim = makeShim(makeDeps(h))

    const child = await shim.onExecute(execAs('read', { file_path: 'README.md' }, { id: 'child', parentSession: 'parent' }), makeNext().next)
    expect(text(child)).toContain('1: line1')

    // Another session (no record, no parent) has nothing to anchor on: local.
    const stranger = makeNext()
    await shim.onExecute(execAs('read', { file_path: 'README.md' }, { id: 'stranger' }), stranger.next)
    expect(stranger.passedThrough()).toBe(true)
  })
})

describe('namespace safety remains path-aware', () => {
  function corruptOwner(h: Harness) {
    const root = connect(h)
    writeFileSync(join(h.placeholderRoot, 'prod', HOST_OWNER_FILE), JSON.stringify({ plugin: 'dsh-rw', version: 1, alias: 'other' }))
    return root
  }

  it('does not let a bad remote record block a genuinely local cwd', async () => {
    const h = makeHarness()
    corruptOwner(h)
    const routing = createNativeRouting()
    const shim = makeShim(makeDeps(h, { routing }))
    for (const [name, args] of [['read', { file_path: join(dir, 'local.txt') }], ['bash', { command: 'echo local' }]] as const) {
      const local = makeNext()
      expect(await shim.onExecute(execOf(name, args, dir), local.next)).toBe(LOCAL_RESULT)
      expect(local.passedThrough()).toBe(true)
    }
    expect(await shim.onPreExecute(execOf('bash', { command: 'echo local' }, dir) as unknown as ToolExecution, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    expect(routing.peek('')?.mode).toBe('local')
    expect(h.pool.execCalls).toEqual([])
  })

  it('keeps an explicit unrelated local file local even from an ambiguous cwd', async () => {
    const h = makeHarness()
    const root = corruptOwner(h)
    const shim = makeShim(makeDeps(h, { routing: createNativeRouting() }))
    const local = makeNext()
    expect(await shim.onExecute(execOf('read', { file_path: join(dir, 'local.txt') }, root), local.next)).toBe(LOCAL_RESULT)
    expect(local.passedThrough()).toBe(true)
    expect(h.pool.execCalls).toEqual([])
  })

  it('fails remote-backed reads and bash without remote execution or LOCAL fallback', async () => {
    const h = makeHarness()
    const root = corruptOwner(h)
    const shim = makeShim(makeDeps(h))
    for (const [name, args] of [['read', { file_path: join(root, 'README.md') }], ['bash', { command: 'echo remote' }]] as const) {
      const local = makeNext()
      const result = await shim.onExecute(execOf(name, args, root), local.next)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('belongs to alias')
      expect(local.passedThrough()).toBe(false)
    }
    await expect(shim.onPreExecute(execOf('bash', { command: 'echo remote' }, root) as unknown as ToolExecution, async () => ({ kind: 'allow' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(h.pool.execCalls).toEqual([])
  })

  it('uses a healthy cwd host instead of inspecting a bad recorded host namespace', async () => {
    const h = makeHarness()
    corruptOwner(h)
    const root = ensurePlaceholder('dev', ENTRY_DEV, '/srv/app', { root: h.placeholderRoot, legacyBaseDir: h.placeholderBaseDir })
    const shim = makeShim(makeDeps(h))
    h.pool.execQueue.push(execResult('ok'))
    const local = makeNext()
    const result = await shim.onExecute(execOf('bash', { command: 'echo healthy' }, root), local.next)
    expect(result.isError).toBe(false)
    expect(local.passedThrough()).toBe(false)
    expect(h.pool.execCalls[0]?.alias).toBe('dev')
  })

  it('never blocks unrelated plugin tools because a namespace is broken', async () => {
    const h = makeHarness()
    const root = corruptOwner(h)
    const local = makeNext()
    const shim = makeShim(makeDeps(h))
    expect(await shim.onExecute(execOf('ask_user_question', { question: 'Choose a new root' }, root), local.next)).toBe(LOCAL_RESULT)
    expect(local.passedThrough()).toBe(true)
    expect(h.pool.execCalls).toEqual([])
  })
})

describe('remote IO scope admission', () => {
  it.each([
    ['read', { file_path: 'README.md' }],
    ['write', { file_path: 'new.txt', content: 'created' }],
    ['edit', { file_path: 'README.md', old_string: 'line1', new_string: 'changed' }],
    ['str_replace_editor', { command: 'view', path: 'README.md' }],
    ['glob', { pattern: '**/*.ts' }],
    ['grep', { pattern: 'line' }],
    ['bash', { command: 'true', timeoutMs: 5000 }],
  ] as const)('keeps the full %s mapped operation in one caller scope', async (name, args) => {
    const h = makeHarness()
    const root = connect(h)
    const observed: Readonly<RemoteIoOptions>[] = []
    let closed = 0
    const capture = () => {
      const options = currentRemoteIoOptions()
      if (!options?.signal || options.deadlineMs === undefined) throw new Error('missing remote operation scope')
      observed.push(options)
      return options
    }
    const facade = new Proxy(h.pool.fs, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        return (...parameters: unknown[]) => { capture(); return Reflect.apply(value, target, parameters) }
      },
    })
    h.pool.sftp = async () => {
      capture()
      ownRemoteIoResource(() => { closed++ })
      return facade
    }
    const execute = h.pool.exec.bind(h.pool)
    h.pool.exec = async (entry, command, options) => { capture(); return execute(entry, command, options) }
    if (name === 'glob' || name === 'grep') h.pool.execQueue.push(execResult('__DSH_RW_ENGINE__=rg\n'))
    const shim = makeShim(makeDeps(h, { config: { ...SHIM_CONFIG, operationTimeoutMs: 1234 } }))
    const local = makeNext()
    const result = await shim.onExecute(execOf(name, args, root), local.next)
    expect(result.isError).toBe(false)
    expect(local.passedThrough()).toBe(false)
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every(options => options === observed[0])).toBe(true)
    expect(observed[0]?.timeoutMs).toBe(name === 'bash' ? 5000 : 1234)
    expect(observed[0]?.signal?.aborted).toBe(true) // normal completion closes the caller-owned scope
    expect(currentRemoteIoOptions()).toBeUndefined()
    if (!['glob', 'grep', 'bash'].includes(name)) expect(closed).toBeGreaterThan(0)
  })

  it('times out a cooperative pending remote read and closes its owned facade', async () => {
    const h = makeHarness()
    const root = connect(h)
    let closed = 0
    h.pool.sftp = async () => {
      const signal = currentRemoteIoOptions()?.signal
      if (!signal) throw new Error('no caller signal at facade acquisition')
      ownRemoteIoResource(() => { closed++ })
      const facade = new Proxy(h.pool.fs, {
        get(target, key) {
          if (key === 'readFile') return async () => await new Promise<Buffer>((_resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          })
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return facade
    }
    const shim = makeShim(makeDeps(h, { config: { ...SHIM_CONFIG, operationTimeoutMs: 20 } }))
    const local = makeNext()
    const result = await shim.onExecute(execOf('read', { file_path: 'README.md' }, root), local.next)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('OPERATION_TIMEOUT')
    expect(local.passedThrough()).toBe(false)
    expect(closed).toBe(1)
    expect(h.pool.disconnected).toEqual([])
    expect(currentRemoteIoOptions()).toBeUndefined()
  })

  it.each([
    ['read', { file_path: '/outside-local/file.txt' }],
    ['write', { file_path: 'new.txt' }],
    ['str_replace_editor', { command: 'undo_edit', path: 'README.md' }],
    ['bash', { command: 'pwd', workdir: '/outside-local' }],
  ] as const)('does not pollute %s local passthrough with an aborted remote scope', async (name, args) => {
    const h = makeHarness()
    const root = connect(h)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    let passed = false
    const result = await makeShim(makeDeps(h, { config: { ...SHIM_CONFIG, operationTimeoutMs: 1 } })).onExecute(execOf(name, args, root, controller.signal), async () => {
      expect(currentRemoteIoOptions()).toBeUndefined()
      passed = true
      return LOCAL_RESULT
    })
    expect(result).toBe(LOCAL_RESULT)
    expect(passed).toBe(true)
    expect(h.pool.execCalls).toEqual([])
  })
})
