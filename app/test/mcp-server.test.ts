import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpExperienceServer } from "../src/main/mcp/server.js";
import type { ExperienceReader } from "../src/main/mcp/reader.js";
import type { McpLogEntryDTO } from "@shared/types";
import { request as httpRequest } from "node:http";

/**
 * The one integration test here: a real socket, a real JSON-RPC round trip, and
 * the real MCP SDK transport.
 *
 * Everything the tools DO is decided in the pure modules and tested there. What
 * this covers is the part that cannot be reasoned about offline — that the
 * handshake works, that the guard runs before the transport sees a request, and
 * that a tool call comes back in the shape a client expects.
 */

const EPOCH = 1_754_000_000_000;

const reader: ExperienceReader = {
  search: async (query) => ({
    frames:
      query === "nothing"
        ? []
        : [
            {
              frameId: "f1",
              score: 0.5,
              sessionId: "s1",
              tMono: 1000,
              offsetSec: 1,
              wallClock: EPOCH + 1000,
              width: 100,
              height: 100,
              segmentDigest: "clicked Add",
              taskSummary: "Add numbers",
              thumbUrl: null,
              highlightCount: 0,
            },
          ],
  }),
  moment: () => ({
    frameId: "f1",
    imageUrl: null,
    width: 100,
    height: 100,
    tMono: 1000,
    offsetSec: 1,
    wallClock: EPOCH + 1000,
    session: { id: "s1", startedAt: EPOCH },
    segment: { id: "seg", granularity: "action", digest: "clicked Add", caption: null, transcript: null },
    taskSummary: "Add numbers",
    ax: [],
    highlights: [],
  }),
  frameImage: async () => ({ base64: "Zm9v", mimeType: "image/jpeg" }),
  recordings: () => [],
  outline: () => null,
  flows: () => null,
  skills: () => ({
    skills: [],
    proposals: [],
    graphPresent: false,
    prose: { available: false, model: null },
  }),
};

const log: McpLogEntryDTO[] = [];
let server: McpExperienceServer;
let base: string;

async function rpc(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a guard rejection answers in text/plain */
  }
  return { status: res.status, json, text };
}

/**
 * A POST with headers `fetch` refuses to set. Node's client has no forbidden
 * header list, which is what makes forging Host testable at all.
 */
function rawPost(headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(init));
  });
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

beforeAll(async () => {
  server = new McpExperienceServer({
    reader,
    port: 0, // ephemeral, so the suite never collides with a running DeskRAG
    version: "0.0.0-test",
    onLog: (e) => log.push(e),
  });
  await server.start();
  const status = server.status(true);
  expect(status.listening, status.error ?? "did not bind").toBe(true);
  base = status.url!;
});

afterAll(async () => {
  await server.stop();
});

describe("the endpoint", () => {
  it("binds loopback and reports a connect command for the port it got", () => {
    const status = server.status(true);
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(status.connectCommand).toContain(status.url!);
    expect(status.error).toBeNull();
  });

  it("completes the MCP handshake and advertises the instructions", async () => {
    const { status, json } = await rpc(init);
    expect(status).toBe(200);
    expect(json.result.serverInfo.name).toBe("deskrag");
    expect(json.result.instructions).toMatch(/recording/i);
  });

  it("lists the eight tools, marked read-only", async () => {
    await rpc(init);
    const { json } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "get_flow",
      "get_moment",
      "get_recording_outline",
      "get_skill",
      "list_flows",
      "list_recordings",
      "list_skills",
      "search_experience",
    ]);
    for (const t of json.result.tools) {
      expect(t.annotations.readOnlyHint, t.name).toBe(true);
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });

  it("runs a tool and returns its content", async () => {
    await rpc(init);
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_experience", arguments: { query: "add" } },
    });
    expect(json.result.content[0].text).toMatch(/Add numbers/);
    expect(json.result.isError).toBeUndefined();
  });

  it("returns a screenshot as an image block over the wire", async () => {
    await rpc(init);
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_moment", arguments: { frameId: "f1" } },
    });
    const image = json.result.content.find((c: { type: string }) => c.type === "image");
    expect(image).toMatchObject({ mimeType: "image/jpeg", data: "Zm9v" });
  });

  it("reports a tool-level failure as isError, not as a transport error", async () => {
    await rpc(init);
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_flow", arguments: { routeId: "ghost" } },
    });
    // The call succeeded; the answer is "no". A transport error would tell the
    // agent the server is broken rather than that its argument was wrong.
    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
  });

  it("logs every call without logging the payload", async () => {
    log.length = 0;
    await rpc(init);
    await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "get_moment", arguments: { frameId: "f1" } },
    });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ tool: "get_moment", ok: true });
    expect(log[0]!.args).toContain("f1");
    // The base64 screenshot must never reach the log — it is counted, not kept.
    expect(log[0]!.result).not.toContain("Zm9v");
    expect(log[0]!.result).toMatch(/\+1 image/);
  });
});

describe("the guard runs before the transport", () => {
  it("403s a cross-origin POST", async () => {
    const { status, text } = await rpc(init, { origin: "https://evil.example" });
    expect(status).toBe(403);
    expect(text).toMatch(/origin/i);
  });

  it("403s a rebound Host", async () => {
    // `fetch` cannot send this: Host is a forbidden header name, so a custom one
    // is silently dropped and the real Host goes out instead — which is why this
    // uses the raw client. A rebinding attack has no such restriction; the
    // browser sends `Host: evil.example` to 127.0.0.1 all by itself.
    const { status, text } = await rawPost({ host: "evil.example" });
    expect(status).toBe(403);
    expect(text).toMatch(/host/i);
  });

  it("405s a GET and 404s another path", async () => {
    expect((await fetch(base)).status).toBe(405);
    expect((await fetch(base.replace("/mcp", "/"), { method: "POST" })).status).toBe(404);
  });
});

describe("lifecycle", () => {
  it("stops listening when disabled, and comes back when re-enabled", async () => {
    const s = new McpExperienceServer({ reader, port: 0, version: "0", onLog: () => {} });
    await s.start();
    const url = s.status(true).url!;
    expect((await fetch(url, { method: "POST" })).status).toBeLessThan(500);

    await s.applySettings(false, 0);
    expect(s.status(false).listening).toBe(false);
    await expect(fetch(url, { method: "POST" })).rejects.toThrow();

    await s.applySettings(true, 0);
    expect(s.status(true).listening).toBe(true);
    await s.stop();
  });

  it("records a bind failure instead of throwing", async () => {
    const taken = new McpExperienceServer({ reader, port: 0, version: "0", onLog: () => {} });
    await taken.start();
    const port = taken.status(true).port;

    const clash = new McpExperienceServer({ reader, port, version: "0", onLog: () => {} });
    await clash.start();
    const status = clash.status(true);
    // Enabled and NOT listening is a real state, and the one a reader most needs
    // to see — it must never be retried onto a different port, because the user
    // has already pasted a fixed URL into their client config.
    expect(status.listening).toBe(false);
    expect(status.error).toMatch(/in use/i);
    expect(status.url).toBeNull();

    await taken.stop();
    await clash.stop();
  });
});
