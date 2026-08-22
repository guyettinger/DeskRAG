import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";

/**
 * A habit is AUTHORED: written by a person, and reproducible by nothing.
 *
 * That is one claim with two halves, and both are asserted here. The row must
 * round-trip through a real SQLite file — including across a re-open, because
 * `CREATE TABLE IF NOT EXISTS` running on every open is the whole reason a table
 * addition is safe on an existing install. And the row must SURVIVE the two
 * calls whose job is to throw derived data away: `purgeDerived`, which is what
 * makes "re-index" mean re-index, and `deleteSession`, whose CASCADE reaches
 * most of the schema. If either one ever reaches this table it destroys prose no
 * rebuild can reproduce, and nothing else in the system would notice.
 */

let dir: string;
let store: DualStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "erag-habit-"));
  store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const doc = (name: string): string => JSON.stringify({ slug: name, body: "prose" });

describe("authored habits", () => {
  it("round-trips a habit", async () => {
    const id = ulid();
    const written = await store.putHabit({ id, state: "active", pinned: false, doc: doc("a") });

    expect(written.id).toBe(id);
    expect(written.state).toBe("active");
    expect(written.pinned).toBe(false);
    expect(written.doc).toBe(doc("a"));
    expect(store.getHabit(id)).toEqual(written);
    expect(store.listHabits()).toEqual([written]);
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(store.getHabit(ulid())).toBeUndefined();
  });

  // SQLite has no boolean. A column read back as 0/1 and handed to the app as a
  // number would be truthy for BOTH values, so `pinned: false` would pin.
  it("reads pinned back as a boolean, not as 0 or 1", async () => {
    const id = ulid();
    await store.putHabit({ id, state: "active", pinned: true, doc: doc("a") });
    expect(store.getHabit(id)?.pinned).toBe(true);

    await store.putHabit({ id, state: "active", pinned: false, doc: doc("a") });
    expect(store.getHabit(id)?.pinned).toBe(false);
  });

  it("upserts in place, keeping created_at and moving updated_at", async () => {
    const id = ulid();
    const first = await store.putHabit({ id, state: "active", pinned: false, doc: doc("a") });

    // The stamps are millisecond wall clock, so two writes inside one tick would
    // compare equal and prove nothing either way.
    await new Promise((r) => setTimeout(r, 2));
    const second = await store.putHabit({ id, state: "archived", pinned: true, doc: doc("b") });

    expect(store.listHabits()).toHaveLength(1);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(second.state).toBe("archived");
    expect(second.pinned).toBe(true);
    expect(second.doc).toBe(doc("b"));
  });

  it("lists newest-touched first", async () => {
    const older = ulid();
    const newer = ulid();
    await store.putHabit({ id: older, state: "active", pinned: false, doc: doc("a") });
    await new Promise((r) => setTimeout(r, 2));
    await store.putHabit({ id: newer, state: "active", pinned: false, doc: doc("b") });

    expect(store.listHabits().map((s) => s.id)).toEqual([newer, older]);

    // Touching the older one moves it to the front — an edit belongs at the top
    // of whatever band the screen draws it in.
    await new Promise((r) => setTimeout(r, 2));
    await store.putHabit({ id: older, state: "active", pinned: false, doc: doc("a2") });
    expect(store.listHabits().map((s) => s.id)).toEqual([older, newer]);
  });

  it("deletes only the habit it was asked for", async () => {
    const keep = ulid();
    const drop = ulid();
    await store.putHabit({ id: keep, state: "active", pinned: false, doc: doc("a") });
    await store.putHabit({ id: drop, state: "active", pinned: false, doc: doc("b") });

    await store.deleteHabit(drop);
    expect(store.listHabits().map((s) => s.id)).toEqual([keep]);

    // Deleting an id that is not there is not an error: the screen's Forget
    // button and a concurrent delete must not race into a throw.
    await expect(store.deleteHabit(drop)).resolves.toBeUndefined();
  });
});

/**
 * The half that matters, and the reason `AUTHORED_TABLES` exists as a fifth list
 * rather than being folded into OPERATIONAL.
 */
describe("a habit is neither captured nor derived", () => {
  it("survives purgeDerived and deleteSession", async () => {
    const sessionId = ulid();
    const id = ulid();
    await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
    await store.putSegments([
      {
        id: ulid(),
        sessionId,
        granularity: "action",
        tMonoStart: 0,
        tMonoEnd: 100,
        boundaryReason: "focus_change",
      },
    ]);
    await store.putHabit({ id, state: "active", pinned: false, doc: doc("a") });

    // A re-index of that recording throws its derived rows away.
    await store.purgeDerived(sessionId);
    expect(store.getSegmentsBySession(sessionId)).toHaveLength(0);
    expect(store.getHabit(id)?.doc).toBe(doc("a"));

    // And deleting the recording outright, whose CASCADE reaches most of the
    // schema, must still leave the writing alone: the habit's evidence count is
    // what changes, never the habit.
    await store.deleteSession(sessionId);
    expect(store.listSessions()).toHaveLength(0);
    expect(store.getHabit(id)?.doc).toBe(doc("a"));
  });

  it("survives a store re-open, so the table lands on an existing install", async () => {
    const id = ulid();
    await store.putHabit({ id, state: "active", pinned: true, doc: doc("a") });
    store.close();

    store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"));
    expect(store.getHabit(id)?.doc).toBe(doc("a"));
    expect(store.getHabit(id)?.pinned).toBe(true);
  });

  /**
   * The bound session ids live INSIDE `doc` and are deliberately not a foreign
   * key. This is the assertion that pins that decision: with an FK the row would
   * be gone here, taking the user's prose with it, and the app could no longer
   * say "written from 2 recordings, 1 of which has been deleted."
   */
  it("keeps a reference to a deleted recording as evidence, not as a dead FK", async () => {
    const gone = ulid();
    const id = ulid();
    await store.putSession({ id: gone, startedAt: Date.now(), epochMono: 0 });
    await store.putHabit({
      id,
      state: "active",
      pinned: false,
      doc: JSON.stringify({ sessionIds: [gone] }),
    });

    await store.deleteSession(gone);

    const row = store.getHabit(id);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.doc).sessionIds).toEqual([gone]);
  });
});

describe("the table itself", () => {
  it("is created on open with the columns the app writes", async () => {
    const sql = new Database(join(dir, "app.db"), { readonly: true });
    try {
      const cols = (sql.prepare("PRAGMA table_info(habit)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols.sort()).toEqual(
        ["created_at", "doc", "id", "pinned", "state", "updated_at"].sort(),
      );
    } finally {
      sql.close();
    }
  });
});
