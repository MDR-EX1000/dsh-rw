// dsh-rw — workspace path guard. The workspace root is the security boundary:
// every remote path the agent touches is first confined lexically
// (resolveInWorkspace) and then proven to stay inside through symlinks
// (realpath-based checks). Paths are never secret, so they may appear in
// error messages; credentials obviously never do.
import { mapSftpError, RwError } from './errors.js'
import type { SftpLike } from './ssh-pool.js'

/**
 * Collapse '', '.', '..' and duplicate slashes into a clean absolute POSIX
 * path. '..' past the root clamps at the root (path.posix.normalize
 * semantics); relative input is treated as rooted at '/'.
 */
export function normalizeRemote(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return `/${parts.join('/')}`
}

/** Last path segment ('/' → 'workspace'; '/a/b/' → 'b'). */
export function baseName(p: string): string {
  const n = normalizeRemote(p)
  return n === '/' ? 'workspace' : n.slice(n.lastIndexOf('/') + 1)
}

/** Parent directory ('/' → '/'; '/a' → '/'). */
export function dirName(p: string): string {
  const n = normalizeRemote(p)
  const i = n.lastIndexOf('/')
  return i <= 0 ? '/' : n.slice(0, i)
}

/**
 * Expand a leading `~` (the remote user's home) to an absolute path. SFTP is
 * not a shell and does no tilde expansion, so it must be done explicitly:
 * the home directory is realpath('.') — the canonical start directory of an
 * SFTP session. `~` and `~/…` expand; anything else passes through unchanged.
 */
export async function expandRemoteHome(sftp: SftpLike, p: string): Promise<string> {
  if (p !== '~' && !p.startsWith('~/')) return p
  let home: string
  try {
    home = normalizeRemote(await sftp.realpath('.'))
  } catch (err) {
    throw mapSftpError(err, '.')
  }
  return p === '~' ? home : normalizeRemote(home + p.slice(1))
}

/** Single-quote shell escaping: a'b → 'a'\''b' */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** p is inside root when it equals root or sits under it; root '/' contains everything. */
function inside(root: string, p: string): boolean {
  return root === '/' || p === root || p.startsWith(`${root}/`)
}

/**
 * Resolve user input to an absolute path inside the workspace.
 * - empty input → the root itself
 * - relative input → joined under root
 * - absolute input → must equal root or sit inside it
 * Throws RwError('OUTSIDE_WORKSPACE') otherwise.
 */
export function resolveInWorkspace(root: string, input: string | undefined | null): string {
  const r = normalizeRemote(root)
  const raw = input ?? ''
  const resolved = raw === '' ? r : raw.startsWith('/') ? normalizeRemote(raw) : normalizeRemote(`${r}/${raw}`)
  if (inside(r, resolved)) return resolved
  throw new RwError('OUTSIDE_WORKSPACE', `path escapes workspace ${r}: ${JSON.stringify(raw)}`)
}

/**
 * Symlink-escape check for read-class operations (the target must exist):
 * realpath(p) must stay inside root, else RwError('SYMLINK_ESCAPE').
 * A failing realpath (missing path) is wrapped via mapSftpError(err, p).
 * Returns the resolved real path.
 */
export async function assertRealpathInside(sftp: SftpLike, root: string, p: string): Promise<string> {
  const r = normalizeRemote(root)
  let real: string
  try {
    real = normalizeRemote(await sftp.realpath(p))
  } catch (err) {
    throw mapSftpError(err, p)
  }
  if (inside(r, real)) return real
  throw new RwError('SYMLINK_ESCAPE', `symlink escape: ${p} resolves to ${real}, outside workspace ${r}`)
}

/**
 * Symlink-escape check for write-class operations, where the target itself
 * may not exist yet: walk up from dirName(p) to the nearest ancestor whose
 * realpath succeeds and require it to stay inside root. Because p is already
 * lexically inside root and root always exists, the walk succeeds at root at
 * the latest; running out of in-root ancestors means the workspace root
 * itself is missing remotely → RwError('NO_SUCH_PATH').
 */
export async function assertWritableInside(sftp: SftpLike, root: string, p: string): Promise<void> {
  const r = normalizeRemote(root)
  let cur = dirName(p)
  for (;;) {
    if (!inside(r, cur)) {
      throw new RwError(
        'NO_SUCH_PATH',
        `no existing ancestor of ${p} inside workspace ${r} (does the workspace root exist?)`,
      )
    }
    let real: string
    try {
      real = normalizeRemote(await sftp.realpath(cur))
    } catch (err) {
      const mapped = mapSftpError(err, cur)
      if (mapped.code !== 'NO_SUCH_PATH') throw mapped
      cur = dirName(cur)
      continue
    }
    if (!inside(r, real)) {
      throw new RwError('SYMLINK_ESCAPE', `symlink escape: ${cur} resolves to ${real}, outside workspace ${r}`)
    }
    return
  }
}
