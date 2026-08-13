/**
 * mcp-probe.mjs — drive the real app and exercise the MCP endpoint over a real
 * socket, as an external agent would.
 *
 * READ-ONLY, twice over: every tool it calls is a read, and the probe itself
 * only issues JSON-RPC and screenshots. It exists because the suite cannot see
 * any of this — there is no renderer in vitest, and the app-side integration
 * test runs against a FAKE reader. What is checked here is the one thing
 * neither can reach: the six tools answering from a real store, in whatever
 * provider configuration this machine is actually set to.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { launchApp, gotoScreen, ROOT } from "../.claude/skills/run-app/scripts/launch.mjs";

const OUT = process.env.MCP_PROBE_OUT ?? join(ROOT, "docs", "images", "mcp-pane.png");

/** One JSON-RPC call. Raw node client so Host can be forged for the guard checks. */
function rpc(url, body, headers = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: headers.__method ?? "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* guard rejections are text/plain */
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on("error", reject);
    req.end(body === null ? undefined : JSON.stringify(body));
  });
}

let id = 0;
const call = async (url, name, args = {}) => {
  await rpc(url, {
    jsonrpc: "2.0",
    id: ++id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-probe", version: "0" },
    },
  });
  const { json } = await rpc(url, {
    jsonrpc: "2.0",
    id: ++id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return json;
};

const textOf = (r) =>
  (r?.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

const head = (s, n = 14) => s.split("\n").slice(0, n).join("\n");

const { app, page } = await launchApp();
try {
  await gotoScreen(page, "Settings");
  await page.waitForSelector(".mcp-log", { timeout: 20_000 });

  // What the pane says, read from the DOM rather than from the code.
  const pane = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".card")].find((c) =>
      /Agent access/i.test(c.querySelector("h2")?.textContent ?? ""),
    );
    if (!card) return null;
    const mono = [...card.querySelectorAll(".mono")].map((e) => e.textContent.trim());
    return {
      banner: card.querySelector(".banner")?.textContent?.trim() ?? null,
      descs: [...card.querySelectorAll(".desc")].map((e) => e.textContent.trim()),
      mono,
      connect: mono.find((m) => m.startsWith("claude mcp add")) ?? null,
      switchOn: card.querySelector(".switch")?.classList.contains("on") ?? false,
      // A label wider than its box is a truncated label.
      truncated: [...card.querySelectorAll(".mcp-log__tool, label")].filter(
        (l) => l.scrollWidth > l.clientWidth + 1,
      ).length,
    };
  });
  console.log("=== the pane ===");
  console.log(JSON.stringify(pane, null, 2));

  const url = pane?.connect?.split(" ").pop();
  if (!url) throw new Error("no connect command in the pane — is the endpoint listening?");
  console.log(`\n=== endpoint: ${url} ===`);

  // The security posture, against the live socket.
  const foreign = await rpc(url, { jsonrpc: "2.0", id: 900, method: "initialize", params: {} }, {
    origin: "https://evil.example",
  });
  const rebound = await rpc(url, { jsonrpc: "2.0", id: 901, method: "initialize", params: {} }, {
    host: "evil.example",
  });
  const getMethod = await rpc(url, null, { __method: "GET" });
  console.log(
    `cross-origin POST -> ${foreign.status} (want 403)\n` +
      `rebound Host     -> ${rebound.status} (want 403)\n` +
      `GET              -> ${getMethod.status} (want 405)`,
  );

  // Every tool, against the REAL store in whatever configuration this machine has.
  console.log("\n=== list_recordings ===");
  const recordings = textOf(await call(url, "list_recordings"));
  console.log(head(recordings, 12));

  const sessionId = /^([0-9A-Z]{20,})$/m.exec(recordings)?.[1];

  console.log("\n=== search_experience ===");
  const query = process.env.MCP_PROBE_QUERY ?? "recording";
  console.log(head(textOf(await call(url, "search_experience", { query, limit: 3 })), 16));

  console.log("\n=== get_recording_outline ===");
  if (sessionId) {
    console.log(head(textOf(await call(url, "get_recording_outline", { sessionId })), 20));
  } else {
    console.log("(no recording id found in list_recordings output)");
  }

  console.log("\n=== list_flows ===");
  const flows = textOf(await call(url, "list_flows"));
  console.log(head(flows, 12));

  const routeId = /^\s*id: (.+)$/m.exec(flows)?.[1];
  console.log("\n=== get_flow ===");
  console.log(
    routeId ? head(textOf(await call(url, "get_flow", { routeId })), 20) : "(no route id)",
  );

  console.log("\n=== get_moment ===");
  const frameId = /frameId: (\S+)/.exec(
    textOf(await call(url, "search_experience", { query, limit: 1 })),
  )?.[1];
  if (frameId) {
    const moment = await call(url, "get_moment", { frameId });
    const image = (moment?.result?.content ?? []).find((c) => c.type === "image");
    console.log(head(textOf(moment), 12));
    console.log(
      image
        ? `\n[image ${image.mimeType}, ${Math.round((image.data.length * 3) / 4 / 1024)} kB]`
        : "\n[no image returned]",
    );
  } else {
    console.log("(no frameId from search — nothing indexed?)");
  }

  // The log had better show every one of those calls.
  await page.waitForTimeout(300);
  const logged = await page.evaluate(() =>
    [...document.querySelectorAll(".mcp-log__row")].map((r) => ({
      tool: r.querySelector(".mcp-log__tool")?.textContent,
      ok: r.querySelector(".led")?.classList.contains("ok"),
    })),
  );
  console.log(`\n=== activity log (${logged.length} rows) ===`);
  console.log(JSON.stringify(logged.slice(0, 8)));

  // Scroll the pane into view before shooting: it sits below four other cards,
  // and a screenshot of the top of Settings proves nothing about it.
  await page.evaluate(() => {
    [...document.querySelectorAll(".card")]
      .find((c) => /Agent access/i.test(c.querySelector("h2")?.textContent ?? ""))
      ?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(400);
  const shot = await page.screenshot({ fullPage: false });
  writeFileSync(OUT, shot);
  console.log(`\nscreenshot -> ${OUT}`);
} finally {
  await app.close();
}
