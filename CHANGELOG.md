# Changelog

All notable changes to **dsh-rw**. Format follows [Keep a Changelog](https://keepachangelog.com/),
versioning follows [SemVer](https://semver.org/).

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
