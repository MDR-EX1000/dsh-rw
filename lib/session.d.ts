export interface SessionState {
    alias: string | null;
    workspace: string | null;
}
export declare class Session {
    readonly storePath: string;
    private state;
    constructor(storePath?: string);
    static defaultPath(): string;
    get alias(): string | null;
    get workspace(): string | null;
    /**
     * Merge a patch into the state and persist it. A field set to null clears
     * it; omitted fields keep their current value.
     */
    set(patch: Partial<SessionState>): void;
    /**
     * Restore from disk. A missing file means a fresh session; a corrupt file is
     * ignored (left in place for inspection) rather than crashing startup.
     */
    load(): void;
    /** Atomic write: tmp file + rename, mode 0600, parent directory 0700. */
    private save;
}
