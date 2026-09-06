import { describe, expect, it } from "vitest";
import {
  currentValue,
  type KnowledgeFact,
  type KnowledgeSource,
  type ObservedValue,
  type SessionStartedAt,
} from "../src/knowledge/facts.js";

/** A source: which recording saw it, and how far into that recording. */
const at = (sessionId: string, tMono = 0): KnowledgeSource => ({ sessionId, tMono });

const val = <V>(value: V, ...sources: KnowledgeSource[]): ObservedValue<V> => ({ value, sources });

const fact = <V>(kind: string, ...values: ObservedValue<V>[]): KnowledgeFact<V> => ({ kind, values });

/** Session start times in wall-clock ms. A missing id is an UNDATABLE recording. */
const clock =
  (starts: Record<string, number>): SessionStartedAt =>
  (id) =>
    starts[id];

describe("currentValue — the exclusive path", () => {
  it("picks the most recently observed value", () => {
    const f = fact("keymap", val("ansi", at("s1")), val("iso", at("s2")));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000, s2: 2_000 }));
    expect(out.value).toBe("iso");
  });

  it("orders within one recording by t_mono, not just by session", () => {
    // Both observations are in s1, so session start alone cannot separate them.
    const f = fact("keymap", val("ansi", at("s1", 0)), val("iso", at("s1", 5_000)));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000 }));
    expect(out.value).toBe("iso");
  });

  it("ranks a value by its LATEST source, not its first", () => {
    const f = fact("keymap", val("ansi", at("s1"), at("s3")), val("iso", at("s2")));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000, s2: 2_000, s3: 3_000 }));
    expect(out.value).toBe("ansi");
  });

  it("discloses the alternatives rather than dropping them", () => {
    const f = fact("keymap", val("ansi", at("s1")), val("iso", at("s2")), val("dvorak", at("s3")));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000, s2: 2_000, s3: 3_000 }));
    expect(out.value).toBe("dvorak");
    expect(out.alternatives).toBe(2);
  });

  it("counts no alternatives for the only value observed", () => {
    const out = currentValue(fact("keymap", val("ansi", at("s1"))), "exclusive", clock({ s1: 1 }));
    expect(out.value).toBe("ansi");
    expect(out.alternatives).toBe(0);
  });
});

describe("currentValue — what it refuses", () => {
  it("refuses to name a current value for a coexisting fact", () => {
    // Docked and undocked are BOTH true. Newer-wins would delete a real one.
    const f = fact("display", val("one-up", at("s1")), val("docked", at("s2")));
    const out = currentValue(f, "coexisting", clock({ s1: 1_000, s2: 2_000 }));
    expect(out.value).toBeNull();
    expect(out.alternatives).toBe(2);
    expect(out.reason).toMatch(/at once|set/i);
  });

  it("declines on a tie rather than picking one", () => {
    const f = fact("keymap", val("ansi", at("s1")), val("iso", at("s2")));
    // Same absolute moment: s1 starts at 1000+500, s2 at 1500+0.
    const out = currentValue(f, "exclusive", clock({ s1: 1_000, s2: 1_500 }));
    const tie = currentValue(
      fact("keymap", val("ansi", at("s1", 500)), val("iso", at("s2", 0))),
      "exclusive",
      clock({ s1: 1_000, s2: 1_500 }),
    );
    expect(out.value).toBe("iso"); // control: not a tie
    expect(tie.value).toBeNull();
    expect(tie.reason).toMatch(/same|neither|declin/i);
  });

  it("discloses sources it cannot date without discarding the ranking", () => {
    const f = fact("keymap", val("ansi", at("s1")), val("iso", at("gone")));
    const out = currentValue(f, "exclusive", clock({ s1: 1_000 }));
    expect(out.value).toBe("ansi");
    expect(out.undated).toBe(1);
  });

  it("refuses when no recording can be dated at all", () => {
    const f = fact("keymap", val("ansi", at("gone")), val("iso", at("also-gone")));
    const out = currentValue(f, "exclusive", clock({}));
    expect(out.value).toBeNull();
    expect(out.undated).toBe(2);
    expect(out.reason).toMatch(/dated|order/i);
  });

  it("answers for a fact with no values at all", () => {
    const out = currentValue(fact<string>("keymap"), "exclusive", clock({}));
    expect(out.value).toBeNull();
    expect(out.alternatives).toBe(0);
    expect(out.undated).toBe(0);
    expect(out.reason.length).toBeGreaterThan(0);
  });

  it("always states a reason, on every path", () => {
    const outs = [
      currentValue(fact<string>("k"), "exclusive", clock({})),
      currentValue(fact("k", val("a", at("s1"))), "exclusive", clock({ s1: 1 })),
      currentValue(fact("k", val("a", at("s1"))), "coexisting", clock({ s1: 1 })),
      currentValue(fact("k", val("a", at("gone"))), "exclusive", clock({})),
    ];
    for (const out of outs) expect(out.reason.length).toBeGreaterThan(0);
  });

  it("returns no fraction anywhere — counts, never a ratio", () => {
    const f = fact("k", val("a", at("s1")), val("b", at("s2")), val("c", at("gone")));
    for (const ex of ["exclusive", "coexisting"] as const) {
      const out = currentValue(f, ex, clock({ s1: 1_000, s2: 2_000 }));
      expect(Number.isInteger(out.alternatives)).toBe(true);
      expect(Number.isInteger(out.undated)).toBe(true);
      expect(out.reason).not.toMatch(/\d+(\.\d+)?%|0\.\d+/);
    }
  });
});

describe("the barrel", () => {
  it("exports the Knowledge contract", async () => {
    const barrel = await import("../src/index.js");
    expect(typeof barrel.currentValue).toBe("function");
  });
});
