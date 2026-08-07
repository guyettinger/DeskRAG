/**
 * Typed text runs, coalesced at SESSION scope for retrieval.
 *
 * A run is a stretch of composed text — a sentence, a search box, a commit
 * message — bounded by the things that actually end one: moving to another
 * application, issuing a command, or stopping for long enough that the next
 * keystroke is a new thought.
 *
 * WHY THIS IS NOT `groupGestures`. That function also emits text runs, and the
 * digest used to call it per segment. But it flushes on ANY non-key event
 * (`gestures.ts`: `if (e.kind !== "key_down" && e.kind !== "key_up")
 * flushText()`), because a replayable `type` action must be a contiguous
 * keystroke sequence — a mouse move in the middle genuinely ends it. And the
 * digest fed it one SEGMENT's events at a time, while `action` cuts at every
 * visual state change, and typing IS a visual state change.
 *
 * The two together shredded typed text. Measured on a real recording of someone
 * typing "This is a test of the emergency broadcast system": the digests read
 * `typed "this is"`, `typed "a test"`, `typed "of the"` — the phrase existed in
 * no segment, so no query for it could ever match, and the only place the
 * sentence survived was the VLM caption.
 *
 * So the grouping POLICY differs by purpose, deliberately. What is NOT
 * duplicated is the part that would drift: characters still come from
 * `resolveKeys`, the one decoder, which owns the keymap, the modifier rule and
 * the command-key exclusions.
 */

import { BACKSPACE_SCANCODE } from "../capture/env/keymap.js";
import type { Keymap } from "../capture/env/types.js";
import { resolveKeys } from "../trace/lift.js";
import type { TraceEvent } from "../trace/types.js";

/** One stretch of composed text, with the extent it was actually typed over. */
export interface TypedRun {
  text: string;
  tMonoStart: number;
  tMonoEnd: number;
}

export interface TypedRunOptions {
  /**
   * Idle gap that ends a run. Defaults to the segmenter's own `dwell_gap`
   * (3s) — the repo already calls that "activity resumed after a long idle",
   * and typed text should not disagree with segmentation about what a pause is.
   */
  runGapMs?: number;
}

export const DEFAULT_RUN_GAP_MS = 3_000;

interface KeyData {
  char?: string;
  keycode?: number;
  modifiers?: string[];
}

/**
 * Coalesce a session's key events into text runs.
 *
 * Ends a run on: a focus change (text composed in another app is another run), a
 * command chord (⌘S is an instruction, not content), or a gap of `runGapMs`.
 * Mouse events do NOT end one — clicking to fix a typo or reposition the caret
 * is part of composing the same sentence, which is exactly where this policy
 * departs from `groupGestures`.
 *
 * Returns [] when no keymap is known. Never guesses a layout, the same rule
 * `resolveKeys` and the replay executor's `type` step follow.
 */
export function typedRuns(
  events: readonly TraceEvent[],
  keymapAt: (tMono: number) => Keymap | undefined,
  opts: TypedRunOptions = {},
): TypedRun[] {
  const gap = opts.runGapMs ?? DEFAULT_RUN_GAP_MS;
  const sorted = [...events].sort((a, b) => a.tMono - b.tMono);
  const resolved = resolveKeys(sorted, keymapAt);

  const runs: TypedRun[] = [];
  let current: TypedRun | undefined;
  const flush = (): void => {
    if (current && current.text.trim().length > 0) runs.push(current);
    current = undefined;
  };

  for (const e of resolved) {
    if (e.kind === "focus_change") {
      flush();
      continue;
    }
    if (e.kind !== "key_down") continue;

    const d = e.data !== null && typeof e.data === "object" ? (e.data as KeyData) : {};
    const mods = Array.isArray(d.modifiers) ? d.modifiers : [];
    // A command consumes nothing and is not content — resolveChar leaves its
    // modifiers in place precisely so this stays distinguishable.
    if (mods.length > 0) {
      flush();
      continue;
    }

    // BACKSPACE IS APPLIED, so the run is what ended up on screen rather than
    // the keystrokes that produced it. Measured on a real recording: without it
    // the run read "this is a test of the mergeemergency braoadcast system" —
    // the typist's own corrections left in — and a query for "emergency
    // broadcast" matched none of it. This is exactly where a retrieval run and
    // a replayable `type` action must differ: replay has to reproduce the
    // keystrokes INCLUDING the correction; search wants the result.
    if (d.keycode === BACKSPACE_SCANCODE) {
      // Nothing to delete means it ate text typed before this run began; that
      // text is not ours to guess at, so it is simply a no-op.
      if (current !== undefined && current.text.length > 0) {
        current.text = current.text.slice(0, -1);
        current.tMonoEnd = e.tMono;
      }
      continue;
    }
    if (d.char === undefined || d.char.length === 0) continue;

    if (current !== undefined && e.tMono - current.tMonoEnd > gap) flush();
    if (current === undefined) {
      current = { text: d.char, tMonoStart: e.tMono, tMonoEnd: e.tMono };
    } else {
      current.text += d.char;
      current.tMonoEnd = e.tMono;
    }
  }
  flush();

  return runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, " ").trim() }));
}

/**
 * The runs overlapping [tMonoStart, tMonoEnd), each as its FULL text.
 *
 * Full, not the fragment that falls inside the window — that is the whole
 * point. Every segment a run passes through is part of composing that text, so
 * each one is a legitimate answer to a query for the phrase, and the fragment is
 * an answer to nothing. It is the same relationship `transcript_clip` records in
 * the other direction: a segment's span is not the span of the signal inside it.
 */
export function typedTextOverlapping(
  runs: readonly TypedRun[],
  tMonoStart: number,
  tMonoEnd: number,
): string[] {
  return runs
    .filter((r) => r.tMonoStart < tMonoEnd && r.tMonoEnd >= tMonoStart)
    .map((r) => r.text);
}
