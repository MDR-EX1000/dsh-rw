import { describe, expect, it } from 'vitest'
import { RwError } from '../src/errors.js'
import type { RwErrorCode } from '../src/errors.js'
import { RemoteFs } from '../src/remote-fs.js'
import { FAKE_MTIME, FakeSftp } from './fakes.js'

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

/** Standard fixture: workspace /ws with files, dirs, an inside link and escape links. */
function seeded(): FakeSftp {
  return new FakeSftp()
    .addDir('/ws')
    .addDir('/ws/b-dir')
    .addDir('/ws/a-dir')
    .addFile('/ws/z.txt', 'z', FAKE_MTIME + 3)
    .addFile('/ws/m.txt', 'm-line1\nm-line2\n', FAKE_MTIME + 2)
    .addFile('/ws/b-dir/nested.txt', 'nested')
    .addDir('/etc')
    .addFile('/etc/passwd', 'root:x:0:0')
    .addSymlink('/ws/lnk', '/etc/passwd') // link entry listed as 'symlink'
    .addSymlink('/ws/evil-dir', '/etc') // escape via a directory link
    .addSymlink('/ws/inside-link', '/ws/b-dir') // link staying inside
    .addSymlink('/ws/dangling', '/ws/no-such-target')
}

function makeFs(sftp: FakeSftp, root = '/ws'): RemoteFs {
  return new RemoteFs(sftp, root)
}

describe('RemoteFs constructor', () => {
  it('normalizes the root and does no IO', () => {
    const fs = makeFs(new FakeSftp(), '/ws//sub/../')
    expect(fs.root).toBe('/ws')
  })
})

describe('RemoteFs.list', () => {
  it('lists the root by default, sorted by name, with types', async () => {
    const entries = await makeFs(seeded()).list()
    expect(entries.map((e) => e.name)).toEqual(['a-dir', 'b-dir', 'dangling', 'evil-dir', 'inside-link', 'lnk', 'm.txt', 'z.txt'])
    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.get('a-dir')?.type).toBe('dir')
    expect(byName.get('z.txt')?.type).toBe('file')
    expect(byName.get('z.txt')?.size).toBe(1)
    expect(byName.get('z.txt')?.mtime).toBe(FAKE_MTIME + 3)
    // symlink entries are labeled from lstat-like attrs, never followed
    expect(byName.get('lnk')?.type).toBe('symlink')
    expect(byName.get('inside-link')?.type).toBe('symlink')
    expect(byName.get('evil-dir')?.type).toBe('symlink')
  })

  it('lists a subdirectory', async () => {
    const entries = await makeFs(seeded()).list('b-dir')
    expect(entries.map((e) => e.name)).toEqual(['nested.txt'])
  })

  it('lists through a symlink that stays inside the workspace', async () => {
    const entries = await makeFs(seeded()).list('inside-link')
    expect(entries.map((e) => e.name)).toEqual(['nested.txt'])
  })

  it('filters "." and ".." entries returned by the server', async () => {
    const sftp = seeded()
    sftp.nodes.set('/ws/.', { kind: 'dir', mtime: 0 })
    sftp.nodes.set('/ws/..', { kind: 'dir', mtime: 0 })
    const entries = await makeFs(sftp).list()
    expect(entries.some((e) => e.name === '.' || e.name === '..')).toBe(false)
  })

  it('rejects files with NOT_A_DIRECTORY', async () => {
    expect(await rejectedCode(makeFs(seeded()).list('z.txt'))).toBe('NOT_A_DIRECTORY')
  })

  it('rejects missing paths with NO_SUCH_PATH', async () => {
    expect(await rejectedCode(makeFs(seeded()).list('nope'))).toBe('NO_SUCH_PATH')
  })

  it('rejects paths outside the workspace', async () => {
    const fs = makeFs(seeded())
    expect(await rejectedCode(fs.list('..'))).toBe('OUTSIDE_WORKSPACE')
    expect(await rejectedCode(fs.list('/etc'))).toBe('OUTSIDE_WORKSPACE')
  })

  it('rejects a directory symlink escaping the workspace', async () => {
    expect(await rejectedCode(makeFs(seeded()).list('evil-dir'))).toBe('SYMLINK_ESCAPE')
  })

  it('lists the workspace root itself when it is "/"', async () => {
    const sftp = new FakeSftp().addFile('/top.txt', 'x').addDir('/dir')
    const entries = await makeFs(sftp, '/').list()
    expect(entries.map((e) => e.name)).toEqual(['dir', 'top.txt'])
  })
})

describe('RemoteFs.read', () => {
  it('reads a whole small file with defaults', async () => {
    const r = await makeFs(seeded()).read('m.txt')
    expect(r).toEqual({ content: 'm-line1\nm-line2', totalLines: 2, startLine: 1, endLine: 2, truncated: false })
  })

  it('pages with 1-based startLine and maxLines', async () => {
    const sftp = new FakeSftp().addDir('/ws').addFile('/ws/f.txt', 'l1\nl2\nl3\nl4\nl5')
    const fs = makeFs(sftp)
    const r = await fs.read('f.txt', { startLine: 2, maxLines: 2 })
    expect(r).toEqual({ content: 'l2\nl3', totalLines: 5, startLine: 2, endLine: 3, truncated: false })
    const tail = await fs.read('f.txt', { startLine: 4, maxLines: 100 })
    expect(tail).toEqual({ content: 'l4\nl5', totalLines: 5, startLine: 4, endLine: 5, truncated: false })
  })

  it('clamps startLine below 1 and reports an empty range past EOF', async () => {
    const sftp = new FakeSftp().addDir('/ws').addFile('/ws/f.txt', 'a\nb')
    const fs = makeFs(sftp)
    const fromZero = await fs.read('f.txt', { startLine: 0 })
    expect(fromZero.startLine).toBe(1)
    expect(fromZero.content).toBe('a\nb')
    const past = await fs.read('f.txt', { startLine: 10 })
    expect(past).toEqual({ content: '', totalLines: 2, startLine: 10, endLine: 9, truncated: false })
  })

  it('applies the default page size of 2000 lines', async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join('\n')
    const sftp = new FakeSftp().addDir('/ws').addFile('/ws/big.txt', big)
    const r = await makeFs(sftp).read('big.txt')
    expect(r.totalLines).toBe(2500)
    expect(r.endLine).toBe(2000)
    expect(r.content.split('\n')).toHaveLength(2000)
    expect(r.content.startsWith('line1\n')).toBe(true)
    expect(r.truncated).toBe(false)
  })

  it('caps maxLines at 10000', async () => {
    const big = Array.from({ length: 10005 }, (_, i) => `x${i}`).join('\n')
    const sftp = new FakeSftp().addDir('/ws').addFile('/ws/big.txt', big)
    const r = await makeFs(sftp).read('big.txt', { maxLines: 99999 })
    expect(r.content.split('\n')).toHaveLength(10000)
    expect(r.endLine).toBe(10000)
  })

  it('truncates content beyond maxBytes and flags it', async () => {
    const sftp = new FakeSftp().addDir('/ws').addFile('/ws/f.txt', 'hello world')
    const r = await makeFs(sftp).read('f.txt', { maxBytes: 5 })
    expect(r.content).toBe('hello')
    expect(r.truncated).toBe(true)
    expect(r.totalLines).toBe(1)
  })

  it('does not flag truncation when size equals maxBytes', async () => {
    const sftp = new FakeSftp().addDir('/ws').addFile('/ws/f.txt', '12345')
    const r = await makeFs(sftp).read('f.txt', { maxBytes: 5 })
    expect(r.truncated).toBe(false)
  })

  it('truncates files larger than the 2MB default cap', async () => {
    const sftp = new FakeSftp().addDir('/ws').addFile('/ws/huge.bin', 'a'.repeat(2 * 1024 * 1024 + 10))
    const r = await makeFs(sftp).read('huge.bin')
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.content, 'utf8')).toBe(2 * 1024 * 1024)
  })

  it('handles an empty file', async () => {
    const sftp = new FakeSftp().addDir('/ws').addFile('/ws/empty.txt', '')
    const r = await makeFs(sftp).read('empty.txt')
    expect(r).toEqual({ content: '', totalLines: 0, startLine: 1, endLine: 0, truncated: false })
  })

  it('reads through a symlink whose target stays inside', async () => {
    const sftp = seeded().addSymlink('/ws/inside-file', '/ws/m.txt')
    const r = await makeFs(sftp).read('inside-file')
    expect(r.content).toBe('m-line1\nm-line2')
  })

  it('rejects directories, missing files, escapes and outside paths', async () => {
    const fs = makeFs(seeded())
    expect(await rejectedCode(fs.read('a-dir'))).toBe('NOT_A_DIRECTORY')
    expect(await rejectedCode(fs.read('nope'))).toBe('NO_SUCH_PATH')
    expect(await rejectedCode(fs.read('dangling'))).toBe('NO_SUCH_PATH')
    expect(await rejectedCode(fs.read('lnk'))).toBe('SYMLINK_ESCAPE')
    expect(await rejectedCode(fs.read('../etc/passwd'))).toBe('OUTSIDE_WORKSPACE')
    expect(await rejectedCode(fs.read('/etc/passwd'))).toBe('OUTSIDE_WORKSPACE')
  })
})

describe('RemoteFs.write', () => {
  it('writes a new file and returns its byte length', async () => {
    const sftp = seeded()
    const r = await makeFs(sftp).write('new.txt', 'héllo')
    expect(r.bytes).toBe(Buffer.byteLength('héllo', 'utf8'))
    expect(sftp.fileContent('/ws/new.txt')).toBe('héllo')
  })

  it('writes Buffers verbatim', async () => {
    const sftp = seeded()
    const buf = Buffer.from([0, 1, 2, 255])
    const r = await makeFs(sftp).write('bin', buf)
    expect(r.bytes).toBe(4)
    expect(sftp.nodes.get('/ws/bin')).toMatchObject({ kind: 'file' })
  })

  it('creates missing parent directories by default', async () => {
    const sftp = seeded()
    await makeFs(sftp).write('deep/deeper/file.txt', 'x')
    expect(sftp.kindOf('/ws/deep')).toBe('dir')
    expect(sftp.kindOf('/ws/deep/deeper')).toBe('dir')
    expect(sftp.fileContent('/ws/deep/deeper/file.txt')).toBe('x')
  })

  it('overwrites an existing file', async () => {
    const sftp = seeded()
    await makeFs(sftp).write('m.txt', 'replaced')
    expect(sftp.fileContent('/ws/m.txt')).toBe('replaced')
  })

  it('with mkdir:false fails when the parent is missing', async () => {
    const sftp = seeded()
    expect(await rejectedCode(makeFs(sftp).write('no/dir/file.txt', 'x', { mkdir: false }))).toBe('NO_SUCH_PATH')
  })

  it('writes through an inside directory symlink, landing at the target', async () => {
    const sftp = seeded()
    await makeFs(sftp).write('inside-link/via-link.txt', 'x')
    expect(sftp.fileContent('/ws/b-dir/via-link.txt')).toBe('x')
  })

  it('rejects writes outside the workspace or through escaping links', async () => {
    const sftp = seeded()
    const fs = makeFs(sftp)
    expect(await rejectedCode(fs.write('../escape.txt', 'x'))).toBe('OUTSIDE_WORKSPACE')
    expect(await rejectedCode(fs.write('/etc/new', 'x'))).toBe('OUTSIDE_WORKSPACE')
    expect(await rejectedCode(fs.write('evil-dir/new.txt', 'x'))).toBe('SYMLINK_ESCAPE')
    expect(sftp.has('/etc/new')).toBe(false)
    expect(sftp.has('/etc/new.txt')).toBe(false)
  })

  it('rejects writing onto an existing directory path', async () => {
    expect(await rejectedCode(makeFs(seeded()).write('a-dir', 'x'))).toBe('REMOTE_ERROR')
  })
})

describe('RemoteFs.mkdir', () => {
  it('creates directories recursively', async () => {
    const sftp = seeded()
    await makeFs(sftp).mkdir('a/b/c')
    expect(sftp.kindOf('/ws/a/b/c')).toBe('dir')
  })

  it('succeeds silently when the directory already exists', async () => {
    const sftp = seeded()
    await expect(makeFs(sftp).mkdir('a-dir')).resolves.toBeUndefined()
    await expect(makeFs(sftp).mkdir('.')).resolves.toBeUndefined() // the root itself
  })

  it('rejects when a non-directory occupies the path', async () => {
    expect(await rejectedCode(makeFs(seeded()).mkdir('m.txt/sub'))).toBe('INVALID_INPUT')
  })

  it('rejects paths outside the workspace', async () => {
    expect(await rejectedCode(makeFs(seeded()).mkdir('/etc/x'))).toBe('OUTSIDE_WORKSPACE')
  })
})

describe('RemoteFs.move', () => {
  it('renames a file within the workspace', async () => {
    const sftp = seeded()
    await makeFs(sftp).move('m.txt', 'renamed.txt')
    expect(sftp.has('/ws/m.txt')).toBe(false)
    expect(sftp.fileContent('/ws/renamed.txt')).toBe('m-line1\nm-line2\n')
  })

  it('moves a directory with its subtree', async () => {
    const sftp = seeded()
    await makeFs(sftp).move('b-dir', 'a-dir/moved')
    expect(sftp.has('/ws/b-dir')).toBe(false)
    expect(sftp.fileContent('/ws/a-dir/moved/nested.txt')).toBe('nested')
  })

  it('moves a symlink as the link itself, leaving the target alone', async () => {
    const sftp = seeded()
    await makeFs(sftp).move('lnk', 'lnk2')
    expect(sftp.has('/ws/lnk')).toBe(false)
    expect(sftp.kindOf('/ws/lnk2')).toBe('symlink')
    expect(sftp.nodes.get('/ws/lnk2')).toMatchObject({ target: '/etc/passwd' })
    expect(sftp.fileContent('/etc/passwd')).toBe('root:x:0:0')
  })

  it('rejects an existing destination unless overwrite is set', async () => {
    const sftp = seeded()
    const fs = makeFs(sftp)
    expect(await rejectedCode(fs.move('m.txt', 'z.txt'))).toBe('INVALID_INPUT')
    await expect(fs.move('m.txt', 'z.txt', { overwrite: true })).resolves.toBeUndefined()
    expect(sftp.fileContent('/ws/z.txt')).toBe('m-line1\nm-line2\n')
    expect(sftp.has('/ws/m.txt')).toBe(false)
  })

  it('overwrites an empty destination directory', async () => {
    const sftp = seeded().addDir('/ws/empty-dir')
    await makeFs(sftp).move('m.txt', 'empty-dir', { overwrite: true })
    expect(sftp.fileContent('/ws/empty-dir')).toBe('m-line1\nm-line2\n')
  })

  it('rejects a missing source', async () => {
    expect(await rejectedCode(makeFs(seeded()).move('nope', 'x'))).toBe('NO_SUCH_PATH')
  })

  it('validates both paths against the workspace', async () => {
    const sftp = seeded()
    const fs = makeFs(sftp)
    expect(await rejectedCode(fs.move('../etc/passwd', 'stolen'))).toBe('OUTSIDE_WORKSPACE')
    expect(await rejectedCode(fs.move('m.txt', '/etc/x'))).toBe('OUTSIDE_WORKSPACE')
    expect(await rejectedCode(fs.move('m.txt', 'evil-dir/x'))).toBe('SYMLINK_ESCAPE')
    expect(sftp.fileContent('/ws/m.txt')).toBe('m-line1\nm-line2\n')
  })

  it('rejects moving a file through a source path that escapes', async () => {
    const sftp = seeded()
    expect(await rejectedCode(makeFs(sftp).move('evil-dir/passwd', 'copy'))).toBe('SYMLINK_ESCAPE')
  })
})

describe('RemoteFs.delete', () => {
  it('unlinks a file', async () => {
    const sftp = seeded()
    await makeFs(sftp).delete('m.txt')
    expect(sftp.has('/ws/m.txt')).toBe(false)
  })

  it('unlinks a symlink without touching its outside target', async () => {
    const sftp = seeded()
    await makeFs(sftp).delete('lnk')
    expect(sftp.has('/ws/lnk')).toBe(false)
    expect(sftp.fileContent('/etc/passwd')).toBe('root:x:0:0')
  })

  it('unlinks a dangling symlink', async () => {
    const sftp = seeded()
    await makeFs(sftp).delete('dangling')
    expect(sftp.has('/ws/dangling')).toBe(false)
  })

  it('refuses a directory without recursive:true', async () => {
    const sftp = seeded()
    const err = await rejectedError(makeFs(sftp).delete('b-dir'))
    expect(err.code).toBe('INVALID_INPUT')
    expect(err.message).toContain('recursive')
    expect(sftp.has('/ws/b-dir')).toBe(true)
  })

  it('recursively deletes a directory tree', async () => {
    const sftp = seeded().addDir('/ws/tree/sub').addFile('/ws/tree/a.txt', 'a').addFile('/ws/tree/sub/b.txt', 'b')
    await makeFs(sftp).delete('tree', { recursive: true })
    expect(sftp.has('/ws/tree')).toBe(false)
    expect(sftp.has('/ws/tree/sub')).toBe(false)
  })

  it('does not follow symlinks during recursive delete', async () => {
    const sftp = seeded().addDir('/ws/tree').addSymlink('/ws/tree/out', '/etc')
    await makeFs(sftp).delete('tree', { recursive: true })
    expect(sftp.has('/ws/tree')).toBe(false)
    // the outside target survives untouched
    expect(sftp.fileContent('/etc/passwd')).toBe('root:x:0:0')
    expect(sftp.kindOf('/etc')).toBe('dir')
  })

  it('rejects missing paths and escapes', async () => {
    const sftp = seeded()
    const fs = makeFs(sftp)
    expect(await rejectedCode(fs.delete('nope'))).toBe('NO_SUCH_PATH')
    expect(await rejectedCode(fs.delete('../etc/passwd'))).toBe('OUTSIDE_WORKSPACE')
    expect(await rejectedCode(fs.delete('evil-dir/passwd'))).toBe('SYMLINK_ESCAPE')
    expect(sftp.fileContent('/etc/passwd')).toBe('root:x:0:0')
  })
})

describe('RemoteFs.stat', () => {
  it('reports type, size and mtime for files and dirs', async () => {
    const fs = makeFs(seeded())
    const f = await fs.stat('z.txt')
    expect(f).toEqual({ type: 'file', size: 1, mtime: FAKE_MTIME + 3 })
    const d = await fs.stat('a-dir')
    expect(d.type).toBe('dir')
  })

  it('follows symlinks (stat semantics), rejecting escapes', async () => {
    const fs = makeFs(seeded())
    const viaLink = await fs.stat('inside-link')
    expect(viaLink.type).toBe('dir')
    expect(await rejectedCode(fs.stat('lnk'))).toBe('SYMLINK_ESCAPE')
  })

  it('rejects missing paths and outside paths', async () => {
    const fs = makeFs(seeded())
    expect(await rejectedCode(fs.stat('nope'))).toBe('NO_SUCH_PATH')
    expect(await rejectedCode(fs.stat('/etc/passwd'))).toBe('OUTSIDE_WORKSPACE')
  })
})

describe('RemoteFs with root "/"', () => {
  it('allows absolute paths anywhere', async () => {
    const sftp = new FakeSftp().addDir('/tmp').addFile('/tmp/x.txt', 'x')
    const fs = makeFs(sftp, '/')
    await expect(fs.read('/tmp/x.txt')).resolves.toMatchObject({ content: 'x' })
    await expect(fs.write('/var/log/new.txt', 'y')).resolves.toEqual({ bytes: 1 })
    expect(sftp.fileContent('/var/log/new.txt')).toBe('y')
  })
})
