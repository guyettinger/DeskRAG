/**
 * Command-line flags, in ONE convention.
 *
 * There were four, across seven probes: `arg("name", d)`, `arg("--name", d)`
 * with the dashes inside, `val("--name", d)`, and a fourth reading a sliced
 * `argv`. Each one silently returns the DEFAULT when called in another's
 * convention, so a probe run with an explicit flag reports the numbers for a
 * flag it never received. The dashes live here, never at the call site.
 */

const ARGV = process.argv.slice(2);

/**
 * The value of `--name`, or `fallback`.
 *
 * BOTH spellings, because both were already in use and a probe invoked in the
 * other one silently took its default: `--name value` and `--name=value`.
 */
export function arg(name: string, fallback: string): string;
export function arg(name: string): string | undefined;
export function arg(name: string, fallback?: string): string | undefined {
  const joined = ARGV.find((a) => a.startsWith(`--${name}=`));
  if (joined !== undefined) {
    const v = joined.slice(name.length + 3);
    return v !== "" ? v : fallback;
  }
  const i = ARGV.indexOf(`--${name}`);
  const v = i >= 0 ? ARGV[i + 1] : undefined;
  return v !== undefined && v !== "" ? v : fallback;
}

/** Whether `--name` is present, in either spelling. */
export function flag(name: string): boolean {
  return ARGV.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

/** `--name` as a number, or `fallback` when absent or unparseable. */
export function num(name: string, fallback: number): number {
  const v = arg(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** `--name` as a comma-separated list, trimmed, empties dropped. */
export function list(name: string, fallback: readonly string[]): string[] {
  const v = arg(name);
  if (v === undefined) return [...fallback];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Everything that is neither a `--flag` nor the value of one. */
export function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < ARGV.length; i++) {
    const a = ARGV[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      if (!a.includes("=")) i++; // its value
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * A BARE POSITIONAL MEANS THE FLAG WAS EATEN — refuse the run.
 *
 * `npm run probe:caption --widths 2560,1920,1280` does NOT pass `--widths`: npm
 * consumes it as its own config and hands the script the bare value
 * `2560,1920,1280`. Every flag then falls back to its default — including
 * `--limit`, which is 10 — and the run LOOKS like the one that was asked for,
 * because the default width list happens to be the same three numbers. That is
 * how a sweep was published off 10 frames: the banner echoed the intended
 * widths and nothing said the limit had been ignored. The separator is what npm
 * needs: `npm run probe:caption -- --widths 2560,1920,1280`.
 *
 * OPT-IN, and it must stay opt-in. Four probes take a legitimate positional —
 * `decimate` takes `.mp4` paths, and `baseline` / `fork` / `routes` / `transfer`
 * take a db path — so calling this from a shared preamble would break them.
 * Only a probe whose entire interface is flags may call it.
 */
export function refuseBarePositionals(exampleRun: string): void {
  const stray = positionals();
  if (stray.length === 0) return;
  console.error(
    `REFUSED: ${stray.map((s) => JSON.stringify(s)).join(", ")} reached this script as a bare\n` +
      "argument, so the flag in front of it was swallowed -- npm eats `--foo bar` after\n" +
      "`npm run`, and EVERY other flag then silently took its default. Repeat the run with\n" +
      `the separator:  ${exampleRun}`,
  );
  process.exit(1);
}
