/**
 * Talking to the local Ollama daemon — host resolution, JSON POSTs, and model
 * listing. The one place any adapter learns where Ollama lives.
 *
 * Barrel-safe: plain `fetch`, no native module, no subprocess.
 *
 * What is deliberately NOT here: failure policy. `OllamaTextEmbedding.embed`
 * THROWS on a bad response (a missing embedding is a missing vector, and
 * silently writing nothing would leave a row the reconciler cannot distinguish
 * from a crash), while `OllamaCaptionProvider.caption` returns "" (one view
 * lacking a caption is recoverable later by reconcileAndReembed). This module
 * raises; each adapter decides what that means.
 */

/** Where the daemon lives. Explicit > OLLAMA_HOST > the documented default. */
export function resolveOllamaHost(host?: string): string {
  return host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
}

/**
 * POST JSON, parse JSON. Throws on a transport failure, a non-2xx, or a body
 * that is not JSON — the caller catches if its contract says to degrade.
 */
export async function postJson<T>(
  host: string,
  path: string,
  body: unknown,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<T> {
  const res = await fetchImpl(`${host}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface TagsResponse {
  models?: { name?: string; capabilities?: string[] }[];
}

/**
 * Models resident on THIS machine, optionally filtered by capability.
 *
 * Sourced from /api/tags rather than a hardcoded list, and that is a structural
 * privacy guard rather than a convenience: Ollama's LIBRARY now includes
 * cloud-hosted models (gemini-3-flash-preview, the kimi-k2 family), and offering
 * one in a "local" settings dropdown would route screenshots off the machine
 * invisibly. /api/tags returns only what is pulled to disk, so a cloud model
 * cannot appear here no matter how careless the caller is.
 *
 * Returns [] rather than throwing: an unreachable daemon means "no models
 * available", which is exactly what a picker should render.
 */
export async function listModels(
  host: string,
  opts: { capability?: string } = {},
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${host}/api/tags`);
    if (!res.ok) return [];
    const json = (await res.json()) as TagsResponse;
    return (json.models ?? [])
      .filter(
        (m) =>
          opts.capability === undefined ||
          (Array.isArray(m.capabilities) && m.capabilities.includes(opts.capability)),
      )
      .map((m) => m.name ?? "")
      .filter((n) => n.length > 0);
  } catch {
    return [];
  }
}
