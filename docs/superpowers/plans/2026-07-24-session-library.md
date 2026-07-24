# Session Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recordings first-class — capture each session as a real H.264 video alongside the existing sampled keyframes, and add a Library tab that lists recordings, plays them back with the indexed keyframes marked on the timeline, and deletes them completely.

**Architecture:** Three library changes (a `BlobStore` seam for files written by a subprocess, a `listSessions()` read, a third ffmpeg output branch) feed four app changes (a Range-capable `deskrag://media` protocol host, new DTOs, new service methods, a new React screen). Work follows the repo's dependency direction: `store/` → `capture/` → app main → app shared contract → app renderer.

**Tech Stack:** TypeScript (strict, ESM), better-sqlite3, LanceDB, ffmpeg (subprocess), Electron 43, React, electron-vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-session-library-design.md`

## Global Constraints

- **TypeScript strict mode, ESM.** All relative imports end in `.js` even for `.ts` files. `exactOptionalPropertyTypes` is on — never pass an explicit `undefined` to an optional property; use the `...(x !== undefined ? { k: x } : {})` spread idiom already used throughout the codebase.
- **`npm run typecheck` is the primary gate** after every library edit. `npm --prefix app run typecheck` is the app's separate gate.
- **The app imports `dist/`, not `src/`.** After changing library code, run `npm run build` before the app typechecks or runs.
- **Dual-store rules are non-negotiable:** SQLite commits before Lance adds; deletes gather ids → Lance → SQLite. Do not reorder.
- **Correlate on `t_mono` only.** `startedAt`/`endedAt` are wall-clock and are for human display only.
- **`safeIntegers` is per-statement** in `DualStore.prepare()`. Only `phashScan`, `selectFrameById`, `selectFramesBySession`, and `selectFramesBySegment` enable it. New statements default to it off and return plain `number`.
- **Renderer purity:** `src/main` is the only process that may touch the library, the store, native modules, or API keys. The renderer sees only serializable DTOs from `app/src/shared/types.ts`.
- **Bytes don't go over IPC.** Media is served by blob id through the `deskrag://` protocol.
- **Never hand-edit `assets/` or `app/build/`** — they are generated and drift-guarded.
- Commit after each task. Branch is `feat/session-library`.

---

### Task 1: `BlobStore.reserve()` and `BlobStore.removeSession()`

Two new methods so another process (ffmpeg) can write a blob file directly, and so a session's files can be removed wholesale.

**Files:**
- Modify: `src/store/blob-store.ts`
- Test: `test/blob-store.test.ts` (create)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `BlobStore.reserve(sessionId: string, media: Media, codec: string): Promise<{ id: string; path: string }>`
  - `BlobStore.removeSession(sessionId: string): Promise<void>`
  - `EXT` gains the entry `mp4: "mp4"`.

- [ ] **Step 1: Write the failing test**

Create `test/blob-store.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "../src/store/blob-store.js";

/**
 * BlobStore has two write paths: write() takes bytes, reserve() mints a path for
 * a file another process (ffmpeg) will produce. removeSession() reclaims both.
 */
describe("BlobStore reserve + removeSession", () => {
  let dir: string;
  let blobs: BlobStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "erag-blob-"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reserve creates the session dir and returns a not-yet-existing path", async () => {
    const { id, path } = await blobs.reserve("S1", "screen", "mp4");

    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(path.endsWith(`${id}.mp4`)).toBe(true);
    // The directory exists (ffmpeg will not create it) but the file does not.
    expect(existsSync(dirname(path))).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("reserve puts files in the same session dir that write() uses", async () => {
    const written = await blobs.write("S1", "keyframe", new Uint8Array([1, 2]), {
      tMonoStart: 0,
      tMonoEnd: 1,
      codec: "jpeg",
    });
    const reserved = await blobs.reserve("S1", "screen", "mp4");

    expect(dirname(reserved.path)).toBe(dirname(written.path));
  });

  it("reserve falls back to a .bin extension for an unknown codec", async () => {
    const { path } = await blobs.reserve("S1", "screen", "nonesuch");
    expect(path.endsWith(".bin")).toBe(true);
  });

  it("removeSession deletes every file for that session and leaves others alone", async () => {
    const keep = await blobs.write("S2", "keyframe", new Uint8Array([9]), {
      tMonoStart: 0,
      tMonoEnd: 1,
      codec: "jpeg",
    });
    const doomed = await blobs.write("S1", "keyframe", new Uint8Array([1]), {
      tMonoStart: 0,
      tMonoEnd: 1,
      codec: "jpeg",
    });
    const reserved = await blobs.reserve("S1", "screen", "mp4");
    writeFileSync(reserved.path, new Uint8Array([7]));

    await blobs.removeSession("S1");

    expect(existsSync(doomed.path)).toBe(false);
    expect(existsSync(reserved.path)).toBe(false);
    expect(existsSync(dirname(doomed.path))).toBe(false);
    expect(existsSync(keep.path)).toBe(true);
  });

  it("removeSession on a session that never wrote anything is a no-op", async () => {
    await expect(blobs.removeSession("never-existed")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/blob-store.test.ts`
Expected: FAIL — `blobs.reserve is not a function`.

- [ ] **Step 3: Implement the two methods**

In `src/store/blob-store.ts`, add `mp4` to the `EXT` map:

```ts
const EXT: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
  webp: "webp",
  h264: "h264",
  mp4: "mp4",
  aac: "aac",
  wav: "wav",
};
```

Change the `node:fs/promises` import to include `rm`:

```ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
```

Add both methods to the class, after `write()`:

```ts
  /**
   * Mint a path for a blob another process will write (e.g. ffmpeg encoding the
   * session video straight to disk). Creates the session directory but writes
   * nothing — the caller persists the `blob` row once the file is complete.
   */
  async reserve(
    sessionId: string,
    media: Media,
    codec: string,
  ): Promise<{ id: string; path: string }> {
    const id = ulid();
    const ext = EXT[codec] ?? "bin";
    const dir = join(this.root, sessionId);
    await mkdir(dir, { recursive: true });
    return { id, path: join(dir, `${id}.${ext}`) };
  }

  /** Remove every blob file for a session. Idempotent. */
  async removeSession(sessionId: string): Promise<void> {
    await rm(join(this.root, sessionId), { recursive: true, force: true });
  }
```

Note `media` is unused in `reserve` today (paths are per-session, not per-media) but is part of the signature so callers read symmetrically with `write()` and so a future layout change needs no call-site edits. Prefix it with `_` only if the linter complains; `noUnusedParameters` is not currently on.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/blob-store.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/store/blob-store.ts test/blob-store.test.ts
git commit -m "feat(store): BlobStore.reserve + removeSession for producer-written files"
```

---

### Task 2: `DualStore.listSessions()`

An authoritative, countable session list from SQLite, replacing the app's `sessions.json` sidecar.

**Files:**
- Modify: `src/store/types.ts` (add `SessionSummaryRow`, add to the `Store` interface)
- Modify: `src/store/store.ts` (one prepared statement + one method)
- Test: `test/session-list.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  export interface SessionSummaryRow extends SessionRow {
    frameCount: number;
    segmentCount: number;
    eventCount: number;
    byteLength: number;      // sum of blob.byte_length for the session
    videoBlobId: string | null;  // the `screen` blob, when one exists
  }
  // on Store / DualStore:
  listSessions(): SessionSummaryRow[];
  ```

- [ ] **Step 1: Write the failing test**

Create `test/session-list.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStore, id, type TestCtx } from "./helpers.js";

/**
 * listSessions is the app's Library read: every session, newest first, with the
 * counts and byte totals the UI shows — and the `screen` video blob id when the
 * session was recorded with video. SQLite is the source of truth, so a deleted
 * session simply stops appearing.
 */
describe("DualStore.listSessions", () => {
  let ctx: TestCtx;

  beforeEach(async () => {
    ctx = await makeStore([]);
  });
  afterEach(() => ctx.cleanup());

  it("returns sessions newest-first with counts, bytes, and the video blob id", async () => {
    const { store } = ctx;
    const older = id();
    const newer = id();
    await store.putSession({ id: older, startedAt: 1000, epochMono: 0 });
    await store.putSession({ id: newer, startedAt: 2000, epochMono: 0 });
    await store.endSession(newer, 2500);

    const segId = id();
    await store.putSegments([
      { id: segId, sessionId: newer, granularity: "action", tMonoStart: 0, tMonoEnd: 10 },
    ]);
    const videoBlob = id();
    await store.putBlobs([
      {
        id: videoBlob,
        sessionId: newer,
        media: "screen",
        path: "/tmp/v.mp4",
        byteOffset: 0,
        byteLength: 1000,
        tMonoStart: 0,
        tMonoEnd: 500,
        codec: "mp4",
      },
      {
        id: id(),
        sessionId: newer,
        media: "keyframe",
        path: "/tmp/k.jpg",
        byteOffset: 0,
        byteLength: 24,
        tMonoStart: 5,
        tMonoEnd: 5,
        codec: "jpeg",
      },
    ]);
    await store.putFrames([
      {
        id: id(),
        sessionId: newer,
        tMono: 5,
        width: 100,
        height: 50,
        phash: 1n,
        frameOffset: 0,
        segmentIds: [],
      },
    ]);
    await store.putEvents([
      { id: id(), sessionId: newer, tMono: 1, kind: "mouse_down" },
      { id: id(), sessionId: newer, tMono: 2, kind: "mouse_up" },
    ]);

    const list = store.listSessions();

    expect(list.map((s) => s.id)).toEqual([newer, older]); // started_at DESC
    const top = list[0]!;
    expect(top.endedAt).toBe(2500);
    expect(top.frameCount).toBe(1);
    expect(top.segmentCount).toBe(1);
    expect(top.eventCount).toBe(2);
    expect(top.byteLength).toBe(1024); // 1000 + 24, across BOTH blobs
    expect(top.videoBlobId).toBe(videoBlob);
  });

  it("reports zeroes and a null video id for an empty session", async () => {
    const { store } = ctx;
    const sessionId = id();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });

    const [row] = store.listSessions();

    expect(row!.frameCount).toBe(0);
    expect(row!.segmentCount).toBe(0);
    expect(row!.eventCount).toBe(0);
    expect(row!.byteLength).toBe(0);
    expect(row!.videoBlobId).toBeNull();
    expect(row!.endedAt).toBeNull();
  });

  it("returns plain numbers, not BigInts (safeIntegers is per-statement)", async () => {
    const { store } = ctx;
    await store.putSession({ id: id(), startedAt: 1000, epochMono: 0 });

    const [row] = store.listSessions();

    expect(typeof row!.frameCount).toBe("number");
    expect(typeof row!.byteLength).toBe("number");
    expect(typeof row!.startedAt).toBe("number");
  });

  it("does not double-count when a session has many rows in several tables", async () => {
    const { store } = ctx;
    const sessionId = id();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    // 2 segments x 3 frames x 4 events: a naive multi-JOIN would report 24s.
    await store.putSegments([
      { id: id(), sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 10 },
      { id: id(), sessionId, granularity: "task", tMonoStart: 0, tMonoEnd: 20 },
    ]);
    await store.putFrames(
      [1, 2, 3].map((t) => ({
        id: id(),
        sessionId,
        tMono: t,
        width: 10,
        height: 10,
        phash: BigInt(t),
        frameOffset: 0,
        segmentIds: [],
      })),
    );
    await store.putEvents(
      [1, 2, 3, 4].map((t) => ({ id: id(), sessionId, tMono: t, kind: "mouse_move" })),
    );

    const [row] = store.listSessions();

    expect(row!.segmentCount).toBe(2);
    expect(row!.frameCount).toBe(3);
    expect(row!.eventCount).toBe(4);
  });

  it("drops a session from the list once it is deleted", async () => {
    const { store } = ctx;
    const sessionId = id();
    await store.putSession({ id: sessionId, startedAt: 1000, epochMono: 0 });
    expect(store.listSessions()).toHaveLength(1);

    await store.deleteSession(sessionId);

    expect(store.listSessions()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/session-list.test.ts`
Expected: FAIL — `store.listSessions is not a function`.

- [ ] **Step 3: Add the type**

In `src/store/types.ts`, after the `SessionRow` interface (around line 242), add:

```ts
/** A session plus the aggregate counts the Library UI lists. */
export interface SessionSummaryRow extends SessionRow {
  frameCount: number;
  segmentCount: number;
  eventCount: number;
  /** Total bytes across every blob for the session. */
  byteLength: number;
  /** The continuous `screen` video blob, when the session recorded one. */
  videoBlobId: string | null;
}
```

In the `Store` interface, alongside the other session reads (next to `getSession`, around line 296):

```ts
  listSessions(): SessionSummaryRow[];
```

- [ ] **Step 4: Implement the statement and method**

In `src/store/store.ts`, add `SessionSummaryRow` to the type import list from `./types.js`.

Inside `prepare()`, add this statement next to `selectSession` (around line 156). Each count comes from its own correlated scalar subquery — a multi-table JOIN would multiply the counts together:

```ts
      selectAllSessions: db.prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM frame   f WHERE f.session_id   = s.id) AS frame_count,
                (SELECT COUNT(*) FROM segment g WHERE g.session_id   = s.id) AS segment_count,
                (SELECT COUNT(*) FROM event   e WHERE e.session_id   = s.id) AS event_count,
                (SELECT COALESCE(SUM(b.byte_length), 0) FROM blob b
                  WHERE b.session_id = s.id)                                 AS byte_length,
                (SELECT b.id FROM blob b
                  WHERE b.session_id = s.id AND b.media = 'screen'
                  ORDER BY b.t_mono_start ASC LIMIT 1)                       AS video_blob_id
           FROM session s
          ORDER BY s.started_at DESC`,
      ),
```

Add the method next to `getSession` (after line 525):

```ts
  listSessions(): SessionSummaryRow[] {
    return (this.stmts.selectAllSessions.all() as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      startedAt: r.started_at as number,
      epochMono: r.epoch_mono as number,
      endedAt: (r.ended_at as number | null) ?? null,
      deviceId: (r.device_id as string | null) ?? null,
      meta: parseJson(r.meta as string | null),
      frameCount: r.frame_count as number,
      segmentCount: r.segment_count as number,
      eventCount: r.event_count as number,
      byteLength: r.byte_length as number,
      videoBlobId: (r.video_blob_id as string | null) ?? null,
    }));
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/session-list.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Typecheck, run the full suite, and commit**

```bash
npm run typecheck && npm test
git add src/store/types.ts src/store/store.ts test/session-list.test.ts
git commit -m "feat(store): listSessions() with per-session counts and video blob id"
```

---

### Task 3: `reserveBlob` / `commitBlob` on `CaptureContext`

The seam that lets a producer register a file it wrote itself, without ever touching the store.

**Files:**
- Modify: `src/capture/types.ts` (two methods on `CaptureContext`)
- Modify: `src/capture/session.ts` (implement them)
- Test: `test/capture-session.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `BlobStore.reserve()` from Task 1.
- Produces:
  ```ts
  // on CaptureContext:
  reserveBlob(media: Media, codec: string): Promise<{ blobId: string; path: string } | null>;
  commitBlob(blobId: string, meta: { tMonoStart: number; tMonoEnd: number }): Promise<void>;
  ```
  `reserveBlob` returns `null` when the session has no `blobStore`. `commitBlob` silently no-ops when the file is missing or empty.

- [ ] **Step 1: Write the failing test**

Append to `test/capture-session.test.ts` (inside the existing file, after the existing `describe` block). Add `writeFileSync` and `join` to the existing imports as needed — `join` is already imported:

```ts
/**
 * The file seam: producers that spawn a subprocess writing directly to disk
 * (ffmpeg encoding the session video) reserve a path up front and register the
 * finished file as a blob on stop. Bytes never pass through Node.
 */
describe("CaptureSession reserveBlob/commitBlob", () => {
  let dir: string;
  let store: DualStore;
  let blobs: BlobStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-cap-blob-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
    blobs = new BlobStore(join(dir, "blobs"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Grab the live CaptureContext by way of a probe producer. */
  function probe(): { producer: Producer; ctx: () => CaptureContext } {
    let captured: CaptureContext | undefined;
    return {
      producer: {
        id: "probe",
        start: (c: CaptureContext) => {
          captured = c;
        },
        stop: () => {},
      },
      ctx: () => captured!,
    };
  }

  it("registers a reserved file as a blob row with its on-disk byte length", async () => {
    const p = probe();
    const session = new CaptureSession(store, { blobStore: blobs });
    session.addProducer(p.producer);
    const sessionId = await session.start();

    const reserved = await p.ctx().reserveBlob("screen", "mp4");
    expect(reserved).not.toBeNull();
    writeFileSync(reserved!.path, new Uint8Array([1, 2, 3, 4, 5]));
    await p.ctx().commitBlob(reserved!.blobId, { tMonoStart: 10, tMonoEnd: 90 });

    await session.stop();

    const row = store.getBlob(reserved!.blobId);
    expect(row).toBeDefined();
    expect(row!.sessionId).toBe(sessionId);
    expect(row!.media).toBe("screen");
    expect(row!.codec).toBe("mp4");
    expect(row!.byteLength).toBe(5); // statted from disk, not passed in
    expect(row!.byteOffset).toBe(0);
    expect(row!.tMonoStart).toBe(10);
    expect(row!.tMonoEnd).toBe(90);
    expect(store.getBlobsBySession(sessionId).map((b) => b.id)).toContain(reserved!.blobId);
  });

  it("reserveBlob returns null when the session has no blob store", async () => {
    const p = probe();
    const session = new CaptureSession(store, {}); // no blobStore
    session.addProducer(p.producer);
    await session.start();

    await expect(p.ctx().reserveBlob("screen", "mp4")).resolves.toBeNull();

    await session.stop();
  });

  it("commitBlob writes no row when the reserved file was never produced", async () => {
    const p = probe();
    const session = new CaptureSession(store, { blobStore: blobs });
    session.addProducer(p.producer);
    const sessionId = await session.start();

    const reserved = await p.ctx().reserveBlob("screen", "mp4");
    // ffmpeg failed to start: nothing at reserved.path.
    await p.ctx().commitBlob(reserved!.blobId, { tMonoStart: 0, tMonoEnd: 0 });

    await session.stop();

    expect(store.getBlob(reserved!.blobId)).toBeUndefined();
    expect(store.getBlobsBySession(sessionId)).toHaveLength(0);
  });

  it("commitBlob writes no row for a zero-byte file", async () => {
    const p = probe();
    const session = new CaptureSession(store, { blobStore: blobs });
    session.addProducer(p.producer);
    await session.start();

    const reserved = await p.ctx().reserveBlob("screen", "mp4");
    writeFileSync(reserved!.path, new Uint8Array([]));
    await p.ctx().commitBlob(reserved!.blobId, { tMonoStart: 0, tMonoEnd: 0 });

    await session.stop();

    expect(store.getBlob(reserved!.blobId)).toBeUndefined();
  });
});
```

Extend the file's import block to cover the new needs:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { BlobStore } from "../src/store/blob-store.js";
import type { CaptureContext, Producer } from "../src/capture/types.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/capture-session.test.ts`
Expected: FAIL — `ctx.reserveBlob is not a function`. The pre-existing test in the file must still pass.

- [ ] **Step 3: Add the contract**

In `src/capture/types.ts`, add the `Media` type import at the top:

```ts
import type { Media } from "../store/types.js";
```

Add both methods to `CaptureContext`, after `ingestAudio`:

```ts
  /**
   * Reserve a blob path for a file this producer writes itself (e.g. ffmpeg
   * encoding straight to disk). Returns null when the session has no blob
   * store — the producer should then skip that output entirely.
   */
  reserveBlob(media: Media, codec: string): Promise<{ blobId: string; path: string } | null>;
  /**
   * Register a previously reserved file as a blob row, statting it for its byte
   * length. A missing or empty file is skipped (no row) rather than failing the
   * capture — a video that never materialised must not sink the session.
   */
  commitBlob(blobId: string, meta: { tMonoStart: number; tMonoEnd: number }): Promise<void>;
```

- [ ] **Step 4: Implement in `CaptureSession`**

In `src/capture/session.ts`, add the imports:

```ts
import { stat } from "node:fs/promises";
import type { Media } from "../store/types.js";
```

Add a field to the class, next to `private ingestor`:

```ts
  /** Paths + media for blobs reserved by producers, pending commit. */
  private readonly reserved = new Map<string, { path: string; media: Media; codec: string }>();
```

Add both methods to the `ctx` object literal in `start()`, after `ingestAudio`:

```ts
      // Reserve a path for a file the producer writes itself; without a blob
      // store there is nowhere to keep it, so the producer skips that output.
      reserveBlob: async (media, codec) => {
        if (!this.opts.blobStore) return null;
        const { id, path } = await this.opts.blobStore.reserve(this.sessionId!, media, codec);
        this.reserved.set(id, { path, media, codec });
        return { blobId: id, path };
      },
      // Register the finished file. A missing/empty file means the producer
      // never got going — skip it rather than writing a broken blob row.
      commitBlob: async (blobId, meta) => {
        const entry = this.reserved.get(blobId);
        if (!entry) return;
        let byteLength = 0;
        try {
          byteLength = (await stat(entry.path)).size;
        } catch {
          return; // never written
        }
        if (byteLength === 0) return;
        this.reserved.delete(blobId);
        await this.store.putBlobs([
          {
            id: blobId,
            sessionId: this.sessionId!,
            media: entry.media,
            path: entry.path,
            byteOffset: 0,
            byteLength,
            tMonoStart: meta.tMonoStart,
            tMonoEnd: meta.tMonoEnd,
            codec: entry.codec,
          },
        ]);
      },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/capture-session.test.ts`
Expected: PASS — the new 4 tests plus the pre-existing one.

- [ ] **Step 6: Typecheck, run the full suite, and commit**

```bash
npm run typecheck && npm test
git add src/capture/types.ts src/capture/session.ts test/capture-session.test.ts
git commit -m "feat(capture): reserveBlob/commitBlob seam for producer-written files"
```

---

### Task 4: Record the session video in `FfmpegScreenProducer`

The third ffmpeg output branch, encoding H.264 straight to the reserved path.

**Files:**
- Modify: `src/capture/producers/ffmpeg-screen.ts`
- Test: `test/ffmpeg-screen.test.ts` (add one test; the file skips cleanly without ffmpeg)

**Interfaces:**
- Consumes: `ctx.reserveBlob` / `ctx.commitBlob` from Task 3.
- Produces: a `blob` row with `media: "screen"`, `codec: "mp4"` per session. New `FfmpegScreenOptions` fields: `recordVideo` (default `true`), `videoFps` (`10`), `videoCrf` (`28`), `videoPreset` (`"veryfast"`), `videoMaxWidth` (`1920`).

- [ ] **Step 1: Write the failing test**

Append to `test/ffmpeg-screen.test.ts`, inside the existing `describe.skipIf(!hasFfmpeg)` block:

```ts
  it("records a continuous MP4 alongside the sampled keyframes", async () => {
    const errors: string[] = [];
    const session = new CaptureSession(store, {
      clock: MonotonicClock.start(),
      keyframeGate: new KeyframeGate({ hammingThreshold: 1 }),
      blobStore: blobs,
    });
    // Drives the REAL args() graph (all three outputs) off a synthetic lavfi
    // source — no screen, no permissions. The video path is chosen by
    // reserveBlob inside start(), so this must not use `ffmpegArgs`.
    session.addProducer(
      new FfmpegScreenProducer({
        grayW: 9,
        grayH: 8,
        fps: 5,
        videoFps: 10,
        storeImages: true,
        inputFormat: "lavfi",
        omitInputFramerate: true,
        input: "testsrc=size=64x48:rate=10:duration=2",
        imageMaxWidth: 64,
        videoMaxWidth: 64,
        onError: (m) => errors.push(m),
      }),
    );

    const sessionId = await session.start();
    const deadline = Date.now() + 15_000;
    while (store.getFramesBySession(sessionId).length === 0 && Date.now() < deadline) {
      await sleep(100);
    }
    await session.stop();

    const video = store
      .getBlobsBySession(sessionId)
      .find((b) => b.media === "screen");
    expect(video, `ffmpeg errors: ${errors.join(" | ")}`).toBeDefined();
    expect(video!.codec).toBe("mp4");
    expect(video!.byteLength).toBeGreaterThan(0);
    expect(video!.tMonoEnd).toBeGreaterThanOrEqual(video!.tMonoStart);

    // A real MP4: bytes 4..8 are the 'ftyp' box type.
    const bytes = await blobs.read(video!);
    expect(Buffer.from(bytes.subarray(4, 8)).toString("ascii")).toBe("ftyp");

    // The keyframe pipeline is untouched by the new branch.
    const frames = store.getFramesBySession(sessionId);
    expect(frames.some((f) => f.blobId)).toBe(true);
  }, 30_000);
```

Add a unit test for the arg builder — it is pure and needs no ffmpeg, so put it in a **new top-level `describe` outside** the `skipIf` block at the end of the file:

```ts
/** args() is pure — assert the filter graph without spawning anything. */
describe("FfmpegScreenProducer.args", () => {
  it("emits three mapped outputs and decimates only the sampling branches", () => {
    const p = new FfmpegScreenProducer({ fps: 1, videoFps: 10, grayW: 32, grayH: 32 });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args("/tmp/out.mp4");
    const joined = a.join(" ");

    expect(joined).toContain("split=3[v][g][c]");
    expect(joined).toContain("[g]fps=1,");      // sampling branch decimated
    expect(joined).toContain("[c]fps=1,");
    expect(joined).not.toContain("[v]fps=");    // video branch keeps full rate
    expect(joined).toContain("-framerate 10");  // input runs at videoFps
    expect(joined).toContain("+frag_keyframe+empty_moov+default_base_moof");
    expect(joined).toContain("-pix_fmt yuv420p");
    expect(a[a.length - 1]).toBe("pipe:3");
    expect(joined).toContain("/tmp/out.mp4");
  });

  it("omits the video branch when recordVideo is false", () => {
    const p = new FfmpegScreenProducer({ recordVideo: false });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args(null);

    expect(a.join(" ")).toContain("split=2[g][c]");
    expect(a.join(" ")).not.toContain("libx264");
  });

  it("drops to a gray-only single output when storeImages is false", () => {
    const p = new FfmpegScreenProducer({ storeImages: false, recordVideo: false });
    // @ts-expect-error — exercising the private arg builder directly.
    const a: string[] = p.args(null);

    expect(a.join(" ")).not.toContain("split");
    expect(a[a.length - 1]).toBe("pipe:1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ffmpeg-screen.test.ts`
Expected: FAIL — `args()` takes no argument and produces `split=2`; no `screen` blob is written.

- [ ] **Step 3: Implement the video branch**

In `src/capture/producers/ffmpeg-screen.ts`, extend the options interface:

```ts
  /** Record the full-rate session video to a file (third output branch). */
  recordVideo?: boolean;
  /** Input framerate; also the recorded video's framerate. */
  videoFps?: number;
  /** x264 constant rate factor (higher = smaller + worse). */
  videoCrf?: number;
  /** x264 speed/size preset. */
  videoPreset?: string;
  /** Max width of the recorded video (aspect preserved). */
  videoMaxWidth?: number;
  /** ffmpeg input format (default "avfoundation"; tests pass "lavfi"). */
  inputFormat?: string;
  /** Omit the -framerate flag (lavfi sources carry their own rate). */
  omitInputFramerate?: boolean;
```

`inputFormat`/`omitInputFramerate` exist so the integration test can drive a
synthetic `lavfi` source through the **real** generated arg graph. It cannot use
`ffmpegArgs` for this: `ffmpegArgs` bypasses `args()` entirely, and the video
path is only known after `reserveBlob` runs inside `start()`.

Add fields and constructor defaults:

```ts
  private readonly recordVideo: boolean;
  private readonly videoFps: number;
  /** Blob id + monotonic start for the video file, set on start(). */
  private video: { blobId: string; path: string; tMonoStart: number } | undefined;
```

```ts
    this.recordVideo = opts.recordVideo ?? true;
    this.videoFps = opts.videoFps ?? 10;
```

Replace `args()` with a version taking the video path (`null` = no video branch). Note the `fps` filter moves from the input onto the two sampling branches, so pHash/keyframe behaviour is unchanged while the video keeps the full rate:

```ts
  private args(videoPath: string | null): string[] {
    if (this.opts.ffmpegArgs) return this.opts.ffmpegArgs;
    const fps = this.opts.fps ?? 1;
    const input = this.opts.input ?? "1";
    // The input runs at videoFps when recording video (the sampling branches
    // decimate to `fps` with a filter); otherwise it runs at `fps` directly.
    const inputRate = videoPath ? this.videoFps : fps;
    const head = [
      "-hide_banner", "-loglevel", "error",
      "-f", this.opts.inputFormat ?? "avfoundation",
      ...(this.opts.omitInputFramerate ? [] : ["-framerate", String(inputRate)]),
      "-i", input,
    ];
    if (!this.storeImages && !videoPath) {
      return [
        ...head,
        "-vf", `fps=${fps},scale=${this.grayW}:${this.grayH},format=gray`,
        "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
      ];
    }

    const maxW = this.opts.imageMaxWidth ?? 1280;
    const q = this.opts.imageQuality ?? 5;
    const crf = this.opts.videoCrf ?? 28;
    const preset = this.opts.videoPreset ?? "veryfast";
    const videoMaxW = this.opts.videoMaxWidth ?? 1920;

    // Branch labels are assigned in output order: [v] video, [g] gray, [c] jpeg.
    const labels = [...(videoPath ? ["[v]"] : []), "[g]", ...(this.storeImages ? ["[c]"] : [])];
    const chains = [`[g]fps=${fps},scale=${this.grayW}:${this.grayH},format=gray[gg]`];
    if (this.storeImages) chains.push(`[c]fps=${fps},scale=${maxW}:-2[cc]`);

    const filter =
      `[0:v]split=${labels.length}${labels.join("")};` + chains.join(";");

    const out: string[] = [...head, "-filter_complex", filter];
    // Video first so its -map/-c:v flags cannot be mistaken for the pipe outputs.
    if (videoPath) {
      out.push(
        "-map", "[v]",
        "-vf", `scale='min(${videoMaxW},iw)':-2`,
        "-c:v", "libx264", "-preset", preset, "-crf", String(crf),
        "-pix_fmt", "yuv420p", "-g", String(this.videoFps * 2),
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "-y", videoPath,
      );
    }
    out.push("-map", "[gg]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1");
    if (this.storeImages) {
      out.push("-map", "[cc]", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", String(q), "pipe:3");
    }
    return out;
  }
```

Make `start()` async so it can reserve the path before spawning (the `Producer` contract already allows `void | Promise<void>` and `CaptureSession.start()` already awaits it):

```ts
  async start(ctx: CaptureContext): Promise<void> {
    this.ctx = ctx;
    const onError = this.opts.onError ?? ((m) => console.error(`[ffmpeg-screen] ${m}`));

    // Reserve the path before spawning; without a blob store there is nowhere
    // to keep the file, so the video branch is dropped from the arg graph.
    let videoPath: string | null = null;
    if (this.recordVideo) {
      const reserved = await ctx.reserveBlob("screen", "mp4");
      if (reserved) {
        videoPath = reserved.path;
        this.video = { ...reserved, tMonoStart: ctx.clock.now() };
      }
    }

    const stdio = this.storeImages
      ? (["ignore", "pipe", "pipe", "pipe"] as const)
      : (["ignore", "pipe", "pipe"] as const);
    const proc = spawn(this.opts.ffmpegPath ?? "ffmpeg", this.args(videoPath), {
      stdio: [...stdio],
    });
    this.proc = proc;
    // ...the rest of the existing start() body (stdout/mjpeg/stderr handlers)
    // is unchanged.
```

- [ ] **Step 3b: Await ffmpeg exit and commit the blob in `stop()`**

```ts
  async stop(): Promise<void> {
    const proc = this.proc;
    if (proc) {
      this.proc = undefined;
      proc.kill("SIGINT");
      // The MP4 is only complete once ffmpeg has exited; wait, but never hang.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 5000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await this.ingestChain; // drain frames already read
    if (this.video && this.ctx) {
      await this.ctx.commitBlob(this.video.blobId, {
        tMonoStart: this.video.tMonoStart,
        tMonoEnd: this.ctx.clock.now(),
      });
      this.video = undefined;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ffmpeg-screen.test.ts`
Expected: PASS. The three `args()` tests run everywhere; the two integration tests run only where ffmpeg exists and are skipped otherwise.

- [ ] **Step 5: Typecheck, run the full suite, and commit**

```bash
npm run typecheck && npm test
git add src/capture/producers/ffmpeg-screen.ts test/ffmpeg-screen.test.ts
git commit -m "feat(capture): record the session as H.264 alongside sampled keyframes"
```

---

### Task 5: Delete a session's blob files

Close the loop on delete: `deleteSession` already clears both engines, but the files on disk survive.

**Files:**
- Modify: `test/dual-store.reconcile.test.ts` (extend the existing delete test)
- No `src/` change — `DualStore` must NOT depend on `BlobStore` (the store records where blobs are; it does not own them). The caller pairs the two.

**Interfaces:**
- Consumes: `BlobStore.removeSession()` from Task 1, `DualStore.deleteSession()` (existing).
- Produces: nothing new — this task documents and tests the required call pairing that Task 8 relies on.

- [ ] **Step 1: Write the failing test**

In `test/dual-store.reconcile.test.ts`, add a test after the existing `"deleteSession removes rows from BOTH engines"` case (line 116):

```ts
  it("pairs with BlobStore.removeSession to reclaim the files on disk", async () => {
    const blobs = new BlobStore(join(ctx.dir, "blobs"));
    const sessionId = id();
    await ctx.store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
    const insert = await blobs.write(sessionId, "keyframe", new Uint8Array([1, 2, 3]), {
      tMonoStart: 0,
      tMonoEnd: 1,
      codec: "jpeg",
    });
    await ctx.store.putBlobs([insert]);
    expect(existsSync(insert.path)).toBe(true);

    // The documented pairing: rows first (a row pointing at a deleted file is a
    // broken read; a file with no row is just reclaimable disk).
    await ctx.store.deleteSession(sessionId);
    await blobs.removeSession(sessionId);

    expect(ctx.store.getBlob(insert.id)).toBeUndefined();
    expect(existsSync(insert.path)).toBe(false);
  });
```

Add to that file's imports as needed:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "../src/store/blob-store.js";
```

Check the existing test file for how it names its context (`ctx`, or separate `store`/`dir` variables) and match it — adjust `ctx.store` / `ctx.dir` to the local names.

- [ ] **Step 2: Run the test to verify it fails or passes for the right reason**

Run: `npx vitest run test/dual-store.reconcile.test.ts`
Expected: PASS once `removeSession` exists (Task 1 shipped it). If it fails, the failure is real — investigate rather than adjusting the assertion.

- [ ] **Step 3: Commit**

```bash
npm test
git add test/dual-store.reconcile.test.ts
git commit -m "test(store): cover deleteSession + BlobStore.removeSession pairing"
```

---

### Task 6: Export the new library surface and rebuild `dist/`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `SessionSummaryRow` exported from the barrel (it flows out of `export * from "./store/types.js"`, so verify rather than re-export). `BlobStore` is already exported.

- [ ] **Step 1: Verify the type reaches the barrel**

`src/index.ts` line 9 already does `export * from "./store/types.js"`, which covers `SessionSummaryRow`. `BlobStore` is exported on line 11. `FfmpegScreenProducer` and its options type are exported around line 45. **No edit is expected** — confirm with:

```bash
npm run build
node -e "import('./dist/index.js').then(m => console.log(typeof m.BlobStore, typeof m.DualStore))"
```

Expected: `function function`

- [ ] **Step 2: Confirm the new members exist on the built output**

```bash
grep -n "listSessions" dist/store/store.d.ts dist/store/types.d.ts
grep -n "reserveBlob\|commitBlob" dist/capture/types.d.ts
grep -n "recordVideo\|videoFps" dist/capture/producers/ffmpeg-screen.d.ts
```

Expected: each grep prints at least one line. If any is empty, the corresponding task is incomplete — go back rather than proceeding.

- [ ] **Step 3: Commit only if an export was actually missing**

If Step 2 showed a gap and you edited `src/index.ts`, commit it. If nothing
changed (the expected case), skip this step — do not create an empty commit.

```bash
git add src/index.ts && git commit -m "feat: export session-library surface from the barrel"
```

---

### Task 7: The shared IPC contract

Changed **before** main or renderer, per the repo rule — `app/src/shared/types.ts` is the contract both sides depend on.

**Files:**
- Modify: `app/src/shared/types.ts`

**Interfaces:**
- Consumes: nothing (pure type declarations).
- Produces: `SessionVideoDTO`, `KeyframeMarkerDTO`, `SessionDetailDTO`; an extended `SessionSummaryDTO`; `DeskRagApi.sessions.detail` / `.remove`; `IPC.sessionsDetail` / `IPC.sessionsRemove`.

- [ ] **Step 1: Replace `SessionSummaryDTO` and add the new shapes**

In `app/src/shared/types.ts`, replace the existing `SessionSummaryDTO` (line 144) with:

```ts
export interface SessionSummaryDTO {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** endedAt - startedAt, or 0 while a session is still open. */
  durationMs: number;
  frameCount: number;
  segmentCount: number;
  eventCount: number;
  /** Total bytes across every blob for the session. */
  sizeBytes: number;
  hasVideo: boolean;
  /** deskrag://frame/<blobId> of the first keyframe, for the list thumbnail. */
  posterUrl: string | null;
}

export interface SessionVideoDTO {
  blobId: string;
  /** deskrag://media/<blobId> — Range-capable, so <video> can seek. */
  url: string;
  tMonoStart: number;
  tMonoEnd: number;
  sizeBytes: number;
}

export interface KeyframeMarkerDTO {
  frameId: string;
  tMono: number;
  /** Position within the video: (tMono - video.tMonoStart) / 1000. */
  offsetSec: number;
  thumbUrl: string | null;
  segmentDigest: string | null;
}

export interface SessionDetailDTO {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  /** Null for sessions recorded before video capture, or with Screen disabled. */
  video: SessionVideoDTO | null;
  keyframes: KeyframeMarkerDTO[];
  frameCount: number;
  segmentCount: number;
  eventCount: number;
  sizeBytes: number;
}
```

- [ ] **Step 2: Extend the API and channel map**

Replace the `sessions` block in `DeskRagApi` (line 207):

```ts
  sessions: {
    list(): Promise<SessionSummaryDTO[]>;
    detail(sessionId: string): Promise<SessionDetailDTO | null>;
    remove(sessionId: string): Promise<void>;
  };
```

Add to the `IPC` const, next to `sessionsList`:

```ts
  sessionsDetail: "sessions:detail",
  sessionsRemove: "sessions:remove",
```

- [ ] **Step 3: Typecheck (expect failures in main/preload — that is the point)**

Run: `npm --prefix app run typecheck`
Expected: FAIL — `preload/index.ts` does not implement `detail`/`remove`, and `deskrag-service.ts` no longer satisfies `SessionSummaryDTO`. Tasks 8–9 fix both.

- [ ] **Step 4: Commit**

```bash
git add app/src/shared/types.ts
git commit -m "feat(app): session detail + remove in the shared IPC contract"
```

---

### Task 8: Service methods and the Range-capable media protocol

**Files:**
- Modify: `app/src/main/deskrag-service.ts` (drop the `sessions.json` sidecar; add three methods)
- Modify: `app/src/main/protocol.ts` (add the `media` host)
- Modify: `app/src/main/ipc.ts` (two handlers)
- Modify: `app/src/preload/index.ts` (two bridge methods)

**Interfaces:**
- Consumes: `store.listSessions()` (Task 2), `blobs.removeSession()` (Task 1), the DTOs (Task 7).
- Produces:
  - `DeskRagService.listSessions(): SessionSummaryDTO[]`
  - `DeskRagService.sessionDetail(sessionId: string): SessionDetailDTO | null`
  - `DeskRagService.removeSession(sessionId: string): Promise<void>`
  - `deskrag://media/<blobId>` serving `206` on `Range`.

- [ ] **Step 1: Remove the `sessions.json` sidecar**

In `app/src/main/deskrag-service.ts`, delete: the `sessionLog` field (line 96), `sessionLogPath` (119), `loadSessionLog` (122), `recordSession` (130), the `this.sessionLog = this.loadSessionLog();` line in `open()` (116), and the `recordSession({...})` call in `stopRecording()` (304–310) together with the now-unused `const sess = this.store.getSession(sessionId);` above it. Drop `existsSync`, `readFileSync`, `writeFileSync` from the `node:fs` import if nothing else uses them.

SQLite has always held these rows; the sidecar only duplicated them. A stale `sessions.json` left on disk is ignored.

- [ ] **Step 2: Implement the three service methods**

Replace the existing `listSessions()` (line 513) with:

```ts
  listSessions(): SessionSummaryDTO[] {
    return this.store.listSessions().map((s) => {
      const firstKeyframe = this.store
        .getFramesBySession(s.id)
        .find((f) => f.blobId);
      return {
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.endedAt ? Math.max(0, s.endedAt - s.startedAt) : 0,
        frameCount: s.frameCount,
        segmentCount: s.segmentCount,
        eventCount: s.eventCount,
        sizeBytes: s.byteLength,
        hasVideo: s.videoBlobId !== null,
        posterUrl: firstKeyframe?.blobId ? `deskrag://frame/${firstKeyframe.blobId}` : null,
      };
    });
  }

  sessionDetail(sessionId: string): SessionDetailDTO | null {
    const s = this.store.listSessions().find((row) => row.id === sessionId);
    if (!s) return null;

    const videoBlob = s.videoBlobId ? this.store.getBlob(s.videoBlobId) : undefined;
    const video: SessionVideoDTO | null = videoBlob
      ? {
          blobId: videoBlob.id,
          url: `deskrag://media/${videoBlob.id}`,
          tMonoStart: videoBlob.tMonoStart,
          tMonoEnd: videoBlob.tMonoEnd,
          sizeBytes: videoBlob.byteLength,
        }
      : null;

    // Frames come back ordered by t_mono, so markers are already in timeline order.
    const keyframes: KeyframeMarkerDTO[] = this.store
      .getFramesBySession(sessionId)
      .map((f) => {
        // Most specific (shortest) segment is the best label, as in detail().
        const seg = f.segmentIds
          .map((segId) => this.store.getSegment(segId))
          .filter((x): x is NonNullable<typeof x> => Boolean(x))
          .sort((a, b) => a.tMonoEnd - a.tMonoStart - (b.tMonoEnd - b.tMonoStart))[0];
        return {
          frameId: f.id,
          tMono: f.tMono,
          offsetSec: video ? Math.max(0, (f.tMono - video.tMonoStart) / 1000) : f.tMono / 1000,
          thumbUrl: f.blobId ? `deskrag://frame/${f.blobId}` : null,
          segmentDigest: seg?.digest ?? null,
        };
      });

    return {
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.endedAt ? Math.max(0, s.endedAt - s.startedAt) : 0,
      video,
      keyframes,
      frameCount: s.frameCount,
      segmentCount: s.segmentCount,
      eventCount: s.eventCount,
      sizeBytes: s.byteLength,
    };
  }

  async removeSession(sessionId: string): Promise<void> {
    if (this.state.state !== "idle" && this.state.sessionId === sessionId) {
      throw new Error("That recording is still in progress — stop it before deleting.");
    }
    // Rows first: a row pointing at a deleted file is a broken read, whereas a
    // file with no row is just reclaimable disk.
    await this.store.deleteSession(sessionId);
    await this.blobs.removeSession(sessionId);
    this.lastHighlights.clear();
  }
```

Add `KeyframeMarkerDTO`, `SessionDetailDTO`, `SessionVideoDTO` to the type-only import from `@shared/types`.

- [ ] **Step 3: Add the Range-capable `media` host**

In `app/src/main/protocol.ts`, add the imports and MIME entries:

```ts
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
```

```ts
const MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  wav: "audio/wav",
  aac: "audio/aac",
  mp4: "video/mp4",
  h264: "video/mp4",
};
```

Restructure `protocol.handle` to dispatch on host, keeping `frame` exactly as it is and adding `media`:

```ts
    const url = new URL(request.url);
    const blobId = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const blob = service.getBlobRow(blobId);
    if (!blob) return new Response("not found", { status: 404 });
    const mime = MIME[blob.codec ?? ""] ?? "application/octet-stream";

    if (url.host === "frame") {
      const bytes = await service.readBlob(blob);
      return new Response(bytes as unknown as ConstructorParameters<typeof Response>[0], {
        headers: { "content-type": mime, "cache-control": "no-cache" },
      });
    }
    if (url.host !== "media") return new Response("not found", { status: 404 });

    // Video: stream from disk with Range support — Chromium will not let a
    // <video> seek unless the server answers Range with 206.
    const total = blob.byteLength;
    const range = request.headers.get("range");
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;

    if (!match) {
      return new Response(
        Readable.toWeb(
          createReadStream(blob.path, {
            start: blob.byteOffset,
            end: blob.byteOffset + total - 1,
          }),
        ) as ReadableStream<Uint8Array>,
        {
          status: 200,
          headers: {
            "content-type": mime,
            "content-length": String(total),
            "accept-ranges": "bytes",
          },
        },
      );
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (start >= total || start > end) {
      return new Response("range not satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${total}` },
      });
    }
    return new Response(
      Readable.toWeb(
        createReadStream(blob.path, {
          start: blob.byteOffset + start,
          end: blob.byteOffset + end,
        }),
      ) as ReadableStream<Uint8Array>,
      {
        status: 206,
        headers: {
          "content-type": mime,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${total}`,
          "accept-ranges": "bytes",
        },
      },
    );
```

- [ ] **Step 4: Wire IPC and preload**

In `app/src/main/ipc.ts`, next to the existing `sessionsList` handler:

```ts
  ipcMain.handle(IPC.sessionsDetail, (_e, sessionId: string) => service.sessionDetail(sessionId));
  ipcMain.handle(IPC.sessionsRemove, (_e, sessionId: string) => service.removeSession(sessionId));
```

In `app/src/preload/index.ts`, extend the `sessions` block:

```ts
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionsList),
    detail: (sessionId: string) => ipcRenderer.invoke(IPC.sessionsDetail, sessionId),
    remove: (sessionId: string) => ipcRenderer.invoke(IPC.sessionsRemove, sessionId),
  },
```

- [ ] **Step 5: Build the library and typecheck the app**

```bash
npm run build && npm --prefix app run typecheck
```

Expected: PASS. The Task 7 failures are now resolved.

- [ ] **Step 6: Commit**

```bash
git add app/src/main app/src/preload
git commit -m "feat(app): session detail/remove service + Range-capable deskrag://media"
```

---

### Task 9: The Library screen

**Files:**
- Create: `app/src/renderer/src/screens/LibraryScreen.tsx`
- Modify: `app/src/renderer/src/App.tsx` (fourth nav route)
- Modify: `app/src/renderer/src/icons.tsx` (`IconLibrary`)
- Modify: `app/src/renderer/src/api.ts` (a `formatBytes` helper)
- Modify: `app/src/renderer/src/styles.css` (new classes)

**Interfaces:**
- Consumes: `api.sessions.list/detail/remove`, the DTOs from Task 7, the existing `DetailView` component, and `timecode`/`wallClock` from `api.ts`.
- Produces: the `LibraryScreen` component; `formatBytes(n: number): string` in `api.ts`.

- [ ] **Step 1: Add the icon and the byte formatter**

In `app/src/renderer/src/icons.tsx`, following the existing icon shape (check how `IconSearch` is declared and match its props type and stroke conventions exactly):

```tsx
export function IconLibrary(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" {...props}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="none" />
      <path d="M7 21h10" />
    </svg>
  );
}
```

In `app/src/renderer/src/api.ts`:

```ts
/** Byte count -> a compact human string (1.4 GB). */
export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
```

- [ ] **Step 2: Write the Library screen**

Create `app/src/renderer/src/screens/LibraryScreen.tsx`:

```tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyframeMarkerDTO, SessionDetailDTO, SessionSummaryDTO } from "@shared/types";
import { api, formatBytes, timecode, wallClock } from "../api.js";
import { GhostLottie } from "../brand/GhostLottie.js";
import { DetailView } from "./DetailView.js";

const SPEEDS = [0.5, 1, 2, 4];

export function LibraryScreen(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummaryDTO[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetailDTO | null>(null);
  const [confirming, setConfirming] = useState<SessionSummaryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await api.sessions.list();
    setSessions(list);
    setSelected((cur) => (cur && list.some((s) => s.id === cur) ? cur : (list[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let live = true;
    void api.sessions.detail(selected).then((d) => {
      if (live) setDetail(d);
    });
    return () => {
      live = false;
    };
  }, [selected]);

  const remove = async (s: SessionSummaryDTO): Promise<void> => {
    setConfirming(null);
    setError(null);
    try {
      await api.sessions.remove(s.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!sessions) return <div className="spinner" />;

  return (
    <div className="page">
      <div className="page__head">
        <span className="eyebrow">Library</span>
        <h1>Your recordings</h1>
        <p>
          Every session you have captured. Play one back — the ticks under the scrubber mark the
          keyframes that were indexed and searched.
        </p>
      </div>

      {error && (
        <div className="banner" style={{ marginTop: 16 }}>
          <span className="led" /> {error}
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="empty">
          <GhostLottie size={104} className="empty__ghost" playing />
          <h3>No recordings yet</h3>
          <p>Record a session on the Record tab and it will show up here.</p>
        </div>
      ) : (
        <div className="library">
          <div className="library__list">
            {sessions.map((s) => (
              <button
                key={s.id}
                className={`sessioncard${selected === s.id ? " is-active" : ""}`}
                onClick={() => setSelected(s.id)}
              >
                <div className="sessioncard__thumb">
                  {s.posterUrl ? (
                    <img src={s.posterUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="frame__noimg">no keyframe</span>
                  )}
                  {s.hasVideo && <span className="sessioncard__badge mono">VIDEO</span>}
                </div>
                <div className="sessioncard__body">
                  <div className="sessioncard__when">{wallClock(s.startedAt)}</div>
                  <div className="sessioncard__meta mono">
                    {timecode(s.durationMs)} · {s.frameCount} frames · {formatBytes(s.sizeBytes)}
                  </div>
                </div>
                <span
                  className="sessioncard__del"
                  role="button"
                  aria-label="Delete recording"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirming(s);
                  }}
                >
                  ✕
                </span>
              </button>
            ))}
          </div>

          <div className="library__stage">
            {detail ? <SessionPlayer detail={detail} /> : <div className="spinner" />}
          </div>
        </div>
      )}

      {confirming && (
        <div className="overlay" onClick={() => setConfirming(null)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <h3>Delete this recording?</h3>
            <p>
              {wallClock(confirming.startedAt)} · {timecode(confirming.durationMs)} ·{" "}
              {formatBytes(confirming.sizeBytes)}
            </p>
            <p className="confirm__warn">
              The video, keyframes, transcripts, and search index for this session are removed
              permanently. This cannot be undone.
            </p>
            <div className="confirm__actions">
              <button className="btn ghost" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void remove(confirming)}>
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write the player, in the same file**

Append to `LibraryScreen.tsx`:

```tsx
function SessionPlayer({ detail }: { detail: SessionDetailDTO }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [openFrame, setOpenFrame] = useState<string | null>(null);
  const [hover, setHover] = useState<KeyframeMarkerDTO | null>(null);

  // Fall back to the t_mono span until the element reports its real duration.
  const span = detail.video ? (detail.video.tMonoEnd - detail.video.tMonoStart) / 1000 : 0;
  const total = duration || span;

  const seek = useCallback((sec: number): void => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(sec, v.duration || sec));
  }, []);

  const nearest = useMemo(() => {
    if (detail.keyframes.length === 0) return null;
    return detail.keyframes.reduce((best, k) =>
      Math.abs(k.offsetSec - position) < Math.abs(best.offsetSec - position) ? k : best,
    );
  }, [detail.keyframes, position]);

  const step = useCallback(
    (dir: 1 | -1): void => {
      const ks = detail.keyframes;
      if (ks.length === 0) return;
      const next =
        dir === 1
          ? ks.find((k) => k.offsetSec > position + 0.01)
          : [...ks].reverse().find((k) => k.offsetSec < position - 0.01);
      if (next) seek(next.offsetSec);
    },
    [detail.keyframes, position, seek],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (openFrame) return; // DetailView owns the keyboard while it is open
      if (e.key === " ") {
        e.preventDefault();
        const v = videoRef.current;
        if (v) void (v.paused ? v.play() : v.pause());
      } else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, openFrame]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed]);

  if (!detail.video) {
    return (
      <div className="player">
        <div className="player__note">
          No video for this session — it was recorded before video capture, or with the Screen
          signal off. Its {detail.keyframes.length} indexed keyframes:
        </div>
        <div className="sheet">
          {detail.keyframes.map((k) => (
            <button key={k.frameId} className="frame" onClick={() => setOpenFrame(k.frameId)}>
              <div className="frame__thumb">
                {k.thumbUrl ? <img src={k.thumbUrl} alt="" loading="lazy" /> : null}
                <span className="frame__tc mono">{timecode(k.tMono)}</span>
              </div>
            </button>
          ))}
        </div>
        {openFrame && <DetailView frameId={openFrame} onClose={() => setOpenFrame(null)} />}
      </div>
    );
  }

  return (
    <div className="player">
      <video
        ref={videoRef}
        className="player__video"
        src={detail.video.url}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={(e) => void (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())}
      />

      <div className="player__bar">
        <button
          className="btn ghost"
          onClick={() => {
            const v = videoRef.current;
            if (v) void (v.paused ? v.play() : v.pause());
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="btn ghost" onClick={() => step(-1)} title="Previous keyframe">
          ⏮
        </button>
        <button className="btn ghost" onClick={() => step(1)} title="Next keyframe">
          ⏭
        </button>
        <span className="mono player__time">
          {timecode(position * 1000)} / {timecode(total * 1000)}
        </span>
        <select
          className="player__speed mono"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={!nearest}
          onClick={() => nearest && setOpenFrame(nearest.frameId)}
        >
          Inspect keyframe
        </button>
      </div>

      <div
        className="scrub"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seek(((e.clientX - r.left) / r.width) * total);
        }}
      >
        <div className="scrub__fill" style={{ width: `${total ? (position / total) * 100 : 0}%` }} />
        <div className="scrub__head" style={{ left: `${total ? (position / total) * 100 : 0}%` }} />
      </div>

      <div className="ticks">
        {detail.keyframes.map((k) => (
          <span
            key={k.frameId}
            className={`tick${nearest?.frameId === k.frameId ? " is-near" : ""}`}
            style={{ left: `${total ? (k.offsetSec / total) * 100 : 0}%` }}
            title={k.segmentDigest ?? timecode(k.tMono)}
            onMouseEnter={() => setHover(k)}
            onMouseLeave={() => setHover(null)}
            onClick={() => seek(k.offsetSec)}
          />
        ))}
        {hover?.thumbUrl && (
          <img
            className="tick__peek"
            src={hover.thumbUrl}
            alt=""
            style={{ left: `${total ? (hover.offsetSec / total) * 100 : 0}%` }}
          />
        )}
      </div>

      <div className="player__meta mono">
        {detail.keyframes.length} keyframes · {detail.segmentCount} segments ·{" "}
        {detail.eventCount} events · {formatBytes(detail.sizeBytes)}
      </div>

      {openFrame && <DetailView frameId={openFrame} onClose={() => setOpenFrame(null)} />}
    </div>
  );
}
```

- [ ] **Step 4: Add the route**

In `app/src/renderer/src/App.tsx`, make four edits.

Imports:

```tsx
import { IconLibrary, IconRecord, IconSearch, IconSettings } from "./icons.js";
import { LibraryScreen } from "./screens/LibraryScreen.js";
```

Route type and nav list:

```tsx
type Route = "record" | "library" | "search" | "settings";

const NAV: { id: Route; label: string; Icon: typeof IconRecord }[] = [
  { id: "record", label: "Record", Icon: IconRecord },
  { id: "library", label: "Library", Icon: IconLibrary },
  { id: "search", label: "Search", Icon: IconSearch },
  { id: "settings", label: "Settings", Icon: IconSettings },
];
```

Replace the topbar title ternary chain with a lookup — a fourth route makes the
nested ternary unreadable:

```tsx
const TITLES: Record<Route, string> = {
  record: "Recorder",
  library: "Library",
  search: "Experience Search",
  settings: "Settings",
};
```

```tsx
          <span className="topbar__title">{TITLES[route]}</span>
```

And render the screen alongside the others in `<main className="content">`:

```tsx
          {route === "library" && <LibraryScreen />}
```

- [ ] **Step 5: Add the styles**

Append to `app/src/renderer/src/styles.css`, reusing the existing custom properties (`--accent`, `--muted`, and whatever surface/border variables the file already defines — read the top of the file and match the names exactly rather than inventing new ones):

```css
/* --- library ------------------------------------------------------------- */
.library { display: grid; grid-template-columns: 300px 1fr; gap: 18px; margin-top: 20px; }
.library__list { display: flex; flex-direction: column; gap: 8px; max-height: 70vh; overflow-y: auto; }
.library__stage { min-width: 0; }

.sessioncard { position: relative; display: flex; gap: 10px; padding: 8px; text-align: left; cursor: pointer; border-radius: 10px; background: transparent; border: 1px solid transparent; }
.sessioncard:hover { border-color: var(--accent); }
.sessioncard.is-active { border-color: var(--accent); }
.sessioncard__thumb { position: relative; flex: 0 0 84px; height: 52px; border-radius: 6px; overflow: hidden; display: grid; place-items: center; }
.sessioncard__thumb img { width: 100%; height: 100%; object-fit: cover; }
.sessioncard__badge { position: absolute; left: 4px; bottom: 4px; font-size: 9px; padding: 1px 4px; border-radius: 3px; background: rgb(0 0 0 / 0.6); color: #fff; }
.sessioncard__body { min-width: 0; }
.sessioncard__when { font-size: 13px; }
.sessioncard__meta { font-size: 11px; color: var(--muted); margin-top: 3px; }
.sessioncard__del { position: absolute; top: 6px; right: 8px; opacity: 0; font-size: 12px; color: var(--muted); }
.sessioncard:hover .sessioncard__del { opacity: 1; }
.sessioncard__del:hover { color: #ff6b6b; }

/* --- player -------------------------------------------------------------- */
.player { display: flex; flex-direction: column; gap: 10px; }
.player__video { width: 100%; max-height: 58vh; border-radius: 10px; background: #000; }
.player__note { font-size: 13px; color: var(--muted); }
.player__bar { display: flex; align-items: center; gap: 8px; }
.player__time { font-size: 12px; color: var(--muted); margin-left: 4px; }
.player__speed { margin-left: auto; }
.player__meta { font-size: 11px; color: var(--muted); }

.scrub { position: relative; height: 6px; border-radius: 3px; background: rgb(128 128 128 / 0.25); cursor: pointer; }
.scrub__fill { height: 100%; border-radius: 3px; background: var(--accent); }
.scrub__head { position: absolute; top: -3px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); transform: translateX(-50%); }

.ticks { position: relative; height: 14px; }
.tick { position: absolute; top: 0; width: 2px; height: 8px; border-radius: 1px; background: var(--muted); transform: translateX(-50%); cursor: pointer; }
.tick:hover, .tick.is-near { background: var(--accent); height: 12px; }
.tick__peek { position: absolute; bottom: 16px; width: 160px; border-radius: 6px; transform: translateX(-50%); pointer-events: none; z-index: 5; }

/* --- confirm ------------------------------------------------------------- */
.confirm { max-width: 420px; padding: 22px; border-radius: 12px; display: flex; flex-direction: column; gap: 10px; }
.confirm__warn { font-size: 12px; color: var(--muted); }
.confirm__actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.btn.danger { background: #c0392b; color: #fff; }
```

The `.confirm` block sits inside the existing `.overlay`, which already handles the backdrop and centering — check `.overlay`'s rules and add a background/border to `.confirm` matching whatever `.detail` uses.

- [ ] **Step 6: Typecheck**

```bash
npm run build && npm --prefix app run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer
git commit -m "feat(app): Library tab — browse, play, and delete recordings"
```

---

### Task 10: Update `CLAUDE.md` and verify end to end

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything.
- Produces: documentation matching reality.

- [ ] **Step 1: Fix the two now-false invariants**

In `CLAUDE.md`, under the desktop-app section, the "Data dir" bullet says the library has no list-all read and the app keeps `sessions.json`. Replace that clause with a note that `DualStore.listSessions()` is the authoritative read and `sessions.json` is gone. Remove `sessions.json` from the data-dir file list.

In the pipeline section, note that `FfmpegScreenProducer` emits **three** outputs: the gray pHash stream, the MJPEG keyframes, and a continuous H.264 file registered as a `screen` blob (distinct from the sampled `keyframe` blobs), and that producers register subprocess-written files through `ctx.reserveBlob`/`ctx.commitBlob`.

- [ ] **Step 2: Run every gate**

```bash
npm run typecheck && npm test && npm run build && npm --prefix app run typecheck
```

Expected: all four pass. Report the actual test counts.

- [ ] **Step 3: Manual verification**

```bash
npm run app:dev
```

Walk through and confirm each:
1. Record ~30 s with the Screen signal on; stop and let indexing finish.
2. Open **Library** — the session appears with a poster thumbnail, duration, frame count, size, and a `VIDEO` badge.
3. The video plays. Space toggles play/pause; the scrubber seeks by click (this is what proves the `206` Range path works — without it the video will not seek).
4. Keyframe ticks appear under the scrubber; hovering shows a thumbnail; clicking one seeks there.
5. "Inspect keyframe" opens the existing `DetailView` with digest/AX for the nearest frame; Escape closes it.
6. Delete the session, confirm, and verify the list empties **and** the directory is gone:
   ```bash
   ls ~/Library/Application\ Support/deskrag-app/DeskRAG/blobs/
   ```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: session library changes to the capture and app invariants"
```

---

## Notes for the implementer

- **Task 4 is the risky one.** The filter-graph rewrite changes how the *existing* pHash/keyframe path is fed (the `fps` filter moves from the input onto the branches). If `test/ffmpeg-screen.test.ts`'s original keyframe test regresses, the graph is wrong — fix the graph, do not relax the test.
- **Video seeking is the acceptance test for Task 8.** If the scrubber jumps back to 0 or refuses to move, the `Range` handler is returning `200` instead of `206`, or `content-range` is malformed.
- Fragmented MP4 means `video.duration` may be `Infinity` in some Chromium versions until enough of the file is buffered. The player already falls back to the `t_mono` span; if `Infinity` leaks through, guard `setDuration` with `Number.isFinite(d) ? d : 0`.
