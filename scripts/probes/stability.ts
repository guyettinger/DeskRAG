/**
 * Is the habit set the SAME after a full re-index and re-mine, or does it move?
 *
 * The other half of the held-out evaluation. `probe:transfer` asks whether one
 * habit answers to a recording it was not built from; this asks whether the
 * LIBRARY is stable — because a route's key is its place-label sequence and
 * `rebuildGraph` discards and replays the whole graph on every re-index. If the
 * keys move, every stored `HabitBindingDoc.routeKey` is stale and `bindHabit`
 * has to re-bind, disclose an ambiguity, or orphan a habit somebody wrote. A
 * library that re-keys itself on every rebuild is not a library.
 *
 * ## What is being claimed, and what would falsify it
 *
 * A route key is a function of CAPTURE plus segmentation plus regions.
 * `trace-index.ts` reads events, AX snapshots and regions and nothing else — no
 * caption, no digest, no composed summary — and all three of its inputs are
 * deterministic passes. So the keys should not move at all, and any drift here
 * is a real finding rather than expected noise. That prediction is exactly what
 * makes this worth running: it fails loudly or it holds.
 *
 * A route's NAME does come from composed summaries and a model, so it will vary
 * between cycles. It is printed and deliberately not counted — the name is not
 * the key, and nothing binds on it.
 *
 * ## Cycles, and why the first one is confounded
 *
 * BASELINE is the store as it stands, indexed under whatever providers the user
 * actually ran. Every cycle after it re-indexes with captions and frame patches
 * OFF, because those are essentially the whole cost of a re-index and neither
 * reaches the graph. So baseline -> 1 changes two things at once (the providers
 * AND the re-index) and 1 -> 2 -> 3 changes only one. Both deltas are reported
 * separately and labelled; reading them as one number would attribute a
 * provider change to instability.
 *
 * ## It WRITES, so it writes to a COPY
 *
 * `<userData>/DeskRAG` is cloned (APFS copy-on-write) and the app is launched
 * against the clone, which is deleted at the end. A re-index PURGES everything
 * derived before rebuilding it, so running this against the real store would
 * rebuild a person's library three times with the wrong providers. The real
 * store is opened once, by `cp`, and never by the app.
 *
 * Run:  npm run probe:stability [--cycles=3]
 * Time: minutes per recording per cycle. It prints its own estimate first.
 */

import "../lib/renderer-globals.js";
import { launchApp } from "../lib/launch.js";
import { num } from "../lib/args.js";
import { cloneLibrary } from "../lib/library-clone.js";
import { ok, summary } from "../lib/report.js";
import { until } from "../lib/wait.js";

const CYCLES = num("cycles", 3);
if (!Number.isInteger(CYCLES) || CYCLES < 1) {
  console.error(`--cycles must be a positive integer, got ${CYCLES}`);
  process.exit(1);
}

const copy = cloneLibrary("deskrag-stability");
if (copy === null) process.exit(0);

const { app, page } = await launchApp({ width: 1400, height: 1100, userDataDir: copy.root });

/** One observation of the library: the route keys, and how every habit binds. */
const snapshot = async () => {
  const flows = await page.evaluate(async () => await window.deskrag.flows.graph());
  const habits = await page.evaluate(async () => await window.deskrag.habits.list());
  return {
    // A MULTISET as a sorted list: two routes cannot share a key, but a key
    // appearing or vanishing is exactly what this measures, so it is compared
    // as a whole rather than by count.
    keys: (flows?.routes ?? []).map((r) => r.id).sort(),
    counts: Object.fromEntries((flows?.routes ?? []).map((r) => [r.id, r.count])),
    names: Object.fromEntries((flows?.routes ?? []).map((r) => [r.id, r.name ?? "(unnamed)"])),
    bindings: (habits?.habits ?? []).map((s) => ({
      slug: s.slug,
      state: s.binding.state,
      live: s.binding.liveRouteKey ?? null,
    })),
  };
};

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

const diffKeys = (
  a: readonly string[],
  b: readonly string[],
): { gone: string[]; gained: string[] } => ({
  gone: a.filter((k) => !b.includes(k)),
  gained: b.filter((k) => !a.includes(k)),
});

try {
  const settings = await page.evaluate(async () => await window.deskrag.settings.get());
  const p = settings.providers;
  console.log("CONFIGURATION");
  console.log(`  summary provider   ${p.summaryProvider} / ${p.ollamaSummaryModel}`);
  console.log(`  caption provider   ${p.captionProvider} (turned off IN THE CLONE from cycle 1)`);
  console.log(`  image provider     ${p.imageProvider} (turned off IN THE CLONE from cycle 1)`);
  console.log(`  cycles             ${CYCLES}`);
  console.log("");

  const sessions = await page.evaluate(async () => await window.deskrag.sessions.list());
  console.log(`${sessions.length} recordings. Each cycle re-indexes all of them and rebuilds the`);
  console.log(`graph once at the end. Expect minutes per recording per cycle.\n`);

  const baseline = await snapshot();
  console.log("BASELINE — the store as it stands");
  for (const k of baseline.keys) console.log(`  ${String(baseline.counts[k]).padStart(2)}x  ${k}`);
  console.log(`  habits: ${baseline.bindings.map((b) => `${b.slug}=${b.state}`).join(", ") || "(none)"}`);

  await page.evaluate(
    async () =>
      await window.deskrag.settings.set({
        providers: { captionProvider: "none", imageProvider: "none" },
      }),
  );

  let previous = baseline;
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    console.log(`\n--- cycle ${cycle} of ${CYCLES} -------------------------------------------`);
    const t0 = Date.now();
    await page.evaluate(async () => await window.deskrag.indexing.reindexAll());

    // The trace rebuild is the LAST job of the batch and it is what re-mines the
    // routes, so "the queue is empty" is the only correct finish line — waiting
    // on the per-session jobs alone would read the routes off the previous graph.
    await until(
      async () => {
        const q = await page.evaluate(async () => await window.deskrag.indexing.queue());
        const live = q.jobs.filter((j) => j.state === "queued" || j.state === "running");
        const running = live.find((j) => j.state === "running");
        process.stdout.write(
          `\r  ${live.length} job(s) left` +
            (running ? ` · ${running.kind} ${running.done}/${running.total} stages` : "") +
            "        ",
        );
        return live.length === 0;
      },
      { timeout: 6 * 60 * 60_000, every: 3000, label: "the re-index to drain" },
    );
    console.log(`\n  took ${Math.round((Date.now() - t0) / 1000)}s`);

    const now = await snapshot();
    const label = cycle === 1 ? "baseline -> 1 (CONFOUNDED: providers changed too)" : `${cycle - 1} -> ${cycle}`;
    const d = diffKeys(previous.keys, now.keys);

    ok(`route keys are unchanged, ${label}`, sameKeys(previous.keys, now.keys),
       d.gone.length + d.gained.length === 0 ? `${now.keys.length} routes` : "");
    for (const k of d.gone) console.log(`      GONE    ${k}`);
    for (const k of d.gained) console.log(`      GAINED  ${k}`);

    ok(
      `the route set did not GROW, ${label}`,
      now.keys.length <= previous.keys.length,
      `${previous.keys.length} -> ${now.keys.length}`,
    );

    const broken = now.bindings.filter((b) => b.state !== "exact");
    // Same trap as reflect-probe: `bindings` comes from `habits?.habits ?? []`,
    // so a DTO field rename empties it and "every kept habit still binds" passes
    // over nothing — in the one probe whose entire purpose is catching drift.
    // With no kept habit there is nothing to measure, and that is DISCLOSED
    // rather than reported as a pass.
    if (now.bindings.length === 0) {
      console.log(`  --  no kept habit to bind, ${label} — this measures nothing`);
    } else {
      ok(
        `every kept habit still binds EXACTLY, ${label}`,
        broken.length === 0,
        broken.map((b) => `${b.slug}=${b.state}`).join(", "),
      );
    }

    // Names come from a model and are EXPECTED to move. Printed, never counted.
    const renamed = now.keys.filter((k) => previous.names[k] !== undefined && previous.names[k] !== now.names[k]);
    console.log(
      `  route names that changed: ${renamed.length} of ${now.keys.length}` +
        " (expected — a name is composed by a model and nothing binds on it)",
    );
    for (const k of renamed) console.log(`      "${previous.names[k]}" -> "${now.names[k]}"`);

    previous = now;
  }

  console.log("\nSTABILITY");
  const d = diffKeys(baseline.keys, previous.keys);
  console.log(`  baseline routes    : ${baseline.keys.length}`);
  console.log(`  after ${CYCLES} cycle(s)  : ${previous.keys.length}`);
  console.log(`  keys gained        : ${d.gained.length}`);
  console.log(`  keys lost          : ${d.gone.length}`);
  console.log(
    `  habits binding     : ${previous.bindings.map((b) => `${b.slug}=${b.state}`).join(", ") || "(none)"}`,
  );
} finally {
  await app.close();
  copy.dispose();
  console.log("\nRemoved the clone.");
  summary();
}
