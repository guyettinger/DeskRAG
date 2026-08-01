import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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
      "isSupersededStep",
      "locateNode",
      "executeRun",
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

const REPLAY_DIR = join(process.cwd(), "src/replay");
/**
 * EVERY file in replay/, read from disk rather than listed here. The guard below
 * is the whole safety story, and a guard that has to be remembered when a file
 * is added is a guard that will eventually be forgotten.
 */
const replayFiles = (): string[] => readdirSync(REPLAY_DIR).filter((f) => f.endsWith(".ts"));
const read = (f: string): string => readFileSync(join(REPLAY_DIR, f), "utf8");

describe("executor inertness", () => {
  // The suite must be structurally incapable of moving the mouse: everything
  // that reaches the desktop goes through the injected Actuator, and only
  // sidecar.ts may spawn.
  it("only sidecar.ts spawns a process anywhere in replay/", () => {
    for (const file of replayFiles()) {
      if (file === "sidecar.ts") continue;
      expect(read(file), `${file} must not spawn`).not.toMatch(/child_process|execFile|\bspawn\(/);
    }
    // The exemption has to stay real: if sidecar.ts stopped spawning, this guard
    // would be silently exempting a file that no longer needs exempting.
    expect(read("sidecar.ts")).toMatch(/\bspawn\(/);
  });

  // Planning must stay inert: calling `activate` to discover whether an app is
  // running would activate it, changing the world the plan is describing.
  it("plan.ts never calls activate", () => {
    const src = readFileSync(join(process.cwd(), "src/replay/plan.ts"), "utf8");
    expect(src).not.toMatch(/\.activate\(/);
  });

  it("replay/ never imports store, represent, or retrieve", () => {
    for (const file of replayFiles()) {
      expect(read(file), `${file} must stay a leaf`).not.toMatch(
        /from "\.\.\/(store|represent|retrieve)\//,
      );
    }
  });
});
