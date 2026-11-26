# dsh-rw

[![CI](https://github.com/MDR-EX1000/dsh-rw/actions/workflows/ci.yml/badge.svg)](https://github.com/MDR-EX1000/dsh-rw/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/MDR-EX1000/dsh-rw)](https://github.com/MDR-EX1000/dsh-rw/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Remote-SSH-style workspaces for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Version 0.4.6 supports DSH `0.1.2-rc.1` and `0.2.0-rc.2`, plus compatible later `0.1.x` / `0.2.x`
releases.

Pick an SSH host and a remote directory — that directory becomes a native DSH workspace, and the agent works **directly on the remote filesystem** through `rw_*` tools (SFTP/exec over a persistent ssh2 pool). No mirror, no sync: the remote is the single source of truth.

**Zero config since 0.4.0** — once a remote workspace is active, the agent's native `read`/`write`/`edit`/`bash` tools run on the remote host automatically; you never have to teach it a new tool.

Think of it as the workspace counterpart of an SSH ops toolbox: instead of "run one command over there", the agent gets a persistent remote project root it can read, edit, build, and test in — like VS Code Remote-SSH, but for your agent.

## Features

- **Remote directory as a native workspace** — a centered picker modal fills the DSH "Add workspace" flow: a compact two-card chooser (`LOCAL` / `REMOTE` in English) leads to the local page (OS folder chooser) or a Codex-style remote page (alias-only host dropdown, `~/`-prefilled remote-home path, inline directory browser with live type-to-filter, optional workspace name).
- **Scrollable directory picker** — the modal stays inside the viewport, with a bounded host list and separate directory browser. Use a mouse wheel, trackpad, native scrollbar, or focus the browser for keyboard scrolling; directory rows also support Enter/Space. The header and confirmation actions remain accessible on short windows.
- **Follows DSH Language** — every picker label, hint, validation message, loading state, confirmation, and fallback message ships in Chinese and English. The active copy follows DSH's global **Settings → Language** preference and updates immediately while the picker is open; no plugin-specific language setting or restart is required.
- **Hosts come from `~/.ssh/config`** — zero configuration: your existing aliases show up automatically (re-read on file change, no restart). Password-auth hosts can be added in the picker (stored locally, file mode `0600`).
- **Real workspace confinement** — every `rw_*` file path is confined to the picked workspace root: `../`, absolute paths outside the root, and symlink escapes (`SYMLINK_ESCAPE` via remote `realpath`) are rejected with structured errors.
- **SSH host key verification** — verifies against `~/.ssh/known_hosts` by default (`accept-new`: first-seen keys are recorded), with `strict` and an explicit `off` policy. A changed host key is refused, never silently accepted.
- **Structured errors** — connection refused / auth failed / timeout / no such path / permission denied / outside workspace / host key problems are distinct error codes, so the agent can react correctly.
- **Bounded, cancellable remote I/O** — SFTP acquisition, file operations and cleanup share `operationTimeoutMs` (default 30s) and the caller's cancellation signal. Completed tool calls release their own SFTP subsystem; a closed channel or a missing callback rejects pending waits instead of pinning an Agent indefinitely. Local native calls remain outside these remote scopes.
- **Generation-aware pooled connections** — keepalives detect transport loss, while channel opens have their own cap. Old connection events cannot clear a replacement's ready state, and a healthy connection is not torn down merely because an SFTP subsystem was refused. A dispatched operation or command is **never blindly replayed**: timeout, cancellation or a lost reply can mean it already executed, so verify remote state before retrying writes.
- **Placeholder, not a copy** — the local directory DSH registers is an empty placeholder (`.dsh-rw-meta.json` records the `user@host:path` origin). It never holds remote file contents, so there is nothing to sync and no conflicts.
- **One sidebar node per host (2.0)** — placeholders live under a private root outside your home directory (`placeholderRoot`, default `/Users/Shared/dsh-rw-<user>` on macOS) and **mirror the remote tree**: `<root>/<alias>/data` is remote `/data`, `<root>/<alias>/srv/app` is remote `/srv/app`. Each host has a **main directory** — set per host in the picker, else `defaultMainDir` (`/`; empty = none). The picker opens a host there, and the workspace picked there is registered titled with the bare alias, so in DSH's Workspace Tree the host's node *is* its main workspace and the workspaces below it nest inside it; any other workspace is titled with its canonical remote **basename** (or the name you give) and follows the registered path hierarchy. For example, `/srv/my-app` appears as `my-app` below its closest registered ancestor when **Workspace Tree** is selected. Display names never move placeholder directories. A workspace still carrying the old automatic `alias · path` title is renamed to the new default when picked again; a title you chose is kept unless you explicitly enter a replacement. Remote `/` is registered and made remote-backed when selected as the main workspace, not merely as a side effect of picking a child directory. Because local layout equals remote layout, a local path maps to the same remote path whichever placeholder it is reached through. Collisions are errors, never renamed: a path owned by another workspace, two aliases that sanitize to one directory name, or a case-only clash on a case-insensitive disk. Placeholders created by 1.x (`~/.dsh/remote-workspaces/…`) keep working; add the workspace again from the picker to get the per-host grouping.
- **Host namespace ownership (2.0.3)** — two aliases that map to the same local host directory cannot share it, even for different remote project paths. A private `.dsh-rw-host.json` reserves the alias namespace but does not make remote `/` a workspace. Existing mirror trees are checked for mixed aliases before routing; ambiguous or unsafe ownership fails loudly. Resolve a conflict by choosing distinct SSH aliases or a separate `placeholderRoot`; no paths or session histories are automatically moved.
- **Per-session connections (2.0)** — `rw_connect` / `rw_pick_workspace` record the host and workspace for **the calling DSH session** only (`~/.dsh/dsh-rw-sessions.json`), so sessions on different hosts never overwrite each other; a subagent inherits its parent session's connection until it connects on its own. A session opened inside a placeholder always works on that placeholder's host and root.
- **Main directory per host** — each host can remember a main remote directory (`POST /api/dsh-rw/hosts/main`; shown as `mainDir` in host summaries and by `rw_info`), the workspace the picker offers by default for it.
- **Shim mode (on by default)** — DSH's native `read`/`write`/`edit`/`str_replace_editor`/`glob`/`grep`/`bash` tools are intercepted on the tool pipeline and translated to remote execution, so the agent works as if the workspace were local without learning `rw_*`. Paths map placeholder↔remote in both directions, edits re-stat before writing back (`RW_EDIT_CONFLICT` on a concurrent change), and shimmed `bash` escalates to the approval dialog naming the remote host. On by default — set `shim: false` (the plugin's cordis entry config, or its row in the DSH plugin configuration form) to opt out and use only the explicit `rw_*` tools. The shim has **two anchors**: a call whose own path argument is inside a placeholder is translated from *any* working directory (the anchor travels with the call), and calls with no path to anchor on (`bash`, pathless `glob`/`grep`) translate while the agent session's cwd is the placeholder. Neither anchor consults the mutable `rw_*` session, so `rw_disconnect` or reconnecting to another host can't silently redirect native tools; calls rooted outside every placeholder always pass through to the local tool unchanged.
- **Fail loud, never silently local** — if a placeholder's host was removed from the config, calls that would touch that placeholder fail with an actionable `NOT_CONNECTED` error instead of silently running against the empty local directory. The block is path-aware: only calls touching the broken placeholder fail; everything else still passes through.
- **Version is self-reported** — `rw_info` prints the version of the module the host actually loaded (not the manifest on disk), so a stale process is visible from inside a session.
- **Hide a host without editing ssh config** — the ✕ on an ssh-config row removes it from the list and remembers the alias locally (`hidden` in the plugin store); `~/.ssh/config` is untouched. A line under the list shows what is hidden, with one click to bring it all back.
- **You decide which ssh-config entries exist as hosts** — `sshConfigInclude` / `sshConfigExclude` take shell-style globs, so a machine whose `~/.ssh/config` is full of build and test aliases does not flood the host list. Manual hosts are unaffected by the filter.
- **Host list, not a dropdown** — the 远程 page renders one row per host with `user@host:port`, provenance (`ssh-config` / manual) and credential pills, an inline reason when the host is unusable, a per-row **test** action that reports the measured latency, and edit/remove for manual hosts. The host last used is restored on the next open.
- **Fan-out with `rw_exec_many`** — run one command across several hosts, or an independent command per host, in parallel (bounded concurrency, default 4 / ceiling 16) and get one result section per call in input order. One unreachable host never voids the rest, and every alias is resolved before anything runs.
- **Persistent shell** — the persistent-bash flavor keeps one long-lived remote `bash` per (host, workspace), so `cd` and `export` survive between calls. Each command is framed with a random sentinel carrying its exit code; stdout and stderr are merged because a shell has one ordered stream (the result says so). A stuck command resets the shell instead of leaving unread output behind; an idle shell closes after `persistentShellIdleMs`.
- **Poll-based change watching (`rw_watch`)** — `start` / `poll` / `stop` / `list` over a directory (one `include` glob, `maxEntries` cap). Nothing runs on the remote between polls: the snapshot lives in the plugin process, so one poll costs one recursive SFTP listing.
- **Diff, patch and optimistic writes** — `rw_diff` renders a unified diff of a remote file against supplied text or another remote file (raw bytes, so a trailing newline is never a phantom change); `rw_apply_patch` validates every touched path against the workspace root *before* running, then applies with `patch -pN` behind a `--dry-run`; `rw_write_file` takes `ifHash` (sha256, or `"absent"` for create-only) and fails with `RW_WRITE_CONFLICT` instead of clobbering a concurrent edit.
- **Remote search mirrors the native tools** — `glob` uses `--sort=modified --no-ignore --hidden` plus the VCS excludes, `grep` parses `rg --json` (so a path containing colons cannot be mis-split), and both put `--` before the search root. If ripgrep is missing on the host, the `find` / `grep -rnE` fallback is labelled in the result rather than silently returning different ignore/hidden semantics.
- **Never claims remote while running local** — translation is anchored to the session's working directory, so the plugin reports what it *observed*, never what a record implies. `rw_info` says where this session's native tools actually went (`remote` / `LOCAL` / `not observed yet`), and a pass-through caused by a local working directory logs exactly one console line naming both the cwd and the placeholder it should have been in. The prompt section is generated **per session** from that session's working directory and record: a session working in a placeholder is told it is a remote workspace whose native tools are translated; a local session with an `rw_*` connection is told its native tools stay local (unless a path names a placeholder); the text is stable for the whole session.

## Install

### GitHub source (current channel)

Releases are published to GitHub only; the package is prepared for npm
(`prepublishOnly` runs typecheck + test + build, `publishConfig` pins the npmjs
registry) but is **not published there yet**, so `dsh plugin add dsh-rw` would
not resolve.

GitHub source, using the compact repository basename shown by DSH Market:

```bash
dsh plugin --profile web add github:MDR-EX1000/dsh-rw
```

The repository tracks the compiled `lib/` output and has no `prepare`, `prepack`, `install`, or
`postinstall` lifecycle hook. Installing this source therefore needs neither a local TypeScript
toolchain nor permission to build the plugin. DSH Market keeps the `github:` source when updating
the plugin and resolves the repository's current default-branch commit.

The matching immutable release package remains available when an exact release archive is needed:

```bash
dsh plugin --profile web add https://github.com/MDR-EX1000/dsh-rw/releases/latest/download/dsh-rw.tgz
```

Release packages include the same compiled `lib/` output. The stable `dsh-rw.tgz` filename keeps
the `releases/latest/download` URL valid across versions.

### Source-install maintenance notes

The basename installation follows the repository's default branch and does not run this plugin's
`build` script during installation. The runtime entry point is the committed `lib/index.js`, so
keep generated `lib/` files in Git and rebuild them whenever `src/` changes:

```bash
pnpm build
git add lib
```

The plugin itself currently has no `prepare`, `prepack`, or `postinstall` build hook. Its `ssh2`
dependency may still request pnpm permission for optional native modules (`ssh2` and
`cpu-features`); profiles using pnpm's build-script allowlist must allow those dependencies. This
is dependency setup, not a rebuild of `dsh-rw`.

`prepublishOnly` runs `typecheck`, `test`, and `build` before any `npm publish`,
so the npm artifact is always the tested one.

For each release, build and commit `lib/` before pushing the version commit and tag. Existing
basename installations then stay on the same concise GitHub source through future Market updates.
Use a Release tarball only when an exact tested archive is required.

From a local checkout (development):

```bash
dsh plugin --profile web add /path/to/dsh-rw
```

Restart `dsh web` afterwards. The plugin activates on boot; the "Add workspace" flow gains the card-based picker.

## Quick start

1. **Pick a workspace** — sidebar / conversation **Add workspace** → **REMOTE** card → choose a host (from `~/.ssh/config`, or **+ Add host** on its own subpage for password auth) → browse or type a remote path (starts at the remote home `~/`; optionally give it a workspace name) → **Use as remote workspace**. These labels appear in Chinese when the global DSH language is Chinese. Leave the name blank to use the directory basename; a main workspace keeps the host alias. For host grouping, open/register the main workspace first and select DSH's **Workspace Tree** view: projects beneath it nest automatically; projects outside that main path remain outside its tree.
2. **Work with the agent as usual** — with shim mode on (the default), the agent's native `read`/`write`/`edit`/`glob`/`grep`/`bash` calls inside the workspace are translated to the remote host automatically. Just ask it to fix a bug, run the tests, or refactor — nothing new to learn.
3. **Explicit remote ops when you want them** — the `rw_*` tools stay available:
   - `rw_list_dir` / `rw_read_file` / `rw_write_file` / `rw_mkdir` / `rw_move` / `rw_delete` — file operations (workspace-confined)
   - `rw_exec` — run shell commands with the workspace root as cwd (build, test, grep, …)
   - `rw_hosts` / `rw_connect` / `rw_pick_workspace` / `rw_info` / `rw_disconnect` — host & session management

## Configuration

dsh-rw reads one configuration layer for every key below: the plugin's **cordis entry config**, i.e.
the `dsh-rw` entry in your profile's `cordis.patch.yml` / loader patch. `hostKeyPolicy`,
`knownHostsPath`, `commandTimeoutMs`, `connectTimeoutMs`, and `maxOutputChars` are configured only
there.

The three **shim switches** are a settings-layer concern, and DSH changed that layer under the
plugin:

- **DSH 0.2.x** derives plugin settings from the plugin's own `Config` schema and edits them through
  the profile composition — the plugin configuration form, or the entry's `config:` block. The
  switches dsh-rw exposes live in `Config`, so they show up in that form automatically; an edit
  re-applies the plugin with the new values.
- **DSH 0.1.2** registers a `dsh-rw` settings namespace that adds one more layer on top of the entry
  config, read from the `dsh-rw:` section of `~/.dsh/settings.yaml` and applied live. Resolution
  order: schema defaults → cordis entry config (base) → user layer.

dsh-rw selects the model from the service it finds (presence of the `register` method), never from a
version check, so either line configures the same three keys:

```yaml
# Profile cordis.patch.yml — the dsh-rw entry config. All three keys default to the
# values shown; you only need this block to opt OUT of shim mode. On DSH 0.1.2 the
# same keys also resolve from `dsh-rw:` in ~/.dsh/settings.yaml, which wins over this.
- id: dsh-rw
  config:
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
| `commandTimeoutMs` | `30000` | cordis only | total remote command budget across connection, open and execution; timeout/cancellation rejects with `OPERATION_*` and dispatched outcome may be unknown |
| `operationTimeoutMs` | `30000` | cordis only | total file-operation/picker budget across SFTP acquisition, business operations and cleanup; cancellation is forwarded to the owned channel |
| `connectTimeoutMs` | `15000` | cordis only | SSH handshake timeout |
| `channelOpenTimeoutMs` | `10000` | cordis only | open-phase cap, tightened by the caller's total deadline; a refused healthy subsystem surfaces without disconnecting unrelated channels |
| `maxOutputChars` | `200000` | cordis only | cap on collected stdout/stderr per call |
| `shim` | `true` | cordis + settings layer | shim mode: intercept the native read/write/edit/str_replace_editor/glob/grep/bash tools and run them against the active remote workspace (set `false` to opt out and use only `rw_*`) |
| `shimBash` | `true` | cordis + settings layer | with shim on, also intercept `bash` (only when the agent session cwd is the placeholder workspace) |
| `shimBashApproval` | `'ask'` | cordis + settings layer | shimmed `bash` approval: `'ask'` escalates to the DSH approval dialog (reason names the remote host), but stands down on never-ask presets such as `danger-full-access` — asking there auto-rejects without a dialog, so the command just runs; `'native'` always defers to the native bash policy |
| `persistentShell` | `true` | cordis only | run the persistent-bash flavor on one long-lived remote shell per (host, workspace), so `cd`/`export` survive between calls (set `false` for the pre-1.0 one-shot behavior) |
| `persistentShellIdleMs` | `600000` | cordis only | close an idle persistent shell after this many ms (`0` disables the idle close) |
| `backgroundJobs` | `true` | cordis only | run native `bash(run_in_background)` calls on the HOST as `ctx.jobs` jobs, collected with the usual `job_output`/`job_kill`; off (or no job registry) refuses the call instead of running it locally |
| `jobPollMs` | `500` | cordis only | log poll cadence while narrating a remote background job |
| `jobDir` | `'/tmp'` | cordis only | remote directory holding background-job logs |
| `sshConfigInclude` | `[]` | cordis only | only these `~/.ssh/config` aliases become hosts; shell-style globs (`*`, `?`), case-insensitive. Empty means **every** alias |
| `sshConfigExclude` | `[]` | cordis only | never import these aliases; an exclude match wins over an include match |
| `placeholderRoot` | `''` | cordis only | where placeholder directories live (one mirror tree per host). Empty = `/Users/Shared/dsh-rw-<user>` on macOS, `~/.dsh/rw-workspaces` elsewhere — note that the latter sits under `~`, so if your home directory is a registered DSH workspace the hosts nest under it; set a directory outside it to get top-level host nodes. Must be a real directory owned by you (kept `0700`), else `UNSAFE_PLACEHOLDER_ROOT` |
| `defaultMainDir` | `'/'` | cordis only | main directory of every host that has none of its own (set per host in the picker). The picker opens such a host there — falling back to the remote home when the host lacks it — and the workspace picked there is titled with the bare alias (the host's sidebar node). Empty = none |

## Language

dsh-rw registers its `zh` and `en` dictionaries with the official
`@deepseek-ai/dsh-client-locale` service. It reads the same Host-backed global preference as the
rest of DSH (the `locale.preference` setting, changed under **Settings → Language**) and subscribes
to locale revisions, so
changing **Settings → Language** re-renders an already-open picker immediately. English is the
fallback for other language packs until they contribute a `dsh-rw` namespace dictionary.

## Security model

- **Workspace confinement** — file tools resolve every path against the workspace root and verify the *real* path (following symlinks) stays inside. Writes validate the nearest existing ancestor.
- **Root main workspace** — the default main directory is `/`. File operations in that workspace may address any path the remote account can access; OS permissions still apply. Use explicit project paths for searches instead of recursively scanning the whole filesystem.
- **Host key verification** as described above; host key changes abort the connection with `HOSTKEY_CHANGED`.
- **Loopback-only HTTP routes** — `/api/dsh-rw/*` refuses non-loopback callers.
- **Private placeholder root** — the default macOS root sits in the world-writable `/Users/Shared`, so dsh-rw refuses a root that is a symlink, not a directory, or owned by another user (`UNSAFE_PLACEHOLDER_ROOT`), and keeps it `0700`; every directory below is `0700`, every meta file `0600`.
- **Secrets** — passwords/passphrases are stored plaintext in `~/.dsh/dsh-rw.json` (mode `0600`, same trust model as `dsh-ssh`); they never appear in tool output, API responses, or error messages. Private keys are only read by ssh2 at connect time.
- **Scope** — giving the plugin a host's credentials lets the agent run shell commands as that user on that host. Only connect hosts you trust. `rw_delete` performs real remote deletion.

## Relationship to `@linxin666/dsh-ssh`

Complementary, not a replacement. `dsh-ssh` is an ops toolbox (web terminal, port-forward tunnels, SFTP transfer GUI, cluster exec, ProxyJump). dsh-rw is the workspace layer (persistent remote project root for the agent). They coexist: different tool names (`ssh_*` vs `rw_*`), different routes, separate connection pools.

## Known limitations

- No ProxyJump / jump-host chains (single-hop only).
- `rw_exec` is one-shot, no interactive PTY.
- File reads are text-oriented (line paging) with a model-visible cap; large binary transfers are out of scope. High-level SFTP reads still buffer the whole file: the operation deadline is not a transfer-byte/memory ceiling, so avoid oversized or endless device streams.
- Cancelling an open SSH exec before its channel handle is available may retire the exact shared Client and fail its other in-flight calls. Replacement generations are not touched; affected dispatched mutations report outcome unknown and are not replayed.
- The DSH file tree shows the empty placeholder directory, not remote files — remote browsing happens through the picker or the agent.
- On Linux/Windows the default `placeholderRoot` (`~/.dsh/rw-workspaces`) is inside the home directory; set `placeholderRoot` elsewhere if your home directory is registered as a workspace.
- On Windows, remote paths whose segments Windows cannot store (`<>:"\|?*`, trailing dot/space, `CON`/`NUL`/`COM1`…) cannot get a placeholder.

## Upgrading from 1.x

- Connection state moved from `~/.dsh/dsh-rw-session.json` (one global record) to `~/.dsh/dsh-rw-sessions.json` (per DSH session). The old file is left untouched, so rolling back to 1.6.x still works; after upgrading, sessions start unconnected unless they work inside a placeholder.
- Existing placeholders under `~/.dsh/remote-workspaces` keep working. To get the per-host sidebar grouping, add each workspace again through the picker (it is created under `placeholderRoot`), then remove the old entry from DSH's workspace list.
- `GET /api/dsh-rw/status` reports `current: { alias }` (the host the picker used last) instead of a global workspace; `POST /api/dsh-rw/workspace` answers `{ ok, workspace, placeholderDir, title, registered }`.

## Development

```bash
pnpm install
pnpm build        # tsc (host) + esbuild wrapper (client)
pnpm test         # unit/fault tests + isolated loopback SSH; no user hosts
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
