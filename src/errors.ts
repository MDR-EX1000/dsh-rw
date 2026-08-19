// dsh-rw — structured errors shared by every host-side module.
//
// Security rule: nothing here (or anywhere in this package) may put passwords,
// private key material, or passphrases into messages or return values.

export type RwErrorCode =
  | 'CONN_REFUSED'
  | 'CONN_TIMEOUT'
  | 'AUTH_FAILED'
  | 'HOSTKEY_UNKNOWN'
  | 'HOSTKEY_CHANGED'
  | 'HOSTKEY_VERIFY_FAILED'
  | 'NO_SUCH_PATH'
  | 'NOT_A_DIRECTORY'
  | 'PERMISSION_DENIED'
  | 'OUTSIDE_WORKSPACE'
  | 'SYMLINK_ESCAPE'
  | 'SFTP_UNAVAILABLE'
  | 'NOT_CONNECTED'
  | 'NO_WORKSPACE'
  | 'INVALID_INPUT'
  | 'REMOTE_ERROR'

export class RwError extends Error {
  readonly code: RwErrorCode

  constructor(code: RwErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RwError'
    this.code = code
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function codeOf(err: unknown): unknown {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code: unknown }).code
  }
  return undefined
}

/**
 * Classify ssh2 connect/handshake-phase errors. Matching is done on
 * case-insensitive substrings of err.message (plus err.code for ECONNREFUSED)
 * because ssh2 surfaces plain Error objects without stable codes.
 */
export function mapConnectError(err: unknown): RwError {
  if (err instanceof RwError) return err
  const msg = messageOf(err)
  const lower = msg.toLowerCase()
  const code = codeOf(err)
  if (lower.includes('all configured authentication methods failed') || lower.includes('authentication')) {
    return new RwError('AUTH_FAILED', msg, { cause: err })
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return new RwError('CONN_TIMEOUT', msg, { cause: err })
  }
  if (lower.includes('econnrefused') || code === 'ECONNREFUSED') {
    return new RwError('CONN_REFUSED', msg, { cause: err })
  }
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('getaddrinfo')) {
    // DNS failure means we cannot reach the host at all; keep the original
    // message (it carries the offending hostname) but classify as refused.
    return new RwError('CONN_REFUSED', msg, { cause: err })
  }
  return new RwError('REMOTE_ERROR', msg, { cause: err })
}

// ssh2 SFTP STATUS_CODE values (ssh2.utils.sftp.STATUS_CODE); duplicated here
// so this module stays dependency-free.
const SFTP_NO_SUCH_FILE = 2
const SFTP_PERMISSION_DENIED = 3

/**
 * Classify SFTP operation errors by their numeric `code` field
 * (ssh2 STATUS_CODE: 2=NO_SUCH_FILE, 3=PERMISSION_DENIED). 4/FAILURE and
 * errors without a numeric code map to REMOTE_ERROR. `path`, when given, is
 * included in the message for context — it is never sensitive.
 */
export function mapSftpError(err: unknown, path?: string): RwError {
  if (err instanceof RwError) return err
  const msg = messageOf(err)
  const code = codeOf(err)
  const where = path === undefined ? '' : ` (${path})`
  if (code === SFTP_NO_SUCH_FILE) {
    return new RwError('NO_SUCH_PATH', `${msg}${where}`, { cause: err })
  }
  if (code === SFTP_PERMISSION_DENIED) {
    return new RwError('PERMISSION_DENIED', `${msg}${where}`, { cause: err })
  }
  return new RwError('REMOTE_ERROR', `${msg}${where}`, { cause: err })
}

/** Normalize anything thrown at us into an RwError (RwError passes through). */
export function toRwError(err: unknown): RwError {
  if (err instanceof RwError) return err
  return new RwError('REMOTE_ERROR', messageOf(err), { cause: err })
}
