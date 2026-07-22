import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { namespaceFor, type View } from "../src/embed/types.js";
import type { VectorSpaceInsert } from "../src/store/types.js";

export interface TestCtx {
  store: DualStore;
  dir: string;
  provider: FakeEmbeddingProvider;
  ns: (view: View) => string;
  cleanup: () => void;
}

/** A throwaway store on a fresh tmp dir, with the given views registered. */
export async function makeStore(
  views: View[] = ["frame_image", "region_image"],
  dims = 4,
): Promise<TestCtx> {
  const dir = mkdtempSync(join(tmpdir(), "erag-"));
  const store = await DualStore.open(join(dir, "meta.sqlite"), join(dir, "lance"));
  const provider = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: dims });
  const ns = (view: View) => namespaceFor(view, provider);
  for (const view of views) {
    const space: VectorSpaceInsert = {
      namespace: ns(view),
      view,
      providerId: provider.id,
      model: provider.model,
      dimensions: provider.dimensions,
      sharedTextSpace: provider.sharedTextSpace,
    };
    await store.registerVectorSpace(space);
  }
  return {
    store,
    dir,
    provider,
    ns,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const id = () => ulid();

/** Seed a session + two segments (A, B). Returns their ids. */
export async function seedSessionWithSegments(store: DualStore) {
  const sessionId = id();
  await store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  const segA = id();
  const segB = id();
  await store.putSegments([
    { id: segA, sessionId, granularity: "action", tMonoStart: 0, tMonoEnd: 10 },
    { id: segB, sessionId, granularity: "action", tMonoStart: 10, tMonoEnd: 20 },
  ]);
  return { sessionId, segA, segB };
}
