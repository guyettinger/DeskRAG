import { describe, expect, it } from "vitest";
import { MCP_PATH, guardRequest } from "../app/src/main/mcp/origin.js";

const PORT = 41777;
const HOST = { host: `127.0.0.1:${PORT}` };
const post = (
  headers: Record<string, string | string[] | undefined> = {},
): ReturnType<typeof guardRequest> =>
  guardRequest({ method: "POST", url: MCP_PATH, headers: { ...HOST, ...headers }, port: PORT });

describe("guardRequest — routing", () => {
  it("allows POST to the MCP path with no Origin", () => {
    expect(post()).toEqual({ ok: true });
  });

  it("405s a GET: there is no server-initiated stream to subscribe to", () => {
    // Stateless transport, so answering GET would imply a stream that does not
    // exist. 405 names the wrong method rather than 404 naming a missing route.
    const r = guardRequest({ method: "GET", url: MCP_PATH, headers: HOST, port: PORT });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status: 405 });
  });

  it("405s a DELETE — session teardown is meaningless without sessions", () => {
    const r = guardRequest({ method: "DELETE", url: MCP_PATH, headers: HOST, port: PORT });
    expect(r).toMatchObject({ ok: false, status: 405 });
  });

  it("404s any other path", () => {
    const r = guardRequest({ method: "POST", url: "/", headers: HOST, port: PORT });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("ignores a query string on the MCP path", () => {
    expect(
      guardRequest({ method: "POST", url: `${MCP_PATH}?x=1`, headers: HOST, port: PORT }),
    ).toEqual({ ok: true });
  });

  it("treats a missing url as not found rather than throwing", () => {
    // node's IncomingMessage types `url` as optional; a guard that threw here
    // would fail the request with a 500 and no explanation.
    const r = guardRequest({ method: "POST", headers: HOST, port: PORT });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe("guardRequest — the Host check", () => {
  // THE HOST CHECK IS THE ONE THAT ACTUALLY CLOSES DNS REBINDING. Once
  // evil.example has rebound to 127.0.0.1 the browser considers the target
  // same-origin and sends NO Origin header at all — the request looks perfectly
  // innocent to the Origin check, and the only trace of where the page came
  // from is the Host header it still carries.
  it("rejects a rebound domain even though it sends no Origin", () => {
    const r = guardRequest({
      method: "POST",
      url: MCP_PATH,
      headers: { host: "evil.example" },
      port: PORT,
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(r.ok === false && r.reason).toMatch(/host/i);
  });

  it("rejects a missing Host header", () => {
    expect(guardRequest({ method: "POST", url: MCP_PATH, headers: {}, port: PORT })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("rejects the right host on the wrong port", () => {
    expect(post({ host: "127.0.0.1:9999" })).toMatchObject({ ok: false, status: 403 });
  });

  it("accepts every spelling of loopback, with or without the port", () => {
    for (const host of [
      `127.0.0.1:${PORT}`,
      `localhost:${PORT}`,
      `[::1]:${PORT}`,
      "127.0.0.1",
      "localhost",
    ]) {
      expect(post({ host }), host).toEqual({ ok: true });
    }
  });

  it("rejects a duplicated Host header", () => {
    expect(post({ host: ["127.0.0.1:41777", "evil.example"] })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("is checked before everything else", () => {
    // A rebound page must learn nothing at all — not the route, not the method.
    expect(
      guardRequest({ method: "GET", url: "/", headers: { host: "evil.example" }, port: PORT }),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

describe("guardRequest — the DNS-rebinding gate", () => {
  // This endpoint carries no token, so this check is the ONLY thing standing
  // between a web page you happen to visit and your whole screen history: a
  // page at evil.example can POST to 127.0.0.1 from your own browser.
  it("rejects a foreign Origin with 403", () => {
    const r = post({ origin: "https://evil.example" });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(r.ok === false && r.reason).toMatch(/origin/i);
  });

  it("rejects a localhost page on another port", () => {
    // A dev server on this machine is still a web page running someone else's
    // script. Same-machine is not the same as same-origin.
    expect(post({ origin: "http://localhost:3000" })).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects an http origin that merely CONTAINS the loopback host", () => {
    // The substring trap: "127.0.0.1.evil.example" is a domain the attacker owns.
    expect(post({ origin: "http://127.0.0.1.evil.example" })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(post({ origin: "http://evil.example/127.0.0.1:41777" })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("rejects `null`, which is what a sandboxed iframe sends", () => {
    expect(post({ origin: "null" })).toMatchObject({ ok: false, status: 403 });
  });

  it("allows the server's own loopback origin, by either name", () => {
    // A local page legitimately talking to the endpoint it was told about is
    // same-origin; refusing it would be stricter than the threat requires.
    expect(post({ origin: `http://127.0.0.1:${PORT}` })).toEqual({ ok: true });
    expect(post({ origin: `http://localhost:${PORT}` })).toEqual({ ok: true });
    expect(post({ origin: `http://[::1]:${PORT}` })).toEqual({ ok: true });
  });

  it("rejects a duplicated Origin header outright", () => {
    // node hands back an array when a header repeats. Two origins is not a
    // request any honest client makes, and picking one would be guessing.
    expect(post({ origin: ["http://127.0.0.1:41777", "https://evil.example"] })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("is checked BEFORE the method, so a browser probe cannot learn the route", () => {
    const r = guardRequest({
      method: "GET",
      url: MCP_PATH,
      headers: { ...HOST, origin: "https://evil.example" },
      port: PORT,
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
});
