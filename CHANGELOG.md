# Changelog

All notable changes to **dsh-rw**. Format follows [Keep a Changelog](https://keepachangelog.com/),
versioning follows [SemVer](https://semver.org/).

## Unreleased

Picker UX aligned to Codex's "New remote project", plus remote-home (`~`) support.

- Remote `~` support: `GET /api/dsh-rw/ls` and `rw_pick_workspace` / the workspace
  route now accept `~` and `~/…`, expanded server-side against the session home
  (SFTP `realpath('.')`) via the new `expandRemoteHome` guard helper.
- Picker (remote page) rework after Codex's dialog: workspace-name input with an
  attached icon cell on top; the host select shows alias-only options (unusable
  hosts still disabled) with a globe glyph and a drawn chevron (`appearance:
  none`); the path defaults to the remote home (`~/`, synced back to its real
  path); the inline directory list replaces both the autocomplete dropdown and
  the browse popup — rows drill in, an SVG up-button goes to the parent, and
  typing filters the list live. All glyph icons (folder / globe / arrows /
  close / file / link) are one line-SVG family, the primary action is a white
  Codex-style button, and the back button is a round icon-only button.
- Add-host subpage: label-left single-column rows (名称 / 主机 / 端口 / 用户 /
  认证方式 / …) with a 清空 / 测试连接 / 保存 footer; the back button took over
  取消's form-reset duty so secrets never linger in state.
- Fix (picker): the local page has its own path state — the remote page's `~/`
  expansion no longer leaks a remote home path into the local input.

## 0.3.1 — 2026-08-21

- Fix (shim): native tools are now anchored to the agent session cwd's placeholder, not the
  mutable rw_* session — after `rw_disconnect`, or when `rw_*` was reconnected to a different
  host, native read/write/edit/glob/grep/bash used to silently run on the local empty
  placeholder; they now target the remote the workspace actually points at (the pool redials
  lazily), and a placeholder whose host was removed from the config fails loudly with an
  actionable `NOT_CONNECTED` error instead of falling back silently. The block is path-aware:
  only calls that would touch the broken placeholder fail — calls rooted elsewhere still pass
  through to the local tool. Adds `scripts/live-shim.mjs` (live end-to-end shim acceptance).

## 0.3.0 — 2026-08-21

Picker UX rework, clean placeholder naming, and connection resilience.

- Resilience: an exec or SFTP call whose channel/subsystem open fails on a connection that has
  already dropped out of the pool (it died) now redials and retries the operation once
  transparently, instead of surfacing a transient error to the agent; SFTP ops on a wrapper
  whose connection dropped after acquisition re-acquire and retry once too. Remote business
  errors, command timeouts, and post-open stream failures are never retried, and a second
  failure surfaces the structured error as before.
- Resilience: channel/subsystem opens are now bounded by the new `channelOpenTimeoutMs`
  (default 10s). A silently dead connection (half-open TCP — network gone without a RST)
  previously hung an operation until keepalive detection (~45s) or indefinitely; it is now
  killed, dropped, and retried on a fresh connection within the timeout. Post-ready `error`
  events also drop the pooled client immediately (not only on `close`), so the retry
  discriminator no longer depends on `error`/`close` arrival order.
- Picker UX rework (Codex-style): the modal opens on a two-card chooser (本机 / 远程, each with
  a one-line explainer) instead of tabs; each flow is its own page with a 「← 返回」 back to the
  cards, and 「+ 添加主机」 is now a dedicated subpage rather than an inline expanding form.
- Placeholder naming: clean names by default — the remote basename, or the optional
  「工作区名称」 from the picker — with the `-<sha1[:8]>` suffix added only when the candidate
  directory is already occupied by another workspace. Lookup switches from computed paths to
  scanning `.dsh-rw-meta.json` (`resolvePlaceholderDir`), so legacy hash-suffixed placeholders
  from 0.1/0.2 keep resolving unchanged. `POST /api/dsh-rw/workspace` accepts an optional
  `name`.
- CI: GitHub Actions workflow (typecheck → build → test) on every push/PR.
- Docs: install via prebuilt GitHub Release tarball; add ACCEPTANCE.md (unit / live-host / UI checks).
- Fix: replace pnpm `allowBuilds` placeholder strings with real booleans — placeholders broke
  `pnpm install --frozen-lockfile` on fresh environments (`ERR_PNPM_IGNORED_BUILDS`).

## 0.2.0 — 2026-08-20

Shim mode: DSH's native tools run against the remote workspace.

- Opt-in shim mode (`shim: true`): cordis middleware on the `tools/execute` waterfall intercepts
  the seven native tools — `read` / `write` / `edit` / `str_replace_editor` / `glob` / `grep` /
  `bash` — and translates them to remote execution (SFTP/exec) whenever the call's paths resolve
  inside the active placeholder workspace. Anything outside passes through to the local tool
  untouched, and with shim off (the default) behavior is identical to 0.1.
- Paths map both ways: argument paths map placeholder → remote (relative paths resolve against
  the placeholder root), and every path in results and composed error messages maps back to
  placeholder form, so the agent's worldview stays a local directory.
- Edits (`edit`, `str_replace_editor` str_replace/insert) re-stat before writing back and fail
  with `RW_EDIT_CONFLICT` when the remote file changed since the read.
- `glob`/`grep` run remote `rg` when available (`find` / `grep -rnE` fallback); output is capped
  by `maxOutputChars` like every remote call.
- `bash` rewrites placeholder paths in the command, runs with the remote workspace root as cwd,
  honors `exec.signal` (abort drops the connection, interrupting the remote process), and a
  persistent `bash` (dsh-tool-bash-persistent registers the same tool name) degrades to a
  one-shot remote exec with a note that shell state is not preserved.
- Shimmed bash escalates through `tools/pre-execute` with `{ kind: 'ask' }` naming the remote
  host alias (default `shimBashApproval: 'ask'`; `'native'` defers to the native policy) — but
  stands down when the session's approval policy is `never` (e.g. the `danger-full-access`
  preset): asking there auto-rejects without a dialog, so the command just runs, matching
  that preset's contract. File tools never escalate — the workspace guard confines them.
- Result `value` shapes conform to each native tool's output schema (the registry validates
  them): bash returns the structured foreground object; read/write/edit/glob/grep return
  their schema's objects. String values failed live with "value must match exactly one oneOf
  branch" / "value must be an object" — caught in dogfooding, covered by per-tool value-shape
  tests. `str_replace_editor`'s native schema is a plain string, unchanged.
- Prompt steering: with shim on, the system-prompt section points the agent at the native
  tools (translated transparently) instead of pushing `rw_*` — the 0.1 wording kept the shim
  dormant because models dutifully preferred `rw_*`.
- New config keys: `shim` (default `false`), `shimBash` (default `true`),
  `shimBashApproval` (`'ask'` | `'native'`, default `'ask'`).
- Settings integration: the three shim switches (and only they) also resolve from the
  `dsh-rw:` section of `~/.dsh/settings.yaml` via `@deepseek-ai/dsh-settings` — schema defaults →
  cordis entry config (base) → user layer. Changes committed through the settings service
  apply live (the middlewares are registered unconditionally and read a shared config object
  per dispatch); after editing the file by hand, restart `dsh web` to be sure it is picked
  up. Without a settings service (or with an invalid stored section) the cordis entry config
  stays authoritative. `schemastery` is now a runtime dependency.

## 0.1.0 — 2026-08-19

Initial release.

- Remote-SSH-style workspaces for DSH: pick an SSH host and a remote directory as a native
  DSH workspace; the agent operates the remote filesystem directly via `rw_*` tools
  (SFTP/exec over a persistent ssh2 pool). No mirror, no sync — the remote is the source of truth.
- Hosts auto-parsed from `~/.ssh/config` (re-read on change); manual entries (password auth)
  stored in `~/.dsh/dsh-rw.json` with atomic writes and `0600` permissions.
- Workspace confinement for every file path: `../`, absolute paths outside the root, and
  symlink escapes are rejected (`OUTSIDE_WORKSPACE` / `SYMLINK_ESCAPE`, verified via remote
  `realpath`).
- SSH host key verification against `~/.ssh/known_hosts` (`accept-new` default; `strict` and
  explicit `off` policies; host key changes refused with `HOSTKEY_CHANGED`).
- Structured error taxonomy: `CONN_REFUSED` / `CONN_TIMEOUT` / `AUTH_FAILED` / `NO_SUCH_PATH` /
  `PERMISSION_DENIED` / `HOSTKEY_*` and more.
- Two-tab Add-workspace picker modal: local tab (OS folder chooser or manual path), remote tab
  (host dropdown, `/`-prefilled path autocomplete, cascading directory browser, inline
  add-host form with test-connection).
- 12 agent tools: `rw_info` / `rw_hosts` / `rw_connect` / `rw_pick_workspace` / `rw_list_dir` /
  `rw_read_file` / `rw_write_file` / `rw_mkdir` / `rw_move` / `rw_delete` / `rw_exec` /
  `rw_disconnect`.
- Loopback-only `/api/dsh-rw/*` routes; secrets never appear in tool output, API responses,
  or error messages.
- 285 vitest cases (SSH/SFTP fully mocked) plus an opt-in real-host acceptance script
  (`scripts/acceptance.mjs`), verified against two live hosts.
