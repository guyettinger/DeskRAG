import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { libDistDir, libDistExists, libUrl } from "../src/main/lib-resolve.js";

/**
 * Regression test for ERR_MODULE_NOT_FOUND on every lazy `deskrag/...` import.
 *
 * The bug: Vite aliases only LITERAL specifiers, and the loaders pass the path
 * as a variable, so a bare `deskrag/...` reached Node's resolver and failed —
 * silently disabling input capture, window tracking and region cropping, and
 * (once local providers existed) killing indexing outright.
 */
describe("libUrl", () => {
  it("maps a library subpath to an absolute file URL", () => {
    const url = libUrl("deskrag/embed/onnx/text");
    expect(url.startsWith("file://")).toBe(true);
    expect(url.endsWith("/dist/embed/onnx/text.js")).toBe(true);
  });

  it("leaves a non-deskrag specifier alone", () => {
    // Real packages must still resolve through node_modules.
    expect(libUrl("onnxruntime-node")).toBe("onnxruntime-node");
    expect(libUrl("node:fs")).toBe("node:fs");
  });

  it("points at a dist directory three levels up", () => {
    expect(libDistDir().endsWith("/dist")).toBe(true);
  });

  it("honours the DESKRAG_LIB_DIST override for packaging", () => {
    const prev = process.env.DESKRAG_LIB_DIST;
    process.env.DESKRAG_LIB_DIST = "/tmp/some/lib";
    try {
      expect(libUrl("deskrag/embed/onnx/text")).toBe("file:///tmp/some/lib/embed/onnx/text.js");
    } finally {
      if (prev === undefined) delete process.env.DESKRAG_LIB_DIST;
      else process.env.DESKRAG_LIB_DIST = prev;
    }
  });

  it("resolves every subpath the service lazily imports to a real file", () => {
    // Requires `npm run build` at the repo root, which the app needs anyway.
    expect(libDistExists()).toBe(true);
    for (const spec of [
      "deskrag/capture/producers/uiohook-input",
      "deskrag/capture/producers/active-window",
      "deskrag/represent/regions/sharp-cropper",
      "deskrag/embed/onnx/text",
      "deskrag/embed/onnx/colsmol",
      "deskrag/retrieve/rerank/onnx",
    ]) {
      const file = fileURLToPath(libUrl(spec));
      expect(`${spec} -> ${existsSync(file)}`).toBe(`${spec} -> true`);
    }
  });

  it("actually imports in NODE's resolver, which is the one that broke", async () => {
    // Deliberately a child process, not a vitest `import()`. Vite has its own
    // resolver and refuses absolute paths outside its root, so importing here
    // would test the wrong runtime — the bug was in Node's ESM resolution from
    // the built bundle. sharp-cropper is included because it pulls a native
    // module, proving transitive resolution from dist/ works too.
    const { execFileSync } = await import("node:child_process");
    const script = [
      `const t = await import(${JSON.stringify(libUrl("deskrag/embed/onnx/text"))});`,
      `const c = await import(${JSON.stringify(libUrl("deskrag/represent/regions/sharp-cropper"))});`,
      `if (typeof t.OnnxTextEmbedding !== "function") throw new Error("no OnnxTextEmbedding");`,
      `new c.SharpRegionCropper();`,
      `console.log("OK");`,
    ].join("");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(out.trim()).toBe("OK");
  });

  it("a BARE deskrag specifier still fails in Node — the bug being guarded", async () => {
    // If this ever starts passing, someone added a node_modules/deskrag entry,
    // which would resolve the library's better-sqlite3 from the repo root
    // (Node ABI) instead of app/node_modules (Electron ABI).
    const { execFileSync } = await import("node:child_process");
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", 'await import("deskrag/embed/onnx/text");'],
        { encoding: "utf8", stdio: "pipe", cwd: fileURLToPath(new URL("../out/main/", import.meta.url)) },
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
