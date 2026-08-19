import { describe, expect, it } from 'vitest'
import { RwError } from '../src/errors.js'
import type { RwErrorCode } from '../src/errors.js'
import {
  assertRealpathInside,
  assertWritableInside,
  baseName,
  dirName,
  normalizeRemote,
  resolveInWorkspace,
  shq,
} from '../src/guard.js'
import { FakeSftp } from './fakes.js'

function thrownCode(fn: () => unknown): RwErrorCode {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RwError)
    return (err as RwError).code
  }
  throw new Error('expected function to throw')
}

async function rejectedError(p: Promise<unknown>): Promise<RwError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(RwError)
    return err as RwError
  }
  throw new Error('expected promise to reject')
}

async function rejectedCode(p: Promise<unknown>): Promise<RwErrorCode> {
  return (await rejectedError(p)).code
}

describe('normalizeRemote', () => {
  it.each([
    ['/', '/'],
    ['', '/'],
    ['.', '/'],
    ['..', '/'],
    ['//', '/'],
    ['/../..', '/'],
    ['/../../..', '/'],
    ['/a/b/', '/a/b'],
    ['//a///b//', '/a/b'],
    ['/a/./b/.', '/a/b'],
    ['/a/../b', '/b'],
    ['/a/b/..', '/a'],
    ['/a/../../b', '/b'],
    ['a/b', '/a/b'],
    ['a/./b', '/a/b'],
    ['a/../..', '/'],
    ['../..', '/'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRemote(input)).toBe(expected)
  })

  it('keeps dot-ish names, spaces and Unicode segments intact', () => {
    expect(normalizeRemote('/a/..b/c..')).toBe('/a/..b/c..')
    expect(normalizeRemote('/a b/日 本 語/x.txt')).toBe('/a b/日 本 語/x.txt')
  })
})

describe('baseName', () => {
  it.each([
    ['/', 'workspace'],
    ['/a', 'a'],
    ['/a/b/', 'b'],
    ['/a/b.txt', 'b.txt'],
  ])('%s → %s', (input, expected) => {
    expect(baseName(input)).toBe(expected)
  })
})

describe('dirName', () => {
  it.each([
    ['/', '/'],
    ['/a', '/'],
    ['/a/b', '/a'],
    ['/a/b/c', '/a/b'],
  ])('%s → %s', (input, expected) => {
    expect(dirName(input)).toBe(expected)
  })
})

describe('shq', () => {
  it('wraps in single quotes and escapes embedded quotes', () => {
    expect(shq('abc')).toBe(`'abc'`)
    expect(shq('')).toBe(`''`)
    expect(shq(`a'b`)).toBe(`'a'\\''b'`)
    expect(shq(`it's a "test"`)).toBe(`'it'\\''s a "test"'`)
  })
})

describe('resolveInWorkspace', () => {
  it('maps empty input to the root itself', () => {
    expect(resolveInWorkspace('/ws', undefined)).toBe('/ws')
    expect(resolveInWorkspace('/ws', null)).toBe('/ws')
    expect(resolveInWorkspace('/ws', '')).toBe('/ws')
  })

  it('joins relative paths under the root', () => {
    expect(resolveInWorkspace('/ws', 'a')).toBe('/ws/a')
    expect(resolveInWorkspace('/ws', './a')).toBe('/ws/a')
    expect(resolveInWorkspace('/ws', 'a/./b')).toBe('/ws/a/b')
    expect(resolveInWorkspace('/ws', 'a/../b')).toBe('/ws/b')
    expect(resolveInWorkspace('/ws', 'sub/dir/file.txt')).toBe('/ws/sub/dir/file.txt')
  })

  it('accepts absolute paths equal to or inside the root', () => {
    expect(resolveInWorkspace('/ws', '/ws')).toBe('/ws')
    expect(resolveInWorkspace('/ws', '/ws/')).toBe('/ws')
    expect(resolveInWorkspace('/ws', '/ws/a/b')).toBe('/ws/a/b')
  })

  it('normalizes the root itself before comparing', () => {
    expect(resolveInWorkspace('/ws/', 'a')).toBe('/ws/a')
    expect(resolveInWorkspace('/ws//', '/ws/a')).toBe('/ws/a')
    expect(resolveInWorkspace('/x/../ws', 'a')).toBe('/ws/a')
  })

  it('rejects escapes via .., prefix lookalikes and outside absolutes', () => {
    expect(thrownCode(() => resolveInWorkspace('/ws', '..'))).toBe('OUTSIDE_WORKSPACE')
    expect(thrownCode(() => resolveInWorkspace('/ws', '../x'))).toBe('OUTSIDE_WORKSPACE')
    expect(thrownCode(() => resolveInWorkspace('/ws', 'a/../../x'))).toBe('OUTSIDE_WORKSPACE')
    expect(thrownCode(() => resolveInWorkspace('/ws', '/wsx'))).toBe('OUTSIDE_WORKSPACE')
    expect(thrownCode(() => resolveInWorkspace('/ws', '/ws/../ws2/x'))).toBe('OUTSIDE_WORKSPACE')
    expect(thrownCode(() => resolveInWorkspace('/ws', '/etc/passwd'))).toBe('OUTSIDE_WORKSPACE')
    expect(thrownCode(() => resolveInWorkspace('/ws', '/'))).toBe('OUTSIDE_WORKSPACE')
  })

  it('allows paths that climb out but land back inside', () => {
    expect(resolveInWorkspace('/ws', '../ws/ok')).toBe('/ws/ok')
    expect(resolveInWorkspace('/ws', '/ws/a/../../ws/b')).toBe('/ws/b')
  })

  it('treats root "/" as containing every absolute path', () => {
    expect(resolveInWorkspace('/', undefined)).toBe('/')
    expect(resolveInWorkspace('/', '/etc/passwd')).toBe('/etc/passwd')
    expect(resolveInWorkspace('/', 'a/../b')).toBe('/b')
    expect(resolveInWorkspace('/', '../x')).toBe('/x')
    expect(resolveInWorkspace('/', '/../x')).toBe('/x')
  })

  it('handles spaces and Unicode segments', () => {
    expect(resolveInWorkspace('/ws', 'my dir/x')).toBe('/ws/my dir/x')
    expect(resolveInWorkspace('/ws', '子目录/ファイル.txt')).toBe('/ws/子目录/ファイル.txt')
    expect(resolveInWorkspace('/数据', 'a')).toBe('/数据/a')
    expect(thrownCode(() => resolveInWorkspace('/数据', '/数'))).toBe('OUTSIDE_WORKSPACE')
  })
})

describe('assertRealpathInside', () => {
  function seeded(): FakeSftp {
    return new FakeSftp()
      .addDir('/ws')
      .addDir('/ws/sub')
      .addFile('/ws/a.txt', 'hello')
      .addDir('/etc')
      .addFile('/etc/passwd', 'root:x:0:0')
      .addSymlink('/ws/link-file', '/ws/a.txt')
      .addSymlink('/ws/link-dir', 'sub') // relative target
      .addSymlink('/ws/chain', '/ws/link-file')
      .addSymlink('/ws/evil', '/etc/passwd')
      .addSymlink('/ws/evil-dir', '/etc')
      .addSymlink('/ws/loop', '/ws/loop')
  }

  it('returns the realpath for plain paths inside the workspace', async () => {
    await expect(assertRealpathInside(seeded(), '/ws', '/ws/a.txt')).resolves.toBe('/ws/a.txt')
    await expect(assertRealpathInside(seeded(), '/ws', '/ws')).resolves.toBe('/ws')
  })

  it('follows symlinks (absolute, relative, chained) that stay inside', async () => {
    const sftp = seeded()
    await expect(assertRealpathInside(sftp, '/ws', '/ws/link-file')).resolves.toBe('/ws/a.txt')
    await expect(assertRealpathInside(sftp, '/ws', '/ws/link-dir')).resolves.toBe('/ws/sub')
    await expect(assertRealpathInside(sftp, '/ws', '/ws/chain')).resolves.toBe('/ws/a.txt')
  })

  it('rejects symlinks resolving outside the workspace', async () => {
    const sftp = seeded()
    expect(await rejectedCode(assertRealpathInside(sftp, '/ws', '/ws/evil'))).toBe('SYMLINK_ESCAPE')
    expect(await rejectedCode(assertRealpathInside(sftp, '/ws', '/ws/evil-dir/passwd'))).toBe('SYMLINK_ESCAPE')
  })

  it('maps a missing path via mapSftpError to NO_SUCH_PATH', async () => {
    const err = await rejectedError(assertRealpathInside(seeded(), '/ws', '/ws/nope'))
    expect(err.code).toBe('NO_SUCH_PATH')
    expect(err.message).toContain('/ws/nope')
  })

  it('maps symlink loops (realpath failure, code 4) to REMOTE_ERROR', async () => {
    expect(await rejectedCode(assertRealpathInside(seeded(), '/ws', '/ws/loop'))).toBe('REMOTE_ERROR')
  })

  it('accepts any path when the root is "/"', async () => {
    await expect(assertRealpathInside(seeded(), '/', '/etc/passwd')).resolves.toBe('/etc/passwd')
  })
})

describe('assertWritableInside', () => {
  it('accepts a new file directly under an existing directory', async () => {
    const sftp = new FakeSftp().addDir('/ws')
    await expect(assertWritableInside(sftp, '/ws', '/ws/new.txt')).resolves.toBeUndefined()
  })

  it('walks up past missing parents to the nearest existing ancestor', async () => {
    const sftp = new FakeSftp().addDir('/ws').addDir('/ws/sub')
    await expect(assertWritableInside(sftp, '/ws', '/ws/sub/a/b/c.txt')).resolves.toBeUndefined()
  })

  it('accepts ancestors that are symlinks staying inside the workspace', async () => {
    const sftp = new FakeSftp().addDir('/ws').addDir('/ws/real').addSymlink('/ws/linked', '/ws/real')
    await expect(assertWritableInside(sftp, '/ws', '/ws/linked/new.txt')).resolves.toBeUndefined()
  })

  it('rejects when the nearest existing ancestor escapes the workspace', async () => {
    const sftp = new FakeSftp().addDir('/ws').addDir('/etc').addSymlink('/ws/evil', '/etc')
    expect(await rejectedCode(assertWritableInside(sftp, '/ws', '/ws/evil/new.txt'))).toBe('SYMLINK_ESCAPE')
  })

  it('rejects with NO_SUCH_PATH when even the workspace root is missing', async () => {
    const sftp = new FakeSftp().addDir('/ws')
    expect(await rejectedCode(assertWritableInside(sftp, '/nope', '/nope/a/b.txt'))).toBe('NO_SUCH_PATH')
  })

  it('resolves at "/" when the root is "/"', async () => {
    const sftp = new FakeSftp().addDir('/ws')
    await expect(assertWritableInside(sftp, '/', '/any/thing.txt')).resolves.toBeUndefined()
  })
})
