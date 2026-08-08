import { describe, expect, it } from "vitest";
import { axBinCandidates, resolveAxBin } from "../app/src/main/sidecar-path.js";

const PACKAGED = "/Applications/DeskRAG.app/Contents/Resources";
const PACKAGED_MAIN = `${PACKAGED}/app.asar/out/main`;
const DEV_MAIN = "/repo/app/out/main";

describe("axBinCandidates", () => {
  it("prefers the bundled copy when packaged", () => {
    expect(axBinCandidates(PACKAGED, PACKAGED_MAIN)[0]).toBe(`${PACKAGED}/ax-dump`);
  });

  it("offers only the repo copy in dev, where resourcesPath is undefined", () => {
    expect(axBinCandidates(undefined, DEV_MAIN)).toEqual(["/repo/native/ax-dump"]);
  });

  it("never lets the dev candidate satisfy a packaged run by accident", () => {
    // Packaged, __dirname is inside app.asar, so the dev candidate resolves to
    // Contents/Resources/app.asar/../../native — NOT where extraResources puts
    // the binary. If it ever did collide, a stale repo copy could shadow the
    // shipped one.
    const [, dev] = axBinCandidates(PACKAGED, PACKAGED_MAIN);
    expect(dev).not.toBe(`${PACKAGED}/ax-dump`);
  });
});

describe("resolveAxBin", () => {
  it("finds the bundled sidecar in a packaged app", () => {
    const found = resolveAxBin(PACKAGED, PACKAGED_MAIN, (p) => p === `${PACKAGED}/ax-dump`);
    expect(found).toBe(`${PACKAGED}/ax-dump`);
  });

  it("falls through to the repo copy in dev", () => {
    const found = resolveAxBin(undefined, DEV_MAIN, (p) => p === "/repo/native/ax-dump");
    expect(found).toBe("/repo/native/ax-dump");
  });

  it("returns undefined when nothing is there, rather than a guess", () => {
    // The caller leaves ERAG_AX_BIN unset and capture refuses. Returning a
    // plausible path would move the failure to spawn time and make it look
    // like a permissions problem.
    expect(resolveAxBin(PACKAGED, PACKAGED_MAIN, () => false)).toBeUndefined();
  });
});
