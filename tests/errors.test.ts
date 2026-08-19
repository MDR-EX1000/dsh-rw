import { describe, expect, it } from 'vitest'
import { mapConnectError, mapSftpError, RwError, toRwError } from '../src/errors.js'

describe('RwError', () => {
  it('carries code, message and optional cause', () => {
    const cause = new Error('boom')
    const err = new RwError('NO_SUCH_PATH', 'gone', { cause })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(RwError)
    expect(err.name).toBe('RwError')
    expect(err.code).toBe('NO_SUCH_PATH')
    expect(err.message).toBe('gone')
    expect(err.cause).toBe(cause)
  })
})

describe('mapConnectError', () => {
  it('maps "All configured authentication methods failed" to AUTH_FAILED', () => {
    const err = mapConnectError(new Error('All configured authentication methods failed'))
    expect(err.code).toBe('AUTH_FAILED')
  })

  it('maps any "authentication" mention to AUTH_FAILED (case-insensitive)', () => {
    expect(mapConnectError(new Error('Authentication failure')).code).toBe('AUTH_FAILED')
  })

  it('maps "Timed out" to CONN_TIMEOUT', () => {
    expect(mapConnectError(new Error('Timed out while waiting for handshake')).code).toBe('CONN_TIMEOUT')
  })

  it('maps "timeout" to CONN_TIMEOUT', () => {
    expect(mapConnectError(new Error('connect timeout after 15000ms')).code).toBe('CONN_TIMEOUT')
  })

  it('maps ECONNREFUSED in message to CONN_REFUSED', () => {
    expect(mapConnectError(new Error('connect ECONNREFUSED 10.0.0.1:22')).code).toBe('CONN_REFUSED')
  })

  it('maps err.code ECONNREFUSED to CONN_REFUSED even without the message', () => {
    const raw = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
    expect(mapConnectError(raw).code).toBe('CONN_REFUSED')
  })

  it.each(['getaddrinfo ENOTFOUND no.such.host', 'getaddrinfo EAI_AGAIN no.such.host', 'ENOTFOUND'])(
    'maps DNS failures to CONN_REFUSED keeping the original message: %s',
    (msg) => {
      const err = mapConnectError(new Error(msg))
      expect(err.code).toBe('CONN_REFUSED')
      expect(err.message).toBe(msg)
    },
  )

  it('maps anything else to REMOTE_ERROR', () => {
    expect(mapConnectError(new Error('weird handshake thing')).code).toBe('REMOTE_ERROR')
  })

  it('handles non-Error values', () => {
    expect(mapConnectError('plain string').code).toBe('REMOTE_ERROR')
    expect(mapConnectError(undefined).code).toBe('REMOTE_ERROR')
  })

  it('passes RwError through unchanged', () => {
    const orig = new RwError('HOSTKEY_CHANGED', 'changed!')
    expect(mapConnectError(orig)).toBe(orig)
  })
})

describe('mapSftpError', () => {
  it('maps STATUS_CODE 2 (NO_SUCH_FILE) to NO_SUCH_PATH', () => {
    const err = mapSftpError(Object.assign(new Error('No such file'), { code: 2 }), '/remote/x')
    expect(err.code).toBe('NO_SUCH_PATH')
    expect(err.message).toContain('/remote/x')
  })

  it('maps STATUS_CODE 3 (PERMISSION_DENIED) to PERMISSION_DENIED', () => {
    expect(mapSftpError(Object.assign(new Error('Permission denied'), { code: 3 })).code).toBe('PERMISSION_DENIED')
  })

  it('maps STATUS_CODE 4 (FAILURE) to REMOTE_ERROR', () => {
    expect(mapSftpError(Object.assign(new Error('Failure'), { code: 4 })).code).toBe('REMOTE_ERROR')
  })

  it('maps errors without a numeric code to REMOTE_ERROR', () => {
    expect(mapSftpError(new Error('mystery')).code).toBe('REMOTE_ERROR')
    expect(mapSftpError('mystery').code).toBe('REMOTE_ERROR')
  })

  it('omits the path suffix when no path is given', () => {
    expect(mapSftpError(Object.assign(new Error('No such file'), { code: 2 })).message).toBe('No such file')
  })

  it('passes RwError through unchanged', () => {
    const orig = new RwError('OUTSIDE_WORKSPACE', 'nope')
    expect(mapSftpError(orig, '/x')).toBe(orig)
  })
})

describe('toRwError', () => {
  it('returns an RwError as-is', () => {
    const orig = new RwError('NOT_CONNECTED', 'x')
    expect(toRwError(orig)).toBe(orig)
  })

  it('wraps Errors and non-Errors as REMOTE_ERROR', () => {
    expect(toRwError(new Error('a')).code).toBe('REMOTE_ERROR')
    expect(toRwError(new Error('a')).message).toBe('a')
    expect(toRwError(42).code).toBe('REMOTE_ERROR')
  })
})
