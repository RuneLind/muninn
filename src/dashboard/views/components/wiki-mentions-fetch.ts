/// <reference lib="dom" />
/**
 * `GET /api/wiki/mentions` from the reader, cached per wiki and key: the
 * selection menu's «Where else» and «History», the key peek and the Trace
 * view (Discuss v2 PRs 5 and 6) share one cache, so hovering a key and then
 * opening its Trace is one request. An answer is reused for
 * {@link MENTIONS_FRESH_MS} at most, never a failure nor one with a PR row
 * still being refreshed, and a page render drops them all
 * ({@link clearMentionsCache}).
 */

import type { MentionsBody } from "../../../wiki/mentions.ts";

const MENTIONS_PATH = "/api/wiki/mentions";
/** How long a mentions answer is reused: «Where else» then «History» on one
 *  key is one request, and a commit made elsewhere shows within this. */
export const MENTIONS_FRESH_MS = 30_000;

export type MentionsAnswer = { ok: true; body: MentionsBody } | { ok: false; message: string };

/** `at` null while the request is in flight (asks share it), else when it answered. */
const cache = new Map<string, { p: Promise<MentionsAnswer>; at: number | null }>();

export function clearMentionsCache(): void {
  cache.clear();
}

export function fetchMentions(wiki: string, key: string): Promise<MentionsAnswer> {
  const k = `${wiki}\n${key}`;
  const hit = cache.get(k);
  if (hit && (hit.at === null || Date.now() - hit.at < MENTIONS_FRESH_MS)) return hit.p;
  const p = (async (): Promise<MentionsAnswer> => {
    try {
      const res = await fetch(`${MENTIONS_PATH}?${new URLSearchParams({ wiki, key }).toString()}`, { headers: { Accept: "application/json" } });
      const data = (await res.json().catch(() => null)) as (MentionsBody & { error?: string }) | null;
      if (res.ok && data && Array.isArray(data.files)) return { ok: true as const, body: data };
      return { ok: false as const, message: data?.error ? `The search failed: ${data.error} (${res.status}).` : `The search failed (${res.status}).` };
    } catch {
      return { ok: false as const, message: "The search failed: the server did not answer." };
    }
  })();
  const entry: { p: Promise<MentionsAnswer>; at: number | null } = { p, at: null };
  cache.set(k, entry);
  // Neither a failure nor a PR row the route is still refreshing is kept: the next ask asks again.
  void p.then((r) => {
    if (cache.get(k) !== entry) return;
    if (r.ok && !r.body.prs.some((pr) => pr.stale)) entry.at = Date.now();
    else cache.delete(k);
  });
  return p;
}
