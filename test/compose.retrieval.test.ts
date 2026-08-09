import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { FakeSummaryProvider } from "../src/embed/summary.js";
import { ComposeRepresenter } from "../src/represent/compose/compose-representer.js";
import type { DualStore } from "../src/store/store.js";
import { id, makeStore } from "./helpers.js";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function withActions(n: number): Promise<{ store: DualStore; sessionId: string }> {
  const ctx = await makeStore();
  cleanup = ctx.cleanup;
  const sessionId = id();
  await ctx.store.putSession({ id: sessionId, startedAt: Date.now(), epochMono: 0 });
  for (let i = 0; i < n; i++) {
    await ctx.store.putSegments([
      {
        id: id(),
        sessionId,
        granularity: "action",
        tMonoStart: i * 1000,
        tMonoEnd: (i + 1) * 1000,
        digest: `action ${i}`,
      },
    ]);
  }
  return { store: ctx.store, sessionId };
}

describe("the summary vector space", () => {
  it("registers a summary namespace and writes one vector per composed node", async () => {
    const { store, sessionId } = await withActions(4);
    const embedder = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });

    const rep = new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
      summaryEmbedder: embedder,
    });
    const r = await rep.represent(sessionId);

    expect(rep.namespace).toBe("summary:fake:m:4");
    expect(store.listVectorSpaces().map((s) => s.namespace)).toContain(rep.namespace);

    const [q] = await embedder.embed(["anything"]);
    const hits = await store.searchSegments(rep.namespace!, q!, 100);
    // One vector per COMPOSED node — a leaf has no summary and so no vector.
    expect(hits).toHaveLength(r.nodes);
  });

  it("registers NO space and writes no vectors without an embedder", async () => {
    const { store, sessionId } = await withActions(4);
    const rep = new ComposeRepresenter(store, { summarizer: new FakeSummaryProvider(2) });

    await rep.represent(sessionId);

    expect(rep.namespace).toBeNull();
    expect(store.listVectorSpaces().some((s) => s.namespace.startsWith("summary:"))).toBe(false);
  });

  it("REPLACES on a re-index rather than accumulating", async () => {
    const { store, sessionId } = await withActions(4);
    const embedder = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });
    const rep = new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
      summaryEmbedder: embedder,
    });

    const first = await rep.represent(sessionId);
    await rep.represent(sessionId);

    const [q] = await embedder.embed(["anything"]);
    const hits = await store.searchSegments(rep.namespace!, q!, 100);
    // A bare `add` would leave two vectors under one id, and NEITHER is an
    // orphan, so reconcile() could never prune them.
    expect(hits).toHaveLength(first.nodes);
  });

  it("leaves reconciliation clean — text is committed before the vector", async () => {
    const { store, sessionId } = await withActions(6);
    const embedder = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });
    await new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
      summaryEmbedder: embedder,
    }).represent(sessionId);

    const rec = await store.reconcile();
    expect(rec.orphansPruned).toBe(0);
  });

  it("drops a level's vectors when composing replaces it", async () => {
    const { store, sessionId } = await withActions(8);
    const embedder = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });
    const rep = new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(2),
      summaryEmbedder: embedder,
    });
    await rep.represent(sessionId);

    // Re-compose with a coarser grouping: fewer nodes, so the old ids are gone.
    const coarser = new ComposeRepresenter(store, {
      summarizer: new FakeSummaryProvider(4),
      summaryEmbedder: embedder,
    });
    const r2 = await coarser.represent(sessionId);

    const [q] = await embedder.embed(["anything"]);
    const hits = await store.searchSegments(rep.namespace!, q!, 100);
    expect(hits).toHaveLength(r2.nodes);
    expect((await store.reconcile()).orphansPruned).toBe(0);
  });
});
