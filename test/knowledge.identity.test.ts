import { describe, expect, it } from "vitest";
import { currentValue, type KnowledgeSource } from "../src/knowledge/facts.js";
import {
  foldByIdentity,
  stableKey,
  type Identity,
  type Observation,
} from "../src/knowledge/identity.js";

/** A source: which recording saw it, and how far into that recording. */
const at = (sessionId: string, tMono = 0): KnowledgeSource => ({ sessionId, tMono });

const obs = <R>(value: R, sessionId: string, tMono = 0): Observation<R> => ({
  value,
  source: at(sessionId, tMono),
});

/** A payload with a decoy: `id` is re-minted per session, `w`/`h` are not. */
interface Screen {
  id: string;
  w: number;
  h: number;
}
const geometry: Identity<Screen, { w: number; h: number }> = (s) => ({ w: s.w, h: s.h });

describe("stableKey", () => {
  it("is independent of object key order", () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
  });

  it("is sensitive to array order, because order is the identity's business", () => {
    expect(stableKey([1, 2])).not.toBe(stableKey([2, 1]));
  });

  it("omits an undefined property, so an optional field that is absent is absent", () => {
    expect(stableKey({ a: 1, b: undefined })).toBe(stableKey({ a: 1 }));
  });

  it("keeps an undefined array element positional, so a hole cannot shift its neighbours", () => {
    expect(stableKey([1, undefined, 2])).not.toBe(stableKey([1, 2]));
  });

  it('distinguishes the string "1" from the number 1', () => {
    expect(stableKey({ a: "1" })).not.toBe(stableKey({ a: 1 }));
  });

  it("throws rather than serializing something an identity should never return", () => {
    expect(() => stableKey({ f: () => 1 })).toThrow(/serialize/i);
    expect(() => stableKey({ n: Number.NaN })).toThrow(/finite/i);
  });
});

describe("foldByIdentity", () => {
  it("collapses payloads that differ only in a decoy field", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "185", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.value).toEqual({ w: 1920, h: 1080 });
  });

  it("unions the sources of every observation it folded", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "185", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    expect(f.values[0]!.sources.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("keeps the distinct raw payloads as variants, in first-observed order", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "185", w: 1920, h: 1080 }, "s1"), obs({ id: "180", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    expect(f.values[0]!.variants.map((v) => v.id)).toEqual(["185", "180"]);
  });

  it("does not duplicate a raw payload observed twice, but keeps both sources", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "206", w: 1920, h: 1080 }, "s1"), obs({ id: "206", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    expect(f.values[0]!.variants).toHaveLength(1);
    expect(f.values[0]!.sources).toHaveLength(2);
  });

  it("keeps genuinely different values apart", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "1", w: 1728, h: 1117 }, "s2")],
      geometry,
    );
    expect(f.values).toHaveLength(2);
  });

  it("counts an unidentifiable observation instead of dropping it silently", () => {
    const maybe: Identity<Screen, { w: number; h: number }> = (s) =>
      s.w === 0 ? null : { w: s.w, h: s.h };
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "x", w: 0, h: 0 }, "s2")],
      maybe,
    );
    expect(f.unidentified).toBe(1);
    expect(f.values).toHaveLength(1);
    expect(f.values[0]!.sources).toHaveLength(1);
  });

  it("returns an empty fact rather than throwing on no observations", () => {
    const f = foldByIdentity("display", [], geometry);
    expect(f).toEqual({ kind: "display", values: [], unidentified: 0 });
  });

  it("IS a KnowledgeFact, so cycle 0's resolver reads it unchanged", () => {
    const f = foldByIdentity(
      "display",
      [obs({ id: "180", w: 1920, h: 1080 }, "s1"), obs({ id: "185", w: 1920, h: 1080 }, "s2")],
      geometry,
    );
    const starts: Record<string, number> = { s1: 1000, s2: 2000 };
    const current = currentValue(f, "exclusive", (id) => starts[id]);
    expect(current.value).toEqual({ w: 1920, h: 1080 });
    expect(current.alternatives).toBe(0);
  });
});
