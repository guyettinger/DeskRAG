/**
 * AX tree -> predicate set. A node's identity IS its predicate set, so anything
 * volatile in here — a clock, a badge count, a row total — makes every visit to
 * the same state look like a new state and the graph never merges. The filter is
 * deliberately aggressive: dropping a stable predicate costs a little identity
 * precision, keeping a volatile one costs merging entirely.
 *
 * Pure: no store, no clock, no I/O.
 */

import { nestAxElements } from "../capture/ax/tree.js";
import type { Predicate, UIElement } from "./types.js";
import { REACH_BY_KIND } from "./types.js";

export interface PredicateContext {
  /** Focused application name, from a `focus_change` event. */
  app?: string;
  windowTitle?: string;
  /** Assertable — recorded so replay can refuse on a different monitor setup. */
  displays?: { id: string; w: number; h: number }[];
  /** Assertable — paths the recording depended on existing. */
  files?: string[];
  maxAxPredicates?: number;
}

/**
 * 32 was too small, measured: two DIFFERENT GitHub pages in Chrome (a pull
 * request and a repository home) both truncated to the same 32 predicates and
 * produced IDENTICAL sets — a wrong merge, which is silent corruption rather
 * than a visible redundant node. Candidates sort shallowest-first, so the budget
 * went entirely to browser chrome and nothing page-specific survived.
 *
 * At 64 the same two pages yield 61 and 62 predicates and differ by 25 of them,
 * on page-specific controls ("Edit title" vs "Add file") already covered by
 * STABLE_ROLES. The heaviest tree measured (973 elements) produces 62, so 64 is
 * above the observed ceiling rather than merely above the observed collision.
 *
 * Only web content came close: TextEdit produced 19 predicates and the Electron
 * app 14, so this raises nothing for native apps.
 */
export const DEFAULT_MAX_AX_PREDICATES = 64;

/**
 * Roles whose presence says something durable about which screen you are on.
 * Containers and decorative text are excluded: they are ubiquitous, so they add
 * no discriminating power while inflating every set.
 *
 * Stored WITHOUT the "AX" prefix, because that is the shape real data has: the
 * Swift sidecar strips it (`ax-dump.swift`, `rawRole.dropFirst(2)`). Matching the
 * prefixed spelling meant no recording ever produced an ax predicate, so every
 * boundary in an app looked like one state and the graph could not merge —
 * `axFilter` already learned this and normalizes for the same reason.
 */
const STABLE_ROLES: ReadonlySet<string> = new Set([
  // "Window" is deliberately ABSENT. A window's label is its title, which is
  // document or page IDENTITY rather than state: TextEdit reported
  // `Window("Untitled.rtf")` and Chrome the full page title. Keeping it meant a
  // node recorded in one document could never be located in another, even
  // though the UI is identical and the recorded task is document-independent.
  // Measured live: `n2` missed by exactly this plus `window(title=...)` while 16
  // of its 19 predicates held. `Sheet` and `Dialog` stay — their titles name a
  // state ("Open", "Save") rather than which file you happen to have open.
  "Sheet",
  "Dialog",
  "Button",
  "PopUpButton",
  "CheckBox",
  "RadioButton",
  "TextField",
  "TextArea",
  "SecureTextField",
  "ComboBox",
  "MenuItem",
  "MenuButton",
  // "TabGroup" is deliberately ABSENT. A browser labels one with the NAME OF A
  // COLLAPSED TAB GROUP, which is session state — measured on a real recording
  // as 7 of one node's 61 predicates, alongside the 20 tabs below.
  "Toolbar",
  "SearchField",
]);

/**
 * Canonical role: unprefixed. Applied to the predicate ARGS too, not just the
 * match, so the two spellings key identically — a change of AX source must not
 * silently stop merging.
 */
export const canonicalRole = (role: string): string => role.replace(/^AX/, "");

const VOLATILE_PATTERNS: readonly RegExp[] = [
  /\d{1,2}:\d{2}/, //           a clock, or a duration
  /\(\s*\d+\s*\)/, //           "Inbox (14)"
  /^\s*[\d.,]+\s*%?\s*$/, //    a bare number or percentage
  /\b\d+\s+(unread|items?|messages?|results?|files?|photos?|selected)\b/i,
  /\b(just now|\d+\s+(seconds?|minutes?|hours?|days?)\s+ago)\b/i,
  /\b\d+\s*(KB|MB|GB|TB)\b/i,
  // A document's unsaved-changes indicator (TextEdit's "Edited" MenuButton).
  // Exactly the clock/badge-count class this filter exists for: it appears the
  // moment you type and vanishes on save, so a node recorded in a dirty document
  // could never be located in a clean one. Anchored, so "Edited by Sam" — a
  // label describing content rather than dirty state — is unaffected.
  /^\s*(Edited|Modified)\s*$/,
];

export function isVolatileLabel(label: string): boolean {
  return VOLATILE_PATTERNS.some((re) => re.test(label));
}

/** Canonical string form, so predicate sets compare as sets of strings. */
export function predicateKey(p: Predicate): string {
  const args = Object.keys(p.args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(p.args[k])}`)
    .join(",");
  return `${p.kind}(${args})`;
}

export function samePredicateSet(a: readonly Predicate[], b: readonly Predicate[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a.map(predicateKey));
  if (left.size !== a.length) {
    // Duplicates would make size comparison lie; fall back to multiset compare.
    const sortedA = a.map(predicateKey).sort();
    const sortedB = b.map(predicateKey).sort();
    return sortedA.every((k, i) => k === sortedB[i]);
  }
  return b.every((p) => left.has(predicateKey(p)));
}

/**
 * Is this element part of a browser's tab strip?
 *
 * A browser exposes every open tab as a `RadioButton` labelled with the page
 * title, nested under the tab strip's `TabGroup`. That is SESSION state, not
 * application state — the same class as a clock or a badge count, one level up.
 * Measured on a real recording: 27 of one Chrome node's 61 predicates were tabs
 * and tab groups, so the node could only ever verify with the same 20 pages
 * open. The first live multi-segment replay stopped there.
 *
 * Keyed on the TabGroup ANCESTOR rather than on the role or the label, because
 * that is structural: measured 27/27 of the tabs sit under one, while a radio
 * button in a preferences pane does not. Guessing from label shape would be a
 * heuristic tuned on one application, which is how the anchor ladder was
 * falsified twice.
 */
function inTabStrip(el: UIElement, all: readonly UIElement[]): boolean {
  let cur: UIElement | undefined = el;
  // Bounded: a malformed parent chain must not spin.
  for (let guard = 0; guard < 64 && cur?.parent !== undefined; guard++) {
    cur = all[cur.parent];
    if (cur !== undefined && canonicalRole(cur.role) === "TabGroup") return true;
  }
  return false;
}

export function extractPredicates(
  ax: readonly UIElement[],
  ctx: PredicateContext = {},
): Predicate[] {
  const out: Predicate[] = [];
  const add = (kind: Predicate["kind"], args: Predicate["args"]): void => {
    out.push({ kind, args, reach: REACH_BY_KIND[kind] });
  };

  if (ctx.app !== undefined && ctx.app.length > 0) add("app", { app: ctx.app });
  // `ctx.windowTitle` is deliberately NOT emitted as a predicate. A title is
  // document or page identity, not state — see STABLE_ROLES above — and as a
  // node predicate it made every recording unusable outside the exact file it
  // was recorded against. The field stays on the context because callers still
  // carry the title for display and debugging; this is the one place that
  // decides it is not part of identity.
  for (const d of ctx.displays ?? []) add("display", { id: d.id, w: d.w, h: d.h });
  for (const f of ctx.files ?? []) add("file", { path: f });

  if (ax.length > 0) {
    const nested = nestAxElements(ax);
    const focused = nested.find((e) => e.focused === true);
    if (
      focused !== undefined &&
      STABLE_ROLES.has(canonicalRole(focused.role)) &&
      !inTabStrip(focused, nested)
    ) {
      add("ax_focused", labelArgs(focused));
    }

    // Deterministic order independent of input order: shallowest first, then
    // role, then label. Two captures of the same screen must yield the same
    // truncation, or the cap itself becomes a source of false mismatches.
    const candidates = nested
      .filter((e) => STABLE_ROLES.has(canonicalRole(e.role)))
      .filter((e) => !inTabStrip(e, nested))
      .filter((e) => e.label !== undefined && e.label.length > 0 && !isVolatileLabel(e.label))
      .sort(
        (a, b) =>
          (a.depth ?? 0) - (b.depth ?? 0) ||
          canonicalRole(a.role).localeCompare(canonicalRole(b.role)) ||
          (a.label ?? "").localeCompare(b.label ?? ""),
      );

    const seen = new Set<string>();
    const cap = ctx.maxAxPredicates ?? DEFAULT_MAX_AX_PREDICATES;
    for (const e of candidates) {
      const args = labelArgs(e);
      const key = `${args.role} ${args.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add("ax_exists", args);
      if (seen.size >= cap) break;
    }
  }

  return out;
}

function labelArgs(e: UIElement): { role: string; label: string } {
  return { role: canonicalRole(e.role), label: e.label ?? "" };
}
