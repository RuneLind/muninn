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
  /** Turn origin — `"factcheck"` for a fact-check turn (drives the status line;
   *  PR B gates its ➕ button on it). Absent ⇒ a plain Ask/Explain turn. */
  kind?: string;
  /** sha256 of the checked page content at fact-check time (fact-check turns only;
   *  PR B round-trips it). Absent on Ask/Explain turns. */
  baseHash?: string;
  /** The checked page's name — the ➕ "Add to article" append target (fact-check
   *  turns only). Absent on Ask/Explain turns. */
  page?: string;
  /** The checked page's type — the ➕ button gates markdown-only (hidden for
   *  `"explainer"`). Absent on Ask/Explain turns. */
  pageType?: string;
  /** Hostnames consulted during a fact check (WebFetch targets, deduped), shown
   *  as a "Consulting" chip row. Persisted so a rehydrated turn still shows them.
   *  Absent on Ask/Explain turns. */
  toolSources?: string[];
  /** host → first full URL seen for that host during a fact check, feeding the
   *  Consulting chip hrefs. Persisted intentionally (better UX — a rehydrated
   *  chip keeps its real deep-link); a pre-PR turn / malformed field is dropped
   *  and the chip falls back to `https://<host>/`. Absent on Ask/Explain turns. */
  toolSourceUrls?: Record<string, string>;
  /** Claims verified in a fact check (drives the meta line). Absent on Ask/Explain. */
  claimCount?: number;
  /** Per-outcome tally (verified / unverifiable / timeout / skipped / error) for
   *  the honest fact-check meta line. Persisted so a rehydrated turn's breakdown
   *  survives. Absent on Ask/Explain turns (and pre-outcome fact-check turns). */
  claimOutcomes?: {
    verified?: number;
    unverifiable?: number;
    timeout?: number;
    skipped?: number;
    error?: number;
  };
  /** Which write action this fact-check turn already performed — `"append"` (the
   *  ➕ callout) or `"integrate"` (in-place prose edits). Persisted because BOTH
   *  buttons' disabled state is derived from it at render time: either write
   *  stales the turn's `baseHash`, so a DOM-only disable would come back live
   *  after a reload and could only ever 409. Absent ⇒ nothing written yet.
   *  Validated as the two-value union — an unknown value is a dropped turn. */
  wrote?: "append" | "integrate";
  /** Integrate-relevant body length of the checked page (the `done` payload's
   *  `bodyLen`, omitted for explainers). Drives the client's page-too-long gate.
   *  Absent ⇒ render the button and let a server 400 decide. */
  bodyLen?: number;
  /** Per-claim verbatim supporting passages from Phase-1 extraction, keyed by the
   *  claim's 1-based index (NOT list position — a claim whose extraction carried
   *  no quote is simply absent). Persisted because they arrive on the transient
   *  `claims` SSE event, which is dropped at `done`; the integrate propose POST
   *  re-sends them, so a rehydrated turn must still carry them. */
  claimQuotes?: { index: number; quote: string }[];
  /** Whether the checked page can carry inline `<Fact>` annotations (server-derived
   *  `.mdx`-ness of the resolved path). Absent on a pre-field turn / an older
   *  server ⇒ treat as not annotatable. */
  annotatable?: boolean;
  /** The retrieval DECLINE that ended this turn — the wiki had nothing worth
   *  synthesizing from (`no_hits`) or only weak nearest-neighbours
   *  (`low_confidence`). Persisted because the decline hook (an "Ask in chat
   *  instead →" action rendered in place of the ordinary escalate bar) is derived
   *  from TURN state at render time, while the flags themselves arrive once on the
   *  transient `done` SSE event: without this a rehydrated — or merely re-shown —
   *  declined turn would silently get the ordinary bar back. Absent ⇒ the turn was
   *  answered (or is a fact-check turn, which has no retrieval at all).
   *  Validated as the two-value union: an unknown value falls through both render
   *  branches, which is the same silent-wrong-bar bug in a different disguise. */
  declined?: "no_hits" | "low_confidence";
}

/**
 * Map an Ask/Explain `done` payload's decline flags onto {@link StoredAskTurn.declined}.
 *
 * **`lowConfidence` is checked FIRST and that order is load-bearing.** The server
 * sets `noHits: true` unconditionally on BOTH decline branches (`src/research/ask.ts`
 * — it means "no answer was synthesized", not "zero documents came back") and
 * distinguishes them only by `lowConfidence`. The natural-reading
 * `noHits ? "no_hits" : …` therefore mislabels EVERY low-confidence decline, which
 * is the one the reader most needs named honestly: weak sources did ride out and
 * are listed under the answer. The status line above the bar has always branched
 * this way; this keeps the two derivations from drifting apart.
 */
export function askDeclineReason(payload: {
  noHits?: unknown;
  lowConfidence?: unknown;
}): "no_hits" | "low_confidence" | undefined {
  if (payload.lowConfidence) return "low_confidence";
  if (payload.noHits) return "no_hits";
  return undefined;
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
  // Optional fields — reject only a present-but-wrong-typed value.
  if (typeof t.kind !== "undefined" && typeof t.kind !== "string") return false;
  if (typeof t.baseHash !== "undefined" && typeof t.baseHash !== "string") return false;
  if (typeof t.page !== "undefined" && typeof t.page !== "string") return false;
  if (typeof t.pageType !== "undefined" && typeof t.pageType !== "string") return false;
  if (
    typeof t.toolSources !== "undefined" &&
    !(Array.isArray(t.toolSources) && t.toolSources.every((s) => typeof s === "string"))
  ) {
    return false;
  }
  // A malformed toolSourceUrls (not a plain object of string values) is DROPPED
  // — the turn is kept, the field removed, so a rehydrated chip falls back to
  // `https://<host>/`. A well-formed map is left intact.
  if (typeof t.toolSourceUrls !== "undefined") {
    if (!isValidUrlMap(t.toolSourceUrls)) delete t.toolSourceUrls;
  }
  // `wrote` is a two-value union, and BOTH values gate a write button. An unknown
  // string would fall through every branch and silently re-enable both actions
  // against a baseHash the real write already staled — so validate the union, not
  // just the type.
  if (typeof t.wrote !== "undefined" && t.wrote !== "append" && t.wrote !== "integrate") return false;
  if (typeof t.bodyLen !== "undefined" && typeof t.bodyLen !== "number") return false;
  // `annotatable` is a purely ADVISORY hint (does this page take inline `<Fact>`
  // wrappers), and its absence already means "not annotatable" — so a malformed
  // value is dropped like `toolSourceUrls`, not fatal like the `bodyLen` scalar
  // beside it. The deviation from that precedent is deliberate: `bodyLen` gates a
  // budget the server enforces, whereas a missing `annotatable` degrades to exactly
  // the pre-field behaviour and throwing away a whole fact-check answer over a hint
  // costs the user far more than it protects.
  if (typeof t.annotatable !== "undefined" && typeof t.annotatable !== "boolean") {
    delete t.annotatable;
  }
  // A malformed quote list is DROPPED (the turn survives), the `toolSourceUrls`
  // precedent: absent quotes degrade to exactly the pre-PR behaviour, whereas
  // rejecting the turn would throw away a whole fact-check answer. All-or-nothing
  // per field — a half-trusted list is never kept.
  if (typeof t.claimQuotes !== "undefined" && !isValidClaimQuotes(t.claimQuotes)) {
    delete t.claimQuotes;
  }
  // `declined` is a two-value union that SELECTS which bar the turn renders, so an
  // unknown value would silently restore the ordinary escalate bar on a turn the
  // wiki actually declined — the exact failure this field exists to prevent. Same
  // reject-the-turn treatment as `wrote`, not the drop-the-field treatment given to
  // advisory hints.
  if (typeof t.declined !== "undefined" && t.declined !== "no_hits" && t.declined !== "low_confidence") {
    return false;
  }
  if (typeof t.claimCount !== "undefined" && typeof t.claimCount !== "number") return false;
  if (typeof t.claimOutcomes !== "undefined" && !isValidOutcomeCounts(t.claimOutcomes)) return false;
  return true;
}

/** A well-formed per-outcome tally: an object whose known count fields, when
 *  present, are numbers. Unknown keys are ignored (forward-tolerant). */
function isValidOutcomeCounts(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  for (const k of ["verified", "unverifiable", "timeout", "skipped", "error"]) {
    if (typeof o[k] !== "undefined" && typeof o[k] !== "number") return false;
  }
  return true;
}

/**
 * A well-formed claim-quote list: an array whose every entry is `{index, quote}`
 * with a **positive safe integer** index and a **non-blank** quote.
 *
 * Held at parity with the server's `validateClaimQuotes`: a bare `typeof === number`
 * accepted `-1`, `1.5` and `1e21` (none of which can name a `Claim n/m` heading) and
 * a bare `typeof === string` accepted `""` — all of which the propose route rejects.
 * Since a single bad entry drops the whole field here, keeping them meant persisting
 * a payload the server would throw away on the next propose. `isSafeInteger` rather
 * than `isInteger` because `1e21` passes the latter.
 */
function isValidClaimQuotes(v: unknown): v is { index: number; quote: string }[] {
  if (!Array.isArray(v)) return false;
  return v.every((q) => {
    if (!q || typeof q !== "object") return false;
    const o = q as Record<string, unknown>;
    if (typeof o.index !== "number" || !Number.isSafeInteger(o.index) || o.index <= 0) return false;
    return typeof o.quote === "string" && o.quote.trim().length > 0;
  });
}

/** A well-formed host→url map: a plain object whose every value is a string.
 *  Anything else (array, null, non-string value) is malformed ⇒ the field is
 *  dropped by {@link isValidTurn} (never trusted, but the turn survives). */
function isValidUrlMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((s) => typeof s === "string");
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
