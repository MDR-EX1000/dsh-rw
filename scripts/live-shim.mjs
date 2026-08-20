// Live end-to-end check for the dsh-rw SHIM (native tool translation) against a
// real SSH host. Complements scripts/acceptance.mjs (which covers the rw_*
// RemoteFs/SshPool core) by exercising the shim path — specifically the Bug A
// scenario: after rw_disconnect (alias null, workspace kept), native
// read/write/bash must still hit the REMOTE the agent-cwd placeholder points
// at (the pool redials lazily), never silently fall back to the local
// placeholder.
//
// Usage: node scripts/live-shim.mjs <alias> /tmp/dsh-rw-live-XXXX
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostTable } from '../lib/hosts.js'
import { KnownHosts } from '../lib/known-hosts.js'
import { SshPool } from '../lib/ssh-pool.js'
import { Session } from '../lib/session.js'
import { ensurePlaceholder } from '../lib/placeholder.js'
import { makeShim } from '../lib/shim.js'

const [alias, root] = process.argv.slice(2)
if (!alias || !root || !root.startsWith('/tmp/dsh-rw-')) {
  console.error('usage: node scripts/live-shim.mjs <alias> /tmp/dsh-rw-live-XXXX')
  process.exit(2)
}

const ssh = (cmd) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, cmd], { encoding: 'utf8' }).trim()

const hosts = new HostTable()
const entry = hosts.find(alias)
if (!entry) {
  console.error(`alias ${alias} is not in the host table`)
  process.exit(2)
}

const pool = new SshPool({
  hostKeyPolicy: 'accept-new',
  knownHosts: new KnownHosts(KnownHosts.defaultPath()),
  connectTimeoutMs: 15000,
  commandTimeoutMs: 20000,
  maxOutputChars: 100000,
})

const placeholderBase = mkdtempSync(join(tmpdir(), 'dsh-rw-live-shim-'))
let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

try {
  // Seed a remote workspace dir + a file to read back.
  ssh(`mkdir -p '${root}' && echo 'hello from live' > '${root}/README.txt'`)

  // rw_connect + rw_pick_workspace: probe, then bind (alias, workspace) and
  // create the local placeholder the agent cwd will live in.
  const session = new Session(join(placeholderBase, 'session.json'))
  const latency = await pool.testConnect(entry)
  ok('connect + host key verify', latency > 0, `latency=${latency}ms`)
  const placeholderDir = ensurePlaceholder(alias, entry, root, placeholderBase)
  session.set({ alias, workspace: root })
  console.log(`  placeholder: ${placeholderDir}`)

  const shim = makeShim({
    hosts,
    pool,
    session,
    config: {
      shim: true,
      shimBash: true,
      shimBashApproval: 'native',
      commandTimeoutMs: 20000,
      maxOutputChars: 100000,
    },
    placeholderBaseDir: placeholderBase,
    getTool: () => ({ parameters: { properties: { command: {}, description: {}, timeoutMs: {}, workdir: {} } } }),
  })

  const execOf = (name, args) => ({
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: placeholderDir } } },
  })
  const next = async () => ({
    isError: false,
    value: 'LOCAL-PASSTHROUGH',
    content: [{ type: 'text', text: 'LOCAL-PASSTHROUGH' }],
  })
  const textOf = (r) => r.content?.[0]?.text ?? ''

  // --- Bug A: rw_disconnect drops the SSH connection and clears the alias
  //     (workspace kept) — exactly tools.ts:513. ---
  pool.disconnect(alias)
  session.set({ alias: null })

  // native read of README.txt must hit the REMOTE, not pass through local.
  const readRes = await shim.onExecute(execOf('read', { file_path: 'README.txt' }), next)
  ok(
    'Bug A: after disconnect, native read hits remote (content fetched)',
    textOf(readRes).includes('hello from live'),
    textOf(readRes),
  )
  ok('Bug A: read did not pass through to local', textOf(readRes) !== 'LOCAL-PASSTHROUGH')

  // native write of a new file must land on the REMOTE.
  const writeRes = await shim.onExecute(
    execOf('write', { file_path: 'bug-a-marker.txt', content: 'written-after-disconnect\n' }),
    next,
  )
  ok(
    'Bug A: native write hits remote (Created/Updated)',
    textOf(writeRes).includes('Created') || textOf(writeRes).includes('Updated'),
    textOf(writeRes),
  )
  ok(
    'Bug A: file actually landed on the remote',
    ssh(`cat '${root}/bug-a-marker.txt'`) === 'written-after-disconnect',
    'remote file missing',
  )

  // native bash must run on the REMOTE with the workspace root as cwd.
  const bashRes = await shim.onExecute(
    execOf('bash', { command: 'echo SHIM_BASH_ON_REMOTE && pwd', description: 'probe' }),
    next,
  )
  ok('Bug A: native bash runs on remote', textOf(bashRes).includes('SHIM_BASH_ON_REMOTE'), textOf(bashRes))
  ok('Bug A: bash cwd is the remote workspace root', textOf(bashRes).includes(root), textOf(bashRes))

  // Sanity: the pool really re-established a connection after the disconnect.
  ok('Bug A: pool reconnected lazily (alias present post-op)', pool.connected().includes(alias))
} catch (err) {
  failed++
  console.log(`  FATAL ${err && err.message}`)
  console.log(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : '')
} finally {
  try {
    ssh(`rm -rf '${root}'`)
  } catch {
    // best-effort cleanup
  }
  pool.dispose()
  rmSync(placeholderBase, { recursive: true, force: true })
}

console.log(`\n== ${alias}: ${passed} passed, ${failed} failed ==`)
process.exit(failed ? 1 : 0)
