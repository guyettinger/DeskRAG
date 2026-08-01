import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxExecSidecar } from "../src/replay/sidecar.js";

/** A stub binary speaking the protocol, so the client is tested without Swift. */
function stubBinary(body: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "axstub-"));
  const path = join(dir, "stub.mjs");
  writeFileSync(
    path,
    `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  ${body}
});
`,
  );
  chmodSync(path, 0o755);
  return { dir, path };
}

describe("AxExecSidecar", () => {
  it("correlates a response to its request id", async () => {
    const { dir, path } = stubBinary(`
      if (req.cmd === "quit") { console.log(JSON.stringify({ id: req.id, ok: true })); process.exit(0); }
      console.log(JSON.stringify({ id: req.id, ok: true, result: { elements: [{ role: "Button", label: "Go", x: 1, y: 2, w: 3, h: 4 }], app: "TextEdit", windowTitle: "Untitled" } }));
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    const obs = await s.dump();
    expect(obs.elements).toEqual([{ role: "Button", label: "Go", x: 1, y: 2, w: 3, h: 4 }]);
    expect(obs.app).toBe("TextEdit");
    expect(obs.windowTitle).toBe("Untitled");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("resolves concurrent requests to the right callers", async () => {
    const { dir, path } = stubBinary(`
      if (req.cmd === "quit") { process.exit(0); }
      // Answer out of order to prove correlation is by id, not arrival.
      const delay = req.id === 1 ? 60 : 5;
      setTimeout(() => console.log(JSON.stringify({ id: req.id, ok: true, result: { handle: req.id, bounds: { x: req.id, y: 0, w: 1, h: 1 } } })), delay);
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    const [a, b] = await Promise.all([
      s.locate({ role: "Button", identifier: "first" }),
      s.locate({ role: "Button", identifier: "second" }),
    ]);
    expect(a!.bounds.x).not.toBe(b!.bounds.x);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("rejects when the sidecar reports an error", async () => {
    const { dir, path } = stubBinary(`
      console.log(JSON.stringify({ id: req.id, ok: false, error: "boom" }));
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    await expect(s.dump()).rejects.toThrow(/boom/);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("rejects in-flight requests when the process dies", async () => {
    const { dir, path } = stubBinary(`process.exit(1);`);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    await expect(s.dump()).rejects.toThrow(/exited|closed/i);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("times out rather than hanging forever", async () => {
    const { dir, path } = stubBinary(`/* never answers */`);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path], timeoutMs: 200 });
    await expect(s.dump()).rejects.toThrow(/timed out/i);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("maps a null locate result to null rather than throwing", async () => {
    const { dir, path } = stubBinary(`
      console.log(JSON.stringify({ id: req.id, ok: true, result: null }));
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    expect(await s.locate({ role: "Button", identifier: "gone" })).toBeNull();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
  it("parses runningApps", async () => {
    const { dir, path } = stubBinary(`
      console.log(JSON.stringify({ id: req.id, ok: true, result: { apps: ["TextEdit", "Google Chrome"] } }));
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    expect(await s.runningApps()).toEqual(["TextEdit", "Google Chrome"]);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("parses an activate outcome and passes launch through", async () => {
    const { dir, path } = stubBinary(`
      console.log(JSON.stringify({ id: req.id, ok: true, result: { outcome: req.launch ? "launched" : "activated" } }));
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    expect(await s.activate("TextEdit", false)).toBe("activated");
    expect(await s.activate("TextEdit", true)).toBe("launched");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("treats a malformed activate result as not-running rather than throwing", async () => {
    const { dir, path } = stubBinary(`
      console.log(JSON.stringify({ id: req.id, ok: true, result: {} }));
    `);
    const s = AxExecSidecar.spawn({ planId: "p1", binaryPath: "node", args: [path] });
    expect(await s.activate("Nope", false)).toBe("not-running");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});
