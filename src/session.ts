// dsh-rw — session state: the currently connected host alias and the current
// remote workspace root. Persisted as JSON (default ~/.dsh/dsh-rw-session.json)
// with the same discipline as every other dsh-rw state file: atomic tmp+rename
// write, file 0600, parent directory 0700. The file holds only an alias and a
// remote path — never credentials.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface SessionState {
  alias: string | null
  workspace: string | null
}

interface SessionFile {
  version: 1
  alias: string | null
  workspace: string | null
}

export class Session {
  private state: SessionState = { alias: null, workspace: null }

  constructor(readonly storePath: string = Session.defaultPath()) {
    this.load()
  }

  static defaultPath(): string {
    return join(homedir(), '.dsh', 'dsh-rw-session.json')
  }

  get alias(): string | null {
    return this.state.alias
  }

  get workspace(): string | null {
    return this.state.workspace
  }

  /**
   * Merge a patch into the state and persist it. A field set to null clears
   * it; omitted fields keep their current value.
   */
  set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch }
    this.save()
  }

  /**
   * Restore from disk. A missing file means a fresh session; a corrupt file is
   * ignored (left in place for inspection) rather than crashing startup.
   */
  load(): void {
    let raw: string
    try {
      raw = readFileSync(this.storePath, 'utf8')
    } catch {
      return
    }
    try {
      const data = JSON.parse(raw) as Partial<SessionFile> | null
      this.state = {
        alias: typeof data?.alias === 'string' ? data.alias : null,
        workspace: typeof data?.workspace === 'string' ? data.workspace : null,
      }
    } catch {
      // corrupt file: keep the fresh state; the next set() rewrites it
    }
  }

  /** Atomic write: tmp file + rename, mode 0600, parent directory 0700. */
  private save(): void {
    const dir = dirname(this.storePath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const data: SessionFile = { version: 1, ...this.state }
    const tmp = `${this.storePath}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.storePath)
  }
}
