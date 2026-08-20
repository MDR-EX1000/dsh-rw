// Shim-mode tests: the middlewares are driven directly with fake exec/next
// pairs (same mock discipline as tests/index.test.ts), plus one apply() wiring
// test with a hand-built ctx that captures ctx.on registrations.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'
import type { Config } from '../src/index.js'
import { ensurePlaceholder } from '../src/placeholder.js'
import { Session } from '../src/session.js'
import { makeShim } from '../src/shim.js'
import type { ShimConfig, ShimDeps } from '../src/shim.js'
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
  const session = new Session(join(dir, 'session.json'))
  const placeholderBaseDir = join(dir, 'placeholders')
  pool.fs.addDir('/srv/app/src').addFile('/srv/app/README.md', 'line1\nline2\nline3\n').addFile('/srv/app/src/index.ts', 'export {}\n')
  return { hosts, pool, session, placeholderBaseDir }
}

type Harness = ReturnType<typeof makeHarness>

/** Activate the 'prod' @ /srv/app session and create its on-disk placeholder; returns the placeholder dir. */
function connect(h: Harness): string {
  h.session.set({ alias: 'prod', workspace: '/srv/app' })
  return ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', h.placeholderBaseDir)
}

function makeDeps(h: Harness, overrides?: Partial<ShimDeps>): ShimDeps {
  return {
    hosts: h.hosts,
    pool: h.pool,
    session: h.session,
    config: { ...SHIM_CONFIG },
    placeholderBaseDir: h.placeholderBaseDir,
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
    for (const args of [{ file_path: '/etc/passwd' }, { file_path: join(root, '..', 'escape.txt') }]) {
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
    // run_in_background also passes through (no remote background jobs).
    const { next, passedThrough } = makeNext()
    const res = await shim.onExecute(execOf('bash', { command: 'ls', run_in_background: true }, root), next)
    expect(res).toBe(LOCAL_RESULT)
    expect(passedThrough()).toBe(true)
    expect(h.pool.execCalls).toEqual([])
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
  it('glob runs remote rg (find fallback) and maps results back to placeholder paths', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('README.md\nsrc/index.ts\n'))
    const shim = makeShim(makeDeps(h))

    const res = await shim.onExecute(execOf('glob', { pattern: '*' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(text(res)).toBe(`${join(root, 'README.md')}\n${join(root, 'src', 'index.ts')}`)
    expect(h.pool.execCalls.length).toBe(1)
    expect(h.pool.execCalls[0]!.command).toContain(`rg --files -g '*'`)
    expect(h.pool.execCalls[0]!.command).toContain('find . -type f')
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app')
  })

  it('glob with an explicit path searches there; a path outside the placeholder passes through', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('./index.ts\n'))
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
    h.pool.execQueue.push(execResult('README.md\nsrc/index.ts\n'))
    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('glob', { pattern: '*' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(res.value).toEqual({
      root,
      paths: [join(root, 'README.md'), join(root, 'src', 'index.ts')],
    })
  })

  it('grep maps match paths back to placeholder paths, grouped by file', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('/srv/app/src/index.ts:1:export {}\n/srv/app/README.md:2:line2\n'))
    const shim = makeShim(makeDeps(h))

    const res = await shim.onExecute(execOf('grep', { pattern: 'e', path: root }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(text(res)).toBe(
      `Found 2 matches\n\n${join(root, 'src', 'index.ts')}\nLine 1: export {}\n\n${join(root, 'README.md')}\nLine 2: line2`,
    )
    expect(h.pool.execCalls[0]!.command).toContain('rg --line-number --with-filename -e')
    expect(h.pool.execCalls[0]!.command).toContain(`grep -rnE -e 'e' '/srv/app'`)

    h.pool.execQueue.push(execResult('', { code: 1 }))
    const none = await shim.onExecute(execOf('grep', { pattern: 'zzz', path: root }, root), makeNext().next)
    expect(text(none)).toBe('No matches found')
  })

  it('grep returns the native schema-shaped value the registry validates against', async () => {
    const h = makeHarness()
    const root = connect(h)
    h.pool.execQueue.push(execResult('/srv/app/src/index.ts:1:export {}\n/srv/app/README.md:2:line2\n'))
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
    expect(text(res)).toBe('total 3')
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
    expect(text(res)).toBe('out\n[stderr]\nbad\n[exit code: 3]')
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
      exitCode: 3,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 30000,
      stdout: { text: 'out\n', truncated: false },
      stderr: { text: 'bad\n', truncated: false },
    })
  })

  it('honors exec.signal: abort interrupts the remote execution and drops the connection', async () => {
    const h = makeHarness()
    const root = connect(h)
    // A remote command that never settles on its own.
    h.pool.exec = async (entry: HostEntry, command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> => {
      h.pool.execCalls.push({ alias: entry.alias, command, ...(opts !== undefined ? { opts } : {}) })
      return new Promise<ExecResult>(() => {})
    }
    const shim = makeShim(makeDeps(h))
    const controller = new AbortController()
    const { next, passedThrough } = makeNext()
    const pending = shim.onExecute(execOf('bash', { command: 'sleep 999', description: 'sleep' }, root, controller.signal), next)
    controller.abort()
    const res = await pending
    expect(passedThrough()).toBe(false)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('command aborted')
    expect(h.pool.disconnected).toContain('prod')
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
    ensurePlaceholder('dev', ENTRY_DEV, '/srv/dev', h.placeholderBaseDir)
    h.session.set({ alias: 'dev', workspace: '/srv/dev' })
    h.pool.execQueue.push(execResult('ok\n'))

    const shim = makeShim(makeDeps(h))
    const res = await shim.onExecute(execOf('bash', { command: 'ls', description: 'list' }, root), makeNext().next)
    expect(res.isError).toBe(false)
    expect(text(res)).toBe('ok')
    // Targeted the cwd's host (prod @ /srv/app), not dev, and never went local.
    expect(h.pool.execCalls.length).toBe(1)
    expect(h.pool.execCalls[0]!.alias).toBe('prod')
    expect(h.pool.execCalls[0]!.opts?.cwd).toBe('/srv/app')
  })

  it('fails loudly when the cwd is a placeholder whose host is no longer configured (no silent local fallback)', async () => {
    const h = makeHarness()
    connect(h) // establishes the prod placeholder and session
    // A second workspace on disk whose host is NOT in the (overridden) table.
    const devRoot = ensurePlaceholder('dev', ENTRY_DEV, '/srv/dev', h.placeholderBaseDir)
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
      return { shim: false, shimBash: true, shimBashApproval: 'ask', ...this.base, ...this.user }
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
    const attachSettings = (settings: FakeSettings): void => {
      for (const { cb } of injectCalls) {
        const dispose = cb({ settings })
        if (typeof dispose === 'function') injectDisposers.push(dispose as () => void)
      }
    }
    const executeListener = (): ExecuteListener =>
      listeners.find((l) => l.event === 'tools/execute')!.fn as ExecuteListener
    return { ctx, listeners, injectCalls, injectDisposers, effectDisposers, effectLabels, attachSettings, executeListener }
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
      session: h.session,
      placeholderBaseDir: h.placeholderBaseDir,
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

  it('settings service absent → cordis entry config is authoritative (shim=false passes through)', async () => {
    const { ctx, executeListener } = makeCtx()
    const h = makeHarness()
    const root = connect(h)
    applyTo(ctx, h) // shim unset in the cordis config; no settings service ever attaches

    const res = await executeListener()(execOf('read', { file_path: join(root, 'README.md') }, root), makeNext().next)
    expect(res).toBe(LOCAL_RESULT)
    expect(h.pool.connectedAliases.size).toBe(0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('shim config resolved (cordis base): shim=false'))
  })

  it('settings user layer overrides the cordis base (base shim=false, user shim=true → intercepts)', async () => {
    const { ctx, attachSettings, executeListener } = makeCtx()
    const h = makeHarness()
    const root = connect(h)
    applyTo(ctx, h) // cordis base: shim=false

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
    applyTo(ctx, h)
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
})
