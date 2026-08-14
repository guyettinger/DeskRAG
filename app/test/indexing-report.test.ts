import { describe, expect, it } from "vitest";
import { downloadLabel } from "../src/main/deskrag-service.js";
// Moved with the stages it belongs to: `index-run.ts` owns the pipeline, and it
// deliberately imports no electron, so this half needs no stub.
import { transcribeFailure } from "../src/main/index-run.js";
import { ModelFilesMissingError } from "../src/main/model-store.js";

/**
 * The two strings the indexing run says about transcription. Both exist because
 * transcription is now on by default and fetches its own weights: the stage can
 * spend a minute downloading, and it can fail in ways no other stage can.
 */
describe("downloadLabel", () => {
  it("reports megabytes, because a byte count says nothing at a glance", () => {
    expect(downloadLabel({ modelId: "w", receivedBytes: 23_000_000, totalBytes: 59_721_011, done: false }))
      .toBe("downloading model 23/60MB");
  });

  it("drops the denominator when the total is unknown", () => {
    expect(downloadLabel({ modelId: "w", receivedBytes: 1_000_000, totalBytes: 0, done: false }))
      .toBe("downloading model 1MB");
  });
});

describe("transcribeFailure", () => {
  /**
   * Setting a Model directory disables managed downloads by design, so the
   * whisper GGML has to be placed there by hand. Naming the file and both ways
   * out matters — the raw error names a path the user never typed.
   */
  it("explains the model-directory case, which is a setting and not a fault", () => {
    const msg = transcribeFailure(
      new ModelFilesMissingError("whisper-base.en-q5_1", ["ggml-base.en-q5_1.bin"], "/models"),
    );
    expect(msg).toContain("ggml-base.en-q5_1.bin");
    expect(msg).toContain("Model directory");
  });

  it("passes any other failure through verbatim", () => {
    expect(transcribeFailure(new Error("checksum mismatch"))).toBe("checksum mismatch");
    expect(transcribeFailure("ECONNRESET")).toBe("ECONNRESET");
  });
});
