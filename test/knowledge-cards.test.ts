import { describe, expect, it } from "vitest";
import {
  attributionChip,
  attributionNote,
  caveatLines,
  corpusLines,
  evidenceLine,
  lastSeen,
} from "../app/src/renderer/src/knowledge-cards.js";
import type { KnowledgeDTO, KnowledgeFactDTO } from "../app/src/shared/types.js";

/**
 * The Knowledge card's own wording. Pure, so it is `.ts` and tested here rather
 * than read off a screenshot — `routes-view.ts` sets the same precedent.
 *
 * The VALUE's label is not tested here because it is not minted here:
 * `knowledge-view.ts` renders it once, in main, so this screen and `list_facts`
 * cannot disagree about the one string they are both about.
 */

const fact = (over: Partial<KnowledgeFactDTO> = {}): KnowledgeFactDTO => ({
  id: "display_topology",
  kind: "display_change",
  title: "Display setups",
  attribution: "ambient",
  projected: false,
  values: [],
  observations: 0,
  unlisted: 0,
  unidentified: 0,
  current: null,
  currentSince: null,
  reason: "…",
  ...over,
});

describe("the attribution chip", () => {
  it("says an ambient fact keeps the recorder's own stretches", () => {
    // Measured: excluding them costs 6 of 12 recordings their only display and
    // keymap observation. A card that cannot say so states one display setup
    // where there are two and cannot explain why.
    expect(attributionChip(fact())).toBe("ambient");
    expect(attributionNote(fact())).toMatch(/does not apply/);
  });

  it("says a focused-app fact does not", () => {
    const f = fact({ attribution: "focused-app" });
    expect(attributionChip(f)).toBe("recorder excluded");
    expect(attributionNote(f)).toMatch(/left out/);
  });
});

describe("a value's evidence", () => {
  // Local noon, so the rendered day is the same wherever the suite runs — and so
  // it matches what `knowledge-text.ts` prints for the same moment.
  const SEEN = new Date(2026, 7, 29, 12).getTime();
  const value = {
    key: '{"w":1920}',
    label: "1920×1080 @2× primary (0,0)",
    isCurrent: false,
    stability: { tier: "core" as const, sessions: 11, reason: "…" },
    observations: 11,
    lastObservedAt: SEEN,
    variants: 7,
  };

  it("is a word, a count of recordings and a date — never a ratio", () => {
    const line = evidenceLine(value);
    expect(line).toBe(`core · 11 recordings · ${lastSeen(SEEN)} · 7 payloads`);
    expect(line).not.toMatch(/%/);
  });

  it("says nothing about payloads when the fold merged nothing", () => {
    // "1 payload" on every row of most of the facts is noise, not disclosure.
    expect(evidenceLine({ ...value, variants: 1 })).toBe(
      `core · 11 recordings · ${lastSeen(SEEN)}`,
    );
  });

  it("calls a withheld tier withheld rather than showing it as zero", () => {
    // A graph lifted before provenance existed is a different state from one
    // whose recordings were all deleted, and `stabilityOf` keeps them apart.
    expect(
      evidenceLine({ ...value, stability: { tier: null, sessions: 0, reason: "…" }, variants: 1 }),
    ).toBe(`withheld · 0 recordings · ${lastSeen(SEEN)}`);
  });

  it("calls an undatable value undated rather than dating it", () => {
    // THE DATE IS WHAT MAKES THE ORDER READABLE, so a missing one has to say so
    // — a blank would read as "seen just now", which is the opposite claim.
    expect(evidenceLine({ ...value, lastObservedAt: null, variants: 1 })).toBe(
      "core · 11 recordings · undated",
    );
  });
});

describe("the disclosures", () => {
  it("counts what could not be placed and what is not shown", () => {
    const lines = caveatLines(fact({ unidentified: 3, unlisted: 16 }));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/3 observations could not be placed/);
    // FOLDED AND COUNTED, never silently cut — `IndexShare`'s rule, and the
    // reason a card can carry a 28-value fact at all.
    expect(lines[1]).toMatch(/16 further values not shown/);
  });

  it("says nothing when there is nothing to disclose", () => {
    expect(caveatLines(fact())).toEqual([]);
  });
});

describe("the corpus footer", () => {
  const dto = (over: Partial<KnowledgeDTO> = {}): KnowledgeDTO => ({
    facts: [],
    recordings: 12,
    excludedApps: ["DeskRAG", "Electron"],
    excludedEvents: 253,
    unattributable: 0,
    ...over,
  });

  it("names the excluded applications rather than counting them", () => {
    // `flows()`'s reasoning, and this is a footer with room for the sentence the
    // Flows chip did not have: a reader who finds their own application gone is
    // entitled to that answer without opening Settings.
    const lines = corpusLines(dto());
    expect(lines[0]).toMatch(/Derived from 12 recordings/);
    expect(lines[1]).toMatch(/253 events left out .*\(DeskRAG, Electron\)/);
    expect(lines[1]).toMatch(/ambient keep theirs/);
  });

  it("says when a recording could not be attributed at all", () => {
    // `active-win` off: `excludeFocusedApps` is a NO-OP there by design, and the
    // count is the only thing that says the exclusion did not run.
    expect(corpusLines(dto({ unattributable: 1 })).join(" ")).toMatch(
      /1 recording carried no focus events/,
    );
  });

  it("says nothing about an exclusion that is not configured", () => {
    expect(corpusLines(dto({ excludedApps: [], excludedEvents: 0 }))).toHaveLength(1);
  });
});
