/**
 * What a probe prints, and how it counts.
 *
 * `ok()` existed six times in four variants. Three of them tracked failures and
 * one — `merge`'s — did not: it set `process.exitCode` but never incremented
 * anything, so its closing line read "All checks passed" whether or not they
 * had. A probe that cannot report its own result is worse than no probe, so
 * there is one of these now and it counts.
 */

let failures = 0;

/**
 * One check. `detail` is printed either way; `hint` only when it fails, so the
 * passing output stays readable and the failing one says what to do.
 */
export function ok(label: string, cond: boolean, detail = "", hint = ""): boolean {
  const tail = cond ? detail : [detail, hint].filter(Boolean).join(" — ");
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${tail ? ` — ${tail}` : ""}`);
  if (!cond) {
    failures += 1;
    process.exitCode = 1;
  }
  return cond;
}

/** Something observed but not asserted. Disclosure, never a verdict. */
export function note(label: string, detail = ""): void {
  console.log(`  --  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** How many checks have failed so far. */
export const failureCount = (): number => failures;

/** The closing line. Returns the count so a caller can branch on it. */
export function summary(prefix = ""): number {
  console.log(
    `${prefix}${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`,
  );
  return failures;
}

/** A section heading with a blank line above it. */
export function section(title: string): void {
  console.log(`\n${title}`);
}

/** `n` of `of`, as a percentage, or an em dash when there is nothing to divide. */
export const pct = (n: number, of: number): string =>
  of === 0 ? "—" : `${Math.round((100 * n) / of)}%`;

export const padEnd = (s: unknown, n: number): string => String(s).padEnd(n);
export const padStart = (s: unknown, n: number): string => String(s).padStart(n);

/**
 * Narrow away an absent value, loudly.
 *
 * A probe reads its subject back out of a list repeatedly — `habits.find(...)`
 * after every write — and TypeScript is right that those can miss. The wrong
 * answer is a non-null assertion: if the habit really did vanish mid-run, the
 * probe would go on to print `undefined` into a check and call it a FAIL about
 * the app. This says which subject went missing, and stops.
 */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`${what} is gone — the probe cannot measure what it cannot find`);
  }
  return value;
}
