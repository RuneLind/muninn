/**
 * SESSION REFS — the pure helpers every reader of a page's `sessions:` line
 * shares: the id shape the ledger accepts, the per-page dedup, and the bare id a
 * `provider:id` ref stands for.
 *
 * A LEAF on purpose. It imports only `provenance.ts` (`parseSessionRef`), which
 * is browser-safe, so `strength.ts` (Related work and the find palette's near
 * map) can read sessions without pulling `session-ledger.ts`'s logging and
 * fetch code, and without the cycle a home in `provenance.ts` would make
 * (`session-ledger.ts` imports `provenance.ts`). `session-ledger.ts` and
 * `provenance-service.ts` re-export what they used to declare, so their
 * importers are unchanged.
 */

import { parseSessionRef } from "./provenance.ts";
import type { WikiPageMeta } from "./store.ts";

/**
 * The longest session id muninn will ask about. A longer value on a page cannot
 * BE a session id, and sending it is how ONE malformed frontmatter entry takes
 * out the whole batch it rides in (a 431 has no body naming the offender).
 *
 * 128 because that is the cap the WRITER enforces: claude-usage's `wiki-stamp`
 * only ever stamps a ref matching `SESSION_REF_RE`
 * (`/^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,128}$/`, `src/wiki-stamp.ts:47`), so no
 * id that pipeline put on a page can exceed it. It is NOT a storage limit —
 * every `session_id` column in claude-usage's sqlite schema (`src/store.ts`) is
 * a bare `TEXT`, which sqlite does not bound — so a longer value is refused
 * here as frontmatter damage, not because the ledger could not hold it.
 */
export const SESSION_ID_MAX_CHARS = 128;

/**
 * The characters a session id is made of, across every provider that stamps
 * one: Claude Code uuids, opencode's `ses_…`, and anything else built from the
 * same alphabet. Anything outside it — a space, a slash, a `%` — is frontmatter
 * damage rather than an id, and refusing it here is what keeps a query string
 * from carrying something that is not one.
 */
export const SESSION_ID_SHAPE = /^[A-Za-z0-9._-]+$/;

/** Is this a value claude-usage could hold at all? */
export function isSessionIdShape(id: string): boolean {
  return id.length > 0 && id.length <= SESSION_ID_MAX_CHARS && SESSION_ID_SHAPE.test(id);
}

/**
 * First-wins dedup on the bare id, preserving the page's own order — with ONE
 * exception: a PREFIXED spelling replaces a bare one already kept.
 *
 * The reverse lookup puts the reader's query at the head of the list, and a
 * reader pastes the bare id as often as the prefixed one. Plain first-wins then
 * threw away the `provider:` the matched page carried, so the answer's own chip
 * for the session asked about was the one chip with no provider glyph. The
 * position is kept (the query still leads); only the spelling is upgraded.
 */
export function dedupeSessionRefs(refs: readonly string[]): string[] {
  const at = new Map<string, number>();
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const id = bareId(ref);
    const seen = at.get(id);
    if (seen === undefined) {
      at.set(id, out.length);
      out.push(ref);
      continue;
    }
    // A prefixed spelling is strictly more informative than a bare one; two
    // prefixed spellings of one id keep the first (the page's own order).
    if (out[seen] === id && ref !== id) out[seen] = ref;
  }
  return out;
}

/** The bare id a stamped ref stands for: `claude-code:<uuid>` and `<uuid>` are
 *  one session. The one spelling of that rule, built on `parseSessionRef`. */
export function bareId(ref: string): string {
  return parseSessionRef(ref).id;
}

/** A page's stamped session refs that can be session ids at all — deduplicated
 *  per page ({@link dedupeSessionRefs}) and shape-checked
 *  ({@link isSessionIdShape}), in the page's own order. */
export function stampedSessionRefs(page: Pick<WikiPageMeta, "sessions">): string[] {
  return dedupeSessionRefs(page.sessions ?? []).filter((ref) => isSessionIdShape(bareId(ref)));
}
