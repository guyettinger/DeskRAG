/**
 * Reading the real store WITHOUT opening it.
 *
 * The probes that measure routes and transfer both need the trace graph and the
 * recordings behind it, and neither may open `DualStore`: it drops retired
 * vector spaces on open, and DeskRAGApp takes no single-instance lock, so a
 * probe that opened the store properly would be a second owner of SQLite and
 * LanceDB while the app is running. `better-sqlite3` in `readonly` mode is the
 * only way in that cannot change what it is measuring.
 *
 * The marshalling here mirrors `store.getGraph`, and that is the one thing in
 * these probes that could drift from the app. It is deliberately dumb — JSON
 * columns parsed, sources grouped — so everything with a JUDGEMENT in it stays
 * in the single implementation the app actually runs.
 *
 * One copy, imported by every probe that reads the graph, for the reason
 * `flowWalks` is one copy. The PATH it is opened at lives in `paths.ts`, and
 * `openFlows` in `flows.ts` is what callers should reach for — this is the
 * marshalling layer underneath it.
 */

import type Database from "better-sqlite3";
import type { Graph } from "../../src/trace/types.js";

/** `store.getGraph`, read-only and without the store. See the header. */
export function readGraph(db: Database.Database, graphId: string): Graph | undefined {
  const head = db.prepare("SELECT id, entry_node FROM trace_graph WHERE id = ?").get(graphId) as
    | { id: string; entry_node: string }
    | undefined;
  if (head === undefined) return undefined;

  const group = <R, V>(rows: R[], key: (r: R) => string, val: (r: R) => V): Map<string, V[]> => {
    const out = new Map<string, V[]>();
    for (const r of rows) {
      const k = key(r);
      const list = out.get(k);
      if (list === undefined) out.set(k, [val(r)]);
      else list.push(val(r));
    }
    return out;
  };

  const nodeSources = group(
    db
      .prepare("SELECT * FROM trace_node_source WHERE graph_id = ? ORDER BY node_id ASC, ord ASC")
      .all(graphId) as { node_id: string; session_id: string; t_mono: number }[],
    (r) => r.node_id,
    (r) => ({ sessionId: r.session_id, tMono: r.t_mono }),
  );
  const edgeSources = group(
    db
      .prepare("SELECT * FROM trace_edge_source WHERE graph_id = ? ORDER BY edge_id ASC, ord ASC")
      .all(graphId) as {
      edge_id: string;
      session_id: string;
      t_mono_start: number;
      t_mono_end: number;
    }[],
    (r) => r.edge_id,
    (r) => ({ sessionId: r.session_id, tMonoStart: r.t_mono_start, tMonoEnd: r.t_mono_end }),
  );

  const nodeRows = db
    .prepare("SELECT * FROM trace_node WHERE graph_id = ? ORDER BY ord ASC")
    .all(graphId) as {
    id: string;
    predicates: string;
    visual: string | null;
    intervene: string;
    observations: number;
  }[];
  const edgeRows = db
    .prepare("SELECT * FROM trace_edge WHERE graph_id = ? ORDER BY ord ASC")
    .all(graphId) as {
    id: string;
    from_node: string;
    to_node: string;
    actions: string;
    guard: string | null;
    provenance: string;
    observations: number;
    attempts: number;
    successes: number;
  }[];

  return {
    id: head.id,
    entry: head.entry_node,
    nodes: nodeRows.map((r) => ({
      id: r.id,
      predicates: JSON.parse(r.predicates),
      ...(r.visual !== null ? { visual: JSON.parse(r.visual) } : {}),
      intervene: r.intervene,
      observations: r.observations,
      ...(nodeSources.has(r.id) ? { sources: nodeSources.get(r.id)! } : {}),
    })),
    edges: edgeRows.map((r) => ({
      id: r.id,
      from: r.from_node,
      to: r.to_node,
      actions: JSON.parse(r.actions),
      ...(r.guard !== null ? { guard: JSON.parse(r.guard) } : {}),
      provenance: r.provenance,
      observations: r.observations,
      outcomes: { attempts: r.attempts, successes: r.successes },
      ...(edgeSources.has(r.id) ? { sources: edgeSources.get(r.id)! } : {}),
    })),
    slots: (
      db.prepare("SELECT * FROM trace_slot WHERE graph_id = ? ORDER BY ord ASC").all(graphId) as {
        name: string;
        samples: string;
      }[]
    ).map((r) => ({ name: r.name, samples: JSON.parse(r.samples), secret: false as const })),
  } as Graph;
}

