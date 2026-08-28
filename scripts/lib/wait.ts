/** Polling, with the two timeout behaviours the probes actually rely on. */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface UntilOptions {
  /** Give up after this long. */
  timeout?: number;
  /** How often to re-check. */
  every?: number;
  /**
   * What a timeout means. THROW and NULL are both load-bearing and this is why
   * the two were never one function: `reflect`, `stability` and `habits` want a
   * timeout to abort the run, while `tray` BRANCHES on the null — a menu item
   * that never appears is one of the things it reports on. Collapsing them
   * would turn one probe's finding into a stack trace.
   */
  onTimeout?: "throw" | "null";
  /** Named in the timeout message. */
  label?: string;
}

/** Poll `fn` until it returns something truthy. */
export async function until<T>(
  fn: () => T | Promise<T>,
  { timeout = 20_000, every = 250, onTimeout = "throw", label = "a condition" }: UntilOptions = {},
): Promise<T | null> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) {
      if (onTimeout === "null") return null;
      throw new Error(`timed out after ${Math.round(timeout / 1000)}s waiting for ${label}`);
    }
    await sleep(every);
  }
}
