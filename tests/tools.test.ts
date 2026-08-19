import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RwError } from '../src/errors.js'
import { placeholderDirFor, readPlaceholderMeta } from '../src/placeholder.js'
import { makeTools } from '../src/tools.js'
import { ENTRY_PROD, makeHarness, SECRET_PASSWORD } from './p4-fakes.js'
import type { FakeHarness } from './p4-fakes.js'

/** Test-facing view of a defineTool product (the registry supplies exec). */
interface TestTool {
  name: string
  description: string
  execute(args?: Record<string, unknown>): Promise<{ text: string }>
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
  it('registers exactly the twelve rw_* tools in fixed order', () => {
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
    const { text } = await tool('rw_info').execute({})
    expect(text).toContain('deploy@example.com:22 (alias: prod)')
    expect(text).toContain('Connected: yes')
    expect(text).toContain('Current workspace: /srv/app')
    expect(text).toContain(placeholderDirFor('prod', '/srv/app', `${dir}/placeholders`))
    expect(text).not.toContain(SECRET_PASSWORD)
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
    const placeholderDir = placeholderDirFor('prod', '/srv/app', `${dir}/placeholders`)
    expect(text).toContain(placeholderDir)
    const meta = readPlaceholderMeta(placeholderDir)
    expect(meta).toMatchObject({ plugin: 'dsh-rw', alias: 'prod', remotePath: '/srv/app' })
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
