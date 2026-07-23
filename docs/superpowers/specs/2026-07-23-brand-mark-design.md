# DeskRAG brand mark — logo, icon, and animated Lottie

**Date:** 2026-07-23
**Status:** approved, ready for implementation planning

## Goal

Give DeskRAG a visual identity: a static logo, a square app/tray icon, and an
animated Lottie of a rag-ghost hovering over a desk — applied to the README, the
app README, and DeskRAGApp itself (rail brand, busy states, empty states,
dock/tray/packaged icons).

## The mark

A **pure silhouette** ghost — smooth dome, even hem lobes, no interior detail,
matching the reference art — hovering above an **implied desk**: one horizontal
rounded bar plus a soft elliptical shadow resting on it. Three elements total, so
the mark survives down to 16px without a separate simplified cut.

### Palette

| Token | Value | Used for |
|---|---|---|
| `ghost-top` | `#FFFFFF` | gradient stop 0% |
| `ghost-mid` | `#F3EEFF` | gradient stop 45% |
| `ghost-bot` | `#A18AF5` | gradient stop 100% |
| `face` | `#12161C` | eyes, mouth |
| `desk` | `#8A93A3` at `0.55` | desk bar |
| `shadow` | `#6D5BD0` at `0.28 → 0` | radial-gradient contact shadow |

`ghost-bot` is the reference art's violet nudged toward the app's existing
`--accent: #7c9cff` (`app/src/renderer/src/styles.css`) so the mark reads as part
of the same system as the UI. `face` is effectively the app's `--ink` (`#0f1216`).

`desk` and `shadow` are mid-tones chosen to stay legible on **all three**
backgrounds the assets land on: GitHub light, GitHub dark, and the app's
`#0f1216`. There is exactly one mark; there are no light/dark variants.

**No SVG filters.** No `feGaussianBlur` anywhere — softness comes from radial
gradient stops only. Rationale: `sharp` rasterises SVG through libvips/librsvg,
whose filter support is inconsistent; gradients rasterise exactly. This keeps the
icon PNGs pixel-identical to what a browser shows.

### Geometry

Authored in a `0 0 240 260` ghost-local box, composed into a `0 0 256 256` square
for the mark.

- **Body:** vertical sides at `x = 24` and `x = 216` rising to a dome apex near
  `y = 20`, cubic-curved shoulders.
- **Hem:** three downward lobes across `x = 24…216` (boundaries at 24 / 88 / 152 /
  216, lobe bottoms ≈ `y = 218`, cusps ≈ `y = 186`). Tangents at the two outer
  ends are vertical so the hem meets the body sides without a visible corner.
- **Eyes:** vertical ellipses, `rx 13` / `ry 17`, centred `(88, 112)` and
  `(152, 112)`.
- **Mouth:** round-capped arc, `M 110 130 Q 120 141 130 130`, stroke-width 6.
- **Composed mark (256×256):** ghost occupies roughly `y 30…200`; desk bar spans
  `x 28…228` at `y ≈ 224`; shadow ellipse `cx 128`, `cy 222`, `rx 54`, `ry 9`,
  drawn over the bar.

Exact numbers are owned by `geometry.mjs` (below); the values here fix the
proportions and are the reference if the module is ever re-derived.

## Architecture — one geometry module, four emitters

The animated SVG and the Lottie JSON describe identical motion in two
incompatible formats. Hand-maintaining both guarantees drift. So neither is
hand-authored: both are emitted from one module.

```
scripts/brand/
  geometry.mjs      the ONLY place ghost shape + motion math lives.
                    Pure functions, no I/O, no deps:
                      ghostBodyPath(phase) -> SVG path string
                      hemLobes(phase)      -> control points for the 3 lobes
                      bob(t)               -> vertical offset at normalised t
                      shadowAt(t)          -> { scale, opacity }
                      face()               -> eye/mouth primitives
                      palette              -> the table above
  emit-static.mjs   -> assets/deskrag-mark.svg, assets/deskrag-logo.svg
  emit-svg.mjs      -> assets/deskrag-ghost.svg          (CSS bob + SMIL hem morph)
  emit-lottie.mjs   -> assets/deskrag-ghost.lottie.json  (bodymovin v5)
  emit-icons.mjs    -> app/build/icon.{png,icns,ico}, app/build/tray/*
  index.mjs         runner for all four
```

Each unit has one job: `geometry.mjs` knows shape and motion but nothing about
file formats; each emitter knows one file format but no shape math. An emitter
can be rewritten without touching the others, and a proportion tweak lands in
every asset at once.

Exposed as `npm run gen:brand` at the repo root.

### Build dependencies: zero new ones

- **SVG → PNG:** `sharp`, already a root dependency of the library.
- **PNG set → `.icns`:** macOS's built-in `iconutil` (`.iconset` dir → `icns`).
- **PNG set → `.ico`:** a small hand-rolled packer in `emit-icons.mjs`. The ICO
  container is a 6-byte header plus a 16-byte directory entry per image plus the
  PNG payloads — no library warranted.

`emit-icons.mjs` requires macOS for `iconutil`. It must fail with a clear message
on other platforms rather than emitting a broken `.icns`; the committed artifacts
mean non-macOS contributors never need to run it.

## Motion

One 3-second loop at 60fps (180 frames), ease-in-out, emitted identically into
both formats:

- **Bob:** ±8px vertical, sinusoidal.
- **Hem:** the three lobes morph between 4 keyframe shapes, **phase-offset per
  lobe** so the cloth ripples left→right rather than pulsing in unison.
- **Shadow:** scale `1.0 → 0.86` and opacity `0.28 → 0.18`, in sync with the bob —
  the ghost's shadow tightening as it rises is the cue that sells "hovering".
- **Face:** eyes and mouth ride the body transform and never detach.

In the SVG the bob is a CSS `@keyframes` transform and the hem morph is SMIL
`<animate>` on the path's `d`. In the Lottie the bob is a transform-position
keyframe track and the hem is an animated `sh` (shape) property; the body, face,
and shadow are separate shape groups so the hem morph affects only the body.

## Deliverables

### `assets/` (canonical, generated, committed)

| File | What |
|---|---|
| `deskrag-mark.svg` | square 256×256 mark — ghost + desk + shadow |
| `deskrag-logo.svg` | horizontal lockup — mark + "DeskRAG" wordmark |
| `deskrag-ghost.svg` | animated SVG (CSS + SMIL), for the READMEs |
| `deskrag-ghost.lottie.json` | Lottie / bodymovin v5, played in the app |

The wordmark is set in the app's existing system UI font stack. No font is
licensed, embedded, or converted to outlines.

### `app/build/` (generated, committed)

`icon.png` (1024), `icon.icns`, `icon.ico`, and `tray/trayTemplate.png` +
`trayTemplate@2x.png`. Committed so packaging never requires running the
generator.

## App integration

New directory `app/src/renderer/src/brand/`. A vite alias `@brand` →
repo-root `assets/` is added to the **renderer** config in
`app/electron.vite.config.ts`, so the app consumes the canonical assets directly
with no duplicated copies in git. Because `assets/` sits outside the app's vite
root, the renderer config also needs `server.fs.allow` to include the repo root —
production builds resolve the import fine without it, but `electron-vite dev`
will refuse to serve the file otherwise.

- **`GhostMark.tsx`** — the static mark as inline SVG. Replaces the rail's plain
  `DESK·RAG` text (`App.tsx`) with mark + wordmark.
- **`GhostLottie.tsx`** — a thin `lottie-web` wrapper, props `{ playing, size }`.
  `lottie-web`'s **light build** (`lottie-web/build/player/lottie_light`), added
  as a dependency of the `deskrag-app` workspace only — never the library.
  It **honors `prefers-reduced-motion`**: renders a single static frame instead of
  looping.
- **Animated placements:** indexing progress and live recording on `RecordScreen`;
  pre-query and no-results states on `SearchScreen`.
- **Packaged icons:** `app/electron-builder.yml` + an `electron-builder` devDep +
  an `app:dist` script. `app:build` (electron-vite only) is unchanged.
- **Dev dock icon:** `app.dock.setIcon()` in `app/src/main/index.ts`, since an
  unpackaged macOS dev run otherwise shows Electron's own icon.
- **Tray:** `app/src/main/index.ts:102` currently does
  `new Tray(nativeImage.createEmpty())` — a blank menu-bar icon. Replaced with the
  monochrome **template** image (`…Template.png` naming, so macOS auto-inverts it
  for light/dark menu bars).

The process boundary is untouched: the brand assets are renderer-side, the icons
are main-side, and no DTO or IPC channel changes.

## README integration

- **`README.md`** — the animated ghost, centred, above the `# DeskRAG` heading.
- **`app/README.md`** — the static mark atop the existing intro.

**Known caveat, stated up front:** GitHub serves README images through its camo
proxy. CSS and SMIL animation inside an SVG referenced as an `<img>` is widely
used and works, but is not contractually guaranteed. If it renders static, the
fallback is committing a generated GIF twin. The GIF is **not** produced
preemptively — it would be added on request.

## Drift guard

`test/brand.test.ts` re-runs the emitters in memory and byte-compares the result
against the committed files in `assets/`. Hand-editing a generated SVG without
regenerating fails `npm test`. This is what makes `geometry.mjs` the permanent
single source of truth rather than merely the original one.

The test is pure JS — no native modules, no network — so it stays inside the
suite's existing "fast and deterministic" contract. Binary icons under
`app/build/` are **not** covered by the drift guard: rasterisation output varies
with the installed libvips/librsvg version, so byte-comparing them would produce
false failures across machines.

## Out of scope

- Light/dark mark variants — one mark works on both by construction.
- A simplified small-size icon cut — the pure silhouette needs none.
- Font licensing or an outlined wordmark.
- A GIF twin, unless the README SVG proves to render static.
- Any change to the library (`src/`), the store, or the IPC contract.

## Verification

1. `npm run gen:brand` regenerates all assets; `git diff` is empty on a clean tree.
2. `npm test` passes, including the new drift guard.
3. `npm run typecheck` and `npm --workspace deskrag-app run typecheck` pass.
4. `npm run app:dev` launches: rail shows the mark, the ghost animates during
   indexing and on the empty search state, the tray icon is visible in the menu
   bar, and the dock icon is the DeskRAG mark.
5. The mark is legible at 16px, and on GitHub light and dark.
