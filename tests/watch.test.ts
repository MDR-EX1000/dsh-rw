import { describe, expect, it } from 'vitest'
import type { WatchFs } from '../src/watch.js'
import { Watcher, WatchManager } from '../src/watch.js'

const T0 = 1_700_000_000_000

type FakeKind = 'file' | 'dir' | 'other'

interface FakeEntry {
  name: string
  kind: FakeKind
  size: number
  mtimeMs: number
}

/**
 * In-memory WatchFs: a map from directory path to its raw listing. Tests mutate
 * it the way a remote host would between polls (add/update/remove), and the
 * optional failures model permission-denied / vanished directories.
 */
class FakeWatchFs implements WatchFs {
  readonly dirs = new Map<string, FakeEntry[]>()
  readonly calls: string[] = []
  private readonly failures = new Map<string, Error>()

  /** Create an (empty) directory listing. */
  addDir(path: string): this {
    const key = normalize(path)
    if (!this.dirs.has(key)) this.dirs.set(key, [])
    return this
  }

  /** Add a child directory plus its empty listing. */
  addSubdir(parent: string, name: string): this {
    this.listingOf(parent).push({ name, kind: 'dir', size: 0, mtimeMs: T0 })
    return this.addDir(join(parent, name))
  }

  addFile(parent: string, name: string, size = 1, mtimeMs = T0): this {
    this.listingOf(parent).push({ name, kind: 'file', size, mtimeMs })
    return this
  }

  addOther(parent: string, name: string): this {
    this.listingOf(parent).push({ name, kind: 'other', size: 0, mtimeMs: T0 })
    return this
  }

  update(parent: string, name: string, patch: { size?: number; mtimeMs?: number }): this {
    Object.assign(this.find(parent, name), patch)
    return this
  }

  remove(parent: string, name: string): this {
    const listing = this.listingOf(parent)
    const index = listing.findIndex((entry) => entry.name === name)
    if (index < 0) throw new Error(`no entry ${name} in ${parent}`)
    listing.splice(index, 1)
    return this
  }

  failOn(path: string, error: Error = Object.assign(new Error(`permission denied: ${path}`), { code: 3 })): this {
    this.failures.set(normalize(path), error)
    return this
  }

  async readdir(path: string): Promise<FakeEntry[]> {
    const key = normalize(path)
    this.calls.push(key)
    const failure = this.failures.get(key)
    if (failure !== undefined) throw failure
    const listing = this.dirs.get(key)
    if (listing === undefined) throw Object.assign(new Error(`no such directory: ${key}`), { code: 2 })
    // Return copies: a real readdir never aliases server state.
    return listing.map((entry) => ({ ...entry }))
  }

  private listingOf(parent: string): FakeEntry[] {
    const listing = this.dirs.get(normalize(parent))
    if (listing === undefined) throw new Error(`add the directory first: ${normalize(parent)}`)
    return listing
  }

  private find(parent: string, name: string): FakeEntry {
    const entry = this.listingOf(parent).find((candidate) => candidate.name === name)
    if (entry === undefined) throw new Error(`no entry ${name} in ${parent}`)
    return entry
  }
}

function normalize(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

function join(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/** Seed a fake with one or more (empty) directories. */
function tree(...dirs: string[]): FakeWatchFs {
  const fs = new FakeWatchFs()
  for (const dir of dirs) fs.addDir(dir)
  return fs
}

describe('Watcher.start', () => {
  it('establishes a baseline with no changes and counts files recursively', async () => {
    const fs = tree('/ws')
    fs.addFile('/ws', 'a.txt')
    fs.addSubdir('/ws', 'src')
    fs.addFile('/ws/src', 'b.ts')
    fs.addSubdir('/ws/src', 'deep')
    fs.addFile('/ws/src/deep', 'c.ts')
    const watcher = new Watcher(fs, { root: '/ws' })

    await expect(watcher.start()).resolves.toEqual({ changes: [], truncated: false, entries: 3 })
    // The baseline is complete, so an immediate poll has nothing to report.
    await expect(watcher.poll()).resolves.toEqual({ changes: [], truncated: false, entries: 3 })
  })

  it('normalizes a trailing slash on the root and lists every directory once', async () => {
    const fs = tree('/ws')
    fs.addSubdir('/ws', 'src')
    fs.addFile('/ws/src', 'a.ts')
    const watcher = new Watcher(fs, { root: '/ws/' })

    expect(watcher.root).toBe('/ws')
    expect((await watcher.start()).entries).toBe(1)
    expect(fs.calls).toEqual(['/ws', '/ws/src'])
  })

  it('ignores symlinks and other entry kinds without descending them', async () => {
    const fs = tree('/ws')
    fs.addFile('/ws', 'root.txt')
    fs.addSubdir('/ws', 'real')
    fs.addFile('/ws/real', 'inside.txt')
    fs.addOther('/ws', 'link')
    // Even if a listing exists behind the 'other' entry, it must never be read.
    fs.addDir('/ws/link')
    fs.addFile('/ws/link', 'hidden.txt')
    const watcher = new Watcher(fs, { root: '/ws' })

    expect((await watcher.start()).entries).toBe(2)
    expect(fs.calls).not.toContain('/ws/link')
  })

  it('handles "/" as the watch root', async () => {
    const fs = tree('/')
    fs.addFile('/', 'top.txt')
    fs.addSubdir('/', 'dir')
    fs.addFile('/dir', 'nested.txt')
    const watcher = new Watcher(fs, { root: '/' })

    expect(watcher.root).toBe('/')
    expect((await watcher.start()).entries).toBe(2)
    expect(fs.calls).toEqual(['/', '/dir'])
  })
})

describe('Watcher.poll', () => {
  it('reports a new file as added with its size and mtime', async () => {
    const fs = tree('/ws')
    const watcher = new Watcher(fs, { root: '/ws' })
    await watcher.start()

    fs.addFile('/ws', 'new.txt', 42, T0 + 10)
    await expect(watcher.poll()).resolves.toEqual({
      changes: [{ path: 'new.txt', kind: 'added', size: 42, mtimeMs: T0 + 10 }],
      truncated: false,
      entries: 1,
    })
  })

  it('reports a size change as changed', async () => {
    const fs = tree('/ws').addFile('/ws', 'a.txt', 1)
    const watcher = new Watcher(fs, { root: '/ws' })
    await watcher.start()

    fs.update('/ws', 'a.txt', { size: 9 })
    await expect(watcher.poll()).resolves.toMatchObject({
      changes: [{ path: 'a.txt', kind: 'changed', size: 9, mtimeMs: T0 }],
    })
  })

  it('reports an mtime-only change as changed', async () => {
    const fs = tree('/ws').addFile('/ws', 'a.txt', 5, T0)
    const watcher = new Watcher(fs, { root: '/ws' })
    await watcher.start()

    fs.update('/ws', 'a.txt', { mtimeMs: T0 + 1000 })
    await expect(watcher.poll()).resolves.toMatchObject({
      changes: [{ path: 'a.txt', kind: 'changed', size: 5, mtimeMs: T0 + 1000 }],
    })
  })

  it('reports nothing when size and mtime are unchanged', async () => {
    const fs = tree('/ws').addFile('/ws', 'a.txt').addFile('/ws', 'b.txt')
    const watcher = new Watcher(fs, { root: '/ws' })
    await watcher.start()

    await expect(watcher.poll()).resolves.toEqual({ changes: [], truncated: false, entries: 2 })
  })

  it('reports a removed file without size or mtime', async () => {
    const fs = tree('/ws').addFile('/ws', 'gone.txt', 3)
    const watcher = new Watcher(fs, { root: '/ws' })
    await watcher.start()

    fs.remove('/ws', 'gone.txt')
    const result = await watcher.poll()
    expect(result.changes).toEqual([{ path: 'gone.txt', kind: 'removed' }])
    expect(result.changes[0]).not.toHaveProperty('size')
    expect(result.changes[0]).not.toHaveProperty('mtimeMs')
    expect(result.entries).toBe(0)
  })

  it('sorts additions and changes by path, then removals by path', async () => {
    const fs = tree('/ws')
    fs.addFile('/ws', 'old1.txt')
    fs.addFile('/ws', 'old2.txt')
    fs.addFile('/ws', 'mod.txt')
    fs.addFile('/ws', 'keep.txt')
    const watcher = new Watcher(fs, { root: '/ws' })
    await watcher.start()

    fs.addFile('/ws', 'b.txt')
    fs.addFile('/ws', 'a.txt')
    fs.update('/ws', 'mod.txt', { size: 2 })
    fs.remove('/ws', 'old2.txt')
    fs.remove('/ws', 'old1.txt')
    const result = await watcher.poll()
    expect(result.changes.map((change) => `${change.kind}:${change.path}`)).toEqual([
      'added:a.txt',
      'added:b.txt',
      'changed:mod.txt',
      'removed:old1.txt',
      'removed:old2.txt',
    ])
  })

  it('reports nested paths relative to the root with "/" separators', async () => {
    const fs = tree('/ws')
    fs.addSubdir('/ws', 'src')
    fs.addSubdir('/ws/src', 'deep')
    const watcher = new Watcher(fs, { root: '/ws' })
    expect((await watcher.start()).entries).toBe(0)

    fs.addFile('/ws/src/deep', 'new.ts')
    await expect(watcher.poll()).resolves.toMatchObject({
      changes: [{ path: 'src/deep/new.ts', kind: 'added', size: 1, mtimeMs: T0 }],
    })
  })

  it('treats a poll before start as a baseline', async () => {
    const fs = tree('/ws').addFile('/ws', 'a.txt')
    const watcher = new Watcher(fs, { root: '/ws' })

    await expect(watcher.poll()).resolves.toEqual({ changes: [], truncated: false, entries: 1 })
    fs.addFile('/ws', 'b.txt')
    expect((await watcher.poll()).changes.map((change) => change.path)).toEqual(['b.txt'])
  })
})

describe('Watcher include filter', () => {
  it('filters by basename at any depth when the pattern has no "/"', async () => {
    const fs = tree('/ws').addFile('/ws', 'root.ts').addFile('/ws', 'skip.js')
    fs.addSubdir('/ws', 'src')
    fs.addFile('/ws/src', 'nested.ts')
    fs.addFile('/ws/src', 'nested.js')
    const watcher = new Watcher(fs, { root: '/ws', include: '*.ts' })

    expect((await watcher.start()).entries).toBe(2) // root.ts, src/nested.ts
    fs.addFile('/ws/src', 'new.ts')
    fs.addFile('/ws/src', 'new.js')
    expect((await watcher.poll()).changes.map((change) => change.path)).toEqual(['src/new.ts'])
  })

  it('matches the path relative to the root when the pattern contains "/"', async () => {
    const fs = tree('/ws')
    fs.addSubdir('/ws', 'src')
    fs.addSubdir('/ws/src', 'deep')
    fs.addSubdir('/ws', 'other')
    fs.addFile('/ws/src', 'a.ts')
    fs.addFile('/ws/src/deep', 'b.ts')
    fs.addFile('/ws/other', 'c.ts')
    const watcher = new Watcher(fs, { root: '/ws', include: 'src/**' })

    expect((await watcher.start()).entries).toBe(2)
    fs.addFile('/ws/src', 'new.ts')
    fs.addFile('/ws/other', 'new.ts')
    expect((await watcher.poll()).changes.map((change) => change.path)).toEqual(['src/new.ts'])
  })

  it('lets "**/" match zero directories so root files are included', async () => {
    const fs = tree('/ws').addFile('/ws', 'top.ts').addFile('/ws', 'top.js')
    fs.addSubdir('/ws', 'src')
    fs.addFile('/ws/src', 'inner.ts')
    const watcher = new Watcher(fs, { root: '/ws', include: '**/*.ts' })

    expect((await watcher.start()).entries).toBe(2)
    fs.addFile('/ws', 'another.ts')
    expect((await watcher.poll()).changes.map((change) => change.path)).toEqual(['another.ts'])
  })

  it('keeps "*" inside one path segment', async () => {
    const fs = tree('/ws')
    fs.addSubdir('/ws', 'src')
    fs.addSubdir('/ws/src', 'deep')
    fs.addFile('/ws/src', 'a.ts')
    fs.addFile('/ws/src/deep', 'b.ts')
    const watcher = new Watcher(fs, { root: '/ws', include: 'src/*.ts' })

    expect((await watcher.start()).entries).toBe(1)
  })

  it('ignores changes to files the filter excludes', async () => {
    const fs = tree('/ws').addFile('/ws', 'a.ts', 1).addFile('/ws', 'b.js', 1)
    const watcher = new Watcher(fs, { root: '/ws', include: '*.ts' })
    await watcher.start()

    fs.update('/ws', 'b.js', { size: 99 })
    fs.remove('/ws', 'b.js')
    await expect(watcher.poll()).resolves.toEqual({ changes: [], truncated: false, entries: 1 })
  })
})

describe('Watcher limits', () => {
  it('truncates when more files exist than maxEntries', async () => {
    const fs = tree('/ws')
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) fs.addFile('/ws', name)
    const watcher = new Watcher(fs, { root: '/ws', maxEntries: 2 })

    const result = await watcher.start()
    expect(result.entries).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('does not truncate when the tree holds exactly maxEntries files', async () => {
    const fs = tree('/ws').addFile('/ws', 'a.txt').addFile('/ws', 'b.txt')
    const watcher = new Watcher(fs, { root: '/ws', maxEntries: 2 })

    await expect(watcher.start()).resolves.toEqual({ changes: [], truncated: false, entries: 2 })
  })

  it('honours maxDepth and flags skipped deeper entries', async () => {
    const fs = tree('/ws').addFile('/ws', 'root.txt')
    fs.addSubdir('/ws', 'src')
    fs.addFile('/ws/src', 'a.txt')
    fs.addSubdir('/ws/src', 'deep')
    fs.addFile('/ws/src/deep', 'b.txt')

    const shallow = new Watcher(fs, { root: '/ws', maxDepth: 1 })
    expect(await shallow.start()).toMatchObject({ entries: 1, truncated: true }) // only root.txt
    const two = new Watcher(fs, { root: '/ws', maxDepth: 2 })
    expect(await two.start()).toMatchObject({ entries: 2, truncated: true }) // src/deep not read
    const three = new Watcher(fs, { root: '/ws', maxDepth: 3 })
    expect(await three.start()).toMatchObject({ entries: 3, truncated: false })
  })

  it('reports truncation when a growing tree first exceeds maxEntries during a poll', async () => {
    const fs = tree('/ws').addFile('/ws', 'a.txt').addFile('/ws', 'b.txt')
    const watcher = new Watcher(fs, { root: '/ws', maxEntries: 2 })
    expect(await watcher.start()).toMatchObject({ entries: 2, truncated: false })

    fs.addFile('/ws', 'c.txt')
    expect(await watcher.poll()).toMatchObject({ entries: 2, truncated: true })
  })

  it('keeps reporting truncation from a baseline that hit maxEntries', async () => {
    const fs = tree('/ws')
    for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.addFile('/ws', name)
    const watcher = new Watcher(fs, { root: '/ws', maxEntries: 2 })
    await watcher.start() // baseline tracked a.txt + b.txt, truncated before c.txt

    fs.remove('/ws', 'b.txt') // a.txt + c.txt remain: this scan fits the cap
    const result = await watcher.poll()
    expect(result).toMatchObject({ entries: 2, truncated: true })
    // c.txt was never in the truncated baseline, so it looks newly added — the
    // reason a truncated diff must never be consumed as a complete one.
    expect(result.changes).toEqual([
      { path: 'c.txt', kind: 'added', size: 1, mtimeMs: T0 },
      { path: 'b.txt', kind: 'removed' },
    ])
  })
})

describe('Watcher.reset', () => {
  it('drops the baseline so the next poll is a fresh baseline', async () => {
    const fs = tree('/ws').addFile('/ws', 'a.txt')
    const watcher = new Watcher(fs, { root: '/ws' })
    await watcher.start()

    fs.addFile('/ws', 'b.txt')
    watcher.reset()
    await expect(watcher.poll()).resolves.toEqual({ changes: [], truncated: false, entries: 2 })
    fs.addFile('/ws', 'c.txt')
    expect((await watcher.poll()).changes.map((change) => change.path)).toEqual(['c.txt'])
  })

  it('clears a truncated baseline', async () => {
    const fs = tree('/ws')
    for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.addFile('/ws', name)
    const watcher = new Watcher(fs, { root: '/ws', maxEntries: 2 })
    await watcher.start()
    fs.remove('/ws', 'c.txt')

    watcher.reset()
    await expect(watcher.poll()).resolves.toEqual({ changes: [], truncated: false, entries: 2 })
  })
})

describe('Watcher errors', () => {
  it('skips a failing subdirectory and still scans its siblings', async () => {
    const fs = tree('/ws').addFile('/ws', 'root.txt')
    fs.addSubdir('/ws', 'bad')
    fs.addFile('/ws/bad', 'hidden.txt')
    fs.addSubdir('/ws', 'good')
    fs.addFile('/ws/good', 'a.txt')
    fs.failOn('/ws/bad')
    const watcher = new Watcher(fs, { root: '/ws' })

    await expect(watcher.start()).resolves.toEqual({ changes: [], truncated: false, entries: 2 })
    fs.addFile('/ws/good', 'b.txt')
    expect((await watcher.poll()).changes.map((change) => change.path)).toEqual(['good/b.txt'])
  })

  it('propagates a root readdir failure', async () => {
    const fs = tree('/ws')
    const error = new Error('permission denied: /ws')
    fs.failOn('/ws', error)
    const watcher = new Watcher(fs, { root: '/ws' })

    await expect(watcher.start()).rejects.toBe(error)
    await expect(watcher.poll()).rejects.toBe(error)
  })
})

describe('Watcher properties', () => {
  it('exposes the normalized root and the include pattern', () => {
    const fs = tree('/ws')
    expect(new Watcher(fs, { root: '/ws' }).include).toBeUndefined()
    const filtered = new Watcher(fs, { root: '/ws', include: '*.ts' })
    expect(filtered.root).toBe('/ws')
    expect(filtered.include).toBe('*.ts')
  })
})

describe('WatchManager', () => {
  it('registers named watchers and lists their settings', async () => {
    const manager = new WatchManager()
    await manager.start('docs', tree('/one').addFile('/one', 'a.txt'), { root: '/one' })
    await manager.start('code', tree('/two'), { root: '/two', include: '*.ts' })

    expect(manager.list()).toEqual([
      { name: 'docs', root: '/one' },
      { name: 'code', root: '/two', include: '*.ts' },
    ])
  })

  it('polls a named watcher and rejects unknown names', async () => {
    const manager = new WatchManager()
    const fs = tree('/ws')
    await manager.start('w', fs, { root: '/ws' })

    fs.addFile('/ws', 'a.txt')
    await expect(manager.poll('w')).resolves.toEqual({
      changes: [{ path: 'a.txt', kind: 'added', size: 1, mtimeMs: T0 }],
      truncated: false,
      entries: 1,
    })
    await expect(manager.poll('missing')).rejects.toThrow('unknown watcher: missing')
  })

  it('stops a watcher and reports whether it existed', async () => {
    const manager = new WatchManager()
    await manager.start('w', tree('/ws'), { root: '/ws' })

    expect(manager.stop('w')).toBe(true)
    expect(manager.stop('w')).toBe(false)
    expect(manager.list()).toEqual([])
    await expect(manager.poll('w')).rejects.toThrow('unknown watcher: w')
  })

  it('replaces a watcher started under an existing name', async () => {
    const manager = new WatchManager()
    const fs = tree('/ws')
    await manager.start('w', fs, { root: '/ws' })
    fs.addFile('/ws', 'a.txt')

    // The new start re-baselines, so the file added in between is not a change.
    expect((await manager.start('w', fs, { root: '/ws' })).entries).toBe(1)
    expect(manager.list()).toHaveLength(1)
    await expect(manager.poll('w')).resolves.toEqual({ changes: [], truncated: false, entries: 1 })
  })

  it('disposes every watcher', async () => {
    const manager = new WatchManager()
    await manager.start('a', tree('/a'), { root: '/a' })
    await manager.start('b', tree('/b'), { root: '/b' })

    manager.dispose()
    expect(manager.list()).toEqual([])
    await expect(manager.poll('a')).rejects.toThrow('unknown watcher: a')
    expect(manager.stop('b')).toBe(false)
    expect(() => manager.dispose()).not.toThrow()
  })
})
