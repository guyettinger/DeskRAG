import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAudioTapAnchor } from "../src/capture/audio-tap-anchor.js";

const here = dirname(fileURLToPath(import.meta.url));
const swiftSrc = join(here, "..", "native", "audio-tap.swift");
const hasSwiftc = (() => {
  try {
    return spawnSync("swiftc", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

/**
 * Compiled from the real .swift, because `parseAudioTapAnchor` and the Swift
 * emitter are two readers of ONE contract — the drift hazard that already bit
 * ax-dump/ax-exec over a single empty string, and which no hand-written fixture
 * can catch.
 *
 * Everything here goes through `--self-test`, which sits ABOVE the macOS 14.2
 * gate and above every CoreAudio call. That is deliberate: a tap needs a
 * permission, a running audio device and something actually playing, none of
 * which exist in CI — but the protocol can still be checked on any Mac with a
 * compiler. `ax-dump --clock` is exempted from its Accessibility gate for the
 * same reason.
 */
describe.skipIf(!hasSwiftc)("audio-tap contract", () => {
  let dir: string;
  let bin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "erag-tapbin-"));
    bin = join(dir, "audio-tap");
    execFileSync("swiftc", ["-O", swiftSrc, "-o", bin], {
      stdio: "pipe",
      env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0" },
    });
  }, 240_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs the binary with fd 3 redirected to a file, the way the producer wires it. */
  const run = (args: string[]): { anchors: string; stdout: Buffer; status: number | null } => {
    const anchorPath = join(dir, `anchor-${Math.random().toString(36).slice(2)}`);
    const fd = openSync(anchorPath, "w+");
    try {
      const r = spawnSync(bin, args, { stdio: ["ignore", "pipe", "pipe", fd] });
      return { anchors: readFileSync(anchorPath, "utf8"), stdout: r.stdout, status: r.status };
    } finally {
      closeSync(fd);
    }
  };

  it("reports the contract version the producer pins", () => {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8" });
    // The producer refuses to record against any other number. ax-dump has no
    // such handshake, and a stale copy silently ignoring its flags cost two days
    // and every recording's typed text.
    expect(out.trim()).toBe("audio-tap 1");
  });

  it("emits an anchor this repo's parser accepts", () => {
    const { anchors } = run(["--self-test"]);
    const anchor = parseAudioTapAnchor(anchors.trim());
    expect(anchor.version).toBe(1);
    expect(anchor.byteOffset).toBe(0);
    expect(anchor.sampleRate).toBe(16000);
    expect(anchor.channels).toBe(1);
    expect(anchor.format).toBe("s16le");
  });

  it("puts PCM on stdout and NOTHING else", () => {
    const { stdout } = run(["--self-test"]);
    // 0.1s of 16 kHz mono s16le. Exact, because one stray log byte on this fd
    // does not produce a parse error — it produces a WAV with the right byte
    // count and garbage inside it, which no assertion over the schema can see.
    expect(stdout.length).toBe(3200);
  });

  it("refuses to start without the anchor channel", () => {
    // Running with no fd 3 is the one state the design forbids outright: there
    // would be no device time, and the only remaining option is arrival time.
    const r = spawnSync(bin, [], { stdio: ["ignore", "pipe", "pipe", "ignore"] });
    expect(r.status).toBe(3);
    expect(r.stderr.toString()).toMatch(/fd 3 is not open/);
  });

  it("self-tests above the availability gate, so it runs anywhere", () => {
    // Exit 2 is "this Mac is too old". --self-test must never reach it.
    expect(run(["--self-test"]).status).toBe(0);
  });
});
