/**
 * A URL reduced to the coarsest thing that still names a state.
 *
 * The grain is the SITE, not the page and not the tab. The repo already decided
 * a task should work on any document — that is why `Window` is absent from
 * `STABLE_ROLES` — and the web analogue is that it should work on any pull
 * request. A full URL is too strict for exactly the reason a filename was; a
 * bare host is too coarse, because two repositories are genuinely different
 * states.
 *
 * Pure: no I/O, no clock.
 */

/**
 * Segments naming an instance rather than a kind of page.
 *
 * The opaque-key pattern requires a DIGIT, which is not cosmetic: an earlier
 * draft used `/^[A-Za-z0-9_-]{16,}$/` and would have eaten a real repository
 * name like `my-very-long-repo-name`, silently merging two unrelated projects
 * into one state. Generated keys carry digits; hyphenated words do not.
 */
const ID_PATTERNS: readonly RegExp[] = [
  /^\d+$/, //                            27, 12345 — an issue or PR number
  /^[0-9a-f]{8,}$/i, //                  a commit sha
  /^[0-9a-f]{8}-[0-9a-f-]{8,}$/i, //     a UUID
  /^(?=.*\d)[A-Za-z0-9_-]{16,}$/, //     an opaque document key
];

/**
 * Enough to separate `github.com/owner/repo/pull` from `.../issues` while
 * refusing to let a deep path become a unique identity. Measured against live
 * URLs: MDN's `/en-US/docs/Web/API/Fetch_API/Using_Fetch` reduces to
 * `/en-US/docs/Web`, which is the intended grain — one documentation area is
 * one state, not one page per method.
 */
const MAX_SEGMENTS = 3;

const isIdLike = (segment: string): boolean => ID_PATTERNS.some((re) => re.test(segment));

/** `undefined` when the URL names no site, which is not a failure. */
export function urlPrefix(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  // `file:`, `chrome:`, `about:` name no site, so they carry no web scope.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  const host = parsed.hostname.replace(/^www\./, "");
  if (host.length === 0) return undefined;

  // Query and fragment are dropped by reading `pathname` alone: a tab parameter
  // or a scroll anchor is session state, the same class as a badge count.
  const segments = parsed.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map(decodeSegment)
    .filter((s) => !isIdLike(s))
    .slice(0, MAX_SEGMENTS);

  return [host, ...segments].join("/");
}

/**
 * Percent-decoded so `%2D` and `-` cannot produce two identities for one page.
 * A segment that will not decode is used verbatim rather than dropped — it is
 * still a real distinction, just an ugly one.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
