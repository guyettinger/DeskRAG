/**
 * Compiles the Swift sidecars in `native/`.
 *
 * This was three `swiftc` invocations chained with `&&` inside package.json,
 * with `MACOSX_DEPLOYMENT_TARGET=13.0` written out three times and a fourth,
 * DIVERGENT copy in a `build:ax-exec` entry that nothing referenced and that
 * omitted the deployment target entirely. A binary built through that entry
 * would refuse to launch on a Mac the others still run on. One list, one
 * constant, and the ordering rationale beside the thing it orders.
 *
 * Run:  npm run build:ax                    (all three, in this order)
 *       npm run build:ax -- audio-tap       (just one)
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NATIVE = join(ROOT, "native");

/**
 * 13.0 so `audio-tap` LAUNCHES on an older Mac and prints an honest reason
 * (exit 2) instead of failing to exec. It applies to all three: a sidecar that
 * cannot start is indistinguishable from one that found nothing.
 */
const DEPLOYMENT_TARGET = "13.0";

/**
 * THE ORDER IS LOAD-BEARING, and `audio-tap` is last on purpose.
 *
 * It needs Xcode 15.1+ for `CATapDescription`, so it is the one that can fail
 * to compile on an otherwise fine machine. Building it last leaves the two
 * CLOCK-CRITICAL binaries on disk when it does — a session refuses to start
 * without `ax-dump --clock`, so losing those two costs every recording, while
 * losing the tap costs computer audio.
 */
const TARGETS = ["ax-dump", "ax-exec", "audio-tap"] as const;

const asked = process.argv.slice(2);
const unknown = asked.filter((a) => !(TARGETS as readonly string[]).includes(a));
if (unknown.length > 0) {
  console.error(
    `unknown target(s): ${unknown.join(", ")}\n` +
      `known: ${TARGETS.join(", ")} (no argument builds all three, in that order)`,
  );
  process.exit(1);
}
const build = asked.length > 0 ? TARGETS.filter((t) => asked.includes(t)) : [...TARGETS];

for (const target of build) {
  const source = join(NATIVE, `${target}.swift`);
  if (!existsSync(source)) {
    console.error(`no source at ${source}`);
    process.exit(1);
  }
  const out = join(NATIVE, target);
  console.log(`swiftc -O ${target}.swift -> native/${target}`);
  const r = spawnSync("swiftc", ["-O", source, "-o", out], {
    stdio: "inherit",
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET },
  });
  if (r.status !== 0) {
    console.error(
      `\n${target} failed to compile (exit ${r.status}).` +
        (target === "audio-tap"
          ? "\naudio-tap needs Xcode 15.1+ for CATapDescription. The two clock-critical\n" +
            "binaries above are built and on disk; computer audio is what is missing."
          : ""),
    );
    process.exit(r.status ?? 1);
  }
}
