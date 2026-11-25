// dsh-rw — per-session state: which host alias each DSH session is connected
// to and which remote workspace root it picked. 2.0 keys this by the DSH
// session id (one file, ~/.dsh/dsh-rw-sessions.json) instead of one global
// record, so two sessions working on different hosts no longer overwrite each
// other. A subagent without its own record inherits its direct parent's
// (header.parentSession), and writes copy-on-write into its own record.
//
// Persistence discipline matches every other dsh-rw state file: atomic
// tmp+rename write, file 0600, parent directory 0700; a corrupt file is moved
// aside (.corrupt-<ts>) rather than overwritten. Only aliases and remote paths
// are stored — never credentials. The ≤ 1.6 file (dsh-rw-session.json) is
// neither read, written nor deleted, so rolling back to 1.6.x still works.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Records kept on disk; the least recently updated beyond this are dropped. */
export const SESSION_RECORD_LIMIT = 500;
const EMPTY = { alias: null, workspace: null };
function normalizeKeys(keys) {
    if (typeof keys === 'string')
        return { id: keys };
    const id = keys?.id ?? '';
    const parentId = keys?.parentId;
    return parentId !== undefined && parentId !== '' && parentId !== id ? { id, parentId } : { id };
}
/** The session header of a DSH agent (`agent.session.header`), read structurally. */
export function sessionHeaderOf(agent) {
    const header = agent?.session?.header;
    if (header === null || typeof header !== 'object')
        return {};
    const h = header;
    return {
        ...(typeof h.id === 'string' && h.id !== '' ? { id: h.id } : {}),
        ...(typeof h.cwd === 'string' && h.cwd !== '' ? { cwd: h.cwd } : {}),
        ...(typeof h.parentSession === 'string' && h.parentSession !== '' ? { parentSession: h.parentSession } : {}),
    };
}
/** Session keys of a DSH agent: its id and its direct parent's id. */
export function sessionKeysOf(agent) {
    const header = sessionHeaderOf(agent);
    return {
        ...(header.id !== undefined ? { id: header.id } : {}),
        ...(header.parentSession !== undefined ? { parentId: header.parentSession } : {}),
    };
}
export class SessionStore {
    storePath;
    records = new Map();
    last = null;
    limit;
    now;
    constructor(storePath = SessionStore.defaultPath(), opts = {}) {
        this.storePath = storePath;
        this.limit = opts.limit ?? SESSION_RECORD_LIMIT;
        this.now = opts.now ?? (() => new Date());
        this.load();
    }
    static defaultPath() {
        return join(homedir(), '.dsh', 'dsh-rw-sessions.json');
    }
    /** The raw record stored under one session id (no parent fallback). */
    record(id) {
        const rec = this.records.get(id);
        return rec === undefined ? undefined : { ...rec };
    }
    /** Session ids currently on record, least recently updated first. */
    ids() {
        return [...this.records.keys()];
    }
    /** Resolved state plus where it came from: own record, else the parent's, else empty. */
    lookup(keys) {
        const { id, parentId } = normalizeKeys(keys);
        const own = this.records.get(id);
        if (own !== undefined)
            return { alias: own.alias, workspace: own.workspace, source: 'own' };
        if (parentId !== undefined) {
            const parent = this.records.get(parentId);
            if (parent !== undefined)
                return { alias: parent.alias, workspace: parent.workspace, source: 'parent' };
        }
        return { ...EMPTY, source: 'none' };
    }
    /** Resolved state for a session (own record → parent's → empty). */
    get(keys) {
        const { alias, workspace } = this.lookup(keys);
        return { alias, workspace };
    }
    /**
     * Merge a patch over the session's resolved state (so a subagent's first
     * write starts from what it inherited) and persist it under its OWN id. A
     * field set to null clears it; omitted fields keep their value.
     */
    set(keys, patch) {
        const { id } = normalizeKeys(keys);
        const next = { ...this.get(keys), ...patch, updatedAt: this.now().toISOString() };
        // Re-insert so Map order tracks recency (the eviction tiebreak).
        this.records.delete(id);
        this.records.set(id, next);
        this.evict();
        this.save();
    }
    /** Drop one session's record (its subagents fall back to nothing). */
    delete(id) {
        if (this.records.delete(id))
            this.save();
    }
    /** The host the picker used last (shown as the picker's default). */
    get lastAlias() {
        return this.last;
    }
    setLastAlias(alias) {
        if (this.last === alias)
            return;
        this.last = alias;
        this.save();
    }
    /** A host was removed: clear it from every session record and from lastAlias. */
    forgetAlias(alias) {
        let changed = false;
        for (const [id, rec] of this.records) {
            if (rec.alias !== alias)
                continue;
            this.records.set(id, { alias: null, workspace: null, updatedAt: rec.updatedAt });
            changed = true;
        }
        if (this.last === alias) {
            this.last = null;
            changed = true;
        }
        if (changed)
            this.save();
    }
    /** A live view bound to one session (reads resolve through the parent; writes go to the own record). */
    view(keys) {
        const store = this;
        const bound = normalizeKeys(keys);
        return {
            get alias() {
                return store.get(bound).alias;
            },
            get workspace() {
                return store.get(bound).workspace;
            },
            set(patch) {
                store.set(bound, patch);
            },
        };
    }
    /** Keep the newest `limit` records by updatedAt (ties: least recently written first out). */
    evict() {
        if (this.records.size <= this.limit)
            return;
        const ordered = [...this.records.entries()].sort((a, b) => a[1].updatedAt < b[1].updatedAt ? -1 : a[1].updatedAt > b[1].updatedAt ? 1 : 0);
        for (const [id] of ordered.slice(0, this.records.size - this.limit))
            this.records.delete(id);
    }
    /**
     * Restore from disk. Missing → fresh. A corrupt or wrong-shaped file is moved
     * aside for inspection (never overwritten) and the store starts fresh;
     * individual malformed records are skipped.
     */
    load() {
        this.records = new Map();
        this.last = null;
        let raw;
        try {
            raw = readFileSync(this.storePath, 'utf8');
        }
        catch {
            return;
        }
        let data;
        try {
            data = JSON.parse(raw);
            if (data?.version !== 2 || data.sessions === null || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) {
                throw new Error('bad shape');
            }
        }
        catch {
            try {
                renameSync(this.storePath, `${this.storePath}.corrupt-${Date.now()}`);
            }
            catch {
                // best effort; an unmoved corrupt file is still not loaded
            }
            return;
        }
        const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
        for (const [id, value] of Object.entries(data.sessions)) {
            if (value === null || typeof value !== 'object')
                continue;
            const rec = value;
            if (typeof rec.updatedAt !== 'string')
                continue;
            this.records.set(id, { alias: str(rec.alias), workspace: str(rec.workspace), updatedAt: rec.updatedAt });
        }
        this.last = str(data.lastAlias);
        this.evict();
    }
    /** Atomic write: tmp file + rename, mode 0600, parent directory 0700. */
    save() {
        const dir = dirname(this.storePath);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        const data = {
            version: 2,
            sessions: Object.fromEntries(this.records),
            lastAlias: this.last,
        };
        const tmp = `${this.storePath}.tmp-${process.pid}`;
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.storePath);
    }
}
