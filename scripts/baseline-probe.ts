/**
 * Which baseline rule should a habit's walks be measured against?
 *
 * `walk-analysis.ts` ships three — `majority`, `recent` and `none` — and each is
 * wrong in a way the others are not. This decides which one ships, on the
 * library that actually exists, the way `probe:routes` decides the cluster rule.
 *
 * READ-ONLY, and HEADLESS on purpose. It opens `app.db` with better-sqlite3 in
 * `readonly` mode and marshals the `trace_*` tables into a `Graph`. It never
 * launches the app: DeskRAGApp takes no single-instance lock, so a second
 * instance against the same data dir is a SECOND OWNER of SQLite and LanceDB —
 * and it writes on startup (`adoptUnclosedSessions`, the index worker). It also
 * never opens the store through `DualStore`, which drops retired vector spaces
 * on open. Reading rows is the only way in here that cannot change what it is
 * measuring.
 *
 * It calls the app's own `frequentRoutes`, `toGraphDTO` and `walkAnalysis` —
 * there is no second implementation of anything with a JUDGEMENT in it, so what
 * is compared below is what ships.
 *
 * It PRINTS THE LIBRARY IT FOUND BEFORE JUDGING ANYTHING (the `probe:habits`
 * precedent). A verdict drawn from two recordings is not a verdict.
 *
 * Run:  npm run probe:baseline
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { DEFAULT_DB, readGraph } from "./lib/read-store.js";
import { frequentRoutes, toGraphDTO } from "../app/src/main/graph-view.js";
import { walkAnalysis, type BaselineRule } from "../app/src/main/walk-analysis.js";
import type { FlowsDTO } from "@shared/types";

const RULES: BaselineRule[] = ["majority", "recent", "none"];

const dbPath = process.argv[2] ?? DEFAULT_DB;
if (!existsSync(dbPath)) {
  console.error(`No store at ${dbPath}`);
  process.exit(1);
}

console.log("\nStore");
console.log(`  path            : ${dbPath}`);

const db = new Database(dbPath, { readonly: true });
try {
  const graphIds = (db.prepare("SELECT id FROM trace_graph").all() as { id: string }[]).map(
    (r) => r.id,
  );
  const graph = readGraph(db, graphIds[0] ?? "default");
  const totalSessions = (db.prepare("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n;

  if (graph === undefined) {
    console.log("\nNo trace graph. Record a session and let indexing finish, then run this again.");
    process.exitCode = 1;
  } else {
    // AND the lane origin, the same resolver `DeskRagService.flows()` passes.
    // `laneSec` clamps at zero, so a walk beginning before its video's first
    // frame has its `atSec` pulled to 0 while its `throughSec` is not — without
    // this the probe reads the raw t_mono span where the app reads the lane
    // span, and the two disagree about when a recording walked a route.
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
    // WITHOUT this resolver `toEdgeSources` drops EVERY source — it flatMaps
    // away any whose session it cannot date — so every edge arrives with
    // `sources: []` and every `firstAt` is null. It read that way until
    // 2026-08-23, and it was NOT only the "Other readings" section: measured on
    // the real store, adding the resolver moved the deviation table itself from
    // 14/20 to 12/22, because a walk with no date cannot be ordered and the
    // baseline lands somewhere else. The rule that ships was unchanged — both
    // `majority` and `recent` still call 3 of 4 walks deviant, still by tiebreak
    // — but every count printed before this date was against an empty graph.
    const startedAt = new Map(
      (
        db.prepare("SELECT id, started_at FROM session").all() as {
          id: string;
          started_at: number;
        }[]
      ).map((r) => [r.id, r.started_at]),
    );
    const flows: FlowsDTO = {
      graph: toGraphDTO(graph, {
        sessionStart: (id) => startedAt.get(id),
        laneOrigin: (id) => origin.get(id) ?? 0,
      }),
      routes,
      excludedApps: [],
    };
    const repeated = routes.filter((r) => r.walks.length > 1);
    const inGraph = new Set(routes.flatMap((r) => r.sessionIds));

    console.log("\nCorpus");
    console.log(`  recordings        : ${totalSessions}`);
    console.log(`  in the graph      : ${inGraph.size}`);
    console.log(`  routes            : ${routes.length}`);
    console.log(`  walked 2+ times   : ${repeated.length}`);

    // A rule can only be COMPARED on a route several recordings walked. Said
    // before the table, not after it, because a reader who sees numbers first
    // has already believed them.
    if (repeated.length === 0) {
      console.log(
        "\nNO ROUTE WAS WALKED MORE THAN ONCE, so all three rules are identical here and\n" +
          "nothing below is a measurement. Record the same task again and re-run.",
      );
      process.exitCode = 1;
    } else if (repeated.length < 3) {
      console.log(
        `\nONLY ${repeated.length} ROUTE${repeated.length === 1 ? " WAS" : "S WERE"} WALKED MORE ` +
          `THAN ONCE. The table below is an observation, not a verdict.`,
      );
    }

    console.log("\nRules");
    console.log("  rule       routes  deviant walks  deviations (skip/ins/reorder)");
    for (const rule of RULES) {
      let deviantWalks = 0;
      let totalWalks = 0;
      let skipped = 0;
      let inserted = 0;
      let reordered = 0;
      let noBaseline = 0;
      for (const route of repeated) {
        const out = walkAnalysis({ flows, route, rule });
        if (out.baseline.wayIndex === null) noBaseline += 1;
        for (const w of out.walks) {
          totalWalks += 1;
          if (w.deviations.length > 0) deviantWalks += 1;
          for (const d of w.deviations) {
            if (d.kind === "skipped") skipped += 1;
            else if (d.kind === "inserted") inserted += 1;
            else reordered += 1;
          }
        }
      }
      console.log(
        `  ${rule.padEnd(10)} ${String(repeated.length - noBaseline).padStart(6)}  ` +
          `${String(deviantWalks).padStart(6)}/${String(totalWalks).padEnd(6)}  ` +
          `${skipped}/${inserted}/${reordered}`,
      );
    }

    // THE FRAGILITY THAT MATTERS. Under `majority` a tie means the tiebreak is
    // carrying the whole decision, and a standard chosen that way is one more
    // recording away from moving. Cross-re-index stability is a different
    // question and belongs to probe:stability, which re-mines against a clone —
    // a read-only headless probe cannot answer it.
    const byTiebreak = repeated.filter((route) =>
      walkAnalysis({ flows, route, rule: "majority" }).baseline.reason.includes("tie at"),
    );
    console.log("\nFragility (majority)");
    console.log(`  chosen by tiebreak: ${byTiebreak.length} of ${repeated.length}`);
    for (const route of byTiebreak.slice(0, 5)) {
      console.log(`    ${route.name ?? route.label}`);
    }

    console.log("\nOther readings (majority)");
    let withAntecedents = 0;
    let withPrefix = 0;
    let dropped = 0;
    for (const route of repeated) {
      const out = walkAnalysis({ flows, route });
      if (out.antecedents.length > 0) withAntecedents += 1;
      if (out.droppedEarly.length > 0) {
        withPrefix += 1;
        dropped += out.droppedEarly.reduce((n, p) => n + p.count, 0);
      }
    }
    console.log(`  routes with a prefix route : ${withPrefix}`);
    console.log(`  recordings that dropped early: ${dropped}`);
    // Zero is EXPECTED here and says so, because this probe passes no hook —
    // antecedents need the focus stream, which lives in DeskRagService.
    console.log(
      `  routes with antecedents    : ${withAntecedents} (0 is expected: this probe passes no hook)`,
    );
    console.log("");
  }
} finally {
  db.close();
}
