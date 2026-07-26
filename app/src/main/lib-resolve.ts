/**
 * Resolves `deskrag/<subpath>` to an absolute file URL under the built library.
 *
 * WHY THIS EXISTS
 *
 * electron.vite.config.ts aliases `deskrag` -> ../dist, but Vite rewrites only
 * LITERAL import specifiers. The lazy loaders in deskrag-service.ts receive the
 * module path as a VARIABLE:
 *
 *     await import(&#47;* @vite-ignore *&#47; path)
 *
 * so nothing rewrites it, the bare specifier survives into the bundle, and Node
 * tries to resolve `node_modules/deskrag` at runtime — which never exists,
 * because the library IS the repo root package and is never installed as a
 * dependency. Every lazy native import therefore failed with
 * ERR_MODULE_NOT_FOUND: input capture, window tracking, region cropping, and
 * (once it existed) the whole local ONNX path.
 *
 * WHY NOT A node_modules ENTRY
 *
 * Adding `"deskrag": "file:.."` to app/package.json would create a symlink and
 * fix resolution — but Node resolves a symlinked package's own imports from its
 * REALPATH, so the library's `better-sqlite3` would come from the repo root
 * (Node ABI) instead of app/node_modules (Electron ABI). That is exactly the
 * dual-install invariant in CLAUDE.md, and breaking it swaps a clear error for
 * a native crash.
 *
 * WHY RESOLVING INTO dist/ IS SAFE
 *
 * None of the lazily-loaded modules imports better-sqlite3 — they pull
 * uiohook-napi, active-win, sharp and onnxruntime-node, all N-API or prebuilt
 * and ABI-agnostic. So loading them from the repo's dist/ never crosses the
 * boundary better-sqlite3 cares about.
 *
 * PACKAGING CAVEAT: this points at the repo's dist/, so it works for `app:dev`
 * and `app:build` but NOT a packaged .app, which has no repo alongside it.
 * Packaging needs the library bundled into resources and this base pointed at
 * it; DESKRAG_LIB_DIST exists for that.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Base directory of the built library.
 *
 * Both `app/src/main/*.ts` (tests, typecheck) and `app/out/main/index.js` (the
 * bundle this file is inlined into) sit three levels below the repo root, so one
 * relative path is correct in both.
 */
export function libDistDir(): string {
  const override = process.env.DESKRAG_LIB_DIST;
  if (override && override.length > 0) return resolve(override);
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist");
}

/** True when the built library is actually present. */
export function libDistExists(): boolean {
  return existsSync(resolve(libDistDir(), "index.js"));
}

/**
 * `deskrag/embed/onnx/text` -> `file:///…/dist/embed/onnx/text.js`
 *
 * A specifier without the `deskrag/` prefix is returned unchanged, so callers
 * can pass through anything that is genuinely a package.
 */
export function libUrl(specifier: string): string {
  if (!specifier.startsWith("deskrag/")) return specifier;
  const rel = specifier.slice("deskrag/".length);
  const file = resolve(libDistDir(), `${rel}.js`);
  return pathToFileURL(file).href;
}
