import { describe, expect, it } from "vitest";
import { isNonSpeechText } from "../src/represent/transcript/transcript-representer.js";

/**
 * MEASURED on the real store, which is the only reason this filter exists: of
 * 24 transcript clips, 22 were bracketed annotations and ZERO were plausible
 * speech. A desktop is a music-and-silence corpus far more often than a spoken
 * one, and computer audio roughly doubled the count.
 */
describe("whisper non-speech annotations", () => {
  for (const t of [
    "(soft music)",
    "(dramatic music)",
    "(light music)",
    "(upbeat music)",
    "(wind howling)",
    "[BLANK_AUDIO]",
    "  (soft music)  ",
    "*sighs*",
    "[ Silence ]",
  ]) {
    it(`drops ${JSON.stringify(t)}`, () => expect(isNonSpeechText(t)).toBe(true));
  }

  for (const t of [
    "there we go",
    "You",                       // the -91 dB hallucination: NO text rule catches this
    "click the (blue) button",   // brackets INSIDE speech are still speech
    "(soft music) and then I said hello",
    "save the file",
  ]) {
    it(`keeps ${JSON.stringify(t)}`, () => expect(isNonSpeechText(t)).toBe(false));
  }
});
