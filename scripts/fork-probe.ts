/**
 * Where do a habit's ways actually fork, on the library that exists?
 *
 * `test/way-fork.test.ts` proves the fold. It cannot tell you the fold produces
 * a READING — a spine of length 0 is a legal fold result and a useless picture,
 * and that is precisely how the prefix/suffix design was falsified: Way C
 * begins at `n0 — no state`, so the common PREFIX across the four real ways is
 * empty. This prints what the real store folds to.
 *
 * READ-ONLY, and HEADLESS for `probe:baseline`'s reason: DeskRAGApp takes no
 * single-instance lock and WRITES on startup, so launching it would make a
 * second owner of SQLite and LanceDB. It opens `app.db` readonly and never
 * through `DualStore`, which drops retired vector spaces on open.
 *
 * It PRINTS THE CORPUS BEFORE ANY READING (the `probe:habits` precedent) and
 * exits non-zero when no route has more than one way — there is no fork to
 * measure there and the output would be an empty table wearing a verdict.
 *
 * Run:  npm run probe:fork
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { DEFAULT_DB, readGraph } from "./lib/read-store.js";
import { frequentRoutes, toGraphDTO } from "../app/src/main/graph-view.js";
import { runPhrase, secs, wayFork, type WayFork } from "../app/src/main/way-fork.js";
import type { FlowRouteDTO, FlowsDTO } from "@shared/types";

const dbPath = process.argv[2] ?? DEFAULT_DB;
if (!existsSync(dbPath)) {
  console.error(`No store at ${dbPath}`);
  process.exit(1);
}

console.log("\nStore");
console.log(`  path : ${dbPath}`);

const db = new Database(dbPath, { readonly: true });
try {
  const graphIds = (db.prepare("SELECT id FROM trace_graph").all() as { id: string }[]).map(
    (r) => r.id,
  );
  const graph = readGraph(db, graphIds[0] ?? "default");
  if (graph === undefined) {
    console.log("\nNo trace graph. Record a session, let indexing finish, and run this again.");
    process.exit(1);
  }

  // The resolver is not optional. Without it `toEdgeSources` flatMaps away
  // every source whose session it cannot date, so every walk arrives undated
  // and every printed duration is missing — the defect `probe:baseline` shipped
  // with until 2026-08-23.
  const startedAt = new Map(
    (
      db.prepare("SELECT id, started_at FROM session").all() as {
        id: string;
        started_at: number;
      }[]
    ).map((r) => [r.id, r.started_at]),
  );
  // AND the lane origin, for a reason measured on 2026-08-23: without it this
  // probe read Way C at 28.1s where the screen read 26.6s. `laneSec` clamps at
  // zero, so a walk beginning before its video's first frame has its `atSec`
  // pulled to 0 while its `throughSec` is not — the app's span is the LANE span
  // and this one was the raw t_mono span. Two readers of one store disagreeing
  // by 1.5s is the `ax-dump`/`ax-exec` drift hazard in the instrument. The
  // origin is what `laneOriginOf` returns: the earliest `screen` blob's start,
  // or 0 for a recording with no video.
  const origin = new Map(
    (
      db
        .prepare(
          `SELECT s.id AS id,
                  (SELECT b.t_mono_start FROM blob b
                    WHERE b.session_id = s.id AND b.media = 'screen'
                    ORDER BY b.t_mono_start ASC LIMIT 1) AS t
             FROM session s`,
        )
        .all() as { id: string; t: number | null }[]
    ).map((r) => [r.id, r.t ?? 0]),
  );
  const routes = frequentRoutes(
    graph,
    undefined,
    undefined,
    (sessionId) => origin.get(sessionId) ?? 0,
  );
  const flows: FlowsDTO = {
    graph: toGraphDTO(graph, {
      sessionStart: (id) => startedAt.get(id),
      laneOrigin: (id) => origin.get(id) ?? 0,
    }),
    routes,
    excludedApps: [],
  };

  const forked: { route: FlowRouteDTO; fork: WayFork }[] = [];
  for (const route of routes) {
    const fork = wayFork({ flows, route });
    if (fork !== null) forked.push({ route, fork });
  }

  console.log("\nCorpus");
  console.log(
    `  recordings          : ${(db.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n}`,
  );
  console.log(`  routes              : ${routes.length}`);
  console.log(`  routes with 2+ ways : ${forked.length}`);

  if (forked.length === 0) {
    console.log(
      "\nNO ROUTE HAS MORE THAN ONE WAY, so there is no fork to measure. Record the same\n" +
        "task again, taking a different path through it, and run this again.",
    );
    process.exit(1);
  }

  for (const { route, fork } of forked) {
    console.log(`\n=== ${route.name ?? route.label}`);
    for (const w of fork.ways) {
      const times = w.totalsMs.length === 0 ? "no timed recording" : w.totalsMs.map(secs).join(", ");
      console.log(
        `  Way ${w.letter} — ${w.steps} steps, ${w.sessionIds.length} recording(s), ${times}`,
      );
    }
    const spine = fork.rows.filter((r) => r.kind === "spine").length;
    console.log(`  spine: ${spine} step(s) shared by every way`);
    let n = 0;
    for (const row of fork.rows) {
      if (row.kind === "spine") {
        n += 1;
        console.log(`   ${String(n).padStart(2)}. ${row.from} → ${row.to}`);
        continue;
      }
      for (const run of row.runs) {
        if (run.steps.length === 0) continue;
        const letter = fork.ways.find((w) => w.wayIndex === run.wayIndex)?.letter ?? "?";
        console.log(`       Way ${letter}: ${runPhrase(run, row.after)}`);
      }
    }
    console.log(
      `  verdict: ${
        fork.verdict.kind === "named" ? fork.verdict.text : `withheld — ${fork.verdict.reason}`
      }`,
    );
    if (spine === 0) {
      console.log("  FINDING: the ways share NO place-step. The picture here is disjoint lists.");
    }
  }
} finally {
  db.close();
}
