export interface SessionState {
    alias: string | null;
    workspace: string | null;
}
export interface SessionRecord extends SessionState {
    updatedAt: string;
}
/**
 * Which session a call belongs to. `id` '' (or absent) is the key used when
 * the caller has no session id (tests, the /rw slash command, legacy callers).
 */
export interface SessionKeys {
    id?: string;
    /** The direct parent session (subagents inherit its record). */
    parentId?: string;
}
/** Where a resolved state came from. */
export type SessionSource = 'own' | 'parent' | 'none';
/** Records kept on disk; the least recently updated beyond this are dropped. */
export declare const SESSION_RECORD_LIMIT = 500;
/** The session header of a DSH agent (`agent.session.header`), read structurally. */
export declare function sessionHeaderOf(agent: unknown): {
    id?: string;
    cwd?: string;
    parentSession?: string;
};
/** Session keys of a DSH agent: its id and its direct parent's id. */
export declare function sessionKeysOf(agent: unknown): SessionKeys;
/** A view bound to one session's keys — the shape the ≤ 1.6 global record had. */
export interface SessionView {
    readonly alias: string | null;
    readonly workspace: string | null;
    set(patch: Partial<SessionState>): void;
}
export declare class SessionStore {
    readonly storePath: string;
    private records;
    private last;
    private readonly limit;
    private readonly now;
    constructor(storePath?: string, opts?: {
        limit?: number;
        now?: () => Date;
    });
    static defaultPath(): string;
    /** The raw record stored under one session id (no parent fallback). */
    record(id: string): SessionRecord | undefined;
    /** Session ids currently on record, least recently updated first. */
    ids(): string[];
    /** Resolved state plus where it came from: own record, else the parent's, else empty. */
    lookup(keys?: SessionKeys | string): SessionState & {
        source: SessionSource;
    };
    /** Resolved state for a session (own record → parent's → empty). */
    get(keys?: SessionKeys | string): SessionState;
    /**
     * Merge a patch over the session's resolved state (so a subagent's first
     * write starts from what it inherited) and persist it under its OWN id. A
     * field set to null clears it; omitted fields keep their value.
     */
    set(keys: SessionKeys | string | undefined, patch: Partial<SessionState>): void;
    /** Drop one session's record (its subagents fall back to nothing). */
    delete(id: string): void;
    /** The host the picker used last (shown as the picker's default). */
    get lastAlias(): string | null;
    setLastAlias(alias: string | null): void;
    /** A host was removed: clear it from every session record and from lastAlias. */
    forgetAlias(alias: string): void;
    /** A live view bound to one session (reads resolve through the parent; writes go to the own record). */
    view(keys?: SessionKeys | string): SessionView;
    /** Keep the newest `limit` records by updatedAt (ties: least recently written first out). */
    private evict;
    /**
     * Restore from disk. Missing → fresh. A corrupt or wrong-shaped file is moved
     * aside for inspection (never overwritten) and the store starts fresh;
     * individual malformed records are skipped.
     */
    load(): void;
    /** Atomic write: tmp file + rename, mode 0600, parent directory 0700. */
    private save;
}
