/**
 * Reading another service's HTTP response without trusting its size.
 *
 * Muninn proxies two claude-usage endpoints server-side (`/api/pipeline` for the
 * `/models` Pipeline ledger card, `/api/plans` for the `/plans` board) and will
 * likely proxy more. Both bounds below — and the read loop that enforces the
 * byte one — live here rather than in either caller, because two copies of a
 * byte cap drift and one does not.
 *
 * The bounds are sized against the widest legal claude-usage query, measured
 * 2026-08-13 against the live service: 640 KB in ~0.2 s for `?days=90`. The
 * time budget is deliberate slack for a cold ledger on a loaded mini, not a
 * tight fit; the byte cap is two orders of magnitude above that worst case and
 * far below the 145 MB sqlite behind those endpoints — the point being that a
 * wrong service on the port cannot stream the dashboard out of memory.
 */

/** Wall-clock budget for one proxied read, including connect. */
export const BOUNDED_FETCH_TIMEOUT_MS = 10_000;
/** Hard body cap for one proxied read. */
export const BOUNDED_FETCH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read a response body without buffering more than `maxBytes`. The declared
 * `content-length` is the cheap check; the read loop is the guarantee, because a
 * chunked response declares no length at all.
 *
 * Every failure names `url`: the operator's first question about a degraded card
 * is whether it was pointed at the right host, and "fetch failed" cannot answer
 * it.
 */
export async function readBounded(res: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `response body is ${declared} bytes, over the ${maxBytes}-byte cap (${url})`,
    );
  }
  const body = res.body;
  if (!body) return await res.text(); // no stream to bound (empty body)
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response body exceeded the ${maxBytes}-byte cap (${url})`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releases the socket on the over-cap path; a no-op once the stream is done.
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}
