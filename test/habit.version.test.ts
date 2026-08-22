import { describe, expect, it } from "vitest";
import {
  INITIAL_VERSION,
  MAX_HISTORY,
  bumpVersion,
  type HabitRevision,
} from "../app/src/main/habit-version.js";

describe("bumpVersion", () => {
  it("starts a habit that has none at the initial version, without inventing history", () => {
    // A doc written before versioning existed has neither field. It is not
    // retroactively given a past it did not have.
    const out = bumpVersion(undefined, [], "the recorded steps changed", 1000);
    expect(out.version).toBe("0.1.1");
    expect(out.history).toEqual([
      { at: 1000, version: "0.1.1", what: "the recorded steps changed" },
    ]);
  });

  it("moves ONLY the patch position", () => {
    // Nothing here knows what a breaking change to a habit would be, so the two
    // positions that would claim to are never touched. Saying "0.2.0" would be
    // asserting a distinction nothing computes.
    let v = INITIAL_VERSION;
    for (let i = 0; i < 12; i += 1) v = bumpVersion(v, [], "x", i).version;
    expect(v).toBe("0.1.12");
  });

  it("appends to history, newest last, each entry naming what moved", () => {
    const a = bumpVersion(INITIAL_VERSION, [], "prose regenerated", 1);
    const b = bumpVersion(a.version, a.history, "re-bound to a different route", 2);
    expect(b.history.map((h) => h.what)).toEqual([
      "prose regenerated",
      "re-bound to a different route",
    ]);
    expect(b.history.map((h) => h.version)).toEqual(["0.1.1", "0.1.2"]);
  });

  it("keeps history BOUNDED, dropping the oldest", () => {
    // An unbounded list inside a JSON column grows with every re-index that
    // moves the steps, and nothing would ever prune it.
    let version = INITIAL_VERSION;
    let history: HabitRevision[] = [];
    for (let i = 0; i < MAX_HISTORY + 5; i += 1) {
      const out = bumpVersion(version, history, `change ${i}`, i);
      version = out.version;
      history = out.history;
    }
    expect(history).toHaveLength(MAX_HISTORY);
    expect(history[0]!.what).toBe("change 5");
    expect(history.at(-1)!.what).toBe(`change ${MAX_HISTORY + 4}`);
  });

  it("tolerates a malformed stored version rather than throwing on a read", () => {
    // The column is opaque JSON that older builds and hand edits can both reach.
    // Refusing to render a habit because its version is odd would be worse than
    // restarting the count, and the history still says what happened.
    expect(bumpVersion("not.a.version", [], "x", 1).version).toBe("0.1.1");
    expect(bumpVersion("", [], "x", 1).version).toBe("0.1.1");
  });

  it("does not mutate the history it was given", () => {
    const history: HabitRevision[] = [{ at: 1, version: "0.1.1", what: "first" }];
    bumpVersion("0.1.1", history, "second", 2);
    expect(history).toHaveLength(1);
  });
});
