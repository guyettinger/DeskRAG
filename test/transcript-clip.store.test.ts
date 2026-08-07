import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";

describe("transcript_clip (Store.putTranscriptClips / getTranscriptClipsBySession)", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-clip-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips clips in time order and cascade-deletes with the session", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.endSession(sessionId, 10_000);

    // Inserted out of order on purpose: the read is what must be ordered.
    await store.putTranscriptClips([
      { id: ulid(), sessionId, tMonoStart: 4000, tMonoEnd: 6000, text: "plus one equals two" },
      { id: ulid(), sessionId, tMonoStart: 1000, tMonoEnd: 2500, text: "one plus one" },
    ]);

    const clips = store.getTranscriptClipsBySession(sessionId);
    expect(clips.map((c) => [c.tMonoStart, c.tMonoEnd, c.text])).toEqual([
      [1000, 2500, "one plus one"],
      [4000, 6000, "plus one equals two"],
    ]);

    await store.deleteSession(sessionId);
    expect(store.getTranscriptClipsBySession(sessionId)).toEqual([]);
  });

  it("writing an empty array is a no-op, not an error", async () => {
    await expect(store.putTranscriptClips([])).resolves.toBeUndefined();
  });

  it("returns an empty array for a session that has none", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    expect(store.getTranscriptClipsBySession(sessionId)).toEqual([]);
  });
});
