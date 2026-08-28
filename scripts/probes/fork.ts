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

import { openFlows } from "../lib/flows.js";
import { DB_PATH, openReadOnly } from "../lib/paths.js";
import { runPhrase, secs, wayFork, type WayFork } from "../../app/src/main/way-fork.js";
import type { FlowRouteDTO } from "@shared/types";

const dbPath = process.argv[2] ?? DB_PATH;

console.log("\nStore");
console.log(`  path : ${dbPath}`);

const db = openReadOnly(dbPath);
try {
  // BOTH resolvers, and NEITHER is optional — `scripts/lib/flows.ts` carries
  // the two measurements that say why, including the one taken here: without
  // the lane origin this probe read Way C at 28.1s where the screen read 26.6s.
  const opened = openFlows(db);
  if (opened === null) {
    console.log("\nNo trace graph. Record a session, let indexing finish, and run this again.");
    process.exit(1);
  }
  const { graph, routes, flows } = opened;

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
