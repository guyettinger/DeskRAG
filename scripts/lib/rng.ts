/**
 * A seeded LCG, so a sample is the same sample on the next run.
 *
 * Byte-identical in `caption-width` and `embed` before this. Both report a
 * verdict over a drawn sample, and a sample that moved between runs would make
 * every comparison a comparison of two different corpora.
 */
export function seeded(n: number, seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}
