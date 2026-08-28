/**
 * Does a kept habit transfer to a recording it was NOT built from?
 *
 * This is the decisive question about a habit and the one nothing here has ever
 * answered. Extraction is easy; a route that only resolves against the recording
 * it came from is a memory of one event, not a procedure. Answering it live
 * would mean arranging the other screen by hand — but every recording already
 * holds a sequence of real AX trees, so a recording can BE the other screen.
 *
 * ## What it measures
 *
 * For each node on the habit's route, in order, it scans FORWARD through the
 * held-out recording for the first moment that VERIFIES that node — the same
 * subset rule the executor uses (`verifyNode`: every predicate the node claims
 * must still hold; extras are not violations). The scan is monotone: a node may
 * only match at or after the moment the previous one did, because a route is an
 * order, not a set. Where the scan runs out, the route stopped transferring, and
 * that position is reported rather than a score.
 *
 * Each edge between two verified nodes is then put through `resolveAnchor`
 * against the moment its source node verified at, which is the executor's own
 * question: could this action be aimed at anything on that screen?
 *
 * ## The CONTROL is the point
 *
 * Every habit is also run against recordings of DIFFERENT work. A transfer test
 * that can only say yes measures nothing — a permissive resolver would report
 * 100% and look like success. The number that matters is the gap between the
 * two, and both are printed.
 *
 * ## Read-only, twice over
 *
 * SQLite is opened `readonly`, `DualStore` is never opened (it drops retired
 * vector spaces, and the app takes no single-instance lock), `executeRun` is
 * never called so there is no `arm` to get wrong, and the actuator is wrapped in
 * the same read-only proxy `scripts/replay-probe.mjs` uses — belt and braces,
 * because `StoredActuator`'s own refusals are a statement about recorded worlds,
 * not a safety story.
 *
 * Run:  npm run probe:transfer
 */

// THE SAME re-resolution the app performs, never a second copy of it. A route's
// key is its place-label sequence, so every rebuild re-keys everything and a
// habit's STORED key goes stale by design — `bindHabit` finds it again by
// strict-majority session overlap. Matching the raw key here reported every kept
// habit as orphaned the first time a rebuild moved the keys, which reads as the
// habit being broken rather than as this probe not asking the question the app
// asks.
import { bindHabit } from "../../app/src/main/habit-bind.js";
import { StoredActuator } from "../../app/src/main/stored-actuator.js";
import { focusContext } from "../../src/trace/lift.js";
import { verifyNode } from "../../src/replay/verify.js";
import { resolveAnchor } from "../../src/replay/resolve.js";
import { predicatesOf, windowOriginOf } from "../../src/replay/observe.js";
import type { Actuator, AxObservation } from "../../src/replay/types.js";
import type { Anchor, TraceEvent, UIElement } from "../../src/trace/types.js";
import { flag } from "../lib/args.js";
import { openFlows } from "../lib/flows.js";
import { DB_PATH, openReadOnly } from "../lib/paths.js";

/** Every mutating Actuator method, blocked — `probes/replay.ts`, verbatim. */
const MUTATORS = ["activate", "moveTo", "click", "dragPath", "scroll", "key"];

function readOnly(actuator: Actuator): Actuator {
  return new Proxy(actuator, {
    get(target, prop, recv) {
      if (MUTATORS.includes(String(prop))) {
        return () => {
          throw new Error(`transfer-probe is read-only: refused ${String(prop)}()`);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Actuator;
}

/**
 * `--why` explains every anchor that came back point-only.
 *
 * Off by default because the distinction it draws only matters once you are
 * asking about a specific route, and on by name because "17 of 25" is a number
 * you cannot act on without knowing which 8 and why.
 */
const WHY = flag("why");
const dbPath = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? DB_PATH;
const db = openReadOnly(dbPath);

try {
  // The shipped clustering rule and BOTH resolvers — `scripts/lib/flows.ts`.
  // This probe used to call `frequentRoutes(graph)` bare, which took the
  // shipped rule but no `sessionStart` and no `laneOrigin`, so every edge
  // source arrived undated. Nothing it reports is dated, so the counts did not
  // move; going through the shared projection is what stops that from being
  // luck the next time one of them starts to matter.
  const opened = openFlows(db);
  if (opened === null) {
    console.log("No trace graph. Record and index some sessions first.");
    process.exit(1);
  }
  const { graph, routes } = opened;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));

  // --- the recordings, as sequences of observations -----------------------
  //
  // `ax_snapshot` stores elements and NOTHING ELSE — no app name, no URL — so a
  // stored observation is only comparable to a node's predicates if it resolves
  // those two facts exactly as lift did. `focusContext` is exported from
  // `lift.ts` for this, rather than reimplemented here, because it carries a
  // rule that is easy to miss: a `focus_change` RESETS the url.
  const sessionIds = (
    db.prepare("SELECT id FROM session ORDER BY started_at ASC").all() as { id: string }[]
  ).map((r) => r.id);

  const momentsOf = new Map<string, AxObservation[]>();
  for (const sid of sessionIds) {
    const events = (
      db
        .prepare("SELECT kind, t_mono, data FROM event WHERE session_id = ? ORDER BY t_mono ASC")
        .all(sid) as { kind: string; t_mono: number; data: string | null }[]
    ).map((r) => ({
      kind: r.kind,
      tMono: r.t_mono,
      data: r.data === null ? null : JSON.parse(r.data),
    })) as TraceEvent[];

    const snaps = db
      .prepare("SELECT t_mono, elements FROM ax_snapshot WHERE session_id = ? ORDER BY t_mono ASC")
      .all(sid) as { t_mono: number; elements: string }[];

    momentsOf.set(
      sid,
      snaps.map((s) => {
        const ctx = focusContext(s.t_mono, events);
        return {
          elements: JSON.parse(s.elements) as UIElement[],
          ...(ctx.app !== undefined ? { app: ctx.app } : {}),
          ...(ctx.windowTitle !== undefined ? { windowTitle: ctx.windowTitle } : {}),
          ...(ctx.url !== undefined ? { url: ctx.url } : {}),
        };
      }),
    );
  }

  /** The node sequence a walk passes through. */
  const nodesOf = (edgeIds: readonly string[]): string[] => {
    const out: string[] = [];
    for (const id of edgeIds) {
      const e = edgeById.get(id);
      if (e === undefined) continue;
      if (out.length === 0) out.push(e.from);
      out.push(e.to);
    }
    return out;
  };

  interface Outcome {
    verified: number;
    total: number;
    /**
     * States that verified against ANY screen, because they claim nothing.
     *
     * A zero-predicate node is vacuously a subset of every observation, so it
     * verifies against a recording of completely different work. `locateNode`
     * already refuses such a node as a candidate for exactly this reason; a
     * transfer count that included them would credit the route for states no
     * recording could fail. They are disclosed, never counted.
     */
    vacuous: number;
    /**
     * Verified states identified ONLY by which application was in front.
     *
     * Real, but weak: an agent can confirm it arrived in one and cannot find it
     * on screen. The same distinction `cautionsFor` already draws in the file.
     */
    appOnly: number;
    stoppedAt: string | null;
    anchorsResolved: number;
    anchorsTotal: number;
    /**
     * Anchors that carry no AX descriptors at all.
     *
     * NOT a failure, and conflating them with one understates every route.
     * `buildPlan` says so itself where it decides to cut: "a point-only anchor
     * is already at its permanent best and cannot be improved by waiting". A
     * Dock click is the canonical case — the target sits outside the focused
     * window's tree by definition.
     */
    pointOnly: number;
    /** Carried descriptors and still reached no AX rung. The real failures. */
    unresolved: number;
    moments: number;
  }

  async function attempt(walkEdgeIds: readonly string[], sessionId: string): Promise<Outcome> {
    const moments = momentsOf.get(sessionId) ?? [];
    const actuator = readOnly(new StoredActuator(moments));
    const stored = actuator as unknown as StoredActuator;
    const nodeIds = nodesOf(walkEdgeIds);

    const predsAt = moments.map((m) => predicatesOf(m));

    let cursor = 0;
    let verified = 0;
    let vacuous = 0;
    let appOnly = 0;
    let stoppedAt: string | null = null;
    let anchorsResolved = 0;
    let anchorsTotal = 0;
    /** Anchors carrying NO descriptors — a point is their permanent best. */
    let pointOnly = 0;
    /** Anchors that DID carry descriptors and still reached no AX rung. */
    let unresolved = 0;

    for (let i = 0; i < nodeIds.length; i += 1) {
      const node = nodeById.get(nodeIds[i]!);
      if (node === undefined) continue;
      if (node.predicates.length === 0) {
        // Claims nothing, so it cannot fail. Counted apart from the score.
        vacuous += 1;
        continue;
      }
      // MONOTONE: a route is an order, not a set. Allowing a later node to match
      // an earlier moment would report a recording as "the same procedure"
      // because it happened to contain the same states in any sequence at all.
      let hit = -1;
      for (let m = cursor; m < moments.length; m += 1) {
        if (verifyNode(node.predicates, predsAt[m]!).satisfied) {
          hit = m;
          break;
        }
      }
      if (hit < 0) {
        stoppedAt = node.id;
        break;
      }
      verified += 1;
      if (node.predicates.every((p) => p.kind === "app")) appOnly += 1;
      cursor = hit;
      stored.seek(hit);

      // The edge LEAVING this node, aimed at the screen this node verified on.
      const edge = edgeById.get(walkEdgeIds[i] ?? "");
      if (edge !== undefined) {
        for (const action of edge.actions) {
          const anchor = (action as { anchor?: Anchor }).anchor;
          if (anchor === undefined) continue;
          anchorsTotal += 1;
          const origin = windowOriginOf(moments[hit]!);
          const r = await resolveAnchor(anchor, (d) => actuator.locate(d), {
            ...(origin !== undefined ? { windowOrigin: origin } : {}),
          });
          if (r.layer !== "point") anchorsResolved += 1;
          else if (anchor.ax === undefined) pointOnly += 1;
          else unresolved += 1;
          if (WHY && r.layer === "point") {
            console.log(
              `      ${action.kind} on ${node.id.split(":").pop()} -> point` +
                (anchor.ax === undefined
                  ? "   POINT-ONLY BY CONSTRUCTION (no descriptors; already at its best)"
                  : `\n        descriptors : ${JSON.stringify(anchor.ax)}` +
                    `\n        attempts    : ${
                      r.attempts.map((a) => `${a.layer}: ${a.rejected}`).join(" | ") ||
                      "(no rung tried)"
                    }`),
            );
          }
        }
      }
    }

    return {
      verified,
      // Only states that CAN fail. A vacuous node in the denominator would make
      // every route look closer to transferring than it is.
      total: nodeIds.filter((id) => (nodeById.get(id)?.predicates.length ?? 0) > 0).length,
      vacuous,
      appOnly,
      stoppedAt,
      anchorsResolved,
      anchorsTotal,
      pointOnly,
      unresolved,
      moments: moments.length,
    };
  }

  /** Held-out and control totals, summed over every attempt. */
  interface Tally {
    attempts: number;
    whole: number;
    verified: number;
    states: number;
    anchorsResolved: number;
    /** Anchors carrying descriptors — the only ones that CAN reach an AX rung. */
    anchorsClaiming: number;
  }
  const tally = (): Tally => ({
    attempts: 0,
    whole: 0,
    verified: 0,
    states: 0,
    anchorsResolved: 0,
    anchorsClaiming: 0,
  });
  const add = (t: Tally, o: Outcome): void => {
    t.attempts += 1;
    if (o.stoppedAt === null) t.whole += 1;
    t.verified += o.verified;
    t.states += o.total;
    t.anchorsResolved += o.anchorsResolved;
    t.anchorsClaiming += o.anchorsTotal - o.pointOnly;
  };
  const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d);
  const pct = (n: number, d: number): string =>
    d === 0 ? "n/a" : `${Math.round(rate(n, d) * 100)}%`;
  const heldOut = tally();
  const control = tally();

  // --- the kept habits ----------------------------------------------------
  //
  // Read WITH the dismissals, because coverage is a question about answered
  // routes and a dismissal is an answer. Dropping them would report a route the
  // user explicitly declined as a gap in the library, which is the opposite of
  // what it is.
  interface HabitRow {
    id: string;
    state: string;
    doc: {
      slug: string;
      binding: { routeKey: string; routeLabel: string; sessionIds: string[]; boundAt: number };
    };
  }
  const allHabits: HabitRow[] = (
    db.prepare("SELECT id, state, doc FROM habit ORDER BY updated_at DESC").all() as {
      id: string;
      state: string;
      doc: string;
    }[]
  ).map((r) => ({ id: r.id, state: r.state, doc: JSON.parse(r.doc) as HabitRow["doc"] }));
  const habits = allHabits.filter((r) => r.state !== "dismissed");

  console.log("\nStore");
  console.log(`  path            : ${dbPath}`);
  console.log(`  recordings      : ${sessionIds.length}`);
  console.log(`  routes          : ${routes.length}`);
  console.log(`  kept habits     : ${habits.length}`);
  for (const sid of sessionIds) {
    console.log(`  ${sid}  ${String(momentsOf.get(sid)?.length ?? 0).padStart(3)} AX moments`);
  }

  // --- coverage -------------------------------------------------------------
  //
  // "Does the library have a habit for the work that RECURS." Recurrence is the
  // whole question: a route walked once is an observation, and `habitPrompt`
  // already refuses to describe one as a habit. A singleton is admissible as a
  // habit and is counted apart rather than counted against.
  //
  // A DISMISSED route is an ANSWERED route. Leaving dismissals out would report
  // a route the user looked at and declined as a hole in the library.
  {
    // Keyed by the route each habit answers for NOW. A habit still answers for
    // its route after a rebuild moved the key; counting only the stored key
    // would report answered work as an unanswered gap.
    const answered = new Map<string, string>();
    for (const s of allHabits) {
      const live = bindHabit(s.doc.binding, routes).route;
      answered.set(live?.id ?? s.doc.binding.routeKey, s.state);
    }
    const recurring = routes.filter((r) => r.count >= 2);
    const held = recurring.filter((r) => answered.get(r.id) === "active");
    const declined = recurring.filter((r) => answered.get(r.id) === "dismissed");
    const open = recurring.filter((r) => !answered.has(r.id));
    // Local, and named apart from the `pct` the transfer tally uses below: one
    // pads to a column and the other does not, and two functions with one name
    // reading differently is the drift this repo keeps paying for.
    const share = (n: number, d: number) =>
      d === 0 ? "  n/a" : `${Math.round((n / d) * 100)}%`.padStart(4);

    console.log("\nCoverage");
    console.log(`  routes                 : ${routes.length}`);
    console.log(
      `  recurring (2+ takes)   : ${recurring.length}` +
        `   singletons ${routes.length - recurring.length} of ${routes.length}` +
        ` (${share(routes.length - recurring.length, routes.length)})`,
    );
    console.log(`  with an active habit   : ${held.length} of ${recurring.length}  (${share(held.length, recurring.length)})`);
    console.log(`  dismissed on purpose   : ${declined.length}`);
    console.log(`  unanswered             : ${open.length}`);
    for (const r of open) console.log(`      ${String(r.count)}x  ${r.id}`);
  }

  if (habits.length === 0) {
    console.log("\nNo kept habits. Keep one on the Habits screen, then run this again.");
    process.exit(0);
  }

  for (const habit of habits) {
    const binding = bindHabit(habit.doc.binding, routes);
    const route = binding.route;
    console.log(`\n=== ${habit.doc.slug} ===`);
    if (route === null) {
      console.log(`  ${binding.state} — nothing to replay. ${binding.note ?? ""}`.trimEnd());
      continue;
    }
    // Disclosed, never silently adopted: the app holds the same line, and a
    // measurement taken against a route the habit has not been re-bound to has
    // to say which route it used.
    if (binding.state !== "exact") {
      console.log(`  ${binding.state}: reading “${route.id}” — ${binding.note ?? ""}`.trimEnd());
    }

    const bound = new Set(habit.doc.binding.sessionIds);
    const inRoute = route.sessionIds.filter((s) => !bound.has(s));
    const outOfRoute = sessionIds.filter((s) => !route.sessionIds.includes(s));
    const walk = route.walks[0]?.edgeIds ?? route.edgeIds;

    console.log(`  route      : ${route.id}`);
    console.log(`  recordings : ${route.count}  bound: ${bound.size}`);
    const walkNodes = nodesOf(walk);
    const claiming = walkNodes.filter((id) => (nodeById.get(id)?.predicates.length ?? 0) > 0);
    console.log(
      `  walk       : ${walk.length} edges, ${walkNodes.length} states ` +
        `(${claiming.length} of them claim something)`,
    );

    if (inRoute.length === 0) {
      console.log(
        "\n  UNTESTABLE — every recording on this route is one the habit was built from.\n" +
          "  Transfer cannot be measured against the only evidence there is.",
      );
    }

    const run = async (label: string, ids: string[], into: Tally) => {
      if (ids.length === 0) return;
      console.log(`\n  ${label}`);
      for (const sid of ids) {
        const o = await attempt(walk, sid);
        const pass = o.stoppedAt === null;
        add(into, o);
        console.log(
          `    ${pass ? "  ok  " : " stop "} ${sid.slice(-8)}  ` +
            `states ${o.verified}/${o.total}  ` +
            `anchors ${o.anchorsResolved}/${o.anchorsTotal - o.pointOnly}` +
            (o.pointOnly > 0 ? ` (+${o.pointOnly} point-only by construction)` : "") +
            "  " +
            `(${o.moments} moments` +
            (o.vacuous > 0 ? `, ${o.vacuous} state claims nothing` : "") +
            (o.appOnly > 0 ? `, ${o.appOnly} app-only` : "") +
            ")" +
            (o.stoppedAt === null ? "" : `  stopped at ${o.stoppedAt.split(":").pop()}`),
        );
      }
    };

    await run("HELD OUT — same route, a recording it was not built from:", inRoute, heldOut);
    await run("CONTROL — different work, and it should NOT resolve:", outOfRoute, control);
  }

  // --- the eval line --------------------------------------------------------
  //
  // ONE number would be worthless and this prints two. A permissive resolver
  // reports a high transfer rate and a high control rate, and looks like
  // success on the first alone — which is why the header of this file says the
  // gap is the measurement. A rate quoted without its control is not evidence.
  //
  // The denominators are deliberately the strict ones `attempt` already
  // computes: states that CLAIM something (a zero-predicate node is a subset of
  // every screen) and anchors that CARRY DESCRIPTORS (a point-only anchor is at
  // its permanent best and cannot resolve higher).
  const line = (label: string, t: Tally) => {
    if (t.attempts === 0) {
      console.log(`  ${label.padEnd(9)}: nothing to measure`);
      return;
    }
    console.log(
      `  ${label.padEnd(9)}: ${t.whole}/${t.attempts} recordings transferred whole  ` +
        `states ${t.verified}/${t.states} (${pct(t.verified, t.states)})  ` +
        `anchors ${t.anchorsResolved}/${t.anchorsClaiming} (${pct(t.anchorsResolved, t.anchorsClaiming)})`,
    );
  };

  console.log("\nTransfer");
  line("held out", heldOut);
  line("control", control);
  // The anchor column is CONDITIONED on the states that verified, so a control
  // that stopped at state 1 reports the anchor rate of one edge. It is printed
  // for completeness and must not be read across the two rows; the states
  // column is the one that compares.
  console.log("             (anchors are measured only over states that verified — not comparable across rows)");
  if (heldOut.attempts > 0 && control.attempts > 0) {
    const gap = rate(heldOut.verified, heldOut.states) - rate(control.verified, control.states);
    console.log(
      `  gap      : ${(gap * 100).toFixed(0)} points of state verification between the two.` +
        (gap <= 0
          ? "\n             NOT A TRANSFER RESULT — the control did as well or better, which means\n" +
            "             this is measuring how permissive the check is, not whether a habit moves."
          : ""),
    );
  } else if (control.attempts === 0) {
    console.log(
      "  gap      : NO CONTROL RAN. Every recording in this library is on the route under\n" +
        "             test, so a high held-out rate here is not evidence of anything.",
    );
  }
} finally {
  db.close();
}
