// dsh-rw — remote file watcher. SFTP has no inotify-style change feed, so the
// only portable change source is polling: take a recursive snapshot of the
// tree, then rescan and diff it. The watcher owns no timer — the host decides
// the poll cadence and calls poll() — which keeps this module pure, testable,
// and free of lifecycle surprises. It consumes a one-method readdir interface
// instead of RemoteFs/ssh2 so the diff logic can be unit-tested without a
// network or a real filesystem.

/** Minimal directory listing the watcher needs (SFTP readdir). */
export interface WatchFs {
  /** Recursive-free: list ONE directory. Returns entries with type and mtime in ms. */
  readdir(path: string): Promise<{ name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }[]>
}

export interface WatchOptions {
  /** Root directory to watch (absolute remote path). */
  root: string
  /**
   * Optional single glob filter applied to the path relative to root, e.g.
   * "*.ts" or "src/**". A pattern with no "/" matches the basename at any
   * depth; a pattern with "/" is matched against the relative path. The exact
   * supported syntax is documented next to globToRegExp below.
   */
  include?: string
  /** Max entries to track (default 20000). Directories never count against it. */
  maxEntries?: number
  /** Max depth to descend (default 8); entries at depth maxDepth+1 are skipped. */
  maxDepth?: number
}

export type WatchChangeKind = 'added' | 'changed' | 'removed'

export interface WatchChange {
  /** Path RELATIVE to the watch root, using "/" separators. */
  path: string
  kind: WatchChangeKind
  /** Present for added/changed. */
  size?: number
  mtimeMs?: number
}

export interface WatchSnapshotResult {
  changes: WatchChange[]
  /** True when the tree exceeded maxEntries/maxDepth: the change list is incomplete. */
  truncated: boolean
  /** Number of tracked entries in this snapshot (matching files; directories are not tracked). */
  entries: number
}

/** What the watcher remembers about one tracked file. */
interface SnapshotEntry {
  size: number
  mtimeMs: number
}

/** One scan's result: the current snapshot plus whether limits cut it short. */
interface ScanResult {
  entries: Map<string, SnapshotEntry>
  truncated: boolean
}

const DEFAULT_MAX_ENTRIES = 20000
const DEFAULT_MAX_DEPTH = 8

const REGEX_META = new Set('\\^$.*+?()[]{}|'.split(''))

function literalChar(ch: string): string {
  return REGEX_META.has(ch) ? `\\${ch}` : ch
}

// Glob syntax supported by the `include` filter (deliberately tiny — one
// filter does not justify a dependency):
//   *   zero or more characters within a single path segment (never '/')
//   ?   exactly one character within a single path segment (never '/')
//   **  zero or more characters including '/', and when followed by a '/'
//       it also matches zero directories — so '**/*.ts' matches 'a.ts' as
//       well as 'src/a.ts'
// Everything else is literal: no character classes, braces, extglob or
// negation, and the pattern must match the whole string (not a substring).
// A pattern without '/' is applied to the basename by makeIncludeMatcher,
// matching the glob rule the plugin documents for the native glob tool: no
// slash = basename at any depth, slash = path relative to the root.
function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += literalChar(ch)
    }
  }
  return new RegExp(`${source}$`)
}

/**
 * Build the include predicate. Directories are always descended, so this only
 * ever sees the relative path of a file: filtering a directory would silently
 * hide everything below a non-matching ancestor (e.g. include "*.ts" must
 * still find "src/deep/a.ts").
 */
function makeIncludeMatcher(include: string): (relPath: string) => boolean {
  const re = globToRegExp(include)
  if (include.includes('/')) return (relPath) => re.test(relPath)
  return (relPath) => {
    const slash = relPath.lastIndexOf('/')
    return re.test(slash < 0 ? relPath : relPath.slice(slash + 1))
  }
}

/** Strip trailing slashes so children join as "${dir}/${name}" ('/' stays '/'). */
function normalizeWatchRoot(root: string): string {
  const trimmed = root.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

function joinWatchPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Clamp a user-supplied limit: missing or non-finite → default, negatives → 0. */
function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

/**
 * A named watcher: takes a snapshot on start, then diffs against the previous
 * snapshot on each poll. The class is deliberately passive (no interval, no
 * events): the host owns scheduling and can reuse one watcher across many
 * connections, while tests drive it step by step.
 */
export class Watcher {
  readonly root: string
  readonly include: string | undefined

  private readonly fs: WatchFs
  private readonly maxEntries: number
  private readonly maxDepth: number
  private readonly includeMatch: ((relPath: string) => boolean) | undefined
  private baseline: Map<string, SnapshotEntry> | undefined
  private baselineTruncated = false

  constructor(fs: WatchFs, options: WatchOptions) {
    this.fs = fs
    this.root = normalizeWatchRoot(options.root)
    this.include = options.include
    this.maxEntries = clampLimit(options.maxEntries, DEFAULT_MAX_ENTRIES)
    this.maxDepth = clampLimit(options.maxDepth, DEFAULT_MAX_DEPTH)
    this.includeMatch = options.include === undefined ? undefined : makeIncludeMatcher(options.include)
  }

  /** First snapshot; establishes the baseline. Returns entries counted (changes always empty). */
  async start(): Promise<WatchSnapshotResult> {
    const scan = await this.scan()
    this.baseline = scan.entries
    this.baselineTruncated = scan.truncated
    return { changes: [], truncated: scan.truncated, entries: scan.entries.size }
  }

  /** Re-scan and return the diff against the previous snapshot (also updates the baseline). */
  async poll(): Promise<WatchSnapshotResult> {
    const scan = await this.scan()
    const previous = this.baseline
    // "Either scan" matters: a baseline cut short by a limit may be missing
    // paths, so the next diff cannot be complete even if this scan was not.
    const truncated = scan.truncated || this.baselineTruncated
    this.baseline = scan.entries
    this.baselineTruncated = scan.truncated
    const changes = previous === undefined ? [] : diffSnapshots(previous, scan.entries)
    return { changes, truncated, entries: scan.entries.size }
  }

  /** Drop the baseline (next poll behaves like start). */
  reset(): void {
    this.baseline = undefined
    this.baselineTruncated = false
  }

  /**
   * Walk the tree depth-first with one readdir per directory. The root's
   * readdir error propagates to the caller (a broken workspace root must be
   * reported); any deeper error just prunes that subtree, because a permission
   * denied or a directory vanishing mid-walk is normal on a remote host and
   * must not kill the watcher.
   */
  private async scan(): Promise<ScanResult> {
    const entries = new Map<string, SnapshotEntry>()
    let truncated = false

    // `depth` is the depth of the directory being listed (root = 0); entries
    // found there sit at depth + 1, which is the depth used by maxDepth.
    const visit = async (dir: string, relDir: string, depth: number): Promise<boolean> => {
      let listing: Awaited<ReturnType<WatchFs['readdir']>>
      try {
        listing = await this.fs.readdir(dir)
      } catch (err) {
        if (depth === 0) throw err
        return true
      }
      // Sorting every listing makes both the snapshot and the first N entries
      // kept under maxEntries deterministic regardless of server order.
      const sorted = [...listing].sort((a, b) => compareStrings(a.name, b.name))
      for (const item of sorted) {
        const name = item.name
        // Servers may return '.'/'..' (SFTP readdir does); a name containing
        // '/' would not be a real child and must not produce a fake nested path.
        if (name === '' || name === '.' || name === '..' || name.includes('/')) continue
        const relPath = relDir === '' ? name : `${relDir}/${name}`
        if (item.kind === 'dir') {
          // Refusing to descend means deeper files may be missing from the
          // snapshot: flag it even if the directory happens to be empty,
          // because its contents cannot be known without another readdir.
          if (depth + 1 < this.maxDepth) {
            const keepGoing = await visit(joinWatchPath(dir, name), relPath, depth + 1)
            if (!keepGoing) return false
          } else {
            truncated = true
          }
        } else if (item.kind === 'file') {
          if (depth + 1 > this.maxDepth) {
            truncated = true
            continue
          }
          if (this.includeMatch !== undefined && !this.includeMatch(relPath)) continue
          // Stop as soon as one more file would exceed the cap; scanning the
          // rest of the tree could not add anything and only costs IO.
          if (entries.size >= this.maxEntries) {
            truncated = true
            return false
          }
          entries.set(relPath, { size: item.size, mtimeMs: item.mtimeMs })
        }
        // 'other' (symlinks, sockets, …) is deliberately ignored: following a
        // link could escape the tree or loop forever, and its target changes
        // are not this watcher's concern.
      }
      return true
    }

    await visit(this.root, '', 0)
    return { entries, truncated }
  }
}

/**
 * Diff two snapshots into a stable change list: additions and modifications
 * first (sorted by path), then removals (sorted by path). Keeping removals
 * last lets consumers apply "upsert then delete" without consulting kinds.
 */
function diffSnapshots(
  previous: ReadonlyMap<string, SnapshotEntry>,
  next: ReadonlyMap<string, SnapshotEntry>,
): WatchChange[] {
  const upserts: WatchChange[] = []
  for (const [path, entry] of next) {
    const before = previous.get(path)
    if (before === undefined) {
      upserts.push({ path, kind: 'added', size: entry.size, mtimeMs: entry.mtimeMs })
    } else if (before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) {
      upserts.push({ path, kind: 'changed', size: entry.size, mtimeMs: entry.mtimeMs })
    }
  }
  const removed: WatchChange[] = []
  for (const path of previous.keys()) {
    if (!next.has(path)) removed.push({ path, kind: 'removed' })
  }
  upserts.sort((a, b) => compareStrings(a.path, b.path))
  removed.sort((a, b) => compareStrings(a.path, b.path))
  return [...upserts, ...removed]
}

/**
 * Manages the named watchers of one plugin instance (start/poll/stop/list).
 * Names are user-facing strings; reusing one replaces the old watcher and its
 * baseline, while stop/dispose simply drop the state — poll-based watching
 * holds no OS resources that would need releasing.
 */
export class WatchManager {
  private readonly watchers = new Map<string, Watcher>()

  /** Start (or replace) a named watcher; the baseline is only installed once the scan succeeds. */
  async start(name: string, fs: WatchFs, options: WatchOptions): Promise<WatchSnapshotResult> {
    const watcher = new Watcher(fs, options)
    const snapshot = await watcher.start()
    this.watchers.set(name, watcher)
    return snapshot
  }

  /** Rescan one named watcher; an unknown name is a programming error, not a user-facing condition. */
  async poll(name: string): Promise<WatchSnapshotResult> {
    const watcher = this.watchers.get(name)
    if (watcher === undefined) throw new Error(`unknown watcher: ${name}`)
    return watcher.poll()
  }

  /** Drop a named watcher; true when it existed. */
  stop(name: string): boolean {
    return this.watchers.delete(name)
  }

  /** Snapshot of the registered watchers, in registration order. */
  list(): { name: string; root: string; include?: string }[] {
    return [...this.watchers].map(([name, watcher]) =>
      watcher.include === undefined
        ? { name, root: watcher.root }
        : { name, root: watcher.root, include: watcher.include },
    )
  }

  /** Stop everything (plugin teardown). Idempotent. */
  dispose(): void {
    this.watchers.clear()
  }
}
