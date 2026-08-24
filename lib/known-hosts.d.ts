export type VerifyResult = 'match' | 'unknown' | 'changed';
export declare class KnownHosts {
    readonly path: string;
    constructor(path: string);
    static defaultPath(): string;
    private load;
    /**
     * Candidate names for a connection: `[host]:port` is the canonical form
     * for non-22 ports, but we also try the plain name (some tools record it
     * that way); port 22 is always recorded plain.
     */
    private static candidates;
    verify(host: string, port: number, keyType: string, keyBase64: string): VerifyResult;
    /** Append a plain entry; exact duplicates (host+keyType+base64) are skipped. */
    accept(host: string, port: number, keyType: string, keyBase64: string): void;
}
