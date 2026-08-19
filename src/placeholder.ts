// dsh-rw — local placeholder directories. DSH's native workspace flow needs a
// real local directory (fs.realpath must succeed), so each (alias, remotePath)
// pair gets an empty placeholder holding only a meta file — never a copy of
// remote files. The meta file carries no credentials, but is still written
// 0600 inside a 0700 directory like every other dsh-rw state file.
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

/**
 * Deterministic placeholder path:
 * <baseDir>/<sanitize(alias)>/<base>-<sha1(normalized remotePath)[:8]>
 * so the same alias+path always maps to the same directory and distinct
 * paths (even with equal basenames) never collide.
 */
export function placeholderDirFor(alias: string, remotePath: string, baseDir?: string): string {
  const normalized = normalizeRemote(remotePath)
  const hash = createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 8)
  return join(baseDir ?? defaultBaseDir(), sanitize(alias), `${baseName(normalized)}-${hash}`)
}

/**
 * Create the placeholder directory plus its meta file (0600, dir 0700).
 * Idempotent: when the existing meta is consistent nothing is rewritten; an
 * inconsistent meta is rewritten but keeps the original createdAt.
 * Returns the placeholder directory.
 */
export function ensurePlaceholder(
  alias: string,
  entry: { host: string; port: number; user: string },
  remotePath: string,
  baseDir?: string,
): string {
  const dir = placeholderDirFor(alias, remotePath, baseDir)
  const remote = normalizeRemote(remotePath)
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
