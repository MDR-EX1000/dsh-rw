export declare const PLACEHOLDER_META_FILE = ".dsh-rw-meta.json";
/** Host namespace ownership only; never makes remote '/' a workspace. */
export declare const HOST_OWNER_FILE = ".dsh-rw-host.json";
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
 * Where placeholders live. Every field is optional so production code passes
 * the plugin config through and tests inject tmp directories.
 */
export interface PlaceholderLocations {
    /** Mirror-layout root (2.0). Default: {@link defaultPlaceholderRoot}. */
    root?: string;
    /** Legacy (≤ 1.6) base directory, searched by lookups only. Default ~/.dsh/remote-workspaces. */
    legacyBaseDir?: string;
    /** Platform whose path rules apply (tests); default process.platform. */
    platform?: NodeJS.Platform;
    /** The uid the root must belong to (tests simulate a foreign owner); default process.getuid(). */
    currentUid?: () => number | undefined;
}
/** One located placeholder. `hostRoot` is set for mirror-layout hits only. */
export interface PlaceholderHit {
    dir: string;
    meta: PlaceholderMeta;
    layout: 'mirror' | 'legacy';
    /** `<root>/<alias>` in the same path form as `dir` (mirror layout only). */
    hostRoot?: string;
}
/** Anything outside [a-zA-Z0-9._-] becomes '_'; dot-only names cannot climb out of the root. */
export declare function sanitizeAlias(alias: string): string;
/**
 * The default mirror root. macOS: /Users/Shared/dsh-rw-<user> (always exists,
 * never under ~, so DSH's workspace tree shows each host at the top level).
 * Elsewhere: ~/.dsh/rw-workspaces — which may itself sit below a registered
 * home workspace; set `placeholderRoot` to move it.
 */
export declare function defaultPlaceholderRoot(platform?: NodeJS.Platform): string;
/** The ≤ 1.6 placeholder base (lookups only). */
export declare function legacyPlaceholderBaseDir(): string;
/** The effective mirror root (resolved, `~` expanded). */
export declare function placeholderRootOf(loc?: PlaceholderLocations): string;
/**
 * Create (if needed) and validate the mirror root: a real directory — not a
 * symlink — owned by the current user, mode 0700. The macOS default lives in
 * the world-writable /Users/Shared, so another account could pre-create the
 * name; these checks are what keep placeholders out of someone else's tree.
 * The default root is created non-recursively (/Users/Shared always exists and
 * must keep its own mode); a configured root is created recursively.
 */
export declare function ensurePlaceholderRoot(loc?: PlaceholderLocations): string;
/** The host-root placeholder directory (`<root>/<alias>`, remote '/'). */
export declare function hostRootDir(alias: string, loc?: PlaceholderLocations): string;
/** Where (alias, remotePath) lives in the mirror layout (computed, not checked on disk). */
export declare function mirrorPlaceholderDir(alias: string, remotePath: string, loc?: PlaceholderLocations): string;
/**
 * Create the placeholder of (alias, remotePath) at its mirror position;
 * `<root>/<alias>` has an alias ownership record, not a workspace meta, and
 * the directories between it and the placeholder are meta-less 0700 dirs.
 * The host root gets a workspace meta (remote '/') only when '/'
 * itself is picked: a meta there would make every path of the host
 * remote-backed, so it is never created as a side effect. Idempotent. Always
 * the mirror layout — a legacy placeholder for the same pair is left alone
 * (still found by path). Returns the placeholder directory.
 */
export declare function ensurePlaceholder(alias: string, entry: {
    host: string;
    port: number;
    user: string;
}, remotePath: string, loc?: PlaceholderLocations): string;
/** Read and validate the meta file; null when missing or corrupt. */
export declare function readPlaceholderMeta(dir: string): PlaceholderMeta | null;
/**
 * Find the placeholder whose directory contains `path` (a session cwd or a
 * native tool path argument): the mirror layout first (deepest valid meta
 * wins), then the legacy base. Containment is checked both lexically and via
 * realpath. Null when the path is a real local directory — native tools then
 * legitimately run locally.
 */
export declare function findPlaceholderByPath(path: string, loc?: PlaceholderLocations): PlaceholderHit | null;
/**
 * Locate the placeholder of (alias, remotePath): its mirror position when the
 * meta there matches, else a legacy directory whose meta matches (legacy names
 * are not computable, so that half scans). Null when the workspace was never
 * picked or its meta is lost/corrupt.
 */
export declare function locatePlaceholder(alias: string, remotePath: string, loc?: PlaceholderLocations): PlaceholderHit | null;
/** {@link locatePlaceholder}, directory only. */
export declare function resolvePlaceholderDir(alias: string, remotePath: string, loc?: PlaceholderLocations): string | null;
/** Build lookup locations from a deps-style pair (`placeholderRoot` + legacy `placeholderBaseDir`). */
export declare function placeholderLocationsOf(deps: {
    placeholderRoot?: string;
    placeholderBaseDir?: string;
}): PlaceholderLocations;
export {};
