/**
 * Session reflections over a local Ollama chat model.
 *
 * Barrel-safe: plain `fetch`, no native module, no subprocess.
 *
 * Failure policy: THROWS. A recording with no reflection is a recording with no
 * reflection — the stage says so and the pipeline carries on — but this adapter
 * must not decide that, and must never return an invented note, which would be
 * indistinguishable from a real one downstream. Same split as
 * `OllamaHabitProseProvider.write`.
 *
 * It reuses the SUMMARY model rather than adding a third picker, for the reason
 * `ollama-habit-prose.ts` does: naming a composed level, naming a recorded flow
 * and judging how a session went are the same act at three altitudes, and each
 * extra model setting is one more thing to keep in step.
 */

import { postJson, resolveOllamaHost } from "./ollama-client.js";
import {
  parseReflectionResponse,
  reflectionPrompt,
  REFLECTION_SYSTEM,
  type ReflectionBrief,
  type ReflectionProvider,
  type SessionReflection,
} from "./reflection.js";

export interface OllamaReflectionOptions {
  model: string;
  host?: string;
  fetchImpl?: typeof globalThis.fetch;
}

interface ChatResponse {
  message?: { content?: string; thinking?: string };
}

export class OllamaReflectionProvider implements ReflectionProvider {
  readonly id = "ollama";
  readonly model: string;
  private readonly host: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaReflectionOptions) {
    this.model = opts.model;
    this.host = resolveOllamaHost(opts.host);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async write(brief: ReflectionBrief): Promise<SessionReflection> {
    const res = await postJson<ChatResponse>(
      this.host,
      "/api/chat",
      {
        model: this.model,
        stream: false,
        format: "json",
        think: false,
        messages: [
          { role: "system", content: REFLECTION_SYSTEM },
          { role: "user", content: reflectionPrompt(brief) },
        ],
      },
      this.fetchImpl,
    );

    // BOTH channels, content first — the measurement `OllamaSummaryProvider`
    // recorded and `OllamaHabitProseProvider` repeats. A thinking model routes
    // its structured answer into `thinking` and leaves `content` EMPTY even with
    // `think: false`, because Ollama applies the JSON format constraint to
    // whichever channel the model writes. Reading only `content` would make this
    // adapter silently incompatible with every thinking model — and silently is
    // the operative word: every recording would come back with no reflection and
    // the stage would report a torn reply nobody was looking at.
    //
    // This cannot widen what is accepted: `parseReflectionResponse` rejects
    // wholesale either way.
    const msg = res.message;
    const note =
      parseReflectionResponse(msg?.content ?? "") ?? parseReflectionResponse(msg?.thinking ?? "");
    if (note === undefined) {
      const seen = (msg?.content ?? "") || (msg?.thinking ?? "");
      throw new Error(`Ollama reflection was unparseable: ${seen.slice(0, 200)}`);
    }
    return note;
  }
}
