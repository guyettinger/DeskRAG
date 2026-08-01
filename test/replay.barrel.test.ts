import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as barrel from "../src/index.js";

describe("replay barrel", () => {
  it("exports the executor's public surface", () => {
    for (const name of [
      "resolveAnchor",
      "verifyNode",
      "blockersOf",
      "repairableOf",
      "reverseKeymap",
      "strokesFor",
      "buildPlan",
      "findPath",
      "edgeCost",
      "canArm",
      "executePlan",
      "agreement",
      "isRepairStep",
      "AxExecSidecar",
      "LAYER_CEILING",
      "BRITTLENESS_FLOOR",
    ]) {
      expect(barrel, name).toHaveProperty(name);
    }
  });

  // replay/ spawns a subprocess but loads no native module, so it belongs in the
  // barrel — the repo's line is "native module, not subprocess".
  it("importing the barrel loads no native module and starts no process", () => {
    expect(typeof barrel.executePlan).toBe("function");
  });
});

describe("executor inertness", () => {
  // The suite must be structurally incapable of moving the mouse: everything
  // that reaches the desktop goes through the injected Actuator, and only
  // sidecar.ts may spawn.
  it("only sidecar.ts spawns a process anywhere in replay/", () => {
    const dir = join(process.cwd(), "src/replay");
    for (const file of [
      "types.ts",
      "resolve.ts",
      "verify.ts",
      "typing.ts",
      "plan.ts",
      "execute.ts",
    ]) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(src, `${file} must not spawn`).not.toMatch(/child_process|execFile|\bspawn\(/);
    }
  });

  // Planning must stay inert: calling `activate` to discover whether an app is
  // running would activate it, changing the world the plan is describing.
  it("plan.ts never calls activate", () => {
    const src = readFileSync(join(process.cwd(), "src/replay/plan.ts"), "utf8");
    expect(src).not.toMatch(/\.activate\(/);
  });

  it("replay/ never imports store, represent, or retrieve", () => {
    const dir = join(process.cwd(), "src/replay");
    for (const file of [
      "types.ts",
      "resolve.ts",
      "verify.ts",
      "typing.ts",
      "plan.ts",
      "execute.ts",
      "sidecar.ts",
    ]) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(src, `${file} must stay a leaf`).not.toMatch(/from "\.\.\/(store|represent|retrieve)\//);
    }
  });
});
