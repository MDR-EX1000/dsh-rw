// dsh-rw 实机验收脚本（P7）。直接消费 lib/ 编译产物，对真实主机执行
// connect → workspace 限定文件 CRUD → 安全边界 → exec 链路，与 SSH 端核对。
//
// 用法: node scripts/acceptance.mjs <alias> <remoteTmpDir>
// 例:   node scripts/acceptance.mjs freedom /tmp/dsh-rw-acceptance.tMPqXO
//
// 安全：只在传入的 /tmp/dsh-rw-acceptance.* 目录内做写删；不读取/打印任何凭据。
import { HostTable } from '../lib/hosts.js'
import { KnownHosts } from '../lib/known-hosts.js'
import { SshPool } from '../lib/ssh-pool.js'
import { RemoteFs } from '../lib/remote-fs.js'
import { execFileSync } from 'node:child_process'

const [alias, root] = process.argv.slice(2)
if (!alias || !root || !root.startsWith('/tmp/dsh-rw-acceptance.')) {
  console.error('usage: node scripts/acceptance.mjs <alias> /tmp/dsh-rw-acceptance.XXXX')
  process.exit(2)
}

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}`) }
  else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}
const expectRwError = async (name, code, fn) => {
  try {
    await fn()
    failed++
    console.log(`  FAIL ${name} — 未抛错（期望 ${code}）`)
  } catch (err) {
    const got = err && err.code
    if (got === code) { passed++; console.log(`  PASS ${name} [${code}]`) }
    else { failed++; console.log(`  FAIL ${name} — 期望 ${code}，实际 ${got}: ${err && err.message}`) }
  }
}
const ssh = (cmd) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, cmd], { encoding: 'utf8' }).trim()

const hosts = new HostTable()
const entry = hosts.find(alias)
if (!entry) { console.error(`alias ${alias} 不在主机表`); process.exit(2) }

const pool = new SshPool({
  hostKeyPolicy: 'accept-new',
  knownHosts: new KnownHosts(KnownHosts.defaultPath()),
  connectTimeoutMs: 15000,
  commandTimeoutMs: 20000,
  maxOutputChars: 100000,
})

console.log(`\n== ${alias} (${entry.user}@${entry.host}) root=${root} ==`)

try {
  // 1. 连接与 host key 校验
  const latency = await pool.testConnect(entry)
  ok('connect + host key verify', latency > 0, `latency=${latency}ms`)

  // 1b. strict 策略 + 空 known_hosts → 必须拒绝未知 host key
  const strictPool = new SshPool({
    hostKeyPolicy: 'strict',
    knownHosts: new KnownHosts('/tmp/dsh-rw-empty-known-hosts'),
    connectTimeoutMs: 10000,
    commandTimeoutMs: 10000,
    maxOutputChars: 1000,
  })
  await expectRwError('strict policy rejects unknown host key', 'HOSTKEY_UNKNOWN', () => strictPool.testConnect(entry))
  strictPool.dispose()

  // 2. RemoteFs 文件操作
  const sftp = await pool.sftp(entry)
  const fs = new RemoteFs(sftp, root)

  const names = (await fs.list()).map((e) => `${e.type}:${e.name}`)
  ok('list: 测试数据完整', ['README.txt', 'nested', 'space dir', '中文目录', 'empty-dir', 'binary.bin'].every((n) => names.some((x) => x.endsWith(':' + n))), JSON.stringify(names))
  ok('list: symlink 标注', names.includes('symlink:inside-link') && names.includes('symlink:escape-link'))

  const readme = await fs.read('README.txt')
  ok('read: README.txt', readme.content.includes('hello from'))
  const unicode = await fs.read('中文目录/你好.txt')
  ok('read: Unicode 路径与内容', unicode.content.includes('你好'))
  const space = await fs.read('space dir/file with space.txt')
  ok('read: 空格路径', space.content.includes('space content'))
  const viaLink = await fs.read('inside-link')
  ok('read: workspace 内 symlink 允许', viaLink.content.includes('nested content'))

  await expectRwError('read: 逃逸 symlink 拒绝', 'SYMLINK_ESCAPE', () => fs.read('escape-link'))
  await expectRwError('read: 绝对路径越界拒绝', 'OUTSIDE_WORKSPACE', () => fs.read('/etc/hostname'))
  await expectRwError('read: ../ 越界拒绝', 'OUTSIDE_WORKSPACE', () => fs.read('../escape'))
  await expectRwError('read: 不存在路径', 'NO_SUCH_PATH', () => fs.read('no-such-file'))

  // 3. 写/建/移/删（每步 SSH 端核对）
  await fs.write('new/deep/file.txt', 'created by dsh-rw')
  ok('write: 递归建父目录', ssh(`cat '${root}/new/deep/file.txt'`) === 'created by dsh-rw')

  await fs.mkdir('made/by-mkdir')
  ok('mkdir: 递归', ssh(`test -d '${root}/made/by-mkdir' && echo yes`) === 'yes')

  await fs.move('new/deep/file.txt', 'moved.txt')
  ok('move: 重命名', ssh(`cat '${root}/moved.txt'`) === 'created by dsh-rw' && ssh(`test ! -e '${root}/new/deep/file.txt' && echo gone`) === 'gone')

  await expectRwError('write: 越界路径拒绝', 'OUTSIDE_WORKSPACE', () => fs.write('/tmp/dsh-rw-evil', 'x'))
  ok('write 越界后远端无残留', ssh('test ! -e /tmp/dsh-rw-evil && echo clean') === 'clean')

  await fs.delete('moved.txt')
  ok('delete: 文件', ssh(`test ! -e '${root}/moved.txt' && echo gone`) === 'gone')
  await expectRwError('delete: 目录缺 recursive 拒绝', 'INVALID_INPUT', () => fs.delete('new'))
  await fs.delete('new', { recursive: true })
  ok('delete: 递归目录', ssh(`test ! -e '${root}/new' && echo gone`) === 'gone')

  // 4. exec（cwd = workspace 根）
  const exec1 = await pool.exec(entry, 'pwd && ls README.txt', { cwd: root })
  ok('exec: cwd 注入', exec1.stdout.includes(root) && exec1.stdout.includes('README.txt'), exec1.stdout)
  const exec2 = await pool.exec(entry, 'sleep 5', { timeoutMs: 1500 })
  ok('exec: 超时结构化', exec2.timedOut === true)

  // 5. 二进制完整性
  const bin = await fs.read('binary.bin')
  const binOk = ssh(`md5sum '${root}/binary.bin' | cut -d' ' -f1`)
  ok('read: 二进制可读（远端 md5 可算）', /^[0-9a-f]{32}$/.test(binOk))
  void bin
} catch (err) {
  failed++
  console.log(`  FATAL ${err && err.message}`)
} finally {
  pool.dispose()
}

console.log(`\n== ${alias}: ${passed} passed, ${failed} failed ==`)
process.exit(failed ? 1 : 0)
