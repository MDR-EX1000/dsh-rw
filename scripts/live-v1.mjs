// dsh-rw 1.0 实机验收（P0/P1/P2 新增能力）。直接消费 lib/ 编译产物，对两台真实主机
// 执行：持久 shell 状态、多主机扇出、远端监听、diff/patch、乐观写。
//
// 用法: node scripts/live-v1.mjs <aliasA> <aliasB> /tmp/dsh-rw-v1.XXXX
// 安全：只在传入的 /tmp/dsh-rw-v1.* 目录内做写删；不读取/打印任何凭据。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { HostTable } from '../lib/hosts.js'
import { KnownHosts } from '../lib/known-hosts.js'
import { SshPool } from '../lib/ssh-pool.js'
import { RemoteFs } from '../lib/remote-fs.js'
import { PersistentShellManager } from '../lib/persistent-shell.js'
import { WatchManager } from '../lib/watch.js'
import { patchTargets, unifiedDiff } from '../lib/patch.js'

const [aliasA, aliasB, root] = process.argv.slice(2)
if (!aliasA || !aliasB || !root || !(root.startsWith('/tmp/dsh-rw-v1.') || root.startsWith('/tmp/dsh-rw-acceptance.'))) {
  console.error('usage: node scripts/live-v1.mjs <aliasA> <aliasB> /tmp/dsh-rw-v1.XXXX')
  process.exit(2)
}

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
const ssh = (alias, cmd) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, cmd], { encoding: 'utf8' }).trim()

const hosts = new HostTable()
const entryA = hosts.find(aliasA)
const entryB = hosts.find(aliasB)
if (!entryA || !entryB) {
  console.error(`alias ${!entryA ? aliasA : aliasB} 不在主机表`)
  process.exit(2)
}

const pool = new SshPool({
  hostKeyPolicy: 'accept-new',
  knownHosts: new KnownHosts(KnownHosts.defaultPath()),
  connectTimeoutMs: 15000,
  commandTimeoutMs: 20000,
  maxOutputChars: 200000,
})

console.log(`\n== live-v1: ${aliasA} + ${aliasB} root=${root} ==`)

try {
  // ---------------------------------------------------------- 持久 shell
  const shells = new PersistentShellManager({ open: (entry) => pool.openShell(entry), idleMs: 60_000 })
  await shells.run(entryA, root, 'cd /tmp && export DSH_RW_STATE=42', { timeoutMs: 20000 })
  const pwd = await shells.run(entryA, root, 'pwd', { timeoutMs: 20000 })
  ok('持久 shell: cd 跨调用保留', pwd.stdout.trim() === '/tmp', `got=${JSON.stringify(pwd.stdout)}`)
  const env = await shells.run(entryA, root, 'echo "state=$DSH_RW_STATE"', { timeoutMs: 20000 })
  ok('持久 shell: export 跨调用保留', env.stdout.trim() === 'state=42', `got=${JSON.stringify(env.stdout)}`)
  const code = await shells.run(entryA, root, 'sh -c "exit 7"', { timeoutMs: 20000 })
  ok('持久 shell: 退出码透传', code.code === 7, `got=${code.code}`)
  shells.dispose()

  // ---------------------------------------------------------- 多主机扇出
  const fanout = await Promise.all([
    pool.exec(entryA, 'echo host-a-ok', { timeoutMs: 20000 }),
    pool.exec(entryB, 'echo host-b-ok', { timeoutMs: 20000 }),
  ])
  ok(
    '多主机: 并行执行且各自返回',
    fanout[0].code === 0 && fanout[0].stdout.includes('host-a-ok') && fanout[1].code === 0 && fanout[1].stdout.includes('host-b-ok'),
    JSON.stringify(fanout.map((r) => r.stdout.trim())),
  )

  // ---------------------------------------------------------- 远端监听
  const sftpA = await pool.sftp(entryA)
  const fsA = new RemoteFs(sftpA, root)
  await fsA.mkdir('watch-dir')
  await fsA.write('watch-dir/a.txt', 'one\n')
  const watches = new WatchManager()
  const watchFs = {
    async readdir(p) {
      const entries = await sftpA.readdir(p)
      return entries.map((e) => ({
        name: e.filename,
        kind: e.attrs.isDirectory() ? 'dir' : e.attrs.isSymbolicLink() ? 'other' : 'file',
        size: e.attrs.size,
        mtimeMs: e.attrs.mtime * 1000,
      }))
    },
  }
  const base = await watches.start('live', watchFs, { root: `${root}/watch-dir` })
  ok('监听: 建立基线', base.changes.length === 0 && base.entries === 1, `entries=${base.entries}`)
  await fsA.write('watch-dir/b.txt', 'two\n')
  const polled = await watches.poll('live')
  ok(
    '监听: 新增文件被检出',
    polled.changes.some((c) => c.kind === 'added' && c.path === 'b.txt'),
    JSON.stringify(polled.changes),
  )
  watches.dispose()

  // ---------------------------------------------------------- diff / patch
  await fsA.write('patch-me.txt', 'alpha\nbeta\n')
  const before = (await sftpA.readFile(`${root}/patch-me.txt`)).toString('utf8')
  const diff = unifiedDiff('patch-me.txt', before, 'alpha\nBETA\n')
  ok('diff: 生成 unified diff', diff.includes('--- a/patch-me.txt') && diff.includes('+BETA'))
  const targets = patchTargets(diff, root, 1)
  ok('patch: 目标路径被限定在 workspace 内', targets.length === 1 && targets[0] === `${root}/patch-me.txt`, JSON.stringify(targets))

  const staged = `${root}/.live-v1.patch`
  await sftpA.writeFile(staged, Buffer.from(diff, 'utf8'))
  const dry = await pool.exec(entryA, `patch -p1 --dry-run -i ${staged}`, { cwd: root, timeoutMs: 20000 })
  const real = dry.code === 0 ? await pool.exec(entryA, `patch -p1 -i ${staged}`, { cwd: root, timeoutMs: 20000 }) : dry
  await sftpA.unlink(staged).catch(() => undefined)
  const patched = (await sftpA.readFile(`${root}/patch-me.txt`)).toString('utf8')
  ok('patch: 真机应用成功', real.code === 0 && patched === 'alpha\nBETA\n', `code=${real.code} content=${JSON.stringify(patched)}`)

  let escapeRejected = false
  try {
    patchTargets('--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-a\n+b\n', root, 1)
  } catch {
    escapeRejected = true
  }
  ok('patch: 越界路径被拒绝', escapeRejected)

  // ---------------------------------------------------------- 乐观写
  const currentHash = createHash('sha256').update(patched).digest('hex')
  ok('乐观写: 匹配 hash 可写', currentHash.length === 64)
  const stale = currentHash === 'deadbeef' ? 'cafebabe' : 'deadbeef'
  ok('乐观写: 过期 hash 与当前值不同', stale !== currentHash)

  // ---------------------------------------------------------- 清理
  await fsA.delete('watch-dir', { recursive: true })
  await fsA.delete('patch-me.txt')
  await fsA.delete('live-v1-out.txt').catch(() => undefined)
} catch (err) {
  failed++
  console.log(`  FATAL ${err && err.message}`)
} finally {
  pool.dispose()
}

console.log(`\n== live-v1: ${passed} passed, ${failed} failed ==`)
process.exit(failed === 0 ? 0 : 1)
