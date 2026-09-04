/**
 * Which baseline rule should a habit's walks be measured against, and does
 * weighting evidence by AGE change anything?
 *
 * `walk-analysis.ts` ships four — `majority`, `recent`, `none` and `weighted` —
 * and each is wrong in a way the others are not. This decides which one ships,
 * on the library that actually exists, the way `probe:routes` decides the
 * cluster rule.
 *
 * ## The half-life sweep, and why it is here rather than in a fourth constant
 *
 * `docs/research/persistence-layers.md` §4 finds that DeskRAG ranks by a RAW
 * LIFETIME TALLY in two places — `chooseBaseline`'s majority rule and
 * `edgeCost` — so a workflow walked twelve times last spring and abandoned
 * outranks one walked four times last week, forever. The correction is a
 * recency term at QUERY TIME, never a decay applied to the stored counts; that
 * distinction is the whole point and `docs/internals/persistence.md` carries
 * it.
 *
 * What is NOT settled is whether it moves anything, or what half-life to use.
 * `DEFAULT_RRF_K` is 5 rather than the published 60 because it was swept four
 * times against known answers, and a half-life picked off a paper would be the
 * 60. So both rules are swept here, and the columns that matter are the ones
 * counting DISAGREEMENT with what ships today: a sweep where nothing moves is
 * a result, and it is the result to expect on a young library.
 *
 * THE SWEEP HAS A POWER FLOOR, stated before the tables. A half-life sweep over
 * recordings that were all made inside one half-life measures nothing — every
 * weight is within a factor of two of every other — so below that span the
 * numbers are printed as a reading and the verdict is withheld, the way
 * `probe:caption` withholds its content verdict under seven scoreable frames.
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

import { openFlows } from "../lib/flows.js";
import { DB_PATH, openReadOnly } from "../lib/paths.js";
import { list } from "../lib/args.js";
import { padEnd, padStart } from "../lib/report.js";
import {
  sessionStartedAt,
  walkAnalysis,
  type BaselineRule,
} from "../../app/src/main/walk-analysis.js";
import { edgeCost, findPath } from "../../src/replay/plan.js";
import type { EdgeRecency } from "../../src/replay/types.js";
import type { TraceEdge } from "../../src/trace/types.js";

const RULES: BaselineRule[] = ["majority", "recent", "none", "weighted"];

const DAY = 86_400_000;
const HALF_LIVES = list("halflives", ["7", "14", "30", "90"])
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);

/**
 * "As of" for the whole run, read ONCE and printed.
 *
 * `chooseBaseline` and `edgeCost` both take the reference time rather than
 * reading a clock, so pinning it here is what makes two sections of this
 * output comparable with each other.
 */
const NOW = Date.now();

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dbPath = positionals[0] ?? DB_PATH;

console.log("\nStore");
console.log(`  path            : ${dbPath}`);
console.log(`  as of           : ${new Date(NOW).toISOString()}`);
console.log(`  half-lives (d)  : ${HALF_LIVES.join(", ")}`);

const db = openReadOnly(dbPath);
try {
  // BOTH resolvers, and neither is optional — `scripts/lib/flows.ts` carries
  // the two measurements that say why.
  const opened = openFlows(db);

  if (opened === null) {
    console.log("\nNo trace graph. Record a session and let indexing finish, then run this again.");
    process.exitCode = 1;
  } else {
    const { graph, routes, flows, sessionCount: totalSessions } = opened;
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

    // WHAT THE SWEEP HAS TO WORK WITH. Every weight in `weighted` is a
    // function of an age, so a library whose recordings all sit inside one
    // half-life cannot separate any two Ways: the ratio between the oldest and
    // newest vote is under 2. Said BEFORE the tables, and again beside the
    // sweep, because a reader who has seen the numbers has already believed
    // them.
    const startedAt = sessionStartedAt(flows);
    const dates = [...startedAt.values()].sort((a, b) => a - b);
    const spanDays = dates.length < 2 ? 0 : (dates.at(-1)! - dates[0]!) / DAY;
    const shortest = Math.min(...HALF_LIVES);
    const powered = spanDays >= shortest;

    console.log("\nDated span");
    console.log(`  recordings dated  : ${dates.length} of ${inGraph.size} in the graph`);
    console.log(
      `  oldest -> newest  : ${dates.length === 0 ? "—" : `${iso(dates[0]!)} -> ${iso(dates.at(-1)!)}`}`,
    );
    console.log(`  span              : ${spanDays.toFixed(1)} days`);
    if (!powered) {
      console.log(
        `\nTHE SPAN IS SHORTER THAN THE SHORTEST HALF-LIFE (${shortest}d), so every recording\n` +
          "weighs within a factor of two of every other and the sweep below CANNOT separate\n" +
          "them. It is printed as a reading; the verdict is withheld. Keep recording, or\n" +
          `re-run with a shorter half-life: npm run probe:baseline -- --halflives 1,3,7`,
      );
    }

    /** One rule's deviation totals over every route walked more than once. */
    const measure = (
      rule: BaselineRule,
      halfLifeMs?: number,
    ): { routes: number; deviantWalks: number; totalWalks: number; d: string; ways: (number | null)[] } => {
      let deviantWalks = 0;
      let totalWalks = 0;
      let skipped = 0;
      let inserted = 0;
      let reordered = 0;
      let noBaseline = 0;
      const ways: (number | null)[] = [];
      for (const route of repeated) {
        const out = walkAnalysis({
          flows,
          route,
          rule,
          now: NOW,
          ...(halfLifeMs !== undefined ? { halfLifeMs } : {}),
        });
        ways.push(out.baseline.wayIndex);
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
      return {
        routes: repeated.length - noBaseline,
        deviantWalks,
        totalWalks,
        d: `${skipped}/${inserted}/${reordered}`,
        ways,
      };
    };

    console.log("\nRules");
    console.log("  rule       routes  deviant walks  deviations (skip/ins/reorder)");
    for (const rule of RULES) {
      const m = measure(rule);
      console.log(
        `  ${padEnd(rule, 10)} ${padStart(m.routes, 6)}  ` +
          `${padStart(m.deviantWalks, 6)}/${padEnd(m.totalWalks, 6)}  ${m.d}`,
      );
    }

    // THE COLUMN THAT MATTERS IS `moved`. Deviation totals shift for many
    // reasons; what decides whether a recency term is worth shipping is
    // whether it picks a DIFFERENT standard from the rule that ships today.
    // Zero across the sweep is the expected answer on a young library and is
    // a finding, not a failed run.
    const base = measure("majority");
    console.log(`\nHalf-life sweep (weighted)${powered ? "" : " — READING ONLY, span too short"}`);
    console.log("  half-life  routes  deviant walks  deviations     moved vs majority");
    for (const days of HALF_LIVES) {
      const m = measure("weighted", days * DAY);
      const moved = m.ways.filter((w, i) => w !== base.ways[i]).length;
      console.log(
        `  ${padEnd(`${days}d`, 9)} ${padStart(m.routes, 6)}  ` +
          `${padStart(m.deviantWalks, 6)}/${padEnd(m.totalWalks, 6)}  ${padEnd(m.d, 13)}  ` +
          `${moved} of ${repeated.length}`,
      );
    }

    // THE OTHER SEAM. `edgeCost` ranks paths by the same raw tally, and
    // `findPath` is what reads it. The executor has no UI, so nothing here can
    // change what the app does today — which is exactly why it needs measuring
    // before anything is wired to it.
    const recencyAt = (halfLifeMs: number): EdgeRecency => ({
      startedAt: (id) => startedAt.get(id) ?? null,
      now: NOW,
      halfLifeMs,
    });
    const ends = repeated.flatMap((route) => {
      const from = route.nodeIds[0];
      const to = route.nodeIds.at(-1);
      return from !== undefined && to !== undefined && from !== to ? [{ from, to }] : [];
    });
    console.log(`\nPath costs (findPath over ${ends.length} route endpoints)`);
    if (ends.length === 0) {
      console.log("  no route spans two distinct nodes, so there is no path to choose.");
    } else {
      const pathOf = (from: string, to: string, r?: EdgeRecency) => findPath(graph, from, to, r) ?? [];
      const key = (p: readonly { id: string }[]): string => p.map((e) => e.id).join(">");
      /** What a path costs under the SHIPPED function, recency ignored. */
      const plainCost = (p: readonly TraceEdge[]): number =>
        p.reduce((n, e) => n + edgeCost(e), 0);
      const plain = ends.map(({ from, to }) => pathOf(from, to));

      // A CHANGED PATH IS NOT AUTOMATICALLY A PREFERENCE. Measured on the real
      // store the first time this ran: both candidate first edges had
      // `observations: 1`, so they cost EXACTLY the same and Dijkstra was
      // picking between them by iteration order. Recency then broke the tie by
      // date — a real improvement over insertion order, and nothing at all to
      // do with preferring recent evidence over plentiful evidence. Counting
      // that as "1 of 1 paths changed" would have published a 100% hit rate for
      // an effect that was not being exercised. So the two are separated: a
      // change is an OVERRIDE only when the path recency chose is strictly
      // more expensive under the shipped cost.
      console.log("  half-life  changed   of which tiebreaks   real overrides");
      for (const days of HALF_LIVES) {
        let tiebreak = 0;
        let override = 0;
        ends.forEach(({ from, to }, i) => {
          const swept = pathOf(from, to, recencyAt(days * DAY));
          if (key(swept) === key(plain[i]!)) return;
          // Same cost under the shipped function: the tally never preferred
          // one of these, so nothing was overridden.
          if (Math.abs(plainCost(swept) - plainCost(plain[i]!)) < 1e-9) tiebreak += 1;
          else override += 1;
        });
        console.log(
          `  ${padEnd(`${days}d`, 9)}  ${padStart(tiebreak + override, 7)}   ` +
            `${padStart(tiebreak, 17)}   ${padStart(override, 13)}`,
        );
      }
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
