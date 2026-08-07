/**
 * Character resolution, in two halves.
 *
 * SCANCODE -> VIRTUAL KEYCODE is layout-INDEPENDENT: it identifies a physical
 * key. uiohook reports PC set-1 scancodes (Space = 57); macOS wants virtual
 * keycodes (Space = 49). A US user and a Dvorak user share this table exactly.
 *
 * VIRTUAL KEYCODE -> CHARACTER is layout-DEPENDENT and comes from the sidecar's
 * UCKeyTranslate dump. That split is why the fixed table below is not the "static
 * keymap" rejected during design: it encodes key positions, not what they type.
 *
 * Pure: no store, no clock, no I/O.
 */

import type { Keymap } from "./types.js";

/**
 * uiohook scancode -> macOS virtual keycode, for the text-entry core: letters,
 * the digit row, punctuation, space. Keys outside it (arrows, function keys,
 * modifiers) produce no character by definition and resolve to undefined, which
 * the caller reports as "no char" rather than guessing.
 */
const SCANCODE_TO_VK: Readonly<Record<number, number>> = {
  // letters
  30: 0, 48: 11, 46: 8, 32: 2, 18: 14, 33: 3, 34: 5, 35: 4, 23: 34, 36: 38,
  37: 40, 38: 37, 50: 46, 49: 45, 24: 31, 25: 35, 16: 12, 19: 15, 31: 1, 20: 17,
  22: 32, 47: 9, 17: 13, 45: 7, 21: 16, 44: 6,
  // digit row
  2: 18, 3: 19, 4: 20, 5: 21, 6: 23, 7: 22, 8: 26, 9: 28, 10: 25, 11: 29,
  // punctuation + space
  12: 27, 13: 24, 26: 33, 27: 30, 43: 42, 39: 41, 40: 39, 41: 50, 51: 43,
  52: 47, 53: 44, 57: 49,
};

export function macKeycodeFor(uiohookKeycode: number): number | undefined {
  return SCANCODE_TO_VK[uiohookKeycode];
}

/**
 * Backspace, in the same PC set-1 scancode space as the table above.
 *
 * Deliberately NOT in `SCANCODE_TO_VK`: it types no character, so `resolveChar`
 * must keep reporting "no char" for it. It lives here because this file is where
 * scancode facts belong — a second copy in `represent/` is the drift hazard the
 * ax-dump/ax-exec pair already paid for. `typedRuns` uses it to reconstruct what
 * ended up ON SCREEN; a replayable `type` action does not, since the keystrokes
 * it replays include the correction.
 */
export const BACKSPACE_SCANCODE = 14;

/** Column index into a keymap entry: [plain, shift, alt, altShift]. */
function columnFor(shift: boolean, alt: boolean): 0 | 1 | 2 | 3 {
  if (shift && alt) return 3;
  if (alt) return 2;
  if (shift) return 1;
  return 0;
}

/**
 * Resolve a keystroke to the character it denotes, plus the modifiers that
 * survive it. One rule: **a command consumes nothing.**
 *
 * cmd or ctrl present -> a command. Nothing is consumed, so the character comes
 * from the plain column and every modifier stays. `⌘S` is still the S key: the
 * character NAMES the key, it is not text that was typed.
 *
 * Otherwise -> shift/alt are CONSUMED selecting the column, and stripped from
 * the returned modifiers.
 *
 * Consume-and-strip is load-bearing, and so is its absence for commands.
 * `gestures.ts` reads `char` first and treats any surviving modifier as
 * chord-forming, so:
 *   - leaving shift on a capital would lift "A" as the chord shift+A;
 *   - withholding the character from a command would drop ⌘S entirely, since
 *     the no-char branch is checked before the chord branch.
 */
export function resolveChar(
  km: Keymap,
  uiohookKeycode: number,
  mods: readonly string[],
): { char?: string; modifiers: string[] } {
  const sorted = [...mods].sort();
  const isCommand = sorted.includes("cmd") || sorted.includes("ctrl");

  const vk = macKeycodeFor(uiohookKeycode);
  if (vk === undefined) return { modifiers: sorted };

  const entry = km.entries[vk];
  if (entry === undefined) return { modifiers: sorted };

  // A command consumes neither shift nor alt — ⌘⇧S keeps both.
  const shift = !isCommand && sorted.includes("shift");
  const alt = !isCommand && sorted.includes("alt");
  const char = entry[columnFor(shift, alt)];
  if (char === undefined || char.length === 0) return { modifiers: sorted };

  return { char, modifiers: isCommand ? sorted : [] };
}
