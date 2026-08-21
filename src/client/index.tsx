/// <reference lib="dom" />

// dsh-rw — client half: the unified workspace directory picker.
//
// One modal fills ui-workspace's two directory-flow holes (sidebar +
// conversation hero). The entry is a two-card chooser (本机 / 远程, each with
// a one-line explainer); picking a card drills into that flow's page, which
// carries a 「← 返回」 back to the cards:
//   • 本机 → 手动输入本机路径，或经 POST /api/dsh-rw/local-pick 调起系统
//     文件夹选择器，结果直接 onPicked(localPath)。
//   • 远程 → 主机用下拉选择（选项只显示别名；来自 ~/.ssh/config + 手动条目）；
//     路径默认落在远端 home（~/，服务端经 realpath('.') 扩展），输入框下方是
//     行内目录列表（Codex「New remote project」式）：列表实时跟随输入
//     内容（对父目录做 ls + 前缀过滤，防抖 ~220ms），点行下钻、↑ 回上一级；
//     可选「工作区名称」命名本地占位目录（留空用路径 basename，
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
  radius: 10,
  muted: v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
  label: v('--dsw-alias-label-primary', '#e4e4e7'),
}
const panelBg = v('--dsw-alias-bg-layer-1', '#18181b')

const inputS: CSSProperties = { flex: 1, padding: '9px 14px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, outline: 'none', fontSize: 14, transition: 'border-color .15s' }
const buttonS: CSSProperties = { padding: '9px 16px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, cursor: 'pointer', fontSize: 14, transition: 'background .15s, border-color .15s' }

/** Section caption above a field group (form pages). */
const labelS: CSSProperties = { fontSize: 14, color: T.muted }

/** Button with hover feedback; `primary` renders the Codex-style white
 * call-to-action (cf. "Add project"), `danger` the muted-danger look. */
function Btn(props: { primary?: boolean; danger?: boolean; title?: string; disabled?: boolean; style?: CSSProperties; onClick?: () => void; children: unknown }) {
  const [hov, setHov] = useState(false)
  const base: CSSProperties = props.primary
    ? { ...buttonS, background: '#f4f4f5', border: '1px solid #f4f4f5', color: '#18181b', fontWeight: 600 }
    : props.danger
      ? { ...buttonS, color: T.danger }
      : buttonS
  const hover: CSSProperties = hov && !props.disabled ? (props.primary ? { filter: 'brightness(0.92)' } : { background: T.bgHover, border: '1px solid ' + T.borderStrong }) : {}
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

// ── outline SVG icons (Codex-style flat line icons, stroke = currentColor) ──

function SvgFolder(props: { size?: number }) {
  const s = props.size ?? 15
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

function SvgGlobe(props: { size?: number }) {
  const s = props.size ?? 15
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9s1.4-6.4 3.9-9z" />
    </svg>
  )
}

function SvgLink(props: { size?: number }) {
  const s = props.size ?? 15
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  )
}

function SvgArrowUp(props: { size?: number }) {
  const s = props.size ?? 16
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  )
}

function SvgChevronDown(props: { size?: number }) {
  const s = props.size ?? 16
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function SvgChevronRight(props: { size?: number }) {
  const s = props.size ?? 16
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

function SvgArrowLeft(props: { size?: number }) {
  const s = props.size ?? 16
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  )
}

function SvgArrowRight(props: { size?: number }) {
  const s = props.size ?? 16
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </svg>
  )
}

function SvgMonitor(props: { size?: number }) {
  const s = props.size ?? 16
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  )
}

function SvgFile(props: { size?: number }) {
  const s = props.size ?? 15
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

function SvgX(props: { size?: number }) {
  const s = props.size ?? 14
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

/** Composite input with an attached icon cell at the left (Codex-style):
 * the border wraps icon + field as one control; focus rings the outer box. */
function IconInput(props: { icon: unknown; value: string; placeholder?: string; onChange: (e: { target: { value: string } }) => void }) {
  const [focus, setFocus] = useState(false)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        border: '1px solid ' + (focus ? T.accent : T.border),
        borderRadius: T.radius,
        background: T.bg,
        overflow: 'hidden',
        transition: 'border-color .15s',
      }}
    >
      <div style={{ width: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, borderRight: '1px solid ' + T.border }}>
        {props.icon as never}
      </div>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onChange={props.onChange}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: T.label, padding: '9px 14px', fontSize: 14 }}
      />
    </div>
  )
}

/** Label-left form row (add-host page): fixed label column + flexible field. */
function FormRow(props: { label: string; children: unknown }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 60, flexShrink: 0, fontSize: 13, color: T.label }}>{props.label}</div>
      <div style={{ flex: 1, display: 'flex', gap: 8 }}>{props.children as never}</div>
    </div>
  )
}

/** One row in the inline directory listing, with hover highlight. */
function DirRow(props: { item: LsItem; drill: boolean; onEnter: () => void }) {
  const [hov, setHov] = useState(false)
  const { item, drill } = props
  return (
    <div
      title={(drill ? '进入 ' : '文件: ') + item.name}
      onClick={drill ? props.onEnter : undefined}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ padding: '8px 12px', cursor: drill ? 'pointer' : 'default', color: T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 10, alignItems: 'center', fontSize: 14, borderRadius: 6, background: hov && drill ? T.bgHover : 'transparent' }}
    >
      <span style={{ color: T.muted, display: 'flex', flexShrink: 0 }}>{item.type === 'dir' ? <SvgFolder /> : item.type === 'symlink' ? <SvgLink /> : <SvgFile />}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{item.name}</span>
      {drill ? (
        <span style={{ color: T.muted, display: 'flex' }}>
          <SvgChevronRight size={13} />
        </span>
      ) : null}
    </div>
  )
}

/** Entry-step card: lifts and highlights on hover, chevron hints drill-in. */
function FlowCard(props: { icon: unknown; title: string; desc: string; onClick: () => void }) {
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
        <div style={{ color: hov ? T.accent : T.label, display: 'flex', transition: 'color .15s' }}>{props.icon as never}</div>
        <div style={{ color: hov ? T.accent : T.muted, display: 'flex', transition: 'color .15s' }}>
          <SvgArrowRight size={17} />
        </div>
      </div>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{props.title}</div>
      <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>{props.desc}</div>
    </div>
  )
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
  // 本机路径独立成 state：远程页会把 path 写成远端 home（~/ 扩展结果），
  // 共用一个 state 会让远程路径残留进本机输入框。
  const [localPath, setLocalPath] = useState('')
  const [wsName, setWsName] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  // 行内目录列表状态：dirBase 是列表内容所属的目录，dirItems 是该目录下
  // 可下钻的条目（仅目录/符号链接；点行下钻，↑ 回上一级）。
  const [dirItems, setDirItems] = useState<LsItem[]>([])
  const [dirBase, setDirBase] = useState('')
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

  // 行内目录列表的数据源：列出 dir 的下钻条目（仅目录/符号链接）。
  // sync=true 时把服务端解析后的真实路径回填输入框（用于 ~/ 默认路径，
  // 服务端经 realpath('.') 扩展为远端 home 的绝对路径）。
  const loadDir = (a: string, dir: string, sync?: boolean) => {
    if (!a) return
    setLoading(true)
    setErr('')
    api<LsResponse>('GET', `/api/dsh-rw/ls?alias=${encodeURIComponent(a)}&path=${encodeURIComponent(dir || '/')}`)
      .then((res) => {
        const real = res.path || dir || '/'
        setDirBase(real)
        if (sync) setPath(real)
        setDirItems((Array.isArray(res.items) ? res.items : []).filter(drillable).slice(0, 400))
      })
      .catch((e) => {
        setDirItems([])
        setErr(errText(e))
      })
      .finally(() => setLoading(false))
  }

  // 输入补全：对末段的父目录做 ls，按末段前缀过滤，结果同样进列表。
  const completePath = (raw: string, aid?: string) => {
    const a = aid || alias
    const t = String(raw || '').trim()
    if (!a || !t) {
      setDirItems([])
      return
    }
    const slash = t.lastIndexOf('/')
    const parent = slash <= 0 ? '/' : t.slice(0, slash)
    const lastSeg = slash < 0 ? t : t.slice(slash + 1)
    api<LsResponse>('GET', `/api/dsh-rw/ls?alias=${encodeURIComponent(a)}&path=${encodeURIComponent(parent)}`)
      .then((res) => {
        const list = Array.isArray(res.items) ? res.items : []
        setDirBase(res.path || parent)
        setDirItems(
          list
            .filter((it) => drillable(it) && it.name.toLowerCase().startsWith(lastSeg.toLowerCase()))
            .slice(0, 400),
        )
      })
      .catch(() => setDirItems([]))
  }

  const onPathChange = (raw: string) => {
    setPath(raw)
    setErr('')
    if (suggestTimer.current !== null) window.clearTimeout(suggestTimer.current)
    suggestTimer.current = window.setTimeout(() => completePath(raw), 220)
  }

  // 下钻：点列表里的一行 → 路径进入该目录并刷新列表。
  const selectDir = (name: string) => {
    const base = dirBase || '/'
    const next = base === '/' ? '/' + name : base + '/' + name
    setPath(next)
    setErr('')
    loadDir(alias, next)
  }

  // ↑ 回上一级：取输入框路径的父目录并刷新列表。
  const goUp = () => {
    const norm = String(path || '').replace(/\/+$/, '')
    const idx = norm.lastIndexOf('/')
    const parent = idx <= 0 ? '/' : norm.slice(0, idx)
    setPath(parent)
    setErr('')
    loadDir(alias, parent)
  }

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
    if (t === 'remote' && alias) {
      // 已输入过路径则保留（列表跟随其内容），否则默认落在远端 home（~/）。
      const start = path.trim()
      if (start) {
        loadDir(alias, start)
      } else {
        setPath('~/')
        loadDir(alias, '~/', true)
      }
    }
  }

  // Commit the remote path as the workspace: the host resolves it (realpath),
  // creates the local placeholder dir (named by 工作区名称 when given), and
  // answers with its path.
  const commitPath = (p: string) => {
    const target = String(p || '').trim()
    if (!target || !alias || busy) return
    const name = wsName.trim()
    api<WorkspaceResponse>('POST', '/api/dsh-rw/workspace', { alias, path: target, ...(name ? { name } : {}) })
      .then((res) => {
        if (res && res.ok && res.placeholderDir) onPicked(String(res.placeholderDir))
        else setErr((res && res.error) || '设置远程工作区失败')
      })
      .catch((e) => setErr(errText(e)))
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
            setErr('')
            setPath('~/')
            loadDir(newAlias, '~/', true)
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
          setDirItems([])
          if (next) {
            setPath('~/')
            loadDir(next, '~/', true)
          }
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
        <FormRow label="名称">
          <TextInput value={form.alias} onChange={(e: { target: { value: string } }) => updForm({ alias: e.target.value })} placeholder="例如 编译机" />
        </FormRow>
        <FormRow label="主机">
          <TextInput value={form.host} onChange={(e: { target: { value: string } }) => updForm({ host: e.target.value })} placeholder="IP 或 hostname" style={{ fontFamily: 'monospace' }} />
        </FormRow>
        <FormRow label="端口">
          <TextInput value={form.port} onChange={(e: { target: { value: string } }) => updForm({ port: e.target.value })} placeholder="22" inputMode="numeric" />
        </FormRow>
        <FormRow label="用户">
          <TextInput value={form.user} onChange={(e: { target: { value: string } }) => updForm({ user: e.target.value })} placeholder="root" />
        </FormRow>
        <FormRow label="认证方式">
          {seg('key', '私钥路径')}
          {seg('password', '密码')}
        </FormRow>
        {form.authKind === 'key' ? (
          <>
            <FormRow label="私钥路径">
              <TextInput value={form.keyPath} onChange={(e: { target: { value: string } }) => updForm({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" style={{ fontFamily: 'monospace' }} />
            </FormRow>
            <FormRow label="私钥口令">
              <TextInput value={form.passphrase} onChange={(e: { target: { value: string } }) => updForm({ passphrase: e.target.value })} type="password" placeholder="可选" />
            </FormRow>
          </>
        ) : (
          <FormRow label="密码">
            <TextInput value={form.password} onChange={(e: { target: { value: string } }) => updForm({ password: e.target.value })} type="password" placeholder="不回显、仅保存" />
          </FormRow>
        )}
        {formErr ? <div style={{ color: T.danger, fontSize: 12 }}>{formErr}</div> : null}
        {testMsg ? <div style={{ color: testOk ? T.ok : T.danger, fontSize: 12 }}>{testMsg}</div> : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid ' + T.border, paddingTop: 12, marginTop: 2 }}>
          <Btn onClick={resetAddForm} disabled={busyForm}>
            清空
          </Btn>
          <Btn onClick={testNewHost} disabled={busyForm}>
            {testing ? '测试中…' : '测试连接'}
          </Btn>
          <Btn primary onClick={saveNewHost} disabled={busyForm}>
            {saving ? '保存中…' : '保存'}
          </Btn>
        </div>
      </div>
    )
  }

  if (!open) return null

  const selectedHost = hosts.find((h) => h.alias === alias)

  // 卡片步：两张大卡片（本机 / 远程），各带一句说明，点击进对应表单页。
  const card = (t: 'local' | 'remote', icon: unknown, title: string, desc: string) => <FlowCard onClick={() => openFlow(t)} icon={icon} title={title} desc={desc} />

  // 圆形返回钮（无文字）：addHost 子页回远程表单页（接管旧「取消」职责，
  // 清空表单——密码与私钥口令不留存于 state），其余表单页回卡片步。
  const backBtn = (
    <Btn
      title="返回"
      style={{ width: 32, height: 32, padding: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
      onClick={() => {
        if (view === 'addHost') {
          resetAddForm()
          setView('remote')
        } else {
          setView('cards')
        }
      }}
      disabled={busy}
    >
      <SvgArrowLeft size={16} />
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
        style={{ background: panelBg, border: '1px solid ' + T.borderStrong, borderRadius: 14, boxShadow: '0 16px 56px rgba(0,0,0,0.55)', width: 'min(640px, 94vw)', padding: 22, boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          {view !== 'cards' ? backBtn : null}
          <div style={{ flex: 1, fontSize: 17, fontWeight: 600 }}>{viewTitle}</div>
          <Btn
            style={{ padding: '4px 6px', border: '1px solid transparent', background: 'transparent', color: T.muted, display: 'flex', alignItems: 'center' }}
            onClick={() => {
              if (!busy) onCancel()
            }}
            disabled={busy}
          >
            <SvgX />
          </Btn>
        </div>
        {view === 'cards' ? (
          <div style={{ display: 'flex', gap: 12 }}>
            {card('local', <SvgMonitor size={22} />, '本机目录', '使用这台电脑上的文件夹，直接输入路径或打开系统文件夹选择器。')}
            {card('remote', <SvgGlobe size={22} />, '远程工作区', '通过 SSH 在远程主机上选一个目录，本地操作都会实时落到远程。')}
          </div>
        ) : null}
        {view === 'local' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>系统选择器优先；不可用时直接输入本机目录。</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={labelS}>本机路径</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <TextInput value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="本机目录，如 /Users/you/project" />
                <Btn primary onClick={() => (localPath.trim() ? onPicked(localPath.trim()) : undefined)} disabled={!localPath.trim()}>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {view === 'addHost' ? (
              renderAddForm()
            ) : (
              <>
                {/* 工作区名称（可选）：Codex 式图标格输入框，置顶；留空用路径末级目录名 */}
                <IconInput icon={<SvgFolder />} value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="工作区名称（可选）" />
                {/* 远程主机：caption 行内放「+ 添加主机 / 删除」，下拉选项只显示别名 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ ...labelS, flex: 1 }}>远程主机</div>
                    <Btn
                      style={{ padding: '2px 9px', border: '1px solid transparent', background: 'transparent', color: T.accent, fontSize: 12, whiteSpace: 'nowrap' }}
                      onClick={() => {
                        resetAddForm()
                        setView('addHost')
                      }}
                    >
                      + 添加主机
                    </Btn>
                    {selectedHost && selectedHost.source === 'manual' ? (
                      <Btn danger style={{ padding: '2px 9px', fontSize: 12, whiteSpace: 'nowrap' }} title={`删除手动主机 ${selectedHost.alias}`} onClick={() => removeManualHost(selectedHost)}>
                        删除
                      </Btn>
                    ) : null}
                  </div>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: T.accent, display: 'flex', pointerEvents: 'none', zIndex: 1 }}>
                      <SvgGlobe />
                    </span>
                    <select
                      value={alias}
                      onChange={(e) => {
                        const a = e.target.value
                        setAlias(a)
                        setErr('')
                        if (a) {
                          setPath('~/')
                          loadDir(a, '~/', true)
                        } else {
                          setDirItems([])
                        }
                      }}
                      style={{ ...inputS, width: '100%', boxSizing: 'border-box', paddingLeft: 40, paddingRight: 36, appearance: 'none', WebkitAppearance: 'none' }}
                    >
                      <option value="">— 选择 —</option>
                      {hosts.map((h) => (
                        <option key={h.alias} value={h.alias} disabled={hostProblem(h) !== null}>
                          {h.alias}
                        </option>
                      ))}
                    </select>
                    <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: T.muted, display: 'flex', pointerEvents: 'none' }}>
                      <SvgChevronDown />
                    </span>
                  </div>
                </div>
                {hosts.length === 0 ? (
                  <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>
                    未在 ~/.ssh/config 发现主机，也未手动添加。点击上方「+ 添加主机」登记一台，或在 ~/.ssh/config 配置 Host 条目后重新打开本窗口。
                  </div>
                ) : null}
                {/* 远程路径：↑ 上一级 + 输入框，下方行内目录列表实时跟随 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={labelS}>远程路径</div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
                    <Btn style={{ padding: '0 12px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="上一级" onClick={goUp} disabled={!alias}>
                      <SvgArrowUp />
                    </Btn>
                    <TextInput
                      value={path}
                      onChange={(e: { target: { value: string } }) => onPathChange(e.target.value)}
                      onFocus={() => completePath(path)}
                      placeholder={alias ? '输入远程路径（下方列表实时跟随）' : '先选择远程主机'}
                      disabled={!alias}
                      style={{ flex: 1, minWidth: 120 }}
                    />
                  </div>
                  <div style={{ border: '1px solid ' + T.border, borderRadius: 10, background: T.bg, maxHeight: 240, overflowY: 'auto', overflowX: 'hidden', padding: 4 }}>
                    {!alias ? (
                      <div style={{ color: T.muted, padding: 12, fontSize: 12 }}>先选择远程主机</div>
                    ) : loading ? (
                      <div style={{ color: T.muted, padding: 12, fontSize: 12 }}>加载中…</div>
                    ) : dirItems.length ? (
                      dirItems.map((it, i) => <DirRow key={it.name + '-' + i} item={it} drill onEnter={() => selectDir(it.name)} />)
                    ) : (
                      <div style={{ color: T.muted, padding: 12, fontSize: 12 }}>（无匹配目录）</div>
                    )}
                  </div>
                </div>
                {err ? <div style={{ color: T.danger, fontSize: 12 }}>{err}</div> : null}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', borderTop: '1px solid ' + T.border, paddingTop: 12, marginTop: 2 }}>
                  <Btn style={{ border: '1px solid transparent', background: 'transparent', color: T.muted }} onClick={onCancel} disabled={busy}>
                    取消
                  </Btn>
                  <Btn primary onClick={() => commitPath(path)} disabled={busy || !alias || !path.trim()}>
                    {busy ? '设置中…' : '设为远程工作区'}
                  </Btn>
                </div>
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
