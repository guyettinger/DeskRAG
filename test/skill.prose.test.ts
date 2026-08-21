import { describe, expect, it } from "vitest";
import {
  FakeSkillProseProvider,
  parseSkillResponse,
  skillPrompt,
  type SkillBrief,
} from "../src/embed/skill-prose.js";
import { OllamaSkillProseProvider } from "../src/embed/ollama-skill-prose.js";

/**
 * The seam that keeps a model out of the record, and samples out of the model.
 *
 * Two properties are load-bearing here and neither is visible by reading the
 * prompt. A reply is rejected WHOLESALE rather than repaired, because a document
 * half-written by a model and half by a template with nothing saying which half
 * is worse than one written entirely by the template and labelled. And a
 * recorded keystroke must never reach the request at all — whether the rendered
 * file prints values is a per-skill toggle, whether the model sees them is not.
 */

/** Distinctive tokens, so "no sample reached the prompt" is a real assertion. */
const SECRET_A = "hunter2-correct-horse-battery";
const SECRET_B = "sk-live-DEADBEEFCAFE1234";

const brief: SkillBrief = {
  routeLabel: "Ghostty → Google Chrome → github.com/user/repo",
  routeName: "file a bug report",
  recordings: 5,
  firstRecorded: "2026-08-02",
  lastRecorded: "2026-08-14",
  apps: ["Ghostty", "Google Chrome"],
  steps: ['click Link "Issues"', "type into slot issue_title"],
  variables: [
    { name: "issue_title", samples: 4 },
    { name: "command", samples: 1 },
  ],
  cautions: ["Step 3 was in 4 of the 5 recordings."],
  reflections: [],
};

describe("skillPrompt", () => {
  it("carries variable NAMES and counts, never a sample", () => {
    // The brief type has no field a sample could occupy — this asserts the
    // consequence, over a prompt built beside values that would be catastrophic
    // to leak. If `SkillBrief` ever grows a `samples: string[]`, this fails.
    const text = skillPrompt(brief);
    expect(text).not.toContain(SECRET_A);
    expect(text).not.toContain(SECRET_B);
    expect(text).toContain("issue_title");
    expect(text).toContain("4 distinct values");
  });

  it("distinguishes a discovered variable from a value typed once", () => {
    const text = skillPrompt(brief);
    expect(text).toContain("issue_title: 4 distinct values — varies between recordings");
    expect(text).toContain("command: 1 value, typed once — not established as a variable");
  });

  /**
   * A reflection is model output being fed back to a model, so the prompt has to
   * say what it is. Without the label the notes sit in the same wall of text as
   * the steps, and a note that hallucinated a keyboard shortcut would be
   * laundered into the prose as though the recording showed it.
   */
  it("labels reflections as opinion, and keeps them out of the step list", () => {
    const text = skillPrompt({
      ...brief,
      reflections: ["Goal: file a bug.\nWhat stalled: finding the repo took half the session."],
    });
    expect(text).toContain("finding the repo took half the session");
    expect(text).toContain("NOT part of the record");
    // After the steps, never inside them: the step list is numbered and this is
    // not one of the numbers.
    expect(text.indexOf("finding the repo")).toBeGreaterThan(text.indexOf("Steps:"));
    expect(text).not.toMatch(/^\d+\. Goal:/m);
  });

  it("says nothing at all when no reflection was written", () => {
    expect(skillPrompt(brief)).not.toContain("Notes written by a model");
  });

  it("leads with 'recorded once' rather than a date range for a single walk", () => {
    const once = skillPrompt({ ...brief, recordings: 1 });
    expect(once).toContain("Recorded ONCE");
    expect(once).toContain("not an established habit");
    expect(skillPrompt(brief)).toContain("Recorded 5 times");
  });

  it("is deterministic", () => {
    expect(skillPrompt(brief)).toBe(skillPrompt(brief));
  });
});

const good = {
  title: "File a bug report",
  description: "Use when filing a GitHub issue.",
  overview: "Two sentences.",
  whenToUse: "A paragraph.",
};

describe("parseSkillResponse", () => {
  it("accepts a clean object", () => {
    expect(parseSkillResponse(JSON.stringify(good))).toEqual(good);
  });

  it("digs the object out of a fence or a preamble", () => {
    expect(parseSkillResponse("Sure!\n```json\n" + JSON.stringify(good) + "\n```")).toEqual(good);
  });

  it("brace-matches rather than regexing, so a nested object does not truncate", () => {
    const nested = { ...good, overview: "x" };
    const text = `prefix {"a":{"b":1}} ` + JSON.stringify(nested);
    // The FIRST object wins, and it is not a valid skill — the point is that the
    // scan consumes the whole of it rather than stopping at the inner brace.
    expect(parseSkillResponse(text)).toBeUndefined();
  });

  it.each(["title", "description", "overview", "whenToUse"] as const)(
    "rejects wholesale when %s is missing",
    (field) => {
      const partial: Record<string, string> = { ...good };
      delete partial[field];
      expect(parseSkillResponse(JSON.stringify(partial))).toBeUndefined();
    },
  );

  it("rejects an empty or whitespace-only field rather than accepting a blank", () => {
    expect(parseSkillResponse(JSON.stringify({ ...good, description: "   " }))).toBeUndefined();
  });

  it("rejects a non-string field", () => {
    expect(parseSkillResponse(JSON.stringify({ ...good, title: 3 }))).toBeUndefined();
  });

  /**
   * The record is not the model's to write. A reply that returned one has
   * misunderstood the job badly enough that its prose is not trustworthy either,
   * so the four valid fields do not save it.
   */
  it.each(["steps", "recorded", "recordedSteps"])(
    "rejects a reply carrying a %s key, even with all four fields present",
    (key) => {
      expect(parseSkillResponse(JSON.stringify({ ...good, [key]: ["fake"] }))).toBeUndefined();
    },
  );

  it("rejects a bare string and text with no object", () => {
    expect(parseSkillResponse('"just a string"')).toBeUndefined();
    expect(parseSkillResponse("no json here")).toBeUndefined();
    expect(parseSkillResponse("")).toBeUndefined();
    // An ARRAY of junk: the first object found is not a skill, and nothing
    // scans past it looking for a better one.
    expect(parseSkillResponse('[{"a":1},' + JSON.stringify(good) + "]")).toBeUndefined();
  });

  /**
   * An object wrapped in an array is dug out, exactly as one wrapped in a fence
   * is. `format: "json"` is a request and models wrap replies both ways; the
   * permissiveness is in FINDING the object, never in what counts as a valid
   * one — the four-field check and the forbidden-key check run identically
   * whichever wrapper it arrived in.
   */
  it("digs the object out of an array wrapper", () => {
    expect(parseSkillResponse(JSON.stringify([good]))).toEqual(good);
    expect(parseSkillResponse(JSON.stringify([{ ...good, steps: ["x"] }]))).toBeUndefined();
  });

  it("rejects an unterminated object rather than guessing at the tail", () => {
    expect(parseSkillResponse(JSON.stringify(good).slice(0, -1))).toBeUndefined();
  });
});

const chat = (message: unknown): typeof globalThis.fetch =>
  (async () =>
    new Response(JSON.stringify({ message }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;

describe("OllamaSkillProseProvider", () => {
  it("reads the reply from content", async () => {
    const p = new OllamaSkillProseProvider({
      model: "m",
      fetchImpl: chat({ content: JSON.stringify(good) }),
    });
    expect(await p.write(brief)).toEqual(good);
  });

  /**
   * The measurement `OllamaSummaryProvider` records, carried here: a thinking
   * model routes structured output into `thinking` and leaves `content` empty
   * even with `think: false`. Reading only `content` would make every skill come
   * out template-written, and the file would say so without anyone asking why.
   */
  it("falls back to the thinking channel when content is empty", async () => {
    const p = new OllamaSkillProseProvider({
      model: "m",
      fetchImpl: chat({ content: "", thinking: JSON.stringify(good) }),
    });
    expect(await p.write(brief)).toEqual(good);
  });

  it("THROWS on a torn reply rather than returning invented prose", async () => {
    const p = new OllamaSkillProseProvider({
      model: "m",
      fetchImpl: chat({ content: '{"title":"only"' }),
    });
    await expect(p.write(brief)).rejects.toThrow(/unparseable/);
  });

  it("throws rather than accepting a reply that rewrote the steps", async () => {
    const p = new OllamaSkillProseProvider({
      model: "m",
      fetchImpl: chat({ content: JSON.stringify({ ...good, steps: ["invented"] }) }),
    });
    await expect(p.write(brief)).rejects.toThrow(/unparseable/);
  });
});

describe("FakeSkillProseProvider", () => {
  it("is deterministic and invents nothing not in the brief", async () => {
    const p = new FakeSkillProseProvider();
    const a = await p.write(brief);
    expect(await p.write(brief)).toEqual(a);
    expect(a.title).toBe("file a bug report");
    expect(a.whenToUse).toContain(brief.routeLabel);
  });
});
