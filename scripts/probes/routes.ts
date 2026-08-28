/**
 * Which mining rule turns many recordings into the right number of routes?
 *
 * `frequentRoutes` keys a route on its de-duplicated place-label sequence and
 * groups by EXACT string equality, so the same task recorded once more through
 * one extra application lands as two routes of ×1 and neither ever looks like a
 * habit. `app/src/main/route-cluster.ts` can merge those; this decides whether
 * it should, and under which rule, on the library that actually exists.
 *
 * READ-ONLY, and HEADLESS on purpose. It opens `app.db` with better-sqlite3 in
 * `readonly` mode, marshals the five `trace_*` tables into a `Graph`, and calls
 * the app's own `frequentRoutes` and `labelNode`. It never launches the app:
 * DeskRAGApp takes no single-instance lock, so a second instance against the
 * same data dir is a SECOND OWNER of SQLite and LanceDB — and it writes on
 * startup (`adoptUnclosedSessions`, the index worker). It also never opens the
 * store through `DualStore`, which drops retired vector spaces on open. Reading
 * rows is the only way in here that cannot change what it is measuring.
 *
 * The marshalling lives in `scripts/lib/read-store.ts` and the projection in
 * `scripts/lib/flows.ts`, shared with the other three graph probes. Both are
 * deliberately dumb — JSON columns parsed, sources grouped — so that everything
 * with a JUDGEMENT in it (what a place is, where a route starts and ends, which
 * routes are one) stays in the single implementation the app runs.
 *
 * It PRINTS THE LIBRARY IT FOUND BEFORE JUDGING ANYTHING (the `probe:habits`
 * precedent). A verdict drawn from two recordings is not a verdict, and the
 * numbers quoted in `graph-view.ts` came from a nine-recording store that no
 * longer exists — so the corpus is the first thing on screen.
 *
 * Run:  npm run probe:routes
 */

import { openFlows } from "../lib/flows.js";
import { DB_PATH, openReadOnly } from "../lib/paths.js";
import { pct } from "../lib/report.js";
import {
  DEFAULT_CLUSTER_RULE,
  insertionGap,
  jaccard,
  lcsRatio,
  type ClusterRule,
} from "../../app/src/main/route-cluster.js";

/**
 * The rules to compare.
 *
 * WHICH ONE SHIPS IS READ FROM THE CODE, NEVER TYPED HERE. This table used to
 * label `exact` "(today)" — and `DEFAULT_CLUSTER_RULE` has been
 * `{ insertions, budget: 2 }` since the commit that wrote the label. So the row
 * presented as the baseline was a rule the app has never used, and the row that
 * IS the app appeared as a candidate: on the real store that is the difference
 * between 6 routes and 5, which is also why `probe:transfer` (which calls the
 * shipped default) and this probe disagreed about how many routes exist.
 */
const RULES: { name: string; rule: ClusterRule }[] = [
  { name: "exact", rule: { kind: "exact" } },
  { name: "insertions ≤1", rule: { kind: "insertions", budget: 1 } },
  { name: "insertions ≤2", rule: { kind: "insertions", budget: 2 } },
  { name: "lcs ≥0.80", rule: { kind: "lcs", min: 0.8 } },
  { name: "lcs ≥0.60", rule: { kind: "lcs", min: 0.6 } },
  { name: "jaccard ≥0.80", rule: { kind: "jaccard", min: 0.8 } },
];

/** Marks the row the app actually runs, by comparing against the export. */
const shipped = (rule: ClusterRule): boolean =>
  JSON.stringify(rule) === JSON.stringify(DEFAULT_CLUSTER_RULE);

const dbPath = process.argv[2] ?? DB_PATH;

console.log("\nStore");
console.log(`  path            : ${dbPath}`);

const db = openReadOnly(dbPath);
try {
  // The app's own projection, called ONCE PER RULE — no second implementation
  // of the mining anywhere in here, so what is compared below is what ships.
  // `covering` is left at its default: this probe measures GROUPING, and a
  // route's NAME is a separate majority vote that never reaches the key.
  const under = (rule: ClusterRule) => openFlows(db, { rule });
  // Read UNCLUSTERED, so the raw picture below is the routes before any rule
  // merged them — that is what the distance table has to sit in.
  const opened = under({ kind: "exact" });

  if (opened === null) {
    console.log("\nNo trace graph. Record a session and let indexing finish, then run this again.");
    process.exitCode = 1;
  } else {
    const { graph, routes, sessionCount: totalSessions } = opened;
    const sessions = new Set(routes.flatMap((r) => r.sessionIds));

    console.log("\nCorpus");
    console.log(`  recordings      : ${totalSessions}`);
    console.log(`  in the graph    : ${sessions.size}`);
    console.log(`  nodes / edges   : ${graph.nodes.length} / ${graph.edges.length}`);
    console.log(`  routes (exact)  : ${routes.length}`);

    if (sessions.size < 4) {
      console.log(
        `\n  ⚠ ${sessions.size} recordings is not a corpus. Nothing below is a measurement —\n` +
          `    it is a demonstration that the code runs.`,
      );
    }

    const shapes = routes.map((r) => ({
      key: r.id,
      places: r.id.split(" → "),
      count: r.count,
    }));
    const singles = shapes.filter((s) => s.count === 1).length;

    console.log("\nRoutes UNCLUSTERED (rule: exact) — the raw picture");
    for (const s of shapes) {
      console.log(`  ×${String(s.count).padEnd(3)} ${String(s.places.length).padStart(2)} hops  ${s.key}`);
    }
    console.log(`  walked once     : ${singles}/${shapes.length} (${pct(singles, shapes.length)})`);

    console.log("\nPairwise distance (the distribution the rule has to sit in)");
    let pairs = 0;
    for (let i = 0; i < shapes.length; i += 1) {
      for (let j = i + 1; j < shapes.length; j += 1) {
        const a = shapes[i]!;
        const b = shapes[j]!;
        const gap = insertionGap(a.places, b.places);
        // Only the near ones are worth printing: a library of N routes has
        // N²/2 pairs and almost all of them are unrelated work.
        const near = gap !== null || lcsRatio(a.places, b.places) >= 0.5;
        if (near) {
          console.log(
            `  ${String(a.places.length).padStart(2)}v${String(b.places.length).padEnd(2)} ` +
              `insert=${gap === null ? " — " : `+${gap} `} ` +
              `lcs=${lcsRatio(a.places, b.places).toFixed(2)} ` +
              `jac=${jaccard(a.places, b.places).toFixed(2)}\n` +
              `        A: ${a.key}\n        B: ${b.key}`,
          );
        }
        pairs += 1;
      }
    }
    if (pairs === 0) console.log("  (fewer than two routes — nothing to compare)");

    console.log("\nRule comparison");
    console.log("  rule                  routes  merged  ×≥2  walked-once  partition");
    for (const { name, rule } of RULES) {
      const out = under(rule)!.routes;
      const merged = out.filter((r) => r.variants.length > 0).length;
      const repeated = out.filter((r) => r.count >= 2).length;
      const alone = out.filter((r) => r.count === 1).length;

      // The invariant that keeps `bindHabit`'s majority rule a proof rather
      // than a threshold: every recording in exactly one route. Structural —
      // but a rule that broke it must be visible here rather than inferred.
      const seen = out.flatMap((r) => r.sessionIds);
      const partition = new Set(seen).size === seen.length && seen.length === sessions.size;

      console.log(
        `  ${(shipped(rule) ? `${name} (today)` : name).padEnd(21)} ` +
          `${String(out.length).padStart(6)}  ` +
          `${String(merged).padStart(6)}  ${String(repeated).padStart(3)}  ` +
          `${String(alone).padStart(11)}  ${partition ? "ok" : "BROKEN"}`,
      );
      if (!partition) process.exitCode = 1;
    }

    for (const { name, rule } of RULES.slice(1)) {
      const changed = under(rule)!.routes.filter((r) => r.variants.length > 0);
      if (changed.length === 0) continue;
      console.log(`\nWhat \`${name}\` merges`);
      for (const route of changed) {
        console.log(`  ×${route.count}  ${route.id}`);
        for (const v of route.variants) {
          console.log(
            `        + ${v.count} recording(s), ${
              v.extraHops < 0 ? "not a containment" : `+${v.extraHops} hops`
            }: ${v.key}`,
          );
        }
      }
    }
  }
} finally {
  db.close();
}
