/**
 * The six tools, and the formatting that turns DTOs into something an agent can
 * read.
 *
 * Pure: no MCP SDK, no Electron, no store. The transport in `server.ts` walks
 * `TOOLS` to advertise them and calls `callTool` to run one, so everything
 * decided here — what exists, what it says, what it refuses — is decided in the
 * root test suite.
 *
 * READ ONLY. There is no tool that records, deletes, reindexes or acts, and
 * `ExperienceReader` has no method that could support one.
 */

import type { FrameHitDTO, ResultDetailDTO, SessionSummaryDTO } from "@shared/types";
import type { ExperienceReader } from "./reader.js";
import { renderOutline, stamp } from "./outline.js";
import { findRoute, renderFlow, renderFlowList } from "./flow-text.js";

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  /** base64, for an image block. */
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  run(reader: ExperienceReader, args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * What this server is, in the words the client shows the model.
 *
 * The framing matters: these are recordings of THIS user's own activity, so
 * they are evidence about what they did, not general knowledge about how
 * software works.
 */
export const SERVER_INSTRUCTIONS = `DeskRAG is a local recording of this user's own desktop activity — \
screen, audio, input and the accessibility tree — indexed so it can be searched.

Use it to ground decisions in what the user has ACTUALLY done rather than guessing: \
which tools and sites they use, how they carried out a task before, what they typed, \
what was on screen at a particular time. Everything here is evidence about this user's \
past, never general knowledge.

Start with search_experience for "when did I…", list_recordings for what exists, \
get_recording_outline for what one recording was about, and list_flows/get_flow for a \
task the user has performed more than once. get_moment returns the actual screenshot.

This server is read-only: it cannot record, delete, re-index, or control the desktop.`;

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const fail = (s: string): ToolResult => ({ content: [{ type: "text", text: s }], isError: true });

function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (typeof v !== "string" || v.trim().length === 0) return null;
  return v.trim();
}

const DEFAULT_LIMIT = 8;

/**
 * A caller's limit, clamped.
 *
 * 0 and negatives fall back to the default rather than returning nothing: an
 * empty result would read as an empty index, which is the one thing this server
 * must never say by accident.
 */
export function limitOf(args: Record<string, unknown>): number {
  const v = args["limit"];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(v), 50);
}

/** Wall clock, because an agent reasons in dates and not in session offsets. */
function iso(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function bytes(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${(n / 1000).toFixed(0)} kB`;
}

// --- search ----------------------------------------------------------------

function hitLines(h: FrameHitDTO, rank: number): string {
  const out = [
    `${rank}. ${iso(h.wallClock)} · ${stamp(h.offsetSec)} into recording ${h.sessionId} · score ${h.score.toFixed(3)}`,
  ];
  if (h.taskSummary !== null) out.push(`   Task: ${h.taskSummary}`);
  if (h.segmentDigest !== null) out.push(`   What happened: ${h.segmentDigest}`);
  if (h.highlightCount > 0) out.push(`   ${h.highlightCount} matching region(s) on screen`);
  out.push(`   frameId: ${h.frameId}  — pass to get_moment for the screenshot`);
  return out.join("\n");
}

const searchTool: ToolDef = {
  name: "search_experience",
  title: "Search recorded experience",
  description:
    "Search everything the user has recorded — screen captions, typed text, window titles, " +
    "transcripts and composed task summaries — and return the moments that match, best first. " +
    "Use this to answer 'when did I…', 'have I done this before', 'what was I working on'.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language or an exact term." },
      limit: { type: "number", description: "Max moments to return (1-50, default 8)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(reader, args) {
    const query = str(args, "query");
    if (query === null) return fail("`query` is required and must be a non-empty string.");

    const result = await reader.search(query);
    const hits = result.frames.slice(0, limitOf(args));

    if (hits.length === 0) {
      // An empty list is the shape of THREE different states, and an agent given
      // the bare list would report the first one every time.
      if (result.indexedUnderDifferentProvider === true) {
        return text(
          "No matches — but this library HAS indexed vectors, just under a different " +
            "embedding provider than the one currently configured. Vector spaces are " +
            "namespaced per model and never migrated, so nothing in the old space is " +
            "searchable now. Switch the provider back in DeskRAG's Settings, or re-index.",
        );
      }
      if (result.segmentsMatchedButNoFrames !== undefined) {
        return text(
          `No moments returned, though ${result.segmentsMatchedButNoFrames} segment(s) matched ` +
            "the query. Those segments have no frames linked to them, which is an index " +
            "defect rather than an empty result — re-index the library in DeskRAG " +
            "(Settings → Rebuild search index).",
        );
      }
      return text("No matches.");
    }

    return text(
      `${hits.length} moment(s), best first.\n\n${hits.map((h, i) => hitLines(h, i + 1)).join("\n\n")}`,
    );
  },
};

// --- one moment ------------------------------------------------------------

function momentText(d: ResultDetailDTO, hasImage: boolean): string {
  const out = [
    `Frame ${d.frameId} — ${iso(d.wallClock)}, ${stamp(d.offsetSec)} into recording ${d.session.id}`,
  ];
  if (d.taskSummary !== null) out.push(`Task: ${d.taskSummary}`);
  if (d.segment !== null) {
    if (d.segment.caption !== null) out.push(`On screen: ${d.segment.caption}`);
    if (d.segment.digest !== null) out.push(`What happened: ${d.segment.digest}`);
    if (d.segment.transcript !== null) out.push(`Said: ${d.segment.transcript}`);
  }
  const labelled = d.ax
    .filter((e) => e.label !== undefined && e.label.length > 0)
    .slice(0, 40)
    .map((e) => `${e.role} "${e.label}"`);
  if (labelled.length > 0) out.push(`Accessibility elements: ${labelled.join(", ")}`);
  if (d.highlights.length > 0) {
    out.push(
      `Matched regions: ${d.highlights
        .map((h) => `${h.role ?? "region"} "${h.label ?? ""}" (${h.matchedBy.join("+")})`)
        .join(", ")}`,
    );
  }
  if (!hasImage) {
    out.push(
      "(No stored keyframe for this frame, so there is no screenshot — the text above is " +
        "everything recorded about it.)",
    );
  }
  return out.join("\n");
}

const momentTool: ToolDef = {
  name: "get_moment",
  title: "Get one recorded moment",
  description:
    "Everything recorded about one moment: the screenshot the user was looking at, the " +
    "caption, what happened, any speech, and the on-screen accessibility elements. " +
    "Takes a frameId from search_experience.",
  inputSchema: {
    type: "object",
    properties: {
      frameId: { type: "string", description: "A frameId returned by search_experience." },
      includeImage: {
        type: "boolean",
        description: "Return the screenshot as an image (default true).",
      },
    },
    required: ["frameId"],
    additionalProperties: false,
  },
  async run(reader, args) {
    const frameId = str(args, "frameId");
    if (frameId === null) return fail("`frameId` is required and must be a non-empty string.");

    const d = reader.moment(frameId);
    if (d === null) return fail(`No frame ${frameId}. Frame ids come from search_experience.`);

    const wantImage = args["includeImage"] !== false;
    const image = wantImage ? await reader.frameImage(frameId) : null;
    const content: ToolContent[] = [{ type: "text", text: momentText(d, image !== null) }];
    if (image !== null) {
      content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
    }
    return { content };
  },
};

// --- recordings ------------------------------------------------------------

function recordingLines(s: SessionSummaryDTO): string {
  const ended = s.endedAt === null ? "in progress" : iso(s.endedAt);
  const out = [
    `${s.id}`,
    `  ${iso(s.startedAt)} → ${ended}  (${(s.durationMs / 1000).toFixed(1)}s)`,
  ];
  out.push(
    s.purpose === null
      ? "  Purpose: unknown — this recording has not been indexed."
      : `  Purpose: ${s.purpose}${s.purposeSource === null ? "" : ` [${s.purposeSource}]`}`,
  );
  out.push(
    `  ${s.frameCount} keyframes · ${s.segmentCount} segments · ${s.eventCount} events · ${bytes(s.sizeBytes)}`,
  );
  return out.join("\n");
}

const recordingsTool: ToolDef = {
  name: "list_recordings",
  title: "List recordings",
  description:
    "Every recording DeskRAG holds, newest first, with what each one was for. Use this to " +
    "find a session id for get_recording_outline, or to see what periods are covered at all.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run(reader) {
    const rows = reader.recordings();
    if (rows.length === 0) {
      return text("No recordings yet. Nothing has been captured on this machine.");
    }
    return text(
      `${rows.length} recording(s).\n\n${[...rows]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(recordingLines)
        .join("\n\n")}`,
    );
  },
};

const outlineTool: ToolDef = {
  name: "get_recording_outline",
  title: "Outline a recording",
  description:
    "One recording as a hierarchy: its overall purpose, the phases within it, the tasks " +
    "within those, and the individual actions — each with its time offset. This is the " +
    "fastest way to understand what a whole session was about.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "A recording id from list_recordings." },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
  async run(reader, args) {
    const sessionId = str(args, "sessionId");
    if (sessionId === null) return fail("`sessionId` is required and must be a non-empty string.");
    const outline = reader.outline(sessionId);
    if (outline === null) {
      return fail(`No recording ${sessionId}. Recording ids come from list_recordings.`);
    }
    return text(renderOutline(outline));
  },
};

// --- flows -----------------------------------------------------------------

const NO_GRAPH =
  "No trace graph has been built on this machine, so there are no recorded flows. " +
  "A graph is lifted from recordings when they are indexed; press `Rebuild trace graph` " +
  "in DeskRAG (Settings → Maintenance) to build one from what has already been captured.";

const listFlowsTool: ToolDef = {
  name: "list_flows",
  title: "List recorded flows",
  description:
    "Tasks the user has performed more than once, as routes through the states their " +
    "recordings actually passed through. Use this to find out whether something is a " +
    "habit and to get a routeId for get_flow.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run(reader) {
    const flows = reader.flows();
    if (flows === null) return text(NO_GRAPH);
    return text(renderFlowList(flows));
  },
};

const getFlowTool: ToolDef = {
  name: "get_flow",
  title: "Get one recorded flow",
  description:
    "One recorded flow step by step: the states it moves between, the actions taken on each " +
    "step with the elements they targeted, when it was walked and by how many recordings, " +
    "and the values that varied between attempts.",
  inputSchema: {
    type: "object",
    properties: { routeId: { type: "string", description: "A routeId from list_flows." } },
    required: ["routeId"],
    additionalProperties: false,
  },
  async run(reader, args) {
    const routeId = str(args, "routeId");
    if (routeId === null) return fail("`routeId` is required and must be a non-empty string.");
    const flows = reader.flows();
    if (flows === null) return fail(NO_GRAPH);
    const route = findRoute(flows, routeId);
    if (route === undefined) {
      return fail(`No flow ${routeId}. Route ids come from list_flows.`);
    }
    return text(renderFlow(flows, route));
  },
};

export const TOOLS: readonly ToolDef[] = [
  searchTool,
  momentTool,
  recordingsTool,
  outlineTool,
  listFlowsTool,
  getFlowTool,
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Run a tool by name, converting anything thrown into a tool error.
 *
 * A provider being unreachable — Ollama not running, most often — is an ordinary
 * state here, not a crash: it has to reach the agent as a message it can act on
 * rather than as a failed request with no explanation.
 */
export async function callTool(
  reader: ExperienceReader,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = toolByName(name);
  if (tool === undefined) {
    return fail(`No such tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(", ")}.`);
  }
  try {
    return await tool.run(reader, args);
  } catch (err) {
    return fail(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
