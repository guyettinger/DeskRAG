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

// --- live: greedy resolution against the real desktop -----------------------

async function live(graph, goalId) {
  const sidecar = AxExecSidecar.spawn({ planId: `probe-${Date.now()}` });
  const actuator = readOnly(sidecar);
  try {
    // Polling for the app avoids the observer effect: the probe cannot be run
    // without focusing a terminal, which would be the app it then measures.
    const waitFor = val("--wait-for");
    if (waitFor !== undefined) {
      const deadline = Date.now() + 60_000;
      // Report what is actually seen, not a dot. A silent poll that times out
      // cannot distinguish "you never switched" from "dump reports another name".
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
        if (d.app === waitFor) { console.log("   matched.\n"); break; }
        if (Date.now() >= deadline) {
          console.log(`\n  timed out. Apps seen while waiting: ${[...seen].map((s) => JSON.stringify(s)).join(", ")}`);
          console.log(`  If one of those IS the app you meant, pass its exact name to --wait-for.`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

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

    if (loc.nodeId === undefined) {
      console.log("\n  cannot probe resolution without a located node.");
      return;
    }
    if (goalId === undefined) {
      console.log("\n  pass --goal <nodeId> to probe greedy resolution.");
      return;
    }

    const goal = graph.nodes.find((n) => n.id === goalId || n.id.endsWith(`:${goalId}`));
    if (goal === undefined) { console.log(`\n  no such goal node: ${goalId}`); return; }

    const path = findPath(graph, loc.nodeId, goal.id);
    if (path === null) { console.log(`\n  no path from ${loc.nodeId} to ${goal.id}`); return; }

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

  if (has("--diagnose-frontmost")) await diagnoseFrontmost(Number(val("--diagnose-frontmost") ?? 20));
  else if (has("--list") || has("--offline")) offline(graph);
  else await live(graph, val("--goal"));
} finally {
  store.close?.();
}
