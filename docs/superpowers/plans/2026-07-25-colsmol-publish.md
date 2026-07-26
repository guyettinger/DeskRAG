# Publishing the Dynamic ColSmol Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `MODELS.colsmol` an ordinary streamed HuggingFace download instead of a model each user must build locally with a Python toolchain.

**Architecture:** The dynamic-tile ColSmol ONNX export is a deterministic build artifact, not user setup, and its MIT/Apache-2.0 licensing permits redistribution. It is published once to `guyettinger/colSmol-256M-dynamic-onnx` and fetched by pinned commit SHA with SHA-256 verification, exactly like `MODELS.text` and `MODELS.reranker`. Because the artifact is 954 MB, `ModelStore` must stream to disk rather than buffer whole files in the Electron main process. Publishing strands the entire `source: "local"` mechanism, which is deleted.

**Tech Stack:** TypeScript (strict, ESM), Electron main process, Node streams (`node:fs` `createWriteStream`, `node:events` `once`), `node:crypto` incremental hashing, vitest with a real `node:http` fixture server.

**Spec:** `docs/superpowers/specs/2026-07-25-colsmol-publish-design.md`

## Global Constraints

- **`MODELS.colsmol.id` stays exactly `"colSmol-256M-dynamic"`.** It is part of the vector namespace (`view:provider:model:dimensions`); renaming it orphans any Lance table built under it.
- **`revision` is a commit SHA, never `"main"`.** A moving branch would change weights while the namespace kept claiming the same model.
- **Never fall back to unverified bytes.** On checksum mismatch, delete the `.partial` and throw. Wrong weights produce vectors that are silently wrong inside a table claiming otherwise.
- **`.partial` → verify → atomic `renameSync`.** A partial file must never look complete. Streaming does not weaken this: the rename still happens only after the full digest is verified.
- **Acquisition policy lives in the app, never the library.** `deskrag` is published to npm and must not fetch anything at install or runtime. No file under `src/` is touched by this plan.
- **`app/` is not an npm workspace member.** App tests run via `npm --prefix app run test`, app typecheck via `npm --prefix app run typecheck`. Library gates are `npm run typecheck` and `npm test`.
- **Typecheck must pass at every commit.** Task order below is chosen so the `"local"` union member is removed only after its last user is gone. Do not reorder Tasks 2 and 3.
- Commit style: `feat(scope): …`, `fix(scope): …`, `refactor(scope): …`, `docs(scope): …`, `test(scope): …`.

## Measured values (do not recompute — these are from the validated artifact)

| file | sha256 | bytes |
|---|---|---|
| `model.onnx` | `cf13ca0c6951a4607c303dbe15fd9c8161289ff624f8582ce539cca2ccd99084` | 953919521 |
| `tokenizer.json` | `77eaa5071d562289dbd9c18f8a998124d899a4a0a4311b1a4b6964a873d306b8` | 3548416 |
| `tokenizer_config.json` | `e5bc53ee738178fca59eac1df6dc821576d1082ffedb7b8f8dfe97ceab43eb92` | 28274 |
| `preprocessor_config.json` | `6b8e11369a62e97e3b2f37a0dd1440b9018d177f7ecd2cfc2492e316b930a78a` | 489 |
| `config.json` | `e68e589bbc081d258f585d32ff90d41f0eededdddd5d5d38f006d80ff7de0c0d` | 7268 |

## File Structure

**Modify:**

| File | Responsibility after this plan |
|---|---|
| `app/src/main/model-store.ts` | Streams downloads to disk with incremental hashing and byte-level progress; presence-checks `overrideDir`. No longer knows about locally-built models. |
| `app/src/main/models.ts` | Pinned manifest of three downloadable models. No `"local"` source, no `setupHint`. |
| `app/src/main/deskrag-service.ts` | Indexing failure path no longer special-cases a missing local build. |
| `app/test/model-store.test.ts` | Covers streaming, mid-stream failure, checksum discipline, and incomplete `overrideDir`. |
| `scripts/export-colsmol.py` | Maintainer-only regeneration tool; declares its own environment via PEP 723. |
| `.gitignore` | Ignores Python bytecode. |

**No files are created.** No file under `src/` is modified.

---

## Task 0: Publish the artifact (PREREQUISITE — human action)

**This is not a code task.** Task 2 cannot start until it produces a commit SHA.

The five validated files plus a model card are staged at:
`~/Library/Application Support/deskrag-app/DeskRAG/models/colSmol-256M-dynamic/`

- [ ] **Step 1: Upload (requires a write token — run these yourself)**

```bash
uv tool install "huggingface_hub[cli]"
hf auth login                                    # write token: huggingface.co/settings/tokens
hf repos create guyettinger/colSmol-256M-dynamic-onnx --type model
hf upload guyettinger/colSmol-256M-dynamic-onnx \
  "$HOME/Library/Application Support/deskrag-app/DeskRAG/models/colSmol-256M-dynamic" . \
  --type model
```

- [ ] **Step 2: Capture the commit SHA**

```bash
curl -s https://huggingface.co/api/models/guyettinger/colSmol-256M-dynamic-onnx \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['sha'])"
```

Record the 40-character hex string. Everywhere below writes `PASTE_UPLOAD_SHA_HERE`; substitute this value. **Do not proceed to Task 2 with the placeholder in place** — typecheck will pass but the download will 404 at runtime.

- [ ] **Step 3: Verify the upload serves the exact bytes**

```bash
curl -sL "https://huggingface.co/guyettinger/colSmol-256M-dynamic-onnx/resolve/PASTE_UPLOAD_SHA_HERE/config.json" \
  | shasum -a 256
```

Expected: `e68e589bbc081d258f585d32ff90d41f0eededdddd5d5d38f006d80ff7de0c0d`. If this does not match, the manifest checksums are wrong and Task 2 must not proceed.

---

## Task 1: Stream downloads to disk

Independent of Task 0 — start here.

**Files:**
- Modify: `app/src/main/model-store.ts:22-35` (options), `:113-169` (download loop)
- Test: `app/test/model-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ModelStoreOptions.progressIntervalBytes?: number` (default `4 * 1024 * 1024`) — a test seam letting tests force per-chunk progress emission. `ModelDownloadProgress` keeps its existing shape `{ modelId: string; receivedBytes: number; totalBytes: number; done: boolean }`.

**Why:** `ensureOnce` currently does `Buffer.from(await res.arrayBuffer())`, holding each file whole in memory. At 954 MB that is a ~1 GB allocation in the process that must not fall over. Streaming also makes `receivedBytes` genuinely incremental instead of jumping 0 → total.

- [x] **Step 1: Add the big-body route to the fixture server**

In `app/test/model-store.test.ts`, add after the `BODY`/`SHA` constants (line 18):

```ts
// 512KB served in 64KB chunks — enough to observe streaming progress.
const BIG = Buffer.alloc(512 * 1024, 7);
const BIG_SHA = createHash("sha256").update(BIG).digest("hex");
```

Then inside the `createServer` callback in `beforeEach`, immediately after the `missing` branch:

```ts
    if (req.url?.includes("big")) {
      res.writeHead(200, { "content-length": String(BIG.length) });
      for (let i = 0; i < BIG.length; i += 64 * 1024) {
        res.write(BIG.subarray(i, i + 64 * 1024));
      }
      res.end();
      return;
    }
```

And add a spec helper next to the existing `spec` helper (line 44):

```ts
const bigSpec = (): ModelSpec => ({
  id: "test-model",
  source: "download",
  repo: "org/repo",
  revision: "abc123",
  files: [{ path: "big.onnx", sha256: BIG_SHA, bytes: BIG.length }],
});
```

- [x] **Step 2: Write the failing tests**

Add these two tests inside `describe("ModelStore — download source", …)`:

```ts
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
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `npm --prefix app run test -- model-store`

Expected: "streams to disk with incremental progress" FAILS (`mid.length` is 0 — the current per-file emission produces only the final reading). The mid-stream test may already pass by accident via the existing `catch`; that is fine, it guards the new code path.

- [x] **Step 4: Add the new imports and the option**

In `app/src/main/model-store.ts`, change the import block at lines 17-20 to:

```ts
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ModelSpec } from "./models.js";
```

Note `writeFileSync` is dropped — nothing buffers a whole file any more.

Add to `ModelStoreOptions` (after `onProgress`, line 34):

```ts
  /**
   * Emit a progress event at most this often, in bytes downloaded. A 954MB
   * model at chunk granularity would be ~15k IPC messages; tests set 1.
   */
  progressIntervalBytes?: number;
```

Add the private field beside the others (after line 56) and initialise it in the constructor (after line 67):

```ts
  private readonly progressIntervalBytes: number;
```

```ts
    this.progressIntervalBytes = opts.progressIntervalBytes ?? 4 * 1024 * 1024;
```

- [x] **Step 5: Replace the download body with a streaming read**

> Line numbers cited in this plan are **pre-edit** references to the file as it
> stands at the start of the task. Step 4 already shifted them. Anchor on the
> quoted code, not the numbers.

Inside the `for (const file of spec.files)` loop, replace the entire block that
begins `try {` / `const res = await this.fetchImpl(url);` and ends with the
`} catch (err) { rmSync(partial, { force: true }); throw err; }` closing it —
i.e. everything after the `const url = …` line and before the loop's closing
brace — with:

```ts
      try {
        const res = await this.fetchImpl(url);
        if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
        if (!res.body) throw new Error(`download failed: empty body ${url}`);

        // Stream rather than buffer: model.onnx is ~950MB and arrayBuffer()
        // would hold all of it in the main process at once. The hash is
        // updated as bytes pass, so verification costs no second read.
        const hash = createHash("sha256");
        const out = createWriteStream(partial);
        let fileBytes = 0;
        let emitted = 0;
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            hash.update(buf);
            fileBytes += buf.length;
            if (!out.write(buf)) await once(out, "drain"); // backpressure
            if (fileBytes - emitted >= this.progressIntervalBytes) {
              emitted = fileBytes;
              this.onProgress?.({
                modelId: spec.id,
                receivedBytes: received + fileBytes,
                totalBytes: total,
                done: false,
              });
            }
          }
          await new Promise<void>((resolve, reject) => {
            out.once("error", reject);
            out.end(resolve);
          });
        } catch (err) {
          out.destroy();
          throw err;
        }

        if (file.sha256) {
          const actual = hash.digest("hex");
          if (actual !== file.sha256) {
            rmSync(partial, { force: true });
            throw new Error(
              `checksum mismatch for ${spec.id}/${file.path}: expected ${file.sha256}, got ${actual}`,
            );
          }
        }
        renameSync(partial, dest); // atomic: only now does it look complete
        received += fileBytes;
        this.onProgress?.({
          modelId: spec.id,
          receivedBytes: received,
          totalBytes: total,
          done: false,
        });
      } catch (err) {
        rmSync(partial, { force: true });
        throw err;
      }
```

Also update the file header comment (line 5) — "Streams to `<file>.partial`" is now true rather than aspirational; change it to read:

```
 * Streams to <file>.partial while hashing incrementally, verifies SHA-256, then
 * renames atomically — a partial file never looks complete, so an interrupted
 * download cannot poison a namespace. Nothing is buffered whole: the largest
 * model is ~950MB and this runs in the Electron main process.
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix app run test -- model-store`
Expected: PASS, all cases including the pre-existing checksum, no-redownload, shared-promise, and pinned-revision tests.

- [x] **Step 7: Typecheck**

Run: `npm --prefix app run typecheck`
Expected: clean.

- [x] **Step 8: Commit**

```bash
git add app/src/main/model-store.ts app/test/model-store.test.ts
git commit -m "perf(app): stream model downloads instead of buffering whole files

arrayBuffer() held each file entirely in memory, which is fine at 137MB but
means a ~1GB allocation in the Electron main process for the 954MB ColSmol
export. Stream to .partial with incremental hashing, so verification costs no
second read and progress becomes genuinely incremental."
```

---

## Task 2: Repoint the manifest at the published repo

**BLOCKED ON TASK 0.** Do not start without the upload SHA.

**Files:**
- Modify: `app/src/main/models.ts:93-111`

**Interfaces:**
- Consumes: the commit SHA from Task 0 Step 2.
- Produces: `MODELS.colsmol` with `source: "download"`. After this task no `ModelSpec` in the codebase uses `source: "local"`, which is what unblocks Task 3.

- [ ] **Step 1: Replace the colsmol entry**

Replace lines 93-111 of `app/src/main/models.ts` entirely with:

```ts
  colsmol: {
    id: "colSmol-256M-dynamic",
    source: "download",
    repo: "guyettinger/colSmol-256M-dynamic-onnx",
    revision: "PASTE_UPLOAD_SHA_HERE",
    files: [
      {
        path: "model.onnx",
        sha256: "cf13ca0c6951a4607c303dbe15fd9c8161289ff624f8582ce539cca2ccd99084",
        bytes: 953919521,
      },
      {
        path: "tokenizer.json",
        sha256: "77eaa5071d562289dbd9c18f8a998124d899a4a0a4311b1a4b6964a873d306b8",
        bytes: 3548416,
      },
      {
        path: "tokenizer_config.json",
        sha256: "e5bc53ee738178fca59eac1df6dc821576d1082ffedb7b8f8dfe97ceab43eb92",
        bytes: 28274,
      },
      {
        path: "preprocessor_config.json",
        sha256: "6b8e11369a62e97e3b2f37a0dd1440b9018d177f7ecd2cfc2492e316b930a78a",
        bytes: 489,
      },
      {
        path: "config.json",
        sha256: "e68e589bbc081d258f585d32ff90d41f0eededdddd5d5d38f006d80ff7de0c0d",
        bytes: 7268,
      },
    ],
  },
```

`id` is unchanged and must stay unchanged — see Global Constraints.

- [ ] **Step 2: Rewrite the file header**

Replace the "TWO KINDS OF ENTRY" block (lines 11-22) with:

```
 * Every entry is fetched from HuggingFace and verified against sha256.
 *
 * ColSmol is a re-export, not the upstream weights: the published export
 * (onnx-community/colSmol-256M-ONNX) is traced at exactly 13 tiles and rejects
 * any other count, while DeskRAG's 16:10 frames tile to 7 and a 5:4 display
 * needs 17. scripts/export-colsmol.py re-exports with a dynamic tile count;
 * the result is published to guyettinger/colSmol-256M-dynamic-onnx so users
 * download it like any other model rather than building it locally.
```

- [ ] **Step 3: Verify the SHA placeholder is gone**

Run: `grep -rn "PASTE_UPLOAD_SHA_HERE" app/src/`
Expected: no output. If it prints a line, go back to Task 0.

- [ ] **Step 4: Typecheck**

Run: `npm --prefix app run typecheck`
Expected: clean. `setupHint` and `source: "local"` still exist in the interface — they are simply unused now, which Task 3 cleans up.

- [ ] **Step 5: Verify the pinned URL actually resolves**

```bash
curl -sI "https://huggingface.co/guyettinger/colSmol-256M-dynamic-onnx/resolve/$(grep -A1 'colSmol-256M-dynamic-onnx' app/src/main/models.ts | grep revision | cut -d'"' -f2)/config.json" | head -1
```

Expected: `HTTP/2 200` or a 302 to a CDN URL. A 404 means the SHA or repo name is wrong.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/models.ts
git commit -m "feat(models): fetch the dynamic ColSmol export instead of building it

The export is deterministic and MIT/Apache-2.0 permits redistribution, so it is
a build artifact rather than per-user setup. Published to
guyettinger/colSmol-256M-dynamic-onnx and pinned by commit SHA with per-file
sha256, exactly like nomic and jina."
```

---

## Task 3: Delete the local-build mechanism

**Files:**
- Modify: `app/src/main/model-store.ts:12-14` (header), `:37-50` (error class), `:93-111` (branches)
- Modify: `app/src/main/models.ts:32-42` (ModelSpec)
- Modify: `app/src/main/deskrag-service.ts:56` (import), `:401-416` (catch)
- Test: `app/test/model-store.test.ts:123-157` (delete), plus one new case

**Interfaces:**
- Consumes: Task 2's manifest (no spec uses `source: "local"` any more).
- Produces: `ModelFilesMissingError extends Error` with `readonly modelId: string` and `readonly missing: string[]`, exported from `app/src/main/model-store.ts`. Replaces `ModelNotBuiltError`, which is deleted. `ModelSpec.source` narrows to the literal type `"download"`.

**Why:** ColSmol was the only `source: "local"` entry. Publishing it strands the branch, the error class, `setupHint`, and the service-layer special case. One diagnostic is worth keeping in changed form: under `overrideDir`, `ensureOnce` returns the directory unchecked, so a mis-pointed `localModels.dir` surfaces as a raw ENOENT from inside onnxruntime.

- [ ] **Step 1: Write the failing test**

In `app/test/model-store.test.ts`, **delete the entire `describe("ModelStore — local source", …)` block (lines 123-157)**. Then add this test inside `describe("ModelStore — download source", …)`:

```ts
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
```

Change the import on line 14 to:

```ts
import { ModelFilesMissingError, ModelStore } from "../src/main/model-store.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix app run test -- model-store`
Expected: FAIL — `ModelFilesMissingError` is not exported.

- [ ] **Step 3: Replace the error class**

In `app/src/main/model-store.ts`, replace `ModelNotBuiltError` (lines 37-50) with:

```ts
/**
 * Thrown when `overrideDir` points at a directory missing files. That path
 * skips downloading and verification by design, so this is the only chance to
 * report the gap before onnxruntime fails on a nonexistent path.
 */
export class ModelFilesMissingError extends Error {
  constructor(
    readonly modelId: string,
    readonly missing: string[],
    dir: string,
  ) {
    super(
      `Model "${modelId}" is incomplete in ${dir} — missing: ${missing.join(", ")}. ` +
        `This directory comes from the "Model directory" setting, which disables ` +
        `managed downloads. Add the missing files or clear that setting.`,
    );
    this.name = "ModelFilesMissingError";
  }
}
```

- [ ] **Step 4: Replace the two branches at the top of `ensureOnce`**

Replace lines 93-111 (from `private async ensureOnce` through `if (this.overrideDir) return target;`) with:

```ts
  private async ensureOnce(spec: ModelSpec): Promise<string> {
    const target = this.dirFor(spec);

    if (this.overrideDir) {
      // Hand-curated: trusted, so no download and no checksum. But an
      // incomplete directory must fail here, with names.
      const missing = spec.files
        .map((f) => basename(f.path))
        .filter((name) => !existsSync(join(target, name)));
      if (missing.length > 0) throw new ModelFilesMissingError(spec.id, missing, target);
      return target;
    }
```

Then update the header comment at lines 12-14, replacing the "Locally-produced models (ColSmol) are not downloaded at all" sentence with:

```
 * Every model is downloaded. The `overrideDir` escape hatch reads from a
 * hand-curated directory instead, verifying only that the files are present.
```

- [ ] **Step 5: Narrow `ModelSpec` in `app/src/main/models.ts`**

In the `ModelSpec` interface (lines 32-42), change:

```ts
  source: "download" | "local";
```

to:

```ts
  source: "download";
```

and delete these two lines entirely:

```ts
  /** Shown when a local-source model is absent. */
  setupHint?: string;
```

- [ ] **Step 6: Simplify the indexing failure path**

In `app/src/main/deskrag-service.ts`, remove `ModelNotBuiltError,` from the import block at line 56. Then replace lines 403-416 with:

```ts
    } catch (err) {
      console.error("[deskrag] indexing failed:", err);
      this.emitIndexing({ stage: "Indexing failed — see logs", done: 0, total: 0 });
    }
```

A failed download is an ordinary transient error, not the actionable setup state the special case existed to report.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm --prefix app run test -- model-store`
Expected: PASS. The pre-existing "uses overrideDir and skips download and verification entirely" test still passes — it writes `model.onnx` before calling, so the new presence check is satisfied.

- [ ] **Step 8: Verify nothing references the deleted names**

Run: `grep -rn "ModelNotBuiltError\|setupHint" app/src app/test`
Expected: no output.

- [ ] **Step 9: Full app gate**

Run: `npm --prefix app run typecheck && npm --prefix app run test`
Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add app/src/main/model-store.ts app/src/main/models.ts \
        app/src/main/deskrag-service.ts app/test/model-store.test.ts
git commit -m "refactor(app): drop the local-build model mechanism

ColSmol was the only source:\"local\" entry; publishing it strands the branch,
ModelNotBuiltError, setupHint, and the service-layer special case. The one
diagnostic worth keeping is retargeted: an incomplete overrideDir now throws
ModelFilesMissingError instead of failing later as a raw ENOENT."
```

---

## Task 4: Keep the export reproducible

**Files:**
- Modify: `scripts/export-colsmol.py:1-25` (docstring), plus a new PEP 723 block
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing. Independent of Tasks 1-3; may be done at any point.
- Produces: nothing consumed by other tasks.

**Why:** the pip/python instructions previously lived in the deleted `setupHint`. The script stays a maintainer tool — nothing in the app invokes it — but regenerating must stay a single reproducible command. The monkeypatches target version-sensitive `transformers` internals, so the pins matter. These four versions are the ones the shipped artifact was built and validated with.

- [x] **Step 1: Add the PEP 723 block**

Insert at the very top of `scripts/export-colsmol.py`, **above** the module docstring (PEP 723 blocks must precede code but the docstring must remain the module docstring — placing it first as a comment is correct and keeps the docstring in position 1 for `__doc__`):

```python
# /// script
# requires-python = "==3.12.*"
# dependencies = [
#   "torch==2.11.0",
#   "transformers==5.14.1",
#   "colpali-engine==0.3.17",
#   "onnx==1.22.0",
# ]
# ///
```

- [x] **Step 2: Update the usage lines in the docstring**

Replace lines 20-24 of the docstring:

```
Usage:
    python scripts/export-colsmol.py --out /path/to/model.onnx [--tiles 7]

Requires torch, transformers, colpali-engine, onnx in the active environment.
The export is CPU/fp32 and takes several minutes.
```

with:

```
Usage:
    uv run scripts/export-colsmol.py --out /path/to/model.onnx [--tiles 7]

uv reads the PEP 723 block above and provisions its own CPython 3.12 plus the
pinned dependencies — no venv to manage. The pins matter: the monkeypatches
below target version-sensitive transformers internals.

MAINTAINER TOOL. The app does not run this; it downloads the published export
(guyettinger/colSmol-256M-dynamic-onnx). Regenerate only to change the export
itself, then re-upload and update MODELS.colsmol in app/src/main/models.ts.

The export is CPU/fp32. Validate the result before publishing:
    uv run --with onnxruntime --with numpy scripts/validate-colsmol-onnx.py \
      --onnx /path/to/model.onnx
```

- [x] **Step 3: Ignore Python bytecode**

Append to `.gitignore`, after the `native/ax-dump` block:

```
# python bytecode from scripts/*.py (maintainer export tooling)
__pycache__/
*.pyc
```

- [x] **Step 4: Verify the script still runs under uv with only the inline metadata**

Run:

```bash
uv run scripts/export-colsmol.py --help
```

Expected: argparse usage text listing `--out`, `--model`, `--tiles`, `--opset`. This proves uv resolved the PEP 723 block without any `--with` flags. It does not re-export the model.

- [x] **Step 5: Verify the pycache is no longer reported**

Run: `git status --short scripts/`
Expected: no `?? scripts/__pycache__/` line.

- [x] **Step 6: Commit**

```bash
git add scripts/export-colsmol.py .gitignore
git commit -m "docs(scripts): declare the ColSmol export environment inline

The pip/python instructions lived in ModelSpec.setupHint, which is gone. PEP 723
inline metadata puts the pinned deps in the script itself, so regenerating is
one uv run with no venv management. Pins are the versions the published artifact
was built and validated against."
```

---

## Task 5: End-to-end verification

**Files:** none modified. This task only runs things.

**Interfaces:**
- Consumes: Tasks 1-4 complete, Task 0 uploaded.

- [ ] **Step 1: Full gates**

```bash
npm run typecheck && npm test
npm --prefix app run typecheck && npm --prefix app run test
```

Expected: all clean. The library suite should be entirely unaffected — a failure there means the `src/` seam was crossed by mistake.

- [ ] **Step 2: Force a real download**

```bash
mv "$HOME/Library/Application Support/deskrag-app/DeskRAG/models/colSmol-256M-dynamic" \
   "$HOME/Library/Application Support/deskrag-app/DeskRAG/models/colSmol-256M-dynamic.bak"
```

Keeping a backup means a failed download does not cost another 954 MB fetch.

- [ ] **Step 3: Build and launch**

```bash
npm run build && npm run app:dev
```

In Settings → Local models, set the image provider to ColSmol. Expected: the "Downloading colSmol-256M-dynamic" row appears and the percentage **climbs smoothly** rather than jumping 0 → 100. That climbing number is the observable proof Task 1 worked.

- [ ] **Step 4: Verify what landed on disk**

```bash
ls -la "$HOME/Library/Application Support/deskrag-app/DeskRAG/models/colSmol-256M-dynamic"
shasum -a 256 "$HOME/Library/Application Support/deskrag-app/DeskRAG/models/colSmol-256M-dynamic/model.onnx"
```

Expected: five files, no `.partial` remaining, and the hash equals
`cf13ca0c6951a4607c303dbe15fd9c8161289ff624f8582ce539cca2ccd99084`.

- [ ] **Step 5: Index a real session**

Record a short session with ColSmol as the image provider, then Stop. Expected: indexing completes through the frame/region stages with no `ModelNotBuiltError` and no "Indexing failed" stage. This is the original bug, fixed.

- [ ] **Step 6: Full pipeline against real weights**

```bash
node scripts/e2e-local.mjs "$HOME/Library/Application Support/deskrag-app/DeskRAG/models"
```

Expected: completes without error.

- [ ] **Step 7: Clean up the backup**

```bash
rm -rf "$HOME/Library/Application Support/deskrag-app/DeskRAG/models/colSmol-256M-dynamic.bak"
```

Only after Steps 4-6 pass.

---

## Notes for the implementer

- **`app/` has its own `node_modules` and its own vitest.** Always use `npm --prefix app run …` for app work. Running `npm test` from the root will not exercise any file in this plan except by accident.
- **The four small JSON files are already correct on disk** at the models dir from the design session. Only `model.onnx` is large enough for the streaming change to matter, which is why Task 1's tests synthesize a 512 KB body rather than using a real model.
- **If the checksum test fails after Task 1**, the likely cause is hashing the wrong view of the chunk. `Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)` is deliberate — `Buffer.from(chunk)` on a `Uint8Array` view over a larger `ArrayBuffer` copies the wrong bytes.
- **Do not add a `ModelBuilder`, a Settings "Build" button, or `extraResources` packaging.** Those were explicitly ruled out; publishing removes the need.
