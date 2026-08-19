// dsh-rw — persistent ssh2 connection pool with host key verification.
//
// One long-lived connection per host alias; concurrent connects are deduped
// through an in-flight promise; a closed connection drops out of the pool and
// the next use reconnects lazily. Host key policy is enforced via ssh2's
// sync hostVerifier hook against a KnownHosts store ('off' disables the hook
// entirely, matching ssh -o StrictHostKeyChecking=no).
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import ssh2 from 'ssh2'
import type { Client } from 'ssh2'

const { Client: Ssh2Client, utils } = ssh2
import type { ConnectConfig, SFTPWrapper, Stats } from 'ssh2'
import { mapConnectError, RwError } from './errors.js'
import { expandHome } from './hosts.js'
import type { HostEntry } from './hosts.js'
import type { KnownHosts } from './known-hosts.js'

export interface ExecResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
}

interface StatLike {
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
  mtime: number
}

/** Promisified SFTP subset consumed directly by the P3 file layer. */
export interface SftpLike {
  readdir(p: string): Promise<{ filename: string; longname: string; attrs: StatLike }[]>
  stat(p: string): Promise<StatLike>
  lstat(p: string): Promise<StatLike>
  realpath(p: string): Promise<string>
  readFile(p: string): Promise<Buffer>
  writeFile(p: string, data: Buffer): Promise<void>
  mkdir(p: string): Promise<void>
  rename(src: string, dst: string): Promise<void>
  unlink(p: string): Promise<void>
  rmdir(p: string): Promise<void>
}

export interface PoolOptions {
  hostKeyPolicy: 'accept-new' | 'strict' | 'off'
  knownHosts: KnownHosts
  connectTimeoutMs: number
  commandTimeoutMs: number
  maxOutputChars: number
  /** Test hook; defaults to () => new ssh2.Client(). */
  clientFactory?: () => Client
}

interface Pooled {
  client: Client
  ready: Promise<Client>
}

/** Shell single-quote escaping: 'a'b' → 'a'\''b' */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function toStatLike(stats: Stats): StatLike {
  return {
    isDirectory: () => stats.isDirectory(),
    isSymbolicLink: () => stats.isSymbolicLink(),
    size: stats.size,
    mtime: stats.mtime,
  }
}

function wrapSftp(raw: SFTPWrapper): SftpLike {
  return {
    readdir: (p) =>
      new Promise((resolve, reject) => {
        raw.readdir(p, (err, list) => {
          if (err) reject(err)
          else resolve(list.map((f) => ({ filename: f.filename, longname: f.longname, attrs: toStatLike(f.attrs) })))
        })
      }),
    stat: (p) =>
      new Promise((resolve, reject) => {
        raw.stat(p, (err, stats) => (err ? reject(err) : resolve(toStatLike(stats))))
      }),
    lstat: (p) =>
      new Promise((resolve, reject) => {
        raw.lstat(p, (err, stats) => (err ? reject(err) : resolve(toStatLike(stats))))
      }),
    realpath: (p) =>
      new Promise((resolve, reject) => {
        raw.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)))
      }),
    readFile: (p) =>
      new Promise((resolve, reject) => {
        raw.readFile(p, (err, data) => (err ? reject(err) : resolve(data)))
      }),
    writeFile: (p, data) =>
      new Promise((resolve, reject) => {
        raw.writeFile(p, data, (err) => (err ? reject(err) : resolve()))
      }),
    mkdir: (p) =>
      new Promise((resolve, reject) => {
        raw.mkdir(p, (err) => (err ? reject(err) : resolve()))
      }),
    rename: (src, dst) =>
      new Promise((resolve, reject) => {
        raw.rename(src, dst, (err) => (err ? reject(err) : resolve()))
      }),
    unlink: (p) =>
      new Promise((resolve, reject) => {
        raw.unlink(p, (err) => (err ? reject(err) : resolve()))
      }),
    rmdir: (p) =>
      new Promise((resolve, reject) => {
        raw.rmdir(p, (err) => (err ? reject(err) : resolve()))
      }),
  }
}

export class SshPool {
  private readonly opts: PoolOptions
  private readonly factory: () => Client
  private readonly pool = new Map<string, Pooled>()
  private readonly readyAliases = new Set<string>()

  constructor(opts: PoolOptions) {
    this.opts = opts
    this.factory = opts.clientFactory ?? (() => new Ssh2Client())
  }

  /**
   * Run a remote command. opts.cwd prefixes `cd <cwd> &&`. Command timeouts
   * do not reject — they resolve with timedOut: true (signal 'TIMEOUT').
   * Connection/auth/host-key failures reject with RwError.
   */
  async exec(entry: HostEntry, command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    const client = await this.ensureConnected(entry)
    const cmd = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ${command}` : command
    const timeoutMs = opts?.timeoutMs ?? this.opts.commandTimeoutMs
    const max = this.opts.maxOutputChars

    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(cmd, (execErr, stream) => {
        if (execErr) {
          reject(mapConnectError(execErr))
          return
        }
        let stdout = ''
        let stderr = ''
        let stdoutTrunc = false
        let stderrTrunc = false
        let timedOut = false
        let settled = false
        // 'exit' carries code/signal but is optional per the SSH spec; 'close'
        // always fires. Record on exit, resolve on close.
        let exitCode: number | null = null
        let exitSignal: string | null = null
        const outDecoder = new StringDecoder('utf8')
        const errDecoder = new StringDecoder('utf8')

        const timer = setTimeout(() => {
          timedOut = true
          try {
            stream.close()
          } catch {
            // stream may already be half-closed; the result stands either way
          }
          finish(null, 'TIMEOUT')
        }, timeoutMs)

        const finish = (code: number | null, signal: string | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({
            code,
            signal,
            stdout: stdoutTrunc ? `${stdout}\n…[truncated]` : stdout,
            stderr: stderrTrunc ? `${stderr}\n…[truncated]` : stderr,
            timedOut,
          })
        }

        const collect = (cur: string, chunk: Buffer, decoder: StringDecoder, truncated: boolean): [string, boolean] => {
          if (truncated || cur.length >= max) return [cur, true]
          let piece = decoder.write(chunk)
          if (cur.length + piece.length > max) {
            piece = piece.slice(0, max - cur.length)
            truncated = true
          }
          return [cur + piece, truncated]
        }

        stream.on('data', (chunk: Buffer) => {
          ;[stdout, stdoutTrunc] = collect(stdout, chunk, outDecoder, stdoutTrunc)
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          ;[stderr, stderrTrunc] = collect(stderr, chunk, errDecoder, stderrTrunc)
        })
        stream.once('exit', (code: number | null, signal?: string) => {
          exitCode = code
          exitSignal = signal ?? null
        })
        stream.on('close', () => {
          finish(exitCode, exitSignal)
        })
        stream.on('error', (streamErr: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(mapConnectError(streamErr))
        })
      })
    })
  }

  async sftp(entry: HostEntry): Promise<SftpLike> {
    const client = await this.ensureConnected(entry)
    const raw = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(mapConnectError(err)) : resolve(sftp)))
    })
    return wrapSftp(raw)
  }

  /** Round-trip probe: resolves with the latency in ms, rejects with RwError. */
  async testConnect(entry: HostEntry): Promise<number> {
    const start = Date.now()
    await this.exec(entry, 'true')
    return Date.now() - start
  }

  disconnect(alias: string): void {
    const pooled = this.pool.get(alias)
    this.pool.delete(alias)
    this.readyAliases.delete(alias)
    if (pooled) {
      try {
        pooled.client.end()
      } catch {
        // already dead — nothing to do
      }
    }
  }

  dispose(): void {
    for (const alias of [...this.pool.keys()]) this.disconnect(alias)
  }

  /** Aliases with an established (ready) connection — for status display. */
  connected(): string[] {
    return [...this.readyAliases]
  }

  private ensureConnected(entry: HostEntry): Promise<Client> {
    const pooled = this.pool.get(entry.alias)
    if (pooled) return pooled.ready

    const client = this.factory()
    let settled = false
    // When hostVerifier rejects a key ssh2 only raises a generic error, so the
    // verifier records the precise reason here and the 'error' handler
    // prefers it over ssh2's message.
    let hostKeyFailure: RwError | undefined

    const ready = new Promise<Client>((resolve, reject) => {
      let config: ConnectConfig
      try {
        config = this.buildConfig(entry, (e) => {
          hostKeyFailure = e
        })
      } catch (err) {
        reject(err) // credential problems: no point dialing at all
        return
      }

      client.once('ready', () => {
        settled = true
        this.readyAliases.add(entry.alias)
        resolve(client)
      })
      // Kept attached for the connection's lifetime so late errors cannot
      // become unhandled 'error' events; pre-ready it decides the handshake.
      client.on('error', (err: Error) => {
        if (settled) return
        settled = true
        reject(hostKeyFailure ?? mapConnectError(err))
      })
      client.on('close', () => {
        if (this.pool.get(entry.alias)?.client === client) this.pool.delete(entry.alias)
        this.readyAliases.delete(entry.alias)
        if (!settled) {
          settled = true
          reject(hostKeyFailure ?? new RwError('NOT_CONNECTED', `connection to ${entry.alias} closed before ready`))
        }
      })

      try {
        client.connect(config)
      } catch (err) {
        settled = true
        reject(mapConnectError(err))
      }
    })

    this.pool.set(entry.alias, { client, ready })
    // A failed handshake must not poison the pool: drop the entry so the next
    // caller dials fresh. (Also swallows the rejection for this branch; the
    // caller still receives it via `ready`.)
    ready.catch(() => {
      if (this.pool.get(entry.alias)?.client === client) this.pool.delete(entry.alias)
      this.readyAliases.delete(entry.alias)
    })
    return ready
  }

  private buildConfig(entry: HostEntry, recordHostKeyFailure: (e: RwError) => void): ConnectConfig {
    const config: ConnectConfig = {
      host: entry.host,
      port: entry.port,
      username: entry.user,
      readyTimeout: this.opts.connectTimeoutMs,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    }

    if (entry.auth.kind === 'password') {
      if (!entry.auth.password) {
        throw new RwError('AUTH_FAILED', `no credentials configured for host "${entry.alias}"`)
      }
      config.password = entry.auth.password
    } else {
      if (!entry.auth.keyPath) {
        throw new RwError('AUTH_FAILED', `no credentials configured for host "${entry.alias}"`)
      }
      try {
        // Expand `~` at the point of use: ssh-config entries arrive expanded
        // already, but manual entries and /test ad-hoc payloads may not be.
        config.privateKey = readFileSync(expandHome(entry.auth.keyPath))
      } catch {
        // The path is safe to disclose; the key material obviously never is.
        throw new RwError('AUTH_FAILED', `private key not readable: ${entry.auth.keyPath}`)
      }
      if (entry.auth.passphrase) config.passphrase = entry.auth.passphrase
    }

    if (this.opts.hostKeyPolicy !== 'off') {
      config.hostVerifier = (key: Buffer): boolean => this.verifyHostKey(entry, key, recordHostKeyFailure)
    }
    return config
  }

  private verifyHostKey(entry: HostEntry, key: Buffer, record: (e: RwError) => void): boolean {
    const parsed = utils.parseKey(key)
    if (parsed instanceof Error) {
      record(new RwError('HOSTKEY_VERIFY_FAILED', `cannot parse host key presented by ${entry.host}:${entry.port}`))
      return false
    }
    const keyBase64 = key.toString('base64')
    const where = `${entry.host}:${entry.port}`
    switch (this.opts.knownHosts.verify(entry.host, entry.port, parsed.type, keyBase64)) {
      case 'match':
        return true
      case 'unknown':
        if (this.opts.hostKeyPolicy === 'accept-new') {
          this.opts.knownHosts.accept(entry.host, entry.port, parsed.type, keyBase64)
          return true
        }
        record(new RwError('HOSTKEY_UNKNOWN', `host key for ${where} is not in known_hosts (policy: strict)`))
        return false
      case 'changed':
        record(
          new RwError(
            'HOSTKEY_CHANGED',
            `host key for ${where} has CHANGED — possible MITM or host rebuild; ` +
              `review and fix the entry in ${this.opts.knownHosts.path} manually`,
          ),
        )
        return false
    }
  }
}
