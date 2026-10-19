// dsh-rw — remote file watcher. SFTP has no inotify-style change feed, so the
// only portable change source is polling: take a recursive snapshot of the
// tree, then rescan and diff it. The watcher owns no timer — the host decides
// the poll cadence and calls poll() — which keeps this module pure, testable,
// and free of lifecycle surprises. It consumes a one-method readdir interface
// instead of RemoteFs/ssh2 so the diff logic can be unit-tested without a
// network or a real filesystem.
const DEFAULT_MAX_ENTRIES = 20000;
const DEFAULT_MAX_DEPTH = 8;
const REGEX_META = new Set('\\^$.*+?()[]{}|'.split(''));
function literalChar(ch) {
    return REGEX_META.has(ch) ? `\\${ch}` : ch;
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
function globToRegExp(pattern) {
    let source = '^';
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                i += 1;
                if (pattern[i + 1] === '/') {
                    i += 1;
                    source += '(?:.*/)?';
                }
                else {
                    source += '.*';
                }
            }
            else {
                source += '[^/]*';
            }
        }
        else if (ch === '?') {
            source += '[^/]';
        }
        else {
            source += literalChar(ch);
        }
    }
    return new RegExp(`${source}$`);
}
/**
 * Build the include predicate. Directories are always descended, so this only
 * ever sees the relative path of a file: filtering a directory would silently
 * hide everything below a non-matching ancestor (e.g. include "*.ts" must
 * still find "src/deep/a.ts").
 */
function makeIncludeMatcher(include) {
    const re = globToRegExp(include);
    if (include.includes('/'))
        return (relPath) => re.test(relPath);
    return (relPath) => {
        const slash = relPath.lastIndexOf('/');
        return re.test(slash < 0 ? relPath : relPath.slice(slash + 1));
    };
}
/** Strip trailing slashes so children join as "${dir}/${name}" ('/' stays '/'). */
function normalizeWatchRoot(root) {
    const trimmed = root.replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed;
}
function joinWatchPath(dir, name) {
    return dir === '/' ? `/${name}` : `${dir}/${name}`;
}
function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/** Clamp a user-supplied limit: missing or non-finite → default, negatives → 0. */
function clampLimit(value, fallback) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.max(0, Math.floor(value));
}
/**
 * A named watcher: takes a snapshot on start, then diffs against the previous
 * snapshot on each poll. The class is deliberately passive (no interval, no
 * events): the host owns scheduling and can reuse one watcher across many
 * connections, while tests drive it step by step.
 */
export class Watcher {
    root;
    include;
    fs;
    maxEntries;
    maxDepth;
    includeMatch;
    baseline;
    baselineTruncated = false;
    constructor(fs, options) {
        this.fs = fs;
        this.root = normalizeWatchRoot(options.root);
        this.include = options.include;
        this.maxEntries = clampLimit(options.maxEntries, DEFAULT_MAX_ENTRIES);
        this.maxDepth = clampLimit(options.maxDepth, DEFAULT_MAX_DEPTH);
        this.includeMatch = options.include === undefined ? undefined : makeIncludeMatcher(options.include);
    }
    /** First snapshot; establishes the baseline. Returns entries counted (changes always empty). */
    async start() {
        const scan = await this.scan();
        this.baseline = scan.entries;
        this.baselineTruncated = scan.truncated;
        return { changes: [], truncated: scan.truncated, entries: scan.entries.size };
    }
    /** Re-scan and return the diff against the previous snapshot (also updates the baseline). */
    async poll() {
        const scan = await this.scan();
        const previous = this.baseline;
        // "Either scan" matters: a baseline cut short by a limit may be missing
        // paths, so the next diff cannot be complete even if this scan was not.
        const truncated = scan.truncated || this.baselineTruncated;
        this.baseline = scan.entries;
        this.baselineTruncated = scan.truncated;
        const changes = previous === undefined ? [] : diffSnapshots(previous, scan.entries);
        return { changes, truncated, entries: scan.entries.size };
    }
    /** Drop the baseline (next poll behaves like start). */
    reset() {
        this.baseline = undefined;
        this.baselineTruncated = false;
    }
    /**
     * Walk the tree depth-first with one readdir per directory. The root's
     * readdir error propagates to the caller (a broken workspace root must be
     * reported); any deeper error just prunes that subtree, because a permission
     * denied or a directory vanishing mid-walk is normal on a remote host and
     * must not kill the watcher.
     */
    async scan() {
        const entries = new Map();
        let truncated = false;
        // `depth` is the depth of the directory being listed (root = 0); entries
        // found there sit at depth + 1, which is the depth used by maxDepth.
        const visit = async (dir, relDir, depth) => {
            let listing;
            try {
                listing = await this.fs.readdir(dir);
            }
            catch (err) {
                if (depth === 0)
                    throw err;
                return true;
            }
            // Sorting every listing makes both the snapshot and the first N entries
            // kept under maxEntries deterministic regardless of server order.
            const sorted = [...listing].sort((a, b) => compareStrings(a.name, b.name));
            for (const item of sorted) {
                const name = item.name;
                // Servers may return '.'/'..' (SFTP readdir does); a name containing
                // '/' would not be a real child and must not produce a fake nested path.
                if (name === '' || name === '.' || name === '..' || name.includes('/'))
                    continue;
                const relPath = relDir === '' ? name : `${relDir}/${name}`;
                if (item.kind === 'dir') {
                    // Refusing to descend means deeper files may be missing from the
                    // snapshot: flag it even if the directory happens to be empty,
                    // because its contents cannot be known without another readdir.
                    if (depth + 1 < this.maxDepth) {
                        const keepGoing = await visit(joinWatchPath(dir, name), relPath, depth + 1);
                        if (!keepGoing)
                            return false;
                    }
                    else {
                        truncated = true;
                    }
                }
                else if (item.kind === 'file') {
                    if (depth + 1 > this.maxDepth) {
                        truncated = true;
                        continue;
                    }
                    if (this.includeMatch !== undefined && !this.includeMatch(relPath))
                        continue;
                    // Stop as soon as one more file would exceed the cap; scanning the
                    // rest of the tree could not add anything and only costs IO.
                    if (entries.size >= this.maxEntries) {
                        truncated = true;
                        return false;
                    }
                    entries.set(relPath, { size: item.size, mtimeMs: item.mtimeMs });
                }
                // 'other' (symlinks, sockets, …) is deliberately ignored: following a
                // link could escape the tree or loop forever, and its target changes
                // are not this watcher's concern.
            }
            return true;
        };
        await visit(this.root, '', 0);
        return { entries, truncated };
    }
}
/**
 * Diff two snapshots into a stable change list: additions and modifications
 * first (sorted by path), then removals (sorted by path). Keeping removals
 * last lets consumers apply "upsert then delete" without consulting kinds.
 */
function diffSnapshots(previous, next) {
    const upserts = [];
    for (const [path, entry] of next) {
        const before = previous.get(path);
        if (before === undefined) {
            upserts.push({ path, kind: 'added', size: entry.size, mtimeMs: entry.mtimeMs });
        }
        else if (before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) {
            upserts.push({ path, kind: 'changed', size: entry.size, mtimeMs: entry.mtimeMs });
        }
    }
    const removed = [];
    for (const path of previous.keys()) {
        if (!next.has(path))
            removed.push({ path, kind: 'removed' });
    }
    upserts.sort((a, b) => compareStrings(a.path, b.path));
    removed.sort((a, b) => compareStrings(a.path, b.path));
    return [...upserts, ...removed];
}
/**
 * Manages the named watchers of one plugin instance (start/poll/stop/list).
 * Names are user-facing strings; reusing one replaces the old watcher and its
 * baseline, while stop/dispose simply drop the state — poll-based watching
 * holds no OS resources that would need releasing.
 */
export class WatchManager {
    watchers = new Map();
    /** Start (or replace) a named watcher; the baseline is only installed once the scan succeeds. */
    async start(name, fs, options) {
        const watcher = new Watcher(fs, options);
        const snapshot = await watcher.start();
        this.watchers.set(name, watcher);
        return snapshot;
    }
    /** Rescan one named watcher; an unknown name is a programming error, not a user-facing condition. */
    async poll(name) {
        const watcher = this.watchers.get(name);
        if (watcher === undefined)
            throw new Error(`unknown watcher: ${name}`);
        return watcher.poll();
    }
    /** Drop a named watcher; true when it existed. */
    stop(name) {
        return this.watchers.delete(name);
    }
    /** Snapshot of the registered watchers, in registration order. */
    list() {
        return [...this.watchers].map(([name, watcher]) => watcher.include === undefined
            ? { name, root: watcher.root }
            : { name, root: watcher.root, include: watcher.include });
    }
    /** Stop everything (plugin teardown). Idempotent. */
    dispose() {
        this.watchers.clear();
    }
}
