/**
 * The MCP endpoint: a loopback HTTP listener, the transport, and the activity
 * log.
 *
 * This is the only module here that does I/O. What it may serve is decided by
 * `tools.ts`, what it may read is bounded by `ExperienceReader`, and what it
 * will answer at all is decided by `origin.ts` — all three pure and root-tested,
 * so the part that cannot be tested offline is only the plumbing.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpLogEntryDTO, McpStatusDTO } from "@shared/types";
import { MCP_PATH, guardRequest } from "./origin.js";
import { SERVER_INSTRUCTIONS, TOOLS, callTool } from "./tools.js";
import type { ExperienceReader } from "./reader.js";

/**
 * How many calls the activity log keeps.
 *
 * In memory, and cleared on quit. A permanent growing record of what an agent
 * read from your screen history is itself a second copy of sensitive material,
 * and nothing here needs it to survive a restart.
 */
const LOG_CAP = 200;

/** One line summarising a call's arguments, for the log. */
function summarizeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  const line = parts.join(" ");
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/** What went back, in one line — never the payload, which may be a screenshot. */
function summarizeResult(result: { content: { type: string; text?: string }[]; isError?: boolean }): string {
  const images = result.content.filter((c) => c.type === "image").length;
  const first = result.content.find((c) => c.type === "text")?.text ?? "";
  const head = first.split("\n")[0] ?? "";
  const shown = head.length > 120 ? `${head.slice(0, 117)}…` : head;
  return images > 0 ? `${shown} (+${images} image)` : shown;
}

export interface McpServerOptions {
  reader: ExperienceReader;
  port: number;
  /** Fired for every completed call, so the app can show what agents are asking. */
  onLog: (entry: McpLogEntryDTO) => void;
  /** App version, reported in the MCP handshake. */
  version: string;
}

export class McpExperienceServer {
  private http: HttpServer | undefined;
  private readonly log: McpLogEntryDTO[] = [];
  private bindError: string | null = null;
  private listening = false;
  /** Mutable: the port can be changed in Settings without restarting the app. */
  private port: number;

  constructor(private readonly options: McpServerOptions) {
    this.port = options.port;
  }

  /**
   * Bring the listener into line with the settings.
   *
   * Called on every settings write, so it must be a no-op when nothing relevant
   * changed — the Settings screen writes on each keystroke, and tearing the
   * socket down and back up on every one would drop an agent's in-flight call.
   */
  async applySettings(enabled: boolean, port: number): Promise<void> {
    if (!enabled) {
      await this.stop();
      this.bindError = null;
      return;
    }
    if (this.listening && port === this.port) return;
    await this.stop();
    this.port = port;
    await this.start();
  }

  entries(): McpLogEntryDTO[] {
    return [...this.log];
  }

  status(enabled: boolean): McpStatusDTO {
    const url = this.listening ? `http://127.0.0.1:${this.port}${MCP_PATH}` : null;
    return {
      enabled,
      port: this.port,
      // `listening` is not `enabled`: a server switched on that failed to bind is
      // enabled and NOT listening, and that is the state a reader needs to see.
      listening: this.listening,
      error: this.bindError,
      url,
      connectCommand: url === null ? null : `claude mcp add --transport http deskrag ${url}`,
    };
  }

  /**
   * Bind, or record why not.
   *
   * A bind failure is REPORTED rather than retried on another port: the user
   * pastes a fixed URL into an agent's config once, so a server that quietly
   * moved would present as broken with nothing on screen to say why.
   */
  async start(): Promise<void> {
    if (this.http !== undefined) return;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.http = server;

    await new Promise<void>((resolve) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        this.bindError =
          err.code === "EADDRINUSE"
            ? `Port ${this.port} is already in use. Pick another in Settings.`
            : err.message;
        this.listening = false;
        this.http = undefined;
        resolve();
      });
      // Loopback only. Never 0.0.0.0: this serves recorded screen activity.
      server.listen(this.port, "127.0.0.1", () => {
        // Read back what was actually bound rather than trusting the request.
        // With a configured port the two are identical; this is not a fallback —
        // it is what makes the Host check and the connect command agree with the
        // socket, including when a caller asks for port 0.
        const addr = server.address();
        if (addr !== null && typeof addr === "object") this.port = addr.port;
        this.listening = true;
        this.bindError = null;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.http;
    this.http = undefined;
    this.listening = false;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const verdict = guardRequest({
      method: req.method,
      url: req.url,
      headers: req.headers,
      port: this.port,
    });
    if (!verdict.ok) {
      res.writeHead(verdict.status, { "content-type": "text/plain" });
      res.end(verdict.reason);
      return;
    }

    try {
      // A FRESH server and transport per request. Stateless: no session id, no
      // stream held open, nothing to reconnect after the app restarts.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = this.buildServer();
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /**
   * The low-level `Server`, deliberately, rather than the high-level `McpServer`.
   *
   * `McpServer.registerTool` types `inputSchema` as a Zod schema, so using it
   * would mean either putting Zod into `tools.ts` — which is pure, SDK-free and
   * root-tested precisely so the tool surface can be argued about offline — or
   * converting JSON Schema to Zod and back on every registration. `Server` takes
   * the JSON Schema this repo already writes and dispatches through `callTool`,
   * which is the SDK's own stated carve-out ("only use Server for advanced use
   * cases"): the dispatch and the schemas are already owned here.
   */
  private buildServer(): Server {
    const server = new Server(
      { name: "deskrag", version: this.options.version },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        // Advertised so a client can show what this server will and will not do.
        // Every tool here reads; nothing writes, and nothing touches the desktop.
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const started = Date.now();
      const result = await callTool(this.options.reader, name, args);
      this.record({
        id: randomUUID(),
        at: started,
        tool: name,
        args: summarizeArgs(args),
        result: summarizeResult(result),
        ms: Date.now() - started,
        ok: result.isError !== true,
      });
      return { content: result.content, ...(result.isError === true ? { isError: true } : {}) };
    });

    return server;
  }

  private record(entry: McpLogEntryDTO): void {
    this.log.push(entry);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
    this.options.onLog(entry);
  }
}
