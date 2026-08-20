/// <reference lib="dom" />

// dsh-rw — client half: the unified workspace directory picker.
//
// One modal fills ui-workspace's two directory-flow holes (sidebar +
// conversation hero). The entry is a two-card chooser (本机 / 远程, each with
// a one-line explainer); picking a card drills into that flow's page, which
// carries a 「← 返回」 back to the cards:
//   • 本机 → 手动输入本机路径，或经 POST /api/dsh-rw/local-pick 调起系统
//     文件夹选择器，结果直接 onPicked(localPath)。
//   • 远程 → 选一台 SSH 主机（来自 ~/.ssh/config + 手动条目），输入路径时
//     逐级自动补全（防抖 ~220ms，对父目录做 ls + 前缀过滤），或用「浏览…」弹层
//     逐级下钻；可选「工作区名称」命名本地占位目录（留空用路径 basename，
//     仅重名冲突时服务端才追加哈希后缀）。确认后 POST /api/dsh-rw/workspace
//     拿到本地占位目录 → onPicked(placeholderDir)，交给 DSH 原生流程登记为
//     workspace。「+ 添加主机」跳到 modal 内独立子页（带返回）：测试连接走
//     POST /test 完整字段形式（临时探测不入库），保存走 POST /hosts；手动
//     条目带「手动」标注，选中后可在远程页删除。密码只提交不展示。
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
  bgHover: v('--dsw-alias-bg-layer-2', 'rgba(128,128,128,0.14)'),
  border: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
  borderStrong: v('--dsw-alias-border-l3', 'rgba(128,128,128,0.5)'),
  accent: v('--dsw-alias-accent-primary', '#4c8dff'),
  danger: v('--dsw-static-red-500', '#e06c75'),
  ok: v('--dsw-static-green-500', '#4caf7d'),
  radius: 8,
  muted: v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
  label: v('--dsw-alias-label-primary', '#e4e4e7'),
}
const overlayBg = v('--dsw-alias-bg-overlay', '#1e1e1e')
const panelBg = v('--dsw-alias-bg-layer-1', '#18181b')

const inputS: CSSProperties = { flex: 1, padding: '7px 12px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, outline: 'none', fontSize: 13, transition: 'border-color .15s' }
const buttonS: CSSProperties = { padding: '7px 14px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, cursor: 'pointer', fontSize: 13, transition: 'background .15s, border-color .15s' }

/** Section caption above a field group (form pages). */
const labelS: CSSProperties = { fontSize: 12, fontWeight: 600, color: T.muted, letterSpacing: 0.2 }

/** Button with hover feedback; `primary` renders the accent call-to-action,
 * `danger` keeps the muted-danger look for destructive actions. */
function Btn(props: { primary?: boolean; danger?: boolean; title?: string; disabled?: boolean; style?: CSSProperties; onClick?: () => void; children: unknown }) {
  const [hov, setHov] = useState(false)
  const base: CSSProperties = props.primary
    ? { ...buttonS, background: T.accent, border: '1px solid ' + T.accent, color: '#fff', fontWeight: 600 }
    : props.danger
      ? { ...buttonS, color: T.danger }
      : buttonS
  const hover: CSSProperties = hov && !props.disabled ? (props.primary ? { filter: 'brightness(1.12)' } : { background: T.bgHover, border: '1px solid ' + T.borderStrong }) : {}
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ ...base, ...hover, ...(props.disabled ? { opacity: 0.55, cursor: 'default' } : {}), ...(props.style || {}) }}
    >
      {props.children as never}
    </button>
  )
}

/** Text input with an accent focus ring (inline styles can't do :focus). */
function TextInput(props: Record<string, unknown> & { value: string; onChange: (e: { target: { value: string } }) => void }) {
  const [focus, setFocus] = useState(false)
  const { style, onFocus, onBlur, ...rest } = props as { style?: CSSProperties; onFocus?: (e: unknown) => void; onBlur?: (e: unknown) => void } & Record<string, unknown>
  return (
    <input
      {...(rest as any)} // eslint-disable-line @typescript-eslint/no-explicit-any -- passthrough input props
      style={{ ...inputS, ...(focus ? { border: '1px solid ' + T.accent } : {}), ...(style || {}) }}
      onFocus={(e: unknown) => {
        setFocus(true)
        if (onFocus) onFocus(e)
      }}
      onBlur={(e: unknown) => {
        setFocus(false)
        if (onBlur) onBlur(e)
      }}
    />
  )
}

/** One autocomplete suggestion row with hover highlight. */
function SuggestRow(props: { text: string; onPick: () => void }) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onMouseDown={props.onPick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', borderRadius: 6, background: hov ? T.bgHover : 'transparent' }}
    >
      {props.text}
    </div>
  )
}

/** One row in the browse popup's directory listing, with hover highlight. */
function DirRow(props: { item: LsItem; drill: boolean; onEnter: () => void }) {
  const [hov, setHov] = useState(false)
  const { item, drill } = props
  return (
    <div
      title={(drill ? '进入 ' : '文件: ') + item.name}
      onClick={drill ? props.onEnter : undefined}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ padding: '7px 10px', cursor: drill ? 'pointer' : 'default', color: drill ? T.ok : T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderRadius: 6, background: hov && drill ? T.bgHover : 'transparent' }}
    >
      <span>{item.type === 'dir' ? '📁' : item.type === 'symlink' ? '🔗' : '📄'}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{item.name}</span>
      {drill ? <span style={{ color: T.muted, fontSize: 11 }}>›</span> : null}
    </div>
  )
}

/** Entry-step card: lifts and highlights on hover, chevron hints drill-in. */
function FlowCard(props: { icon: string; title: string; desc: string; onClick: () => void }) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onClick={props.onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        flex: 1,
        border: '1px solid ' + (hov ? T.accent : T.border),
        borderRadius: 12,
        padding: '18px 16px',
        cursor: 'pointer',
        background: hov ? T.bgHover : T.bg,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transform: hov ? 'translateY(-1px)' : 'none',
        boxShadow: hov ? '0 6px 20px rgba(0,0,0,0.25)' : 'none',
        transition: 'border-color .15s, background .15s, transform .15s, box-shadow .15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 24 }}>{props.icon}</div>
        <div style={{ color: hov ? T.accent : T.muted, fontSize: 16, transition: 'color .15s' }}>→</div>
      </div>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{props.title}</div>
      <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>{props.desc}</div>
    </div>
  )
}

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
  // 视图状态机：cards（两张大卡片入口）→ local / remote 表单页；addHost 是
  // 从 remote 页跳入的独立子页，四者互斥，除 cards 外都有「← 返回」。
  const [view, setView] = useState<'cards' | 'local' | 'remote' | 'addHost'>('cards')
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [alias, setAlias] = useState('')
  const [path, setPath] = useState('')
  const [wsName, setWsName] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  // 级联下钻状态：每一格是 { path, all } —— 该路径下的条目列表。
  const [levels, setLevels] = useState<Level[] | null>(null)
  const [popOpen, setPopOpen] = useState(false)
  const [suggest, setSuggest] = useState<string[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const suggestTimer = useRef<number | null>(null)
  // 「添加主机」子页表单状态（view === 'addHost' 时独占整页）。
  const [form, setForm] = useState<AddHostForm>(emptyAddForm)
  const [formErr, setFormErr] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [testOk, setTestOk] = useState(false)

  // On open: always land on the card step, then fetch the host inventory
  // (+ current alias for preselection).
  useEffect(() => {
    if (!open) return
    setView('cards')
    setWsName('')
    setErr('')
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

  // 进入本机/远程表单页（卡片步点击或子页返回时调用）。
  const openFlow = (t: 'local' | 'remote') => {
    setView(t)
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
  // creates the local placeholder dir (named by 工作区名称 when given), and
  // answers with its path.
  const commitPath = (p: string) => {
    const target = String(p || '').trim()
    if (!target || !alias || busy) return
    setPopOpen(false)
    setSuggestOpen(false)
    const name = wsName.trim()
    api<WorkspaceResponse>('POST', '/api/dsh-rw/workspace', { alias, path: target, ...(name ? { name } : {}) })
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

  // 保存手动主机：成功后清空表单（含密码）、回到远程页、刷新列表并自动选中新主机。
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
        setView('remote')
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
    // 认证方式分段选择器的一段。
    const seg = (kind: 'key' | 'password', label: string) => {
      const active = form.authKind === kind
      return (
        <button
          onClick={() => updForm({ authKind: kind })}
          style={{
            ...buttonS,
            flex: 1,
            border: '1px solid ' + (active ? T.accent : T.border),
            background: active ? T.bgHover : 'transparent',
            color: active ? T.accent : T.label,
            fontWeight: active ? 600 : 400,
          }}
        >
          {label}
        </button>
      )
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>保存为手动主机（~/.dsh/dsh-rw.json）；密码与私钥口令仅用于提交，此处不回显。</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={labelS}>基本信息</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <TextInput value={form.alias} onChange={(e: { target: { value: string } }) => updForm({ alias: e.target.value })} placeholder="别名 *（字母数字 . _ -）" />
            <TextInput value={form.host} onChange={(e: { target: { value: string } }) => updForm({ host: e.target.value })} placeholder="主机 *（IP 或域名）" style={{ flex: 2 }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <TextInput value={form.port} onChange={(e: { target: { value: string } }) => updForm({ port: e.target.value })} placeholder="端口（默认 22）" inputMode="numeric" />
            <TextInput value={form.user} onChange={(e: { target: { value: string } }) => updForm({ user: e.target.value })} placeholder="用户（默认 root）" />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={labelS}>认证方式</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {seg('key', '私钥路径')}
            {seg('password', '密码')}
          </div>
          {form.authKind === 'key' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <TextInput value={form.keyPath} onChange={(e: { target: { value: string } }) => updForm({ keyPath: e.target.value })} placeholder="私钥路径 *（如 ~/.ssh/id_ed25519）" style={{ flex: 2, fontFamily: 'monospace' }} />
              <TextInput value={form.passphrase} onChange={(e: { target: { value: string } }) => updForm({ passphrase: e.target.value })} type="password" placeholder="私钥口令（可选）" />
            </div>
          ) : (
            <TextInput value={form.password} onChange={(e: { target: { value: string } }) => updForm({ password: e.target.value })} type="password" placeholder="密码 *" />
          )}
        </div>
        {formErr ? <div style={{ color: T.danger, fontSize: 12 }}>{formErr}</div> : null}
        {testMsg ? <div style={{ color: testOk ? T.ok : T.danger, fontSize: 12 }}>{testMsg}</div> : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid ' + T.border, paddingTop: 12, marginTop: 2 }}>
          <Btn onClick={testNewHost} disabled={busyForm}>
            {testing ? '测试中…' : '测试连接'}
          </Btn>
          <Btn primary onClick={saveNewHost} disabled={busyForm}>
            {saving ? '保存中…' : '保存'}
          </Btn>
          <Btn
            onClick={() => {
              setView('remote')
              resetAddForm()
            }}
            disabled={busyForm}
          >
            取消
          </Btn>
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid ' + T.border }}>
            <Btn style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setLevels((p) => (p && p.length > 1 ? p.slice(0, p.length - 1) : p))} disabled={levels.length <= 1 || loading}>
              回上一级 ▴
            </Btn>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {breadcrumb(!!alias, last.path, jumpTo)}
            </div>
            <Btn style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setPopOpen(false)}>
              关闭 ✕
            </Btn>
          </div>
          <div style={{ overflowY: 'auto', overflowX: 'hidden', padding: 4 }}>
            {loading ? (
              <div style={{ color: T.muted, padding: 12, fontSize: 12 }}>加载中…</div>
            ) : entries.length ? (
              entries.slice(0, 400).map((it, i) => {
                const drill = drillable(it)
                return <DirRow key={it.name + '-' + i} item={it} drill={drill} onEnter={() => enterDir(it.name)} />
              })
            ) : (
              <div style={{ color: T.muted, padding: 12, fontSize: 12 }}>（空目录）</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid ' + T.border }}>
            <span style={{ fontSize: 11, color: T.muted, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {'所选: ' + last.path}
            </span>
            <Btn primary onClick={() => acceptBrowserPick(last.path)}>
              选用此路径
            </Btn>
          </div>
        </div>
      </div>
    )
  }

  if (!open) return null

  const selectedHost = hosts.find((h) => h.alias === alias)

  // 卡片步：两张大卡片（本机 / 远程），各带一句说明，点击进对应表单页。
  const card = (t: 'local' | 'remote', icon: string, title: string, desc: string) => <FlowCard onClick={() => openFlow(t)} icon={icon} title={title} desc={desc} />

  // 「← 返回」：addHost 子页回远程表单页，其余表单页回卡片步。
  const backBtn = (
    <Btn style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => (view === 'addHost' ? setView('remote') : setView('cards'))} disabled={busy}>
      ← 返回
    </Btn>
  )

  const viewTitle = view === 'cards' ? '选择工作目录' : view === 'local' ? '本机目录' : view === 'remote' ? '远程工作区' : '添加远程主机'

  // 全屏居中 modal（遮罩 + 面板）：在窄 sidebar 和 conversation 里渲染一致。
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={() => {
        if (!busy) onCancel()
      }}
    >
      <div
        style={{ background: panelBg, border: '1px solid ' + T.borderStrong, borderRadius: 14, boxShadow: '0 16px 56px rgba(0,0,0,0.55)', width: 'min(640px, 94vw)', padding: 20, boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          {view !== 'cards' ? backBtn : null}
          <div style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>{viewTitle}</div>
          <Btn
            style={{ padding: '2px 9px', border: '1px solid transparent', background: 'transparent', color: T.muted }}
            onClick={() => {
              if (!busy) onCancel()
            }}
            disabled={busy}
          >
            ✕
          </Btn>
        </div>
        {view === 'cards' ? (
          <div style={{ display: 'flex', gap: 12 }}>
            {card('local', '💻', '本机目录', '使用这台电脑上的文件夹，直接输入路径或打开系统文件夹选择器。')}
            {card('remote', '🌐', '远程工作区', '通过 SSH 在远程主机上选一个目录，本地操作都会实时落到远程。')}
          </div>
        ) : null}
        {view === 'local' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>系统选择器优先；不可用时直接输入本机目录。</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={labelS}>本机路径</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <TextInput value={path} onChange={(e) => setPath(e.target.value)} placeholder="本机目录，如 /Users/you/project" />
                <Btn primary onClick={() => (path.trim() ? onPicked(path.trim()) : undefined)} disabled={!path.trim()}>
                  选用
                </Btn>
              </div>
            </div>
            <Btn style={{ alignSelf: 'flex-start' }} onClick={chooseLocal} disabled={loading}>
              {loading ? '打开中…' : '打开系统文件夹选择器'}
            </Btn>
            {err ? <div style={{ color: T.danger, fontSize: 12 }}>{err}</div> : null}
          </div>
        ) : null}
        {view === 'remote' || view === 'addHost' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {view === 'addHost' ? (
              renderAddForm()
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={labelS}>远程主机</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
                    <Btn
                      style={{ whiteSpace: 'nowrap' }}
                      onClick={() => {
                        resetAddForm()
                        setView('addHost')
                      }}
                    >
                      + 添加主机
                    </Btn>
                    {selectedHost && selectedHost.source === 'manual' ? (
                      <Btn danger style={{ padding: '5px 10px', fontSize: 12, whiteSpace: 'nowrap' }} title={`删除手动主机 ${selectedHost.alias}`} onClick={() => removeManualHost(selectedHost)}>
                        删除
                      </Btn>
                    ) : null}
                  </div>
                  {selectedHost ? (
                    <div style={{ fontSize: 11, color: T.muted, fontFamily: 'monospace' }}>
                      {selectedHost.user}@{selectedHost.host}:{selectedHost.port} · {selectedHost.authKind === 'key' ? '私钥' : '密码'}认证
                    </div>
                  ) : null}
                </div>
                {hosts.length === 0 ? (
                  <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>
                    未在 ~/.ssh/config 发现主机，也未手动添加。点击上方「+ 添加主机」登记一台，或在 ~/.ssh/config 配置 Host 条目后重新打开本窗口。
                  </div>
                ) : null}
                {/* 路径输入框（带自动补全）+ 打开浏览弹层按钮 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={labelS}>远程路径</div>
                  <div style={{ position: 'relative', display: 'flex', gap: 8 }}>
                    <TextInput
                      value={path}
                      onChange={(e: { target: { value: string } }) => onPathChange(e.target.value)}
                      onFocus={() => loadSuggestions(path)}
                      placeholder={alias ? '输入远程路径（自动补全）' : '先选择远程主机'}
                      disabled={!alias}
                      style={{ flex: 1, minWidth: 120, fontFamily: 'monospace' }}
                    />
                    <Btn
                      style={{ whiteSpace: 'nowrap' }}
                      onClick={() => {
                        if (alias) setPopOpen(true)
                      }}
                      disabled={!alias}
                    >
                      浏览…
                    </Btn>
                    {/* 自动补全下拉 */}
                    {suggestOpen && suggest.length ? (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: overlayBg, border: '1px solid ' + T.borderStrong, borderRadius: 8, marginTop: 4, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 28px rgba(0,0,0,0.35)', padding: 4 }}>
                        {suggest.map((s, i) => (
                          <SuggestRow key={s + i} text={s} onPick={() => selectSuggestion(s)} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                {/* 工作区名称：可选；留空用路径末级目录名，仅重名冲突时服务端追加哈希后缀 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={labelS}>工作区名称（可选）</div>
                  <TextInput value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="默认取路径末级目录名" />
                </div>
                {err ? <div style={{ color: T.danger, fontSize: 12 }}>{err}</div> : null}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', borderTop: '1px solid ' + T.border, paddingTop: 12, marginTop: 2 }}>
                  <span style={{ fontSize: 11, color: T.muted, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {path ? '所选: ' + path : ''}
                  </span>
                  <Btn primary onClick={() => commitPath(path)} disabled={busy || !alias || !path.trim()}>
                    {busy ? '设置中…' : '设为远程工作区'}
                  </Btn>
                </div>
                {/* 悬浮浏览弹层：选中的路径回填到输入框（不直接提交） */}
                {popOpen ? renderDirPopup() : null}
              </>
            )}
          </div>
        ) : null}
        {view === 'local' ? (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn style={{ border: '1px solid transparent', background: 'transparent', color: T.muted }} onClick={onCancel}>
              取消
            </Btn>
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
