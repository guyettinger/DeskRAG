# App-local native install — ending the better-sqlite3 ABI switch

**Date:** 2026-07-24
**Status:** Design approved, pending spec review

## Context

`better-sqlite3` is a raw `NODE_MODULE_VERSION` native addon: its compiled
`better_sqlite3.node` is bound to one ABI. The library's tests run on system
Node (ABI 127); the desktop app runs on Electron's Node (a different ABI). Today
there is exactly **one** copy of the module, hoisted to the repo-root
`node_modules` because `app/` is an npm **workspace member**. So the app's
`rebuild:native` rebuilds that one copy for Electron — which breaks the library's
`npm test` with a `NODE_MODULE_VERSION` error until it is rebuilt back for Node.
Development means ping-ponging one binary between two ABIs.

The goal: **both ABIs coexist and the switching goes away entirely** — an
app-local copy of `better-sqlite3` compiled for Electron, physically separate
from the library's Node-ABI copy, so neither rebuild touches the other.

### One root cause, three symptoms

Everything traces to `app/` being a hoisting workspace member (one hoisted copy
of every native dep, at root):

1. **ABI switching** — the one `better-sqlite3` copy can be Node-ABI *or*
   Electron-ABI, never both.
2. **Packaging is broken** — `app:dist` fails because `electron-builder` can't
   resolve the hoisted `electron` from root (documented in `app/README.md`), and
   `app/package.json` has **no `dependencies`**, so a package would ship zero
   native modules anyway.
3. *(adjacent, out of scope)* — `loadNativeProducer`'s runtime
   `import("deskrag/capture/producers/...")` resolves to nothing (no `deskrag`
   package exists on disk), so input / active-window capture silently no-op.

Fixing the root cause resolves #1 and #2 together. #3 is left as a follow-up.

## Why this works (the runtime already cooperates)

`electron-vite` bundles the library from `../dist` and **externalizes only the
native modules** as bare specifiers — verified in the built `app/out/main`
bundle, which emits bare `from "better-sqlite3"`, `from "@lancedb/lancedb"`, and
`from "sharp"` (in the lazy cropper chunk). At runtime `app/out/main/index.js`
resolves those by Node's normal upward directory walk. Because `app/` is
physically nested in the repo, that walk checks `app/node_modules` **before**
the repo root — so an Electron-ABI copy placed in `app/node_modules` wins, and
root's Node-ABI copy is never consulted by the app again.

Only `better-sqlite3` is ABI-fragile (raw Node addon). `@lancedb/lancedb`,
`sharp`, `uiohook-napi`, and `active-win` are N-API / prebuilt (ABI-stable) —
they must be present in the app's tree for packaging, but are never rebuilt. The
library's pure-JS runtime deps (`apache-arrow`, `ulid`, `undici`,
`@anthropic-ai/sdk`) are **bundled** into the main chunk (not externalized), so
they resolve from root at build time via directory nesting and need not be app
dependencies.

## Changes

### `package.json` (root)
- Remove `"app"` from `workspaces` (drop the field). This is the crux: npm has
  no per-package nohoist, so leaving `app/` in the workspace guarantees a single
  hoisted `better-sqlite3`. Removing it lets `app/` own its native install.
- Repoint the app scripts from `npm --workspace deskrag-app run …` to
  `npm --prefix app run …`: `app:dev`, `app:build`, `app:dist`.
- Add `"app:install": "npm --prefix app install"` as a convenience.

### `app/package.json`
- Add real `dependencies` for the runtime externals, versions matching root:
  `better-sqlite3`, `@lancedb/lancedb`, `sharp`, `uiohook-napi`, `active-win`.
- Mirror root's platform `optionalDependencies`: `@lancedb/lancedb-darwin-arm64`.
- Change `rebuild:native` to `electron-rebuild -f -w better-sqlite3` (module-dir
  now defaults to `app/`; drop the `--module-dir ../`).
- Add `"postinstall": "electron-rebuild -f -w better-sqlite3"` so
  `cd app && npm install` lands Electron-ready with no manual step. (Only the
  app's copy is ever rebuilt; root's is untouched.)

### `app/electron.vite.config.ts`
- **Unchanged.** The `../dist` alias and the `nativeExternals` list stay correct.

### Docs — retire the "hard way" invariant
- `CLAUDE.md`: delete the "`rebuild:native` breaks `npm test`" invariant and the
  `rebuild:native` line from the app command block; restate the two-install
  model; flip "App-local native copies are future work" → done. Add a one-line
  note that native version pins now live in both `package.json`s and must stay in
  sync.
- `README.md` + `app/README.md`: replace the install steps (root `npm install`
  for the library; `cd app && npm install` for the app) and delete the
  "packaging does not yet work" note.

## The new workflow

- **Library / tests / CI:** `npm install` → `npm test`. `better-sqlite3` stays
  Node-ABI **permanently** — no rebuild step ever.
- **App:** `cd app && npm install` once (postinstall builds `better-sqlite3` for
  Electron), then `npm run app:dev` from root.
- **Packaging:** `npm run app:dist` now resolves `electron` and packages +
  rebuilds native deps from the app's own tree.

## Trade-offs (accepted)

- **Disk:** `app/node_modules` duplicates `@lancedb/lancedb`, `sharp`, and
  `electron` (hundreds of MB). This duplication *is* the isolation — the price of
  two coexisting ABIs.
- **Two installs** to remember — mitigated by `app:install` and the docs.
- **Native pins live in two `package.json`s** — a handful of stable pins to keep
  in sync (noted in `CLAUDE.md`).
- **App build depends on the repo-root install** for the bundled pure-JS deps via
  directory nesting. Acceptable: the app is inherently a repo-root consumer (it
  aliases `../dist`), and `app:build` runs the library build first.

## Out of scope

- **`loadNativeProducer` dead imports (symptom #3).** Fixing input / active-window
  capture requires either bundling those producer modules or resolving the native
  modules directly. Not needed for ABI coexistence; tracked as a follow-up.

## Verification

1. **Library untouched:** root `npm install && npm test && npm run typecheck` —
   all green, no `NODE_MODULE_VERSION` errors, no rebuild step.
2. **App builds for Electron:** `cd app && npm install` (postinstall rebuilds
   `better-sqlite3`), `npm --prefix app run typecheck`, `npm run app:dev` —
   launch, record, and search (exercises `better-sqlite3` under Electron).
3. **The actual win:** immediately re-run root `npm test` — it must **still**
   pass, proving the two copies are independent (this is exactly what broke
   before).
4. **Packaging:** `npm run app:dist` produces a launchable `app/dist-app` bundle
   whose store opens.
