import { describe, expect, it } from "vitest";
import { toolPath } from "../src/main/tool-path.js";

describe("toolPath", () => {
  it("adds the Homebrew prefixes a launchd-started app never inherits", () => {
    const out = toolPath("/usr/bin:/bin", "darwin").split(":");
    expect(out).toContain("/opt/homebrew/bin");
    expect(out).toContain("/usr/local/bin");
  });

  it("keeps inherited entries first so a user PATH still wins", () => {
    const out = toolPath("/my/bin:/usr/bin", "darwin").split(":");
    expect(out[0]).toBe("/my/bin");
    expect(out.indexOf("/opt/homebrew/bin")).toBeGreaterThan(out.indexOf("/usr/bin"));
  });

  it("never duplicates a prefix that is already present", () => {
    const out = toolPath("/opt/homebrew/bin:/usr/bin", "darwin").split(":");
    expect(out.filter((p) => p === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("tolerates an empty or missing PATH", () => {
    expect(toolPath(undefined, "darwin").split(":")).toContain("/opt/homebrew/bin");
    expect(toolPath("", "darwin").startsWith(":")).toBe(false);
  });

  it("leaves non-darwin platforms alone — these prefixes are macOS conventions", () => {
    expect(toolPath("/usr/bin:/bin", "linux")).toBe("/usr/bin:/bin");
    expect(toolPath("C:\\Windows", "win32")).toBe("C:\\Windows");
  });
});
