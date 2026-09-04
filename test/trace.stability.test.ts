import { describe, expect, it } from "vitest";
import { CORE_SESSIONS, stabilityOf } from "../src/trace/stability.js";

const from = (...ids: string[]) => ids.map((sessionId) => ({ sessionId }));

describe("stabilityOf", () => {
  it("counts DISTINCT recordings, not observations", () => {
    // One recording that walked a loop twice is one recording. `observations`
    // would say two, which is why the tier never reads it.
    expect(stabilityOf(from("s1", "s1", "s1")).sessions).toBe(1);
    expect(stabilityOf(from("s1", "s1", "s1")).tier).toBe("prediction");
  });

  it("promotes at the core threshold and not before", () => {
    const ids = Array.from({ length: CORE_SESSIONS }, (_, i) => `s${i}`);
    expect(stabilityOf(from(...ids.slice(0, -1))).tier).toBe("prediction");
    expect(stabilityOf(from(...ids)).tier).toBe("core");
  });

  it("withholds the tier on a graph lifted before provenance existed", () => {
    const out = stabilityOf(undefined);
    expect(out.tier).toBeNull();
    expect(out.reason).toContain("before provenance");
  });

  it("distinguishes 'unknown' from 'every recording was deleted'", () => {
    // `[]` is a real answer — the graph knows its sources and there are none
    // left — where `undefined` is the absence of the feature.
    const gone = stabilityOf([]);
    expect(gone.tier).toBe("prediction");
    expect(gone.sessions).toBe(0);
    expect(gone.reason).not.toBe(stabilityOf(undefined).reason);
  });

  it("returns no fraction anywhere — a tier is a word and a count", () => {
    for (const out of [stabilityOf(undefined), stabilityOf([]), stabilityOf(from("a", "b", "c"))]) {
      expect(Number.isInteger(out.sessions)).toBe(true);
      expect(out.reason).not.toMatch(/\d+(\.\d+)?%|0\.\d+/);
    }
  });

  it("always states a reason", () => {
    for (const out of [stabilityOf(undefined), stabilityOf([]), stabilityOf(from("a"))]) {
      expect(out.reason.length).toBeGreaterThan(0);
    }
  });
});
