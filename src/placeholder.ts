// dsh-rw — local placeholder directories. DSH's native workspace flow needs a
// real local directory (fs.realpath must succeed), so each (alias, remotePath)
// pair gets an empty placeholder holding only a meta file — never a copy of
// remote files. The meta file carries no credentials, but is still written
// 0600 inside a 0700 directory like every other dsh-rw state file.
//
// Naming: the placeholder takes a CLEAN name — the remote path's basename, or
// the display name the user gave in the picker — sanitized to a safe directory
// name. The sha1 suffix appears ONLY on collision: when the candidate
// directory already exists and does not provably belong to this workspace
// (another workspace's meta, or an unreadable one), the name becomes
// `<name>-<sha1(normalized remotePath)[:8]>`. Because names are no longer
// computable from (alias, remotePath), lookup works by scanning meta files
// (resolvePlaceholderDir) — which keeps legacy hash-suffixed directories from
// v0.1/v0.2 working unchanged: their meta still records the remotePath.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { baseName, normalizeRemote } from './guard.js'

export const PLACEHOLDER_META_FILE = '.dsh-rw-meta.json'

const PLACEHOLDER_NOTE = 'placeholder only — not a copy of remote files' as const

export interface PlaceholderMeta {
  plugin: 'dsh-rw'
  alias: string
  host: string
  port: number
  user: string
  remotePath: string
  createdAt: string // ISO
  note: typeof PLACEHOLDER_NOTE
}

/** Anything outside [a-zA-Z0-9._-] becomes '_'. */
function sanitize(alias: string): string {
  return alias.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function defaultBaseDir(): string {
  return join(homedir(), '.dsh', 'remote-workspaces')
}

/** sha1(normalized remotePath)[:8] — the collision suffix (also the v0.1/v0.2 directory naming). */
function pathHash(normalized: string): string {
  return createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 8)
}

/**
 * Locate the placeholder of (alias, remotePath) by scanning the alias's
 * placeholder directories and matching their meta files (exact alias +
 * normalized remotePath). Names are no longer computable — clean basenames,
 * user display names, and legacy hash suffixes coexist — so this is the ONLY
 * correct lookup. Null when nothing matches (workspace never picked, or the
 * meta is lost/corrupt).
 */
export function resolvePlaceholderDir(alias: string, remotePath: string, baseDir?: string): string | null {
  const normalized = normalizeRemote(remotePath)
  const parent = join(baseDir ?? defaultBaseDir(), sanitize(alias))
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return null
  }
  for (const name of names) {
    const dir = join(parent, name)
    const meta = readPlaceholderMeta(dir)
    if (meta !== null && meta.alias === alias && meta.remotePath === normalized) return dir
  }
  return null
}

/**
 * The directory name for a fresh placeholder: displayName (trimmed) or the
 * remote basename, sanitized; the sha1 suffix appears only when the candidate
 * is already occupied by something that is not provably this workspace.
 */
function freshPlaceholderDir(alias: string, normalized: string, baseDir: string | undefined, displayName?: string): string {
  const parent = join(baseDir ?? defaultBaseDir(), sanitize(alias))
  const clean = sanitize(displayName?.trim() || baseName(normalized))
  const dir = join(parent, clean)
  if (!existsSync(dir)) return dir
  return join(parent, `${clean}-${pathHash(normalized)}`)
}

/**
 * Create the placeholder directory plus its meta file (0600, dir 0700).
 * Idempotent: an existing placeholder for the same (alias, remotePath) — found
 * via resolvePlaceholderDir — is kept as-is when its meta is consistent; an
 * inconsistent meta is rewritten but keeps the original createdAt.
 * displayName (picker-only) names a fresh placeholder; omitting it uses the
 * remote basename. Returns the placeholder directory.
 */
export function ensurePlaceholder(
  alias: string,
  entry: { host: string; port: number; user: string },
  remotePath: string,
  baseDir?: string,
  displayName?: string,
): string {
  const remote = normalizeRemote(remotePath)
  const dir = resolvePlaceholderDir(alias, remote, baseDir) ?? freshPlaceholderDir(alias, remote, baseDir, displayName)
  const existing = readPlaceholderMeta(dir)
  const consistent =
    existing !== null &&
    existing.alias === alias &&
    existing.host === entry.host &&
    existing.port === entry.port &&
    existing.user === entry.user &&
    existing.remotePath === remote
  if (consistent) return dir

  const meta: PlaceholderMeta = {
    plugin: 'dsh-rw',
    alias,
    host: entry.host,
    port: entry.port,
    user: entry.user,
    remotePath: remote,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    note: PLACEHOLDER_NOTE,
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, PLACEHOLDER_META_FILE)
  writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return dir
}

/** Read and validate the meta file; null when missing or corrupt. */
export function readPlaceholderMeta(dir: string): PlaceholderMeta | null {
  let raw: string
  try {
    raw = readFileSync(join(dir, PLACEHOLDER_META_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    const data = JSON.parse(raw) as Record<string, unknown>
    if (
      data?.plugin !== 'dsh-rw' ||
      typeof data.alias !== 'string' ||
      typeof data.host !== 'string' ||
      typeof data.port !== 'number' ||
      typeof data.user !== 'string' ||
      typeof data.remotePath !== 'string' ||
      typeof data.createdAt !== 'string' ||
      data.note !== PLACEHOLDER_NOTE
    ) {
      return null
    }
    return data as unknown as PlaceholderMeta
  } catch {
    return null
  }
}

/** True when `p` (already resolve()d) is `root` or inside it (path-platform-aware). */
function inside(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}${sep}`)
}

/**
 * Find the placeholder whose directory contains `cwd`, by scanning every
 * placeholder directory under the base dir and matching its meta. Containment
 * is checked both lexically (resolve()) and via realpath (macOS /var ↔
 * /private/var), mirroring the shim's insideLocal. Returns the placeholder dir
 * and its meta, or null when the cwd is not inside any dsh-rw placeholder —
 * i.e. the agent is working in a real local directory, where native tools
 * should run locally. This is the reverse of resolvePlaceholderDir: names are
 * not computable from (alias, remotePath), so lookup is by scan.
 */
export function findPlaceholderByPath(cwd: string, baseDir?: string): { dir: string; meta: PlaceholderMeta } | null {
  const root = baseDir ?? defaultBaseDir()
  let aliasDirNames: string[]
  try {
    aliasDirNames = readdirSync(root)
  } catch {
    return null
  }
  const candLex = resolve(cwd)
  let candReal: string | null = null
  try {
    const real = realpathSync(cwd)
    if (real !== candLex) candReal = real
  } catch {
    // cwd may not exist (e.g. a probe path) — lexical containment still applies
  }
  for (const aliasName of aliasDirNames) {
    const aliasParent = join(root, aliasName)
    let placeholderNames: string[]
    try {
      placeholderNames = readdirSync(aliasParent)
    } catch {
      continue
    }
    for (const name of placeholderNames) {
      const dir = join(aliasParent, name)
      const meta = readPlaceholderMeta(dir)
      if (meta === null) continue
      const dirRoots: string[] = [resolve(dir)]
      try {
        const real = realpathSync(dir)
        if (!dirRoots.includes(real)) dirRoots.push(real)
      } catch {
        // placeholder missing on disk: lexical containment still applies
      }
      const hit = dirRoots.some((r) => inside(candLex, r) || (candReal !== null && inside(candReal, r)))
      if (hit) return { dir, meta }
    }
  }
  return null
}
