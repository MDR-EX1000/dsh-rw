// dsh-rw — remote filesystem layer. Every operation follows the same pipeline:
// resolveInWorkspace (lexical confinement) → realpath check (symlink
// confinement) → the SFTP call, whose errors are wrapped via mapSftpError.
//
// One nuance: operations that act on a symlink *entry* itself (delete/move of
// the link) must not follow it — unlinking a dangling or escaping link is
// safe and legitimate. Those paths validate the parent chain instead of the
// link target. Read-class operations always follow (stat/read/list).
import { mapSftpError, RwError } from './errors.js';
import { assertRealpathInside, assertWritableInside, dirName, normalizeRemote, resolveInWorkspace } from './guard.js';
const DEFAULT_MAX_LINES = 2000;
const MAX_LINES_CAP = 10000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
function clampInt(value, dflt, min, max) {
    if (value === undefined || !Number.isFinite(value))
        return dflt;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
function joinRemote(parent, name) {
    return parent === '/' ? `/${name}` : `${parent}/${name}`;
}
// StatLike exposes no isFile(), so anything that is neither dir nor symlink
// is reported as 'file'; the 'other' tag is kept for future refinement.
function typeOf(attrs) {
    if (attrs.isSymbolicLink())
        return 'symlink';
    if (attrs.isDirectory())
        return 'dir';
    return 'file';
}
export class RemoteFs {
    sftp;
    root;
    /** No IO here — root existence is validated by the pick_workspace flow. */
    constructor(sftp, root) {
        this.sftp = sftp;
        this.root = normalizeRemote(root);
    }
    /** List a directory (default: the workspace root); entries sorted by name. */
    async list(path) {
        const p = resolveInWorkspace(this.root, path);
        await assertRealpathInside(this.sftp, this.root, p);
        const st = await this.statChecked(p, 'stat');
        if (!st.isDirectory())
            throw new RwError('NOT_A_DIRECTORY', `not a directory: ${p}`);
        let items;
        try {
            items = await this.sftp.readdir(p);
        }
        catch (err) {
            throw mapSftpError(err, p);
        }
        return items
            .filter((it) => it.filename !== '.' && it.filename !== '..')
            .map((it) => ({ name: it.filename, type: typeOf(it.attrs), size: it.attrs.size, mtime: it.attrs.mtime }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    /**
     * Read a text file: 1-based startLine + maxLines paging over the utf-8
     * content; the file is read whole and capped at maxBytes (truncated=true
     * when cut — the byte cap may split a multi-byte sequence, surfaced as
     * U+FFFD). totalLines counts the (possibly truncated) content.
     */
    async read(path, opts) {
        const p = resolveInWorkspace(this.root, path);
        await assertRealpathInside(this.sftp, this.root, p);
        const st = await this.statChecked(p, 'stat');
        if (st.isDirectory())
            throw new RwError('NOT_A_DIRECTORY', `is a directory: ${p}`);
        const maxBytes = clampInt(opts?.maxBytes, DEFAULT_MAX_BYTES, 0, Number.MAX_SAFE_INTEGER);
        let buf;
        try {
            buf = await this.sftp.readFile(p);
        }
        catch (err) {
            throw mapSftpError(err, p);
        }
        const truncated = buf.length > maxBytes;
        const text = (truncated ? buf.subarray(0, maxBytes) : buf).toString('utf8');
        const startLine = clampInt(opts?.startLine, 1, 1, Number.MAX_SAFE_INTEGER);
        const maxLines = clampInt(opts?.maxLines, DEFAULT_MAX_LINES, 1, MAX_LINES_CAP);
        const lines = text.split('\n');
        // A trailing newline terminates the last line; it does not start a new one.
        if (lines.length > 0 && lines[lines.length - 1] === '')
            lines.pop();
        const totalLines = lines.length;
        const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);
        return {
            content: slice.join('\n'),
            totalLines,
            startLine,
            endLine: slice.length > 0 ? startLine + slice.length - 1 : startLine - 1,
            truncated,
        };
    }
    /** Write (overwrite) a file; opts.mkdir (default true) creates missing parents. */
    async write(path, content, opts) {
        const p = resolveInWorkspace(this.root, path);
        await assertWritableInside(this.sftp, this.root, p);
        const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        if (opts?.mkdir ?? true)
            await this.mkdirp(dirName(p));
        try {
            await this.sftp.writeFile(p, data);
        }
        catch (err) {
            throw mapSftpError(err, p);
        }
        return { bytes: data.length };
    }
    /** Create a directory recursively; existing directories succeed silently. */
    async mkdir(path) {
        const p = resolveInWorkspace(this.root, path);
        // The workspace root itself has no in-root ancestor; validate it directly.
        if (p === this.root)
            await assertRealpathInside(this.sftp, this.root, p);
        else
            await assertWritableInside(this.sftp, this.root, p);
        await this.mkdirp(p);
    }
    /**
     * Move/rename within the workspace. An existing destination is rejected
     * with INVALID_INPUT unless opts.overwrite, which unlinks/rmdirs it first
     * (rmdir fails on a non-empty directory — rename semantics stay atomic-ish).
     */
    async move(src, dst, opts) {
        const s = resolveInWorkspace(this.root, src);
        const d = resolveInWorkspace(this.root, dst);
        const srcStat = await this.statChecked(s, 'lstat');
        // A symlink moves as the link itself; only its parent chain must be inside.
        if (srcStat.isSymbolicLink())
            await assertWritableInside(this.sftp, this.root, s);
        else
            await assertRealpathInside(this.sftp, this.root, s);
        await assertWritableInside(this.sftp, this.root, d);
        let dstStat;
        try {
            dstStat = await this.sftp.lstat(d);
        }
        catch (err) {
            const mapped = mapSftpError(err, d);
            if (mapped.code !== 'NO_SUCH_PATH')
                throw mapped;
        }
        if (dstStat) {
            if (!(opts?.overwrite ?? false)) {
                throw new RwError('INVALID_INPUT', `destination exists: ${d}`);
            }
            try {
                if (dstStat.isDirectory())
                    await this.sftp.rmdir(d);
                else
                    await this.sftp.unlink(d);
            }
            catch (err) {
                throw mapSftpError(err, d);
            }
        }
        try {
            await this.sftp.rename(s, d);
        }
        catch (err) {
            throw mapSftpError(err, `${s} -> ${d}`);
        }
    }
    /**
     * Delete a file/symlink (unlink) or a directory (rmdir; only with
     * opts.recursive, deleting children first — symlinks are unlinked, never
     * followed, so a link pointing outside the workspace removes only itself).
     */
    async delete(path, opts) {
        const p = resolveInWorkspace(this.root, path);
        const st = await this.statChecked(p, 'lstat');
        if (st.isSymbolicLink()) {
            // Removing the link entry never touches its target — even a dangling
            // one — but the link's parent chain must still be inside the workspace.
            await assertWritableInside(this.sftp, this.root, p);
            await this.unlinkChecked(p);
            return;
        }
        await assertRealpathInside(this.sftp, this.root, p);
        if (!st.isDirectory()) {
            await this.unlinkChecked(p);
            return;
        }
        if (!(opts?.recursive ?? false)) {
            throw new RwError('INVALID_INPUT', `is a directory; pass recursive: true (${p})`);
        }
        await this.deleteChildren(p);
        try {
            await this.sftp.rmdir(p);
        }
        catch (err) {
            throw mapSftpError(err, p);
        }
    }
    /** Stat a path (follows symlinks); missing → NO_SUCH_PATH. */
    async stat(path) {
        const p = resolveInWorkspace(this.root, path);
        await assertRealpathInside(this.sftp, this.root, p);
        const st = await this.statChecked(p, 'stat');
        return { type: typeOf(st), size: st.size, mtime: st.mtime };
    }
    // --- internals ------------------------------------------------------------
    async statChecked(p, how) {
        try {
            return how === 'stat' ? await this.sftp.stat(p) : await this.sftp.lstat(p);
        }
        catch (err) {
            throw mapSftpError(err, p);
        }
    }
    async unlinkChecked(p) {
        try {
            await this.sftp.unlink(p);
        }
        catch (err) {
            throw mapSftpError(err, p);
        }
    }
    /** Recursive delete below an already-validated directory. */
    async deleteChildren(dir) {
        let items;
        try {
            items = await this.sftp.readdir(dir);
        }
        catch (err) {
            throw mapSftpError(err, dir);
        }
        for (const it of items) {
            if (it.filename === '.' || it.filename === '..')
                continue;
            const child = joinRemote(dir, it.filename);
            if (it.attrs.isSymbolicLink() || !it.attrs.isDirectory()) {
                await this.unlinkChecked(child);
            }
            else {
                await this.deleteChildren(child);
                try {
                    await this.sftp.rmdir(child);
                }
                catch (err) {
                    throw mapSftpError(err, child);
                }
            }
        }
    }
    /** mkdir -p; p must already be resolved inside the workspace. */
    async mkdirp(p) {
        if (p === '/')
            return;
        let exists = false;
        try {
            const st = await this.sftp.stat(p);
            if (!st.isDirectory())
                throw new RwError('INVALID_INPUT', `exists and is not a directory: ${p}`);
            exists = true;
        }
        catch (err) {
            const mapped = mapSftpError(err, p);
            if (mapped.code !== 'NO_SUCH_PATH')
                throw mapped;
        }
        if (exists)
            return;
        await this.mkdirp(dirName(p));
        try {
            await this.sftp.mkdir(p);
        }
        catch (err) {
            // Lost a creation race, or the server reports EEXIST as a generic
            // FAILURE: accept it when the directory is there now.
            try {
                const st = await this.sftp.stat(p);
                if (st.isDirectory())
                    return;
            }
            catch {
                // fall through to the original mkdir error
            }
            throw mapSftpError(err, p);
        }
    }
}
