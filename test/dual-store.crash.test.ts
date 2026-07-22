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
 */
describe("dual-store crash recovery", () => {
  let dir: string;
  const provider = new FakeEmbeddingProvider({ id: "fake", model: "m", dimensions: 4 });
  const namespace = namespaceFor("region_image", provider);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "erag-crash-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("recovers a region whose vector never landed", async () => {
    const sqlitePath = join(dir, "meta.sqlite");
    const lanceDir = join(dir, "lance");
    const payload = {
      sessionId: ulid(), segId: ulid(), frameId: ulid(), regionId: ulid(),
      namespace, label: "Save As", role: "dialog",
    };

    // 1. Run the child that commits SQLite then dies during the Lance add.
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", childScript, sqlitePath, lanceDir, JSON.stringify(payload)],
      { encoding: "utf8" },
    );
    // Exit code 1 == our kill-on-add. Anything else means the gap wasn't hit.
    expect(res.status, `child stderr: ${res.stderr}`).toBe(1);

    // 2. Reopen with a real Lance layer. The region row exists; its vector doesn't.
    const store = await DualStore.open(sqlitePath, lanceDir);
    try {
      const before = await store.reconcile();
      expect(before.orphansPruned).toBe(0);
      expect(before.missing.map((m) => m.id)).toEqual([payload.regionId]);
      const miss = before.missing[0]!;
      expect(miss.entity).toBe("region");
      // The retained relational content is what makes re-embedding possible.
      expect(miss.region?.label).toBe("Save As");
      expect(miss.region?.role).toBe("dialog");

      // A query for the region's vector finds NOTHING yet (no vector present).
      const q = Float32Array.from([1, 0, 0, 0]);
      expect(await store.searchRegions(namespace, q, 5, { frameIds: [payload.frameId] })).toHaveLength(0);

      // 3. Reconcile + re-embed from retained content (deterministic fake).
      const reembed = async (missing: MissingVector[]) => {
        const out: { namespace: string; id: string; vector: Float32Array }[] = [];
        for (const m of missing) {
          const text = `${m.region?.role ?? ""} ${m.region?.label ?? ""}`;
          const [vec] = await provider.embed([text]);
          out.push({ namespace: m.namespace, id: m.id, vector: vec! });
        }
        return out;
      };
      const after = await store.reconcileAndReembed(reembed);
      expect(after.missing.map((m) => m.id)).toEqual([payload.regionId]);

      // 4. The vector is now present and the region is retrievable.
      const hits = await store.searchRegions(namespace, q, 5, { frameIds: [payload.frameId] });
      expect(hits.map((h) => h.id)).toContain(payload.regionId);

      // 5. And a second reconcile finds nothing missing (idempotent recovery).
      const clean = await store.reconcile();
      expect(clean.missing).toHaveLength(0);
      expect(clean.orphansPruned).toBe(0);
    } finally {
      store.close();
    }
  });
});
