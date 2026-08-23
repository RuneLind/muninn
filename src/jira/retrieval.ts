/**
 * The retrieval half of the Jira composer — server-side, and BEFORE generation.
 *
 * A generated Jira task is only as good as what it retrieved: that this was
 * reported before, that another issue is refactoring the same service, which
 * Confluence page describes the contract about to change. So retrieval is its own
 * phase, over the three melosys collections `bots/melosys/.mcp.json` already binds
 * (`jira-issues` + `melosys-confluence-v3` + `nav-wiki`) on the SAME huginn
 * instance `config.knowledgeApiUrl` points at — no MCP in the path.
 *
 * Three rules from the plan's design call 1, all implemented here:
 *
 *  1. **Retrieval always runs at the WIDE limit, whatever depth is selected.**
 *     `limit` is a retrieval-time parameter (it sets `?limit=` per sub-question)
 *     and therefore cannot be re-sliced from stored citations the way
 *     `maxSources` can. Since retrieval happens once per draft session and depth
 *     is a control the reader changes afterwards, retrieving narrow would leave
 *     `Full` permanently starved.
 *  2. **Retrieval runs once per draft SESSION, not once per generation.** The hit
 *     set is persisted on the `jira_drafts` row and reused. Re-retrieving on a
 *     regenerate would be nondeterministic (a fresh Haiku decomposition per call),
 *     so the second run's hits could differ from the rows the reader was
 *     toggling — which makes the toggle a lie.
 *  3. **A coverage floor.** `assessCoverage` is reused verbatim; `coverageMessage`
 *     is NOT — its two strings are `/research` reader copy naming the Anthropic
 *     firehose and saying "I'd rather not synthesize", neither of which is true
 *     here. This module owns its own two strings, and the `done` payload carries
 *     the VERDICT rather than a boolean.
 */

import { researchKnowledge, type ResearchHit } from "../ai/research-knowledge.ts";
import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import { buildCitations, assessCoverage, type Coverage } from "../research/answer.ts";
import { badgeFromCollectionMeta } from "../research/corpus.ts";
import type { BotConfig } from "../bots/config.ts";
import type { TraceContext } from "../tracing/index.ts";
import {
  JIRA_LOW_CONFIDENCE_MESSAGE,
  JIRA_NO_HITS_MESSAGE,
  JIRA_UNREACHABLE_MESSAGE,
} from "./wire.ts";
import type { JiraCitation, JiraCoverage, JiraDepth } from "./wire.ts";
import { getLog } from "../logging.ts";

const log = getLog("jira", "retrieval");

/** The three melosys collections, in the order `.mcp.json` names them. */
export const JIRA_COLLECTIONS = ["jira-issues", "melosys-confluence-v3", "nav-wiki"] as const;

/** The collection whose docs ARE Jira issues — the one `verify-keys` resolves against. */
export const JIRA_ISSUES_COLLECTION = "jira-issues";

/**
 * Per-sub-question retrieval width.
 *
 * `ask.ts` uses `PER_SEARCH_LIMIT = 6`. This is wider because `query.ts` hands
 * the decomposer ONE rich multi-part question, so a 2–4-way fan-out is the
 * expected case and 8×4 = 32 raw hits before dedup is what makes the stored
 * 24-wide citation set reachable at all.
 */
export const JIRA_PER_SEARCH_LIMIT = 8;

/**
 * How many citations are BUILT and STORED on the draft row.
 *
 * The widest the feature uses, sized to cover a 4-way decomposition at
 * {@link JIRA_PER_SEARCH_LIMIT}. What is stored is `JiraCitation[]`, never raw
 * `ResearchHit[]` — a hit's `matchedChunks`/`graph_context` are unbounded
 * `unknown[]` and would make a heavy JSONB row for no reader-visible gain.
 * PR 2's toggle column always renders this stored set, so it does not change
 * size when depth changes; depth only varies how many of them reach the prompt.
 */
export const JIRA_STORED_MAX_SOURCES = 24;

/**
 * Chars of a citation's snippet handed to the GENERATION prompt.
 *
 * `SNIPPET_CHARS` in `answer.ts` is module-private (1200) and this module defines
 * its own rather than reaching for it — no export, no extra coupling. Note it can
 * only ever be TIGHTER: `buildCitations` has already truncated at 1200, so a
 * larger number here would be inert. `Full`'s appetite for more text is served by
 * the full-document pull below, not by widening snippets.
 */
export const JIRA_SNIPPET_CHARS = 900;

/** How many of the stored citations reach the prompt, per depth. */
export const JIRA_MAX_SOURCES_BY_DEPTH: Record<JiraDepth, number> = {
  // `Ingen` writes problem/value/acceptance — it needs enough to know this was
  // reported before, not the whole shelf.
  ingen: 6,
  skisse: 8,
  // `Full` widens over the STORED set (design call 2's grounding budget).
  full: JIRA_STORED_MAX_SOURCES,
};

/** How many top hits `Full` pulls as FULL documents, on top of their snippets. */
export const JIRA_FULL_DOC_COUNT = 3;
/** Per-document char cap on that pull (the `capContent`/`SHARE_BODY_MAX` shape). */
export const JIRA_FULL_DOC_CHARS = 6_000;
/** Total retrieved full-document text across the pull. */
export const JIRA_FULL_DOC_TOTAL_CHARS = 15_000;
/** Whole-operation budget for the full-document pull. Degrades to snippets-only. */
export const JIRA_FULL_DOC_TIMEOUT_MS = 8_000;

/** The coverage strings live in the dependency-free `./wire.ts` — the page
 *  renders them and cannot import this module. Import them from there.
 *
 *  A `switch` with an exhaustive `never` tail rather than a ternary chain: adding
 *  a fourth verdict must be a COMPILE error here, not a silent fall-through into
 *  the `no_hits` sentence — which is exactly how `unreachable` would have been
 *  reported as "the corpus covered nothing" a second time. */
export function jiraCoverageMessage(coverage: Exclude<JiraCoverage, "answer">): string {
  switch (coverage) {
    case "low_confidence":
      return JIRA_LOW_CONFIDENCE_MESSAGE;
    case "unreachable":
      return JIRA_UNREACHABLE_MESSAGE;
    case "no_hits":
      return JIRA_NO_HITS_MESSAGE;
    default: {
      const exhaustive: never = coverage;
      return exhaustive;
    }
  }
}

/**
 * THE Jira key shape — one source, two consumers.
 *
 * `verify-keys.ts` scans the generated markdown with it and this module reads it
 * off a doc id; they shipped as two regexes that DISAGREED (prefix ≥1 vs ≥2
 * characters, ≤∞ vs ≤7 digits), which means a key could be extracted from the
 * draft and never found in the index, or the other way round — a red row for a
 * real issue. Digits go to 8: MELOSYS is at 5 figures and a corpus that reaches
 * 7 would otherwise start failing silently.
 */
export const JIRA_KEY_SOURCE = "[A-Z][A-Z0-9]{1,15}-\\d{1,8}";

/**
 * Pull the Jira key out of a `jira-issues` doc id (`<KEY>_<slug>.md`).
 *
 * Measured against the live listing on 2026-08-22: 2107 documents, every id of
 * that shape, prefixes MELOSYS (2102) / TESTLOOP (4) / SMOKE (1). Returns
 * undefined for any other collection — a Confluence page has no key, and
 * inventing one would put a broken `[KEY](url)` in `## Referanser`.
 *
 * `verify-keys.ts`'s index builder calls THIS function rather than re-deriving
 * the shape, so the two sides of the verdict are matched by construction.
 */
const DOC_ID_KEY_RE = new RegExp(`^(${JIRA_KEY_SOURCE})(?:[_.]|$)`);

export function jiraKeyFromDocId(collection: string, docId: string): string | undefined {
  if (collection !== JIRA_ISSUES_COLLECTION) return undefined;
  return DOC_ID_KEY_RE.exec(docId)?.[1];
}

/**
 * Pull the key out of a Jira issue URL — `…/browse/<KEY>` on a JIRA host only.
 *
 * The url is unescaped first (5 real docs carry `https\://`). The host is gated
 * to the two Jira instances the corpus actually links (`jira.adeo.no`, the
 * legacy Server, and `nav.atlassian.net`, Cloud — both measured live), because
 * Bitbucket/Stash also spell `/browse/<repo>-<n>` and an ungated match minted a
 * fabricated Jira key from a `build-12` repo path. The key itself is matched
 * case-sensitively, same as `jiraKeyFromDocId`. A sub-page or a query/fragment
 * tail (`/browse/MELOSYS-1/comments`, `?focusedCommentId=`) still names the
 * issue and is accepted.
 */
const BROWSE_KEY_RE = new RegExp(
  `^https?://(?:[^/]*\\.)?(?:jira\\.adeo\\.no|nav\\.atlassian\\.net)/browse/(${JIRA_KEY_SOURCE})(?:[/?#]|$)`,
);

export function jiraKeyFromBrowseUrl(url: string | undefined): string | undefined {
  const normalized = normalizeJiraUrl(url);
  if (!normalized) return undefined;
  return BROWSE_KEY_RE.exec(normalized)?.[1];
}

/**
 * THE key resolver for a retrieved document — doc id first, then the URL.
 *
 * **Why the URL half exists.** `nav-wiki` carries a page PER ISSUE under
 * `sources/jira/<KEY>.md`, whose `url` IS `https://jira.adeo.no/browse/<KEY>`.
 * Keyed off the doc id alone those rows had no key at all, with two consequences
 * measured on a live draft: the key-verification pass called a retrieved issue
 * amber `notes` ("the reader wrote it, retrieval never saw it") about an issue
 * retrieval had just returned, and `## Referanser` — which dedupes on
 * `key ?? docId` — listed the same issue twice under two different doc ids.
 *
 * A `/browse/<KEY>` url is as authoritative as a doc id: it is not a page that
 * MENTIONS the issue, it is a page whose canonical address IS the issue. A
 * Confluence page linking to Jira has a Confluence url and is unaffected.
 */
export function jiraKeyFor(collection: string, docId: string, url?: string): string | undefined {
  return jiraKeyFromDocId(collection, docId) ?? jiraKeyFromBrowseUrl(url);
}

/**
 * Make a `jira-issues` title readable.
 *
 * Measured on the live corpus: huginn's `title` for these documents IS the
 * filename, so `titleFor` in `answer.ts` hands back
 * `MELOSYS-6528_Ny_flyt_steg1_Foreløpig_fakturert_trygdeavgift_…`. Rendered into
 * `## Referanser` that is a wall of underscores beside a link that already says
 * the key — so the key prefix comes off and the underscores become spaces. Left
 * alone for every other collection, whose titles are real prose.
 */
export function humanizeJiraTitle(collection: string, title: string, key?: string): string {
  if (collection !== JIRA_ISSUES_COLLECTION) return title;
  const withoutKey = key && title.startsWith(`${key}_`) ? title.slice(key.length + 1) : title;
  const spaced = withoutKey.replace(/_/g, " ").trim();
  return spaced || title;
}

/**
 * Is this URL safe to render as a Jira link?
 *
 * Only http(s). Measured on the live corpus: `nav-wiki` documents carry
 * `file://./huginn-nav/wiki/entities/MEDL.md` — the indexer's own on-disk path.
 * Pasted into a Jira description that is a dead link at best and, since PR 0
 * measured that a bare URL becomes a smart-link card, a visibly broken card at
 * worst. A source with no LINKABLE url renders as plain text instead, which is
 * the same rule as a source with no url at all.
 */
export function isLinkableUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

/**
 * Unescape, then judge, one corpus url — the ONE place a citation's link is made.
 *
 * Measured on the live listing: **5 real `jira-issues` documents carry
 * `https\://jira.adeo.no/browse/…`** — a markdown-escaped colon, from whatever
 * wrote the source file. Judged raw it fails {@link isLinkableUrl}, the key
 * renders BARE in `## Referanser`, and because two doc ids can share one key the
 * same issue then appeared TWICE, once linked and once bare. Unescaping first is
 * what makes those five ordinary links again.
 *
 * Everything not http(s) after that still returns undefined: `nav-wiki` documents
 * carry `file://./huginn-nav/wiki/…`, the indexer's own on-disk path, which PR 0
 * measured renders as a visibly broken Jira smart-link card.
 */
export function normalizeJiraUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const unescaped = url.trim().replace(/^(https?)\\+:/i, "$1:");
  return isLinkableUrl(unescaped) ? unescaped : undefined;
}

/**
 * Turn ranked hits into this feature's citation rows.
 *
 * **The badge overwrite is load-bearing and is one of two things that must BOTH
 * happen or the fix is inert** (the plan's badge note): `RESEARCH_CORPUS` is
 * derived from `RESEARCH_PROFILES`, not from `COLLECTION_META`, and
 * `badgeForCollection` reads `RESEARCH_CORPUS` — so the three entries added to
 * `COLLECTION_META` are dead to *that* function, and `buildCitations` has already
 * populated `badge` with the raw collection name via it. The two things:
 * (1) the entries exist in `COLLECTION_META`, and (2) the badge is OVERWRITTEN
 * here through `badgeFromCollectionMeta`, which reads that array rather than the
 * profile derivation. Doing one without the other ships a citation row badged
 * `jira-issues`. (`COLLECTION_META` itself stays module-private in `corpus.ts` —
 * `badgeFromCollectionMeta` is the whole public surface this needs.)
 */
export function toJiraCitations(hits: ResearchHit[]): JiraCitation[] {
  return buildCitations(hits, JIRA_STORED_MAX_SOURCES).map((c) => toJiraCitation(c, c.n));
}

/**
 * The fields a citation row can be built FROM, whatever produced it.
 *
 * Two producers exist: `buildCitations` over live retrieval hits (the notes
 * path), and a `research_citations` row the chat's own `research_knowledge` call
 * wrote (the thread path). They agree on exactly this much.
 */
export interface JiraCitationSource {
  collection: string;
  docId: string;
  title: string;
  url?: string | null;
  relevance: number;
  snippet?: string | null;
}

/**
 * Build ONE citation row. Extracted so the thread-sourced seeding cannot drift
 * from live retrieval on any of the four things this does — the url unescape +
 * http(s) gate, the doc-id-or-`/browse/` key resolution, the title humanization
 * and the badge overwrite. Copying it was the alternative, and every one of those
 * four is a defect this feature has already shipped once.
 */
export function toJiraCitation(c: JiraCitationSource, n: number): JiraCitation {
  const url = normalizeJiraUrl(c.url ?? undefined);
  // Doc id OR `/browse/<KEY>` url — a `nav-wiki` page whose address IS the
  // issue carries the key too, or the verdict goes amber for a retrieved issue
  // and `## Referanser` lists it twice. See `jiraKeyFor`.
  const key = jiraKeyFor(c.collection, c.docId, c.url ?? undefined);
  return {
    n,
    collection: c.collection,
    docId: c.docId,
    title: humanizeJiraTitle(c.collection, c.title, key),
    // Unescaped and judged at the SOURCE rather than at each render site, so
    // nothing downstream can emit a `file://` or a `https\://`.
    ...(url ? { url } : {}),
    badge: badgeFromCollectionMeta(c.collection),
    relevance: c.relevance,
    ...(c.snippet ? { snippet: clip(c.snippet, JIRA_SNIPPET_CHARS) } : {}),
    ...(key ? { key } : {}),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Drop the reader's de-selected docs and RENUMBER.
 *
 * `buildCitations` assigns `n` 1-based at build time, so after an exclusion the
 * ordering the toggle column renders would have gaps in it. The renumber happens
 * BEFORE prompt assembly, so the de-selected hits are genuinely absent from what
 * the model sees rather than filtered out of a list afterwards.
 *
 * **The exclusion set is keyed on the BARE `docId`, not `collection/docId`, and
 * that was measured rather than assumed.** Two collections sharing a stem
 * (`index.md`) would make one click switch off a document in the other. Against
 * the live huginn listings on 2026-08-22 — `jira-issues` 2107 ids,
 * `melosys-confluence-v3` 276, `nav-wiki` 538, 2921 in total — all three pairwise
 * intersections are EMPTY, and the three id shapes are structurally disjoint:
 * `MELOSYS-1234_slug.md`, `Team MELOSYS/<page>.md`, `concepts/<page>.md`. The ids
 * carry their own path prefixes, so a composite key would also be ambiguous about
 * where the collection name ends. Re-measure before adding a fourth collection —
 * a collision would be invisible from the page, which shows both rows toggling as
 * one.
 */
export function applyExclusions(citations: JiraCitation[], excludeDocIds: string[]): JiraCitation[] {
  const excluded = new Set(excludeDocIds);
  return citations
    .filter((c) => !excluded.has(c.docId))
    .map((c, i) => ({ ...c, n: i + 1 }));
}

/** Slice the stored (already renumbered) set down to the depth's prompt budget. */
export function sliceForDepth(citations: JiraCitation[], depth: JiraDepth): JiraCitation[] {
  return citations.slice(0, JIRA_MAX_SOURCES_BY_DEPTH[depth]);
}

export interface JiraRetrievalOptions {
  question: string;
  botConfig: BotConfig;
  knowledgeApiUrl: string;
  /** Parent trace context — `tracer.context` from the caller's root span. */
  traceContext?: TraceContext;
  /** Test seam — production callers omit it. */
  retrieve?: typeof researchKnowledge;
}

export interface JiraRetrievalResult {
  citations: JiraCitation[];
  /** Widened past `Coverage` by `unreachable` — see {@link classifyJiraCoverage}. */
  coverage: JiraCoverage;
  /** Unique documents retrieved before the 24-wide citation slice. */
  hitCount: number;
}

/**
 * The retrieval verdict, with the ONE case `assessCoverage` structurally cannot
 * see: every sub-search FAILED.
 *
 * `researchKnowledge` records a thrown sub-search as `{resultCount: 0, error}`
 * and swallows it, so a dead huginn reaches `assessCoverage` looking exactly like
 * a corpus that had nothing to say — and the reader was told the corpus had
 * nothing to say. Measured on the first real run of the composer.
 *
 * The test is **every** sub-search, not any: a partial failure genuinely did ask
 * the corpus, and whatever came back is a real (if narrower) answer to grade the
 * ordinary way. `subSearches.length > 0` guards the vacuous-truth case — an empty
 * fan-out is not an outage.
 */
export function classifyJiraCoverage(input: {
  hitCount: number;
  subSearches: { resultCount: number; lowConfidence?: boolean; error?: string }[];
}): JiraCoverage {
  if (input.subSearches.length > 0 && input.subSearches.every((s) => !!s.error)) {
    return "unreachable";
  }
  return assessCoverage({
    hitCount: input.hitCount,
    subSearches: input.subSearches.map((s) => ({
      resultCount: s.resultCount,
      ...(s.lowConfidence !== undefined ? { lowConfidence: s.lowConfidence } : {}),
    })),
  }) satisfies Coverage;
}

/** Retrieve over the three melosys collections and build the stored citation set. */
export async function retrieveForJira(opts: JiraRetrievalOptions): Promise<JiraRetrievalResult> {
  const retrieve = opts.retrieve ?? researchKnowledge;
  const res = await retrieve({
    question: opts.question,
    collections: [...JIRA_COLLECTIONS],
    limit: JIRA_PER_SEARCH_LIMIT,
    botName: opts.botConfig.name,
    knowledgeApiUrl: opts.knowledgeApiUrl,
    ...(opts.traceContext ? { traceContext: opts.traceContext } : {}),
    ...(opts.botConfig.connector ? { connector: opts.botConfig.connector } : {}),
    ...(opts.botConfig.haikuBackend ? { haikuBackend: opts.botConfig.haikuBackend } : {}),
  });

  const coverage = classifyJiraCoverage({
    hitCount: res.results.length,
    subSearches: res.subSearches.map((s) => ({
      resultCount: s.resultCount,
      ...(s.lowConfidence !== undefined ? { lowConfidence: s.lowConfidence } : {}),
      ...(s.error !== undefined ? { error: s.error } : {}),
    })),
  });
  if (coverage === "unreachable") {
    log.warn("jira retrieval unreachable bot={bot} subSearches={count}", {
      bot: opts.botConfig.name,
      count: res.subSearches.length,
    });
  }

  return { citations: toJiraCitations(res.results), coverage, hitCount: res.results.length };
}

/** One full-document body pulled for `Full` depth. */
export interface JiraFullDoc {
  docId: string;
  title: string;
  text: string;
}

/**
 * `Full` only: pull the top hits as FULL documents on top of their snippets.
 *
 * Through `fetchKnowledgeApi` against huginn's `/api/document/<collection>/<id>`
 * — deliberately NOT muninn's own `/api/search/document/…` dashboard route, which
 * is the browser-side proxy PR 2's doc panel uses and would make a server-side
 * pull go out through our own HTTP surface to reach the same upstream.
 *
 * Fail-soft in every direction: a dead huginn, a 404 on one id or an over-budget
 * pull all degrade to fewer (or zero) documents and the draft is written from
 * snippets alone. The whole pull shares one deadline, so `Full`'s wall clock
 * cannot grow by three sequential huginn timeouts.
 */
export async function fetchFullDocuments(
  citations: JiraCitation[],
  knowledgeApiUrl: string,
  fetchDoc: typeof fetchKnowledgeApi = fetchKnowledgeApi,
): Promise<JiraFullDoc[]> {
  const wanted = citations.slice(0, JIRA_FULL_DOC_COUNT);
  if (wanted.length === 0) return [];
  const deadline = Date.now() + JIRA_FULL_DOC_TIMEOUT_MS;

  const settled = await Promise.allSettled(
    wanted.map(async (c) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("full-document pull budget exhausted");
      const path = `/api/document/${encodeURIComponent(c.collection)}/${encodeURIComponent(c.docId)}`;
      const raw = (await fetchDoc(knowledgeApiUrl, path, { timeoutMs: remaining })) as {
        text?: unknown;
        content?: unknown;
      };
      const text = typeof raw.text === "string" ? raw.text : typeof raw.content === "string" ? raw.content : "";
      if (!text.trim()) throw new Error("document carried no text");
      return { docId: c.docId, title: c.title, text: clip(text.trim(), JIRA_FULL_DOC_CHARS) };
    }),
  );

  const out: JiraFullDoc[] = [];
  let total = 0;
  for (const [i, r] of settled.entries()) {
    if (r.status === "rejected") {
      log.warn("jira full-document pull failed doc={doc} error={error}", {
        doc: wanted[i]!.docId,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
      continue;
    }
    // The TOTAL budget is checked after the per-document clip, so one long page
    // cannot eat the whole allowance and starve the next two silently. `continue`,
    // not `break`: a later, shorter document that still fits should ride along.
    // (With today's constants — {@link JIRA_FULL_DOC_COUNT} 3 documents clipped at
    // {@link JIRA_FULL_DOC_CHARS} 6 000 against a 15 000 total — the budget can
    // only ever bind on the LAST document, so the two behave identically; this is
    // the intent made correct ahead of any widening, not an observed fix.)
    if (total + r.value.text.length > JIRA_FULL_DOC_TOTAL_CHARS) continue;
    total += r.value.text.length;
    out.push(r.value);
  }
  return out;
}
