# dsh-rw

[![CI](https://github.com/MDR-EX1000/dsh-rw/actions/workflows/ci.yml/badge.svg)](https://github.com/MDR-EX1000/dsh-rw/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/MDR-EX1000/dsh-rw)](https://github.com/MDR-EX1000/dsh-rw/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Remote-SSH-style workspaces for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Pick an SSH host and a remote directory — that directory becomes a native DSH workspace, and the agent works **directly on the remote filesystem** through `rw_*` tools (SFTP/exec over a persistent ssh2 pool). No mirror, no sync: the remote is the single source of truth.

**Zero config since 0.4.0** — once a remote workspace is active, the agent's native `read`/`write`/`edit`/`bash` tools run on the remote host automatically; you never have to teach it a new tool.

Think of it as the workspace counterpart of an SSH ops toolbox: instead of "run one command over there", the agent gets a persistent remote project root it can read, edit, build, and test in — like VS Code Remote-SSH, but for your agent.

## Features

- **Remote directory as a native workspace** — a centered picker modal fills the DSH "Add workspace" flow: a two-card chooser (本机 / 远程) leads to the local page (OS folder chooser) or a Codex-style remote page (alias-only host dropdown, `~/`-prefilled remote-home path, inline directory browser with live type-to-filter, optional workspace name).
- **Hosts come from `~/.ssh/config`** — zero configuration: your existing aliases show up automatically (re-read on file change, no restart). Password-auth hosts can be added in the picker (stored locally, file mode `0600`).
- **Real workspace confinement** — every `rw_*` file path is confined to the picked workspace root: `../`, absolute paths outside the root, and symlink escapes (`SYMLINK_ESCAPE` via remote `realpath`) are rejected with structured errors.
- **SSH host key verification** — verifies against `~/.ssh/known_hosts` by default (`accept-new`: first-seen keys are recorded), with `strict` and an explicit `off` policy. A changed host key is refused, never silently accepted.
- **Structured errors** — connection refused / auth failed / timeout / no such path / permission denied / outside workspace / host key problems are distinct error codes, so the agent can react correctly.
- **Self-healing connections** — the ssh2 pool keepalives (15s × 3) detect dropped connections, and channel/subsystem opens are bounded (`channelOpenTimeoutMs`, default 10s) so a silently dead connection (half-open TCP) can't hang an operation. An operation that lands on a dead connection is transparently retried once on a fresh redial — transient network blips never reach the agent as errors.
- **Placeholder, not a copy** — the local directory DSH registers is an empty placeholder (`.dsh-rw-meta.json` records the `user@host:path` origin). It never holds remote file contents, so there is nothing to sync and no conflicts. It takes a clean name — the remote basename or the name you give in the picker; a hash suffix appears only on a naming conflict (legacy hash-suffixed placeholders keep working).
- **Shim mode (on by default)** — DSH's native `read`/`write`/`edit`/`str_replace_editor`/`glob`/`grep`/`bash` tools are intercepted on the tool pipeline and translated to remote execution, so the agent works as if the workspace were local without learning `rw_*`. Paths map placeholder↔remote in both directions, edits re-stat before writing back (`RW_EDIT_CONFLICT` on a concurrent change), and shimmed `bash` escalates to the approval dialog naming the remote host. On by default — set `shim: false` (cordis config or `dsh-rw:` in `~/.dsh/settings.yaml`) to opt out and use only the explicit `rw_*` tools. The shim anchors on the agent session's cwd placeholder — not the mutable `rw_*` session — so `rw_disconnect` or reconnecting `rw_*` to another host can't silently redirect native tools; calls rooted outside the placeholder always pass through to the local tool unchanged.
- **Fail loud, never silently local** — if a placeholder's host was removed from the config, calls that would touch that placeholder fail with an actionable `NOT_CONNECTED` error instead of silently running against the empty local directory. The block is path-aware: only calls touching the broken placeholder fail; everything else still passes through.

## Install

Prebuilt tarball from GitHub Release (no build step):

```bash
dsh plugin --profile web add https://github.com/MDR-EX1000/dsh-rw/releases/latest/download/dsh-rw.tgz
```

The `latest` URL always points at the newest release — no need to update the link per version.

From a local checkout (development):

```bash
dsh plugin --profile web add /path/to/dsh-rw
```

Restart `dsh web` afterwards. The plugin activates on boot; the "Add workspace" flow gains the card-based picker.

## Quick start

1. **Pick a workspace** — sidebar / conversation **Add workspace** → 远程 card → choose a host (from `~/.ssh/config`, or **+ 添加主机** on its own subpage for password auth) → browse or type a remote path (starts at the remote home `~/`; optionally give it a 工作区名称) → 设为远程工作区.
2. **Work with the agent as usual** — with shim mode on (the default), the agent's native `read`/`write`/`edit`/`glob`/`grep`/`bash` calls inside the workspace are translated to the remote host automatically. Just ask it to fix a bug, run the tests, or refactor — nothing new to learn.
3. **Explicit remote ops when you want them** — the `rw_*` tools stay available:
   - `rw_list_dir` / `rw_read_file` / `rw_write_file` / `rw_mkdir` / `rw_move` / `rw_delete` — file operations (workspace-confined)
   - `rw_exec` — run shell commands with the workspace root as cwd (build, test, grep, …)
   - `rw_hosts` / `rw_connect` / `rw_pick_workspace` / `rw_info` / `rw_disconnect` — host & session management

## Configuration

dsh-rw reads two configuration layers:

- **Cordis entry config** (the plugin entry in your cordis.yml / loader patch) — the base layer for
  every key below. `hostKeyPolicy`, `knownHostsPath`, `commandTimeoutMs`, `connectTimeoutMs`, and
  `maxOutputChars` are configured **only** here.
- **`~/.dsh/settings.yaml`** — the `dsh-rw:` section overrides **only the three shim switches**.
  Changes made through the settings service apply live; after editing the file by hand,
  restart `dsh web` to be sure they are picked up. Resolution order: schema defaults →
  cordis entry config (base) → this user layer.

```yaml
# ~/.dsh/settings.yaml — all three keys default to the values shown; you only
# need this section to opt OUT of shim mode.
dsh-rw:
  shim: false             # default true: native tools run on the remote workspace.
                          # Set false to use only the explicit rw_* tools.
  # shimBash: true        # also intercept bash (session cwd must be the placeholder)
  # shimBashApproval: ask # ask = approval dialog naming the remote host (skipped on
                          # never-ask presets like danger-full-access, which run directly);
                          # native = defer to the native bash policy
```

Plugin config keys (defaults shown):

| Key | Default | Layer | Meaning |
| --- | --- | --- | --- |
| `hostKeyPolicy` | `'accept-new'` | cordis only | `'accept-new'` learns first-seen keys into known_hosts; `'strict'` refuses unknown; `'off'` disables verification (explicitly) |
| `knownHostsPath` | `~/.ssh/known_hosts` | cordis only | known_hosts file used for verification |
| `commandTimeoutMs` | `30000` | cordis only | per remote command timeout |
| `connectTimeoutMs` | `15000` | cordis only | SSH handshake timeout |
| `channelOpenTimeoutMs` | `10000` | cordis only | channel/subsystem open timeout: bounds the wait on a silently dead connection before it is dropped and retried once on a fresh connection |
| `maxOutputChars` | `200000` | cordis only | cap on collected stdout/stderr per call |
| `shim` | `true` | cordis + settings | shim mode: intercept the native read/write/edit/str_replace_editor/glob/grep/bash tools and run them against the active remote workspace (set `false` to opt out and use only `rw_*`) |
| `shimBash` | `true` | cordis + settings | with shim on, also intercept `bash` (only when the agent session cwd is the placeholder workspace) |
| `shimBashApproval` | `'ask'` | cordis + settings | shimmed `bash` approval: `'ask'` escalates to the DSH approval dialog (reason names the remote host), but stands down on never-ask presets such as `danger-full-access` — asking there auto-rejects without a dialog, so the command just runs; `'native'` always defers to the native bash policy |

## Security model

- **Workspace confinement** — file tools resolve every path against the workspace root and verify the *real* path (following symlinks) stays inside. Writes validate the nearest existing ancestor.
- **Host key verification** as described above; host key changes abort the connection with `HOSTKEY_CHANGED`.
- **Loopback-only HTTP routes** — `/api/dsh-rw/*` refuses non-loopback callers.
- **Secrets** — passwords/passphrases are stored plaintext in `~/.dsh/dsh-rw.json` (mode `0600`, same trust model as `dsh-ssh`); they never appear in tool output, API responses, or error messages. Private keys are only read by ssh2 at connect time.
- **Scope** — giving the plugin a host's credentials lets the agent run shell commands as that user on that host. Only connect hosts you trust. `rw_delete` performs real remote deletion.

## Relationship to `@linxin666/dsh-ssh`

Complementary, not a replacement. `dsh-ssh` is an ops toolbox (web terminal, port-forward tunnels, SFTP transfer GUI, cluster exec, ProxyJump). dsh-rw is the workspace layer (persistent remote project root for the agent). They coexist: different tool names (`ssh_*` vs `rw_*`), different routes, separate connection pools.

## Known limitations

- No ProxyJump / jump-host chains (single-hop only).
- `rw_exec` is one-shot, no interactive PTY.
- File reads are text-oriented (line paging) with a 2 MB cap; large binary transfers are out of scope.
- The DSH file tree shows the empty placeholder directory, not remote files — remote browsing happens through the picker or the agent.

## Development

```bash
pnpm install
pnpm build        # tsc (host) + esbuild wrapper (client)
pnpm test         # vitest, 354 tests — all SSH/SFTP mocked
pnpm typecheck
```

Real-host acceptance (opt-in, creates and cleans a temp dir on the target):

```bash
ssh <alias> 'mktemp -d /tmp/dsh-rw-acceptance.XXXXXX'   # then seed test data
node scripts/acceptance.mjs <alias> /tmp/dsh-rw-acceptance.XXXXXX
node scripts/live-shim.mjs <alias> <remote-dir>   # end-to-end shim acceptance (native tools → remote)
```

## License

MIT
