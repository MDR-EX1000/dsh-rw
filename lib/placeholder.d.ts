export declare const PLACEHOLDER_META_FILE = ".dsh-rw-meta.json";
declare const PLACEHOLDER_NOTE: "placeholder only \u2014 not a copy of remote files";
export interface PlaceholderMeta {
    plugin: 'dsh-rw';
    alias: string;
    host: string;
    port: number;
    user: string;
    remotePath: string;
    createdAt: string;
    note: typeof PLACEHOLDER_NOTE;
}
/**
 * Locate the placeholder of (alias, remotePath) by scanning the alias's
 * placeholder directories and matching their meta files (exact alias +
 * normalized remotePath). Names are no longer computable — clean basenames,
 * user display names, and legacy hash suffixes coexist — so this is the ONLY
 * correct lookup. Null when nothing matches (workspace never picked, or the
 * meta is lost/corrupt).
 */
export declare function resolvePlaceholderDir(alias: string, remotePath: string, baseDir?: string): string | null;
/**
 * Create the placeholder directory plus its meta file (0600, dir 0700).
 * Idempotent: an existing placeholder for the same (alias, remotePath) — found
 * via resolvePlaceholderDir — is kept as-is when its meta is consistent; an
 * inconsistent meta is rewritten but keeps the original createdAt.
 * displayName (picker-only) names a fresh placeholder; omitting it uses the
 * remote basename. Returns the placeholder directory.
 */
export declare function ensurePlaceholder(alias: string, entry: {
    host: string;
    port: number;
    user: string;
}, remotePath: string, baseDir?: string, displayName?: string): string;
/** Read and validate the meta file; null when missing or corrupt. */
export declare function readPlaceholderMeta(dir: string): PlaceholderMeta | null;
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
export declare function findPlaceholderByPath(cwd: string, baseDir?: string): {
    dir: string;
    meta: PlaceholderMeta;
} | null;
export {};
