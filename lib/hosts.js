// dsh-rw — host inventory: OpenSSH config parsing + manually added hosts.
//
// Sources of truth:
//   - ~/.ssh/config (or opts.sshConfigPath), re-read when its mtime changes
//   - a JSON store for manual entries (default ~/.dsh/dsh-rw.json), written
//     atomically (tmp + rename) with mode 0600 inside a 0700 directory
//
// The store file may hold passwords/passphrases (it is 0600 for that reason);
// never log its contents or echo them into error messages.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { RwError } from './errors.js';
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const DEFAULT_KEY_CANDIDATES = ['id_ed25519', 'id_rsa', 'id_ecdsa'];
/** Expand a leading `~` (or `~/...`) against the current user's home. */
export function expandHome(p) {
    if (p === '~')
        return homedir();
    if (p.startsWith('~/'))
        return join(homedir(), p.slice(2));
    return p;
}
/**
 * First existing default private key, mirroring ssh(1) default identity
 * probing order (~/.ssh/id_ed25519, id_rsa, id_ecdsa). '' when none exist —
 * the entry then surfaces as keyReady=false instead of pointing at a guess.
 */
function probeDefaultKey() {
    for (const name of DEFAULT_KEY_CANDIDATES) {
        const p = join(homedir(), '.ssh', name);
        if (existsSync(p))
            return p;
    }
    return '';
}
function stripComment(line) {
    // Whole-line comments, plus inline `  # ...` (hash preceded by whitespace).
    const hash = line.search(/(^|\s)#/);
    return (hash === -1 ? line : line.slice(0, hash)).trim();
}
/**
 * Parse OpenSSH ssh_config text into host entries. Pure function.
 *
 * Rules: first pattern of each `Host` line wins; patterns containing
 * `*` `?` `!` are skipped; blocks without HostName are skipped; directives
 * are case-insensitive; an invalid Port falls back to 22; User falls back to
 * defaultUser ?? 'root'. Include/Match blocks are ignored (Match content is
 * skipped until the next Host). Without IdentityFile, auth is key-based with
 * the first existing default private key (ssh(1) behavior; '' when none).
 */
export function parseSshConfig(text, defaultUser) {
    const entries = [];
    let current;
    let skip = false; // inside a wildcard/negated Host block or a Match block
    const flush = () => {
        if (current?.hostName) {
            const keyPath = current.identityFile ? expandHome(current.identityFile) : probeDefaultKey();
            entries.push({
                alias: current.alias,
                host: current.hostName,
                port: current.port ?? 22,
                user: current.user ?? defaultUser ?? 'root',
                auth: { kind: 'key', keyPath },
                source: 'ssh-config',
            });
        }
        current = undefined;
    };
    for (const rawLine of text.split('\n')) {
        const line = stripComment(rawLine);
        if (!line)
            continue;
        const sp = line.search(/\s/);
        const keyword = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
        const value = sp === -1 ? '' : line.slice(sp).trim();
        if (keyword === 'match') {
            flush();
            skip = true;
            continue;
        }
        if (keyword === 'host') {
            flush();
            const pattern = value.split(/\s+/)[0] ?? '';
            if (!pattern || pattern.includes('*') || pattern.includes('?') || pattern.includes('!')) {
                skip = true;
            }
            else {
                skip = false;
                current = { alias: pattern };
            }
            continue;
        }
        if (skip || !current)
            continue;
        switch (keyword) {
            case 'hostname':
                current.hostName = value;
                break;
            case 'user':
                current.user = value;
                break;
            case 'port': {
                const n = Number.parseInt(value, 10);
                current.port = Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 22;
                break;
            }
            case 'identityfile':
                current.identityFile = value;
                break;
            default:
                break; // Include and everything else: ignored
        }
    }
    flush();
    return entries;
}
/**
 * Shell-style match for an SSH alias: `*` (any run), `?` (one character).
 * Case-insensitive, because `~/.ssh/config` aliases are used case-insensitively
 * in practice and nobody wants `ORIN` vs `orin` to be a trap.
 */
function globMatches(pattern, value) {
    const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${source}$`, 'i').test(value);
}
export class HostTable {
    sshConfigPath;
    storePath;
    /**
     * Which `~/.ssh/config` aliases are imported. An empty include list means
     * "every alias" (the historical behaviour); exclude always wins. Matching is
     * shell-style against the alias (`*` and `?`), because an Alias is a single
     * path-free token.
     */
    sshConfigInclude;
    sshConfigExclude;
    manual;
    hidden;
    sshCache;
    constructor(opts) {
        this.sshConfigPath = opts?.sshConfigPath ?? join(homedir(), '.ssh', 'config');
        this.storePath = opts?.storePath ?? join(homedir(), '.dsh', 'dsh-rw.json');
        this.sshConfigInclude = opts?.sshConfigInclude ?? [];
        this.sshConfigExclude = opts?.sshConfigExclude ?? [];
        const stored = this.loadStore();
        this.manual = stored.hosts;
        this.hidden = new Set(stored.hidden);
    }
    /** All entries; manual entries shadow ssh-config entries with the same alias. */
    list() {
        const fromConfig = this.sshEntries().filter((e) => !this.manual.some((m) => m.alias === e.alias));
        return [...this.manual, ...fromConfig];
    }
    find(alias) {
        return this.manual.find((e) => e.alias === alias) ?? this.sshEntries().find((e) => e.alias === alias);
    }
    summarize(entry) {
        return {
            alias: entry.alias,
            host: entry.host,
            port: entry.port,
            user: entry.user,
            authKind: entry.auth.kind,
            keyReady: entry.auth.kind === 'key' && entry.auth.keyPath !== '' && existsSync(entry.auth.keyPath),
            passwordSet: entry.auth.kind === 'password' && !!entry.auth.password,
            ...(entry.auth.kind === 'key' ? { keyPath: entry.auth.keyPath } : {}),
            source: entry.source,
        };
    }
    summaries() {
        return this.list().map((e) => this.summarize(e));
    }
    /** Validate a manual host's connection details and build its entry. */
    buildManualEntry(alias, payload) {
        if (!ALIAS_RE.test(alias)) {
            throw new RwError('INVALID_INPUT', `invalid alias: ${JSON.stringify(alias)}`);
        }
        if (!payload.host) {
            throw new RwError('INVALID_INPUT', 'host is required');
        }
        const port = payload.port ?? 22;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new RwError('INVALID_INPUT', `invalid port: ${payload.port}`);
        }
        const hasKey = !!payload.keyPath;
        const hasPassword = !!payload.password;
        if (!hasKey && !hasPassword) {
            throw new RwError('INVALID_INPUT', 'either keyPath or password is required');
        }
        return {
            alias,
            host: payload.host,
            port,
            user: payload.user,
            // A key path wins when both are given: key auth is the steady state,
            // passwords are the fallback for hosts that cannot take keys.
            auth: hasKey
                ? { kind: 'key', keyPath: payload.keyPath, ...(payload.passphrase ? { passphrase: payload.passphrase } : {}) }
                : { kind: 'password', password: payload.password },
            source: 'manual',
        };
    }
    addManual(payload) {
        const entry = this.buildManualEntry(payload.alias, payload);
        if (this.manual.some((e) => e.alias === payload.alias)) {
            throw new RwError('INVALID_INPUT', `manual host already exists: ${payload.alias}`);
        }
        this.manual.push(entry);
        this.saveStore();
        return entry;
    }
    /**
     * Replace one manual host's connection details in place. The alias is the
     * record key, so it cannot change (a rename is remove + add), and
     * ssh-config hosts are not editable here — their source of truth is
     * ~/.ssh/config.
     */
    updateManual(alias, payload) {
        const index = this.manual.findIndex((e) => e.alias === alias);
        const existing = this.manual[index];
        if (existing === undefined)
            throw new RwError('INVALID_INPUT', `no manual host named ${JSON.stringify(alias)}`);
        // An edit that only moves the address must not wipe the credential: when
        // neither a password nor a key path is supplied, keep what is stored.
        const withCredential = payload.password !== undefined || payload.keyPath !== undefined
            ? payload
            : existing.auth.kind === 'key'
                ? {
                    ...payload,
                    keyPath: existing.auth.keyPath,
                    ...(existing.auth.passphrase !== undefined ? { passphrase: existing.auth.passphrase } : {}),
                }
                : { ...payload, password: existing.auth.password };
        const entry = this.buildManualEntry(alias, withCredential);
        this.manual[index] = entry;
        this.saveStore();
        return entry;
    }
    /** Whether one ssh-config alias passes the include/exclude globs. */
    importsFromSshConfig(alias) {
        if (this.hidden.has(alias))
            return false;
        if (this.sshConfigExclude.some((pattern) => globMatches(pattern, alias)))
            return false;
        if (this.sshConfigInclude.length === 0)
            return true;
        return this.sshConfigInclude.some((pattern) => globMatches(pattern, alias));
    }
    /**
     * Drop one ssh-config alias from the list without touching ~/.ssh/config.
     * Manual hosts are deleted instead (they exist only here), so hiding one is
     * rejected rather than silently doing nothing.
     */
    hide(alias) {
        const entry = this.find(alias);
        if (entry === undefined)
            throw new RwError('INVALID_INPUT', `unknown host alias: ${JSON.stringify(alias)}`);
        if (entry.source !== 'ssh-config') {
            throw new RwError('INVALID_INPUT', `host ${JSON.stringify(alias)} is a manual entry — remove it instead of hiding it`);
        }
        this.hidden.add(alias);
        this.sshCache = undefined;
        this.saveStore();
    }
    /** Put a hidden alias back in the list. */
    unhide(alias) {
        if (!this.hidden.delete(alias))
            return;
        this.sshCache = undefined;
        this.saveStore();
    }
    /** Aliases currently hidden from the host list (sorted, for display). */
    hiddenAliases() {
        return [...this.hidden].sort();
    }
    removeManual(alias) {
        const next = this.manual.filter((e) => e.alias !== alias);
        if (next.length !== this.manual.length) {
            this.manual = next;
            this.saveStore();
        }
    }
    sshEntries() {
        let mtimeMs = -1;
        try {
            mtimeMs = statSync(this.sshConfigPath).mtimeMs;
        }
        catch {
            // missing/unreadable config → treated as empty
        }
        if (this.sshCache && this.sshCache.mtimeMs === mtimeMs)
            return this.sshCache.entries;
        let entries = [];
        if (mtimeMs !== -1) {
            try {
                entries = parseSshConfig(readFileSync(this.sshConfigPath, 'utf8'), process.env.USER);
            }
            catch {
                entries = [];
            }
        }
        const filtered = entries.filter((entry) => this.importsFromSshConfig(entry.alias));
        this.sshCache = { mtimeMs, entries: filtered };
        return filtered;
    }
    loadStore() {
        let raw;
        try {
            raw = readFileSync(this.storePath, 'utf8');
        }
        catch {
            return { hosts: [], hidden: [] };
        }
        try {
            const data = JSON.parse(raw);
            if (data?.version !== 1 || !Array.isArray(data.hosts))
                throw new Error('bad shape');
            const hidden = Array.isArray(data.hidden) ? data.hidden.filter((a) => typeof a === 'string') : [];
            return { hosts: data.hosts.map((h) => ({ ...h, source: 'manual' })), hidden };
        }
        catch {
            // Never overwrite a corrupt store: move it aside for manual inspection.
            try {
                renameSync(this.storePath, `${this.storePath}.corrupt-${Date.now()}`);
            }
            catch {
                // best effort; an unmoved corrupt file is still not loaded
            }
            return { hosts: [], hidden: [] };
        }
    }
    /** Atomic write: tmp file + rename, mode 0600, parent directory 0700. */
    saveStore() {
        const dir = dirname(this.storePath);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        const data = {
            version: 1,
            hosts: this.manual.map(({ alias, host, port, user, auth }) => ({ alias, host, port, user, auth })),
            ...(this.hidden.size > 0 ? { hidden: [...this.hidden].sort() } : {}),
        };
        const tmp = `${this.storePath}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.storePath);
    }
}
