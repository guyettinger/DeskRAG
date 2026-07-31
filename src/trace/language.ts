/**
 * The language: a Graph's text projection.
 *
 * The persisted form is typed SQLite rows; this is the exchange form. Keeping
 * them separate means the AI never sees ids and foreign keys, and a malformed
 * response fails at the parser rather than halfway through a database write.
 *
 * `parseGraph(printGraph(g))` deep-equals `g` — the round trip is the contract,
 * and anything the text cannot represent losslessly is serialized explicitly
 * rather than dropped.
 *
 * Validation here is a security boundary, not a convenience: a response naming
 * an unknown edge, an undeclared slot, or synthesizing under `allow: "select"`
 * becomes an abort. A model must not widen its own permissions by malforming a
 * reply.
 *
 * Format, two-space indent, `!` marking an assertable predicate:
 *
 *   graph g_01 entry=n0
 *
 *   node n0 intervene=select obs=3 visual=b_1/0f1e
 *     app app="Mail"
 *     ax_exists role="AXButton" label="Send"
 *     ! display id="D1" w=2560 h=1440
 *
 *   edge e0 n0 -> n1 obs=2 recorded attempts=5 successes=4
 *     click axrole="AXButton" axpath="AXWindow[0]" point=1420,386@D1 button=1 count=1
 *     type $recipient "guy@example.com"
 *     wait ax_exists role="AXSheet" timeout=3000
 *
 *   slot recipient "alice@example.com" "bob@example.com"
 */

import type {
  Action,
  Anchor,
  CubicBezier,
  Graph,
  InterventionRequest,
  InterventionResponse,
  Intervene,
  Path,
  Predicate,
  PredicateKind,
  TraceEdge,
  TraceNode,
} from "./types.js";

// --- scalars ---------------------------------------------------------------

const quote = (s: string): string => JSON.stringify(s);

function unquote(s: string, line: number): string {
  if (!s.startsWith('"')) throw new Error(`line ${line}: expected a quoted string, got ${s}`);
  try {
    const v: unknown = JSON.parse(s);
    if (typeof v !== "string") throw new Error("not a string");
    return v;
  } catch {
    throw new Error(`line ${line}: malformed quoted string ${s}`);
  }
}

const numList = (ns: readonly number[]): string => ns.map((n) => String(n)).join(",");

function parseNumList(s: string, line: number): number[] {
  if (s.length === 0) return [];
  return s.split(",").map((part) => {
    const n = Number(part);
    if (!Number.isFinite(n)) throw new Error(`line ${line}: expected a number, got ${part}`);
    return n;
  });
}

/**
 * Split a line into tokens on spaces, treating a quoted run as part of one
 * token so `k="a b c"` and a bare `"a b c"` both survive intact.
 */
function scanTokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === " ") i++;
    if (i >= line.length) break;
    let tok = "";
    while (i < line.length && line[i] !== " ") {
      if (line[i] === '"') {
        tok += line[i++];
        while (i < line.length && line[i] !== '"') {
          if (line[i] === "\\") {
            tok += line[i++];
            if (i < line.length) tok += line[i++];
          } else {
            tok += line[i++];
          }
        }
        if (i < line.length) tok += line[i++];
      } else {
        tok += line[i++];
      }
    }
    out.push(tok);
  }
  return out;
}

interface Parsed {
  /** Tokens with no `=`, in order: the line's keywords. */
  words: string[];
  kv: Map<string, string>;
}

function parseLine(line: string): Parsed {
  const words: string[] = [];
  const kv = new Map<string, string>();
  for (const tok of scanTokens(line)) {
    const eq = tok.indexOf("=");
    if (eq <= 0 || tok.startsWith('"')) {
      words.push(tok);
    } else {
      kv.set(tok.slice(0, eq), tok.slice(eq + 1));
    }
  }
  return { words, kv };
}

function need(kv: Map<string, string>, key: string, line: number): string {
  const v = kv.get(key);
  if (v === undefined) throw new Error(`line ${line}: missing ${key}`);
  return v;
}

function needNum(kv: Map<string, string>, key: string, line: number): number {
  const n = Number(need(kv, key, line));
  if (!Number.isFinite(n)) throw new Error(`line ${line}: ${key} is not a number`);
  return n;
}

// --- predicates ------------------------------------------------------------

const PREDICATE_KINDS: ReadonlySet<string> = new Set<PredicateKind>([
  "app",
  "window",
  "ax_exists",
  "ax_focused",
  "display",
  "file",
  "permission",
]);

function printPredicate(p: Predicate): string {
  const args = Object.keys(p.args)
    .map((k) => {
      const v = p.args[k]!;
      return `${k}=${typeof v === "string" ? quote(v) : String(v)}`;
    })
    .join(" ");
  // The reach tag rides as a `!` prefix rather than a field, so it cannot be
  // printed inconsistently with the value actually stored.
  return `${p.reach === "assertable" ? "! " : ""}${p.kind}${args.length > 0 ? ` ${args}` : ""}`;
}

/** `words[0]` may be `!`; the kind follows. Consumes the whole parsed line. */
function predicateFrom(parsed: Parsed, line: number, offset = 0): Predicate {
  let i = offset;
  let reach: Predicate["reach"] = "achievable";
  if (parsed.words[i] === "!") {
    reach = "assertable";
    i++;
  }
  const kind = parsed.words[i];
  if (kind === undefined || !PREDICATE_KINDS.has(kind)) {
    throw new Error(`line ${line}: unknown predicate kind ${String(kind)}`);
  }
  const args: Predicate["args"] = {};
  for (const [k, raw] of parsed.kv) {
    if (RESERVED_PREDICATE_KEYS.has(k)) continue;
    args[k] = scalarFrom(raw, line);
  }
  return { kind: kind as PredicateKind, args, reach };
}

/** Keys that belong to the enclosing action, not to an inline predicate. */
const RESERVED_PREDICATE_KEYS: ReadonlySet<string> = new Set(["timeout"]);

function scalarFrom(raw: string, line: number): string | number | boolean {
  if (raw.startsWith('"')) return unquote(raw, line);
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  if (raw.length > 0 && Number.isFinite(n)) return n;
  return raw;
}

// --- anchors ---------------------------------------------------------------

function anchorTokens(a: Anchor, prefix: string): string[] {
  const out: string[] = [];
  if (a.ax !== undefined) {
    out.push(`${prefix}axrole=${quote(a.ax.role)}`);
    if (a.ax.label !== undefined) out.push(`${prefix}axlabel=${quote(a.ax.label)}`);
    out.push(`${prefix}axpath=${quote(a.ax.path)}`);
  }
  if (a.visual !== undefined) {
    out.push(`${prefix}region=${quote(a.visual.regionId)}`);
    out.push(`${prefix}rphash=${quote(a.visual.framePhash)}`);
    const b = a.visual.bbox;
    out.push(`${prefix}rbbox=${numList([b.x, b.y, b.w, b.h])}`);
  }
  out.push(`${prefix}point=${a.point.x},${a.point.y}@${a.point.displayId}`);
  if (a.point.windowRelative !== undefined) {
    out.push(`${prefix}win=${a.point.windowRelative.x},${a.point.windowRelative.y}`);
  }
  return out;
}

function anchorFrom(kv: Map<string, string>, prefix: string, line: number): Anchor {
  const pointRaw = need(kv, `${prefix}point`, line);
  const at = pointRaw.lastIndexOf("@");
  if (at < 0) throw new Error(`line ${line}: ${prefix}point is missing its @display`);
  const [x, y] = parseNumList(pointRaw.slice(0, at), line);
  if (x === undefined || y === undefined) throw new Error(`line ${line}: ${prefix}point needs x,y`);

  const win = kv.get(`${prefix}win`);
  const winParts = win !== undefined ? parseNumList(win, line) : undefined;

  const axPath = kv.get(`${prefix}axpath`);
  const axRole = kv.get(`${prefix}axrole`);
  const axLabel = kv.get(`${prefix}axlabel`);
  const region = kv.get(`${prefix}region`);

  return {
    ...(axPath !== undefined && axRole !== undefined
      ? {
          ax: {
            role: unquote(axRole, line),
            ...(axLabel !== undefined ? { label: unquote(axLabel, line) } : {}),
            path: unquote(axPath, line),
          },
        }
      : {}),
    ...(region !== undefined
      ? {
          visual: {
            regionId: unquote(region, line),
            framePhash: unquote(need(kv, `${prefix}rphash`, line), line),
            bbox: bboxFrom(parseNumList(need(kv, `${prefix}rbbox`, line), line), line),
          },
        }
      : {}),
    point: {
      x,
      y,
      displayId: pointRaw.slice(at + 1),
      ...(winParts !== undefined && winParts[0] !== undefined && winParts[1] !== undefined
        ? { windowRelative: { x: winParts[0], y: winParts[1] } }
        : {}),
    },
  };
}

function bboxFrom(ns: readonly number[], line: number): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = ns;
  if (x === undefined || y === undefined || w === undefined || h === undefined) {
    throw new Error(`line ${line}: bbox needs x,y,w,h`);
  }
  return { x, y, w, h };
}

// --- paths -----------------------------------------------------------------

const printCurve = (curve: readonly CubicBezier[]): string =>
  curve.map((c) => numList([c.c1.x, c.c1.y, c.c2.x, c.c2.y, c.end.x, c.end.y])).join(";");

function curveFrom(raw: string, line: number): CubicBezier[] {
  if (raw.length === 0) return [];
  return raw.split(";").map((seg) => {
    const n = parseNumList(seg, line);
    if (n.length !== 6) throw new Error(`line ${line}: a curve segment needs 6 numbers, got ${n.length}`);
    return {
      c1: { x: n[0]!, y: n[1]! },
      c2: { x: n[2]!, y: n[3]! },
      end: { x: n[4]!, y: n[5]! },
    };
  });
}

// --- actions ---------------------------------------------------------------

function printAction(a: Action): string {
  switch (a.kind) {
    case "click":
      return ["click", ...anchorTokens(a.anchor, ""), `button=${a.button}`, `count=${a.count}`].join(" ");
    case "hover":
      return ["hover", ...anchorTokens(a.anchor, ""), `dwell=${a.dwellMs}`].join(" ");
    case "scroll":
      return [
        "scroll",
        ...anchorTokens(a.anchor, ""),
        `delta=${numList([a.delta.x, a.delta.y])}`,
        `steps=${a.steps}`,
      ].join(" ");
    case "drag":
      return [
        "drag",
        ...anchorTokens(a.from, "from."),
        ...anchorTokens(a.to, "to."),
        `path=${printCurve(a.path.curve)}`,
        `dur=${a.path.durationMs}`,
        `vel=${numList(a.path.velocity)}`,
        `fit=${a.path.fitConfidence}`,
        `button=${a.button}`,
      ].join(" ");
    case "type":
      return `type $${a.slot} ${quote(a.recorded)}`;
    case "chord":
      return `chord ${a.keys.join("+")}`;
    case "wait":
      return `wait ${printPredicate(a.until)} timeout=${a.timeoutMs}`;
  }
}

function actionFrom(parsed: Parsed, line: number): Action {
  const kind = parsed.words[0];
  const { kv } = parsed;
  switch (kind) {
    case "click":
      return {
        kind: "click",
        anchor: anchorFrom(kv, "", line),
        button: needNum(kv, "button", line),
        count: needNum(kv, "count", line),
      };
    case "hover":
      return { kind: "hover", anchor: anchorFrom(kv, "", line), dwellMs: needNum(kv, "dwell", line) };
    case "scroll": {
      const [dx, dy] = parseNumList(need(kv, "delta", line), line);
      if (dx === undefined || dy === undefined) throw new Error(`line ${line}: delta needs x,y`);
      return {
        kind: "scroll",
        anchor: anchorFrom(kv, "", line),
        delta: { x: dx, y: dy },
        steps: needNum(kv, "steps", line),
      };
    }
    case "drag": {
      const path: Path = {
        curve: curveFrom(need(kv, "path", line), line),
        durationMs: needNum(kv, "dur", line),
        velocity: parseNumList(need(kv, "vel", line), line),
        fitConfidence: needNum(kv, "fit", line),
      };
      return {
        kind: "drag",
        from: anchorFrom(kv, "from.", line),
        to: anchorFrom(kv, "to.", line),
        path,
        button: needNum(kv, "button", line),
      };
    }
    case "type": {
      const slot = parsed.words[1];
      const value = parsed.words[2];
      if (slot === undefined || !slot.startsWith("$") || value === undefined) {
        throw new Error(`line ${line}: type needs $slot and a quoted value`);
      }
      return { kind: "type", slot: slot.slice(1), recorded: unquote(value, line) };
    }
    case "chord": {
      const keys = parsed.words[1];
      if (keys === undefined) throw new Error(`line ${line}: chord needs its keys`);
      return { kind: "chord", keys: keys.split("+") };
    }
    case "wait":
      return {
        kind: "wait",
        until: predicateFrom(parsed, line, 1),
        timeoutMs: needNum(kv, "timeout", line),
      };
    default:
      throw new Error(`line ${line}: unknown action ${String(kind)}`);
  }
}

// --- graph -----------------------------------------------------------------

const INTERVENE: ReadonlySet<string> = new Set<Intervene>(["none", "select", "synthesize"]);

export function printGraph(g: Graph): string {
  const out: string[] = [`graph ${g.id} entry=${g.entry}`];

  for (const n of g.nodes) {
    out.push("");
    const head = [`node ${n.id}`, `intervene=${n.intervene}`, `obs=${n.observations}`];
    if (n.visual !== undefined) head.push(`visual=${n.visual.frameBlobId}/${n.visual.phash}`);
    out.push(head.join(" "));
    for (const p of n.predicates) out.push(`  ${printPredicate(p)}`);
  }

  for (const e of g.edges) {
    out.push("");
    out.push(
      `edge ${e.id} ${e.from} -> ${e.to} obs=${e.observations} ${e.provenance} attempts=${e.outcomes.attempts} successes=${e.outcomes.successes}`,
    );
    for (const a of e.actions) out.push(`  ${printAction(a)}`);
    // A defined-but-empty guard/warning list is distinct from an absent one, so
    // it gets a bare marker line rather than silently becoming undefined.
    if (e.guard !== undefined) {
      if (e.guard.length === 0) out.push("  guard");
      for (const p of e.guard) out.push(`  guard ${printPredicate(p)}`);
    }
    if (e.liftWarnings !== undefined) {
      if (e.liftWarnings.length === 0) out.push("  warn");
      for (const w of e.liftWarnings) out.push(`  warn ${quote(w)}`);
    }
  }

  for (const s of g.slots) {
    out.push("");
    out.push(`slot ${s.name}${s.samples.length > 0 ? ` ${s.samples.map(quote).join(" ")}` : ""}`);
  }

  return `${out.join("\n")}\n`;
}

export function parseGraph(text: string): Graph {
  const lines = text.split("\n");
  let graph: Graph | undefined;
  let node: TraceNode | undefined;
  let edge: TraceEdge | undefined;

  const closeBlock = (): void => {
    if (node !== undefined) graph!.nodes.push(node);
    if (edge !== undefined) graph!.edges.push(edge);
    node = undefined;
    edge = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    if (raw.trim().length === 0) continue;

    const indented = raw.startsWith("  ");
    const parsed = parseLine(raw.trim());
    const head = parsed.words[0];

    if (!indented) {
      if (head === "graph") {
        if (graph !== undefined) throw new Error(`line ${lineNo}: a second graph header`);
        const id = parsed.words[1];
        if (id === undefined) throw new Error(`line ${lineNo}: graph needs an id`);
        graph = { id, nodes: [], edges: [], slots: [], entry: need(parsed.kv, "entry", lineNo) };
        continue;
      }
      if (graph === undefined) throw new Error(`line ${lineNo}: expected a graph header first`);
      closeBlock();

      if (head === "node") {
        const id = parsed.words[1];
        if (id === undefined) throw new Error(`line ${lineNo}: node needs an id`);
        const intervene = need(parsed.kv, "intervene", lineNo);
        if (!INTERVENE.has(intervene)) throw new Error(`line ${lineNo}: bad intervene ${intervene}`);
        const visual = parsed.kv.get("visual");
        const slash = visual?.indexOf("/") ?? -1;
        node = {
          id,
          predicates: [],
          ...(visual !== undefined && slash > 0
            ? { visual: { frameBlobId: visual.slice(0, slash), phash: visual.slice(slash + 1) } }
            : {}),
          intervene: intervene as Intervene,
          observations: needNum(parsed.kv, "obs", lineNo),
        };
      } else if (head === "edge") {
        const [, id, from, arrow, to] = parsed.words;
        if (id === undefined || from === undefined || arrow !== "->" || to === undefined) {
          throw new Error(`line ${lineNo}: edge needs "<id> <from> -> <to>"`);
        }
        const provenance = parsed.words[5];
        if (provenance !== "recorded" && provenance !== "synthesized") {
          throw new Error(`line ${lineNo}: edge needs a provenance`);
        }
        edge = {
          id,
          from,
          to,
          actions: [],
          provenance,
          observations: needNum(parsed.kv, "obs", lineNo),
          outcomes: {
            attempts: needNum(parsed.kv, "attempts", lineNo),
            successes: needNum(parsed.kv, "successes", lineNo),
          },
        };
      } else if (head === "slot") {
        const name = parsed.words[1];
        if (name === undefined) throw new Error(`line ${lineNo}: slot needs a name`);
        graph.slots.push({
          name,
          samples: parsed.words.slice(2).map((s) => unquote(s, lineNo)),
          secret: false,
        });
      } else {
        throw new Error(`line ${lineNo}: unexpected ${String(head)}`);
      }
      continue;
    }

    // Indented: a member of the open block.
    if (node !== undefined) {
      node.predicates.push(predicateFrom(parsed, lineNo));
    } else if (edge !== undefined) {
      if (head === "guard") {
        edge.guard ??= [];
        if (parsed.words.length > 1) edge.guard.push(predicateFrom(parsed, lineNo, 1));
      } else if (head === "warn") {
        edge.liftWarnings ??= [];
        const w = parsed.words[1];
        if (w !== undefined) edge.liftWarnings.push(unquote(w, lineNo));
      } else {
        edge.actions.push(actionFrom(parsed, lineNo));
      }
    } else {
      throw new Error(`line ${lineNo}: indented line outside a node or edge`);
    }
  }

  if (graph === undefined) throw new Error("line 1: expected a graph header");
  closeBlock();
  return graph;
}

// --- intervention ----------------------------------------------------------

export function printInterventionRequest(req: InterventionRequest): string {
  const out: string[] = [`goal: ${req.goal}`, "", "expected:"];
  for (const p of req.atNode) out.push(`  ${printPredicate(p)}`);
  out.push("", "observed:");
  for (const p of req.observed) out.push(`  ${printPredicate(p)}`);
  out.push("", "options:");
  for (const o of req.options) {
    out.push(`  ${o.edgeId} — ${o.summary}`);
    for (const g of o.guard ?? []) out.push(`    guard ${printPredicate(g)}`);
  }
  out.push("", "slots:");
  for (const s of req.slots) out.push(`  ${s.name}: ${s.samples.map(quote).join(", ")}`);
  out.push("", `allow: ${req.allow}`);
  return `${out.join("\n")}\n`;
}

/**
 * Parse a model's reply and validate it against what the request permitted.
 * Failure order is fixed: unparseable, then unknown edge, then undeclared slot,
 * then synthesis-not-permitted. Any failure yields `{ abort }` alone — never a
 * choice alongside an abort, so a caller cannot act on a half-valid reply.
 */
export function parseInterventionResponse(
  text: string,
  req: InterventionRequest,
): InterventionResponse {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { abort: "empty response" };

  let choose: string | undefined;
  const bind: Record<string, string> = {};
  const synthesize: Action[] = [];
  let sawSynthesize = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const parsed = parseLine(raw.trim());
    const head = parsed.words[0];

    if (raw.startsWith("  ") && sawSynthesize) {
      try {
        synthesize.push(actionFrom(parsed, lineNo));
      } catch (err) {
        return { abort: err instanceof Error ? err.message : "unparseable synthesized action" };
      }
      continue;
    }

    switch (head) {
      case "abort":
        return { abort: parsed.words.slice(1).join(" ") || "no reason given" };
      case "choose": {
        const id = parsed.words[1];
        if (id === undefined) return { abort: `line ${lineNo}: choose needs an edge id` };
        choose = id;
        break;
      }
      case "bind": {
        for (const [k, v] of parsed.kv) {
          try {
            bind[k] = unquote(v, lineNo);
          } catch {
            return { abort: `line ${lineNo}: bind value must be a quoted string` };
          }
        }
        if (parsed.kv.size === 0) return { abort: `line ${lineNo}: bind needs name="value"` };
        break;
      }
      case "synthesize":
        sawSynthesize = true;
        break;
      default:
        return { abort: `line ${lineNo}: unparseable response line` };
    }
  }

  if (choose === undefined && !sawSynthesize) return { abort: "response chose nothing" };

  if (choose !== undefined && !req.options.some((o) => o.edgeId === choose)) {
    return { abort: `unknown edge ${choose}` };
  }

  const declared = new Set(req.slots.map((s) => s.name));
  for (const name of Object.keys(bind)) {
    if (!declared.has(name)) return { abort: `undeclared slot ${name}` };
  }

  // The permission check comes last so its message is not pre-empted by a
  // narrower complaint, and it is absolute: `allow` is set by the caller, never
  // by the model.
  if (sawSynthesize && req.allow !== "synthesize") {
    return { abort: "synthesis is not permitted at this node" };
  }

  return {
    ...(choose !== undefined ? { choose } : {}),
    ...(Object.keys(bind).length > 0 ? { bind } : {}),
    ...(sawSynthesize ? { synthesize } : {}),
  };
}
