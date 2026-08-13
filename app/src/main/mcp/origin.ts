/**
 * The request guard for the MCP endpoint — routing plus the DNS-rebinding gate.
 *
 * Pure: it takes a method, a url, headers and the port, and returns a verdict.
 * No `node:http`, no sockets, nothing to stand up in a test, which is what lets
 * the security decision live in the ROOT suite beside the rest of the
 * projections rather than being argued about in prose.
 */

/** The one route. Anything else is a 404. */
export const MCP_PATH = "/mcp";

export type Guard = { ok: true } | { ok: false; status: number; reason: string };

export interface GuardInput {
  method: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  /** The port this server is listening on — half of its own origin. */
  port: number;
}

/**
 * Origins that are this server talking to itself.
 *
 * Only the server's OWN port: a page served from `localhost:3000` is still
 * somebody else's script running in your browser, and "same machine" is not
 * "same origin". Anything else — including a bare `null`, which is what a
 * sandboxed iframe sends — is refused.
 */
function selfOrigins(port: number): ReadonlySet<string> {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
}

/**
 * Is this request allowed to reach the MCP transport at all?
 *
 * The Origin check runs FIRST, before the method and the path. A browser
 * probing for local services should learn nothing about which routes exist —
 * answering 405 to a cross-origin GET would confirm the endpoint is here.
 */
export function guardRequest(input: GuardInput): Guard {
  const origin = input.headers["origin"];

  if (origin !== undefined) {
    // An array means the header repeated. No honest client sends two origins,
    // and choosing one of them would be guessing on the security path.
    if (Array.isArray(origin) || !selfOrigins(input.port).has(origin)) {
      return {
        ok: false,
        status: 403,
        reason:
          "Refused: cross-origin request. This endpoint serves recorded screen " +
          "activity and is reachable from a browser, so a page's Origin is never trusted.",
      };
    }
  }

  // `url` is optional on node's IncomingMessage. Throwing here would surface as
  // a 500 with nothing explaining it.
  const path = (input.url ?? "").split("?")[0];
  if (path !== MCP_PATH) {
    return { ok: false, status: 404, reason: `No such route. The MCP endpoint is ${MCP_PATH}.` };
  }

  if (input.method !== "POST") {
    return {
      ok: false,
      status: 405,
      reason:
        "The transport is stateless: every call is one POST. There is no stream " +
        "to open and no session to delete.",
    };
  }

  return { ok: true };
}
