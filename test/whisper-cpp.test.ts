import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WhisperCppTranscription } from "../src/represent/transcript/whisper-cpp.js";

/**
 * A stub whisper-cli: writes a canned whisper.cpp -oj-shaped JSON to
 * `<-of value>.json`, so WhisperCppTranscription is tested without a real
 * model or binary — same shebang-stub pattern as test/replay.sidecar-client.test.ts.
 */
function stubWhisper(jsonBody: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "whisper-stub-"));
  const path = join(dir, "whisper-cli");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "const of = args[args.indexOf('-of') + 1];",
      `fs.writeFileSync(of + '.json', ${JSON.stringify(jsonBody)});`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return { dir, path };
}

describe("WhisperCppTranscription", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("parses whisper.cpp's -oj output into text + per-segment timestamps", async () => {
    const stub = stubWhisper(
      JSON.stringify({
        transcription: [
          { offsets: { from: 0, to: 2000 }, text: " hello" },
          { offsets: { from: 2000, to: 4000 }, text: " world" },
        ],
      }),
    );
    dir = stub.dir;
    const t = new WhisperCppTranscription({ binaryPath: stub.path, modelPath: "fake-model" });
    const result = await t.transcribe(Uint8Array.from([1, 2, 3]));
    expect(result.text).toBe("hello world");
    expect(result.segments).toEqual([
      { text: "hello", startMs: 0, endMs: 2000 },
      { text: "world", startMs: 2000, endMs: 4000 },
    ]);
  });

  it("degrades to text-only ({ text: '' }) when the JSON is malformed", async () => {
    const stub = stubWhisper("not json");
    dir = stub.dir;
    const t = new WhisperCppTranscription({
      binaryPath: stub.path,
      modelPath: "fake-model",
      onError: () => {}, // silence the expected error log for this test
    });
    const result = await t.transcribe(Uint8Array.from([1, 2, 3]));
    expect(result).toEqual({ text: "" });
  });
});
