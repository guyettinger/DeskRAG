import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hasSwiftc = (() => {
  try {
    return spawnSync("swiftc", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

/**
 * The real ax-exec binary (skipped without swiftc). Only the protocol and the
 * safety gates are exercised here — no test posts a real event, so no command
 * that moves the mouse is ever sent.
 */
/**
 * Collect complete newline-delimited lines. A real AX tree dump exceeds 64KB, so
 * stdout arrives in several chunks and a chunk boundary lands mid-JSON —
 * splitting each chunk independently yields truncated "lines". This mirrors what
 * `sidecar.ts` does with its own buffer.
 */
function lineCollector(): { lines: string[]; feed: (b: Buffer) => void } {
  const lines: string[] = [];
  let buffer = "";
  return {
    lines,
    feed(b: Buffer) {
      buffer += b.toString();
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) lines.push(line);
      }
    },
  };
}

describe.skipIf(!hasSwiftc)("ax-exec sidecar protocol", () => {
  let dir: string;
  let bin: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "axexec-"));
    bin = join(dir, "ax-exec");
    execFileSync("swiftc", ["-O", join(process.cwd(), "native/ax-exec.swift"), "-o", bin]);
  }, 180_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses to start without a plan id", () => {
    const r = spawnSync(bin, [], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/--plan/);
  });

  it("answers a request with a matching id, and quits cleanly", async () => {
    const proc: ChildProcessWithoutNullStreams = spawn(bin, ["--plan", "p1"]);
    const { lines, feed } = lineCollector();
    proc.stdout.on("data", feed);

    proc.stdin.write(`${JSON.stringify({ id: 7, cmd: "dump" })}\n`);
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (lines.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 25);
      setTimeout(() => {
        clearInterval(t);
        resolve();
      }, 5000);
    });

    expect(lines.length).toBeGreaterThan(0);
    const msg = JSON.parse(lines[0]!) as { id: number; ok: boolean };
    expect(msg.id).toBe(7);
    // Without Accessibility permission `dump` still answers, with an empty tree.
    expect(typeof msg.ok).toBe("boolean");

    proc.stdin.write(`${JSON.stringify({ id: 8, cmd: "quit" })}\n`);
    const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
    expect(code).toBe(0);
  }, 20_000);

  it("reports an unknown command as an error rather than dying", async () => {
    const proc: ChildProcessWithoutNullStreams = spawn(bin, ["--plan", "p1"]);
    const { lines, feed } = lineCollector();
    proc.stdout.on("data", feed);

    proc.stdin.write(`${JSON.stringify({ id: 1, cmd: "explode" })}\n`);
    await new Promise((r) => setTimeout(r, 1500));

    expect(lines.length).toBeGreaterThan(0);
    const msg = JSON.parse(lines[0]!) as { id: number; ok: boolean; error?: string };
    expect(msg).toMatchObject({ id: 1, ok: false });
    expect(msg.error).toMatch(/unknown command/i);

    proc.kill();
  }, 20_000);

  // Exercised against a name that CANNOT match a running application, and with
  // launch disabled, so this test activates and launches nothing.
  it("answers runningApps and refuses to activate an unknown app", async () => {
    const proc: ChildProcessWithoutNullStreams = spawn(bin, ["--plan", "p1"]);
    const { lines, feed } = lineCollector();
    proc.stdout.on("data", feed);

    proc.stdin.write(`${JSON.stringify({ id: 1, cmd: "runningApps" })}\n`);
    proc.stdin.write(
      `${JSON.stringify({ id: 2, cmd: "activate", app: "NoSuchApp_ZZZ", launch: false })}\n`,
    );
    await new Promise((r) => setTimeout(r, 2500));

    const byId = new Map(
      lines.map((l) => JSON.parse(l) as { id: number; result?: Record<string, unknown> }).map((m) => [m.id, m]),
    );
    expect((byId.get(1)?.result?.apps as string[] | undefined)?.length).toBeGreaterThan(0);
    expect(byId.get(2)?.result?.outcome).toBe("not-running");

    proc.kill();
  }, 20_000);
});

/**
 * A source-level guard, because the behaviour cannot be unit-tested: reproducing
 * it requires the frontmost application to CHANGE mid-process, and no test may
 * cause that without posting a real event.
 *
 * `NSWorkspace.shared.frontmostApplication` and `.runningApplications` are backed
 * by workspace notifications delivered to the main run loop. `ax-exec` blocks in
 * `readLine()` and spins no run loop, so without draining it first those values
 * stay PINNED at whatever was true when the process started. Measured against a
 * freshly spawned process: 14 disagreements in 20 one-second samples before the
 * drain, 0 after.
 *
 * It is not only the app name. `rootElement()` takes its pid from the same call,
 * so a pinned value means every `dump` and `locate` after an app change reads the
 * WRONG application's tree — which makes `runRepair`'s confirmation poll and
 * every `wait { until: app(X) }` incapable of ever succeeding.
 */
describe("ax-exec run loop", () => {
  it("drains the run loop once per command, before dispatch", () => {
    const src = readFileSync(join(process.cwd(), "native/ax-exec.swift"), "utf8");

    const loop = src.indexOf("while let line = readLine");
    const drain = src.indexOf("drainRunLoop()", loop);
    const dispatch = src.indexOf("switch req.cmd", loop);

    expect(loop, "the command loop must exist").toBeGreaterThan(-1);
    expect(drain, "drainRunLoop() must be called inside the command loop").toBeGreaterThan(loop);
    expect(
      drain,
      "drainRunLoop() must run BEFORE the command is dispatched, or the first " +
        "command of each kind reads stale workspace state",
    ).toBeLessThan(dispatch);
  });

  it("reads the frontmost application once per dump, for both the pid and the name", () => {
    const src = readFileSync(join(process.cwd(), "native/ax-exec.swift"), "utf8");
    const dump = src.indexOf('case "dump":');
    const locate = src.indexOf('case "locate":', dump);
    const body = src.slice(dump, locate);

    // Two lookups could describe two different applications — the same
    // split-fact hazard that made boundary snapshots report the previous app.
    expect(
      (body.match(/frontmostApp\(\)/g) ?? []).length,
      "dump must resolve the frontmost app exactly once",
    ).toBe(1);
    expect(
      body,
      "dump must not read NSWorkspace directly; it would bypass the single lookup",
    ).not.toMatch(/NSWorkspace\.shared\.frontmostApplication/);
  });
});
