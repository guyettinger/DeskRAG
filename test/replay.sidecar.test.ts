import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
});
