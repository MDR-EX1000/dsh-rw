// dsh-rw — local placeholder directories. DSH's native workspace flow needs a
// real local directory (fs.realpath must succeed), so each (alias, remotePath)
// pair gets an empty placeholder holding only private metadata — never a copy of
// remote files. The workspace meta file carries no credentials, and the host
// namespace owner record does not grant remote-root access. Both are written
// 0600 inside a 0700 directory like every other dsh-rw state file.
//
// Layout (2.0): the placeholders of one host MIRROR its remote paths under a
// private root that lives OUTSIDE the user's home directory:
//
//   <root>/<alias>                 host dir    (no meta unless remote '/' is picked)
//   <root>/<alias>/data            workspace   (remotePath '/data')
//   <root>/<alias>/home/me/proj    workspace   (remotePath '/home/me/proj';
//                                  home/ and home/me/ are meta-less 0700 dirs)
//
// Two reasons. (1) DSH nests a workspace under the closest registered local
// ancestor; with the root outside ~, a host's main workspace (default /data)
// is its own top-level node instead of hanging off the home workspace. (2)
// Because local layout == remote layout, local → remote translation is "strip
// <root>/<alias>, keep the rest": a local path reached through an outer and an
// inner workspace maps to the SAME remote path. A placeholder therefore must never live at a
// location other than its mirror position, which is why ownership is decided
// by location (a meta whose own mirror position differs is ignored) and why
// collisions are errors rather than hash-suffixed siblings.
//
// Legacy placeholders (≤ 1.6: ~/.dsh/remote-workspaces/<alias>/<name>, clean
// names, display names, or hash suffixes) are still FOUND by every lookup —
// the session that works in one keeps working — but new placeholders are
// always created in the mirror layout.
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { RwError } from './errors.js';
import { normalizeRemote } from './guard.js';
export const PLACEHOLDER_META_FILE = '.dsh-rw-meta.json';
/** Host namespace ownership only; never makes remote '/' a workspace. */
export const HOST_OWNER_FILE = '.dsh-rw-host.json';
const HOST_NAMESPACE_SCAN_LIMIT = 10_000;
const PLACEHOLDER_NOTE = 'placeholder only — not a copy of remote files';
/** Anything outside [a-zA-Z0-9._-] becomes '_'; dot-only names cannot climb out of the root. */
export function sanitizeAlias(alias) {
    const clean = alias.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (clean === '')
        return '_';
    return /^\.+$/.test(clean) ? clean.replace(/\./g, '_') : clean;
}
function sanitizeUser(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'user';
}
function currentUserName() {
    try {
        return userInfo().username;
    }
    catch {
        return process.env.USER ?? process.env.USERNAME ?? 'user';
    }
}
/**
 * The default mirror root. macOS: /Users/Shared/dsh-rw-<user> (always exists,
 * never under ~, so DSH's workspace tree shows each host at the top level).
 * Elsewhere: ~/.dsh/rw-workspaces — which may itself sit below a registered
 * home workspace; set `placeholderRoot` to move it.
 */
export function defaultPlaceholderRoot(platform = process.platform) {
    if (platform === 'darwin')
        return join('/Users/Shared', `dsh-rw-${sanitizeUser(currentUserName())}`);
    return join(homedir(), '.dsh', 'rw-workspaces');
}
/** The ≤ 1.6 placeholder base (lookups only). */
export function legacyPlaceholderBaseDir() {
    return join(homedir(), '.dsh', 'remote-workspaces');
}
function expandLocalHome(p) {
    if (p === '~')
        return homedir();
    if (p.startsWith('~/'))
        return join(homedir(), p.slice(2));
    return p;
}
/** The effective mirror root (resolved, `~` expanded). */
export function placeholderRootOf(loc = {}) {
    return loc.root !== undefined && loc.root !== '' ? resolve(expandLocalHome(loc.root)) : defaultPlaceholderRoot(loc.platform);
}
function legacyBaseOf(loc) {
    return loc.legacyBaseDir ?? legacyPlaceholderBaseDir();
}
function errorCode(err) {
    return err && typeof err === 'object' && 'code' in err ? err.code : undefined;
}
function messageOf(err) {
    return err instanceof Error ? err.message : String(err);
}
function unsafeRoot(root, why) {
    return new RwError('UNSAFE_PLACEHOLDER_ROOT', `unsafe dsh-rw placeholder root ${root}: ${why} — it must be a real directory owned by the current user; ` +
        'remove it or set placeholderRoot in the dsh-rw plugin config');
}
/**
 * Create (if needed) and validate the mirror root: a real directory — not a
 * symlink — owned by the current user, mode 0700. The macOS default lives in
 * the world-writable /Users/Shared, so another account could pre-create the
 * name; these checks are what keep placeholders out of someone else's tree.
 * The default root is created non-recursively (/Users/Shared always exists and
 * must keep its own mode); a configured root is created recursively.
 */
export function ensurePlaceholderRoot(loc = {}) {
    const root = placeholderRootOf(loc);
    const platform = loc.platform ?? process.platform;
    const custom = loc.root !== undefined && loc.root !== '';
    const recursive = custom || platform !== 'darwin';
    try {
        mkdirSync(root, { recursive, mode: 0o700 });
    }
    catch (err) {
        if (errorCode(err) !== 'EEXIST')
            throw unsafeRoot(root, `cannot create it (${messageOf(err)})`);
    }
    let st;
    try {
        st = lstatSync(root);
    }
    catch (err) {
        throw unsafeRoot(root, `cannot stat it (${messageOf(err)})`);
    }
    if (st.isSymbolicLink())
        throw unsafeRoot(root, 'it is a symbolic link');
    if (!st.isDirectory())
        throw unsafeRoot(root, 'it is not a directory');
    const uid = (loc.currentUid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : undefined)))();
    if (uid !== undefined && st.uid !== uid)
        throw unsafeRoot(root, `it is owned by uid ${st.uid}, not the current user (uid ${uid})`);
    try {
        chmodSync(root, 0o700);
    }
    catch (err) {
        throw unsafeRoot(root, `cannot restrict it to 0700 (${messageOf(err)})`);
    }
    return root;
}
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const WIN_INVALID = /[<>:"\\|?*\u0000-\u001f]/;
/** Reject a path segment the local file system cannot (or must not) hold. */
function assertSegment(seg, what, platform) {
    if (seg === PLACEHOLDER_META_FILE || seg === HOST_OWNER_FILE) {
        throw new RwError('INVALID_INPUT', `${what} ${JSON.stringify(seg)} collides with a reserved dsh-rw metadata file name`);
    }
    if (platform !== 'win32')
        return;
    if (WIN_INVALID.test(seg)) {
        throw new RwError('INVALID_INPUT', `${what} ${JSON.stringify(seg)} contains a character Windows cannot store in a directory name`);
    }
    if (/[. ]$/.test(seg)) {
        throw new RwError('INVALID_INPUT', `${what} ${JSON.stringify(seg)} ends with a dot or a space, which Windows cannot store`);
    }
    if (WIN_RESERVED.test(seg)) {
        throw new RwError('INVALID_INPUT', `${what} ${JSON.stringify(seg)} is a reserved device name on Windows`);
    }
}
/** The non-empty segments of a normalized remote path ('/' → []). */
function remoteSegments(remotePath) {
    return normalizeRemote(remotePath)
        .split('/')
        .filter((s) => s !== '');
}
/** `<root>/<sanitized alias>` for an explicit root form. */
function hostRootUnder(root, alias) {
    return join(root, sanitizeAlias(alias));
}
/** The mirror position of (alias, remotePath) under an explicit root form; throws on unstorable segments. */
function mirrorUnder(root, alias, remotePath, platform) {
    const aliasSeg = sanitizeAlias(alias);
    assertSegment(aliasSeg, 'host alias directory', platform);
    const segs = remoteSegments(remotePath);
    for (const seg of segs)
        assertSegment(seg, 'remote path segment', platform);
    return join(root, aliasSeg, ...segs);
}
/** The host-root placeholder directory (`<root>/<alias>`, remote '/'). */
export function hostRootDir(alias, loc = {}) {
    return hostRootUnder(placeholderRootOf(loc), alias);
}
/** Where (alias, remotePath) lives in the mirror layout (computed, not checked on disk). */
export function mirrorPlaceholderDir(alias, remotePath, loc = {}) {
    return mirrorUnder(placeholderRootOf(loc), alias, remotePath, loc.platform ?? process.platform);
}
/**
 * On a case-insensitive file system an existing `<parent>/<seg>` may really be
 * `<parent>/<Seg>`. Such a pair would silently share one placeholder, so the
 * exact spelling must be present in the parent listing (unicode-normalization
 * differences — HFS+ stores NFD — are not a conflict).
 */
function assertExactSpelling(parent, seg) {
    let names;
    try {
        names = readdirSync(parent);
    }
    catch {
        return;
    }
    const want = seg.normalize('NFC');
    if (names.some((name) => name === seg || name.normalize('NFC') === want))
        return;
    const other = names.find((name) => name.normalize('NFC').toLowerCase() === want.toLowerCase());
    throw new RwError('INVALID_INPUT', `placeholder directory ${JSON.stringify(join(parent, seg))} collides with the existing ${JSON.stringify(join(parent, other ?? '?'))}: ` +
        `this local file system is case-insensitive, so ${JSON.stringify(seg)} and ${JSON.stringify(other ?? '?')} name the same directory`);
}
/** mkdir -p one segment at a time below `base`: 0700, plain directories only, exact spelling. */
function ensureDirChain(base, segments) {
    let cur = base;
    for (const seg of segments) {
        const next = join(cur, seg);
        let st;
        try {
            st = lstatSync(next);
        }
        catch (err) {
            if (errorCode(err) !== 'ENOENT')
                throw new RwError('INVALID_INPUT', `cannot inspect ${next}: ${messageOf(err)}`);
        }
        if (st === undefined) {
            try {
                mkdirSync(next, { mode: 0o700 });
            }
            catch (err) {
                if (errorCode(err) !== 'EEXIST')
                    throw new RwError('INVALID_INPUT', `cannot create ${next}: ${messageOf(err)}`);
                assertExactSpelling(cur, seg);
            }
            st = lstatSync(next);
        }
        else {
            assertExactSpelling(cur, seg);
        }
        if (st.isSymbolicLink() || !st.isDirectory()) {
            throw new RwError('INVALID_INPUT', `${next} exists and is not a plain directory — cannot place a dsh-rw placeholder there`);
        }
        cur = next;
    }
    return cur;
}
/** Unicode-equivalent spellings count only if the filesystem proves they are the same directory. */
function sameMirrorPosition(expected, actual) {
    if (expected === actual)
        return true;
    if (expected.normalize('NFC') !== actual.normalize('NFC'))
        return false;
    try {
        const a = lstatSync(expected, { bigint: true });
        const b = lstatSync(actual, { bigint: true });
        return a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink() &&
            a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
    }
    catch {
        return false;
    }
}
/** An alias owns its entire host-root namespace, not just one project leaf. */
function namespaceConflict(hostRoot, alias, owner) {
    return new RwError('INVALID_INPUT', `placeholder host directory ${hostRoot} belongs to alias ${JSON.stringify(owner)}, not ${JSON.stringify(alias)} ` +
        '(the aliases map to the same directory name) — choose a distinct SSH alias or placeholderRoot; no paths were remapped');
}
/** Read-only ownership check. Audit old trees too, including those touched by an older process. */
function assertHostOwner(hostRoot, alias, platform) {
    const ownerFile = join(hostRoot, HOST_OWNER_FILE);
    let hasOwner = false;
    try {
        const st = lstatSync(ownerFile);
        if (!st.isFile() || st.isSymbolicLink())
            throw new Error('owner record is not a regular file');
        const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
        if (owner?.plugin !== 'dsh-rw' || owner.version !== 1 || typeof owner.alias !== 'string') {
            throw new Error('invalid owner record');
        }
        if (owner.alias !== alias)
            throw namespaceConflict(hostRoot, alias, owner.alias);
        hasOwner = true;
    }
    catch (err) {
        if (err instanceof RwError)
            throw err;
        if (errorCode(err) !== 'ENOENT') {
            throw new RwError('INVALID_INPUT', `cannot verify host ownership at ${ownerFile}: ${messageOf(err)}`);
        }
    }
    // A marker alone is not enough: an older DSH process may still add a foreign
    // leaf. Inspect only plain placeholder directories, never follow symlinks.
    const pending = [hostRoot];
    let seen = 0;
    while (pending.length > 0) {
        const dir = pending.pop();
        const meta = readPlaceholderMeta(dir);
        if (meta !== null) {
            let expected;
            try {
                expected = mirrorUnder(dirname(hostRoot), meta.alias, meta.remotePath, platform);
            }
            catch {
                // A misplaced/unstorable meta is not a claim on this namespace.
            }
            if (expected !== undefined && sameMirrorPosition(expected, dir) && meta.alias !== alias) {
                throw namespaceConflict(hostRoot, alias, meta.alias);
            }
        }
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch (err) {
            throw new RwError('INVALID_INPUT', `cannot verify host namespace ${hostRoot}: ${messageOf(err)}`);
        }
        for (const entry of entries) {
            if (++seen > HOST_NAMESPACE_SCAN_LIMIT) {
                throw new RwError('INVALID_INPUT', `host namespace ${hostRoot} exceeds the ${HOST_NAMESPACE_SCAN_LIMIT}-entry ownership check limit`);
            }
            if (entry.isDirectory() && !entry.isSymbolicLink())
                pending.push(join(dir, entry.name));
        }
    }
    return hasOwner;
}
/** Reserve once, exclusively: another profile/process cannot overwrite an alias's claim. */
function ensureHostOwner(hostRoot, alias, platform) {
    if (assertHostOwner(hostRoot, alias, platform))
        return;
    const ownerFile = join(hostRoot, HOST_OWNER_FILE);
    try {
        writeFileSync(ownerFile, `${JSON.stringify({ plugin: 'dsh-rw', version: 1, alias })}\n`, { flag: 'wx', mode: 0o600 });
    }
    catch (err) {
        if (errorCode(err) === 'EEXIST') {
            assertHostOwner(hostRoot, alias, platform);
            return;
        }
        throw new RwError('INVALID_INPUT', `cannot reserve host namespace ${hostRoot}: ${messageOf(err)}`);
    }
}
function writeMeta(dir, meta) {
    chmodSync(dir, 0o700);
    const file = join(dir, PLACEHOLDER_META_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
}
/**
 * Make `dir` the placeholder of (alias, remote). A valid meta naming another
 * workspace is a hard error (location decides ownership — never relocate). A
 * consistent meta is left untouched; changed host/port/user is rewritten in
 * place keeping createdAt; a missing or corrupt meta is (re)written.
 */
function ensureMetaAt(dir, alias, entry, remote) {
    const existing = readPlaceholderMeta(dir);
    if (existing !== null && (existing.alias !== alias || existing.remotePath !== remote)) {
        throw new RwError('INVALID_INPUT', `placeholder directory ${dir} already belongs to host alias ${JSON.stringify(existing.alias)} remote ` +
            `${existing.remotePath} — cannot reuse it for ${JSON.stringify(alias)} remote ${remote}` +
            (existing.alias !== alias ? ' (the two aliases map to the same directory name)' : ''));
    }
    if (existing !== null &&
        existing.host === entry.host &&
        existing.port === entry.port &&
        existing.user === entry.user) {
        return;
    }
    writeMeta(dir, {
        plugin: 'dsh-rw',
        alias,
        host: entry.host,
        port: entry.port,
        user: entry.user,
        remotePath: remote,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        note: PLACEHOLDER_NOTE,
    });
}
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
export function ensurePlaceholder(alias, entry, remotePath, loc = {}) {
    const platform = loc.platform ?? process.platform;
    const remote = normalizeRemote(remotePath);
    const aliasSeg = sanitizeAlias(alias);
    const segs = remoteSegments(remote);
    // Validate every segment before anything touches the disk.
    mirrorUnder('/', alias, remote, platform);
    const root = ensurePlaceholderRoot(loc);
    const hostRoot = ensureDirChain(root, [aliasSeg]);
    ensureHostOwner(hostRoot, alias, platform);
    const dir = ensureDirChain(hostRoot, segs);
    ensureMetaAt(dir, alias, entry, remote);
    return dir;
}
/** Read and validate the meta file; null when missing or corrupt. */
export function readPlaceholderMeta(dir) {
    let raw;
    try {
        raw = readFileSync(join(dir, PLACEHOLDER_META_FILE), 'utf8');
    }
    catch {
        return null;
    }
    try {
        const data = JSON.parse(raw);
        if (data?.plugin !== 'dsh-rw' ||
            typeof data.alias !== 'string' ||
            typeof data.host !== 'string' ||
            typeof data.port !== 'number' ||
            typeof data.user !== 'string' ||
            typeof data.remotePath !== 'string' ||
            typeof data.createdAt !== 'string' ||
            data.note !== PLACEHOLDER_NOTE) {
            return null;
        }
        return data;
    }
    catch {
        return null;
    }
}
/** True when `p` (already resolve()d) is `root` or inside it (path-platform-aware). */
function inside(p, root) {
    return p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
/**
 * realpath of the deepest existing ancestor, with the missing tail re-appended
 * — so a not-yet-created file below a symlinked prefix (macOS /var ↔
 * /private/var) still compares against the real form of the root.
 */
function realpathLoose(p) {
    let cur = p;
    const tail = [];
    for (;;) {
        try {
            const real = realpathSync(cur);
            return tail.length === 0 ? real : join(real, ...tail.reverse());
        }
        catch {
            const parent = dirname(cur);
            if (parent === cur)
                return null;
            tail.push(basename(cur));
            cur = parent;
        }
    }
}
/** The lexical and real forms of a path (deduplicated, lexical first). */
function pathForms(p) {
    const lex = resolve(p);
    const real = realpathLoose(lex);
    return real !== null && real !== lex ? [lex, real] : [lex];
}
/**
 * Mirror-layout lookup: walk from the candidate up to (not including) the
 * root and take the first — i.e. deepest — directory whose meta is valid AND
 * sits exactly at its own mirror position. A meta found anywhere else is
 * ignored: it would map local paths to the wrong remote paths.
 */
function findInMirror(path, loc) {
    const platform = loc.platform ?? process.platform;
    const roots = pathForms(placeholderRootOf(loc));
    for (const cand of pathForms(path)) {
        for (const root of roots) {
            if (cand === root || !inside(cand, root))
                continue;
            const segs = cand
                .slice(root.length)
                .split(sep)
                .filter((s) => s !== '');
            for (let i = segs.length; i >= 1; i--) {
                const dir = join(root, ...segs.slice(0, i));
                const meta = readPlaceholderMeta(dir);
                if (meta === null)
                    continue;
                let expected;
                try {
                    expected = mirrorUnder(root, meta.alias, meta.remotePath, platform);
                }
                catch {
                    continue;
                }
                if (!sameMirrorPosition(expected, dir))
                    continue;
                const hostRoot = hostRootUnder(root, meta.alias);
                assertHostOwner(hostRoot, meta.alias, platform);
                return { dir, meta, layout: 'mirror', hostRoot };
            }
        }
    }
    return null;
}
/** Legacy (≤ 1.6) lookup: scan `<base>/<alias>/<name>` metas for one containing the path. */
function findInLegacy(path, base) {
    let aliasDirNames;
    try {
        aliasDirNames = readdirSync(base);
    }
    catch {
        return null;
    }
    const cands = pathForms(path);
    for (const aliasName of aliasDirNames) {
        const aliasParent = join(base, aliasName);
        let placeholderNames;
        try {
            placeholderNames = readdirSync(aliasParent);
        }
        catch {
            continue;
        }
        for (const name of placeholderNames) {
            const dir = join(aliasParent, name);
            const meta = readPlaceholderMeta(dir);
            if (meta === null)
                continue;
            const dirRoots = [resolve(dir)];
            try {
                const real = realpathSync(dir);
                if (!dirRoots.includes(real))
                    dirRoots.push(real);
            }
            catch {
                // placeholder missing on disk: lexical containment still applies
            }
            if (dirRoots.some((r) => cands.some((c) => inside(c, r))))
                return { dir, meta, layout: 'legacy' };
        }
    }
    return null;
}
/**
 * Find the placeholder whose directory contains `path` (a session cwd or a
 * native tool path argument): the mirror layout first (deepest valid meta
 * wins), then the legacy base. Containment is checked both lexically and via
 * realpath. Null when the path is a real local directory — native tools then
 * legitimately run locally.
 */
export function findPlaceholderByPath(path, loc = {}) {
    return findInMirror(path, loc) ?? findInLegacy(path, legacyBaseOf(loc));
}
/**
 * Locate the placeholder of (alias, remotePath): its mirror position when the
 * meta there matches, else a legacy directory whose meta matches (legacy names
 * are not computable, so that half scans). Null when the workspace was never
 * picked or its meta is lost/corrupt.
 */
export function locatePlaceholder(alias, remotePath, loc = {}) {
    const normalized = normalizeRemote(remotePath);
    let mirrorDir;
    try {
        mirrorDir = mirrorPlaceholderDir(alias, normalized, loc);
    }
    catch {
        // Unstorable segment: no mirror placeholder. Ownership errors below must
        // never be swallowed into a legacy/null (and therefore local) fallback.
    }
    if (mirrorDir !== undefined) {
        const meta = readPlaceholderMeta(mirrorDir);
        if (meta !== null && meta.alias === alias && meta.remotePath === normalized) {
            const hostRoot = hostRootDir(alias, loc);
            assertHostOwner(hostRoot, alias, loc.platform ?? process.platform);
            return { dir: mirrorDir, meta, layout: 'mirror', hostRoot };
        }
    }
    const parent = join(legacyBaseOf(loc), sanitizeAlias(alias));
    let names;
    try {
        names = readdirSync(parent);
    }
    catch {
        return null;
    }
    for (const name of names) {
        const dir = join(parent, name);
        const meta = readPlaceholderMeta(dir);
        if (meta !== null && meta.alias === alias && meta.remotePath === normalized)
            return { dir, meta, layout: 'legacy' };
    }
    return null;
}
/** {@link locatePlaceholder}, directory only. */
export function resolvePlaceholderDir(alias, remotePath, loc = {}) {
    return locatePlaceholder(alias, remotePath, loc)?.dir ?? null;
}
/** Build lookup locations from a deps-style pair (`placeholderRoot` + legacy `placeholderBaseDir`). */
export function placeholderLocationsOf(deps) {
    return {
        ...(deps.placeholderRoot !== undefined ? { root: deps.placeholderRoot } : {}),
        ...(deps.placeholderBaseDir !== undefined ? { legacyBaseDir: deps.placeholderBaseDir } : {}),
    };
}
