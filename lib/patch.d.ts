/** One file's entry in a parsed unified diff. */
export interface PatchFile {
    /** The path as written in the diff's `---`/`+++` lines, minus any a/ b/ prefix and trailing timestamp. */
    oldPath: string;
    newPath: string;
    /** True for /dev/null (file created or deleted). */
    oldIsNull: boolean;
    newIsNull: boolean;
}
/**
 * Malformed patch text: no `---`/`+++` pair, a missing `+++`, a bad hunk
 * header or an unreadable hunk body.
 */
export declare class PatchFormatError extends Error {
    constructor(message: string);
}
/**
 * A patch path that would leave the workspace: absolute, empty after
 * stripping, or containing '..'.
 */
export declare class PathEscapeError extends Error {
    constructor(message: string);
}
/**
 * Parse a unified diff into its file entries. Accepts the forms produced by
 * git and `diff -u`: optional `diff --git` / `index` metadata, `a/`/`b/`
 * prefixes, `/dev/null` on either side, timestamps after a tab, and multiple
 * files. Throws PatchFormatError when no file header pair exists at all or
 * when a `---` header has no `+++` partner.
 */
export declare function parsePatch(patch: string): PatchFile[];
/** True when the text looks like it contains a NUL byte (binary content). */
export declare function looksBinary(text: string): boolean;
/**
 * Build a unified diff for one file from two texts. Returns '' when the texts
 * are identical. Header uses `a/<path>` and `b/<path>`, `---`/`+++` lines, and
 * @@ hunks with `contextLines` lines of context (default 3, 0 allowed).
 *
 * Line terminators are treated as content, so a change that only adds or
 * removes the final newline is a real change and is represented with the
 * `\ No newline at end of file` marker.
 */
export declare function unifiedDiff(path: string, before: string, after: string, contextLines?: number): string;
/**
 * Apply a single-file unified diff produced by unifiedDiff (or a normal one)
 * to `before`. Matching is exact — no fuzz, no offset guessing — and a hunk
 * whose context does not match throws PatchFormatError, so a stale patch can
 * never silently corrupt a remote file.
 */
export declare function applyUnifiedDiff(before: string, patch: string): string;
/**
 * Every path a patch would touch, resolved against a workspace root, after
 * stripping `strip` leading path components (default 1, i.e. `patch -p1`,
 * which conventionally removes the `a/` and `b/` prefixes). `/dev/null` sides
 * contribute no target. Throws PathEscapeError when a resulting path is
 * absolute, empty, or escapes the root (`..`), so a patch can never write
 * outside the workspace. Targets are de-duplicated while preserving order.
 */
export declare function patchTargets(patch: string, workspaceRoot: string, strip?: number): string[];
