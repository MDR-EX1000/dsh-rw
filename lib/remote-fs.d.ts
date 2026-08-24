import type { SftpLike } from './ssh-pool.js';
export interface RemoteEntry {
    name: string;
    type: 'dir' | 'file' | 'symlink' | 'other';
    size: number;
    mtime: number;
}
export interface ReadResult {
    content: string;
    totalLines: number;
    startLine: number;
    endLine: number;
    truncated: boolean;
}
export declare class RemoteFs {
    readonly sftp: SftpLike;
    readonly root: string;
    /** No IO here — root existence is validated by the pick_workspace flow. */
    constructor(sftp: SftpLike, root: string);
    /** List a directory (default: the workspace root); entries sorted by name. */
    list(path?: string): Promise<RemoteEntry[]>;
    /**
     * Read a text file: 1-based startLine + maxLines paging over the utf-8
     * content; the file is read whole and capped at maxBytes (truncated=true
     * when cut — the byte cap may split a multi-byte sequence, surfaced as
     * U+FFFD). totalLines counts the (possibly truncated) content.
     */
    read(path: string, opts?: {
        startLine?: number;
        maxLines?: number;
        maxBytes?: number;
    }): Promise<ReadResult>;
    /** Write (overwrite) a file; opts.mkdir (default true) creates missing parents. */
    write(path: string, content: string | Buffer, opts?: {
        mkdir?: boolean;
    }): Promise<{
        bytes: number;
    }>;
    /** Create a directory recursively; existing directories succeed silently. */
    mkdir(path: string): Promise<void>;
    /**
     * Move/rename within the workspace. An existing destination is rejected
     * with INVALID_INPUT unless opts.overwrite, which unlinks/rmdirs it first
     * (rmdir fails on a non-empty directory — rename semantics stay atomic-ish).
     */
    move(src: string, dst: string, opts?: {
        overwrite?: boolean;
    }): Promise<void>;
    /**
     * Delete a file/symlink (unlink) or a directory (rmdir; only with
     * opts.recursive, deleting children first — symlinks are unlinked, never
     * followed, so a link pointing outside the workspace removes only itself).
     */
    delete(path: string, opts?: {
        recursive?: boolean;
    }): Promise<void>;
    /** Stat a path (follows symlinks); missing → NO_SUCH_PATH. */
    stat(path: string): Promise<{
        type: RemoteEntry['type'];
        size: number;
        mtime: number;
    }>;
    private statChecked;
    private unlinkChecked;
    /** Recursive delete below an already-validated directory. */
    private deleteChildren;
    /** mkdir -p; p must already be resolved inside the workspace. */
    private mkdirp;
}
