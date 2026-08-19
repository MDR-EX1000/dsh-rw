# Acceptance

How dsh-rw is verified before a release, and the current status of each item.

## 1. Unit tests — 285/285 PASS

```bash
pnpm test        # vitest run, 13 files / 285 tests
pnpm typecheck   # tsc --noEmit
```

Also enforced by GitHub Actions on every push/PR (`.github/workflows/ci.yml`), and by
`prepack` on every `npm pack/publish`.

## 2. Live acceptance against real hosts — PASS

`scripts/acceptance.mjs` consumes the compiled `lib/` output and exercises a real SSH
host end to end: connect → workspace-confined file CRUD → security boundaries → exec,
cross-checking results against plain `ssh` on the same host. It only writes/deletes
inside the `/tmp/dsh-rw-acceptance.*` directory it is given, and never reads or prints
credentials.

```bash
node scripts/acceptance.mjs <ssh-alias> /tmp/dsh-rw-acceptance.XXXX
```

Last run (2026-08-19, dsh-rw 0.1.0):

| host    | result     |
| ------- | ---------- |
| freedom | 23/23 PASS |
| docker  | 23/23 PASS |

Covered: host key verification (incl. changed-key refusal), workspace confinement
(`../`, absolute paths outside root, `SYMLINK_ESCAPE` via remote `realpath`),
structured error codes (`NO_SUCH_PATH`, `PERMISSION_DENIED`, …), exec cwd/exit-code
propagation, and placeholder metadata (`.dsh-rw-meta.json`).

## 3. Web UI manual checks — pending human confirmation

Automated tests cover the host side; the client bundle is verified structurally
(`tests/client-bundle.test.ts`). The following are verified by a human in
`dsh web` (http://127.0.0.1:3080):

- [ ] "Add workspace" opens the two-tab picker modal (本机 / 远程)
- [ ] 远程 tab lists hosts from `~/.ssh/config`; path input autocompletes level by level
- [ ] "+ 添加主机" form adds a password-auth host; host can be deleted again
- [ ] Picking a host + path registers the workspace and the agent can use `rw_*` tools in it
