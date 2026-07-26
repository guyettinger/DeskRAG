/**
 * Runs ColSmol REPEATEDLY under the Electron binary's allocator — the one
 * failure mode no vitest test can reach.
 *
 * WHY THIS EXISTS: the ONNX crashes this project has hit twice both need two
 * things at once, and the suite provides neither.
 *
 *   1. Chromium's allocator. It refuses a single huge `operator new` and turns
 *      the failure into a deliberate crash (EXC_BREAKPOINT; utilityProcess
 *      reports `exit code=5`). Bare node's malloc satisfies the same request,
 *      so `npm test` passes either way and only the app dies.
 *   2. A SECOND run. ORT's memory-pattern planner records the activation
 *      layout on run #1 and only from run #2 onward pre-allocates its one fused
 *      block in `ExecutionFrame`'s constructor.
 *
 * A single-image check under bare node — which is what every earlier
 * verification did — misses both. Hence: real weights, real Electron, N runs.
 *
 *   npm run smoke:onnx-electron
 *   node scripts/onnx-electron-smoke.mjs [runs]        # default 3
 *
 * Skips cleanly (exit 0) without `app/node_modules` or the models, so it is
 * safe to wire into CI. Set DESKRAG_MODELS_DIR to override the models
 * location; it defaults to where DeskRAGApp downloads them.
 *
 * Requires `npm run build` first (imports dist/) — the npm script does it.
 *
 * ONE FILE, THREE ROLES, because the crash needs a real process tree:
 *   plain node        -> launcher: checks the gates, spawns Electron on itself
 *   electron main     -> forks itself as a utilityProcess, mirrors its exit code
 *   utilityProcess    -> the actual work (detected by process.parentPort)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SELF = fileURLToPath(import.meta.url);

const DEFAULT_MODELS = join(
  homedir(),
  "Library/Application Support/deskrag-app/DeskRAG/models",
);
const MODELS = process.env.DESKRAG_MODELS_DIR || DEFAULT_MODELS;
const COLSMOL = join(MODELS, "colSmol-256M-dynamic");
const FIXTURE = join(ROOT, "test/fixtures/login.png");
const ELECTRON = join(ROOT, "app/node_modules/.bin/electron");

// The whole point is repetition: run 1 can never fail this way.
const RUNS = Math.max(2, Number(process.argv[2] ?? 3) || 3);

/* -------------------------------------------------------------------------- */
/* role 3: the utility process — detected first, it is the innermost           */
/* -------------------------------------------------------------------------- */

if (process.parentPort) {
  const gb = (b) => (b / 2 ** 30).toFixed(2);
  const D = "file://" + join(ROOT, "dist/embed/onnx");
  const { ColSmolMultiVector, readTileConfig } = await import(`${D}/colsmol.js`);
  const { computeTileGeometry } = await import(`${D}/geometry.js`);

  const cfg = await readTileConfig(
    join(COLSMOL, "preprocessor_config.json"),
    join(COLSMOL, "config.json"),
  );

  // No injected session: this must exercise the REAL SESSION_OPTIONS, since
  // those flags are the thing under test.
  const emb = new ColSmolMultiVector({
    modelPath: join(COLSMOL, "model.onnx"),
    tokenizerPath: join(COLSMOL, "tokenizer.json"),
    tileConfig: cfg,
  });

  const bytes = readFileSync(FIXTURE);
  const { tileImageWithSharp } = await import(`${D}/colsmol-tiler.js`);
  const tiled = await tileImageWithSharp(bytes, cfg);
  const geo = computeTileGeometry(tiled.width, tiled.height, cfg);
  const tiles = geo.cols * geo.rows + (geo.hasGlobalTile ? 1 : 0);

  // A single-tile image would allocate too little to prove anything, and would
  // pass just as happily with the flags reverted.
  if (tiles < 2) {
    console.error(
      `FAIL: fixture tiles to ${tiles} tile(s) — too small to exercise the ` +
        `allocation this smoke exists to catch.`,
    );
    process.exit(1);
  }
  console.log(
    `[smoke] ${tiled.width}x${tiled.height} -> ${geo.cols}x${geo.rows}` +
      `${geo.hasGlobalTile ? " + global" : ""} = ${tiles} tiles`,
  );

  let first;
  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now();
    const [patches] = await emb.embedImages([bytes]);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[smoke] run ${i}/${RUNS} ok in ${secs}s vectors=${patches.length} ` +
        `rss=${gb(process.memoryUsage.rss())}GB`,
    );

    // The planner reuses a recorded layout across runs; if that reuse were ever
    // subtly wrong the vectors would drift rather than crash. Cheap to rule out.
    if (i === 1) {
      first = patches;
    } else if (patches.length !== first.length) {
      console.error(
        `FAIL: run ${i} returned ${patches.length} vectors, run 1 returned ${first.length}`,
      );
      process.exit(1);
    } else {
      for (let k = 0; k < first[0].length; k++) {
        if (first[0][k] !== patches[0][k]) {
          console.error(`FAIL: run ${i} vector 0 differs from run 1 at index ${k}`);
          process.exit(1);
        }
      }
    }
  }
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* role 2: electron main — fork ourselves as the utility process               */
/* -------------------------------------------------------------------------- */

if (process.versions.electron) {
  const { app, utilityProcess } = await import("electron");

  // `ready` never fires while a top-level await holds this module's evaluation
  // open, so this stays in .then() deliberately.
  app.whenReady().then(() => {
    app.dock?.hide();
    const child = utilityProcess.fork(SELF, process.argv.slice(2), {
      serviceName: "deskrag-onnx-smoke",
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        console.error(
          `\nFAIL: the ONNX worker died (exit code=${code}).\n` +
            `Code 5 is SIGTRAP — Chromium's allocator refusing a single huge\n` +
            `allocation. Check SESSION_OPTIONS in src/embed/onnx/runtime.ts:\n` +
            `both enableCpuMemArena and enableMemPattern must be false.`,
        );
      } else {
        console.log(`\nPASS: ${RUNS} consecutive ColSmol runs under Electron.`);
      }
      app.exit(code === 0 ? 0 : 1);
    });
  });
} else {
  /* ------------------------------------------------------------------------ */
  /* role 1: plain node launcher — gate, then hand off to Electron             */
  /* ------------------------------------------------------------------------ */

  const skip = (why) => {
    console.log(`[smoke] SKIP: ${why}`);
    process.exit(0);
  };

  if (!existsSync(ELECTRON)) skip("app/node_modules missing — run `npm run app:install`");
  if (!existsSync(join(COLSMOL, "model.onnx"))) {
    skip(`no ColSmol weights at ${COLSMOL} — record once in the app, or set DESKRAG_MODELS_DIR`);
  }
  if (!existsSync(join(ROOT, "dist/embed/onnx/colsmol.js"))) {
    console.error("[smoke] dist/ is missing — run `npm run build` first.");
    process.exit(1);
  }

  console.log(`[smoke] models: ${COLSMOL}`);
  console.log(`[smoke] ${RUNS} runs under Electron (run 2 is the one that matters)`);
  const res = spawnSync(ELECTRON, [SELF, String(RUNS)], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}
