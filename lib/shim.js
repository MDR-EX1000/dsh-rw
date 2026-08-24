// dsh-rw — shim mode: run DSH's NATIVE tools against the remote workspace.
//
// With `shim: true` and an active remote session, two cordis middlewares
// translate native read / write / edit / str_replace_editor / glob / grep /
// bash calls on the `tools/execute` waterfall into SFTP/exec operations on the
// remote host, so the agent can ignore rw_* and work as if the workspace were
// local. The placeholder directory is the only path space the agent ever
// sees: argument paths map placeholder → remote on the way in, and every path
// in results (and in composed error messages) maps back remote → placeholder.
// A call whose path — or, for bash, whose session cwd — falls outside the
// placeholder passes through via next() unchanged; with shim off every call
// passes through, so the default behavior is identical to v0.1.
//
// Approvals: shimmed bash calls escalate on the `tools/pre-execute` waterfall
// with { kind: 'ask', reason } (the DSH approval dialog, reason naming the
// remote host alias) when shimBashApproval is 'ask'; fs tools never escalate
// — the workspace guard confines them. bash flavor: dsh-tool-bash and
// dsh-tool-bash-persistent BOTH register a tool named "bash"; they are told
// apart by their parameter schema (only the one-shot schema declares
// workdir/timeoutMs/description). A persistent call runs as a one-shot remote
// exec and the result says shell state is not preserved.
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { mapSftpError, RwError } from './errors.js';
import { assertRealpathInside, normalizeRemote, resolveInWorkspace, shq } from './guard.js';
import { findPlaceholderByPath, resolvePlaceholderDir } from './placeholder.js';
import { RemoteFs } from './remote-fs.js';
// Native-tool caps mirrored from the DSH tool plugins so shimmed results read
// like local ones: dsh-tool-fs readLimit/readMaxBytes/readMaxLineLength and
// dsh-tool-fs-search globMaxResults/grepMaxMatches.
const READ_LIMIT = 2000;
const READ_MAX_BYTES = 50 * 1024;
const READ_MAX_LINE_LENGTH = 2000;
const GLOB_MAX_RESULTS = 100;
const GREP_MAX_MATCHES = 250;
// --- result envelopes ---------------------------------------------------------
function ok(text) {
    return { isError: false, value: text, content: [{ type: 'text', text }] };
}
/**
 * Success envelope with a structured value. The registry validates `value`
 * against the native tool's declared output schema (additionalProperties:
 * false), so it must carry exactly the native fields; the rendered text stays
 * the model-facing content.
 */
function okValue(value, text) {
    return { isError: false, value, content: [{ type: 'text', text }] };
}
/** Mirror of the registry's error envelope: `Error: message` text plus the structured failure. */
function fail(message, info) {
    return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${message}` }],
        error: { message, ...(info !== undefined ? { info } : {}) },
    };
}
/** Native-vocabulary error (message + code) for edit/editor fidelity with dsh-tool-fs. */
class FsStyleError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'FsError';
    }
}
/** Run one intercepted call: RwError and FsStyleError keep their codes, anything else is a plain failure. */
async function guarded(fn) {
    try {
        return await fn();
    }
    catch (err) {
        if (err instanceof RwError)
            return fail(`[${err.code}] ${err.message}`, { name: 'RwError', code: err.code });
        if (err instanceof FsStyleError)
            return fail(err.message, { name: 'FsError', code: err.code });
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** The placeholder's local root forms (lexical + realpath), as insideLocal expects them. */
function localRootsOf(localRoot) {
    const roots = [resolve(localRoot)];
    try {
        const real = realpathSync(localRoot);
        if (!roots.includes(real))
            roots.push(real);
    }
    catch {
        // placeholder missing on disk: lexical containment still applies
    }
    return roots;
}
/** Build an ActiveTarget from a resolved host entry, remote root, and placeholder dir. */
function buildTarget(entry, remotePath, localRoot) {
    return { entry, remoteRoot: normalizeRemote(remotePath), localRoot, localRoots: localRootsOf(localRoot) };
}
/**
 * The live target for native tools. The agent's session cwd is authoritative:
 * when DSH registered a remote-backed placeholder as the workspace, the agent
 * cwd lives inside that placeholder, so native tools must target ITS remote —
 * not the mutable rw_* "current host" (null after rw_disconnect, or a different
 * host the user reconnected for rw_* work). The rw_* session is a fast path
 * when it matches the cwd; otherwise the cwd's placeholder is resolved by
 * scanning meta files (the pool redials lazily on the next op, so native tools
 * even survive a disconnect). Null when the cwd is a real local directory
 * (legitimate local pass-through) or a placeholder whose host is gone
 * (onExecute turns that into a clear error instead of a silent local fallback).
 */
function activeTarget(deps, exec) {
    const cwd = agentCwd(exec);
    // Fast path: the rw_* session's (alias, workspace), in-memory. Used when it
    // matches the agent cwd (the common case — the user picked this workspace
    // and stayed), so the hot path does no placeholder scan.
    const alias = deps.session.alias;
    const workspace = deps.session.workspace;
    if (alias !== null && workspace !== null) {
        const entry = deps.hosts.find(alias);
        if (entry !== undefined) {
            const localRoot = resolvePlaceholderDir(alias, workspace, deps.placeholderBaseDir);
            if (localRoot !== null) {
                const target = buildTarget(entry, workspace, localRoot);
                if (cwd === undefined || insideLocal(target.localRoots, resolve(cwd)))
                    return target;
            }
        }
    }
    // Authoritative slow path: the agent cwd itself. The placeholder meta
    // carries the host alias + remote path; the HostTable supplies credentials.
    if (cwd !== undefined) {
        const found = findPlaceholderByPath(cwd, deps.placeholderBaseDir);
        if (found !== null) {
            const entry = deps.hosts.find(found.meta.alias);
            if (entry !== undefined)
                return buildTarget(entry, found.meta.remotePath, found.dir);
            // cwd is a dsh-rw placeholder whose host is no longer configured: never
            // silently fall back to the local empty placeholder — onExecute reports
            // it as a clear error.
        }
    }
    return null;
}
/**
 * The blocked state: the agent cwd sits inside a dsh-rw placeholder whose
 * host is no longer configured. Returns the placeholder + meta, or null when
 * the cwd is not placeholder-backed (legitimate local pass-through) or its
 * host is configured (activeTarget then handles it).
 */
function brokenPlaceholder(deps, exec) {
    const cwd = agentCwd(exec);
    if (cwd === undefined)
        return null;
    const found = findPlaceholderByPath(cwd, deps.placeholderBaseDir);
    if (found === null)
        return null;
    if (deps.hosts.find(found.meta.alias) !== undefined)
        return null;
    return found;
}
/** The clear, actionable error for a call that touches a broken placeholder. */
function blockedMessage(found) {
    return (`the workspace ${found.dir} is remote-backed (host alias '${found.meta.alias}', remote ` +
        `${found.meta.remotePath}) but that host is no longer configured — re-add it (rw_hosts) ` +
        `and rw_connect('${found.meta.alias}') to operate on the remote; native tools will not ` +
        `use the local placeholder`);
}
/**
 * Whether a native-tool call would actually touch the placeholder at `root`:
 * bash always (it runs with the session cwd); glob/grep without a path arg
 * too (they default to the session cwd); file tools only when their path
 * argument resolves inside. Calls that stay elsewhere pass through to the
 * local tool even in the blocked state — same rule the shim applies when the
 * remote is healthy.
 */
function callTouchesPlaceholder(name, args, roots, root) {
    if (name === 'bash')
        return true;
    const inside = (raw) => insideLocal(roots, isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
    switch (name) {
        case 'read':
        case 'write':
        case 'edit': {
            const raw = args?.file_path;
            // Missing/invalid path → pass through; native validation reports it.
            return typeof raw === 'string' && raw !== '' && inside(raw);
        }
        case 'str_replace_editor': {
            const raw = args?.path;
            return typeof raw === 'string' && raw !== '' && inside(raw);
        }
        case 'glob':
        case 'grep': {
            const raw = args?.path;
            if (typeof raw !== 'string' || raw === '')
                return true; // cwd-bound
            return inside(raw);
        }
        default:
            return false; // not a shimmed tool: do not interfere
    }
}
/** p (already resolve()d) sits inside one of the placeholder root forms. */
function insideLocal(roots, p) {
    return roots.some((r) => p === r || p.startsWith(`${r}${sep}`));
}
/**
 * Map a native-tool path argument to an absolute remote path inside the
 * workspace: relative input resolves against the placeholder root, the
 * matching placeholder prefix is stripped, and the remainder is re-rooted at
 * the remote root (still through the guard's lexical confinement). Null when
 * the resolved path falls outside the placeholder → the call passes through
 * to the local tool.
 */
function toRemotePath(target, input) {
    const abs = isAbsolute(input) ? resolve(input) : resolve(target.localRoot, input);
    if (!insideLocal(target.localRoots, abs))
        return null;
    const root = target.localRoots.find((r) => abs === r || abs.startsWith(`${r}${sep}`));
    const rel = abs
        .slice(root.length)
        .split(sep)
        .filter((s) => s !== '')
        .join('/');
    return resolveInWorkspace(target.remoteRoot, rel);
}
/**
 * Map an absolute remote path back to placeholder form. Paths outside the
 * workspace root are returned unchanged (they can appear in grep output when
 * the remote tool follows an escaping symlink; the guard already confines
 * file IO).
 */
function toLocalPath(target, remote) {
    const r = normalizeRemote(remote);
    if (r === target.remoteRoot)
        return target.localRoot;
    if (!r.startsWith(`${target.remoteRoot}/`))
        return remote;
    return join(target.localRoot, ...r.slice(target.remoteRoot.length + 1).split('/'));
}
/** The calling agent's session cwd — where DSH put the workspace (dsh-agent-loop reads it the same way). */
function agentCwd(exec) {
    const cwd = exec.agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}
/** The bash interception gate: the agent session must live inside the placeholder (cwd unknown → pass through). */
function sessionInsidePlaceholder(target, exec) {
    const cwd = agentCwd(exec);
    return cwd !== undefined && insideLocal(target.localRoots, resolve(cwd));
}
// --- small argument/exec helpers ----------------------------------------------
/** exec.arguments as a plain record; null for anything else (→ pass through to native validation). */
function objectArgs(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args))
        return null;
    return args;
}
function strArg(args, key) {
    const v = args[key];
    return typeof v === 'string' ? v : undefined;
}
/** Native-style positive-integer validation for read's offset/limit. */
function parsePositiveInteger(value, name) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}
/**
 * pool.exec has no signal channel, so abort races the call and — on winning —
 * drops the whole SSH connection: the only way to actually interrupt the
 * remote process through PoolLike. The pool reconnects lazily on next use.
 */
async function execRemote(deps, target, command, opts, signal) {
    if (signal.aborted)
        return 'aborted';
    let onAbort;
    const aborted = new Promise((resolveAbort) => {
        onAbort = () => resolveAbort('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const res = await Promise.race([deps.pool.exec(target.entry, command, opts), aborted]);
        if (res === 'aborted')
            deps.pool.disconnect(target.entry.alias);
        return res;
    }
    finally {
        if (onAbort !== undefined)
            signal.removeEventListener('abort', onAbort);
    }
}
/** Guarded whole-file read: realpath confinement, not-a-directory, utf-8 decode. */
async function readRemoteText(sftp, root, p, display) {
    await assertRealpathInside(sftp, root, p);
    let st;
    try {
        st = await sftp.stat(p);
    }
    catch (err) {
        throw mapSftpError(err, display);
    }
    if (st.isDirectory())
        throw new RwError('NOT_A_DIRECTORY', `is a directory: ${display}`);
    let buf;
    try {
        buf = await sftp.readFile(p);
    }
    catch (err) {
        throw mapSftpError(err, display);
    }
    return { content: buf.toString('utf8').replaceAll('\r\n', '\n'), mtime: st.mtime };
}
/**
 * Conflict-guarded write-back for edit-class operations: re-stat right before
 * writing and refuse with RW_EDIT_CONFLICT when the file moved since the read
 * — the remote is shared mutable state and there is no local copy to diff.
 */
async function writeRemoteText(sftp, p, content, expectedMtime, display) {
    let st;
    try {
        st = await sftp.stat(p);
    }
    catch (err) {
        throw mapSftpError(err, display);
    }
    if (st.mtime !== expectedMtime) {
        throw new RwError('RW_EDIT_CONFLICT', `file changed on the remote since it was read (mtime ${expectedMtime} -> ${st.mtime}): ${display} — re-read it and retry the edit`);
    }
    try {
        await sftp.writeFile(p, Buffer.from(content, 'utf8'));
    }
    catch (err) {
        throw mapSftpError(err, display);
    }
}
function truncateLine(line) {
    return line.length > READ_MAX_LINE_LENGTH
        ? `${line.substring(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
        : line;
}
/** Synchronous port of dsh-tool-fs buildWindow: exact total count, offset/limit window, byte cap. */
function buildReadWindow(content, offset, limit, display) {
    const rawLines = content.split('\n');
    // A trailing newline terminates the last line; it does not start a new one.
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '')
        rawLines.pop();
    const lines = [];
    let outputBytes = 0;
    let truncatedByBytes = false;
    let totalLines = 0;
    for (const raw of rawLines) {
        totalLines += 1;
        if (truncatedByBytes || totalLines < offset || lines.length >= limit)
            continue;
        const text = truncateLine(raw);
        const bytes = Buffer.byteLength(text, 'utf8') + (lines.length > 0 ? 1 : 0);
        if (outputBytes + bytes > READ_MAX_BYTES) {
            truncatedByBytes = true;
            continue;
        }
        outputBytes += bytes;
        lines.push({ number: totalLines, text });
    }
    if (!truncatedByBytes && offset > totalLines && !(totalLines === 0 && offset === 1)) {
        throw new Error(`offset ${offset} is out of range for "${display}" (${totalLines} lines)`);
    }
    return { lines, totalLines, truncatedByBytes };
}
/** Native read envelope: <path>/<type>/<content> with numbered lines and a continuation footer. */
function formatReadOutput(display, offset, window) {
    const endLine = window.lines.at(-1)?.number ?? Math.max(0, offset - 1);
    let footer;
    if (window.truncatedByBytes) {
        footer = `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`;
    }
    else if (endLine < window.totalLines) {
        footer = `(Showing lines ${offset}-${endLine} of ${window.totalLines}. Use offset=${endLine + 1} to continue.)`;
    }
    else {
        footer = `(End of file - total ${window.totalLines} lines)`;
    }
    const body = window.lines.length > 0 ? `${window.lines.map((line) => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}` : footer;
    return `<path>${display}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}
/** Native `read` (dsh-tool-fs): { file_path, offset?, limit? }. */
async function shimRead(deps, target, args) {
    const filePath = strArg(args, 'file_path');
    if (filePath === undefined)
        return null;
    const remote = toRemotePath(target, filePath);
    if (remote === null)
        return null;
    return guarded(async () => {
        if (filePath.trim().length === 0)
            throw new Error('file_path must be a non-empty string');
        const offset = parsePositiveInteger(args.offset, 'offset') ?? 1;
        const limit = parsePositiveInteger(args.limit, 'limit') ?? READ_LIMIT;
        if (limit > READ_LIMIT)
            throw new Error(`limit must be less than or equal to ${READ_LIMIT}`);
        const display = toLocalPath(target, remote);
        const sftp = await deps.pool.sftp(target.entry);
        const { content } = await readRemoteText(sftp, target.remoteRoot, remote, display);
        const window = buildReadWindow(content, offset, limit, display);
        // Native read output: { path, offset, lines: [{ number, text }], totalLines }.
        return okValue({ path: display, offset, lines: window.lines, totalLines: window.totalLines }, formatReadOutput(display, offset, window));
    });
}
// --- write --------------------------------------------------------------------
/** Native `write` (dsh-tool-fs): { file_path, content }. Parent directories are created. */
async function shimWrite(deps, target, args) {
    const filePath = strArg(args, 'file_path');
    const content = strArg(args, 'content');
    if (filePath === undefined || content === undefined)
        return null;
    const remote = toRemotePath(target, filePath);
    if (remote === null)
        return null;
    return guarded(async () => {
        const display = toLocalPath(target, remote);
        const sftp = await deps.pool.sftp(target.entry);
        const fs = new RemoteFs(sftp, target.remoteRoot);
        // Native write output carries the previous content (`before`, null on
        // create) and the new content (`after`), so read the file first when it
        // exists. A directory skips the read: the write below fails either way.
        let before = null;
        let operation;
        try {
            const st = await fs.stat(remote);
            operation = 'update';
            if (st.type !== 'dir')
                before = (await readRemoteText(sftp, target.remoteRoot, remote, display)).content;
        }
        catch (err) {
            if (err instanceof RwError && err.code === 'NO_SUCH_PATH')
                operation = 'create';
            else
                throw err;
        }
        await fs.write(remote, content, { mkdir: true });
        // Native write output: { path, operation, before, after }.
        return okValue({ path: display, operation, before, after: content }, `<path>${display}</path>\n<type>file</type>\n<content>\n${operation === 'create' ? 'Created' : 'Updated'} file\n</content>`);
    });
}
// --- edit ---------------------------------------------------------------------
function countOccurrences(content, search) {
    let count = 0;
    let offset = 0;
    for (;;) {
        const at = content.indexOf(search, offset);
        if (at < 0)
            return count;
        count += 1;
        offset = at + search.length;
    }
}
/** Native `edit` (dsh-tool-fs): { file_path, old_string, new_string, replace_all? } with an mtime conflict gate. */
async function shimEdit(deps, target, args) {
    const filePath = strArg(args, 'file_path');
    const oldString = strArg(args, 'old_string');
    const newString = strArg(args, 'new_string');
    if (filePath === undefined || oldString === undefined || newString === undefined)
        return null;
    const remote = toRemotePath(target, filePath);
    if (remote === null)
        return null;
    return guarded(async () => {
        if (filePath.trim().length === 0)
            throw new Error('file_path must be a non-empty string');
        if (oldString.length === 0)
            throw new Error('old_string must be a non-empty string');
        if (oldString === newString)
            throw new Error('old_string and new_string must differ');
        const replaceAll = args.replace_all === true;
        const display = toLocalPath(target, remote);
        const sftp = await deps.pool.sftp(target.entry);
        const state = await readRemoteText(sftp, target.remoteRoot, remote, display);
        const replacements = countOccurrences(state.content, oldString);
        if (replacements === 0) {
            return fail(`old_string was not found in "${display}"`, { name: 'FsError', code: 'FS_EDIT_NOT_FOUND' });
        }
        if (!replaceAll && replacements > 1) {
            return fail(`old_string matched ${replacements} times in "${display}"; provide a more specific old_string or set replace_all to true`, {
                name: 'FsError',
                code: 'FS_AMBIGUOUS_EDIT',
            });
        }
        const at = state.content.indexOf(oldString);
        const after = replaceAll
            ? state.content.split(oldString).join(newString)
            : state.content.slice(0, at) + newString + state.content.slice(at + oldString.length);
        await writeRemoteText(sftp, remote, after, state.mtime, display);
        // Native edit output: { path, before, after }.
        return okValue({ path: display, before: state.content, after }, replaceAll
            ? `The file ${display} has been updated. All occurrences were successfully replaced.`
            : `The file ${display} has been updated successfully.`);
    });
}
// --- str_replace_editor --------------------------------------------------------
function matchOffsets(content, search) {
    const offsets = [];
    let offset = 0;
    for (;;) {
        const match = content.indexOf(search, offset);
        if (match < 0)
            return offsets;
        offsets.push(match);
        offset = match + search.length;
    }
}
function lineNumbersAt(content, offsets) {
    let line = 1;
    let cursor = 0;
    return offsets.map((offset) => {
        while (cursor < offset) {
            if (content[cursor] === '\n')
                line += 1;
            cursor += 1;
        }
        return line;
    });
}
function requiredForCommand(value, parameter, command, allowEmpty = true) {
    if (value === undefined)
        throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
    if (!allowEmpty && value.length === 0)
        throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`);
    return value;
}
function maybeTruncate(text, maxChars) {
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n<response clipped>` : text;
}
/** The native statExisting: missing path and directory-for-non-view map to FsStyleError. */
async function statExisting(fs, remote, display, command) {
    let info;
    try {
        info = await fs.stat(remote);
    }
    catch (err) {
        if (err instanceof RwError && err.code === 'NO_SUCH_PATH') {
            throw new FsStyleError(`The path ${display} does not exist. Please provide a valid path.`, 'FS_NOT_FOUND');
        }
        throw err;
    }
    const type = info.type === 'dir' ? 'dir' : info.type === 'file' ? 'file' : 'other';
    if (type === 'dir' && command !== 'view') {
        throw new FsStyleError(`The path ${display} is a directory and only the \`view\` command can be used on directories`, 'FS_NOT_REGULAR_FILE');
    }
    return type;
}
/** Native formatFileView: padStart(6) + two spaces numbering, total counted from a raw split. */
function formatEditorFileView(display, content, maxChars, viewRange) {
    const allLines = content.split('\n');
    let lines = allLines;
    let initialLine = 1;
    let prompt = `Here's the content of ${display} with line numbers (which has a total of ${allLines.length} lines)`;
    if (viewRange !== undefined) {
        if (!Array.isArray(viewRange) || viewRange.length !== 2 || !viewRange.every(Number.isInteger)) {
            throw new Error('Invalid `view_range`. It should be a list of two integers.');
        }
        const [requestedInitialLine, requestedFinalLine] = viewRange;
        initialLine = requestedInitialLine;
        if (initialLine < 1 || initialLine > allLines.length) {
            throw new Error(`Invalid \`view_range\`: [${viewRange.join(', ')}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`);
        }
        if (requestedFinalLine > allLines.length) {
            throw new Error(`Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${requestedFinalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``);
        }
        if (requestedFinalLine !== -1 && requestedFinalLine < initialLine) {
            throw new Error(`Invalid \`view_range\`: [${viewRange.join(', ')}]. Its second element \`${requestedFinalLine}\` should be larger or equal than its first \`${initialLine}\``);
        }
        lines = requestedFinalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, requestedFinalLine);
        prompt += ` with view_range=[${initialLine}, ${requestedFinalLine}]`;
    }
    const numbered = lines.map((line, index) => `${String(initialLine + index).padStart(6, ' ')}  ${line}`).join('\n');
    return maybeTruncate(`${prompt}:\n${numbered}\n`, maxChars);
}
function joinRemote(parent, name) {
    return parent === '/' ? `/${name}` : `${parent}/${name}`;
}
/** Native directory view: two levels deep, excluding hidden entries, node_modules and __pycache__. */
async function editorListDir(deps, fs, remote, display) {
    const rows = [`d\t${display}`];
    const visit = async (dirRemote, dirDisplay, depth) => {
        for (const entry of await fs.list(dirRemote)) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__')
                continue;
            const childDisplay = join(dirDisplay, entry.name);
            const type = entry.type === 'dir' ? 'd' : entry.type === 'file' ? 'f' : '?';
            rows.push(`${type}\t${childDisplay}`);
            if (entry.type === 'dir' && depth < 2)
                await visit(joinRemote(dirRemote, entry.name), childDisplay, depth + 1);
        }
    };
    await visit(remote, display, 1);
    rows.sort((left, right) => {
        const lp = left.slice(left.indexOf('\t') + 1);
        const rp = right.slice(right.indexOf('\t') + 1);
        return lp < rp ? -1 : lp > rp ? 1 : 0;
    });
    const listing = maybeTruncate(`${rows.join('\n')}\n`, deps.config.maxOutputChars);
    return `Here're the files and directories up to 2 levels deep in ${display}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}
/** Native `str_replace_editor` (Anthropic editor): { command, path, file_text?, insert_line?, new_str?, old_str?, view_range? }. */
async function shimStrReplaceEditor(deps, target, args) {
    const command = strArg(args, 'command');
    const pathArg = strArg(args, 'path');
    if (command === undefined || pathArg === undefined)
        return null;
    if (!['view', 'create', 'str_replace', 'insert'].includes(command))
        return null;
    const remote = toRemotePath(target, pathArg);
    if (remote === null)
        return null;
    return guarded(async () => {
        const display = toLocalPath(target, remote);
        const sftp = await deps.pool.sftp(target.entry);
        const fs = new RemoteFs(sftp, target.remoteRoot);
        switch (command) {
            case 'view': {
                const type = await statExisting(fs, remote, display, 'view');
                if (type === 'dir') {
                    if (args.view_range !== undefined) {
                        throw new Error('The `view_range` parameter is not allowed when `path` points to a directory.');
                    }
                    return ok(await editorListDir(deps, fs, remote, display));
                }
                if (type !== 'file')
                    throw new FsStyleError(`cannot view "${display}": not a regular file or directory`, 'FS_NOT_REGULAR_FILE');
                const state = await readRemoteText(sftp, target.remoteRoot, remote, display);
                return ok(formatEditorFileView(display, state.content, deps.config.maxOutputChars, args.view_range));
            }
            case 'create': {
                const fileText = requiredForCommand(strArg(args, 'file_text'), 'file_text', 'create');
                let exists = true;
                try {
                    await fs.stat(remote);
                }
                catch (err) {
                    if (err instanceof RwError && err.code === 'NO_SUCH_PATH')
                        exists = false;
                    else
                        throw err;
                }
                if (exists)
                    throw new Error(`File already exists at: ${display}. Cannot overwrite files using command \`create\`.`);
                await fs.write(remote, fileText, { mkdir: true });
                return ok(`New file created successfully at: ${display}`);
            }
            case 'str_replace': {
                const oldValue = requiredForCommand(strArg(args, 'old_str'), 'old_str', 'str_replace', false);
                const newValue = strArg(args, 'new_str') ?? '';
                const type = await statExisting(fs, remote, display, 'str_replace');
                if (type !== 'file')
                    throw new FsStyleError(`cannot edit "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE');
                const state = await readRemoteText(sftp, target.remoteRoot, remote, display);
                const offsets = matchOffsets(state.content, oldValue);
                const offset = offsets[0];
                if (offset === undefined) {
                    throw new FsStyleError(`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${display}.`, 'FS_EDIT_NOT_FOUND');
                }
                if (offsets.length > 1) {
                    throw new FsStyleError(`No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lineNumbersAt(state.content, offsets).join(', ')}]. Please ensure it is unique`, 'FS_AMBIGUOUS_EDIT');
                }
                const after = state.content.slice(0, offset) + newValue + state.content.slice(offset + oldValue.length);
                await writeRemoteText(sftp, remote, after, state.mtime, display);
                return ok(`The file ${display} has been edited successfully.`);
            }
            case 'insert': {
                const insertLine = args.insert_line;
                if (insertLine === undefined)
                    throw new Error('Parameter `insert_line` is required for command: insert');
                const value = requiredForCommand(strArg(args, 'new_str'), 'new_str', 'insert');
                const type = await statExisting(fs, remote, display, 'insert');
                if (type !== 'file')
                    throw new FsStyleError(`cannot insert into "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE');
                const state = await readRemoteText(sftp, target.remoteRoot, remote, display);
                const lines = state.content.split('\n');
                if (typeof insertLine !== 'number' || !Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
                    throw new Error(`Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`);
                }
                const after = [...lines.slice(0, insertLine), ...value.split('\n'), ...lines.slice(insertLine)].join('\n');
                await writeRemoteText(sftp, remote, after, state.mtime, display);
                return ok(`The file ${display} has been edited successfully.`);
            }
        }
        throw new Error(`unknown command: ${command}`); // unreachable — command is validated above
    });
}
// --- glob / grep ----------------------------------------------------------------
/**
 * Resolve the search directory for glob/grep: an explicit path maps like any
 * fs path (outside → null → pass through); no path means the session
 * workspace, which is only ours when the agent session lives in the
 * placeholder. 'search' distinguishes the two in error messages.
 */
function searchDir(target, exec, args) {
    const rawPath = args.path;
    if (rawPath !== undefined && typeof rawPath !== 'string')
        return null; // invalid → native validation
    if (typeof rawPath === 'string') {
        const mapped = toRemotePath(target, rawPath);
        return mapped === null ? null : { remoteDir: mapped };
    }
    if (!sessionInsidePlaceholder(target, exec))
        return null;
    return { remoteDir: target.remoteRoot };
}
/** Remote glob: `rg --files -g` when available, `find` as the fallback (best-effort glob). */
async function shimGlob(deps, target, exec, args) {
    const pattern = strArg(args, 'pattern');
    if (pattern === undefined)
        return null;
    const dir = searchDir(target, exec, args);
    if (dir === null)
        return null;
    return guarded(async () => {
        if (pattern.trim().length === 0)
            throw new Error('pattern must be a non-empty string');
        const fallback = pattern.includes('/') ? `find . -type f -path ${shq(`./${pattern}`)}` : `find . -type f -name ${shq(pattern)}`;
        const command = `if command -v rg >/dev/null 2>&1; then rg --files -g ${shq(pattern)}; else ${fallback}; fi`;
        const res = await execRemote(deps, target, command, { cwd: dir.remoteDir, timeoutMs: deps.config.commandTimeoutMs }, exec.signal);
        if (res === 'aborted')
            return fail('command aborted (remote execution interrupted)');
        if (res.code !== 0 && res.code !== 1) {
            throw new Error(`remote glob failed (exit code ${res.code ?? 'null'}): ${(res.stderr || res.stdout).trim()}`);
        }
        const displayDir = toLocalPath(target, dir.remoteDir);
        const paths = res.stdout
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => (line.startsWith('./') ? line.slice(2) : line))
            .map((rel) => join(displayDir, ...rel.split('/')));
        // Native glob output: { root, paths } — the complete list; the rendered
        // text stays capped at GLOB_MAX_RESULTS.
        const shown = paths.slice(0, GLOB_MAX_RESULTS);
        return okValue({ root: displayDir, paths }, shown.length === 0 ? 'No files found' : shown.join('\n'));
    });
}
/** Parse `path:line:text` rows; the greedy path keeps colons inside file names working. */
function parseGrepStdout(target, stdout) {
    const matches = [];
    for (const raw of stdout.split('\n')) {
        if (raw === '')
            continue;
        const m = /^(.*):(\d+):(.*)$/.exec(raw);
        const path = m?.[1];
        const lineNumber = m?.[2];
        const line = m?.[3];
        if (path === undefined || lineNumber === undefined || line === undefined)
            continue;
        matches.push({ path: toLocalPath(target, path), lineNumber: Number(lineNumber), line });
    }
    return matches;
}
/** Native grep render: found-count header, matches grouped by file (`Line N: text`). */
function renderGrepMatches(matches) {
    if (matches.length === 0)
        return 'No matches found';
    const kept = matches.slice(0, GREP_MAX_MATCHES);
    const byFile = new Map();
    for (const match of kept) {
        const group = byFile.get(match.path);
        if (group !== undefined)
            group.push(match);
        else
            byFile.set(match.path, [match]);
    }
    const sections = [];
    for (const [path, group] of byFile) {
        sections.push(`${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`);
    }
    const header = matches.length > GREP_MAX_MATCHES
        ? `Found ${kept.length} of ${matches.length} matches`
        : `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`;
    return `${header}\n\n${sections.join('\n\n')}`;
}
/** Remote grep: `rg --line-number --with-filename` when available, `grep -rnE` fallback. */
async function shimGrep(deps, target, exec, args) {
    const pattern = strArg(args, 'pattern');
    if (pattern === undefined)
        return null;
    const include = strArg(args, 'include');
    if (args.include !== undefined && include === undefined)
        return null; // invalid → native validation
    const dir = searchDir(target, exec, args);
    if (dir === null)
        return null;
    return guarded(async () => {
        if (pattern.trim().length === 0)
            throw new Error('pattern must be a non-empty string');
        if (include !== undefined && include.trim().length === 0)
            throw new Error('include must be a non-empty glob when given');
        const rgInclude = include !== undefined ? ` -g ${shq(include)}` : '';
        const grepInclude = include !== undefined ? ` --include=${shq(include)}` : '';
        const command = `if command -v rg >/dev/null 2>&1; then rg --line-number --with-filename${rgInclude} -e ${shq(pattern)} ${shq(dir.remoteDir)}; else grep -rnE${grepInclude} -e ${shq(pattern)} ${shq(dir.remoteDir)}; fi`;
        const res = await execRemote(deps, target, command, { cwd: dir.remoteDir, timeoutMs: deps.config.commandTimeoutMs }, exec.signal);
        if (res === 'aborted')
            return fail('command aborted (remote execution interrupted)');
        if (res.code !== 0 && res.code !== 1) {
            throw new Error(`remote grep failed (exit code ${res.code ?? 'null'}): ${(res.stderr || res.stdout).trim()}`);
        }
        // Native grep output: { matches: [{ path, lineNumber, line }] } — the
        // complete list; the rendered text stays capped at GREP_MAX_MATCHES.
        const matches = parseGrepStdout(target, res.stdout);
        return okValue({ matches }, renderGrepMatches(matches));
    });
}
// --- bash -----------------------------------------------------------------------
/** ssh-pool appends this to a capped stream; the structured result reports it as the truncated flag. */
const TRUNC_SUFFIX = '\n…[truncated]';
/** Native bash result body: stdout, an optional [stderr] section, then status markers. */
function renderBashResult(res, timeoutMs, persistent) {
    const out = res.stdout.replace(/\n+$/, '');
    const err = res.stderr.replace(/\n+$/, '');
    let body = out;
    if (err.length > 0) {
        if (body.length > 0)
            body += '\n';
        body += `[stderr]\n${err}`;
    }
    if (body.length === 0)
        body = '(no output)';
    const markers = [];
    if (res.timedOut)
        markers.push(`[timed out after ${timeoutMs}ms]`);
    if (res.signal !== null)
        markers.push(`[killed by signal: ${res.signal}]`);
    else if (res.code !== 0)
        markers.push(`[exit code: ${res.code ?? 'null'}]`);
    // The one place a shim note is allowed: a persistent-shell call degrades to
    // a one-shot remote exec, and the model must know state does not carry over.
    if (persistent) {
        markers.push('(dsh-rw shim: persistent bash ran as a one-shot remote command — shell state (cwd, exports) is NOT preserved between calls)');
    }
    if (markers.length === 0)
        return body;
    return `${body}\n${markers.join('\n')}`;
}
/**
 * Both bash plugins register as "bash": dsh-tool-bash (one-shot) declares
 * workdir/timeoutMs/description parameters, dsh-tool-bash-persistent declares
 * only command. The caller-visible definition decides the flavor.
 */
function isPersistentBash(deps, exec) {
    const def = deps.getTool?.('bash', exec.agent);
    const props = def?.parameters?.properties;
    if (props === undefined || props === null || typeof props !== 'object')
        return false;
    return !('workdir' in props) && !('timeoutMs' in props) && !('description' in props);
}
/** Replace every placeholder path form in the command with the remote root. */
function rewriteCommand(target, command) {
    const roots = [...new Set([target.localRoot, ...target.localRoots])].sort((a, b) => b.length - a.length);
    let rewritten = command;
    for (const root of roots)
        rewritten = rewritten.split(root).join(target.remoteRoot);
    return rewritten;
}
/**
 * Native `bash` (either flavor): gated on shimBash and the session cwd living
 * in the placeholder. The command is rewritten to remote paths and runs with
 * the remote workspace root as cwd; an explicit workdir maps like any fs path
 * (outside → conservative pass-through). exec.signal aborts interrupt the
 * remote execution.
 */
async function shimBash(deps, target, exec, args) {
    if (!deps.config.shimBash)
        return null;
    if (!sessionInsidePlaceholder(target, exec))
        return null;
    const command = strArg(args, 'command');
    if (command === undefined)
        return null;
    if (args.run_in_background === true)
        return null; // no remote background jobs — pass through
    if (args.workdir !== undefined && typeof args.workdir !== 'string')
        return null; // invalid → native validation
    let cwd = target.remoteRoot;
    if (typeof args.workdir === 'string') {
        const mapped = toRemotePath(target, args.workdir);
        if (mapped === null)
            return null;
        cwd = mapped;
    }
    return guarded(async () => {
        if (command.trim().length === 0)
            throw new Error('command must be a non-empty string');
        const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
            ? Math.floor(args.timeoutMs)
            : deps.config.commandTimeoutMs;
        const rewritten = rewriteCommand(target, command);
        const res = await execRemote(deps, target, rewritten, { cwd, timeoutMs }, exec.signal);
        if (res === 'aborted')
            return fail('command aborted (remote execution interrupted)');
        // The registry validates bash results against the native tool's oneOf
        // output schema (foreground/background), so value must be the structured
        // foreground object; the rendered text stays the model-facing content.
        return {
            isError: false,
            value: {
                kind: 'foreground',
                exitCode: res.code,
                signal: res.signal,
                timedOut: res.timedOut,
                aborted: false,
                timeoutMs,
                stdout: { text: res.stdout, truncated: res.stdout.endsWith(TRUNC_SUFFIX) },
                stderr: { text: res.stderr, truncated: res.stderr.endsWith(TRUNC_SUFFIX) },
            },
            content: [{ type: 'text', text: renderBashResult(res, timeoutMs, isPersistentBash(deps, exec)) }],
        };
    });
}
// --- the middlewares --------------------------------------------------------------
export function makeShim(deps) {
    const onExecute = async (exec, next) => {
        if (!deps.config.shim)
            return next();
        const target = activeTarget(deps, exec);
        if (process.env.DSH_RW_DEBUG) {
            console.log('[dsh-rw shim] dispatch', {
                name: exec.name,
                target: target === null ? null : `${target.entry.alias}:${target.localRoot}`,
                hasAgent: exec.agent !== undefined && exec.agent !== null,
                cwd: agentCwd(exec) ?? null,
                inside: target === null ? null : sessionInsidePlaceholder(target, exec),
            });
        }
        if (target === null) {
            // The agent cwd pointing at a dsh-rw placeholder whose host is gone
            // means the user expects remote-backed native tools; never silently run
            // them on the local empty placeholder. But the block is path-aware:
            // only calls that would actually TOUCH the broken placeholder fail —
            // calls whose paths live elsewhere still pass through to the local
            // tool, exactly as they do when the remote is healthy.
            const broken = brokenPlaceholder(deps, exec);
            if (broken !== null && callTouchesPlaceholder(exec.name, objectArgs(exec.arguments), localRootsOf(broken.dir), broken.dir)) {
                return fail(blockedMessage(broken), { name: 'RwError', code: 'NOT_CONNECTED' });
            }
            return next();
        }
        const args = objectArgs(exec.arguments);
        if (args === null)
            return next();
        switch (exec.name) {
            case 'read':
                return (await shimRead(deps, target, args)) ?? next();
            case 'write':
                return (await shimWrite(deps, target, args)) ?? next();
            case 'edit':
                return (await shimEdit(deps, target, args)) ?? next();
            case 'str_replace_editor':
                return (await shimStrReplaceEditor(deps, target, args)) ?? next();
            case 'glob':
                return (await shimGlob(deps, target, exec, args)) ?? next();
            case 'grep':
                return (await shimGrep(deps, target, exec, args)) ?? next();
            case 'bash':
                return (await shimBash(deps, target, exec, args)) ?? next();
            default:
                return next();
        }
    };
    const onPreExecute = async (exec, next) => {
        if (!deps.config.shim || !deps.config.shimBash || deps.config.shimBashApproval !== 'ask')
            return next();
        if (exec.name !== 'bash')
            return next();
        const target = activeTarget(deps, exec);
        if (target === null)
            return next();
        if (!sessionInsidePlaceholder(target, exec))
            return next();
        const args = objectArgs(exec.arguments);
        if (args?.run_in_background === true)
            return next(); // passes through locally in onExecute too
        // Never-ask presets (danger-full-access): an ask would auto-reject without
        // a dialog, so stand down — onExecute still intercepts and runs remotely.
        if (deps.approvalPolicyOf?.(exec.agent?.session) === 'never')
            return next();
        if (process.env.DSH_RW_DEBUG) {
            console.log(`[dsh-rw shim] pre-execute: ask approval for bash on remote host '${target.entry.alias}'`);
        }
        return { kind: 'ask', reason: `run on remote host '${target.entry.alias}' (dsh-rw shim)` };
    };
    return { onExecute, onPreExecute };
}
