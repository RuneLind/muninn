/**
 * Wiki provenance — reading the four frontmatter keys a stamped page carries,
 * and shaping them into the payload the reader renders.
 *
 * ```yaml
 * sessions: [claude-code:5a2ee3f0-…, opencode:ses_7f3a9b2c1d]
 * sessions_backfilled: 2026-10-14
 * jira: [MELOSYS-8045]
 * prs: [navikt/melosys-api#1234, RuneLind/muninn#543]
 * ```
 *
 * **muninn never WRITES these keys.** There is exactly one line-upsert
 * implementation and it lives in claude-usage (`src/wiki-stamp.ts`, driven by
 * `scripts/wiki-stamp.ts`); the Claude Code hook and the opencode plugin call it
 * today, and muninn's own Link Jira is to shell out to the same CLI rather than
 * grow a second writer. Two writers of one frontmatter line lose each other's
 * appends, which is the whole reason the interlock in `lockfile.ts` exists.
 *
 * The shape both repos are pinned to is checked in twice — here as
 * `fixtures/wiki-stamp-shape.md`, there as
 * `test/fixtures/wiki-stamp/shape.md` — byte for byte, so a drift on either side
 * fails a test on that side rather than degrading a reader in silence.
 *
 * Everything in this file is PURE. The claude-usage lookup lives in
 * `session-ledger.ts`; the routes are `dashboard/routes/wiki-provenance.ts` and
 * the `provenance` block on `GET /api/wiki/page`.
 */

import type { WikiPageMeta } from "./store.ts";

/** The four frontmatter keys, exactly as they are spelled in a page. */
export const PROVENANCE_FRONTMATTER_KEYS = [
  "sessions",
  "sessions_backfilled",
  "jira",
  "prs",
] as const;

/**
 * The Jira key shape a reverse lookup accepts: one uppercase letter, at least
 * one more prefix character, a hyphen, digits. The SAME shape claude-usage's
 * `/api/jira-sessions` normalizes to, so a key that reaches one service reaches
 * the other. Deliberately NOT `src/jira/verify-keys.ts`'s `KEY_RE`, which is a
 * SCANNER over prose (word-boundary anchored, denylisted for `UTF-8`): this one
 * validates a whole query parameter, where an anchored match is the question and
 * a denylist would refuse a project that happens to be called `SED`.
 */
export const JIRA_KEY_SHAPE = /^[A-Z][A-Z0-9]+-[0-9]+$/;

/** Where a Jira key is read by a human. Same base as the chat card's links
 *  (`chat/views/components/knowledge-links.ts`). */
export const JIRA_BROWSE_BASE = "https://nav.atlassian.net/browse/";

/** Trim + uppercase — the one normalization both the stored value and the query
 *  go through, so `melosys-8045` in a URL matches `MELOSYS-8045` on a page. */
export function normalizeJiraKey(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isJiraKeyShape(key: string): boolean {
  return JIRA_KEY_SHAPE.test(key);
}

export function jiraBrowseUrl(key: string): string {
  return `${JIRA_BROWSE_BASE}${encodeURIComponent(key)}`;
}

/** One `sessions:` entry, split into what the ledger is keyed on and what the
 *  reader shows. */
export interface SessionRef {
  /** The frontmatter value verbatim, `provider:` prefix included. */
  ref: string;
  /** The provider half, or null on a bare id. 4b renders a glyph off it. */
  provider: string | null;
  /** The bare id — the ONLY form claude-usage's `?ids=` accepts. */
  id: string;
}

/**
 * Split `provider:id` into its halves.
 *
 * Split on the FIRST colon only: an opencode id is `ses_7f3a…` today, but
 * nothing promises a provider's ids stay colon-free, and re-joining the tail is
 * what keeps the bare id exact. A value with no colon is a bare id with no
 * provider — the form a hand-written page and an older stamp both produce.
 */
export function parseSessionRef(raw: string): SessionRef {
  const ref = raw.trim();
  const at = ref.indexOf(":");
  if (at <= 0 || at === ref.length - 1) return { ref, provider: null, id: ref };
  return { ref, provider: ref.slice(0, at), id: ref.slice(at + 1) };
}

/** Does a `sessions:` entry name this session? Accepts either form of the
 *  query — `provider:id` or the bare id — so a reader pasting what it copied
 *  from a chip and a caller holding a ledger id both resolve. */
export function sessionRefMatches(entry: string, query: string): boolean {
  const e = parseSessionRef(entry);
  const q = parseSessionRef(query);
  return e.ref === q.ref || e.id === q.id;
}

/** One `prs:` entry: `owner/repo#number`. */
export interface PrRef {
  /** The frontmatter value verbatim. */
  ref: string;
  /** `https://github.com/owner/repo/pull/n`, or null when the value is not a
   *  coordinate we can build one from — a guess is worse than no link. */
  url: string | null;
}

const PR_COORDINATE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([0-9]+)$/;

export function parsePrRef(raw: string): PrRef {
  const ref = raw.trim();
  const m = PR_COORDINATE.exec(ref);
  if (!m) return { ref, url: null };
  return { ref, url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` };
}

/**
 * Jira key → number of pages carrying it, for the listing's Jira facet. The
 * `projectCounts` twin (`dashboard/routes/wiki-routes.ts`) and it answers the
 * same way: a page carrying no key contributes nothing, and a wiki where nothing
 * is stamped yields `{}` — which is how 4b's client knows to render no facet at
 * all rather than one empty control.
 *
 * A page listing one key twice counts ONCE: the facet counts pages, and the
 * count beside a chip must match the number of rows clicking it leaves.
 */
export function jiraCounts(pages: readonly WikiPageMeta[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of pages) {
    if (!p.jira?.length) continue;
    for (const key of new Set(p.jira)) {
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/** Does this page carry any provenance at all? The gate on the page route's
 *  `provenance` block — an unstamped page gets no field, not an empty one. */
export function hasProvenance(meta: WikiPageMeta): boolean {
  return Boolean(meta.sessions?.length || meta.jira?.length || meta.prs?.length);
}

// ── Shaping the answer ───────────────────────────────────────────────────────

/** One session, as the reader renders it. */
export interface ProvenanceSessionChip extends SessionRef {
  title?: string;
  host?: string | null;
  first?: string | null;
  last?: string | null;
  /** USD for the WHOLE session — never this page's share of it. Null when the
   *  ledger priced nothing for it. */
  cost?: number | null;
  messages?: number | null;
  /**
   * The ledger does not hold this id — it was reaped, it belongs to another
   * host, or the ledger was unreachable. A BARE CHIP either way; `ledger` on the
   * payload is what says which, because "this session is gone" and "I could not
   * ask" are opposite conclusions and the chip cannot tell them apart.
   */
  missing: boolean;
  /** Deep link into claude-usage's session drill-down, present only when the
   *  operator set `CLAUDE_USAGE_PUBLIC_URL` on this instance. */
  url?: string;
}

export interface ProvenanceJira {
  key: string;
  /** Where a human reads it. Built from the key, always. */
  url: string;
  /** The issue's own URL as huginn's `jira-issues` corpus holds it, when the
   *  corpus holds the key at all. Absent ⇒ either not in the corpus or the
   *  lookup degraded — the same rule `verifyJiraKeys` states: a down huginn must
   *  not render as "this key is fabricated". */
  huginnUrl?: string;
}

export interface ProvenanceLedgerState {
  reachable: boolean;
  /** `CLAUDE_USAGE_URL` was set on this host. False + unreachable ⇒ this
   *  instance was never meant to price anything. */
  configured: boolean;
  baseUrl: string;
  errors?: string[];
}

export interface ProvenancePayload {
  sessions: ProvenanceSessionChip[];
  jira: ProvenanceJira[];
  prs: PrRef[];
  /** Sum over the sessions the ledger PRICED. Never a per-page share. */
  totalCost: number;
  /** How many sessions that total is over — the denominator, so a reader can
   *  see "2 of 5 priced" rather than trusting a number over an unknown set. */
  costedSessions: number;
  /** `sessions_backfilled` — the list came from a history sweep. */
  backfilled?: string;
  ledger: ProvenanceLedgerState;
}

/** Build the session chips for a list of refs, in the order given. */
export function enrichSessions(
  refs: readonly string[],
  ledger: {
    facts: Map<string, { title?: string | null; host?: string | null; first?: string | null; last?: string | null; cost?: number | null; messages?: number | null }>;
  },
  publicUrl?: string | null,
): ProvenanceSessionChip[] {
  const base = publicUrl?.replace(/\/+$/, "");
  return refs.map((raw) => {
    const ref = parseSessionRef(raw);
    const facts = ledger.facts.get(ref.id);
    // The drill-down is a HASH route (`#/session/<id>`), so the link is built
    // even for an id the ledger does not hold: the page it opens is claude-usage's
    // answer about that id, which is the question a reader clicking it is asking.
    const url = base ? `${base}/#/session/${encodeURIComponent(ref.id)}` : undefined;
    if (!facts) return { ...ref, missing: true, ...(url ? { url } : {}) };
    return {
      ...ref,
      missing: false,
      ...(typeof facts.title === "string" ? { title: facts.title } : {}),
      host: facts.host ?? null,
      first: facts.first ?? null,
      last: facts.last ?? null,
      cost: typeof facts.cost === "number" ? facts.cost : null,
      messages: typeof facts.messages === "number" ? facts.messages : null,
      ...(url ? { url } : {}),
    };
  });
}

/** The money line: the total over the sessions that were actually priced, and
 *  the count that total is over. A `missing` chip contributes neither. */
export function costOfSessions(chips: readonly ProvenanceSessionChip[]): {
  totalCost: number;
  costedSessions: number;
} {
  let totalCost = 0;
  let costedSessions = 0;
  for (const chip of chips) {
    if (chip.missing || typeof chip.cost !== "number") continue;
    totalCost += chip.cost;
    costedSessions += 1;
  }
  return { totalCost, costedSessions };
}

/** Jira rows for a page's keys, with huginn's own issue URL where the corpus
 *  index (`src/jira/verify-keys.ts`) holds one. `corpus` null ⇒ degraded or not
 *  asked; every row then carries the browse URL alone. */
export function jiraRows(
  keys: readonly string[],
  corpus: Map<string, string | undefined> | null,
): ProvenanceJira[] {
  return keys.map((key) => {
    const huginnUrl = corpus?.get(key);
    return { key, url: jiraBrowseUrl(key), ...(huginnUrl ? { huginnUrl } : {}) };
  });
}
