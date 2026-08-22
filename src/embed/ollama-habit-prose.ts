/**
 * Habit prose over a local Ollama chat model.
 *
 * Barrel-safe: plain `fetch`, no native module, no subprocess.
 *
 * Failure policy: THROWS. A habit without model prose is recoverable — the
 * caller catches and takes the template path, and says in the file which one
 * wrote it — but this adapter must not decide that, and must never return
 * invented prose, which would be indistinguishable from a real reply
 * downstream. Same split as `OllamaSummaryProvider.compose`.
 *
 * It reuses the SUMMARY model rather than adding a second picker: naming a
 * composed level and naming a recorded flow are the same act at two altitudes,
 * and two model settings is two things to keep in step.
 */

import { postJson, resolveOllamaHost } from "./ollama-client.js";
import {
  parseHabitResponse,
  habitPrompt,
  HABIT_SYSTEM,
  type HabitBrief,
  type HabitProse,
  type HabitProseProvider,
} from "./habit-prose.js";

export interface OllamaHabitProseOptions {
  model: string;
  host?: string;
  fetchImpl?: typeof globalThis.fetch;
}

interface ChatResponse {
  message?: { content?: string; thinking?: string };
}

export class OllamaHabitProseProvider implements HabitProseProvider {
  readonly id = "ollama";
  readonly model: string;
  private readonly host: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaHabitProseOptions) {
    this.model = opts.model;
    this.host = resolveOllamaHost(opts.host);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async write(brief: HabitBrief): Promise<HabitProse> {
    const res = await postJson<ChatResponse>(
      this.host,
      "/api/chat",
      {
        model: this.model,
        stream: false,
        // A request, not a guarantee — `parseHabitResponse` still digs the
        // object out of whatever actually comes back.
        format: "json",
        think: false,
        messages: [
          { role: "system", content: HABIT_SYSTEM },
          { role: "user", content: habitPrompt(brief) },
        ],
      },
      this.fetchImpl,
    );

    // BOTH channels, content first — the same measurement `OllamaSummaryProvider`
    // records. A thinking model routes its structured answer into `thinking` and
    // leaves `content` EMPTY even with `think: false`, because Ollama applies the
    // JSON format constraint to whichever channel the model writes. Reading only
    // `content` would make this adapter silently incompatible with every thinking
    // model, and silently is the operative word: every habit would come out
    // template-written and the file would say so without anyone asking why.
    //
    // This cannot widen what is accepted: `parseHabitResponse` rejects wholesale
    // either way.
    const msg = res.message;
    const prose =
      parseHabitResponse(msg?.content ?? "") ?? parseHabitResponse(msg?.thinking ?? "");
    if (prose === undefined) {
      const seen = (msg?.content ?? "") || (msg?.thinking ?? "");
      throw new Error(`Ollama habit prose was unparseable: ${seen.slice(0, 200)}`);
    }
    return prose;
  }
}
