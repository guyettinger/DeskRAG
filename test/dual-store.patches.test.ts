import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { LanceStore } from "../src/store/lance/tables.js";
import { FakeMultiVectorProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";

const provider = new FakeMultiVectorProvider(16, 3);
const NS = namespaceFor("frame_patches", provider);

let dir: string;
let store: DualStore;
let lance: LanceStore;
let sessionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dsp-"));
  // Hold the vector side directly so a test can plant a row that SQLite never
  // saw — the only way to produce a genuine orphan, since putFramePatches
  // writes frame_segment first and the FK would reject a phantom frame.
  lance = await LanceStore.open(join(dir, "lance"));
  store = await DualStore.open(join(dir, "app.db"), join(dir, "lance"), lance);
  await store.registerVectorSpace({
    namespace: NS,
    view: "frame_patches",
    providerId: provider.id,
    model: provider.model,
    dimensions: provider.dimensions,
    sharedTextSpace: true,
  });
  sessionId = ulid();
  await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  // frame_segment carries a real FK, so the scope segments must exist.
  await store.putSegments([
    { id: "segA", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 500 },
    { id: "segB", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 500 },
  ]);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addFrame(id: string, tMono: number): Promise<void> {
  await store.putFrames([
    {
      id,
      sessionId,
      tMono,
      width: 1280,
      height: 800,
      phash: 0n,
      frameOffset: 0,
      segmentIds: [],
    },
  ]);
}

describe("DualStore frame patches", () => {
  it("writes and searches patch vectors", async () => {
    await addFrame("f1", 100);
    await addFrame("f2", 200);
    const [pa, pb] = await provider.embedImages([
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([9, 9, 9]),
    ]);
    await store.putFramePatches([
      { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
      { frameId: "f2", sessionId, segmentIds: ["segB"], namespace: NS, patches: pb! },
    ]);
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const hits = await store.searchFramePatches(NS, q!, 5);
    expect(hits[0]!.id).toBe("f1");
  });

  it("scopes patch search to Tier-1 segments", async () => {
    await addFrame("f1", 100);
    await addFrame("f2", 200);
    const [pa, pb] = await provider.embedImages([
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([9, 9, 9]),
    ]);
    await store.putFramePatches([
      { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
      { frameId: "f2", sessionId, segmentIds: ["segB"], namespace: NS, patches: pb! },
    ]);
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const hits = await store.searchFramePatches(NS, q!, 5, { segmentIds: ["segB"] });
    expect(hits.map((h) => h.id)).toEqual(["f2"]);
  });

  it("throws for an unregistered namespace", async () => {
    await expect(
      store.searchFramePatches("frame_patches:nope:nope:16", [new Float32Array(16)], 5),
    ).rejects.toThrow();
  });

  it("does not prune or report multivector rows during reconciliation", async () => {
    await addFrame("f1", 100);
    const [pa] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    await store.putFramePatches([
      { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
    ]);
    const res = await store.reconcile();
    // Patch ids are FRAME ids. If reconcile treated this namespace as a segment
    // space it would find no matching segment row and prune every patch row.
    expect(res.orphansPruned).toBe(0);
    expect(res.missing.filter((m) => m.namespace === NS)).toEqual([]);
    // and the row must still be searchable afterwards
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    expect((await store.searchFramePatches(NS, q!, 5)).length).toBe(1);
  });

  it("still prunes a genuine orphan patch row", async () => {
    await addFrame("f1", 100);
    const [pa] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    await store.putFramePatches([
      { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
    ]);
    // Plant a vector whose frame row does not exist — the shape a crash between
    // the SQLite delete and the Lance delete would leave behind.
    await lance.addPatches(NS, [
      {
        id: "ghost",
        session_id: sessionId,
        segment_ids: ["segA"],
        patches: pa!.map((v) => Array.from(v)),
      },
    ]);

    const res = await store.reconcile();
    expect(res.orphansPruned).toBe(1);
    // and the legitimate row survived
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    expect((await store.searchFramePatches(NS, q!, 5)).map((h) => h.id)).toEqual(["f1"]);
  });

  it("is idempotent — a second write does not duplicate the row", async () => {
    await addFrame("f1", 100);
    const [pa] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const row = {
      frameId: "f1",
      sessionId,
      segmentIds: ["segA"],
      namespace: NS,
      patches: pa!,
    };
    await store.putFramePatches([row]);
    await store.putFramePatches([row]);
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    const hits = await store.searchFramePatches(NS, q!, 10);
    expect(hits.filter((h) => h.id === "f1").length).toBe(1);
  });

  it("deletes patch rows with the session", async () => {
    await addFrame("f1", 100);
    const [pa] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    await store.putFramePatches([
      { frameId: "f1", sessionId, segmentIds: ["segA"], namespace: NS, patches: pa! },
    ]);
    await store.deleteSession(sessionId);
    const [q] = await provider.embedImages([Uint8Array.from([1, 2, 3])]);
    expect(await store.searchFramePatches(NS, q!, 5)).toEqual([]);
  });
});
