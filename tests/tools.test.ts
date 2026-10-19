import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { RwError } from '../src/errors.js'
import { ensurePlaceholder, readPlaceholderMeta } from '../src/placeholder.js'
import { makeTools, statusText } from '../src/tools.js'
import type { PoolLike } from '../src/tools.js'
import type { ExecResult, SftpLike } from '../src/ssh-pool.js'
import type { HostEntry } from '../src/hosts.js'
import { ENTRY_PROD, makeHarness, SECRET_PASSWORD } from './p4-fakes.js'
import type { FakeHarness } from './p4-fakes.js'

/** Test-facing view of a defineTool product (the registry supplies exec). */
interface TestTool {
  name: string
  description: string
  execute(
    args?: Record<string, unknown>,
    exec?: { agent?: { session?: { header?: { cwd?: string } } } },
  ): Promise<{ text: string; isError?: boolean }>
}

/**
 * A PoolLike that tracks how many calls are in flight at once and can refuse
 * specific aliases — the two properties rw_exec_many must guarantee (parallel
 * execution, per-host failure isolation) that FakePool cannot demonstrate.
 */
class TrackingPool implements PoolLike {
  maxInFlight = 0
  private inFlight = 0
  readonly calls: string[] = []

  constructor(private readonly refuse: readonly string[] = []) {}

  async exec(entry: HostEntry, command: string): Promise<ExecResult> {
    this.calls.push(`${entry.alias}:${command}`)
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    this.inFlight -= 1
    if (this.refuse.includes(entry.alias)) throw new RwError('NOT_CONNECTED', `${entry.alias} unreachable`)
    return { code: 0, signal: null, stdout: `${entry.alias}:ok\n`, stderr: '', timedOut: false }
  }

  async sftp(): Promise<SftpLike> {
    throw new Error('sftp not used by rw_exec_many')
  }

  async testConnect(): Promise<number> {
    return 1
  }

  disconnect(): void {}

  connected(): string[] {
    return []
  }

  dispose(): void {}
}

const EXPECTED_NAMES = [
  'rw_info',
  'rw_hosts',
  'rw_connect',
  'rw_pick_workspace',
  'rw_list_dir',
  'rw_read_file',
  'rw_write_file',
  'rw_mkdir',
  'rw_move',
  'rw_delete',
  'rw_exec',
  'rw_exec_many',
  'rw_watch',
  'rw_diff',
  'rw_apply_patch',
  'rw_disconnect',
]

let dir: string
let harness: FakeHarness & { connect(): void }
let tools: Map<string, TestTool>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-tools-'))
  harness = makeHarness(dir)
  tools = new Map((makeTools(harness.deps) as unknown as TestTool[]).map((t) => [t.name, t]))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tool(name: string): TestTool {
  const t = tools.get(name)
  if (!t) throw new Error(`tool not registered: ${name}`)
  return t
}

/** Rejects with a tool error carrying the [CODE] prefix; asserts no password leak. */
async function expectToolError(p: Promise<unknown>, code: string): Promise<Error> {
  const err = await p.then(
    () => {
      throw new Error(`expected failure [${code}] but the call succeeded`)
    },
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  const message = (err as Error).message
  expect(message.startsWith(`[${code}] `)).toBe(true)
  expect(message).not.toContain(SECRET_PASSWORD)
  return err as Error
}

describe('makeTools shape', () => {
  it('registers exactly the sixteen rw_* tools in fixed order', () => {
    expect([...tools.keys()]).toEqual(EXPECTED_NAMES)
  })

  it('every description mentions workspace confinement or session state', () => {
    for (const t of tools.values()) {
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(40)
    }
  })
})

describe('rw_info / rw_hosts', () => {
  it('reports the version of the code that is loaded', async () => {
    const { text } = await tool('rw_info').execute({})
    // Guards the "installed 1.4.x but the host still runs an older module"
    // confusion: the line must resolve from this module, not from disk state.
    expect(text).toMatch(/Plugin version: \d+\.\d+\.\d+ \(the code currently loaded by the host\)/)
  })

  it('rw_info reports the empty state before connecting', async () => {
    const { text } = await tool('rw_info').execute({})
    expect(text).toContain('Hosts configured: 2')
    expect(text).toContain('Current host: (none')
    expect(text).toContain('Connected: no')
    expect(text).toContain('Current workspace: (none')
    expect(text).toContain('accept-new')
  })

  it('rw_info reports host, workspace, placeholder dir when fully picked', async () => {
    harness.connect()
    const placeholderDir = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', `${dir}/placeholders`)
    const { text } = await tool('rw_info').execute({})
    expect(text).toContain('deploy@example.com:22 (alias: prod)')
    expect(text).toContain('Connected: yes')
    expect(text).toContain('Current workspace: /srv/app')
    expect(text).toContain(placeholderDir)
    expect(text).toContain(join('placeholders', 'prod', 'app'))
    expect(text).not.toContain(SECRET_PASSWORD)
  })

  it('rw_info reports where the native tools actually go, from the observed routing', async () => {
    harness.connect()
    ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', `${dir}/placeholders`)
    const deps = { ...harness.deps, shimEnabled: () => true }

    // Nothing dispatched yet: no claim either way, plus the rw_* fallback.
    expect(statusText(deps)).toContain('Native tools: not observed yet')

    const remote = statusText({ ...deps, routing: { mode: 'remote', placeholder: '/p/prod/app' } })
    expect(remote).toContain('Native tools: remote')
    expect(remote).toContain('/p/prod/app')

    const local = statusText({
      ...deps,
      routing: { mode: 'local', cwd: '/Users/me/project', placeholder: '/p/prod/app' },
    })
    expect(local).toContain('Native tools: LOCAL')
    expect(local).toContain('/Users/me/project')
    expect(local).toContain('use rw_* for the remote')

    expect(statusText({ ...deps, shimEnabled: () => false })).toContain('Native tools: shim off')
  })

  it('rw_hosts renders a table of summaries without credentials', async () => {
    const { text } = await tool('rw_hosts').execute({})
    expect(text).toContain('alias | host | port | user | auth | credentials | source')
    expect(text).toContain('prod | example.com | 22 | deploy | password | password-set | manual')
    expect(text).toContain('dev | devbox.local | 2222 | root | key | key-ready | ssh-config')
    expect(text).not.toContain(SECRET_PASSWORD)
  })
})

describe('rw_connect', () => {
  it('connects a known alias, records the session, reports latency', async () => {
    const { text } = await tool('rw_connect').execute({ alias: 'prod' })
    expect(text).toContain('Connected to deploy@example.com:22 (alias: prod) in 42ms')
    expect(harness.session.alias).toBe('prod')
    expect(text).toContain('rw_pick_workspace')
  })

  it('rejects an unknown alias and lists the available ones', async () => {
    const err = await expectToolError(tool('rw_connect').execute({ alias: 'nope' }), 'INVALID_INPUT')
    expect(err.message).toContain('prod')
    expect(err.message).toContain('dev')
    expect(err.message).not.toContain(ENTRY_PROD.auth.kind === 'password' ? (ENTRY_PROD.auth.password ?? '§') : '§')
  })

  it('surfaces connect failures with their code, never credentials', async () => {
    harness.pool.testConnectError = new RwError('AUTH_FAILED', 'All configured authentication methods failed')
    await expectToolError(tool('rw_connect').execute({ alias: 'prod' }), 'AUTH_FAILED')
    expect(harness.session.alias).toBeNull()
  })

  it('keeps the workspace when reconnecting the same alias, clears it when switching', async () => {
    harness.connect()
    await tool('rw_connect').execute({ alias: 'prod' })
    expect(harness.session.workspace).toBe('/srv/app')
    await tool('rw_connect').execute({ alias: 'dev' })
    expect(harness.session.alias).toBe('dev')
    expect(harness.session.workspace).toBeNull()
  })
})

describe('rw_pick_workspace', () => {
  it('requires a connection first', async () => {
    await expectToolError(tool('rw_pick_workspace').execute({ path: '/srv/app' }), 'NOT_CONNECTED')
  })

  it('picks a directory, canonicalizes it, and creates the placeholder', async () => {
    harness.session.set({ alias: 'prod' })
    harness.pool.fs.addSymlink('/srv/link', '/srv/app')
    const { text } = await tool('rw_pick_workspace').execute({ path: '/srv/link/' })
    expect(harness.session.workspace).toBe('/srv/app')
    expect(text).toContain('Remote workspace set to /srv/app on prod')
    const placeholderDir = join(`${dir}/placeholders`, 'prod', 'app')
    expect(text).toContain(placeholderDir)
    const meta = readPlaceholderMeta(placeholderDir)
    expect(meta).toMatchObject({ plugin: 'dsh-rw', alias: 'prod', remotePath: '/srv/app' })
  })

  it('expands ~/… against the session home before resolving', async () => {
    // FakeSftp canonicalizes realpath('.') to '/', so ~/srv/app → /srv/app.
    harness.session.set({ alias: 'prod' })
    const { text } = await tool('rw_pick_workspace').execute({ path: '~/srv/app' })
    expect(harness.session.workspace).toBe('/srv/app')
    expect(text).toContain('Remote workspace set to /srv/app on prod')
  })

  it('rejects a non-directory and a relative path', async () => {
    harness.session.set({ alias: 'prod' })
    await expectToolError(tool('rw_pick_workspace').execute({ path: '/srv/app/README.md' }), 'NOT_A_DIRECTORY')
    await expectToolError(tool('rw_pick_workspace').execute({ path: 'srv/app' }), 'INVALID_INPUT')
    await expectToolError(tool('rw_pick_workspace').execute({ path: '/missing' }), 'NO_SUCH_PATH')
    expect(harness.session.workspace).toBeNull()
  })
})

describe('file tools session gating', () => {
  it('file tools fail NOT_CONNECTED before any connect', async () => {
    await expectToolError(tool('rw_list_dir').execute({}), 'NOT_CONNECTED')
    await expectToolError(tool('rw_read_file').execute({ path: 'README.md' }), 'NOT_CONNECTED')
    await expectToolError(tool('rw_write_file').execute({ path: 'a', content: 'b' }), 'NOT_CONNECTED')
  })

  it('file tools fail NO_WORKSPACE when connected but unpicked', async () => {
    harness.session.set({ alias: 'prod' })
    harness.pool.connectedAliases.add('prod')
    await expectToolError(tool('rw_list_dir').execute({}), 'NO_WORKSPACE')
    await expectToolError(tool('rw_mkdir').execute({ path: 'x' }), 'NO_WORKSPACE')
    await expectToolError(tool('rw_move').execute({ src: 'a', dst: 'b' }), 'NO_WORKSPACE')
    await expectToolError(tool('rw_delete').execute({ path: 'a' }), 'NO_WORKSPACE')
  })
})

describe('rw_list_dir', () => {
  it('lists the workspace root by default', async () => {
    harness.connect()
    const { text } = await tool('rw_list_dir').execute({})
    expect(text).toContain('type | size | modified | name')
    expect(text).toContain('dir | 0 | 2023-11-14T22:13:20Z | src')
    expect(text).toContain('file | 18 | 2023-11-14T22:13:20Z | README.md')
  })

  it('confines paths to the workspace', async () => {
    harness.connect()
    await expectToolError(tool('rw_list_dir').execute({ path: '/etc' }), 'OUTSIDE_WORKSPACE')
    await expectToolError(tool('rw_list_dir').execute({ path: '../..' }), 'OUTSIDE_WORKSPACE')
  })
})

describe('rw_read_file', () => {
  it('reads with 6-column line numbers and a paging hint', async () => {
    harness.connect()
    const { text } = await tool('rw_read_file').execute({ path: 'README.md' })
    expect(text).toContain('README.md — lines 1-3 of 3')
    expect(text).toContain('     1\tline1')
    expect(text).toContain('     3\tline3')
    expect(text).not.toContain('startLine:')
  })

  it('pages via startLine/maxLines', async () => {
    harness.connect()
    const { text } = await tool('rw_read_file').execute({ path: '/srv/app/README.md', startLine: 2, maxLines: 1 })
    expect(text).toContain('lines 2-2 of 3')
    expect(text).toContain('     2\tline2')
    expect(text).toContain('use startLine: 3 to continue paging')
  })

  it('rejects symlink escapes out of the workspace', async () => {
    harness.connect()
    harness.pool.fs.addSymlink('/srv/app/escape', '/etc/passwd')
    await expectToolError(tool('rw_read_file').execute({ path: 'escape' }), 'SYMLINK_ESCAPE')
    await expectToolError(tool('rw_read_file').execute({ path: '/etc/passwd' }), 'OUTSIDE_WORKSPACE')
  })
})

describe('rw_write_file / rw_mkdir', () => {
  it('writes content (parents auto-created) and reports bytes', async () => {
    harness.connect()
    const { text } = await tool('rw_write_file').execute({ path: 'notes/todo.md', content: 'hello\n' })
    expect(text).toBe('wrote 6 bytes to notes/todo.md')
    expect(harness.pool.fs.fileContent('/srv/app/notes/todo.md')).toBe('hello\n')
  })

  it('write failures keep their code and leak nothing', async () => {
    harness.connect()
    harness.pool.sftpError = new RwError('PERMISSION_DENIED', 'permission denied')
    await expectToolError(tool('rw_write_file').execute({ path: 'a', content: 'b' }), 'PERMISSION_DENIED')
  })

  it('mkdir creates nested directories', async () => {
    harness.connect()
    const { text } = await tool('rw_mkdir').execute({ path: 'a/b/c' })
    expect(text).toBe('created directory a/b/c')
    expect(harness.pool.fs.kindOf('/srv/app/a/b/c')).toBe('dir')
  })
})

describe('rw_move / rw_delete', () => {
  it('moves a file within the workspace', async () => {
    harness.connect()
    const { text } = await tool('rw_move').execute({ src: 'README.md', dst: 'docs.md' })
    expect(text).toBe('moved README.md -> docs.md')
    expect(harness.pool.fs.has('/srv/app/docs.md')).toBe(true)
  })

  it('refuses to overwrite an existing destination without overwrite: true', async () => {
    harness.connect()
    harness.pool.fs.addFile('/srv/app/docs.md', 'existing\n')
    await expectToolError(tool('rw_move').execute({ src: 'README.md', dst: 'docs.md' }), 'INVALID_INPUT')
    const { text } = await tool('rw_move').execute({ src: 'README.md', dst: 'docs.md', overwrite: true })
    expect(text).toContain('moved')
    expect(harness.pool.fs.fileContent('/srv/app/docs.md')).toBe('line1\nline2\nline3\n')
  })

  it('deletes files; directories require recursive: true', async () => {
    harness.connect()
    const { text } = await tool('rw_delete').execute({ path: 'README.md' })
    expect(text).toBe('deleted README.md')
    expect(harness.pool.fs.has('/srv/app/README.md')).toBe(false)
    await expectToolError(tool('rw_delete').execute({ path: 'src' }), 'INVALID_INPUT')
    await tool('rw_delete').execute({ path: 'src', recursive: true })
    expect(harness.pool.fs.has('/srv/app/src')).toBe(false)
  })
})

describe('rw_exec', () => {
  it('requires a connection but not a workspace', async () => {
    await expectToolError(tool('rw_exec').execute({ command: 'ls' }), 'NOT_CONNECTED')
  })

  it('runs with the workspace as cwd and renders exit code/stdout/stderr', async () => {
    harness.connect()
    harness.pool.execQueue.push({ code: 1, signal: null, stdout: 'out\n', stderr: 'err\n', timedOut: false })
    const { text } = await tool('rw_exec').execute({ command: 'make test' })
    expect(harness.pool.execCalls[0]).toMatchObject({
      alias: 'prod',
      command: 'make test',
      opts: { cwd: '/srv/app', timeoutMs: 30000 },
    })
    expect(text).toContain('$ make test')
    expect(text).toContain('cwd: /srv/app')
    expect(text).toContain('[exit code: 1]')
    expect(text).toContain('stdout:\nout')
    expect(text).toContain('stderr:\nerr')
  })

  it('notes the missing cwd when no workspace is picked', async () => {
    harness.session.set({ alias: 'prod' })
    harness.pool.connectedAliases.add('prod')
    const { text } = await tool('rw_exec').execute({ command: 'pwd' })
    expect(harness.pool.execCalls[0]?.opts?.cwd).toBeUndefined()
    expect(text).toContain('cwd: (none — no workspace picked')
  })

  it('renders timeouts with the effective budget and honors timeoutMs', async () => {
    harness.connect()
    harness.pool.execQueue.push({ code: null, signal: 'TIMEOUT', stdout: 'partial', stderr: '', timedOut: true })
    const { text } = await tool('rw_exec').execute({ command: 'sleep 99', timeoutMs: 5000 })
    expect(harness.pool.execCalls[0]?.opts?.timeoutMs).toBe(5000)
    expect(text).toContain('[timed out after 5000ms]')
    expect(text).toContain('stdout:\npartial')
  })

  it('rejects an empty command and wraps pool errors', async () => {
    harness.connect()
    await expectToolError(tool('rw_exec').execute({ command: '   ' }), 'INVALID_INPUT')
    harness.pool.execError = new RwError('NOT_CONNECTED', 'connection to prod closed before ready')
    await expectToolError(tool('rw_exec').execute({ command: 'ls' }), 'NOT_CONNECTED')
  })
})

describe('rw_exec_many', () => {
  it('fans one command out to several hosts, one section per host, in input order', async () => {
    harness.connect()
    harness.pool.execQueue.push(
      { code: 0, signal: null, stdout: 'docker-ok\n', stderr: '', timedOut: false },
      { code: 0, signal: null, stdout: 'dev-ok\n', stderr: '', timedOut: false },
    )
    const { text } = await tool('rw_exec_many').execute({ command: 'uname -a', hosts: ['prod', 'dev'] })
    expect(harness.pool.execCalls.map((c) => c.alias)).toEqual(['prod', 'dev'])
    // The current host runs in its workspace; every other host uses the SSH default dir.
    expect(harness.pool.execCalls[0]?.opts?.cwd).toBe('/srv/app')
    expect(harness.pool.execCalls[1]?.opts?.cwd).toBeUndefined()
    expect(text).toContain('rw_exec_many: 2/2 succeeded')
    expect(text).toContain('--- [1] prod (exit 0) ---')
    expect(text).toContain('--- [2] dev (exit 0) ---')
    expect(text).toContain('docker-ok')
    expect(text).toContain('dev-ok')
  })

  it('honors per-call alias, cwd and timeout, and keeps a failure in its own section', async () => {
    harness.connect()
    harness.pool.execQueue.push(
      { code: 0, signal: null, stdout: 'ok\n', stderr: '', timedOut: false },
      { code: 2, signal: null, stdout: '', stderr: 'boom\n', timedOut: false },
    )
    const { text } = await tool('rw_exec_many').execute({
      calls: [
        { command: 'ls', cwd: '/tmp', timeoutMs: 1234 },
        { alias: 'dev', command: 'false' },
      ],
    })
    expect(harness.pool.execCalls[0]?.opts).toEqual({ cwd: '/tmp', timeoutMs: 1234 })
    expect(harness.pool.execCalls[1]?.alias).toBe('dev')
    expect(text).toContain('1/2 succeeded')
    expect(text).toContain('--- [2] dev (exit 2) ---')
    expect(text).toContain('stderr:\nboom')
  })

  it('runs in parallel up to the limit and isolates an unreachable host', async () => {
    harness.connect()
    const pool = new TrackingPool(['dev'])
    const localTools = new Map(
      (makeTools({ ...harness.deps, pool }) as unknown as TestTool[]).map((t) => [t.name, t]),
    )
    const { text } = await localTools.get('rw_exec_many')!.execute({
      command: 'true',
      hosts: ['prod', 'dev', 'prod'],
      concurrency: 3,
    })
    expect(pool.maxInFlight).toBeGreaterThan(1) // actually parallel …
    expect(pool.maxInFlight).toBeLessThanOrEqual(3) // … but never above the limit
    expect(text).toContain('2/3 succeeded')
    expect(text).toContain('--- [2] dev (not reached) ---')
    expect(text).toContain('unreachable')
    expect(text).toContain('prod:ok')
  })

  it('defaults the alias to the current host and requires a connection when it is absent', async () => {
    await expectToolError(tool('rw_exec_many').execute({ calls: [{ command: 'ls' }] }), 'NOT_CONNECTED')
  })

  it('rejects ambiguous, empty and oversized inputs before touching a host', async () => {
    harness.connect()
    await expectToolError(
      tool('rw_exec_many').execute({ calls: [{ command: 'ls' }], command: 'ls', hosts: ['prod'] }),
      'INVALID_INPUT',
    )
    await expectToolError(tool('rw_exec_many').execute({ calls: [] }), 'INVALID_INPUT')
    await expectToolError(tool('rw_exec_many').execute({ command: '   ', hosts: ['prod'] }), 'INVALID_INPUT')
    await expectToolError(tool('rw_exec_many').execute({ command: 'ls', hosts: [] }), 'INVALID_INPUT')
    await expectToolError(tool('rw_exec_many').execute({ calls: [{ command: '   ' }] }), 'INVALID_INPUT')
    await expectToolError(
      tool('rw_exec_many').execute({ calls: Array.from({ length: 33 }, () => ({ command: 'ls' })) }),
      'INVALID_INPUT',
    )
    expect(harness.pool.execCalls).toEqual([])
  })

  it('rejects an unknown alias before any host runs', async () => {
    harness.connect()
    await expectToolError(
      tool('rw_exec_many').execute({ calls: [{ command: 'ls' }, { alias: 'nope', command: 'ls' }] }),
      'INVALID_INPUT',
    )
    expect(harness.pool.execCalls).toEqual([])
  })
})

describe('rw_write_file optimistic write', () => {
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

  it('writes when ifHash matches the current content', async () => {
    harness.connect()
    const current = harness.pool.fs.fileContent('/srv/app/README.md') ?? ''
    const { text } = await tool('rw_write_file').execute({ path: 'README.md', content: 'next\n', ifHash: sha256(current) })
    expect(text).toContain('wrote')
    expect(harness.pool.fs.fileContent('/srv/app/README.md')).toBe('next\n')
  })

  it('refuses a write when the remote content moved on', async () => {
    harness.connect()
    await expectToolError(
      tool('rw_write_file').execute({ path: 'README.md', content: 'next\n', ifHash: sha256('stale') }),
      'RW_WRITE_CONFLICT',
    )
    expect(harness.pool.fs.fileContent('/srv/app/README.md')).toBe('line1\nline2\nline3\n')
  })

  it('honours ifHash: "absent" for create-only and existing-file cases', async () => {
    harness.connect()
    const created = await tool('rw_write_file').execute({ path: 'fresh.txt', content: 'x\n', ifHash: 'absent' })
    expect(created.text).toContain('wrote')
    await expectToolError(
      tool('rw_write_file').execute({ path: 'fresh.txt', content: 'y\n', ifHash: 'absent' }),
      'RW_WRITE_CONFLICT',
    )
    expect(harness.pool.fs.fileContent('/srv/app/fresh.txt')).toBe('x\n')
  })
})

describe('rw_watch', () => {
  it('lists an empty registry', async () => {
    const { text } = await tool('rw_watch').execute({ action: 'list' })
    expect(text).toContain('no watchers')
  })

  it('establishes a baseline, then reports added / changed / removed since the last poll', async () => {
    harness.connect()
    const start = await tool('rw_watch').execute({ action: 'start', name: 'app' })
    expect(start.text).toContain('baseline of 2 entries')

    // No change yet.
    const quiet = await tool('rw_watch').execute({ action: 'poll', name: 'app' })
    expect(quiet.text).toContain('0 change(s)')

    // Mutate the fake remote: one added, one changed (new mtime), one removed.
    harness.pool.fs.addFile('/srv/app/src/new.ts', 'x\n', 99)
    harness.pool.fs.addFile('/srv/app/README.md', 'line1\nline2\nline3\n', 99)
    harness.pool.fs.nodes.delete('/srv/app/src/index.ts')

    const poll = await tool('rw_watch').execute({ action: 'poll', name: 'app' })
    expect(poll.text).toMatch(/added\s+src\/new\.ts/)
    expect(poll.text).toMatch(/changed\s+README\.md/)
    expect(poll.text).toMatch(/removed\s+src\/index\.ts/)
    expect(poll.text).toContain('3 change(s)')
  })

  it('honours an include filter and a workspace-relative path', async () => {
    harness.connect()
    const start = await tool('rw_watch').execute({ action: 'start', name: 'ts', path: 'src', include: '*.ts' })
    expect(start.text).toContain('baseline of 1 entries')

    harness.pool.fs.addFile('/srv/app/src/notes.md', 'x\n', 99)
    harness.pool.fs.addFile('/srv/app/src/more.ts', 'x\n', 99)
    const poll = await tool('rw_watch').execute({ action: 'poll', name: 'ts' })
    expect(poll.text).toContain('more.ts')
    expect(poll.text).not.toContain('notes.md')
  })

  it('lists and stops watchers', async () => {
    harness.connect()
    await tool('rw_watch').execute({ action: 'start', name: 'one' })
    const list = await tool('rw_watch').execute({ action: 'list' })
    expect(list.text).toContain('one: /srv/app')
    const stop = await tool('rw_watch').execute({ action: 'stop', name: 'one' })
    expect(stop.text).toContain("stopped watcher 'one'")
    expect((await tool('rw_watch').execute({ action: 'stop', name: 'one' })).text).toContain('no watcher named')
  })

  it('requires a connection and a workspace, and confines the path', async () => {
    await expectToolError(tool('rw_watch').execute({ action: 'start' }), 'NOT_CONNECTED')
    harness.session.set({ alias: 'prod' }) // connected, workspace not picked yet
    await expectToolError(tool('rw_watch').execute({ action: 'start' }), 'NO_WORKSPACE')
    harness.connect()
    await expectToolError(tool('rw_watch').execute({ action: 'start', path: '../escape' }), 'OUTSIDE_WORKSPACE')
    await expectToolError(tool('rw_watch').execute({ action: 'poll', name: 'nope' }), 'INVALID_INPUT')
  })
})

describe('rw_diff', () => {
  it('reports no differences for identical content', async () => {
    harness.connect()
    const { text } = await tool('rw_diff').execute({ path: 'README.md', content: 'line1\nline2\nline3\n' })
    expect(text).toContain('no differences')
  })

  it('diffs against supplied content with unified headers and hunks', async () => {
    harness.connect()
    const { text } = await tool('rw_diff').execute({ path: 'README.md', content: 'line1\nCHANGED\nline3\n' })
    expect(text).toContain('--- a/README.md')
    expect(text).toContain('+++ b/README.md')
    expect(text).toContain('-line2')
    expect(text).toContain('+CHANGED')
  })

  it('diffs against another remote file', async () => {
    harness.connect()
    const { text } = await tool('rw_diff').execute({ path: 'README.md', against: 'src/index.ts' })
    expect(text).toContain('--- a/README.md')
    expect(text).toContain('+export {}')
  })

  it('rejects binary content, missing/ambiguous after-sides, and paths outside the workspace', async () => {
    harness.connect()
    harness.pool.fs.addFile('/srv/app/blob.bin', Buffer.from([0, 1, 2, 0]))
    await expectToolError(tool('rw_diff').execute({ path: 'blob.bin', content: 'x' }), 'INVALID_INPUT')
    await expectToolError(tool('rw_diff').execute({ path: 'README.md' }), 'INVALID_INPUT')
    await expectToolError(tool('rw_diff').execute({ path: 'README.md', content: 'a', against: 'src/index.ts' }), 'INVALID_INPUT')
    await expectToolError(tool('rw_diff').execute({ path: '/etc/passwd', content: 'a' }), 'OUTSIDE_WORKSPACE')
  })
})

describe('rw_apply_patch', () => {
  const PATCH = ['--- a/src/index.ts', '+++ b/src/index.ts', '@@ -1 +1 @@', '-export {}', '+export const x = 1', ''].join('\n')

  it('dry-runs by default-check and reports the validated targets without applying', async () => {
    harness.connect()
    const { text } = await tool('rw_apply_patch').execute({ patch: PATCH, dryRun: true })
    expect(text).toContain('applies cleanly to 1 file(s)')
    expect(text).toContain('/srv/app/src/index.ts')
    expect(harness.pool.execCalls.length).toBe(1)
    expect(harness.pool.execCalls[0]?.command).toContain('patch -p1 --dry-run -i')
    expect(harness.pool.execCalls[0]?.opts?.cwd).toBe('/srv/app')
  })

  it('applies after a clean dry run and removes the staged patch file', async () => {
    harness.connect()
    const { text } = await tool('rw_apply_patch').execute({ patch: PATCH })
    expect(text).toContain('applied patch to 1 file(s)')
    expect(harness.pool.execCalls.map((c) => c.command.includes('--dry-run'))).toEqual([true, false])
    // No staged .dsh-rw-patch-* file survives the call.
    expect([...harness.pool.fs.nodes.keys()].filter((k) => k.includes('.dsh-rw-patch-'))).toEqual([])
  })

  it('rejects a patch that escapes the workspace before running anything', async () => {
    harness.connect()
    const escaping = ['--- a/../../etc/passwd', '+++ b/../../etc/passwd', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
    await expectToolError(tool('rw_apply_patch').execute({ patch: escaping }), 'INVALID_INPUT')
    expect(harness.pool.execCalls).toEqual([])
  })

  it('surfaces a failed dry run and does not apply', async () => {
    harness.connect()
    harness.pool.execQueue.push({ code: 1, signal: null, stdout: '', stderr: 'hunk FAILED', timedOut: false })
    await expectToolError(tool('rw_apply_patch').execute({ patch: PATCH }), 'INVALID_INPUT')
    expect(harness.pool.execCalls.length).toBe(1)
  })

  it('rejects an empty patch', async () => {
    harness.connect()
    await expectToolError(tool('rw_apply_patch').execute({ patch: '   ' }), 'INVALID_INPUT')
  })
})

describe('rw_disconnect', () => {
  it('disconnects the pool and clears the alias but keeps the workspace record', async () => {
    harness.connect()
    const { text } = await tool('rw_disconnect').execute({})
    expect(text).toBe('disconnected from prod')
    expect(harness.pool.disconnected).toEqual(['prod'])
    expect(harness.session.alias).toBeNull()
    expect(harness.session.workspace).toBe('/srv/app')
  })

  it('is a no-op when not connected', async () => {
    const { text } = await tool('rw_disconnect').execute({})
    expect(text).toContain('not connected')
  })
})

describe('workspace resolution follows the session working directory', () => {
  /** A tool-execution context whose agent works in `cwd`. */
  const ctxAt = (cwd: string): { agent: { session: { header: { cwd: string } } } } => ({
    agent: { session: { header: { cwd } } },
  })

  it('uses the placeholder the agent works in, even when the session record points elsewhere', async () => {
    harness.connect() // record: prod:/srv/app
    const root = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', `${dir}/placeholders`)
    harness.pool.fs.addFile('/srv/app/from-cwd.txt', 'cwd wins\n')
    // The record now names another host entirely (what a reconnect leaves behind).
    harness.session.set({ alias: 'dev', workspace: '/srv/other' })

    const { text } = await tool('rw_read_file').execute({ path: 'from-cwd.txt' }, ctxAt(root))
    expect(text).toContain('cwd wins')
    expect(harness.pool.connectedAliases.has('prod')).toBe(true)
  })

  it('reports where the workspace came from', async () => {
    harness.connect()
    const root = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', `${dir}/placeholders`)
    const fromCwd = await tool('rw_info').execute({}, ctxAt(root))
    expect(fromCwd.text).toContain("from this session's working directory")
    const fromRecord = await tool('rw_info').execute({}, ctxAt('/elsewhere'))
    expect(fromRecord.text).toContain('from the plugin session record')
  })

  it('fails loud when the working directory belongs to a host that is gone (never the record)', async () => {
    harness.connect()
    const root = ensurePlaceholder('prod', ENTRY_PROD, '/srv/app', `${dir}/placeholders`)
    harness.hosts.entries.length = 0 // the host was removed from the config
    await expectToolError(tool('rw_read_file').execute({ path: 'x' }, ctxAt(root)), 'NOT_CONNECTED')
    expect(harness.pool.execCalls).toEqual([])
  })
})
