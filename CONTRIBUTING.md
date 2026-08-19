# Contributing

## Dev loop

```bash
pnpm install        # requires pnpm 11 (see pnpm-workspace.yaml for the supply-chain settings)
pnpm typecheck      # tsc --noEmit
pnpm build          # tsc host side (lib/) + esbuild client bundle (lib/client.js)
pnpm test           # vitest run — 285 tests
```

The host half (`src/*.ts`) compiles with `tsc -p tsconfig.build.json`; the client half
(`src/client/index.tsx`) is bundled by `build-client.mjs` (esbuild). Never edit `lib/` by hand.

Note on `ssh2`: it is CJS — always `import ssh2 from 'ssh2'` and destructure; named imports
crash the DSH boot loader.

## Try it in DSH

```bash
dsh plugin --profile web remove dsh-rw   # if an older copy is installed
dsh plugin --profile web add /path/to/dsh-rw
# restart dsh web, then: Add workspace → 远程 tab
```

The profile install consumes `lib/` — run `pnpm build` before reinstalling after code changes.

## Live acceptance

With an SSH alias from `~/.ssh/config`:

```bash
node scripts/acceptance.mjs <alias> /tmp/dsh-rw-acceptance.XXXX
```

Writes only inside the given `/tmp/dsh-rw-acceptance.*` dir. See ACCEPTANCE.md for what is covered.

## Release

1. `pnpm build && pnpm test` (also runs as `prepack`).
2. `npm pack` → attach the tarball to a GitHub Release (this is the market install artifact).
3. `git tag vX.Y.Z && git push --tags`; `gh release create vX.Y.Z dsh-rw-X.Y.Z.tgz`.
4. Optional: `npm publish --access public` (registry account requires 2FA for writes).
