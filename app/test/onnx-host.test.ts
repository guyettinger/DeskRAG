import { describe, expect, it, vi } from "vitest";
import { OnnxHost, type OnnxTransport, type SpawnFn } from "../src/main/onnx-host.js";
import type { OnnxTensorDTO } from "../src/shared/onnx-protocol.js";

/**
 * A fake child. Records what was posted and lets the test drive replies and
 * death, so the whole protocol is exercised without Electron.
 */
class FakeChild {
  readonly sent: { kind: string; id: number; modelPath?: string }[] = [];
  killed = 0;
  private onMessage!: (msg: unknown) => void;
  private onExit!: () => void;

  readonly spawn: SpawnFn = (handlers) => {
    this.onMessage = handlers.onMessage;
    this.onExit = handlers.onExit;
    const transport: OnnxTransport = {
      // structuredClone, because that is what postMessage actually does. A
      // pass-by-reference fake silently accepts values the real boundary
      // mangles — exactly how an ORT tensor with a prototype `data` getter got
      // through to production.
      postMessage: (msg) => {
        this.sent.push(structuredClone(msg) as { kind: string; id: number });
      },
      kill: () => {
        this.killed++;
      },
    };
    return transport;
  };

  reply(id: number, outputs: Record<string, OnnxTensorDTO>): void {
    this.onMessage(structuredClone({ kind: "ok", id, outputs }));
  }
  fail(id: number, message: string): void {
    this.onMessage(structuredClone({ kind: "err", id, message }));
  }
  die(detail?: string): void {
    this.onExit(detail);
  }
}

const feeds = (): Record<string, OnnxTensorDTO> => ({
  input_ids: { data: new BigInt64Array([1n, 2n]), dims: [1, 2] },
});
const out = (n: number): Record<string, OnnxTensorDTO> => ({
  embeddings: { data: new Float32Array([n]), dims: [1, 1] },
});

describe("OnnxHost", () => {
  it("does not spawn a child until the first run", () => {
    const child = new FakeChild();
    const spawn = vi.fn(child.spawn);
    const host = new OnnxHost({ spawn });
    host.session("/models/a.onnx"); // building a session must not spawn
    expect(spawn).not.toHaveBeenCalled();
  });

  it("routes a run to the child and resolves with its outputs", async () => {
    const child = new FakeChild();
    const host = new OnnxHost({ spawn: child.spawn });
    const p = host.session("/models/a.onnx").run(feeds());

    expect(child.sent).toHaveLength(1);
    expect(child.sent[0]!.modelPath).toBe("/models/a.onnx");
    child.reply(child.sent[0]!.id, out(7));

    const got = await p;
    expect(Array.from(got.embeddings!.data)).toEqual([7]);
  });

  it("correlates concurrent requests by id, whatever order they return", async () => {
    const child = new FakeChild();
    const host = new OnnxHost({ spawn: child.spawn });
    const a = host.session("/models/a.onnx").run(feeds());
    const b = host.session("/models/b.onnx").run(feeds());

    expect(child.sent).toHaveLength(2);
    // Reply out of order: b first.
    child.reply(child.sent[1]!.id, out(2));
    child.reply(child.sent[0]!.id, out(1));

    expect(Array.from((await a).embeddings!.data)).toEqual([1]);
    expect(Array.from((await b).embeddings!.data)).toEqual([2]);
  });

  it("rejects only the matching request when the child reports an error", async () => {
    const child = new FakeChild();
    const host = new OnnxHost({ spawn: child.spawn });
    const a = host.session("/models/a.onnx").run(feeds());
    const b = host.session("/models/b.onnx").run(feeds());

    child.fail(child.sent[0]!.id, "shape mismatch");
    child.reply(child.sent[1]!.id, out(5));

    await expect(a).rejects.toThrow(/shape mismatch/);
    expect(Array.from((await b).embeddings!.data)).toEqual([5]);
  });

  it("rejects every pending request when the child dies", async () => {
    const child = new FakeChild();
    const host = new OnnxHost({ spawn: child.spawn });
    const a = host.session("/models/a.onnx").run(feeds());
    const b = host.session("/models/b.onnx").run(feeds());

    child.die(); // e.g. the OOM this whole change exists to contain

    await expect(a).rejects.toThrow(/exited/i);
    await expect(b).rejects.toThrow(/exited/i);
  });

  it("surfaces how the worker died, so an OOM is distinguishable from a clean exit", async () => {
    const child = new FakeChild();
    const host = new OnnxHost({ spawn: child.spawn });
    const p = host.session("/models/colsmol.onnx").run(feeds());

    child.die("code=null signal=SIGKILL");

    // Without the detail this is an unactionable "it died" and every
    // investigation starts from zero.
    await expect(p).rejects.toThrow(/SIGKILL/);
  });

  it("respawns after a death instead of staying broken", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(child.spawn);
    const host = new OnnxHost({ spawn });

    await expect(
      (async () => {
        const p = host.session("/models/a.onnx").run(feeds());
        child.die();
        return p;
      })(),
    ).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);

    const p = host.session("/models/a.onnx").run(feeds());
    expect(spawn).toHaveBeenCalledTimes(2);
    child.reply(child.sent.at(-1)!.id, out(9));
    expect(Array.from((await p).embeddings!.data)).toEqual([9]);
  });

  it("reuses one child across sessions and runs", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(child.spawn);
    const host = new OnnxHost({ spawn });

    const p1 = host.session("/models/a.onnx").run(feeds());
    child.reply(child.sent[0]!.id, out(1));
    await p1;
    const p2 = host.session("/models/b.onnx").run(feeds());
    child.reply(child.sent[1]!.id, out(2));
    await p2;

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("shutdown kills the child — this is what reclaims the memory", async () => {
    const child = new FakeChild();
    const host = new OnnxHost({ spawn: child.spawn });
    const p = host.session("/models/a.onnx").run(feeds());
    child.reply(child.sent[0]!.id, out(1));
    await p;

    host.shutdown();
    expect(child.killed).toBe(1);
  });

  it("shutdown with nothing running kills nothing", () => {
    const child = new FakeChild();
    const host = new OnnxHost({ spawn: child.spawn });
    host.shutdown();
    expect(child.killed).toBe(0);
  });

  it("rejects in-flight requests on shutdown instead of hanging forever", async () => {
    const child = new FakeChild();
    const host = new OnnxHost({ spawn: child.spawn });
    const p = host.session("/models/a.onnx").run(feeds());
    host.shutdown();
    await expect(p).rejects.toThrow(/shut down/i);
  });

  it("kills an idle worker so the weights do not sit resident", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const host = new OnnxHost({ spawn: child.spawn, idleMs: 1000 });
      const p = host.session("/models/a.onnx").run(feeds());
      child.reply(child.sent[0]!.id, out(1));
      await p;

      expect(child.killed).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(child.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not kill a worker that is still busy", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const host = new OnnxHost({ spawn: child.spawn, idleMs: 1000 });
      const a = host.session("/models/a.onnx").run(feeds());
      const b = host.session("/models/b.onnx").run(feeds());
      child.reply(child.sent[0]!.id, out(1));
      await a;

      // `b` is still outstanding, so the idle clock must not be running.
      vi.advanceTimersByTime(5000);
      expect(child.killed).toBe(0);

      child.reply(child.sent[1]!.id, out(2));
      await b;
      vi.advanceTimersByTime(1000);
      expect(child.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
