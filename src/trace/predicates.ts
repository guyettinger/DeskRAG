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

export const DEFAULT_MAX_AX_PREDICATES = 32;

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
  "Window",
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
  "TabGroup",
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

export function extractPredicates(
  ax: readonly UIElement[],
  ctx: PredicateContext = {},
): Predicate[] {
  const out: Predicate[] = [];
  const add = (kind: Predicate["kind"], args: Predicate["args"]): void => {
    out.push({ kind, args, reach: REACH_BY_KIND[kind] });
  };

  if (ctx.app !== undefined && ctx.app.length > 0) add("app", { app: ctx.app });
  if (ctx.windowTitle !== undefined && ctx.windowTitle.length > 0 && !isVolatileLabel(ctx.windowTitle)) {
    add("window", { title: ctx.windowTitle });
  }
  for (const d of ctx.displays ?? []) add("display", { id: d.id, w: d.w, h: d.h });
  for (const f of ctx.files ?? []) add("file", { path: f });

  if (ax.length > 0) {
    const nested = nestAxElements(ax);
    const focused = nested.find((e) => e.focused === true);
    if (focused !== undefined && STABLE_ROLES.has(canonicalRole(focused.role))) {
      add("ax_focused", labelArgs(focused));
    }

    // Deterministic order independent of input order: shallowest first, then
    // role, then label. Two captures of the same screen must yield the same
    // truncation, or the cap itself becomes a source of false mismatches.
    const candidates = nested
      .filter((e) => STABLE_ROLES.has(canonicalRole(e.role)))
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
