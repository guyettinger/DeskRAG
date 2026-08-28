#!/usr/bin/env node
/**
 * decimate-probe — how many keyframes would each mpdecimate parameter set
 * produce from a recording we already have?
 *
 * READ ONLY by construction: it never writes to the store, never spawns the
 * app, and only ever reads the H.264 session videos on disk. Same principle as
 * scripts/replay-probe.mjs — a harness that cannot change what it measures.
 *
 * Why this exists: mpdecimate's thresholds cannot be chosen from first
 * principles. A blinking text caret is about one 8x8 block and clears ffmpeg's
 * default `hi` on its own, which on screen content would emit a keyframe every
 * sample; a Calculator digit spans several blocks and must NOT be missed. The
 * gap between those two is the whole calibration, and it is a property of real
 * footage, not of an argument.
 *
 * Usage:
 *   node scripts/decimate-probe.mjs <video.mp4> [more.mp4 ...] [--fps 1] [--width 1280] [--dump <dir>]
 *
 * Session videos live at:
 *   ~/Library/Application Support/deskrag-app/DeskRAG/blobs/<sessionId>/
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { arg, num, positionals } from "../lib/args.js";

const fps = num("fps", 1);
const width = num("width", 1280);
const dumpDir = arg("dump");
// POSITIONAL by design: this probe takes video paths, which is why it must not
// call `refuseBarePositionals`.
const videos = positionals().filter((a) => a.endsWith(".mp4"));

if (videos.length === 0) {
  console.error(
    "usage: npm run probe:decimate -- <video.mp4> [...] [--fps N] [--width N] [--dump <dir>]",
  );
  process.exit(1);
}

/**
 * The sets worth comparing. `off` is the control — it is the number of frames
 * offered at this fps, so every other row reads as a fraction of it.
 *
 * `ffmpeg-default` is included precisely because it is expected to be BAD on
 * screen content (hi=768 fires on a caret); seeing it fire far more than the
 * others is the confirmation that the any-one-block path is the problem.
 */
const SETS = [
  { name: "off", filter: "null" },
  { name: "ffmpeg-default", filter: "mpdecimate" },
  { name: "hi-4096-frac-0.002", filter: "mpdecimate=hi=4096:lo=320:frac=0.002:max=60" },
  { name: "hi-4096-frac-0.005", filter: "mpdecimate=hi=4096:lo=320:frac=0.005:max=60" },
  { name: "hi-4096-frac-0.02", filter: "mpdecimate=hi=4096:lo=320:frac=0.02:max=60" },
  { name: "hi-8192-frac-0.002", filter: "mpdecimate=hi=8192:lo=320:frac=0.002:max=60" },
  { name: "hi-2048-frac-0.002", filter: "mpdecimate=hi=2048:lo=320:frac=0.002:max=60" },
];

function durationSec(path: string): number {
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", path,
    ],
    { encoding: "utf8" },
  );
  const d = Number(String(r.stdout).trim());
  return Number.isFinite(d) ? d : 0;
}

/** Count the frames that survive one filter chain, by decoding to null. */
function survivors(path: string, filter: string): number {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-nostats", "-i", path,
      "-vf", `fps=${fps},scale=${width}:-2,${filter}`,
      "-f", "null", "-",
    ],
    { encoding: "utf8" },
  );
  // ffmpeg's final progress line reports the frames actually written.
  const m = String(r.stderr).match(/frame=\s*(\d+)/g);
  const last = m?.[m.length - 1];
  return last === undefined ? 0 : Number(last.replace(/\D/g, ""));
}

function dump(path: string, filter: string, name: string): void {
  if (dumpDir === undefined) return;
  const dir = join(dumpDir, `${basename(path, ".mp4")}--${name}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", path,
    "-vf", `fps=${fps},scale=${width}:-2,${filter}`,
    "-vsync", "0", join(dir, "%04d.jpg"),
  ]);
  console.log(`      dumped -> ${dir}`);
}

for (const path of videos) {
  const sec = durationSec(path);
  console.log(
    `\n${basename(path)}  (${sec.toFixed(1)}s, sampling at ${fps}fps, scaled to ${width}px)`,
  );
  for (const set of SETS) {
    const n = survivors(path, set.filter);
    const perMin = sec > 0 ? (n / sec) * 60 : 0;
    console.log(
      `  ${set.name.padEnd(22)} ${String(n).padStart(5)} frames  ${perMin.toFixed(1)}/min`,
    );
    if (dumpDir) dump(path, set.filter, set.name);
  }
}

console.log(`
Reading this:
  - "off" is the ceiling: every frame offered at this fps.
  - A set close to "off" is firing on noise (a caret, a clock, a cursor).
    Open its dump and look: if consecutive frames are indistinguishable, hi is
    too low or frac is too small.
  - A set far below "off" may be MISSING state changes. Open its dump and check
    that every distinct screen you remember is present. A missed state is worse
    than a duplicate one.
  - Pick the largest hi / frac that still keeps every distinct screen, then set
    DEFAULT_KEYFRAME_MIN_INTERVAL_MS so the worst-case /min figure is affordable
    to caption and embed.
`);
