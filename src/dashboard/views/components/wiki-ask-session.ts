/**
 * Pure, side-effect-free (DOM-free) helpers for persisting the /wiki reader's
 * **Ask** session across page reloads via localStorage. Split out of
 * `wiki-browser.ts` (which runs DOM code at module load, so it can't be imported
 * in tests) so the serialize/validate logic can be unit-tested directly — the
 * same split rationale as `wiki-explain.ts`, `wiki-filter.ts`, `wiki-ask-render.ts`.
 *
 * The client stores the last N committed Ask/Explain turns under
 * `wikiAskSession:<wikiName>`; on boot it rehydrates them into the "This session"
 * history list. `html` is kept so a rehydrated turn re-shows byte-identically via
 * the existing history-click path.
 */

/** The full shape of a persisted Ask turn — mirrors `AskTurn` in wiki-browser.ts.
 *  `citations` is kept loose (`unknown[]`) so this module stays free of the
 *  DOM-side `AskCitation` type; the client casts back to `AskTurn[]` on rehydrate. */
export interface StoredAskTurn {
  question: string;
  answer: string;
  citations: unknown[];
  cited: number[];
  html: string | null;
  askedAt: number;
}

/** True when `v` is a well-formed persisted turn. Malformed entries (partial
 *  writes, hand-edited storage, a future schema) are dropped, never trusted. */
function isValidTurn(v: unknown): v is StoredAskTurn {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  if (typeof t.question !== "string") return false;
  if (typeof t.answer !== "string") return false;
  if (!Array.isArray(t.citations)) return false;
  if (!Array.isArray(t.cited) || !t.cited.every((n) => typeof n === "number")) return false;
  if (!(t.html === null || typeof t.html === "string")) return false;
  if (typeof t.askedAt !== "number") return false;
  return true;
}

/** Serialize the last `cap` turns to a JSON string. Never throws on the input
 *  itself (the caller wraps the `localStorage.setItem` in try/catch for quota). */
export function serializeAskSession(turns: StoredAskTurn[], cap: number): string {
  const recent = cap > 0 ? turns.slice(-cap) : [];
  return JSON.stringify(recent);
}

/** Parse + validate a stored session. Malformed JSON, a non-array root, or any
 *  individually malformed turn is dropped — always returns a clean array, never
 *  throws. */
export function deserializeAskSession(json: string | null | undefined): StoredAskTurn[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidTurn);
}
