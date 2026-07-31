/**
 * The captured keyboard layout, read backwards: char -> keycode + modifiers.
 *
 * The capture spec's deciding constraint was that the mapping is needed in BOTH
 * directions — the lift goes keycode -> char, the executor goes char -> keycode
 * to replay a slot value. One keymap serves both; two mechanisms would drift.
 *
 * There is deliberately no fallback table. A static US-QWERTY map is silently
 * wrong for every non-US layout and for Dvorak/Colemak on US hardware, and wrong
 * text that looks right is the worst failure available here.
 *
 * Pure: no subprocess, no clock, no I/O.
 */

import type { Keymap } from "../capture/env/types.js";

export interface KeyStroke {
  keycode: number;
  modifiers: string[];
}

/** Column order in a Keymap entry, cheapest modifier set first. */
const COLUMNS: readonly string[][] = [[], ["shift"], ["alt"], ["alt", "shift"]];

/**
 * Char -> the cheapest stroke that produces it. Cheapest wins because a char
 * present in several columns (Return, Space, digits on many layouts) should be
 * typed without spurious modifiers held down.
 */
export function reverseKeymap(km: Keymap): Map<string, KeyStroke> {
  const out = new Map<string, KeyStroke>();
  for (const [rawCode, cols] of Object.entries(km.entries)) {
    const keycode = Number(rawCode);
    for (let i = 0; i < COLUMNS.length && i < cols.length; i++) {
      const ch = cols[i];
      if (ch === undefined || ch.length === 0) continue;
      const existing = out.get(ch);
      const modifiers = COLUMNS[i]!;
      if (existing === undefined || modifiers.length < existing.modifiers.length) {
        out.set(ch, { keycode, modifiers: [...modifiers] });
      }
    }
  }
  return out;
}

/**
 * Strokes for `text`, or null if ANY character is unmappable. Null rather than a
 * partial list: dropping a character types a different string, and the caller
 * turns null into a blocker rather than a guess.
 */
export function strokesFor(text: string, km: Keymap): KeyStroke[] | null {
  const rev = reverseKeymap(km);
  const out: KeyStroke[] = [];
  for (const ch of text) {
    const stroke = rev.get(ch);
    if (stroke === undefined) return null;
    out.push(stroke);
  }
  return out;
}
