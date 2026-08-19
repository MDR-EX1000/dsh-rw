/// <reference lib="dom" />

// dsh-rw — client half: the unified workspace directory picker.
//
// One modal fills ui-workspace's two directory-flow holes (sidebar +
// conversation hero), following dsh-remote's proven DirPicker interaction:
//   • 本机 tab → 手动输入本机路径，或经 POST /api/dsh-rw/local-pick 调起系统
//     文件夹选择器，结果直接 onPicked(localPath)。
//   • 远程 tab → 选一台 SSH 主机（来自 ~/.ssh/config + 手动条目），输入路径时
//     逐级自动补全（防抖 ~220ms，对父目录做 ls + 前缀过滤），或用「浏览…」弹层
//     逐级下钻；确认后 POST /api/dsh-rw/workspace 拿到本地占位目录 →
//     onPicked(placeholderDir)，交给 DSH 原生流程登记为 workspace。
//     主机下拉旁内嵌「+ 添加主机」表单（原地展开/收起）：测试连接走
//     POST /test 完整字段形式（临时探测不入库），保存走 POST /hosts；手动
//     条目带「手动」标注，选中后可在旁边删除。密码只提交不展示。
//
// Client entries must be classic scripts registered via window.__ModuleLoader__.load
// ({ id, factory }); the factory receives a synchronous `require` — react and
// react/jsx-runtime are provided by the DSH runtime (esbuild externals), never
// bundled. All traffic goes to the loopback-only /api/dsh-rw/* routes; host
// payloads come from HostTable.summarize and never contain secrets.
import { useEffect, useRef, useState, type CSSProperties } from 'react'

export const name = 'dsh-rw'

// ── wire types (mirror of the host-side JSON shapes) ────────────────────────

/** Host row from GET /api/dsh-rw/hosts or /status (summary only, no secrets). */
interface HostSummary {
  alias: string
  host: string
  port: number
  user: string
  authKind: 'key' | 'password'
  keyReady: boolean
  passwordSet: boolean
  source: 'ssh-config' | 'manual'
}

/** One entry of a GET /api/dsh-rw/ls listing. */
interface LsItem {
  name: string
  type: 'dir' | 'file' | 'symlink'
}

/** One level of the cascading browse stack: a directory path + its listing. */
interface Level {
  path: string
  all: LsItem[]
}

interface StatusResponse {
  hosts?: HostSummary[]
  current?: { alias?: string | null } | null
}

interface LsResponse {
  path?: string
  items?: LsItem[]
}

interface LocalPickResponse {
  ok?: boolean
  path?: string
  cancelled?: boolean
  error?: string
}

interface WorkspaceResponse {
  ok?: boolean
  placeholderDir?: string
  error?: string
}

/** POST /api/dsh-rw/test probe result (probe failures are 200s with ok:false). */
interface TestResponse {
  ok?: boolean
  latencyMs?: number
  error?: string
  code?: string
}

/** POST /api/dsh-rw/hosts add result (echoes the summary only, no secrets). */
interface AddHostResponse {
  ok?: boolean
  host?: HostSummary
  error?: string
}

/** What ui-workspace passes to components registered on directoryFlow slots. */
export interface DirPickerProps {
  open: boolean
  busy: boolean
  onPicked: (path: string) => void
  onCancel: () => void
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** JSON fetch wrapper: non-2xx → throw Error(body.error ?? `HTTP <status>`). */
async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  const data = (await res.json().catch(() => ({}))) as (T & { error?: string; message?: string }) | null
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`)
  return data as T
}

/** Error → display text (Error.message when present, else String(value)). */
function errText(e: unknown): string {
  const m = (e as { message?: unknown } | null | undefined)?.message
  return String(typeof m === 'string' && m ? m : e)
}

/** Whether a listing entry can be entered. Symlinks may be followed — the
 * server realpath-resolves them and reports an error when the target is not a
 * directory, so the UI keeps the simple blueprint behavior. */
function drillable(it: LsItem): boolean {
  return it.type === 'dir' || it.type === 'symlink'
}

/** Why a host cannot be picked right now (null when it is usable). */
function hostProblem(h: HostSummary): string | null {
  if (h.authKind === 'key') return h.keyReady ? null : '私钥缺失'
  return h.passwordSet ? null : '未设密码'
}

/** Alias charset, mirroring the host-side HostTable.addManual ALIAS_RE. */
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** The inline add-host form fields (port stays a string until submit). */
interface AddHostForm {
  alias: string
  host: string
  port: string
  user: string
  authKind: 'key' | 'password'
  keyPath: string
  passphrase: string
  password: string
}

const emptyAddForm = (): AddHostForm => ({ alias: '', host: '', port: '22', user: 'root', authKind: 'key', keyPath: '', passphrase: '', password: '' })

// ── theme (DSH design tokens with fallbacks, so light/dark just works) ──────

const v = (name: string, fb: string): string => `var(${name}, ${fb})`
const T = {
  bg: v('--dsw-alias-bg-layer-1', 'rgba(128,128,128,0.07)'),
  border: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
  borderStrong: v('--dsw-alias-border-l3', 'rgba(128,128,128,0.5)'),
  danger: v('--dsw-static-red-500', '#e06c75'),
  ok: v('--dsw-static-green-500', '#4caf7d'),
  radius: 8,
  muted: v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
  label: v('--dsw-alias-label-primary', '#e4e4e7'),
}
const overlayBg = v('--dsw-alias-bg-overlay', '#1e1e1e')
const panelBg = v('--dsw-alias-bg-layer-1', '#18181b')

const inputS: CSSProperties = { flex: 1, padding: '6px 10px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, outline: 'none' }
const buttonS: CSSProperties = { padding: '6px 12px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, cursor: 'pointer' }

/** Clickable breadcrumb of the current remote path; clicking a segment jumps
 * back to that ancestor level (single line, ellipsized at the front). */
function breadcrumb(active: boolean, cur: string, jumpTo: (p: string) => void) {
  const norm = String(cur || '').replace(/\/+$/, '')
  const segs = norm === '' || norm === '/' ? [] : norm.split('/')
  const crumbs = [
    <span key="root" style={{ cursor: active ? 'pointer' : 'default', color: active ? T.ok : T.muted }} onClick={active ? () => jumpTo('/') : undefined}>
      /
    </span>,
  ]
  let acc = ''
  for (const s of segs) {
    if (!s) continue
    acc += '/' + s
    const target = acc
    crumbs.push(
      <span key={'sep|' + target} style={{ color: T.muted }}>
        /
      </span>,
      <span
        key={target}
        style={{ cursor: active ? 'pointer' : 'default', color: active ? T.label : T.muted, fontWeight: target === norm ? 700 : 400, whiteSpace: 'nowrap' }}
        onClick={active ? () => jumpTo(target) : undefined}
      >
        {s}
      </span>,
    )
  }
  return <span>{crumbs}</span>
}

// ── the picker ──────────────────────────────────────────────────────────────

function DirPicker(props: DirPickerProps) {
  const { open, busy, onPicked, onCancel } = props
  const [tab, setTab] = useState<'local' | 'remote'>('local')
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [alias, setAlias] = useState('')
  const [path, setPath] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  // 级联下钻状态：每一格是 { path, all } —— 该路径下的条目列表。
  const [levels, setLevels] = useState<Level[] | null>(null)
  const [popOpen, setPopOpen] = useState(false)
  const [suggest, setSuggest] = useState<string[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const suggestTimer = useRef<number | null>(null)
  // 内嵌「添加主机」表单状态（远程页签内原地展开/收起，不跳页不开新 modal）。
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState<AddHostForm>(emptyAddForm)
  const [formErr, setFormErr] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [testOk, setTestOk] = useState(false)

  // On open: fetch the host inventory (+ current alias for preselection).
  useEffect(() => {
    if (!open) return
    api<StatusResponse>('GET', '/api/dsh-rw/status')
      .then((r) => {
        const list = Array.isArray(r.hosts) ? r.hosts : []
        setHosts(list)
        const cur = r.current && typeof r.current.alias === 'string' ? r.current.alias : ''
        setAlias(cur || (list[0] ? list[0].alias : ''))
      })
      .catch((e) => setErr('获取主机列表失败：' + errText(e)))
  }, [open])

  useEffect(
    () => () => {
      if (suggestTimer.current !== null) window.clearTimeout(suggestTimer.current)
    },
    [],
  )

  // Load one browse level; toIndex >= 0 replaces that stack position (and
  // truncates below it) so breadcrumb jumps rewrite instead of appending.
  const loadLevels = (a: string, p: string, toIndex?: number) => {
    if (!a) return
    setLoading(true)
    setErr('')
    api<LsResponse>('GET', `/api/dsh-rw/ls?alias=${encodeURIComponent(a)}&path=${encodeURIComponent(p || '/')}`)
      .then((res) => {
        const real = res.path || p || '/'
        const node: Level = { path: real, all: Array.isArray(res.items) ? res.items : [] }
        setLevels((prev) => {
          const base = prev && prev.length ? prev.slice() : []
          const idx = typeof toIndex === 'number' && toIndex >= 0 ? toIndex : base.length
          if (idx >= base.length) return base.concat([node])
          base[idx] = node
          return base.slice(0, idx + 1)
        })
      })
      .catch((e) => setErr(errText(e)))
      .finally(() => setLoading(false))
  }

  // Autocomplete: list children of the partial path's parent directory whose
  // names start with the last segment.
  const loadSuggestions = (raw: string, aid?: string) => {
    const a = aid || alias
    const t = String(raw || '').trim()
    if (!a || !t) {
      setSuggest([])
      setSuggestOpen(false)
      return
    }
    const slash = t.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : t.slice(0, slash)
    const lastSeg = slash < 0 ? t : t.slice(slash + 1)
    api<LsResponse>('GET', `/api/dsh-rw/ls?alias=${encodeURIComponent(a)}&path=${encodeURIComponent(parent)}`)
      .then((res) => {
        const list = Array.isArray(res.items) ? res.items : []
        const matches = list
          .filter((it) => it.name.toLowerCase().startsWith(lastSeg.toLowerCase()))
          .slice(0, 40)
          .map((it) => (parent === '/' ? '/' + it.name : parent + '/' + it.name))
        setSuggest(matches)
        setSuggestOpen(matches.length > 0)
      })
      .catch(() => {
        setSuggest([])
        setSuggestOpen(false)
      })
  }

  // After a suggestion is chosen, immediately reveal the next level: list the
  // chosen directory's children as fresh completions (no keystroke needed).
  const continueSuggest = (dir: string) => {
    if (!alias || !dir) {
      setSuggest([])
      setSuggestOpen(false)
      return
    }
    setSuggestOpen(false)
    const base = String(dir).replace(/\/+$/, '') || '/'
    api<LsResponse>('GET', `/api/dsh-rw/ls?alias=${encodeURIComponent(alias)}&path=${encodeURIComponent(base)}`)
      .then((res) => {
        const list = Array.isArray(res.items) ? res.items : []
        const kids = list
          .filter(drillable)
          .slice(0, 40)
          .map((it) => (base === '/' ? '/' + it.name : base + '/' + it.name))
        setSuggest(kids)
        setSuggestOpen(kids.length > 0)
      })
      .catch(() => {
        setSuggest([])
        setSuggestOpen(false)
      })
  }

  const onPathChange = (raw: string) => {
    setPath(raw)
    setErr('')
    if (suggestTimer.current !== null) window.clearTimeout(suggestTimer.current)
    suggestTimer.current = window.setTimeout(() => loadSuggestions(raw), 220)
  }

  const selectSuggestion = (s: string) => {
    setPath(s)
    setErr('')
    setSuggestOpen(false)
    continueSuggest(s)
  }

  // enterDir(name): drive into the named subdir of the current deepest level,
  // appending that directory as the new deepest level.
  const enterDir = (name: string) => {
    if (busy || loading) return
    const last = levels && levels.length ? levels[levels.length - 1] : undefined
    const base = last ? last.path : ''
    const next = base === '/' ? '/' + name : base + '/' + name
    loadLevels(alias, next, levels ? levels.length : 0)
  }

  // 面包屑回跳：截断级联栈到被点的那一级。
  const jumpTo = (p: string) =>
    setLevels((prev) => {
      if (!prev) return prev
      const cut = prev.findIndex((lv) => lv.path === p)
      return cut >= 0 ? prev.slice(0, cut + 1) : prev
    })

  const chooseLocal = () => {
    setLoading(true)
    setErr('')
    api<LocalPickResponse>('POST', '/api/dsh-rw/local-pick')
      .then((r) => {
        if (r && r.path) onPicked(String(r.path))
        else if (r && r.cancelled) setErr('已取消选择')
        else setErr((r && r.error) || '无法打开系统文件夹选择器，可直接在输入框填本机路径')
      })
      .catch((e) => setErr(errText(e) + ' — 可直接在输入框填本机路径'))
      .finally(() => setLoading(false))
  }

  const switchTab = (t: 'local' | 'remote') => {
    setTab(t)
    setErr('')
    if (t === 'remote') {
      if (alias) loadLevels(alias, '/', 0)
      // 预填 '/'，让输入框立即获得根级补全列表。
      if (!path.trim()) {
        setPath('/')
        loadSuggestions('/', alias)
      }
    }
  }

  // Commit the remote path as the workspace: the host resolves it (realpath),
  // creates the local placeholder dir, and answers with its path.
  const commitPath = (p: string) => {
    const target = String(p || '').trim()
    if (!target || !alias || busy) return
    setPopOpen(false)
    setSuggestOpen(false)
    api<WorkspaceResponse>('POST', '/api/dsh-rw/workspace', { alias, path: target })
      .then((res) => {
        if (res && res.ok && res.placeholderDir) onPicked(String(res.placeholderDir))
        else setErr((res && res.error) || '设置远程工作区失败')
      })
      .catch((e) => setErr(errText(e)))
  }

  // 浏览弹层确认：把路径回填到输入框（不直接提交），留给用户检查/修改。
  const acceptBrowserPick = (p: string) => {
    setPath(String(p || ''))
    setSuggestOpen(false)
    setPopOpen(false)
  }

  // ── 添加主机表单 ────────────────────────────────────────────────────────

  // 表单局部更新：任何字段改动都让旧的测试结果失效。
  const updForm = (patch: Partial<AddHostForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setFormErr('')
    setTestMsg('')
  }

  // 收起/关闭时清空（密码与私钥口令不留存于 state）。
  const resetAddForm = () => {
    setForm(emptyAddForm())
    setFormErr('')
    setTestMsg('')
    setTestOk(false)
  }

  // 保存前置校验（与 host 端 addManual 一致）；测试连接不需要别名。
  const addFormError = (forSave: boolean): string => {
    if (forSave && !ALIAS_RE.test(form.alias.trim())) return '别名必填，仅限字母、数字、. _ -，且以字母或数字开头'
    if (!form.host.trim()) return '请填写主机地址'
    if (!form.user.trim()) return '请填写用户名'
    if (form.authKind === 'key' && !form.keyPath.trim()) return '请填写私钥路径'
    if (form.authKind === 'password' && !form.password) return '请输入密码'
    return ''
  }

  // 连接参数（不含别名）：测试与保存共用；二选一认证，与 addManual 语义一致。
  const addFormPayload = () => ({
    host: form.host.trim(),
    port: Number.parseInt(form.port, 10) || 22,
    user: form.user.trim(),
    ...(form.authKind === 'key'
      ? { keyPath: form.keyPath.trim(), ...(form.passphrase ? { passphrase: form.passphrase } : {}) }
      : { password: form.password }),
  })

  // 刷新主机列表（沿用现有 status 端点）。
  const refreshHosts = () =>
    api<StatusResponse>('GET', '/api/dsh-rw/status').then((r) => {
      const list = Array.isArray(r.hosts) ? r.hosts : []
      setHosts(list)
      return list
    })

  // 测试连接：完整字段形式 POST /test —— 临时探测，不入库。
  const testNewHost = () => {
    const msg = addFormError(false)
    if (msg) {
      setFormErr(msg)
      return
    }
    setTesting(true)
    setFormErr('')
    setTestMsg('')
    api<TestResponse>('POST', '/api/dsh-rw/test', addFormPayload())
      .then((r) => {
        if (r && r.ok) {
          setTestOk(true)
          setTestMsg(`✓ 连接成功（${r.latencyMs} ms）`)
        } else {
          setTestOk(false)
          setTestMsg(`✗ ${(r && r.error) || '连接失败'}${r && r.code ? ` [${r.code}]` : ''}`)
        }
      })
      .catch((e) => {
        setTestOk(false)
        setTestMsg('✗ ' + errText(e))
      })
      .finally(() => setTesting(false))
  }

  // 保存手动主机：成功后清空表单（含密码）、收起、刷新列表并自动选中新主机。
  const saveNewHost = () => {
    const msg = addFormError(true)
    if (msg) {
      setFormErr(msg)
      return
    }
    const newAlias = form.alias.trim()
    setSaving(true)
    setFormErr('')
    api<AddHostResponse>('POST', '/api/dsh-rw/hosts', { alias: newAlias, ...addFormPayload() })
      .then(() => {
        resetAddForm()
        setAddOpen(false)
        refreshHosts()
          .then(() => {
            setAlias(newAlias)
            setLevels(null)
            setErr('')
            loadLevels(newAlias, '/', 0)
            if (!path.trim()) {
              setPath('/')
              loadSuggestions('/', newAlias)
            }
          })
          .catch((e) => setErr('主机已保存，但刷新列表失败：' + errText(e)))
      })
      .catch((e) => setFormErr(errText(e)))
      .finally(() => setSaving(false))
  }

  // 删除手动主机（ssh-config 条目在 hosts 端就会被拒，这里不显示按钮）。
  const removeManualHost = (h: HostSummary) => {
    if (!window.confirm(`确定删除手动主机「${h.alias}」吗？仅删除本地登记，不影响远程主机。`)) return
    setErr('')
    api<{ ok?: boolean }>('DELETE', '/api/dsh-rw/hosts', { alias: h.alias })
      .then(() => refreshHosts())
      .then((list) => {
        if (alias === h.alias) {
          const next = list[0] ? list[0].alias : ''
          setAlias(next)
          setLevels(null)
          if (next) loadLevels(next, '/', 0)
        }
      })
      .catch((e) => setErr('删除主机失败：' + errText(e)))
  }

  function renderAddForm() {
    const busyForm = testing || saving
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid ' + T.border, borderRadius: T.radius, padding: 10 }}>
        <div style={{ fontSize: 12, opacity: 0.8 }}>保存为手动主机（~/.dsh/dsh-rw.json）；密码与私钥口令仅用于提交，此处不回显。</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={form.alias} onChange={(e) => updForm({ alias: e.target.value })} placeholder="别名 *（字母数字 . _ -）" style={inputS} />
          <input value={form.host} onChange={(e) => updForm({ host: e.target.value })} placeholder="主机 *（IP 或域名）" style={{ ...inputS, flex: 2 }} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={form.port} onChange={(e) => updForm({ port: e.target.value })} placeholder="端口（默认 22）" inputMode="numeric" style={inputS} />
          <input value={form.user} onChange={(e) => updForm({ user: e.target.value })} placeholder="用户（默认 root）" style={inputS} />
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
          <span style={{ opacity: 0.8 }}>认证方式:</span>
          <button style={{ ...buttonS, fontWeight: form.authKind === 'key' ? 700 : 400 }} onClick={() => updForm({ authKind: 'key' })}>
            私钥路径
          </button>
          <button style={{ ...buttonS, fontWeight: form.authKind === 'password' ? 700 : 400 }} onClick={() => updForm({ authKind: 'password' })}>
            密码
          </button>
        </div>
        {form.authKind === 'key' ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={form.keyPath} onChange={(e) => updForm({ keyPath: e.target.value })} placeholder="私钥路径 *（如 ~/.ssh/id_ed25519）" style={{ ...inputS, flex: 2 }} />
            <input value={form.passphrase} onChange={(e) => updForm({ passphrase: e.target.value })} type="password" placeholder="私钥口令（可选）" style={inputS} />
          </div>
        ) : (
          <input value={form.password} onChange={(e) => updForm({ password: e.target.value })} type="password" placeholder="密码 *" style={inputS} />
        )}
        {formErr ? <div style={{ color: T.danger, fontSize: 12 }}>{formErr}</div> : null}
        {testMsg ? <div style={{ color: testOk ? T.ok : T.danger, fontSize: 12 }}>{testMsg}</div> : null}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button style={buttonS} onClick={testNewHost} disabled={busyForm}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button style={{ ...buttonS, fontWeight: 600 }} onClick={saveNewHost} disabled={busyForm}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            style={buttonS}
            onClick={() => {
              setAddOpen(false)
              resetAddForm()
            }}
            disabled={busyForm}
          >
            取消
          </button>
        </div>
      </div>
    )
  }

  function renderDirPopup() {
    if (!levels || !levels.length) {
      return <div style={{ opacity: 0.6, fontSize: 12 }}>{loading ? '加载中…' : '正在读取根目录…'}</div>
    }
    const last = levels[levels.length - 1]!
    const entries = last.all
    // 悬浮弹层：钉在视口上，不撑开对话框布局；目录列表在面板内部滚动。
    return (
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}
        onClick={() => setPopOpen(false)}
      >
        <div
          style={{ background: overlayBg, border: '1px solid ' + T.borderStrong, borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,0.5)', width: 'min(560px, 94vw)', minWidth: 320, display: 'flex', flexDirection: 'column', maxHeight: 'min(440px, 82vh)', overflow: 'hidden' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid ' + T.border }}>
            <button style={{ ...buttonS, padding: '3px 10px' }} onClick={() => setLevels((p) => (p && p.length > 1 ? p.slice(0, p.length - 1) : p))} disabled={levels.length <= 1 || loading}>
              回上一级 ▴
            </button>
            <div style={{ fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {breadcrumb(!!alias, last.path, jumpTo)}
            </div>
            <button style={{ ...buttonS, padding: '3px 10px' }} onClick={() => setPopOpen(false)}>
              关闭 ✕
            </button>
          </div>
          <div style={{ overflowY: 'auto', overflowX: 'hidden' }}>
            {loading ? (
              <div style={{ opacity: 0.7, padding: 12 }}>加载中…</div>
            ) : entries.length ? (
              entries.slice(0, 400).map((it, i) => {
                const drill = drillable(it)
                return (
                  <div
                    key={it.name + '-' + i}
                    title={(drill ? '进入 ' : '文件: ') + it.name}
                    onClick={drill ? () => enterDir(it.name) : undefined}
                    style={{ padding: '7px 12px', cursor: drill ? 'pointer' : 'default', color: drill ? T.ok : T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid ' + T.border }}
                  >
                    <span>{it.type === 'dir' ? '📁' : it.type === 'symlink' ? '🔗' : '📄'}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
                  </div>
                )
              })
            ) : (
              <div style={{ opacity: 0.6, padding: 12 }}>（空目录）</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid ' + T.border }}>
            <span style={{ fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {'所选: ' + last.path}
            </span>
            <button style={{ ...buttonS, fontWeight: 600 }} onClick={() => acceptBrowserPick(last.path)}>
              选用此路径
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!open) return null

  const tabBtn = (t: 'local' | 'remote', lbl: string) => (
    <button onClick={() => switchTab(t)} style={{ ...buttonS, fontWeight: tab === t ? 700 : 400 }}>
      {lbl}
    </button>
  )

  const selectedHost = hosts.find((h) => h.alias === alias)

  // 全屏居中 modal（遮罩 + 面板）：在窄 sidebar 和 conversation 里渲染一致。
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={() => {
        if (!busy) onCancel()
      }}
    >
      <div
        style={{ background: panelBg, border: '1px solid ' + T.borderStrong, borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,0.5)', width: 'min(600px, 94vw)', padding: 16, boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>选择工作目录</div>
          <button
            style={{ ...buttonS, padding: '2px 8px' }}
            onClick={() => {
              if (!busy) onCancel()
            }}
            disabled={busy}
          >
            关闭 ✕
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {tabBtn('local', '本机')}
          {tabBtn('remote', '远程')}
        </div>
        {tab === 'local' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>系统选择器优先；不可用时直接输入本机目录。</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="本机目录，如 /Users/you/project" style={inputS} />
              <button style={buttonS} onClick={() => (path.trim() ? onPicked(path.trim()) : undefined)} disabled={!path.trim()}>
                选用此本地路径
              </button>
            </div>
            <button style={{ ...buttonS, alignSelf: 'flex-start' }} onClick={chooseLocal} disabled={loading}>
              {loading ? '打开中…' : '打开系统文件夹选择器'}
            </button>
            {err ? <div style={{ color: T.danger, fontSize: 12 }}>{err}</div> : null}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <label style={{ fontSize: 12, opacity: 0.8, whiteSpace: 'nowrap' }}>远程主机:</label>
              <select
                value={alias}
                onChange={(e) => {
                  const a = e.target.value
                  setAlias(a)
                  setLevels(null)
                  setErr('')
                  if (a) {
                    loadLevels(a, '/', 0)
                    if (!path.trim()) {
                      setPath('/')
                      loadSuggestions('/', a)
                    }
                  }
                }}
                style={{ ...inputS, maxWidth: '100%', minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                <option value="">— 选择 —</option>
                {hosts.map((h) => {
                  const problem = hostProblem(h)
                  return (
                    <option key={h.alias} value={h.alias} disabled={problem !== null}>
                      {h.alias} ({h.user}@{h.host}){h.source === 'manual' ? ' · 手动' : ''}
                      {problem ? ` · ${problem}` : ''}
                    </option>
                  )
                })}
              </select>
              <button
                style={{ ...buttonS, whiteSpace: 'nowrap' }}
                onClick={() => {
                  setAddOpen(!addOpen)
                  resetAddForm()
                }}
              >
                {addOpen ? '收起 ▴' : '+ 添加主机'}
              </button>
              {selectedHost && selectedHost.source === 'manual' ? (
                <button
                  style={{ ...buttonS, padding: '3px 8px', fontSize: 12, color: T.danger, whiteSpace: 'nowrap' }}
                  title={`删除手动主机 ${selectedHost.alias}`}
                  onClick={() => removeManualHost(selectedHost)}
                >
                  删除
                </button>
              ) : null}
            </div>
            {addOpen ? renderAddForm() : null}
            {hosts.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                未在 ~/.ssh/config 发现主机，也未手动添加。点击上方「+ 添加主机」登记一台，或在 ~/.ssh/config 配置 Host 条目后重新打开本窗口。
              </div>
            ) : null}
            {/* 路径输入框（带自动补全）+ 打开浏览弹层按钮 */}
            <div style={{ position: 'relative', display: 'flex', gap: 6 }}>
              <input
                value={path}
                onChange={(e) => onPathChange(e.target.value)}
                onFocus={() => loadSuggestions(path)}
                placeholder={alias ? '输入远程路径（自动补全）' : '先选择远程主机'}
                disabled={!alias}
                style={{ ...inputS, flex: 1, minWidth: 120 }}
              />
              <button
                style={{ ...buttonS, whiteSpace: 'nowrap' }}
                onClick={() => {
                  if (alias) setPopOpen(true)
                }}
                disabled={!alias}
              >
                浏览…
              </button>
              {/* 自动补全下拉 */}
              {suggestOpen && suggest.length ? (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: overlayBg, border: '1px solid ' + T.borderStrong, borderRadius: 8, marginTop: 4, maxHeight: 200, overflowY: 'auto', boxShadow: '0 6px 24px rgba(0,0,0,0.25)' }}>
                  {suggest.map((s, i) => (
                    <div key={s + i} onMouseDown={() => selectSuggestion(s)} style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            {err ? <div style={{ color: T.danger, fontSize: 12 }}>{err}</div> : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
              <span style={{ fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {path ? '所选: ' + path : ''}
              </span>
              <button style={{ ...buttonS, fontWeight: 600 }} onClick={() => commitPath(path)} disabled={busy || !alias || !path.trim()}>
                {busy ? '设置中…' : '设为远程工作区'}
              </button>
            </div>
            {/* 悬浮浏览弹层：选中的路径回填到输入框（不直接提交） */}
            {popOpen ? renderDirPopup() : null}
          </div>
        )}
        {tab === 'local' ? (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button style={{ background: 'transparent' }} onClick={onCancel}>
              取消
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── registration ────────────────────────────────────────────────────────────

/** Slot-registration metadata accepted by the DSH ui-slots client service. */
interface SlotMeta {
  name: string
  id: string
  priority: number
}

/** Structural slice of the DSH `slots` client service this plugin uses. */
interface SlotsLike {
  inject(slot: string, factory: () => unknown): unknown
  register(meta: SlotMeta, component: unknown): unknown
}

/**
 * Cordis client entry: register DirPicker into both directory-flow slots
 * (sidebar + conversation hero) at priority -100. The nested-inject shape is
 * copied from dsh-remote so installing into either slot drags the other along.
 */
export function apply(ctx: unknown): void {
  const get = (ctx as { get?: unknown } | null | undefined)?.get
  if (typeof get !== 'function') return
  const slots = (get as (key: string) => unknown).call(ctx, 'slots') as SlotsLike | null | undefined
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
  slots.inject('conversation.hero.workspace.directoryFlow', () =>
    slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield slots.register({ name: 'conversation.hero.workspace.directoryFlow', id: 'dsh-rw', priority: -100 }, DirPicker)
      yield slots.register({ name: 'sidebar.workspaces.directoryFlow', id: 'dsh-rw', priority: -100 }, DirPicker)
    }),
  )
}
