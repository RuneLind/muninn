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
 * `src/wiki/__fixtures__/wiki-stamp-shape.md`, there as
 * `test/fixtures/wiki-stamp/shape.md` — byte for byte. **Each side pins its own
 * copy**: this repo's suite asserts the keys it reads, claude-usage's asserts the
 * keys it writes. Neither assertion can see the other file, so the two are
 * compared by hand — plus one opportunistic test here that diffs them when a
 * claude-usage checkout happens to sit at `../claude-usage` and SKIPS otherwise
 * (a machine without the sibling repo must not go red over a file it does not
 * have).
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
 * The Jira key shape a reverse lookup accepts: an uppercase letter, any further
 * prefix characters, a hyphen, digits. Byte for byte the regex claude-usage's
 * `/api/jira-sessions` validates with (`src/routes.ts`, `jiraKey`), so a key that
 * reaches one service reaches the other — the `*` is load-bearing: upstream
 * accepts a ONE-character project prefix, and requiring two here made `X-1` a
 * 400 on the muninn side of a key the stamper had happily written.
 *
 * Deliberately NOT `src/jira/verify-keys.ts`'s `KEY_RE`, which is a SCANNER over
 * prose (word-boundary anchored, denylisted for `UTF-8`): this one validates a
 * whole query parameter, where an anchored match is the question and a denylist
 * would refuse a project that happens to be called `SED`.
 */
export const JIRA_KEY_SHAPE = /^[A-Z][A-Z0-9]*-[0-9]+$/;

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
 *
 * **Only KEY-SHAPED values become chips.** The store keeps whatever the page
 * declared (a typo is worth seeing), but the reverse lookup REFUSES a value that
 * is not a key with a 400 — so an unfiltered facet renders a chip whose only
 * behaviour is to fail when clicked. The page's own row still carries the raw
 * value; the facet is the one surface that promises a working click.
 */
export function jiraCounts(pages: readonly WikiPageMeta[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of pages) {
    if (!p.jira?.length) continue;
    for (const key of new Set(p.jira)) {
      if (!isJiraKeyShape(key)) continue;
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

/**
 * One session, as the reader renders it.
 *
 * **Every chip carries the SAME key set**, with an explicit `null` where a fact
 * is unknown, rather than a priced chip carrying six fields and a bare one
 * carrying two. A client that indexes `chip.cost` gets `null` on a bare chip
 * instead of `undefined`, and a JSON reader can see at a glance that the answer
 * is "unknown", not "this key was forgotten".
 *
 * A chip is BARE — no money, no title — for three distinguishable reasons, and
 * exactly one of the three flags is set (see {@link bareChipReason}).
 */
export interface ProvenanceSessionChip extends SessionRef {
  title: string | null;
  host: string | null;
  first: string | null;
  last: string | null;
  /** USD for the WHOLE session — never this page's share of it. Null when the
   *  ledger priced nothing for it. */
  cost: number | null;
  messages: number | null;
  /**
   * The ledger ANSWERED and does not hold this id — it was reaped, or it belongs
   * to another host. A conclusion about the session, so it is set only when the
   * batch carrying this id came back.
   */
  missing: boolean;
  /**
   * Nobody ever asked about this id — the batch carrying it FAILED, or this host
   * is not pointed at a claude-usage at all. The opposite conclusion from
   * `missing`, which is why it is a separate flag: a partial outage rendering as
   * "these sessions were reaped" tells the reader something that is not true,
   * and the under-reported `totalCost` beside it looks like a fact.
   */
  unresolved: boolean;
  /**
   * The value on the page cannot BE a session id (too long, or characters
   * outside claude-usage's `[A-Za-z0-9._-]{1,128}`), so it was refused before
   * batching — one malformed frontmatter entry must not 431 the batch it rides
   * in. Frontmatter damage, reported rather than hidden.
   */
  invalid: boolean;
  /** Deep link into claude-usage's session drill-down, present only when the
   *  operator set `CLAUDE_USAGE_PUBLIC_URL` on this instance. */
  url?: string;
}

/** Which of the three bare reasons applies, or null for a priced chip. The one
 *  place the precedence between the flags is decided. */
export function bareChipReason(
  chip: ProvenanceSessionChip,
): "invalid" | "unresolved" | "missing" | null {
  if (chip.invalid) return "invalid";
  if (chip.unresolved) return "unresolved";
  if (chip.missing) return "missing";
  return null;
}

export interface ProvenanceJira {
  key: string;
  /** Where a human reads it. Built from the key, always. */
  url: string;
  /**
   * huginn's `jira-issues` corpus holds this key.
   *
   * A BOOLEAN rather than the corpus's own URL: measured over the live corpus,
   * every url `loadJiraKeyIndex` returns for a key is the same
   * `…/browse/<KEY>` this row already built from the key itself, so a second
   * field carried a duplicate string and invited a reader to render two links to
   * one page. What the corpus actually adds is the one fact the key cannot
   * supply — whether huginn has heard of this issue.
   *
   * Absent (not `false`) when the corpus was not asked or the lookup degraded:
   * the same rule `verifyJiraKeys` states, that a down huginn must not render as
   * "this key is fabricated".
   */
  huginnKnown?: boolean;
}

export interface ProvenanceLedgerState {
  /**
   * The ledger was ASKED — this page named at least one session AND this host is
   * pointed at a claude-usage. The third state the first cut did not have: a
   * `jira`-only page, or a `?jira=` matching pages nobody stamped a session on,
   * reported `reachable: false` about a call that never happened, which reads as
   * "claude-usage is down" on a page that simply has no sessions.
   *
   * **`reachable`, `partial` and `errors` are meaningful only when this is
   * true.** Unasked, they are all their empty values.
   */
  asked: boolean;
  /** At least one batch answered. */
  reachable: boolean;
  /** Some batch answered and some did not, so `totalCost` is over a SUBSET of
   *  the page's sessions and the unanswered ones are `unresolved` chips. */
  partial: boolean;
  /** `CLAUDE_USAGE_URL` was set on this host. False ⇒ this instance was never
   *  meant to price anything, and nothing was fetched. */
  configured: boolean;
  /** The base URL that was (or would be) read. Absent when unconfigured: naming
   *  a default endpoint nobody pointed this host at invites an operator to go
   *  and check a service that was never meant to run here. */
  baseUrl?: string;
  /** Upstream cut a batch at its own id cap. Should not happen — muninn pages at
   *  the same cap — so it is carried rather than assumed away. */
  truncated?: boolean;
  errors?: string[];
}

/**
 * The ledger state for a host that was never pointed at claude-usage: one
 * spelling, so the callers cannot disagree.
 *
 * FROZEN, because it is handed out by REFERENCE — it rides straight onto an
 * answer payload, and every unconfigured host's every page open gets the same
 * object. One caller adding a field to "its" copy would have added it to every
 * answer this process has already returned and every one it returns next.
 */
export const LEDGER_NOT_ASKED: ProvenanceLedgerState = Object.freeze({
  asked: false,
  reachable: false,
  partial: false,
  configured: false,
});

/**
 * One PR a stamped session merged, as claude-usage's `/api/merges` reports it.
 *
 * Carried VERBATIM from the route rather than reshaped: every field here is one
 * the reader renders, and the two that look redundant are not.
 *
 *  - `repo` is a CHECKOUT PATH on this corpus (`/Users/rune/source/private/…`),
 *    not a GitHub coordinate. It is the hover on an unlinked row and nothing
 *    else — turning it into an `owner/repo` is the guess upstream's `planPrUrl`
 *    refuses to make, because most of the corpus's path-shaped repo keys name
 *    directories that no longer exist.
 *  - `url` is the coordinate, resolved upstream through its own `repoUrls` map,
 *    and **null is a normal answer** for a repo that map does not name.
 *
 * `subject` is null on every merge measured (the confirm side is what carries
 * one), so the row renders without it; the field rides along because it is the
 * ledger's own shape and dropping it here would make a later reader re-fetch.
 */
export interface ProvenanceMerge {
  /** The stamped session that merged it — the join back onto a chip. */
  sessionId: string;
  /** The ledger's repo key. A checkout path, not a coordinate. */
  repo: string;
  /** Null for a bare `gh pr merge` with no PR number in the event. */
  prNumber: number | null;
  /** `https://github.com/owner/repo/pull/n`, or null — never guessed. */
  url: string | null;
  subject: string | null;
  mergedAt: string | null;
  /**
   * The merge command's own result said it merged.
   *
   * FALSE IS NOT "did not merge": measured 20 of 179 rows false on 2026-09-16,
   * of which 11 were squash messages composed for a UI merge and 9 were a
   * `gh pr merge` whose result was never paired — so a row is qualified, never
   * dropped. Dropping them would hide the NAV flow's merges entirely.
   */
  mergeOk: boolean;
}

/**
 * Whether the merges leg ran and what it got — deliberately NOT folded into
 * `ProvenanceLedgerState`.
 *
 * The two legs hit the same service and fail independently, and the one thing
 * the reader must be able to tell apart is "this page has no merges" from "the
 * merges call did not answer". A shared `reachable` would have made the second
 * unsayable, and would also have pushed the cost sentence — which is about the
 * FACTS leg alone — into a state the money it reports never came from.
 */
export interface ProvenanceMergesState {
  /** A request was SENT: the page names a session, this host is pointed at a
   *  claude-usage, and at least one id survived the shape gate. */
  asked: boolean;
  /** At least one batch answered with a readable payload. */
  reachable: boolean;
  /**
   * Some batches answered and some did not — `merges` is a SUBSET and the
   * reader is told so.
   *
   * The facts leg has carried this third state since #549 and the merges leg
   * shipped without it: with `reachable` alone, a page naming 250 sessions whose
   * second batch fails renders its one surviving merge under a silent footer.
   */
  partial: boolean;
  /** Upstream cut the list at its own cap, so `merges` is a SUBSET. */
  truncated: boolean;
  /** The cap upstream reported with `truncated` — its number, never one of
   *  ours. Absent when the leg never reported one. */
  limit?: number;
  /** Why a batch failed, one entry per failed batch — the same field, and the
   *  same purpose, the facts leg's state carries. */
  errors?: string[];
}

/** The merges state for a leg that never ran. Frozen for `LEDGER_NOT_ASKED`'s
 *  reason: it is handed out by reference on every unasked page open. */
export const MERGES_NOT_ASKED: ProvenanceMergesState = Object.freeze({
  asked: false,
  reachable: false,
  partial: false,
  truncated: false,
});

export interface ProvenancePayload {
  sessions: ProvenanceSessionChip[];
  jira: ProvenanceJira[];
  prs: PrRef[];
  /** The PRs the page's sessions merged, in the ledger's own order. Empty when
   *  the leg was not asked or did not answer — `mergesLedger` says which. */
  merges: ProvenanceMerge[];
  /** Sum over the sessions the ledger PRICED. Never a per-page share. */
  totalCost: number;
  /** How many sessions that total is over — the denominator, so a reader can
   *  see "2 of 5 priced" rather than trusting a number over an unknown set. */
  costedSessions: number;
  /** `sessions_backfilled` — the list came from a history sweep. */
  backfilled?: string;
  ledger: ProvenanceLedgerState;
  /** The merges leg's own state. See {@link ProvenanceMergesState}. */
  mergesLedger: ProvenanceMergesState;
}

/** What `enrichSessions` needs of a ledger answer — the narrowest shape, so the
 *  pure layer does not import the client. */
export interface LedgerFactsView {
  facts: Map<
    string,
    {
      title?: string | null;
      provider?: string | null;
      host?: string | null;
      first?: string | null;
      last?: string | null;
      cost?: number | null;
      messages?: number | null;
    }
  >;
  /** Ids whose batch never answered. */
  unresolved?: ReadonlySet<string>;
  /** Ids refused before batching. */
  invalid?: ReadonlySet<string>;
}

/** Build the session chips for a list of refs, in the order given. */
export function enrichSessions(
  refs: readonly string[],
  ledger: LedgerFactsView,
  publicUrl?: string | null,
): ProvenanceSessionChip[] {
  const base = publicUrl?.replace(/\/+$/, "");
  return refs.map((raw) => {
    const ref = parseSessionRef(raw);
    const facts = ledger.facts.get(ref.id);
    // The drill-down is a HASH route (`#/session/<id>`), so the SERVER builds it
    // for every id, held or not; the CLIENT decides per chip whether to render
    // it (`chipView`, `dashboard/views/components/wiki-provenance-view.ts`, which
    // suppresses it on every BARE chip — for `missing`/`invalid` the link is a
    // dead end by construction). Building it here regardless keeps that a
    // rendering decision rather than one baked into the payload.
    const url = base ? `${base}/#/session/${encodeURIComponent(ref.id)}` : undefined;
    const invalid = ledger.invalid?.has(ref.id) ?? false;
    const unresolved = !invalid && (ledger.unresolved?.has(ref.id) ?? false);
    if (!facts) {
      return {
        ...ref,
        title: null,
        host: null,
        first: null,
        last: null,
        cost: null,
        messages: null,
        // A bare chip is `missing` only when the ledger actually answered about
        // it. `invalid` and `unresolved` are the two ways it never did.
        missing: !invalid && !unresolved,
        unresolved,
        invalid,
        ...(url ? { url } : {}),
      };
    }
    return {
      ...ref,
      // A BARE ref takes the ledger's own provider — the ledger knows which tool
      // recorded the session, the page only knows what the stamper wrote, and an
      // older stamp (or a hand-written line) carries no prefix at all. A ref that
      // DOES name a provider keeps its own: that spelling is what the page says
      // and what a `?session=` link round-trips.
      provider: ref.provider ?? (typeof facts.provider === "string" ? facts.provider : null),
      missing: false,
      unresolved: false,
      invalid: false,
      title: typeof facts.title === "string" ? facts.title : null,
      host: facts.host ?? null,
      first: facts.first ?? null,
      last: facts.last ?? null,
      cost: typeof facts.cost === "number" ? facts.cost : null,
      messages: typeof facts.messages === "number" ? facts.messages : null,
      ...(url ? { url } : {}),
    };
  });
}

/**
 * The money line: the total over the sessions that were actually priced, and the
 * count that total is over. A chip with no `cost` contributes neither.
 *
 * **Rounded to cents at this seam**, not at the renderer. The ledger's per-session
 * costs carry full float precision (`164.18199995`), and summing them produces
 * the `5.350000000000001` shape — a number that is wrong in the only way a money
 * figure can be read, on a wire payload that more than one client will render.
 * Rounding once, where the sum is made, is what keeps every reader agreeing.
 */
export function costOfSessions(chips: readonly ProvenanceSessionChip[]): {
  totalCost: number;
  costedSessions: number;
} {
  let totalCost = 0;
  let costedSessions = 0;
  for (const chip of chips) {
    if (typeof chip.cost !== "number") continue;
    totalCost += chip.cost;
    costedSessions += 1;
  }
  return { totalCost: Math.round(totalCost * 100) / 100, costedSessions };
}

/** Jira rows for a page's keys, with huginn's own issue URL where the corpus
 *  index (`src/jira/verify-keys.ts`) has heard of the key. `corpus` null ⇒
 *  degraded or not asked, and every row then carries the browse URL alone with
 *  NO `huginnKnown` — absent is "I could not ask", `false` is "huginn does not
 *  have it", and those are different answers. */
export function jiraRows(
  keys: readonly string[],
  corpus: Map<string, string | undefined> | null,
): ProvenanceJira[] {
  return keys.map((key) => ({
    key,
    url: jiraBrowseUrl(key),
    // `has`, not `get`: the corpus maps a key to a url that may legitimately be
    // undefined (a doc with no `url:` field), and reading the VALUE would report
    // a key huginn holds as one it does not.
    ...(corpus ? { huginnKnown: corpus.has(key) } : {}),
  }));
}
