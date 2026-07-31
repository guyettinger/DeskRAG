import { describe, expect, it } from "vitest";
import * as deskrag from "../src/index.js";

describe("trace barrel exports", () => {
  it("exports the pure trace surface", () => {
    for (const name of [
      "liftTrace",
      "mergeTrace",
      "printGraph",
      "parseGraph",
      "parseInterventionResponse",
      "printInterventionRequest",
      "matchNode",
      "extractPredicates",
      "buildAnchor",
      "anchorKey",
      "axPathOf",
      "hitTest",
      "fitPath",
      "projectPath",
      "groupGestures",
      "edgeSignature",
      "discoveredVariables",
      "slotNameFor",
      "REACH_BY_KIND",
    ]) {
      expect(deskrag, name).toHaveProperty(name);
    }
  });

  it("keeps the native adapters out of the barrel", () => {
    // trace/ is pure TS. If it ever reaches for a native adapter, that adapter
    // would have to be importable from here — and it must not be.
    for (const name of ["OnnxImageEmbedding", "UiohookInputProducer", "SharpRegionCropper"]) {
      expect(deskrag, name).not.toHaveProperty(name);
    }
  });
});
