/**
 * Environment probe — reports which external, non-npm dependencies are present so
 * the UI can show honest availability (ffmpeg for screen/audio, the ax-dump
 * sidecar for AX, whisper config for transcripts). All checks are best-effort.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import type { EnvInfo } from "@shared/types";
import type { DeskRagService } from "./deskrag-service.js";
import { whisperAvailable } from "./whisper.js";

/** True when the running Darwin kernel is at least major.minor. */
function darwinAtLeast(major: number, minor: number): boolean {
  const parts = os.release().split(".");
  const gotMajor = Number(parts[0]);
  const gotMinor = Number(parts[1] ?? 0);
  if (!Number.isFinite(gotMajor)) return false;
  if (gotMajor !== major) return gotMajor > major;
  return Number.isFinite(gotMinor) && gotMinor >= minor;
}

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
  const tapBin = process.env.ERAG_AUDIO_TAP_BIN ?? "audio-tap";
  return {
    platform: process.platform,
    ffmpegAvailable: commandExists("ffmpeg"),
    axSidecarAvailable: onDiskOrPath(axBin),
    // Core Audio process taps arrived in macOS 14.2 == Darwin 23.2. Both of
    // these are facts about the MACHINE and neither prompts: the System Audio
    // Recording grant cannot be queried at all (Electron exposes no member for
    // it), and the only way to learn it is to attempt a capture — which is what
    // pressing Record does. See the card's well for how that is reported.
    audioTapSupported: process.platform === "darwin" && darwinAtLeast(23, 2),
    audioTapAvailable: onDiskOrPath(tapBin),
    // Only the BINARY is probed: the GGML model is managed (MODELS.whisper) and
    // downloaded on first transcribe, so an empty modelPath is not a misconfig.
    // An empty binaryPath is not one either — it resolves to "whisper-cli".
    whisperConfigured: whisperAvailable(settings.providers.whisper.binaryPath),
    dataDir: service.dataDir,
    // Set once, at load, when a removed image provider was rewritten. Its
    // consequence — an index in a vector space nothing can query — is the thing
    // worth saying, and nothing else in the UI would say it.
    migratedImageProvider: service.settingsStore.migratedImageProvider,
    migratedTextProvider: service.settingsStore.migratedTextProvider,
  };
}
