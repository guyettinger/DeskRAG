/**
 * SampleClock — turns ffmpeg's presentation timestamp into t_mono.
 *
 * A sampled frame's t_mono is `origin + pts`, and `origin` is the video blob's
 * `tMonoStart`. That is exact for the thing that matters: the Library maps a
 * frame onto the video with `(frame.tMono - videoBlob.tMonoStart) / 1000`, so
 * anchoring here makes a keyframe and the video frame showing it agree BY
 * CONSTRUCTION rather than by both being approximately right.
 *
 * It replaces stamping arrival time, which measured 3.05s late on a real
 * avfoundation device — ~0.8s of device start-up plus ~2.2s of capture-to-
 * delivery latency, all of it landing in the timestamp. PTS carries none of it.
 *
 * Without a video blob (no blob store, `recordVideo: false` — i.e. every test)
 * the origin is seeded from the first sample instead. Relative spacing stays
 * exact; the absolute offset then carries that one frame's delivery latency.
 * One code path that degrades, rather than two that diverge.
 */
export class SampleClock {
  private origin: number | undefined;

  constructor(videoTMonoStart?: number) {
    this.origin = videoTMonoStart;
  }

  /**
   * t_mono for a sample carrying `ptsMs`. `nowTMono` is used ONLY to seed the
   * origin on the first sample of a video-less session.
   */
  tMonoFor(ptsMs: number, nowTMono: number): number {
    // `??=`, never `||=`: an origin of 0 is a real value and must not re-seed.
    this.origin ??= nowTMono - ptsMs;
    return this.origin + ptsMs;
  }
}
