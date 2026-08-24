/**
 * How a retrieved document becomes a Jira citation row.
 *
 * **This module no longer RETRIEVES.** A draft is a turn in a chat thread, so the
 * retrieval was done by the conversation's own knowledge tools and reaches us as
 * `research_citations` rows (`src/jira/thread-draft.ts` seeds them); the
 * server-side retrieval phase the composer used to run — one condensed question,
 * a four-way fan-out, a stored hit set, an exclusion column — is gone with the
 * notes path. What survives is everything that has to be TRUE of a citation
 * whatever produced it, and every one of these is a defect this feature shipped
 * once:
 *
 *  · the url is unescaped and gated to http(s) (`normalizeJiraUrl`),
 *  · the Jira key comes off the doc id OR a `/browse/<KEY>` url (`jiraKeyFor`),
 *  · a `jira-issues` title is humanized out of its filename shape,
 *  · the badge is OVERWRITTEN, because `buildCitations` cannot name these three
 *    collections (see {@link toJiraCitation}).
 *
 * The three collections are still named here: `verify-keys.ts` resolves against
 * `jira-issues`, and the reader-facing coverage copy names all three.
 */

import { badgeFromCollectionMeta } from "../research/corpus.ts";
import type { JiraCitation, JiraDepth } from "./wire.ts";

/** The three melosys collections, in the order `.mcp.json` names them. */
export const JIRA_COLLECTIONS = ["jira-issues", "melosys-confluence-v3", "nav-wiki"] as const;

/** The collection whose docs ARE Jira issues — the one `verify-keys` resolves against. */
export const JIRA_ISSUES_COLLECTION = "jira-issues";

/**
 * How many citations are BUILT and STORED on the draft row.
 *
 * The widest the feature uses. What is stored is `JiraCitation[]`, never a raw
 * retrieval hit — a hit's `matchedChunks`/`graph_context` are unbounded
 * `unknown[]` and would make a heavy JSONB row for no reader-visible gain.
 * `seedThreadCitations` caps the thread's own hit set here; depth only varies how
 * many of them reach `## Referanser`.
 */
export const JIRA_STORED_MAX_SOURCES = 24;

/**
 * Chars of a citation's snippet kept on the stored row.
 *
 * `SNIPPET_CHARS` in `answer.ts` is module-private (1200) and this module defines
 * its own rather than reaching for it — no export, no extra coupling. Note it can
 * only ever be TIGHTER: whatever produced the source has already truncated at
 * 1200, so a larger number here would be inert.
 */
export const JIRA_SNIPPET_CHARS = 900;

/** How many of the stored citations `## Referanser` may list, per depth. */
export const JIRA_MAX_SOURCES_BY_DEPTH: Record<JiraDepth, number> = {
  // `Ingen` writes problem/value/acceptance — it needs enough to show this was
  // discussed before, not the whole shelf.
  ingen: 6,
  skisse: 8,
  // `Full` widens over the STORED set (design call 2's grounding budget).
  full: JIRA_STORED_MAX_SOURCES,
};

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
 * the key — so the key prefix comes off, the `.md` tail comes off, and the
 * underscores become spaces. Left alone for every other collection, whose titles
 * are real prose.
 *
 * The `.md` matters on the thread path in particular: a `research_citations` row
 * with a null title falls back to the bare doc id, which always carries it.
 */
export function humanizeJiraTitle(collection: string, title: string, key?: string): string {
  if (collection !== JIRA_ISSUES_COLLECTION) return title;
  const withoutKey = key && title.startsWith(`${key}_`) ? title.slice(key.length + 1) : title;
  const spaced = withoutKey.replace(/\.md$/i, "").replace(/_/g, " ").trim();
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
 * The fields a citation row can be built FROM, whatever produced it.
 *
 * Today there is one producer — a `research_citations` row the thread's own
 * knowledge calls wrote — but the shape is deliberately the common denominator
 * with `buildCitations`' output, which is what the deleted notes path fed in.
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
 * Build ONE citation row — the four things a Jira citation must have, in one
 * place: the url unescape + http(s) gate, the doc-id-or-`/browse/` key
 * resolution, the title humanization and the badge overwrite. Every one of them
 * is a defect this feature has already shipped once.
 *
 * **The badge overwrite is load-bearing.** `RESEARCH_CORPUS` is derived from
 * `RESEARCH_PROFILES`, not from `COLLECTION_META`, and `badgeForCollection` reads
 * `RESEARCH_CORPUS` — so the three entries added to `COLLECTION_META` are dead to
 * *that* function and a row built anywhere else is badged with the raw collection
 * name. `badgeFromCollectionMeta` reads that array instead. (`COLLECTION_META`
 * itself stays module-private in `corpus.ts` — that helper is the whole public
 * surface this needs.)
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

/** Slice the seeded set down to the depth's reference budget. */
export function sliceForDepth(citations: JiraCitation[], depth: JiraDepth): JiraCitation[] {
  return citations.slice(0, JIRA_MAX_SOURCES_BY_DEPTH[depth]);
}
