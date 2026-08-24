import type { SftpLike } from './ssh-pool.js';
/**
 * Collapse '', '.', '..' and duplicate slashes into a clean absolute POSIX
 * path. '..' past the root clamps at the root (path.posix.normalize
 * semantics); relative input is treated as rooted at '/'.
 */
export declare function normalizeRemote(p: string): string;
/** Last path segment ('/' → 'workspace'; '/a/b/' → 'b'). */
export declare function baseName(p: string): string;
/** Parent directory ('/' → '/'; '/a' → '/'). */
export declare function dirName(p: string): string;
/**
 * Expand a leading `~` (the remote user's home) to an absolute path. SFTP is
 * not a shell and does no tilde expansion, so it must be done explicitly:
 * the home directory is realpath('.') — the canonical start directory of an
 * SFTP session. `~` and `~/…` expand; anything else passes through unchanged.
 */
export declare function expandRemoteHome(sftp: SftpLike, p: string): Promise<string>;
/** Single-quote shell escaping: a'b → 'a'\''b' */
export declare function shq(s: string): string;
/**
 * Resolve user input to an absolute path inside the workspace.
 * - empty input → the root itself
 * - relative input → joined under root
 * - absolute input → must equal root or sit inside it
 * Throws RwError('OUTSIDE_WORKSPACE') otherwise.
 */
export declare function resolveInWorkspace(root: string, input: string | undefined | null): string;
/**
 * Symlink-escape check for read-class operations (the target must exist):
 * realpath(p) must stay inside root, else RwError('SYMLINK_ESCAPE').
 * A failing realpath (missing path) is wrapped via mapSftpError(err, p).
 * Returns the resolved real path.
 */
export declare function assertRealpathInside(sftp: SftpLike, root: string, p: string): Promise<string>;
/**
 * Symlink-escape check for write-class operations, where the target itself
 * may not exist yet: walk up from dirName(p) to the nearest ancestor whose
 * realpath succeeds and require it to stay inside root. Because p is already
 * lexically inside root and root always exists, the walk succeeds at root at
 * the latest; running out of in-root ancestors means the workspace root
 * itself is missing remotely → RwError('NO_SUCH_PATH').
 */
export declare function assertWritableInside(sftp: SftpLike, root: string, p: string): Promise<void>;
