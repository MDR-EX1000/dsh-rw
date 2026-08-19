// Shared in-memory SftpLike fake for the P3 tests (P4 tool tests reuse it).
//
// Model: a flat map of normalized absolute POSIX paths to file/dir/symlink
// nodes. Symlinks are resolved component-wise (relative targets resolve
// against the link's parent, chains up to 16 hops). Errors reject with
// ssh2-style `Object.assign(new Error(msg), { code })` — 2 = NO_SUCH_FILE,
// 4 = FAILURE — unwrapped, so callers exercise their own mapSftpError paths.
import { dirName, normalizeRemote } from '../src/guard.js'
import type { SftpLike } from '../src/ssh-pool.js'

export type FakeNode =
  | { kind: 'dir'; mtime: number }
  | { kind: 'file'; content: Buffer; mtime: number }
  | { kind: 'symlink'; target: string; mtime: number }

export interface FakeStat {
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
  mtime: number
}

export const FAKE_MTIME = 1_700_000_000

function sftpError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code })
}

const noSuch = (p: string): Error => sftpError(`No such file or directory: ${p}`, 2)
const failure = (msg: string): Error => sftpError(msg, 4)

function statOf(node: FakeNode): FakeStat {
  return {
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => node.kind === 'symlink',
    size: node.kind === 'file' ? node.content.length : 0,
    mtime: node.mtime,
  }
}

function errorCode(err: unknown): unknown {
  return err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
}

export class FakeSftp implements SftpLike {
  /** Public on purpose: tests may seed oddities (e.g. a '.' entry) directly. */
  readonly nodes = new Map<string, FakeNode>()

  constructor() {
    this.nodes.set('/', { kind: 'dir', mtime: FAKE_MTIME })
  }

  /** Fixture helper with `mkdir -p` semantics: missing ancestors are created too. */
  addDir(p: string, mtime = FAKE_MTIME): this {
    let cur = ''
    for (const seg of normalizeRemote(p).split('/').filter((s) => s !== '')) {
      cur = `${cur}/${seg}`
      if (!this.nodes.has(cur)) this.nodes.set(cur, { kind: 'dir', mtime })
    }
    return this
  }

  addFile(p: string, content: string | Buffer = '', mtime = FAKE_MTIME): this {
    this.nodes.set(normalizeRemote(p), {
      kind: 'file',
      content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      mtime,
    })
    return this
  }

  addSymlink(p: string, target: string, mtime = FAKE_MTIME): this {
    this.nodes.set(normalizeRemote(p), { kind: 'symlink', target, mtime })
    return this
  }

  // --- test inspection helpers ------------------------------------------------

  has(p: string): boolean {
    return this.nodes.has(normalizeRemote(p))
  }

  kindOf(p: string): FakeNode['kind'] | undefined {
    return this.nodes.get(normalizeRemote(p))?.kind
  }

  fileContent(p: string): string | undefined {
    const node = this.nodes.get(normalizeRemote(p))
    return node?.kind === 'file' ? node.content.toString('utf8') : undefined
  }

  // --- SftpLike ---------------------------------------------------------------

  async readdir(p: string): Promise<{ filename: string; longname: string; attrs: FakeStat }[]> {
    const dir = this.canonical(p)
    const node = this.nodes.get(dir)
    if (!node) throw noSuch(p)
    if (node.kind !== 'dir') throw failure(`Not a directory: ${p}`)
    const prefix = dir === '/' ? '/' : `${dir}/`
    const out: { filename: string; longname: string; attrs: FakeStat }[] = []
    for (const [path, child] of this.nodes) {
      if (!path.startsWith(prefix)) continue
      const name = path.slice(prefix.length)
      if (name === '' || name.includes('/')) continue
      const st = statOf(child)
      out.push({
        filename: name,
        longname: `${child.kind === 'dir' ? 'd' : child.kind === 'symlink' ? 'l' : '-'}rw-r--r-- 1 u g ${st.size} Jan  1  1970 ${name}`,
        attrs: st,
      })
    }
    return out
  }

  /** Follows symlinks (like SSH_FXP_STAT). */
  async stat(p: string): Promise<FakeStat> {
    const c = this.canonical(p)
    const node = this.nodes.get(c)
    if (!node) throw noSuch(p)
    return statOf(node)
  }

  /** Does not follow the final component (like SSH_FXP_LSTAT). */
  async lstat(p: string): Promise<FakeStat> {
    return statOf(this.lstatNode(p).node)
  }

  /** Canonicalizes; rejects code 2 when any component is missing. */
  async realpath(p: string): Promise<string> {
    return this.canonical(p)
  }

  async readFile(p: string): Promise<Buffer> {
    const c = this.canonical(p)
    const node = this.nodes.get(c)
    if (!node) throw noSuch(p)
    if (node.kind !== 'file') throw failure(`Is a directory: ${p}`)
    return Buffer.from(node.content)
  }

  /** Writes through an existing symlink; missing parents reject code 2. */
  async writeFile(p: string, data: Buffer): Promise<void> {
    const n = normalizeRemote(p)
    let full: string
    try {
      full = this.canonical(n)
      if (this.nodes.get(full)?.kind === 'dir') throw failure(`Is a directory: ${p}`)
    } catch (err) {
      if (errorCode(err) !== 2) throw err
      full = this.joinUnder(this.canonical(dirName(n)), n)
    }
    this.nodes.set(full, { kind: 'file', content: Buffer.from(data), mtime: FAKE_MTIME })
  }

  async mkdir(p: string): Promise<void> {
    const n = normalizeRemote(p)
    if (n === '/') throw failure('File exists: /')
    const parent = this.canonical(dirName(n))
    const full = this.joinUnder(parent, n)
    if (this.nodes.has(full)) throw failure(`File exists: ${p}`)
    this.nodes.set(full, { kind: 'dir', mtime: FAKE_MTIME })
  }

  /** POSIX-ish rename: moves the entry itself (a symlink moves as a link). */
  async rename(src: string, dst: string): Promise<void> {
    const s = this.lstatNode(src)
    const n = normalizeRemote(dst)
    const parent = this.canonical(dirName(n))
    const d = this.joinUnder(parent, n)
    if (d === s.path || d.startsWith(`${s.path}/`)) throw failure(`cannot move ${src} into itself`)
    const existing = this.nodes.get(d)
    if (existing && (existing.kind === 'dir' || s.node.kind === 'dir')) {
      throw failure(`rename ${src} -> ${dst}: invalid target`)
    }
    const moved: [string, FakeNode][] = []
    for (const [path, node] of this.nodes) {
      if (path === s.path || path.startsWith(`${s.path}/`)) moved.push([path, node])
    }
    for (const [path] of moved) this.nodes.delete(path)
    for (const [path, node] of moved) this.nodes.set(`${d}${path.slice(s.path.length)}`, node)
  }

  async unlink(p: string): Promise<void> {
    const { path, node } = this.lstatNode(p)
    if (node.kind === 'dir') throw failure(`Is a directory: ${p}`)
    this.nodes.delete(path)
  }

  async rmdir(p: string): Promise<void> {
    const { path, node } = this.lstatNode(p)
    if (node.kind !== 'dir') throw failure(`Not a directory: ${p}`)
    if (path === '/') throw failure('Device or resource busy')
    const prefix = `${path}/`
    for (const key of this.nodes.keys()) {
      if (key.startsWith(prefix)) throw failure(`Directory not empty: ${p}`)
    }
    this.nodes.delete(path)
  }

  // --- internals --------------------------------------------------------------

  private joinUnder(parent: string, p: string): string {
    const name = p.slice(p.lastIndexOf('/') + 1)
    return parent === '/' ? `/${name}` : `${parent}/${name}`
  }

  /**
   * Canonical absolute path with every symlink component (intermediate and
   * final) resolved. Rejects code 2 on the first missing component, code 4 on
   * link loops.
   */
  private canonical(p: string): string {
    let pending = normalizeRemote(p)
    for (let hops = 0; hops <= 16; hops++) {
      const segs = pending.split('/').filter((s) => s !== '')
      let cur = ''
      let restart: string | undefined
      for (let i = 0; i < segs.length; i++) {
        cur = `${cur}/${segs[i]!}`
        const node = this.nodes.get(cur)
        if (!node) throw noSuch(cur)
        if (node.kind === 'symlink') {
          const base = node.target.startsWith('/') ? node.target : `${dirName(cur)}/${node.target}`
          const rest = segs.slice(i + 1).join('/')
          restart = normalizeRemote(rest === '' ? base : `${base}/${rest}`)
          break
        }
      }
      if (restart === undefined) return cur === '' ? '/' : cur
      pending = restart
    }
    throw failure(`Too many levels of symbolic links: ${p}`)
  }

  /** Resolve p without following its last component (the parent chain is fully resolved). */
  private lstatNode(p: string): { path: string; node: FakeNode } {
    const n = normalizeRemote(p)
    if (n === '/') return { path: '/', node: this.nodes.get('/')! }
    const parent = this.canonical(dirName(n))
    const full = this.joinUnder(parent, n)
    const node = this.nodes.get(full)
    if (!node) throw noSuch(p)
    return { path: full, node }
  }
}
