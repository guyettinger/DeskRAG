/**
 * Running a WRITING probe against a copy of the real library.
 *
 * Four probes do this — merge, reflect, stability, tray — and each carried its
 * own `clone()`, its own mkdtemp, its own banner and its own teardown. The
 * banner matters as much as the copy: it is the probe telling the person
 * running it that their own recordings are not at risk, and one of the four
 * inlined the `cp` and never printed it.
 *
 * `cp -Rc` asks APFS for copy-on-write, so cloning a library with gigabytes of
 * `models/` and `lance/` in it costs almost nothing. The `cp -R` fallback is
 * for a volume that cannot: slower, still correct.
 *
 * THE REAL STORE IS OPENED ONCE, BY `cp`, AND NEVER BY THE APP.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./paths.js";

export interface LibraryClone {
  /** Pass this as `--user-data-dir`; the app resolves its data dir beneath it. */
  root: string;
  /** `<root>/DeskRAG` — where app.db, lance/ and settings.json landed. */
  data: string;
  /** Delete the clone. Safe to call twice. */
  dispose(): void;
}

/**
 * Clone `<userData>/DeskRAG` into a temp directory and describe it on stdout.
 *
 * Returns null when there is nothing to clone, having said so — an empty
 * library is a legitimate state for these probes, not a failure.
 */
export function cloneLibrary(prefix: string, source: string = DATA_DIR): LibraryClone | null {
  if (!existsSync(join(source, "app.db"))) {
    console.log(`No library at ${source}. Record and index something first.`);
    return null;
  }

  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const data = join(root, "DeskRAG");
  try {
    execFileSync("cp", ["-Rc", source, data]);
  } catch {
    execFileSync("cp", ["-R", source, data]);
  }

  console.log(`Copied the library to ${data}`);
  console.log("The real store is opened once, by cp, and never by the app.\n");

  let gone = false;
  return {
    root,
    data,
    dispose(): void {
      if (gone) return;
      gone = true;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
