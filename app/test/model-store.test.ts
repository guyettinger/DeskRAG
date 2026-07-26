import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelFilesMissingError, ModelStore } from "../src/main/model-store.js";
import type { ModelSpec } from "../src/main/models.js";

const BODY = Buffer.from("weights-bytes");
const SHA = createHash("sha256").update(BODY).digest("hex");

// 512KB served in 64KB chunks — enough to observe streaming progress.
const BIG = Buffer.alloc(512 * 1024, 7);
const BIG_SHA = createHash("sha256").update(BIG).digest("hex");

let server: Server;
let base: string;
let dir: string;
let served = 0;

beforeEach(async () => {
  served = 0;
  dir = mkdtempSync(join(tmpdir(), "ms-"));
  server = createServer((req, res) => {
    served++;
    if (req.url?.includes("missing")) {
      res.writeHead(404).end("nope");
      return;
    }
    if (req.url?.includes("big")) {
      res.writeHead(200, { "content-length": String(BIG.length) });
      for (let i = 0; i < BIG.length; i += 64 * 1024) {
        res.write(BIG.subarray(i, i + 64 * 1024));
      }
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": String(BODY.length) }).end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const spec = (sha = SHA, path = "onnx/model.onnx"): ModelSpec => ({
  id: "test-model",
  source: "download",
  repo: "org/repo",
  revision: "abc123",
  files: [{ path, sha256: sha, bytes: BODY.length }],
});

const bigSpec = (): ModelSpec => ({
  id: "test-model",
  source: "download",
  repo: "org/repo",
  revision: "abc123",
  files: [{ path: "big.onnx", sha256: BIG_SHA, bytes: BIG.length }],
});

describe("ModelStore — download source", () => {
  it("downloads, verifies, and returns the local directory", async () => {
    const store = new ModelStore(dir, { baseUrl: base });
    const out = await store.ensure(spec());
    expect(out).toBe(join(dir, "test-model"));
    expect(readFileSync(join(out, "model.onnx")).toString()).toBe(BODY.toString());
  });

  it("does not re-download when the file is already present", async () => {
    const store = new ModelStore(dir, { baseUrl: base });
    await store.ensure(spec());
    const after = served;
    await store.ensure(spec());
    expect(served).toBe(after);
  });

  it("deletes the file and throws on a checksum mismatch", async () => {
    const store = new ModelStore(dir, { baseUrl: base });
    await expect(store.ensure(spec("0".repeat(64)))).rejects.toThrow(/checksum/i);
    expect(existsSync(join(dir, "test-model", "model.onnx"))).toBe(false);
  });

  it("leaves no .partial behind after a failed download", async () => {
    const store = new ModelStore(dir, { baseUrl: base });
    await expect(store.ensure(spec(SHA, "missing.onnx"))).rejects.toThrow();
    expect(existsSync(join(dir, "test-model", "missing.onnx.partial"))).toBe(false);
    expect(existsSync(join(dir, "test-model", "missing.onnx"))).toBe(false);
  });

  it("shares one promise across concurrent calls", async () => {
    const store = new ModelStore(dir, { baseUrl: base });
    const [a, b] = await Promise.all([store.ensure(spec()), store.ensure(spec())]);
    expect(a).toBe(b);
    expect(served).toBe(1); // not two racing downloads of the same file
  });

  it("uses overrideDir and skips download and verification entirely", async () => {
    const over = mkdtempSync(join(tmpdir(), "over-"));
    mkdirSync(join(over, "test-model"), { recursive: true });
    writeFileSync(join(over, "test-model", "model.onnx"), "hand-curated");
    const store = new ModelStore(dir, { baseUrl: base, overrideDir: over });
    const out = await store.ensure(spec("0".repeat(64))); // wrong sha, ignored
    expect(out).toBe(join(over, "test-model"));
    expect(served).toBe(0);
    rmSync(over, { recursive: true, force: true });
  });

  it("reports progress and a final done event", async () => {
    const events: { modelId: string; done: boolean }[] = [];
    const store = new ModelStore(dir, { baseUrl: base, onProgress: (p) => events.push(p) });
    await store.ensure(spec());
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)!.done).toBe(true);
    expect(events.at(-1)!.modelId).toBe("test-model");
  });

  it("builds the pinned-revision URL, never a branch", async () => {
    const urls: string[] = [];
    const store = new ModelStore(dir, {
      baseUrl: base,
      fetchImpl: (async (u: string) => {
        urls.push(String(u));
        return new Response(BODY, { status: 200 });
      }) as unknown as typeof fetch,
    });
    await store.ensure(spec());
    expect(urls[0]).toContain("/org/repo/resolve/abc123/onnx/model.onnx");
    expect(urls[0]).not.toContain("/main/");
  });

  it("streams to disk with incremental progress, not one jump to 100%", async () => {
    const events: number[] = [];
    const store = new ModelStore(dir, {
      baseUrl: base,
      progressIntervalBytes: 1, // emit on every chunk
      onProgress: (p) => events.push(p.receivedBytes),
    });
    await store.ensure(bigSpec());

    expect(readFileSync(join(dir, "test-model", "big.onnx")).length).toBe(BIG.length);
    // Real intermediate readings, not just 0 and total.
    const mid = events.filter((n) => n > 0 && n < BIG.length);
    expect(mid.length).toBeGreaterThan(0);
    // Progress never goes backwards.
    expect(events).toEqual([...events].sort((a, b) => a - b));
  });

  it("leaves no .partial when the stream fails mid-download", async () => {
    const store = new ModelStore(dir, {
      baseUrl: base,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array([1, 2, 3]));
              c.error(new Error("boom"));
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    await expect(store.ensure(spec())).rejects.toThrow(/boom/);
    expect(existsSync(join(dir, "test-model", "model.onnx.partial"))).toBe(false);
    expect(existsSync(join(dir, "test-model", "model.onnx"))).toBe(false);
  });

  it("does not leak an unhandled stream error when the write target vanishes", async () => {
    const seen: unknown[] = [];
    const onUncaught = (e: unknown) => seen.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const store = new ModelStore(dir, {
        baseUrl: base,
        fetchImpl: (async () => {
          // ensureOnce has already mkdir'd the target. Removing it here makes
          // createWriteStream's deferred open fail with ENOENT *after* the
          // body has errored — the ordering that leaves destroy() holding an
          // error nobody listens for.
          rmSync(join(dir, "test-model"), { recursive: true, force: true });
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.error(new Error("boom"));
              },
            }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      });
      await expect(store.ensure(spec())).rejects.toThrow(/boom/);
      await new Promise((r) => setTimeout(r, 150)); // let the deferred open land
      expect(seen).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("throws with the missing names when overrideDir is incomplete", async () => {
    const over = mkdtempSync(join(tmpdir(), "over-"));
    mkdirSync(join(over, "test-model"), { recursive: true }); // dir exists, file does not
    const store = new ModelStore(dir, { baseUrl: base, overrideDir: over });
    const err = await store.ensure(spec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelFilesMissingError);
    expect((err as ModelFilesMissingError).missing).toEqual(["model.onnx"]);
    expect((err as ModelFilesMissingError).modelId).toBe("test-model");
    expect(served).toBe(0); // an override never downloads
    rmSync(over, { recursive: true, force: true });
  });
});
