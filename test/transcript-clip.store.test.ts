import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import Database from "better-sqlite3";
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

    const micBlob = ulid();
    await store.putBlobs([
      { id: micBlob, sessionId, media: "mic", path: "a.wav", byteOffset: 0,
        byteLength: 4, tMonoStart: 0, tMonoEnd: 8000, codec: "wav" },
    ]);

    // Inserted out of order on purpose: the read is what must be ordered.
    await store.putTranscriptClips([
      { id: ulid(), sessionId, tMonoStart: 4000, tMonoEnd: 6000, text: "plus one equals two",
        media: "mic", blobId: micBlob },
      { id: ulid(), sessionId, tMonoStart: 1000, tMonoEnd: 2500, text: "one plus one",
        media: "mic", blobId: micBlob },
    ]);

    const clips = store.getTranscriptClipsBySession(sessionId);
    expect(clips.map((c) => [c.tMonoStart, c.tMonoEnd, c.text])).toEqual([
      [1000, 2500, "one plus one"],
      [4000, 6000, "plus one equals two"],
    ]);
    // The whole point of the side table: which source said it, and which bytes.
    expect(clips.map((c) => c.media)).toEqual(["mic", "mic"]);
    expect(clips.map((c) => c.blobId)).toEqual([micBlob, micBlob]);

    await store.deleteSession(sessionId);
    expect(store.getTranscriptClipsBySession(sessionId)).toEqual([]);
  });

  it("writing an empty array is a no-op, not an error", async () => {
    await expect(store.putTranscriptClips([])).resolves.toBeUndefined();
  });

  it("reports NO SOURCE for a clip written before the side table existed", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    // Written the way a build predating transcript_clip_source wrote it: the
    // clip row alone. This is the state on every existing install, so it is the
    // state the reader has to be honest about.
    const raw = new Database(join(dir, "meta.sqlite"));
    raw
      .prepare(
        `INSERT INTO transcript_clip(id, session_id, t_mono_start, t_mono_end, text)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ulid(), sessionId, 100, 200, "recorded before attribution existed");
    raw.close();

    const clips = store.getTranscriptClipsBySession(sessionId);
    expect(clips).toHaveLength(1);
    // NULL, never "mic". Defaulting would attribute a video's narration to the
    // person recording, and nothing downstream could tell it had been guessed.
    expect(clips[0]?.media).toBeNull();
    expect(clips[0]?.blobId).toBeNull();
    expect(clips[0]?.text).toBe("recorded before attribution existed");
  });

  it("keeps both sources apart when their blob windows overlap", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    const mic = ulid();
    const desktop = ulid();
    // OVERLAPPING SPANS, which is what a session recording both sources always
    // produces — and the reason a clip's source cannot be inferred after the
    // fact from the blob whose window contains it.
    await store.putBlobs([
      { id: mic, sessionId, media: "mic", path: "m.wav", byteOffset: 0,
        byteLength: 4, tMonoStart: 0, tMonoEnd: 10_000, codec: "wav" },
      { id: desktop, sessionId, media: "desktop_audio", path: "d.wav", byteOffset: 0,
        byteLength: 4, tMonoStart: 0, tMonoEnd: 10_000, codec: "wav" },
    ]);
    await store.putTranscriptClips([
      { id: ulid(), sessionId, tMonoStart: 1000, tMonoEnd: 2000, text: "what do you think",
        media: "desktop_audio", blobId: desktop },
      { id: ulid(), sessionId, tMonoStart: 1200, tMonoEnd: 2100, text: "give me a second",
        media: "mic", blobId: mic },
    ]);
    const clips = store.getTranscriptClipsBySession(sessionId);
    expect(clips.map((c) => [c.media, c.text])).toEqual([
      ["desktop_audio", "what do you think"],
      ["mic", "give me a second"],
    ]);
  });

  it("returns an empty array for a session that has none", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    expect(store.getTranscriptClipsBySession(sessionId)).toEqual([]);
  });
});
