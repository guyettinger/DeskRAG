/**
 * Skill prose over a local Ollama chat model.
 *
 * Barrel-safe: plain `fetch`, no native module, no subprocess.
 *
 * Failure policy: THROWS. A skill without model prose is recoverable — the
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
  parseSkillResponse,
  skillPrompt,
  SKILL_SYSTEM,
  type SkillBrief,
  type SkillProse,
  type SkillProseProvider,
} from "./skill-prose.js";

export interface OllamaSkillProseOptions {
  model: string;
  host?: string;
  fetchImpl?: typeof globalThis.fetch;
}

interface ChatResponse {
  message?: { content?: string; thinking?: string };
}

export class OllamaSkillProseProvider implements SkillProseProvider {
  readonly id = "ollama";
  readonly model: string;
  private readonly host: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OllamaSkillProseOptions) {
    this.model = opts.model;
    this.host = resolveOllamaHost(opts.host);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async write(brief: SkillBrief): Promise<SkillProse> {
    const res = await postJson<ChatResponse>(
      this.host,
      "/api/chat",
      {
        model: this.model,
        stream: false,
        // A request, not a guarantee — `parseSkillResponse` still digs the
        // object out of whatever actually comes back.
        format: "json",
        think: false,
        messages: [
          { role: "system", content: SKILL_SYSTEM },
          { role: "user", content: skillPrompt(brief) },
        ],
      },
      this.fetchImpl,
    );

    // BOTH channels, content first — the same measurement `OllamaSummaryProvider`
    // records. A thinking model routes its structured answer into `thinking` and
    // leaves `content` EMPTY even with `think: false`, because Ollama applies the
    // JSON format constraint to whichever channel the model writes. Reading only
    // `content` would make this adapter silently incompatible with every thinking
    // model, and silently is the operative word: every skill would come out
    // template-written and the file would say so without anyone asking why.
    //
    // This cannot widen what is accepted: `parseSkillResponse` rejects wholesale
    // either way.
    const msg = res.message;
    const prose =
      parseSkillResponse(msg?.content ?? "") ?? parseSkillResponse(msg?.thinking ?? "");
    if (prose === undefined) {
      const seen = (msg?.content ?? "") || (msg?.thinking ?? "");
      throw new Error(`Ollama skill prose was unparseable: ${seen.slice(0, 200)}`);
    }
    return prose;
  }
}
