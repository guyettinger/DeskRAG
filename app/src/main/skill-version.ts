/**
 * A skill's version, and the short record of what moved it.
 *
 * A kept skill is not a snapshot: a re-index can change the steps under it, a
 * regenerate rewrites its prose, and a re-bind points it at a different route.
 * Without a version those all happen silently, and an agent that read the file
 * last week has no way to notice it is now describing something else.
 *
 * ## Why the patch position is the only one that moves
 *
 * Semantic versioning promises that the other two positions MEAN something —
 * that a major bump is a breaking change. Nothing here computes that, and
 * nothing could: whether re-bound steps break a caller is a judgement about a
 * procedure, not a diff. Moving only the patch keeps the shape familiar without
 * claiming a distinction the code cannot make. `0.1.x` says "this moved, N
 * times", which is exactly what is known.
 *
 * ## It lives in the `doc` JSON, never in a column
 *
 * `schema.ts` is `CREATE TABLE IF NOT EXISTS` with no migration step, so a new
 * column would never reach an existing install. That is the stated reason the
 * `doc` column is opaque JSON, and it is why every function here treats a
 * MISSING version as ordinary rather than as corruption.
 */

/** Where a skill starts the moment it is kept. */
export const INITIAL_VERSION = "0.1.0";

/**
 * How many revisions are kept.
 *
 * Bounded because this list sits inside a JSON column that nothing prunes: a
 * library re-indexed weekly would append a revision every time the steps moved,
 * forever. The oldest go first — the recent ones are what explain the file you
 * are holding.
 */
export const MAX_HISTORY = 20;

export interface SkillRevision {
  /** Wall-clock ms. A skill is authored, so this is when a PERSON changed it. */
  at: number;
  /** The version this change produced. */
  version: string;
  /** One clause, in the words a reader needs. */
  what: string;
}

const PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The next version and history, given what changed.
 *
 * Pure, and returns new arrays: it is called from read-modify-write paths that
 * also hand the same doc to `refreshSnapshot`, and one of them mutating the
 * other's input is exactly the kind of order dependence that survives a test.
 */
export function bumpVersion(
  version: string | undefined,
  history: readonly SkillRevision[] | undefined,
  what: string,
  at: number,
): { version: string; history: SkillRevision[] } {
  const m = PATTERN.exec(version ?? "");
  // A version this cannot parse restarts the count rather than throwing. The
  // column is opaque JSON that older builds and hand edits both reach, and
  // refusing to render a skill because its version is odd is worse than
  // counting again — the history still says what happened.
  const next =
    m === null ? "0.1.1" : `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  const entry: SkillRevision = { at, version: next, what };
  const all = [...(history ?? []), entry];
  return { version: next, history: all.slice(-MAX_HISTORY) };
}
