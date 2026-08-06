import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import type { EventInsert } from "../src/store/types.js";

describe("segment_app_caption (Store.updateSegmentAppCaption / getAppCaption)", () => {
  let dir: string;
  let store: DualStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "erag-appcap-store-"));
    store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips text, and cascade-deletes with its segment's session", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.putEvents([{ id: ulid(), sessionId, tMono: 0, kind: "mouse_move" } as EventInsert]);
    await store.endSession(sessionId, 1000);
    await store.putSegments([
      { id: "seg1", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
    ]);

    expect(store.getAppCaption("seg1")).toBeUndefined();
    await store.updateSegmentAppCaption("seg1", "Calculator showing 1 + 1 = 2");
    expect(store.getAppCaption("seg1")).toBe("Calculator showing 1 + 1 = 2");

    // Overwrite, don't duplicate.
    await store.updateSegmentAppCaption("seg1", "Calculator showing 2");
    expect(store.getAppCaption("seg1")).toBe("Calculator showing 2");

    await store.deleteSession(sessionId);
    expect(store.getAppCaption("seg1")).toBeUndefined();
  });

  it("reconcile() treats app_caption like the other text views: missing vector -> re-embed candidate", async () => {
    const sessionId = ulid();
    await store.putSession({ id: sessionId, startedAt: 0, epochMono: 0 });
    await store.endSession(sessionId, 1000);
    await store.putSegments([
      { id: "seg1", sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 1000 },
    ]);
    await store.registerVectorSpace({
      namespace: "app_caption:fake:m:8",
      view: "app_caption",
      providerId: "fake",
      model: "m",
      dimensions: 8,
      sharedTextSpace: false,
    });
    // Text written, no vector — simulating a crash between the two writes.
    await store.updateSegmentAppCaption("seg1", "hello");

    const result = await store.reconcile();
    expect(result.missing.some((m) => m.entity === "segment" && m.id === "seg1")).toBe(true);
  });
});
