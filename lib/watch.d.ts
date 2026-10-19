/** Minimal directory listing the watcher needs (SFTP readdir). */
export interface WatchFs {
    /** Recursive-free: list ONE directory. Returns entries with type and mtime in ms. */
    readdir(path: string): Promise<{
        name: string;
        kind: 'file' | 'dir' | 'other';
        size: number;
        mtimeMs: number;
    }[]>;
}
export interface WatchOptions {
    /** Root directory to watch (absolute remote path). */
    root: string;
    /**
     * Optional single glob filter applied to the path relative to root, e.g.
     * "*.ts" or "src/**". A pattern with no "/" matches the basename at any
     * depth; a pattern with "/" is matched against the relative path. The exact
     * supported syntax is documented next to globToRegExp below.
     */
    include?: string;
    /** Max entries to track (default 20000). Directories never count against it. */
    maxEntries?: number;
    /** Max depth to descend (default 8); entries at depth maxDepth+1 are skipped. */
    maxDepth?: number;
}
export type WatchChangeKind = 'added' | 'changed' | 'removed';
export interface WatchChange {
    /** Path RELATIVE to the watch root, using "/" separators. */
    path: string;
    kind: WatchChangeKind;
    /** Present for added/changed. */
    size?: number;
    mtimeMs?: number;
}
export interface WatchSnapshotResult {
    changes: WatchChange[];
    /** True when the tree exceeded maxEntries/maxDepth: the change list is incomplete. */
    truncated: boolean;
    /** Number of tracked entries in this snapshot (matching files; directories are not tracked). */
    entries: number;
}
/**
 * A named watcher: takes a snapshot on start, then diffs against the previous
 * snapshot on each poll. The class is deliberately passive (no interval, no
 * events): the host owns scheduling and can reuse one watcher across many
 * connections, while tests drive it step by step.
 */
export declare class Watcher {
    readonly root: string;
    readonly include: string | undefined;
    private readonly fs;
    private readonly maxEntries;
    private readonly maxDepth;
    private readonly includeMatch;
    private baseline;
    private baselineTruncated;
    constructor(fs: WatchFs, options: WatchOptions);
    /** First snapshot; establishes the baseline. Returns entries counted (changes always empty). */
    start(): Promise<WatchSnapshotResult>;
    /** Re-scan and return the diff against the previous snapshot (also updates the baseline). */
    poll(): Promise<WatchSnapshotResult>;
    /** Drop the baseline (next poll behaves like start). */
    reset(): void;
    /**
     * Walk the tree depth-first with one readdir per directory. The root's
     * readdir error propagates to the caller (a broken workspace root must be
     * reported); any deeper error just prunes that subtree, because a permission
     * denied or a directory vanishing mid-walk is normal on a remote host and
     * must not kill the watcher.
     */
    private scan;
}
/**
 * Manages the named watchers of one plugin instance (start/poll/stop/list).
 * Names are user-facing strings; reusing one replaces the old watcher and its
 * baseline, while stop/dispose simply drop the state — poll-based watching
 * holds no OS resources that would need releasing.
 */
export declare class WatchManager {
    private readonly watchers;
    /** Start (or replace) a named watcher; the baseline is only installed once the scan succeeds. */
    start(name: string, fs: WatchFs, options: WatchOptions): Promise<WatchSnapshotResult>;
    /** Rescan one named watcher; an unknown name is a programming error, not a user-facing condition. */
    poll(name: string): Promise<WatchSnapshotResult>;
    /** Drop a named watcher; true when it existed. */
    stop(name: string): boolean;
    /** Snapshot of the registered watchers, in registration order. */
    list(): {
        name: string;
        root: string;
        include?: string;
    }[];
    /** Stop everything (plugin teardown). Idempotent. */
    dispose(): void;
}
