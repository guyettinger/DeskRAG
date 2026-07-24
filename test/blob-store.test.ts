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
