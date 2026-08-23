import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "../app/src/main/mcp/tools.js";

/**
 * The MCP endpoint is reachable by any local process and carries no token, so
 * "it only reads" cannot be a promise in prose — it has to be a property of the
 * source. This is `test/replay.barrel.test.ts`'s guarantee applied to the one
 * surface the outside world can reach: a tool that clicks cannot be added here
 * by accident, only by deleting this file.
 */
const MCP_DIR = join(process.cwd(), "app/src/main/mcp");

/** Read from disk rather than listed, so a new file is covered the day it lands. */
const mcpFiles = (): string[] => readdirSync(MCP_DIR).filter((f) => f.endsWith(".ts"));

/**
 * Source with its comments removed.
 *
 * The guard has to read CODE, not prose. This repo explains itself in comments,
 * and several of these modules legitimately discuss the executor and the
 * `ax-dump`/`ax-exec` drift hazard while calling neither — a guard that fired on
 * the discussion would be edited away by the first person it annoyed, which is a
 * worse outcome than the blunt version catching nothing.
 *
 * `//` is only treated as a line comment when it is NOT preceded by a colon, so
 * a `deskrag://` or `http://` inside a string keeps its line intact.
 */
export function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const read = (f: string): string => codeOf(readFileSync(join(MCP_DIR, f), "utf8"));

describe("the guard's own comment stripper", () => {
  // A stripper that removed everything would make every assertion below pass
  // vacuously — the failure mode of a guard that reads its input through a
  // filter. So the filter is tested too.
  it("keeps code and drops comments", () => {
    expect(codeOf("const a = 1; // executePlan\n")).toMatch(/const a = 1;/);
    expect(codeOf("const a = 1; // executePlan\n")).not.toMatch(/executePlan/);
    expect(codeOf("/* executePlan */\nconst b = 2;")).toBe("\nconst b = 2;");
    expect(codeOf('const u = "deskrag://frame/x";')).toMatch(/frame\/x/);
  });
});

describe("the MCP surface cannot reach the executor", () => {
  it("has files to guard", () => {
    // A guard over an empty directory passes vacuously and would keep passing if
    // the directory were renamed.
    expect(mcpFiles().length).toBeGreaterThanOrEqual(5);
  });

  it("never imports replay/ or names ax-exec", () => {
    // DeskRAGApp has not spawned ax-exec since 2026-08-06 and this must not be
    // the thing that brings it back — least of all driven by a remote caller.
    for (const file of mcpFiles()) {
      const src = read(file);
      expect(src, `${file} must not reach the executor`).not.toMatch(
        /deskrag\/replay|from "\.\.\/replay|ax-exec|ERAG_AX_EXEC_BIN/,
      );
      for (const symbol of ["executePlan", "executeRun", "buildPlan", "canArm", "AxExecSidecar"]) {
        expect(src, `${file} must not use ${symbol}`).not.toMatch(new RegExp(`\\b${symbol}\\b`));
      }
    }
  });

  it("spawns nothing", () => {
    // Deliberately NOT a bare `exec(`: a regex `.exec()` is ordinary code, and a
    // guard that fires on one would be read as a false positive and loosened.
    for (const file of mcpFiles()) {
      expect(read(file), `${file} must not spawn`).not.toMatch(
        /child_process|execFile|execSync|\bspawn\(|\bspawnSync\(/,
      );
    }
  });

  it("calls nothing on the service that writes, deletes or captures", () => {
    // `DeskRagService` owns recording and deletion as well as reading, so the
    // reader holding one is only safe if it calls the read half. Named methods,
    // because the danger is a specific call rather than a word.
    // `close` is deliberately absent: it is the HTTP server's and the SDK
    // transport's method name too, so guarding it by name would fire on
    // `server.ts` shutting its own socket down. Closing the STORE is prevented
    // by type instead — `ServiceReads` does not declare it, see below.
    const forbidden = [
      "startRecording",
      "stopRecording",
      "removeSession",
      "reindexTraces",
      "reindexSearch",
      "deleteSession",
    ];
    for (const file of mcpFiles()) {
      const src = read(file);
      for (const method of forbidden) {
        expect(src, `${file} must not call ${method}`).not.toMatch(
          new RegExp(`\\.${method}\\s*\\(`),
        );
      }
    }
  });

  it("does not let a tool mutate the window's own state", () => {
    // A background agent search must not clear the highlights the user's open
    // result is drawn from — the detached variants exist for exactly this.
    for (const file of mcpFiles()) {
      expect(read(file), `${file} must not touch renderer state`).not.toMatch(/lastHighlights/);
    }
  });

  it("every advertised tool is a read", () => {
    for (const t of TOOLS) {
      expect(t.name, t.name).toMatch(/^(search|get|list)_/);
    }
  });
});

describe("the reader's interfaces are the read-only contract", () => {
  it("ExperienceReader declares no method that could record, delete or act", () => {
    const src = read("reader.ts");
    const iface = /export interface ExperienceReader \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(iface, "ExperienceReader interface not found").toBeDefined();
    // The interface is what `tools.ts` is written against, so widening it is the
    // first step any acting tool would have to take.
    expect(iface!).not.toMatch(/record\(|delete|remove|start|stop|arm|execute|write|put|set/i);
  });

  it("ServiceReads names only the read half of the service", () => {
    // This is the guarantee that replaces guarding `close` by name: the reader
    // holds this port rather than DeskRagService itself, so it could not close
    // the store, stop a recording or delete a session even if a tool asked.
    const src = read("reader.ts");
    const iface = /export interface ServiceReads \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(iface, "ServiceReads interface not found").toBeDefined();
    expect(iface!).not.toMatch(
      /\bclose\b|\bdelete|\bremove|startRecording|stopRecording|reindex|\bopen\(/i,
    );
  });

  it("declares the two methods the habit tools read through", () => {
    // Named, because their ABSENCE is what a future refactor would produce and
    // the tools would then fail at runtime rather than at typecheck.
    const src = read("reader.ts");
    const iface = /export interface ExperienceReader \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(iface!).toMatch(/\bembed\(/);
    expect(iface!).toMatch(/\bmomentAt\(/);
  });

  it("names the embedder's parameter something other than `inputs`", () => {
    // `EmbeddingProvider.embed(inputs: string[])` cannot be mirrored verbatim:
    // the guard above has no word boundaries, so `inPUTs` matches `put` and the
    // whole interface fails. Likewise no inline `startedAt`, which matches
    // `start`. This asserts the trap stays sprung rather than silently loosened.
    const src = read("reader.ts");
    const iface = /export interface ExperienceReader \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(iface!).not.toMatch(/inputs/);
  });
});
