/**
 * The first JSON object in a model's reply.
 *
 * `format: "json"` is a request, not a guarantee: models still wrap a reply in a
 * fence, a sentence, or a thinking channel. This digs the object out, and it is
 * shared rather than copied because two adapters brace-matching independently is
 * the `ax-dump`/`ax-exec` drift hazard in miniature — one of them gains a fix
 * and the other keeps the bug, and both look fine against small fixtures.
 *
 * Brace-matching forward from the first `{` rather than a regex or a
 * first/last-brace slice, so a nested object does not truncate the scan and a
 * trailing sentence containing a `}` does not extend it. String literals are
 * tracked, with escapes, so a brace inside a quoted value counts for nothing.
 *
 * (`parseComposeResponse` deliberately keeps its own first/last-brace slice: its
 * reply is one object with one array and it has its own wholesale rejection
 * downstream. Unifying the two is a separate change with its own measurement.)
 */

/** Anything at all, as long as it is a JSON object. */
export type JsonObject = Record<string, unknown>;

export function firstJsonObject(text: string): JsonObject | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return undefined;
          }
          return parsed as JsonObject;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
