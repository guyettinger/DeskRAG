import { describe, expect, it } from "vitest";
import {
  FakeReflectionProvider,
  parseReflectionResponse,
  reflectionPrompt,
  renderReflection,
  REFLECTION_HEADINGS,
  type ReflectionBrief,
} from "../src/embed/reflection.js";
import { OllamaReflectionProvider } from "../src/embed/ollama-reflection.js";

/**
 * A reflection is the one derived artefact in this pipeline that is a JUDGEMENT
 * rather than a measurement, and that is what these tests are about.
 *
 * Two properties are load-bearing and neither is visible from reading the
 * prompt. A reply is rejected WHOLESALE rather than repaired — there is no
 * template half to fill a gap with, so a half-parsed note would be a model's
 * opinion with a blank where its worst sentence should be. And the model is
 * given time SHARES rather than raw seconds to divide, because "what stalled"
 * is the only claim it is asked for that the numbers can actually support.
 */

const brief: ReflectionBrief = {
  purpose: "prepare the release notes",
  recordedOn: "2026-08-19",
  durationSec: 600,
  steps: [
    { name: "read the changelog", seconds: 60, actions: 8 },
    { name: "hunt for the issue numbers", seconds: 480, actions: 91 },
    { name: "paste the summary", seconds: 60, actions: 6 },
  ],
  apps: ["Ghostty", "Google Chrome"],
};

describe("reflectionPrompt", () => {
  it("states each step's SHARE of the session, not just its seconds", () => {
    const text = reflectionPrompt(brief);
    expect(text).toContain("hunt for the issue numbers — 480s (80% of the session)");
    expect(text).toContain("91 actions");
  });

  /**
   * A zero-length recording is not a division by zero and not a step at 0%. It
   * simply says nothing about shares — the number would be invented either way.
   */
  it("omits the share rather than dividing by a zero-length session", () => {
    const text = reflectionPrompt({ ...brief, durationSec: 0 });
    expect(text).not.toContain("%");
    expect(text).toContain("read the changelog — 60s, 8 actions");
  });

  it("keeps the steps in the order they were given", () => {
    const text = reflectionPrompt(brief);
    expect(text.indexOf("1. read the changelog")).toBeLessThan(text.indexOf("2. hunt"));
    expect(text.indexOf("2. hunt")).toBeLessThan(text.indexOf("3. paste"));
  });

  it("says nothing about a purpose nothing composed a name for", () => {
    expect(reflectionPrompt({ ...brief, purpose: null })).not.toContain("composed under the name");
  });
});

describe("parseReflectionResponse", () => {
  const good = '{"goal":"g","worked":"w","stalled":"s","better":"b"}';

  it("accepts the four fields, trimmed", () => {
    expect(parseReflectionResponse('{"goal":" g ","worked":"w","stalled":"s","better":"b"}')).toEqual(
      { goal: "g", worked: "w", stalled: "s", better: "b" },
    );
  });

  it("digs the object out of a fence or a sentence", () => {
    expect(parseReflectionResponse("Sure!\n```json\n" + good + "\n```")).not.toBeUndefined();
  });

  /**
   * WHOLESALE, and this is the one that matters. There is no template path for a
   * reflection, so a partially-accepted reply could only be completed by
   * inventing the missing field — which is precisely the fabrication a note
   * about "what stalled" must never contain.
   */
  it("rejects a reply missing any field rather than repairing it", () => {
    expect(parseReflectionResponse('{"goal":"g","worked":"w","stalled":"s"}')).toBeUndefined();
    expect(
      parseReflectionResponse('{"goal":"g","worked":"w","stalled":"","better":"b"}'),
    ).toBeUndefined();
  });

  it("rejects a reply that tried to write steps, even a complete one", () => {
    expect(
      parseReflectionResponse(
        '{"goal":"g","worked":"w","stalled":"s","better":"b","steps":["open Finder"]}',
      ),
    ).toBeUndefined();
  });

  it("returns undefined for prose with no object in it", () => {
    expect(parseReflectionResponse("The session went well.")).toBeUndefined();
  });
});

describe("renderReflection", () => {
  it("writes every heading, in one stable order", () => {
    const text = renderReflection({ goal: "g", worked: "w", stalled: "s", better: "b" });
    expect(text).toBe("Goal: g\nWhat worked: w\nWhat stalled: s\nA better order: b");
    for (const { head } of REFLECTION_HEADINGS) expect(text).toContain(head);
  });
});

/**
 * The thinking-channel measurement, inherited from `OllamaSummaryProvider` and
 * repeated here because it is the failure that is INVISIBLE: a thinking model
 * routes its JSON into `thinking` and leaves `content` empty even with
 * `think: false`, so an adapter reading only `content` reports every recording
 * as having a torn reply, forever, with nobody looking.
 */
describe("OllamaReflectionProvider", () => {
  const reply = (body: { content?: string; thinking?: string }) =>
    (async () =>
      new Response(JSON.stringify({ message: body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

  const good = '{"goal":"g","worked":"w","stalled":"s","better":"b"}';

  it("reads the reply out of content", async () => {
    const p = new OllamaReflectionProvider({ model: "m", fetchImpl: reply({ content: good }) });
    expect((await p.write(brief)).goal).toBe("g");
  });

  it("reads the reply out of the thinking channel when content is empty", async () => {
    const p = new OllamaReflectionProvider({
      model: "m",
      fetchImpl: reply({ content: "", thinking: good }),
    });
    expect((await p.write(brief)).goal).toBe("g");
  });

  it("THROWS on a torn reply rather than returning an invented note", async () => {
    const p = new OllamaReflectionProvider({
      model: "m",
      fetchImpl: reply({ content: "I could not tell." }),
    });
    await expect(p.write(brief)).rejects.toThrow(/unparseable/);
  });
});

describe("FakeReflectionProvider", () => {
  it("invents nothing: every claim comes from the brief", async () => {
    const note = await new FakeReflectionProvider().write(brief);
    expect(note.goal).toBe("prepare the release notes");
    expect(note.stalled).toContain("hunt for the issue numbers");
  });

  it("says a session with no steps has nothing slow, rather than naming one", async () => {
    const note = await new FakeReflectionProvider().write({ ...brief, steps: [] });
    expect(note.stalled).toContain("nothing can be called slow");
  });
});
