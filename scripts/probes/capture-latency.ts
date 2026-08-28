/**
 * Measures how far a sampled keyframe's TIMESTAMP sits from the picture it
 * shows. Read-only: the encoded video goes to /dev/null, the MJPEG pipe is
 * drained and discarded, and no store is touched.
 *
 * --synthetic (default) drives the real arg graph from a lavfi source that
 * burns the input frame number into the picture as an 8-stripe binary barcode,
 * so the 32x32 grayscale branch alone recovers WHICH input frame a sample is —
 * no OCR, no JPEG decode. With -re, input frame N is produced at t0 + N/rate,
 * so the picture's true time is known and both `pts - content` and
 * `arrival - content` are exact.
 *
 * --device runs the same graph against the real screen and reports
 * `arrival - pts`: the latency PTS stamping removes, which needs no ground
 * truth about content. PRIVACY: no pixel data is stored, decoded, printed or
 * kept in this mode — the grayscale pipe is COUNTED ONLY.
 *
 * Usage: npm run probe:latency -- [--device] [--seconds N] [--fps N]
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { flag, num } from "../lib/args.js";

const DEVICE = flag("device");
const SECONDS = num("seconds", 25);
const fps = num("fps", 1);
const GRAY_W = 32, GRAY_H = 32, GRAY_BYTES = GRAY_W * GRAY_H, BITS = 8;
const maxW = 1280, q = 5, videoFps = 10, videoMaxW = 1920;

// Mirrors FfmpegScreenProducer.rateFilter — the escaped comma is load-bearing.
const rate = `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${1 / fps})'`;
// A static desktop keeps ~1 frame per MINUTE via the max=60 heartbeat, which
// starves the device measurement. Delivery latency, not the keep decision, is
// what is under test there.
const decimate = DEVICE ? "null" : `mpdecimate=hi=${64 * 64}:lo=${64 * 20}:frac=0.003:max=60`;
const sample = `${rate},scale=${maxW}:-2,${decimate}`;
const gray = `scale=${GRAY_W}:${GRAY_H},format=gray`;
const PT = ["-fps_mode", "passthrough"];

let input: string | undefined;
let inputArgs: string[];
if (DEVICE) {
  // The index is DISCOVERED: cameras come first in this table, so a hard-coded
  // "1" is a camera on many Macs.
  let table = "";
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    table = String((e as { stderr?: unknown }).stderr ?? "");
  }
  const m = table.match(/\[(\d+)\]\s+Capture screen \d+/);
  // NO NUMERIC FALLBACK for the screen: a camera at index 1 fails as a
  // framerate error, which reads as a pipeline bug.
  if (m?.[1] === undefined) {
    console.error("no screen device found — grant Screen Recording");
    process.exit(1);
  }
  input = m[1];
  inputArgs = ["-f", "avfoundation", "-framerate", String(videoFps), "-t", String(SECONDS), "-i", input];
  console.log(`using avfoundation input [${input}] (Capture screen)`);
} else {
  const barcode =
    `geq=lum='255*bitand(floor(N/pow(2\\,floor(X/(W/${BITS}))))\\,1)':cb=128:cr=128`;
  // -t is an INPUT option: as an output option it binds only to the NEXT
  // output (the mp4), leaving both pipes reading an infinite source.
  inputArgs = ["-re", "-f", "lavfi", "-t", String(SECONDS), "-i",
    `color=c=black:s=320x180:r=${videoFps},${barcode}`];
}

const chains = [
  // Generated small and scaled UP, so every stage does real Retina-sized work
  // without paying to SYNTHESIZE a 2560x1440 source, which cannot be done in
  // real time and silently invalidates the measurement.
  DEVICE ? `[0:v]split=2[v][s]` : `[0:v]scale=2560:1440:flags=neighbor,split=2[v][s]`,
  `[v]scale='min(${videoMaxW},iw)':-2[vv]`,
  `[s]${sample}[d]`,
  `[d]split=3[g][c][t]`,
  `[g]${gray}[gg]`, `[c]null[cc]`, `[t]null[tt]`,
];

const args = [
  "-hide_banner", "-loglevel", "warning", ...inputArgs,
  "-filter_complex", chains.join(";"),
  "-map", "[vv]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
  "-pix_fmt", "yuv420p", "-g", String(videoFps * 2),
  "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", "/dev/null",
  "-map", "[gg]", ...PT, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  "-map", "[cc]", ...PT, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", String(q), "pipe:3",
  "-map", "[tt]", ...PT, "-f", "mkvtimestamp_v2", "pipe:4",
];

/** Recover the burned-in input frame number from one 32x32 gray frame. */
function decodeN(g: Buffer): number {
  const stripe = GRAY_W / BITS;
  const y = Math.floor(GRAY_H / 2);
  let n = 0;
  for (let b = 0; b < BITS; b++) {
    if ((g[y * GRAY_W + Math.floor(b * stripe + stripe / 2)] ?? 0) > 128) n |= 1 << b;
  }
  return n;
}

const t0 = Date.now();
const el = () => (Date.now() - t0) / 1000;
const proc: ChildProcessWithoutNullStreams = spawn("ffmpeg", args, {
  stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
}) as ChildProcessWithoutNullStreams;

/** The extra pipes: fd 3 carries the JPEGs, fd 4 the timestamps. */
const extra = (fd: number): Readable => proc.stdio[fd] as Readable;

let buf = Buffer.alloc(0);
let counted = 0;
const rows: { at: number; n: number }[] = [];
proc.stdout.on("data", (c: Buffer) => {
  const at = el();
  buf = Buffer.concat([buf, c]);
  while (buf.length >= GRAY_BYTES) {
    const g = buf.subarray(0, GRAY_BYTES);
    buf = buf.subarray(GRAY_BYTES);
    // In --device mode the pixels are COUNTED, never inspected.
    rows.push({ at, n: DEVICE ? counted++ : decodeN(g) });
  }
});
extra(3).resume(); // drain and discard the JPEGs, or ffmpeg blocks

const ptsMs: number[] = [];
let tsBuf = "";
extra(4).on("data", (c: Buffer) => {
  tsBuf += c.toString();
  const lines = tsBuf.split("\n");
  tsBuf = lines.pop() ?? "";
  for (const l of lines) if (/^\d/.test(l.trim())) ptsMs.push(Number(l.trim()));
});
proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[ffmpeg] ${d}`));

proc.on("exit", (code) => {
  const med = (a: readonly number[]): number | undefined =>
    a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : undefined;
  console.log(`\n=== ${DEVICE ? "real screen" : "synthetic barcode"}, fps=${fps} (exit ${code}) ===`);
  if (DEVICE) {
    console.log(" arrival     ptsSec   arrival-pts");
    const gaps: number[] = [];
    rows.forEach((r, i) => {
      const p = ptsMs[i];
      if (p == null) return;
      gaps.push(r.at - p / 1000);
      console.log(r.at.toFixed(3).padStart(8), (p / 1000).toFixed(3).padStart(10),
        (r.at - p / 1000).toFixed(3).padStart(13));
    });
    console.log(`\nmedian arrival-pts: ${med(gaps)?.toFixed(3)}s ` +
      `<- the latency PTS stamping removes`);
    return;
  }
  console.log(" arrival  frameN  contentSec  arrival-content   ptsSec  pts-content");
  let wraps = 0, prev = -1;
  const arr: number[] = [];
  const pe: number[] = [];
  rows.forEach((r, i) => {
    if (r.n < prev) wraps++;
    prev = r.n;
    const content = (r.n + wraps * 256) / videoFps;
    const pts = ptsMs[i] != null ? ptsMs[i] / 1000 : null;
    arr.push(r.at - content);
    if (pts != null) pe.push(pts - content);
    console.log(r.at.toFixed(3).padStart(8), String(r.n).padStart(7),
      content.toFixed(3).padStart(11), (r.at - content).toFixed(3).padStart(16),
      (pts?.toFixed(3) ?? "-").padStart(9), (pts == null ? "-" : (pts - content).toFixed(3)).padStart(12));
  });
  console.log(`\narrival-content median ${med(arr.slice(Math.floor(arr.length / 2)))?.toFixed(3)}s ` +
    `(what arrival stamping cost)`);
  console.log(`pts-content    median ${med(pe)?.toFixed(3)}s (expect 0.000 with select)`);
});
