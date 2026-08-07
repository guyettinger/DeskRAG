/** Evenly sample up to `k` items from `arr` (first..last spread). */
export function sample<T>(arr: T[], k: number): T[] {
  if (arr.length <= k) return arr;
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    out.push(arr[Math.floor((i * (arr.length - 1)) / (k - 1))]!);
  }
  return out;
}
