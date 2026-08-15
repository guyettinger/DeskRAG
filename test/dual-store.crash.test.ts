import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { DualStore } from "../src/store/store.js";
import { FakeEmbeddingProvider } from "../src/embed/fake.js";
import { namespaceFor } from "../src/embed/types.js";
import type { MissingVector } from "../src/store/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const childScript = join(here, "..", "scripts", "crash-child.ts");

/**
 * Headline dual-store test: kill the process between the SQLite commit and the
 * Lance add, then prove reconciliation recovers the missing vector from the
 * relational content SQLite retained. Real child process, real SQLite (WAL),
 * real LanceDB.
 *
 * The subject is a SEGMENT vector now rather than a region one — regions stopped
 * carrying vectors with the single-vector image lane. The invariant is the same
 * and so is the shape of the failure: a committed row whose source text is still
 * on disk and whose vector never landed.
 */
describe("dual-store crash recovery", () => {
  let dir: string;
  const provider = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });
  const namespace = namespaceFor("digest", provider);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "erag-crash-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("recovers a segment whose vector never landed", async () => {
    const sqlitePath = join(dir, "meta.sqlite");
    const lanceDir = join(dir, "lance");
    const payload = {
      sessionId: ulid(),
      segId: ulid(),
      namespace,
      digest: "clicked dialog Save As",
    };

    // 1. Run the child that commits SQLite then dies during the Lance add.
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", childScript, sqlitePath, lanceDir, JSON.stringify(payload)],
      { encoding: "utf8" },
    );
    // Exit code 1 == our kill-on-add. Anything else means the gap wasn't hit.
    expect(res.status, `child stderr: ${res.stderr}`).toBe(1);

    // 2. Reopen with a real Lance layer. The segment row exists; its vector doesn't.
    const store = await DualStore.open(sqlitePath, lanceDir);
    try {
      const before = await store.reconcile();
      expect(before.orphansPruned).toBe(0);
      expect(before.missing.map((m) => m.id)).toEqual([payload.segId]);
      const miss = before.missing[0]!;
      expect(miss.entity).toBe("segment");
      // The retained relational content is what makes re-embedding possible.
      expect(miss.segment?.digest).toBe(payload.digest);

      // A query for the segment's vector finds NOTHING yet (no vector present).
      const q = Float32Array.from([1, 0, 0, 0]);
      expect(await store.searchSegments(namespace, q, 5)).toHaveLength(0);

      // 3. Reconcile + re-embed from retained content (deterministic fake).
      const reembed = async (missing: MissingVector[]) => {
        const out: { namespace: string; id: string; vector: Float32Array }[] = [];
        for (const m of missing) {
          const [vec] = await provider.embed([m.segment?.digest ?? ""]);
          out.push({ namespace: m.namespace, id: m.id, vector: vec! });
        }
        return out;
      };
      const after = await store.reconcileAndReembed(reembed);
      expect(after.missing.map((m) => m.id)).toEqual([payload.segId]);

      // 4. The vector is now present and the segment is retrievable.
      const [expected] = await provider.embed([payload.digest]);
      const hits = await store.searchSegments(namespace, expected!, 5);
      expect(hits.map((h) => h.id)).toContain(payload.segId);

      // 5. And a second reconcile finds nothing missing (idempotent recovery).
      const clean = await store.reconcile();
      expect(clean.missing).toHaveLength(0);
      expect(clean.orphansPruned).toBe(0);
    } finally {
      store.close();
    }
  });
});
