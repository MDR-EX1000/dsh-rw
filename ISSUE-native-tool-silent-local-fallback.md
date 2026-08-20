# dsh-rw: native tools silently fall back to the local filesystem when the rw session is disconnected or the agent cwd isn't inside the current host's placeholder

## Summary

In a remote-backed (dsh-rw) session, the native `read` / `write` / `edit` / `str_replace_editor` / `glob` / `grep` / `bash` tools can **silently** stop being translated to the remote host and instead operate on the **local empty placeholder directory** — with no warning and with return values that are indistinguishable from the remote-backed case. This contradicts the documented contract ("native tools translated to the remote host automatically; the remote filesystem is the source of truth; no local mirror") and caused the agent to write/read/delete files locally instead of on the remote, and to misidentify the active repository.

## Affected versions

- `dsh-rw` **0.2.0** (installed at `~/.dsh/profiles/web/node_modules/dsh-rw`) — behavior observed here.
- `dsh-rw` **0.3.0** dev source (`src/`) — same logic; line references below are from this tree.
- `@deepseek-ai/dsh` **0.1.0-rc.6**.
- Client: macOS Darwin 23.5.0. Hosts: `freedom` + `docker` on `platform.shaipower.com:22`.

## Documented contract (being violated)

From the dsh-rw session system prompt:

> "This session's workspace is remote-backed: the native read/write/edit/str_replace_editor/glob/grep/bash tools are translated to the remote host automatically — use them exactly as if the workspace were local. … the remote filesystem is the source of truth (no local mirror)."

`src/placeholder.ts` reinforces this: the placeholder is *"placeholder only — not a copy of remote files"* and holds only `.dsh-rw-meta.json`.

## Root cause (code)

1. **The shim sleeps whenever `session.alias` or `session.workspace` is null.**
   `src/shim.ts` `activeTarget()`:
   ```ts
   const alias = deps.session.alias
   const workspace = deps.session.workspace
   if (alias === null || workspace === null) return null   // shim.ts:148
   ```
   and the dispatcher:
   ```ts
   if (target === null) return next()   // shim.ts:937 → pass through to the LOCAL native tool
   ```
   When the shim sleeps, every native tool runs **locally** on the placeholder dir (which only contains `.dsh-rw-meta.json`).

2. **`rw_disconnect` creates exactly that "asleep" state.**
   `src/tools.ts` `rw_disconnect`:
   ```ts
   session.set({ alias: null })   // tools.ts:513 — clears alias, KEEPS workspace
   ```
   So after a disconnect the persisted session is `{ alias: null, workspace: <kept> }` → shim asleep → native tools go local. The placeholder meta still carries full reconnection info (`host`, `port`, `user`, `remotePath`) but nothing reconnects from it.

3. **Even with a non-null alias, `bash`/`glob`/`grep` silently pass through to local when the agent cwd is not inside the *current host's* placeholder.**
   `src/shim.ts`:
   ```ts
   function sessionInsidePlaceholder(target, exec) {           // shim.ts:210
     const cwd = agentCwd(exec)
     return cwd !== undefined && insideLocal(target.localRoots, resolve(cwd))
   }
   // bash:  if (!sessionInsidePlaceholder(target, exec)) return null   // shim.ts:879
   // glob:  if (!sessionInsidePlaceholder(target, exec)) return null   // shim.ts:706 (searchDir)
   ```
   The DSH agent cwd (the registered DSH workspace) and the dsh-rw "current host" are tracked **independently**. When they disagree (e.g. agent cwd = `freedom/clean-best-practice` placeholder but current host = `docker`), the containment gate fails and `bash`/`glob`/`grep` fall back to **local** — silently.

4. **The shared session file can be mutated under a live agent's feet.**
   `~/.dsh/dsh-rw-session.json` is written by `rw_connect` / `rw_pick_workspace` / `rw_disconnect` (tools.ts:205/235/435) and also by the HTTP `/api/dsh-rw/*` routes / GUI. There is no consistency guard or notification. In this session the current host flipped from `freedom` to `docker` between two of the agent's turns with **no** `rw_connect`/`rw_pick_workspace`/`rw_disconnect` call from the agent in between — so the shim's target silently retargeted mid-conversation.

## Observed manifestations (this session)

- **Self-reproduced (Bug #2/#1):** after running `rw_disconnect` (to inspect the local source tree), native `bash` ran on the **local Mac** — `hostname` returned `<Mac>.local`, Darwin kernel; `ls` showed only `.dsh-rw-meta.json`, not the remote repo. The agent had no indication that `bash` was no longer remote.
- **Indistinguishable local vs. remote results:** native `write`/`read`/`glob` of a `readme.txt` returned placeholder-form paths identical whether the shim was active (remote) or asleep (local). The agent cannot tell its file ops landed locally.
- **One session, two remotes, no warning:** `rw_info` reported `current host = docker / /data/CODE/commodity-forecast/myh-sc` while the agent cwd was the `freedom/clean-best-practice` placeholder. Native `bash`/`glob` therefore ran locally; `rw_exec`/`rw_list_dir` hit `docker`. `rw_exec git remote -v` returned `commodity-forecast.git` while the native-tool workspace was actually `clean-best-practice` — the agent gave a wrong "which repo" answer.

## Minimal repro

### Bug A — disconnect → native tools go local (no warning)

```
rw_connect freedom
rw_pick_workspace /data/CODE/SWIFT/clean-best-practice
# native `bash` now runs on remote; `ls` shows the repo (AGENTS.md, infer/, train/, ...)
rw_disconnect
# native `bash` now runs LOCALLY: hostname = <client Mac>, `ls` shows only .dsh-rw-meta.json
write readme.txt          # writes to the LOCAL empty placeholder, NOT the remote
read  readme.txt          # reads it back from the LOCAL placeholder — looks successful
```

**Expected:** native tools either auto-reconnect to the placeholder's recorded host (meta has `host/port/user/remotePath`) or fail loudly.
**Actual:** silently operate on the local empty placeholder; return values look identical to the remote-backed case.

### Bug B — agent cwd ≠ current host's placeholder → native bash/glob go local

- DSH workspace (agent cwd) = `~/.dsh/remote-workspaces/freedom/clean-best-practice-…`
- dsh-rw current host = `docker` (`/data/CODE/commodity-forecast/myh-sc`, placeholder `docker/myh-sc`)

→ `sessionInsidePlaceholder` is false for the `docker` target, so native `bash`/`glob`/`grep` pass through to **local**; meanwhile `rw_exec`/`rw_list_dir` target `docker`. There is no single source of truth for "which repo am I in", and no warning that the two tool families disagree.

## Expected behavior

1. Native tools must **never silently** fall back to a local empty placeholder. When the rw session is not usable (alias null, or cwd–host mismatch), either auto-establish the placeholder's recorded connection or error loudly — do not run locally against a dir that is explicitly "not a copy of remote files".
2. One canonical "current remote workspace" per session. When the session host ≠ the agent-cwd placeholder host, surface a prominent warning (the native tools and `rw_*` disagree).
3. `rw_info` should report the host/workspace that native ops will **actually** target (today it can report `docker` while native ops run locally against a `freedom` placeholder).

## Suggested fix directions

- `rw_disconnect`: consider keeping a reconnectable alias (or a flag) instead of nulling it, so the shim can re-establish from placeholder meta when a matching placeholder exists; or have the shim auto-connect from placeholder meta on a null alias.
- `shim.ts:879` / `:706`: when a native `bash`/`glob`/`grep` call is dropped to local due to `sessionInsidePlaceholder` being false, at minimum emit a warning (or fail) instead of a silent `return next()`.
- Make the native-tool "asleep" state (target null) visible: log/warn, or surface it in `rw_info`, so the agent/user knows native ops are local.
- Add a consistency guard so the shared session file cannot silently retarget a live agent's shim between turns (e.g. generation counter / change notification).

## Environment

- macOS Darwin 23.5.0 (client)
- `dsh-rw` 0.2.0 installed / 0.3.0 dev src
- `@deepseek-ai/dsh` 0.1.0-rc.6
- Hosts: `freedom` (`freedom.foolma.shai-core.ws@platform.shaipower.com:22`) and `docker` (`build-docker.foolma.shai-core.ws@platform.shaipower.com:22`)
