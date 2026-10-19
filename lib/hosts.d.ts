export interface HostEntry {
    alias: string;
    host: string;
    port: number;
    user: string;
    auth: {
        kind: 'key';
        keyPath: string;
        passphrase?: string;
    } | {
        kind: 'password';
        password?: string;
    };
    source: 'ssh-config' | 'manual';
}
export interface HostSummary {
    alias: string;
    host: string;
    port: number;
    user: string;
    authKind: 'key' | 'password';
    /** key auth: whether the private key file exists on disk. */
    keyReady: boolean;
    /** password auth: whether a password is stored. */
    passwordSet: boolean;
    /**
     * key auth: the configured private-key path. Not a secret (it is a path),
     * and the edit form needs it to prefill without forcing a re-entry.
     */
    keyPath?: string;
    source: 'ssh-config' | 'manual';
}
/** Expand a leading `~` (or `~/...`) against the current user's home. */
export declare function expandHome(p: string): string;
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
export declare function parseSshConfig(text: string, defaultUser?: string): HostEntry[];
export declare class HostTable {
    private readonly sshConfigPath;
    private readonly storePath;
    /**
     * Which `~/.ssh/config` aliases are imported. An empty include list means
     * "every alias" (the historical behaviour); exclude always wins. Matching is
     * shell-style against the alias (`*` and `?`), because an Alias is a single
     * path-free token.
     */
    private readonly sshConfigInclude;
    private readonly sshConfigExclude;
    private manual;
    private sshCache;
    constructor(opts?: {
        sshConfigPath?: string;
        storePath?: string;
        sshConfigInclude?: readonly string[];
        sshConfigExclude?: readonly string[];
    });
    /** All entries; manual entries shadow ssh-config entries with the same alias. */
    list(): HostEntry[];
    find(alias: string): HostEntry | undefined;
    summarize(entry: HostEntry): HostSummary;
    summaries(): HostSummary[];
    /** Validate a manual host's connection details and build its entry. */
    private buildManualEntry;
    addManual(payload: {
        alias: string;
        host: string;
        port?: number;
        user: string;
        password?: string;
        keyPath?: string;
        passphrase?: string;
    }): HostEntry;
    /**
     * Replace one manual host's connection details in place. The alias is the
     * record key, so it cannot change (a rename is remove + add), and
     * ssh-config hosts are not editable here — their source of truth is
     * ~/.ssh/config.
     */
    updateManual(alias: string, payload: {
        host: string;
        port?: number;
        user: string;
        password?: string;
        keyPath?: string;
        passphrase?: string;
    }): HostEntry;
    /** Whether one ssh-config alias passes the include/exclude globs. */
    private importsFromSshConfig;
    removeManual(alias: string): void;
    private sshEntries;
    private loadStore;
    /** Atomic write: tmp file + rename, mode 0600, parent directory 0700. */
    private saveStore;
}
