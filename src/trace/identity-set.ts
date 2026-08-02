/**
 * A node's identity: what the task does next, not what happens to be on screen.
 *
 * A predicate set sized for MERGING (is this a new state?) was being reused for
 * LOCATING (am I here again?), and those pull opposite ways —
 * `DEFAULT_MAX_AX_PREDICATES` went 32 -> 64 to stop two GitHub pages merging
 * wrongly, which is the same move that made a node unlocatable. Deriving
 * identity from the task instead needs no cap and no page-vs-chrome heuristic:
 * content the recording never touched is excluded by construction.
 *
 * Lives apart from `predicates.ts` because it consumes EDGES, which predicate
 * extraction must not know about.
 *
 * Pure: no store, no clock, no I/O.
 */

import { predicateKey } from "./predicates.js";
import type { Anchor, Predicate, TraceEdge } from "./types.js";

export interface IdentityInput {
  /** Everything the tree yielded at this boundary. */
  observed: readonly Predicate[];
  /** Edges leaving this node — what the task can do from here. */
  outgoing: readonly TraceEdge[];
  /** Edges arriving — their waits assert what this state is. */
  incoming: readonly TraceEdge[];
}

/**
 * Predicate keys an anchor could match, BEST FIRST — mirroring `LAYER_CEILING`,
 * where an identifier ceilings at 1.0 and a label at 0.8.
 *
 * Both are offered rather than only the best, because an anchor records what the
 * element had at capture time while the observation records what the tree
 * yielded, and the two can disagree. Trying the identifier and falling back to
 * the label is the same ladder `resolveAnchor` walks at replay.
 */
function anchorKeys(a: Anchor): string[] {
  const ax = a.ax;
  if (ax === undefined) return [];
  // Real data carries no "AX" prefix; matching the prefixed spelling has already
  // produced zero predicates from every recording once in this repo.
  const role = ax.role.replace(/^AX/i, "");
  const keys: string[] = [];
  if (ax.identifier !== undefined && ax.identifier.length > 0) {
    keys.push(
      predicateKey({
        kind: "ax_exists",
        args: { role, identifier: ax.identifier },
        reach: "achievable",
      }),
    );
  }
  if (ax.label !== undefined && ax.label.length > 0) {
    keys.push(
      predicateKey({ kind: "ax_exists", args: { role, label: ax.label }, reach: "achievable" }),
    );
  }
  return keys;
}

/** Every element the given edges' actions target. */
function anchorsOf(edges: readonly TraceEdge[]): Anchor[] {
  const out: Anchor[] = [];
  for (const e of edges) {
    for (const a of e.actions) {
      switch (a.kind) {
        case "click":
        case "hover":
        case "scroll":
          out.push(a.anchor);
          break;
        case "drag":
          // Both ends: each is an element the task requires to exist here.
          out.push(a.from, a.to);
          break;
        default:
          break;
      }
    }
  }
  return out;
}

export function identityPredicates(input: IdentityInput): Predicate[] {
  const byKey = new Map(input.observed.map((q) => [predicateKey(q), q]));
  const out: Predicate[] = [];
  const taken = new Set<string>();
  /** Adopt an observed predicate by key. Absent means it was not actually true. */
  const take = (key: string): boolean => {
    if (taken.has(key)) return true;
    const found = byKey.get(key);
    if (found === undefined) return false;
    taken.add(key);
    out.push(found);
    return true;
  };

  // `app` always: one predicate, cheap, and highly discriminating ACROSS
  // applications — though useless within one, which `isLocatable` accounts for.
  for (const q of input.observed) if (q.kind === "app") take(predicateKey(q));
  // For a browser the real application is the site. Without this, two recordings
  // of the same action on different pages would merge into one node.
  for (const q of input.observed) if (q.kind === "url") take(predicateKey(q));

  // What the task touches. The first key an anchor offers that is actually
  // present wins, so an identifier beats a label exactly as the ladder ranks.
  for (const a of anchorsOf(input.outgoing)) {
    for (const key of anchorKeys(a)) if (take(key)) break;
  }

  // Typing goes to whatever is focused, so focus is part of this state. Without
  // a `type` it is incidental — where the caret happened to be.
  if (input.outgoing.some((e) => e.actions.some((a) => a.kind === "type"))) {
    for (const q of input.observed) if (q.kind === "ax_focused") take(predicateKey(q));
  }

  // Waits from the INCOMING edge. A `wait until app(Chrome)` asserts something
  // about where the edge ARRIVES, so it describes this node; reading them from
  // the outgoing edge would attach the next state's assertion to this one — the
  // same off-by-one that made boundary snapshots describe the previous
  // application. Filtered by the observation, which is also what drops a wait
  // describing a transient mid-edge condition rather than the arrival.
  for (const e of input.incoming) {
    for (const a of e.actions) if (a.kind === "wait") take(predicateKey(a.until));
  }

  return out;
}

/**
 * Can this node answer "which state am I in?".
 *
 * `app` is shared by every node in an application, so it has zero discriminating
 * power for the question LOCATING asks — while being a perfectly good answer to
 * the question VERIFYING asks ("did I reach Chrome?"). Stated as a rule rather
 * than a tunable count, because a count invites tuning.
 */
export function isLocatable(predicates: readonly Predicate[]): boolean {
  return predicates.some((q) => q.kind !== "app");
}
