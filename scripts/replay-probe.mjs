/**
 * The validation harness for progressive anchor resolution.
 *
 * Answers the measurements the design spec is gated on, against a REAL graph and
 * a REAL desktop. It is strictly READ-ONLY: the actuator is wrapped in a proxy
 * that throws on every mutating method, so this cannot post an event even by
 * mistake. That is the same principle as the barrel inertness guard — the
 * property is structural, not a promise.
 *
 *   node scripts/replay-probe.mjs --offline            # graph analysis, no permissions
 *   node scripts/replay-probe.mjs --goal <nodeId>      # live probe against the desktop
 *   node scripts/replay-probe.mjs --list               # nodes and edges, to pick a goal
 *
 * Requires `npm run build` and `npm run build:ax` first.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { DualStore } from "../dist/store/store.js";
import { AxExecSidecar } from "../dist/replay/sidecar.js";
import { resolveAnchor } from "../dist/replay/resolve.js";
import { verifyNode } from "../dist/replay/verify.js";
import { findPath } from "../dist/replay/plan.js";
import { observe, windowOriginOf } from "../dist/replay/observe.js";
import { executeRun } from "../dist/replay/run.js";

const DATA = process.env.DESKRAG_DATA
  ?? join(homedir(), "Library/Application Support/deskrag-app/DeskRAG");
const GRAPH_ID = process.env.DESKRAG_GRAPH ?? "default";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

/** Every mutating Actuator method, blocked. */
const MUTATORS = ["activate", "moveTo", "click", "dragPath", "scroll", "key"];

function readOnly(actuator) {
  return new Proxy(actuator, {
    get(target, prop, recv) {
      if (MUTATORS.includes(prop)) {
        return () => { throw new Error(`replay-probe is read-only: refused ${String(prop)}()`); };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

// --- anchor helpers --------------------------------------------------------

const anchorOf = (a) => a.anchor ?? a.from;

function descriptorsOf(anchor) {
  const d = [];
  const ax = anchor?.ax;
  if (ax) {
    if (ax.identifier) d.push("identifier");
    if (ax.label) d.push("label");
    if (ax.path) d.push(`path(d=${ax.path.split(">").length})`);
  }
  if (anchor?.visual) d.push("visual");
  return d;
}

const hasAxLayer = (anchor) => anchor?.ax !== undefined;
const isSpatial = (a) => a.kind === "click" || a.kind === "hover" || a.kind === "scroll" || a.kind === "drag";

const appOf = (node) => node?.predicates.find((p) => p.kind === "app")?.args.app;

/** Deductive upper bound on an edge's AX rate: anchors with no ax layer can never reach a rung. */
function axUpperBound(actions) {
  const spatial = actions.filter(isSpatial);
  if (spatial.length === 0) return 1; // matches buildPlan: `targets > 0 ? rate : 1`
  const couldReach = spatial.filter((a) => hasAxLayer(anchorOf(a))).length;
  return couldReach / spatial.length;
}

/**
 * The supersession rule as the data supports it: on a cross-app edge, the FINAL
 * action is the switch when it is spatial and point-only, and any
 * `wait { until: app(X) }` is redundant because runRepair polls that predicate.
 */
function afterSupersession(edge, crosses, toApp) {
  if (!crosses) return edge.actions;
  const last = edge.actions[edge.actions.length - 1];
  const dropLast = last !== undefined && isSpatial(last) && !hasAxLayer(anchorOf(last));
  return edge.actions.filter((a, i) => {
    if (dropLast && i === edge.actions.length - 1) return false;
    if (a.kind === "wait" && a.until.kind === "app" && a.until.args.app === toApp) return false;
    return true;
  });
}

/** The subset locator this spec proposes: candidates verify, most predicates wins, tie declines. */
function locateNode(observed, nodes) {
  const candidates = nodes.filter(
    (n) => n.predicates.length > 0 && verifyNode(n.predicates, observed).violations.length === 0,
  );
  if (candidates.length === 0) return { candidates: 0, ambiguous: false, all: [] };
  const sorted = [...candidates].sort((a, b) => b.predicates.length - a.predicates.length);
  const top = sorted[0];
  const tied = sorted.filter((n) => n.predicates.length === top.predicates.length);
  return {
    nodeId: tied.length === 1 ? top.id : undefined,
    candidates: candidates.length,
    ambiguous: tied.length > 1,
    all: sorted.map((n) => ({ id: n.id, n: n.predicates.length, app: appOf(n) })),
  };
}

// --- offline: what the graph alone says -------------------------------------

function offline(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  console.log(`\n=== GRAPH ${graph.id} — ${graph.nodes.length} nodes, ${graph.edges.length} edges ===\n`);

  console.log("--- nodes ---");
  for (const n of graph.nodes) {
    console.log(`  ${n.id.split(":").pop()}  app=${appOf(n) ?? "-"}  predicates=${n.predicates.length}`);
  }

  const descTally = { identifier: 0, label: 0, path: 0, visual: 0, none: 0 };
  let spatialTotal = 0;
  const crossApp = [];

  console.log("\n--- edges ---");
  for (const e of graph.edges) {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    const fromApp = appOf(from);
    const toApp = appOf(to);
    const crosses = fromApp !== undefined && toApp !== undefined && fromApp !== toApp;
    const bound = axUpperBound(e.actions);

    console.log(
      `\n  ${e.id.split(":").pop()}  ${fromApp ?? "?"} -> ${toApp ?? "?"}` +
      `${crosses ? "   *** CROSSES APPS ***" : ""}   axUpperBound=${(bound * 100).toFixed(0)}%`,
    );

    e.actions.forEach((a, i) => {
      const anc = anchorOf(a);
      const d = descriptorsOf(anc);
      if (isSpatial(a)) {
        spatialTotal++;
        if (d.length === 0) descTally.none++;
        if (anc?.ax?.identifier) descTally.identifier++;
        if (anc?.ax?.label) descTally.label++;
        if (anc?.ax?.path) descTally.path++;
        if (anc?.visual) descTally.visual++;
      }
      const extra =
        a.kind === "wait" ? `  until=${a.until.kind}(${JSON.stringify(a.until.args)})`
        : a.kind === "type" ? `  slot=${a.slot} recorded=${JSON.stringify(a.recorded)}`
        : a.kind === "chord" ? `  keys=${JSON.stringify(a.keys)}`
        : "";
      const pt = anc?.point ? `(${anc.point.x.toFixed(0)},${anc.point.y.toFixed(0)})` : "-";
      const last = i === e.actions.length - 1 ? " <<< LAST" : "";
      console.log(`      [${i}] ${a.kind.padEnd(6)} ${pt.padEnd(13)} [${d.join(",") || "NONE"}]${extra}${last}`);
    });

    if (crosses) {
      const last = e.actions[e.actions.length - 1];
      const waits = e.actions
        .map((a, i) => (a.kind === "wait" && a.until.kind === "app" ? i : -1))
        .filter((i) => i >= 0);
      const kept = afterSupersession(e, true, toApp);
      crossApp.push({
        edge: e.id.split(":").pop(),
        fromApp, toApp,
        lastKind: last?.kind,
        lastIsSpatial: last ? isSpatial(last) : false,
        lastHasAx: last ? hasAxLayer(anchorOf(last)) : false,
        appWaitIndices: waits,
        lastIndex: e.actions.length - 1,
        bound,
        boundAfter: axUpperBound(kept),
        dropped: e.actions.length - kept.length,
      });
    }
  }

  console.log("\n\n=== MEASUREMENT: descriptor availability (spatial actions) ===");
  console.log(`  spatial actions: ${spatialTotal}`);
  for (const [k, v] of Object.entries(descTally)) {
    console.log(`  ${k.padEnd(11)} ${v}  (${spatialTotal ? ((v / spatialTotal) * 100).toFixed(0) : 0}%)`);
  }

  console.log("\n=== MEASUREMENT: cross-app edges and the supersession rule ===");
  if (crossApp.length === 0) console.log("  none in this graph");
  for (const c of crossApp) {
    console.log(`\n  ${c.edge}: ${c.fromApp} -> ${c.toApp}`);
    console.log(`    final action: ${c.lastKind}, spatial=${c.lastIsSpatial}, hasAxLayer=${c.lastHasAx}`);
    console.log(`    'switch is the FINAL action, point-only': ${c.lastIsSpatial && !c.lastHasAx ? "HOLDS" : "FAILS"}`);
    console.log(`    app-wait indices: [${c.appWaitIndices.join(",")}]  final index: ${c.lastIndex}`);
    const tailRule = c.appWaitIndices.includes(c.lastIndex - 1) || c.appWaitIndices.includes(c.lastIndex);
    console.log(`    'switch immediately follows/precedes an app wait' (spec's TAIL rule): ${tailRule ? "HOLDS" : "FAILS"}`);
    console.log(`    axUpperBound: ${(c.bound * 100).toFixed(0)}% -> ${(c.boundAfter * 100).toFixed(0)}% ` +
      `after supersession (${c.dropped} action${c.dropped === 1 ? "" : "s"} dropped)`);
    console.log(`    arms? ${c.bound < 0.5 ? "NO" : "yes"} -> ${c.boundAfter < 0.5 ? "NO" : "YES"}` +
      `   (BRITTLENESS_FLOOR = 0.5)`);
  }

  const before = crossApp.filter((c) => c.bound < 0.5).length;
  const after = crossApp.filter((c) => c.boundAfter < 0.5).length;
  console.log(`\n  cross-app edges below the floor: ${before}/${crossApp.length} -> ${after}/${crossApp.length} after supersession`);
}

/**
 * Poll until `--wait-for` names the frontmost app. Shared by every live mode:
 * the probe cannot be started without focusing a terminal, which would
 * otherwise be the app it measures.
 */
async function waitForApp(actuator) {
  const waitFor = val("--wait-for");
  if (waitFor === undefined) return true;
  const deadline = Date.now() + 60_000;
  console.log(`waiting for "${waitFor}" to come forward (ctrl-c to stop)`);
  let last = null;
  const seen = new Set();
  for (;;) {
    const d = await actuator.dump();
    const app = d.app ?? "(none)";
    if (app !== last) {
      console.log(`   sees: ${JSON.stringify(app)}  window=${JSON.stringify(d.windowTitle ?? null)}`);
      last = app;
      seen.add(app);
    }
    if (d.app === waitFor) { console.log("   matched.\n"); return true; }
    if (Date.now() >= deadline) {
      console.log(`\n  timed out. Apps seen: ${[...seen].map((x) => JSON.stringify(x)).join(", ")}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --- live: greedy resolution against the real desktop -----------------------

async function live(graph, goalId) {
  const sidecar = AxExecSidecar.spawn({ planId: `probe-${Date.now()}` });
  const actuator = readOnly(sidecar);
  try {
    if (!(await waitForApp(actuator))) return;
    const dump = await actuator.dump();
    const observed = await observe(actuator);
    const origin = windowOriginOf(dump);
    const running = await actuator.runningApps();

    console.log(`\n=== LIVE OBSERVATION ===`);
    console.log(`  frontmost app : ${dump.app ?? "(none)"}`);
    console.log(`  window        : ${dump.windowTitle ?? "(none)"}`);
    console.log(`  elements      : ${dump.elements.length}`);
    console.log(`  predicates    : ${observed.length}`);
    console.log(`  windowOrigin  : ${origin ? `(${origin.x},${origin.y})` : "(none)"}`);

    console.log(`\n=== MEASUREMENT: node location (subset rule) ===`);
    const loc = locateNode(observed, graph.nodes);
    console.log(`  candidates that verify : ${loc.candidates}`);
    console.log(`  ambiguous              : ${loc.ambiguous}`);
    console.log(`  located                : ${loc.nodeId?.split(":").pop() ?? "NONE"}`);
    for (const c of loc.all) {
      console.log(`     ${c.id.split(":").pop()}  predicates=${c.n}  app=${c.app ?? "-"}`);
    }
    if (loc.all.length > 1) {
      const [a, b] = loc.all;
      const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
      const setB = new Set(nodes.get(b.id).predicates.map((p) => JSON.stringify(p)));
      const nests = nodes.get(b.id).predicates.every((p) =>
        nodes.get(a.id).predicates.some((q) => JSON.stringify(q) === JSON.stringify(p)));
      console.log(`  do the top two NEST (superset rule would also decide)? ${nests ? "YES" : "NO"}`);
      void setB;
    }

    if (loc.candidates === 0) {
      // Why nothing verified is a measurement too: it says whether the locator
      // fails on app/window identity or on the AX predicates beneath them.
      console.log("\n  --- near misses (fewest violations first) ---");
      const near = graph.nodes
        .filter((n) => n.predicates.length > 0)
        .map((n) => ({ n, v: verifyNode(n.predicates, observed).violations }))
        .sort((a, b) => a.v.length - b.v.length)
        .slice(0, 3);
      for (const { n, v } of near) {
        console.log(`    ${n.id.split(":").pop()} (app=${appOf(n) ?? "-"}): ${v.length}/${n.predicates.length} violated`);
        for (const x of v.slice(0, 4)) {
          console.log(`        - ${x.predicate.kind}(${JSON.stringify(x.predicate.args)})`);
        }
        if (v.length > 4) console.log(`        ... and ${v.length - 4} more`);
      }
    }

    // --from forces the start node so the resolution measurements can be taken
    // even when location fails. Location brittleness is a finding in its own
    // right; it should not also block measuring the thing this spec is about.
    const forced = val("--from");
    let startId = loc.nodeId;
    if (forced !== undefined) {
      const n = graph.nodes.find((x) => x.id === forced || x.id.endsWith(`:${forced}`));
      if (n === undefined) { console.log(`\n  no such node: ${forced}`); return; }
      startId = n.id;
      const v = verifyNode(n.predicates, observed).violations;
      console.log(`\n  --from OVERRIDE: starting at ${n.id.split(":").pop()}` +
        ` (${v.length}/${n.predicates.length} of its predicates do NOT hold)`);
      if (v.length > 0) {
        console.log(`  resolution figures below are therefore measured against a state that`);
        console.log(`  does not fully match the recording. Treat them as indicative.`);
      }
    }

    if (startId === undefined) {
      console.log("\n  cannot probe resolution without a located node. Use --from <nodeId> to force one.");
      return;
    }
    if (goalId === undefined) {
      console.log("\n  pass --goal <nodeId> to probe greedy resolution.");
      return;
    }

    const goal = graph.nodes.find((n) => n.id === goalId || n.id.endsWith(`:${goalId}`));
    if (goal === undefined) { console.log(`\n  no such goal node: ${goalId}`); return; }

    const path = findPath(graph, startId, goal.id);
    if (path === null) { console.log(`\n  no path from ${startId} to ${goal.id}`); return; }

    console.log(`\n=== MEASUREMENT: greedy resolution along ${path.length} edges ===`);
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const opts = origin ? { windowOrigin: origin } : {};
    const frontmost = dump.app;
    let cut = null;
    let segEdges = 0;
    const falsePositives = [];

    for (const e of path) {
      const toApp = appOf(nodes.get(e.to));
      const fromApp = appOf(nodes.get(e.from));
      const inWrongApp = fromApp !== undefined && fromApp !== frontmost;
      console.log(`\n  ${e.id.split(":").pop()}  ${fromApp ?? "?"} -> ${toApp ?? "?"}` +
        `${inWrongApp ? "   (source app is NOT frontmost)" : ""}`);

      let edgeCut = false;
      for (const a of e.actions) {
        if (!isSpatial(a)) continue;
        const anc = anchorOf(a);
        const r = await resolveAnchor(anc, (d) => actuator.locate(d), opts);
        const ax = hasAxLayer(anc);
        console.log(`      ${a.kind.padEnd(6)} [${descriptorsOf(anc).join(",") || "NONE"}]` +
          ` -> ${r.layer}@${r.confidence.toFixed(2)}`);
        for (const at of r.attempts) console.log(`          x ${at.layer}: ${at.rejected}`);

        if (inWrongApp && r.layer !== "point") {
          falsePositives.push({ edge: e.id.split(":").pop(), kind: a.kind, layer: r.layer, conf: r.confidence, app: fromApp });
          console.log(`          !!! RESOLVED while ${fromApp} is not frontmost — SUSPECTED FALSE POSITIVE`);
        }
        if (!edgeCut && cut === null && ax && r.layer === "point") {
          edgeCut = true;
          cut = { edgeId: e.id, resumeAt: e.from, attempts: r.attempts };
          console.log(`          >>> CUT HERE (carries ax descriptors, reached no ax rung)`);
        }
      }
      if (cut === null) segEdges++;
      if (cut !== null) break;
    }

    console.log(`\n=== RESULT ===`);
    console.log(`  segment 1 covers      : ${segEdges} of ${path.length} edges`);
    console.log(`  cut                   : ${cut ? `${cut.edgeId.split(":").pop()} (resume at ${cut.resumeAt.split(":").pop()})` : "none — one segment, one arming"}`);
    console.log(`  suspected false resolutions : ${falsePositives.length}`);
    for (const f of falsePositives) console.log(`     ${f.edge} ${f.kind} ${f.layer}@${f.conf.toFixed(2)} (app ${f.app})`);
    console.log(`  running apps          : ${running.length}`);
  } finally {
    sidecar.close();
  }
}

// --- sweep: does ANY anchor resolve in the wrong application? ---------------

/**
 * The false-positive question, at the largest sample the graph allows.
 *
 * Greedy resolution's risk is an anchor that resolves against the WRONG app's
 * tree — an identifier or label present in both — which would be swallowed into
 * segment 1 and clicked. Walking the path only tests the anchors on that path;
 * this tries every spatial anchor in the graph against whatever is frontmost, so
 * each run measures every anchor that does NOT belong to the current app.
 */
async function sweep(graph) {
  const sidecar = AxExecSidecar.spawn({ planId: `probe-sweep-${Date.now()}` });
  const actuator = readOnly(sidecar);
  try {
    if (!(await waitForApp(actuator))) return;
    const dump = await actuator.dump();
    const origin = windowOriginOf(dump);
    const opts = origin ? { windowOrigin: origin } : {};
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    console.log(`\n=== FALSE-POSITIVE SWEEP — frontmost is ${JSON.stringify(dump.app ?? null)} ===\n`);

    let foreign = 0;
    let foreignResolved = 0;
    let own = 0;
    let ownResolved = 0;

    for (const e of graph.edges) {
      const ownerApp = appOf(nodes.get(e.from));
      for (const a of e.actions) {
        if (!isSpatial(a)) continue;
        const anc = anchorOf(a);
        if (!hasAxLayer(anc)) continue; // point-only can never resolve to a rung
        const r = await resolveAnchor(anc, (d) => actuator.locate(d), opts);
        const isForeign = ownerApp !== undefined && ownerApp !== dump.app;
        const hit = r.layer !== "point";
        if (isForeign) { foreign++; if (hit) foreignResolved++; }
        else { own++; if (hit) ownResolved++; }
        const flag = isForeign && hit ? "   !!! FALSE POSITIVE" : "";
        console.log(
          `  ${e.id.split(":").pop().padEnd(4)} ${(ownerApp ?? "?").padEnd(15)}` +
          ` [${descriptorsOf(anc).join(",")}]`.padEnd(34) +
          ` -> ${r.layer}@${r.confidence.toFixed(2)}${isForeign ? "  (foreign)" : ""}${flag}`,
        );
      }
    }

    console.log(`\n  own-app anchors     : ${ownResolved}/${own} resolved to an AX rung`);
    console.log(`  foreign anchors     : ${foreignResolved}/${foreign} resolved to an AX rung`);
    console.log(
      foreign === 0
        ? `\n  NO FOREIGN ANCHORS to test — run this while a different app is frontmost.`
        : foreignResolved === 0
          ? `\n  CLEAN: no anchor resolved against an application it does not belong to.`
          : `\n  FALSE POSITIVES FOUND: ${foreignResolved}. Greedy resolution would swallow these\n` +
            `  into the current segment and click them.`,
    );
  } finally {
    sidecar.close();
  }
}

/**
 * Drive the REAL loop with an arming gate that always REFUSES.
 *
 * Exercises observe -> locate -> pathfind -> buildPlan -> arm end to end against
 * a live desktop and prints the segment it would have run, without posting
 * anything. The read-only proxy makes that structural rather than a promise: it
 * could not post even if `arm` were wrong.
 */
/**
 * The layout the session was RECORDED with, from its own `keymap_change` event.
 * Passing a placeholder makes every `type` action a blocker — correctly, since
 * `type` has no fallback layout — which would make a dry run look unarmable for
 * a reason that has nothing to do with resolution.
 */
function sessionKeymap(store) {
  for (const s of store.listSessions()) {
    for (const e of store.getEventsBySession(s.id)) {
      if (e.kind === "keymap_change" && e.data?.entries !== undefined) return e.data;
    }
  }
  return undefined;
}

async function dryRun(graph, goalId, keymap) {
  const sidecar = AxExecSidecar.spawn({ planId: `probe-run-${Date.now()}` });
  const actuator = readOnly(sidecar);
  try {
    if (!(await waitForApp(actuator))) return;
    const goal = graph.nodes.find((n) => n.id === goalId || n.id.endsWith(`:${goalId}`));
    if (goal === undefined) {
      console.log(`no such goal node: ${goalId}`);
      return;
    }

    let segment = 0;
    const out = await executeRun({
      graph,
      actuator,
      keymap: keymap ?? { layoutId: "none", entries: {} },
      goalNodeId: goal.id,
      arm: async (plan) => {
        segment++;
        console.log(`\n=== SEGMENT ${segment} — ${plan.steps.length} steps ===`);
        for (const s of plan.steps) {
          if (s.repair !== undefined) {
            console.log(`  activate  ${s.app}${s.launch ? " (launching)" : ""}`);
          } else if (s.superseded !== undefined) {
            console.log(`  SUPERSEDED ${s.action.kind} — ${s.reason}`);
          } else if (s.resolution !== undefined) {
            const r = s.resolution;
            console.log(`  ${s.action.kind.padEnd(6)} -> ${r.layer}@${r.confidence.toFixed(2)}`);
          } else {
            // chord / type / wait have no spatial target to resolve.
            const detail =
              s.action.kind === "type"
                ? `  slot=${s.action.slot} ${JSON.stringify(s.slotBinding?.value ?? s.action.recorded)}`
                : s.action.kind === "chord"
                  ? `  ${s.action.keys.join("+")}`
                  : "";
            console.log(`  ${s.action.kind.padEnd(6)}${detail}`);
          }
        }
        console.log(
          `  cut       : ${plan.cut ? `${plan.cut.edgeId.split(":").pop()} (resume ${plan.cut.resumeAt.split(":").pop()})` : "none"}`,
        );
        console.log(
          `  remainder : ${plan.remainder.map((r) => r.edgeId.split(":").pop()).join(", ") || "none"}`,
        );
        console.log(
          `  blockers  : ${plan.blockers.map((b) => `${b.reason} [${b.scope}]`).join("; ") || "none"}`,
        );
        console.log(
          `  brittle   : ${plan.brittleness.map((b) => `${b.edgeId.split(":").pop()}@${(b.axRate * 100).toFixed(0)}%${b.bound === "upper" ? " (upper)" : ""}`).join(", ")}`,
        );
        if (plan.drift !== undefined) {
          console.log(
            `  DRIFT     : expected ${plan.drift.expected.split(":").pop()}, observed ${plan.drift.observed.split(":").pop()}`,
          );
        }
        console.log(`  -> refusing to arm; this probe never posts`);
        return false;
      },
    });
    console.log(`\nstopped: ${out.stopped}   reached: ${out.reached}   segments run: ${out.segments.length}`);
  } finally {
    sidecar.close();
  }
}

/**
 * THE ONLY MODE THAT POSTS REAL EVENTS.
 *
 * Deliberately separate from `dryRun`, and deliberately NOT wrapped in the
 * read-only proxy — which is the one thing making every other mode structurally
 * incapable of touching the desktop. Everything here is real: real CGEvents,
 * a real keyboard, a real application switch, and no rollback of any kind.
 *
 * Each segment is printed and then counted down before it is armed, so there is
 * always a visible window to ctrl-C. The countdown is the only gate this script
 * has; `executeRun`'s own gates (blockers, brittleness) still apply underneath.
 */
async function liveRun(graph, goalId, keymap, countdownSec) {
  const sidecar = AxExecSidecar.spawn({ planId: `live-${Date.now()}` });
  try {
    const goal = graph.nodes.find((n) => n.id === goalId || n.id.endsWith(`:${goalId}`));
    if (goal === undefined) {
      console.log(`no such goal node: ${goalId}`);
      return;
    }
    console.log(`\n${"!".repeat(72)}`);
    console.log(`LIVE RUN — this WILL post real clicks and keystrokes to this desktop.`);
    console.log(`There is no undo. ctrl-C during any countdown to stop.`);
    console.log(`${"!".repeat(72)}`);

    if (!(await waitForApp(sidecar))) return;

    let segment = 0;
    const out = await executeRun({
      graph,
      actuator: sidecar,
      keymap,
      goalNodeId: goal.id,
      arm: async (plan) => {
        segment++;
        console.log(`\n=== SEGMENT ${segment} — ${plan.steps.length} steps ===`);
        for (const st of plan.steps) {
          if (st.repair !== undefined) {
            console.log(`  activate  ${st.app}${st.launch ? " (launching)" : ""}`);
          } else if (st.superseded !== undefined) {
            console.log(`  SUPERSEDED ${st.action.kind} — not posted`);
          } else if (st.resolution !== undefined) {
            const r = st.resolution;
            console.log(
              `  ${st.action.kind.padEnd(6)} -> ${r.layer}@${r.confidence.toFixed(2)}` +
                `  at (${r.point.x.toFixed(0)}, ${r.point.y.toFixed(0)})`,
            );
          } else if (st.action.kind === "type") {
            const v = st.slotBinding?.value ?? st.action.recorded;
            console.log(`  type    ${JSON.stringify(v)}   << REPLACES ANY SELECTION`);
          } else if (st.action.kind === "chord") {
            console.log(`  chord   ${st.action.keys.join("+")}`);
          } else {
            console.log(`  ${st.action.kind}`);
          }
        }
        console.log(
          `  cut: ${plan.cut ? plan.cut.edgeId.split(":").pop() : "none"}` +
            `   remainder: ${plan.remainder.map((r) => r.edgeId.split(":").pop()).join(",") || "none"}` +
            `   blockers: ${plan.blockers.length}`,
        );
        if (plan.drift !== undefined) {
          console.log(
            `  DRIFT: expected ${plan.drift.expected.split(":").pop()}, observed ${plan.drift.observed.split(":").pop()}`,
          );
        }
        for (let i = countdownSec; i > 0; i--) {
          process.stdout.write(`\r  ARMING IN ${i}s — ctrl-C to abort   `);
          await new Promise((r) => setTimeout(r, 1000));
        }
        console.log(`\r  ARMED — posting now.                `);
        return true;
      },
    });

    console.log(`\n=== RESULT ===`);
    console.log(`  reached : ${out.reached}`);
    console.log(`  stopped : ${out.stopped ?? "(goal reached)"}`);
    console.log(`  segments: ${out.segments.length}`);
    out.segments.forEach((seg, i) => {
      console.log(
        `    ${i + 1}: ${seg.outcome.stepsRun} steps run, completed=${seg.outcome.completed}` +
          (seg.outcome.failure ? `  FAILURE: ${seg.outcome.failure.reason}` : ""),
      );
      for (const t of seg.outcome.telemetry) {
        console.log(`       ${t.edgeId.split(":").pop()} ${t.layer}@${t.confidence.toFixed(2)}`);
      }
    });
  } finally {
    sidecar.close();
  }
}

// --- diagnostic: does a long-lived sidecar track the frontmost app? ---------

/**
 * `ax-exec` blocks on `readLine` and spins no run loop, but
 * `NSWorkspace.shared.frontmostApplication` is backed by workspace notifications
 * delivered to the main run loop. If that value is pinned at spawn time, then
 * both the reported app AND the AX tree (whose pid comes from the same call in
 * `rootElement()`) describe whichever app was frontmost when the process started.
 *
 * A fresh process per sample cannot have the problem, so disagreement between
 * the two is the proof.
 */
async function diagnoseFrontmost(seconds) {
  const longLived = readOnly(AxExecSidecar.spawn({ planId: `probe-long-${Date.now()}` }));
  console.log(`\n=== DIAGNOSTIC: long-lived vs fresh sidecar, ${seconds}s ===`);
  console.log(`switch between apps now.\n`);
  // The fresh spawn is SANDWICHED between two long-lived reads. Spawning a
  // process takes time, so a plain before/after pair disagrees whenever the
  // desktop moves mid-sample — which would look identical to a residual lag.
  // If the trailing read has caught up to the fresh one, the world moved during
  // the sample and the disagreement is the measurement's, not the sidecar's.
  console.log(`   ${"long(before)".padEnd(16)} ${"fresh".padEnd(16)} ${"long(after)".padEnd(16)} verdict`);
  let raced = 0;
  let lagged = 0;
  let samples = 0;
  const longSeen = new Set();
  const freshSeen = new Set();
  try {
    for (let i = 0; i < seconds; i++) {
      const a = (await longLived.dump()).app ?? "(none)";
      const fresh = AxExecSidecar.spawn({ planId: `probe-fresh-${i}` });
      let b;
      try { b = (await fresh.dump()).app ?? "(none)"; } finally { fresh.close(); }
      const c = (await longLived.dump()).app ?? "(none)";
      longSeen.add(a).add(c);
      freshSeen.add(b);
      samples++;
      let verdict = "agree";
      if (a !== b) {
        if (c === b) { raced++; verdict = "raced (caught up)"; }
        else { lagged++; verdict = "LAGGED <<<"; }
      }
      console.log(`   ${a.padEnd(16)} ${b.padEnd(16)} ${c.padEnd(16)} ${verdict}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    longLived.close();
  }
  console.log(`\n   raced (world moved mid-sample) : ${raced}`);
  console.log(`   LAGGED (sidecar behind)        : ${lagged}`);
  console.log(`   samples          : ${samples}`);
  console.log(`   long-lived saw   : ${[...longSeen].map((s) => JSON.stringify(s)).join(", ")}`);
  console.log(`   fresh spawns saw : ${[...freshSeen].map((s) => JSON.stringify(s)).join(", ")}`);
  console.log(
    longSeen.size === 1 && freshSeen.size > 1
      ? `\n   CONFIRMED PINNED: the long-lived sidecar never left "${[...longSeen][0]}" while\n` +
        `   the desktop moved. Its AX tree is pinned too — rootElement() takes the pid\n` +
        `   from the same NSWorkspace call.`
      : freshSeen.size <= 1
        ? `\n   INCONCLUSIVE: the frontmost app never changed. Switch apps during the run.`
        : lagged > 0
          ? `\n   RESIDUAL LAG: ${lagged} sample(s) where the sidecar was still behind after the\n` +
            `   fresh read. Not pinned, but not current either.`
          : `\n   CLEAN: the long-lived sidecar tracked the desktop. Any disagreement was the\n` +
            `   world moving mid-sample, which the trailing read confirms.`,
  );
}

// --- main -------------------------------------------------------------------

const store = await DualStore.open(join(DATA, "app.db"), join(DATA, "lance"));
try {
  const graph = store.getGraph(GRAPH_ID);
  if (graph === undefined) {
    console.error(`no graph "${GRAPH_ID}" in ${DATA}. Available: ${JSON.stringify(store.listGraphs())}`);
    process.exit(1);
  }

  if (has("--live")) {
    await liveRun(graph, val("--goal"), sessionKeymap(store), Number(val("--countdown") ?? 6));
  } else if (has("--dry-run")) await dryRun(graph, val("--goal"), sessionKeymap(store));
  else if (has("--sweep")) await sweep(graph);
  else if (has("--diagnose-frontmost")) await diagnoseFrontmost(Number(val("--diagnose-frontmost") ?? 20));
  else if (has("--list") || has("--offline")) offline(graph);
  else await live(graph, val("--goal"));
} finally {
  store.close?.();
}
