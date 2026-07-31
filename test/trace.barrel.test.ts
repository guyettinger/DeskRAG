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

describe("capture/env barrel exports", () => {
  it("exports the PURE environment surface", () => {
    for (const name of [
      "displayIdAt",
      "outsideKnownDisplays",
      "macKeycodeFor",
      "resolveChar",
      "coerceDisplays",
      "coerceKeymap",
      "shouldSampleMove",
      "modifiersOf",
      "resolveKeys",
      "KeymapProducer",
      "BoundaryAxTrigger",
      "FakeDisplaySource",
      "FakeKeymapSource",
    ]) {
      expect(deskrag, name).toHaveProperty(name);
    }
  });

  it("exports the Swift-backed sources, like SwiftAxSource", () => {
    // The barrel rule bars adapters that load a NATIVE MODULE at import time.
    // These only execFile a binary, so importing them loads nothing — which is
    // exactly why SwiftAxSource has always been exported.
    for (const name of ["SwiftDisplaySource", "SwiftKeymapSource", "SwiftAxSource"]) {
      expect(deskrag, name).toHaveProperty(name);
    }
  });

  it("still keeps the genuinely native adapters out", () => {
    for (const name of ["OnnxImageEmbedding", "UiohookInputProducer", "SharpRegionCropper"]) {
      expect(deskrag, name).not.toHaveProperty(name);
    }
  });
});
