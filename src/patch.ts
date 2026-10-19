// dsh-rw — unified diff helpers (pure: strings in, strings/structs out). These
// back the future rw_diff and rw_apply_patch tools: rw_diff renders a remote
// file's change as a unified diff, rw_apply_patch validates a patch and then
// lets `patch -pN` apply it on the host. Keeping the text logic dependency-free
// makes it testable without SSH and keeps every IO call in the tool wiring.
//
// patchTargets is the security gate: before a patch may be applied, every path
// it mentions is resolved under the workspace root and rejected when it stays
// absolute, becomes empty, or climbs out with '..'.
//
// Parsing is a genuine (small) unified-diff parser instead of a scan for
// '---'/'+++' lines: it tracks hunk counts while walking a hunk body, because
// a removed line whose content starts with '--' is rendered as '--- …' and
// must not be mistaken for a file header.

const DEFAULT_CONTEXT = 3
// Above this many lines the LCS table gets too big to be worth it, so the
// fallback is a conservative "replace the whole file" hunk. Correctness (and
// therefore round-tripping) matters more than a minimal diff for huge inputs.
const MAX_LCS_LINES = 2000
const NO_NEWLINE_MARKER = '\\ No newline at end of file'

/** One file's entry in a parsed unified diff. */
export interface PatchFile {
  /** The path as written in the diff's `---`/`+++` lines, minus any a/ b/ prefix and trailing timestamp. */
  oldPath: string
  newPath: string
  /** True for /dev/null (file created or deleted). */
  oldIsNull: boolean
  newIsNull: boolean
}

/**
 * Malformed patch text: no `---`/`+++` pair, a missing `+++`, a bad hunk
 * header or an unreadable hunk body.
 */
export class PatchFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchFormatError'
  }
}

/**
 * A patch path that would leave the workspace: absolute, empty after
 * stripping, or containing '..'.
 */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

/**
 * Parse a unified diff into its file entries. Accepts the forms produced by
 * git and `diff -u`: optional `diff --git` / `index` metadata, `a/`/`b/`
 * prefixes, `/dev/null` on either side, timestamps after a tab, and multiple
 * files. Throws PatchFormatError when no file header pair exists at all or
 * when a `---` header has no `+++` partner.
 */
export function parsePatch(patch: string): PatchFile[] {
  return parseEntries(patch).map((entry) => ({
    oldPath: stripDiffPrefix(entry.oldPath),
    newPath: stripDiffPrefix(entry.newPath),
    oldIsNull: entry.oldIsNull,
    newIsNull: entry.newIsNull,
  }))
}

/** True when the text looks like it contains a NUL byte (binary content). */
export function looksBinary(text: string): boolean {
  return text.includes('\u0000')
}

/**
 * Build a unified diff for one file from two texts. Returns '' when the texts
 * are identical. Header uses `a/<path>` and `b/<path>`, `---`/`+++` lines, and
 * @@ hunks with `contextLines` lines of context (default 3, 0 allowed).
 *
 * Line terminators are treated as content, so a change that only adds or
 * removes the final newline is a real change and is represented with the
 * `\ No newline at end of file` marker.
 */
export function unifiedDiff(path: string, before: string, after: string, contextLines?: number): string {
  if (before === after) return ''
  const context = normalizeContext(contextLines)
  const beforeLines = splitKeep(before)
  const afterLines = splitKeep(after)
  const ops =
    beforeLines.length > MAX_LCS_LINES || afterLines.length > MAX_LCS_LINES
      ? replaceAllOps(beforeLines, afterLines)
      : diffLines(beforeLines, afterLines)
  const out = [`--- a/${path}`, `+++ b/${path}`]
  for (const hunk of buildHunks(ops, context)) {
    // Always print both counts (never the `,1` shorthand) so the header is
    // unambiguous for callers and for `patch` alike.
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)
    for (const line of hunk.lines) {
      out.push(`${line.kind}${line.text}`)
      if (line.noNewline) out.push(NO_NEWLINE_MARKER)
    }
  }
  return `${out.join('\n')}\n`
}

/**
 * Apply a single-file unified diff produced by unifiedDiff (or a normal one)
 * to `before`. Matching is exact — no fuzz, no offset guessing — and a hunk
 * whose context does not match throws PatchFormatError, so a stale patch can
 * never silently corrupt a remote file.
 */
export function applyUnifiedDiff(before: string, patch: string): string {
  // unifiedDiff returns '' when the texts are identical, so an empty patch is
  // the no-change case: applying it returns the input unchanged. This keeps
  // `applyUnifiedDiff(before, unifiedDiff(path, before, after)) === after`
  // total, including before === after. Any non-empty text still has to parse.
  if (patch === '') return before
  const entries = parseEntries(patch)
  if (entries.length !== 1) {
    throw new PatchFormatError(`applyUnifiedDiff expects exactly one file entry, found ${entries.length}`)
  }
  const entry = entries[0]!
  const oldLines = splitKeep(before)
  const out: string[] = []
  let cursor = 0
  for (const hunk of entry.hunks) {
    // With no old lines, `oldStart` is the 0-based insertion point (the line
    // before it); otherwise it is the 1-based line of the first old line.
    const oldIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1
    if (oldIndex < cursor || oldIndex > oldLines.length) {
      throw new PatchFormatError(
        `hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ` +
          `does not apply to ${JSON.stringify(entry.newPath)}: line ${oldIndex + 1} is out of range`,
      )
    }
    for (let i = cursor; i < oldIndex; i++) out.push(oldLines[i]!)
    let pos = oldIndex
    for (const line of hunk.lines) {
      const expected = line.noNewline ? line.text : `${line.text}\n`
      if (line.kind === '+') {
        out.push(expected)
        continue
      }
      const actual = oldLines[pos]
      if (actual !== expected) {
        const found = actual === undefined ? '<end of file>' : JSON.stringify(actual)
        throw new PatchFormatError(
          `hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ` +
            `does not apply to ${JSON.stringify(entry.newPath)}: expected ${JSON.stringify(expected)} ` +
            `at line ${pos + 1}, found ${found}`,
        )
      }
      if (line.kind === ' ') out.push(expected)
      pos++
    }
    cursor = pos
  }
  for (let i = cursor; i < oldLines.length; i++) out.push(oldLines[i]!)
  return out.join('')
}

/**
 * Every path a patch would touch, resolved against a workspace root, after
 * stripping `strip` leading path components (default 1, i.e. `patch -p1`,
 * which conventionally removes the `a/` and `b/` prefixes). `/dev/null` sides
 * contribute no target. Throws PathEscapeError when a resulting path is
 * absolute, empty, or escapes the root (`..`), so a patch can never write
 * outside the workspace. Targets are de-duplicated while preserving order.
 */
export function patchTargets(patch: string, workspaceRoot: string, strip = 1): string[] {
  const stripCount = Number.isFinite(strip) ? Math.max(0, Math.floor(strip)) : 0
  const root = normalizeWorkspaceRoot(workspaceRoot)
  const targets: string[] = []
  const seen = new Set<string>()
  for (const entry of parseEntries(patch)) {
    // Both sides count as paths the patch touches; for the usual a/x → b/x
    // pair they resolve identically and the de-duplication collapses them.
    const candidates: string[] = []
    if (!entry.oldIsNull) candidates.push(entry.oldPath)
    if (!entry.newIsNull) candidates.push(entry.newPath)
    for (const candidate of candidates) {
      const resolved = resolvePatchTarget(candidate, stripCount, root)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      targets.push(resolved)
    }
  }
  return targets
}

// --- internal types ---------------------------------------------------------

/** One body line of a hunk, aligned with both file sides. */
interface HunkLine {
  /** ' ' context, '-' removed, '+' added. */
  kind: ' ' | '-' | '+'
  /** Line content without the marker and without its trailing newline. */
  text: string
  /** The original line had no trailing newline (next line is the marker). */
  noNewline: boolean
}

/** A parsed hunk: 1-based starts, line counts, and its body. */
interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: HunkLine[]
}

/** A file entry as written in the patch; paths keep their a/ b/ prefixes. */
interface ParsedEntry {
  oldPath: string
  newPath: string
  oldIsNull: boolean
  newIsNull: boolean
  hunks: Hunk[]
}

/** A diff step over arrays of newline-terminated lines. */
interface DiffOp {
  kind: 'equal' | 'del' | 'add'
  line: string
}

// --- parsing ----------------------------------------------------------------

/** Drop a CRLF line ending's carriage return; body lines keep theirs as content. */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function isOldHeader(line: string): boolean {
  return line === '---' || line.startsWith('--- ') || line.startsWith('---\t')
}

function isNewHeader(line: string): boolean {
  return line === '+++' || line.startsWith('+++ ') || line.startsWith('+++\t')
}

function isNoNewlineMarker(line: string): boolean {
  return line.startsWith('\\')
}

/**
 * Extract the path from a `---`/`+++` line: drop the marker, one separator,
 * and a trailing tab-separated timestamp (`diff -u` writes one; git does not).
 */
function headerPath(line: string): string {
  let rest = line.slice(3)
  if (rest.startsWith(' ') || rest.startsWith('\t')) rest = rest.slice(1)
  const tab = rest.indexOf('\t')
  return tab === -1 ? rest : rest.slice(0, tab)
}

/** Remove a conventional `a/` or `b/` prefix from a parsed path. */
function stripDiffPrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

function parseEntries(patch: string): ParsedEntry[] {
  const lines = patch.split('\n')
  const entries: ParsedEntry[] = []
  let i = 0
  while (i < lines.length) {
    const line = stripCr(lines[i]!)
    if (!isOldHeader(line)) {
      i++
      continue
    }
    const oldPath = headerPath(line)
    const nextLine = lines[i + 1]
    const next = nextLine === undefined ? undefined : stripCr(nextLine)
    if (next === undefined || !isNewHeader(next)) {
      throw new PatchFormatError(`unified diff header at line ${i + 1} has no matching +++ line`)
    }
    const entry: ParsedEntry = {
      oldPath,
      newPath: headerPath(next),
      oldIsNull: oldPath === '/dev/null',
      newIsNull: headerPath(next) === '/dev/null',
      hunks: [],
    }
    i = parseHunks(lines, i + 2, entry.hunks)
    entries.push(entry)
  }
  if (entries.length === 0) {
    throw new PatchFormatError('not a unified diff: no ---/+++ file header pair found')
  }
  return entries
}

/** Consume hunks (and ignore metadata lines) until the next file header. */
function parseHunks(lines: string[], start: number, hunks: Hunk[]): number {
  let i = start
  while (i < lines.length) {
    const line = stripCr(lines[i]!)
    if (isOldHeader(line)) break
    if (line.startsWith('@@')) {
      i = parseHunk(lines, i, hunks)
      continue
    }
    i++
  }
  return i
}

function parseHunk(lines: string[], start: number, hunks: Hunk[]): number {
  const header = stripCr(lines[start]!)
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
  if (match === null) {
    throw new PatchFormatError(`malformed hunk header at line ${start + 1}: ${JSON.stringify(header)}`)
  }
  const oldStart = Number(match[1]!)
  const oldCount = match[2] === undefined ? 1 : Number(match[2])
  const newStart = Number(match[3]!)
  const newCount = match[4] === undefined ? 1 : Number(match[4])
  const body: HunkLine[] = []
  let oldSeen = 0
  let newSeen = 0
  let i = start + 1
  while (i < lines.length) {
    const raw = lines[i]!
    const structural = stripCr(raw)
    if (isNoNewlineMarker(structural)) {
      const last = body[body.length - 1]
      if (last === undefined) {
        throw new PatchFormatError(`"no newline" marker without a preceding line at patch line ${i + 1}`)
      }
      last.noNewline = true
      i++
      continue
    }
    if (oldSeen >= oldCount && newSeen >= newCount) break
    const kind = raw[0]
    if (kind === ' ' || kind === '-' || kind === '+') {
      body.push({ kind, text: raw.slice(1), noNewline: false })
      if (kind !== '+') oldSeen++
      if (kind !== '-') newSeen++
      i++
      continue
    }
    break
  }
  if (oldSeen !== oldCount || newSeen !== newCount) {
    throw new PatchFormatError(
      `hunk @@ -${oldStart},${oldCount} +${newStart},${newCount} @@ at line ${start + 1} has a malformed body`,
    )
  }
  hunks.push({ oldStart, oldCount, newStart, newCount, lines: body })
  return i
}

// --- diff construction ------------------------------------------------------

/** Split text into lines that keep their trailing '\n'; '' becomes no lines. */
function splitKeep(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

function normalizeContext(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONTEXT
  return Math.max(0, Math.floor(value))
}

function replaceAllOps(before: string[], after: string[]): DiffOp[] {
  const ops: DiffOp[] = []
  for (const line of before) ops.push({ kind: 'del', line })
  for (const line of after) ops.push({ kind: 'add', line })
  return ops
}

/**
 * LCS line diff. Common prefix/suffix are trimmed first, so the quadratic
 * table only covers the changed region of realistic patches. Equal lines are
 * matched by exact string (terminator included).
 */
function diffLines(before: string[], after: string[]): DiffOp[] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }
  const middleBefore = before.slice(prefix, before.length - suffix)
  const middleAfter = after.slice(prefix, after.length - suffix)
  const ops: DiffOp[] = []
  for (let i = 0; i < prefix; i++) ops.push({ kind: 'equal', line: before[i]! })
  appendMiddleOps(middleBefore, middleAfter, ops)
  for (let i = before.length - suffix; i < before.length; i++) ops.push({ kind: 'equal', line: before[i]! })
  return ops
}

function appendMiddleOps(left: string[], right: string[], ops: DiffOp[]): void {
  if (left.length === 0) {
    for (const line of right) ops.push({ kind: 'add', line })
    return
  }
  if (right.length === 0) {
    for (const line of left) ops.push({ kind: 'del', line })
    return
  }
  // dp[i][j] = LCS length of left[i:] and right[j:]; Uint16 is plenty because
  // the tables are capped at MAX_LCS_LINES per side.
  const width = right.length + 1
  const dp = new Uint16Array((left.length + 1) * width)
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      dp[i * width + j] =
        left[i] === right[j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ kind: 'equal', line: left[i]! })
      i++
      j++
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      ops.push({ kind: 'del', line: left[i]! })
      i++
    } else {
      ops.push({ kind: 'add', line: right[j]! })
      j++
    }
  }
  while (i < left.length) {
    ops.push({ kind: 'del', line: left[i]! })
    i++
  }
  while (j < right.length) {
    ops.push({ kind: 'add', line: right[j]! })
    j++
  }
}

/** Group diff ops into hunks with context; nearby changes are merged. */
function buildHunks(ops: DiffOp[], context: number): Hunk[] {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < ops.length; ) {
    if (ops[i]!.kind === 'equal') {
      i++
      continue
    }
    const start = i
    while (i < ops.length && ops[i]!.kind !== 'equal') i++
    runs.push([start, i - 1])
  }
  if (runs.length === 0) return []

  // Lines consumed before each op, used to translate op indices to line numbers.
  const oldBefore = new Array<number>(ops.length + 1)
  const newBefore = new Array<number>(ops.length + 1)
  oldBefore[0] = 0
  newBefore[0] = 0
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    oldBefore[i + 1] = oldBefore[i]! + (op.kind === 'add' ? 0 : 1)
    newBefore[i + 1] = newBefore[i]! + (op.kind === 'del' ? 0 : 1)
  }

  const hunks: Hunk[] = []
  const first = runs[0]!
  let from = Math.max(0, first[0] - context)
  let to = Math.min(ops.length - 1, first[1] + context)
  for (let r = 1; r < runs.length; r++) {
    const run = runs[r]!
    const nextFrom = Math.max(0, run[0] - context)
    // Context ranges that touch (<= 2*context unchanged lines between changes)
    // are emitted as one hunk, which is what git/diff do.
    if (nextFrom <= to + 1) {
      to = Math.min(ops.length - 1, run[1] + context)
    } else {
      hunks.push(makeHunk(ops, from, to, oldBefore, newBefore))
      from = nextFrom
      to = Math.min(ops.length - 1, run[1] + context)
    }
  }
  hunks.push(makeHunk(ops, from, to, oldBefore, newBefore))
  return hunks
}

function makeHunk(ops: DiffOp[], from: number, to: number, oldBefore: number[], newBefore: number[]): Hunk {
  const lines: HunkLine[] = []
  let oldCount = 0
  let newCount = 0
  for (let i = from; i <= to; i++) {
    const op = ops[i]!
    if (op.kind !== 'add') oldCount++
    if (op.kind !== 'del') newCount++
    const terminated = op.line.endsWith('\n')
    lines.push({
      kind: op.kind === 'equal' ? ' ' : op.kind === 'del' ? '-' : '+',
      text: terminated ? op.line.slice(0, -1) : op.line,
      noNewline: !terminated,
    })
  }
  return {
    // A zero count means "insert/delete before this line", so the start is the
    // number of lines already consumed instead of the next 1-based line.
    oldStart: oldCount === 0 ? oldBefore[from]! : oldBefore[from]! + 1,
    oldCount,
    newStart: newCount === 0 ? newBefore[from]! : newBefore[from]! + 1,
    newCount,
    lines,
  }
}

// --- target resolution ------------------------------------------------------

/** Normalize a workspace root to an absolute POSIX path with no trailing slash. */
function normalizeWorkspaceRoot(root: string): string {
  const parts = root.split('/').filter((part) => part !== '' && part !== '.')
  return `/${parts.join('/')}`
}

/** Drop `strip` leading slash-separated components from a path as written. */
function stripLeadingComponents(path: string, strip: number): string {
  let rest = path
  for (let n = 0; n < strip; n++) {
    if (rest === '') return ''
    const slash = rest.indexOf('/')
    if (slash === -1) return ''
    rest = rest.slice(slash + 1)
  }
  return rest
}

function resolvePatchTarget(path: string, strip: number, root: string): string {
  const stripped = stripLeadingComponents(path, strip)
  if (stripped === '') {
    throw new PathEscapeError(`patch path ${JSON.stringify(path)} is empty after stripping ${strip} component(s)`)
  }
  if (stripped.startsWith('/')) {
    throw new PathEscapeError(`patch path ${JSON.stringify(path)} is absolute after stripping ${strip} component(s)`)
  }
  const parts = stripped.split('/')
  if (parts.includes('..')) {
    throw new PathEscapeError(`patch path ${JSON.stringify(path)} escapes the workspace with '..'`)
  }
  const relative = parts.filter((part) => part !== '' && part !== '.').join('/')
  if (relative === '') {
    throw new PathEscapeError(`patch path ${JSON.stringify(path)} resolves to nothing`)
  }
  return root === '/' ? `/${relative}` : `${root}/${relative}`
}
