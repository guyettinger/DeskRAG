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
