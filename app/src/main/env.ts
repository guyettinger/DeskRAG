/**
 * Environment probe — reports which external, non-npm dependencies are present so
 * the UI can show honest availability (ffmpeg for screen/audio, the ax-dump
 * sidecar for AX, whisper config for transcripts). All checks are best-effort.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { EnvInfo } from "@shared/types";
import type { DeskRagService } from "./deskrag-service.js";

function commandExists(cmd: string): boolean {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(probe, [cmd], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function envInfo(service: DeskRagService): EnvInfo {
  const settings = service.settingsStore.view();
  // An absolute/relative path is checked on disk; a bare name is looked up on PATH.
  const onDiskOrPath = (bin: string): boolean =>
    bin.includes("/") ? existsSync(bin) : commandExists(bin);
  const axBin = process.env.ERAG_AX_BIN ?? "ax-dump";
  const whisperBin = settings.providers.whisper.binaryPath;
  return {
    platform: process.platform,
    ffmpegAvailable: commandExists("ffmpeg"),
    axSidecarAvailable: onDiskOrPath(axBin),
    whisperConfigured: Boolean(settings.providers.whisper.modelPath) && onDiskOrPath(whisperBin),
    dataDir: service.dataDir,
  };
}
