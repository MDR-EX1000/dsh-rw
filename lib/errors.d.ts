export type RwErrorCode = 'CONN_REFUSED' | 'CONN_TIMEOUT' | 'AUTH_FAILED' | 'HOSTKEY_UNKNOWN' | 'HOSTKEY_CHANGED' | 'HOSTKEY_VERIFY_FAILED' | 'NO_SUCH_PATH' | 'NOT_A_DIRECTORY' | 'PERMISSION_DENIED' | 'OUTSIDE_WORKSPACE' | 'SYMLINK_ESCAPE' | 'SFTP_UNAVAILABLE' | 'NOT_CONNECTED' | 'NO_WORKSPACE' | 'INVALID_INPUT' | 'RW_EDIT_CONFLICT' | 'REMOTE_ERROR';
export declare class RwError extends Error {
    readonly code: RwErrorCode;
    constructor(code: RwErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
/**
 * Classify ssh2 connect/handshake-phase errors. Matching is done on
 * case-insensitive substrings of err.message (plus err.code for ECONNREFUSED)
 * because ssh2 surfaces plain Error objects without stable codes.
 */
export declare function mapConnectError(err: unknown): RwError;
/**
 * Classify SFTP operation errors by their numeric `code` field
 * (ssh2 STATUS_CODE: 2=NO_SUCH_FILE, 3=PERMISSION_DENIED). 4/FAILURE and
 * errors without a numeric code map to REMOTE_ERROR. `path`, when given, is
 * included in the message for context — it is never sensitive.
 */
export declare function mapSftpError(err: unknown, path?: string): RwError;
/** Normalize anything thrown at us into an RwError (RwError passes through). */
export declare function toRwError(err: unknown): RwError;
