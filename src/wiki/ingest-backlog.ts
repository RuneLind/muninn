/**
 * Wiki ingest-backlog computation.
 *
 * The wiki gardener (weekly watcher) only ever consumes a *recent* window of
 * summaries, so the all-time tail of summary articles that has never been
 * ingested into a bot's knowledge wiki — in any form — grows unbounded. This
 * module measures that backlog: per summary collection, how many listed docs are
 * "queued" (not yet reflected in the wiki) vs already ingested.
 *
 * A doc counts as **ingested** (credited, not queued) when ANY of:
 *  - its key `<collection>/<id>` is in the gardener's consumed set (source_docs
 *    of `applied` proposals) — **consumed-wins**, even if its URL isn't in a page;
 *  - its key is in the pending set (`draft`/`approved` proposals);
 *  - its normalized URL appears literally in some wiki page — **URL-referenced-wins**,
 *    even if the gardener never clustered it (a human may have cited it by hand);
 *  - its URL-derived platform id ({@link docIdFromUrl}) was swept as an id token —
 *    **id-referenced-wins**: the manual-ingest convention cites videos by their bare
 *    backticked id (`` `deFvnmibzow` ``), so hundreds of processed docs carry no full
 *    URL in any page. False-credit risk is acceptable by construction: a stray
 *    backticked token only mis-credits if it equals a real listed doc's id.
 * Everything else is **queued**.
 *
 * LOAD-BEARING: docs without a `url` never reach this module. Huginn's collection
 * listing endpoint (`/api/collection/<c>/documents`) skips url-less docs (its
 * query is `WHERE ... AND doc_url IS NOT NULL` — "not doc_url"), so every listed
 * doc carries a url and URL-matching is always possible. The `url?` optionality
 * below is purely defensive.
 *
 * The URL-set side is built by a single regex sweep over every wiki `.md` file
 * (bodies + frontmatter), normalized so a link with a YouTube timestamp or a
 * share param still matches the doc's canonical URL. Normalization rules are
 * pinned by unit tests — they are what produced the reconciliation reference
 * table (youtube 795/397/391, x 58/27/31, anthropic 12/0/12, tiktok 4/0/4;
 * 548 distinct wiki URLs).
 */

import path from "node:path";

/** A summary doc as listed by huginn (already url-bearing — see module docstring). */
export interface ListedDoc {
  collection: string;
  id: string;
  url?: string;
  date?: string;
}

/** A doc that has not been ingested into the wiki in any form — the PR-2 drain unit. */
export interface QueuedDoc {
  collection: string;
  id: string;
  /** Original (un-normalized) url — always present in practice (huginn omits url-less docs). */
  url: string;
  date?: string;
}

/** Per-collection partition. `total === ingested + queued`. */
export interface CollectionBacklog {
  collection: string;
  total: number;
  ingested: number;
  queued: number;
  queuedDocs: QueuedDoc[];
}

/** Overall backlog across every collection plus the per-collection breakdown. */
export interface IngestBacklog {
  byCollection: CollectionBacklog[];
  total: number;
  ingested: number;
  queued: number;
}

/**
 * The wiki URL sweep regex — grab an http(s) URL up to the first whitespace or
 * a delimiter the markdown/frontmatter would wrap it in. Trailing punctuation
 * the character class lets through (`.,;`) is trimmed by {@link normalizeUrl}.
 */
const URL_SWEEP_RE = /https?:\/\/[^\s)\]"'<>]+/g;

/**
 * Backtick-wrapped token sweep — the manual-ingest convention cites videos by
 * their bare platform-native id (`` `deFvnmibzow` ``), not a full URL. Grab every
 * `` `...` `` span; {@link isDocIdToken} keeps only the ones shaped like an id.
 */
const BACKTICK_TOKEN_RE = /`([^`]+)`/g;

/** A YouTube-style id (`watch?v=`, `youtu.be/`, `shorts/`) — 11 url-safe chars. */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** An X/TikTok numeric status/video id — 15–20 digits. */
const NUMERIC_ID_RE = /^\d{15,20}$/;

/** Does a bare token look like a platform-native doc id worth crediting by? */
function isDocIdToken(token: string): boolean {
  return YT_ID_RE.test(token) || NUMERIC_ID_RE.test(token);
}

/**
 * Extract the platform-native id from a listed doc's URL, or null when the shape
 * carries no such id (anthropic-summaries, unknown hosts) — those stay URL-only.
 *  - YouTube: `watch?v=<11>`, `youtu.be/<11>`, `shorts/<11>`;
 *  - X/Twitter: `/status/<15–20 digits>`;
 *  - TikTok: `/video/<digits>`.
 */
export function docIdFromUrl(url: string): string | null {
  const yt =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ??
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ??
    url.match(/shorts\/([A-Za-z0-9_-]{11})/);
  if (yt) return yt[1]!;
  const status = url.match(/\/status\/(\d{15,20})/);
  if (status) return status[1]!;
  const tiktok = url.match(/\/video\/(\d+)/);
  if (tiktok) return tiktok[1]!;
  return null;
}

/** Query-param values that are noise for identity: YouTube share id + timestamp. */
function isDroppableParam(key: string, value: string): boolean {
  const k = key.toLowerCase();
  if (k === "si") return true; // youtu.be / share tracking id
  if (k === "t" && /^\d+s?$/i.test(value)) return true; // ?t=NNN / ?t=NNNs / &t=NNNs timestamp
  return false;
}

/** Drop `si=` + `t=<timestamp>` params, wherever they sit in the query string. */
function stripShareParams(url: string): string {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return url;
  const base = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);
  const kept = query
    .split("&")
    .filter((pair) => {
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? "" : pair.slice(eq + 1);
      return !isDroppableParam(key, value);
    });
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

/**
 * Normalize a URL to a canonical identity key so a wiki reference matches the
 * doc's stored url. Rules (each pinned by a unit test):
 *  1. trim trailing `.,;` punctuation the regex sweep picked up;
 *  2. `http://` → `https://`;
 *  3. drop `si=` and `t=<timestamp>` query params (share/timestamp noise);
 *  4. strip a single trailing `/`.
 */
export function normalizeUrl(raw: string): string {
  let u = raw.trim();
  // 1. Trailing sentence punctuation swept up from prose.
  u = u.replace(/[.,;]+$/, "");
  // 2. Scheme.
  u = u.replace(/^http:\/\//i, "https://");
  // 3. Share/timestamp params.
  u = stripShareParams(u);
  // 4. Trailing slash (only one — a bare host `https://x.com/` → `https://x.com`).
  u = u.replace(/\/$/, "");
  return u;
}

/** Every normalized http(s) URL found in a blob of text (body + frontmatter). */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_SWEEP_RE)) out.push(normalizeUrl(m[0]));
  return out;
}

/** Every backtick-wrapped bare id token (`^[A-Za-z0-9_-]{11}$` / `^\d{15,20}$`). */
export function extractIdTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(BACKTICK_TOKEN_RE)) {
    if (isDocIdToken(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * The wiki-reference sweep result. `urls` are normalized http(s) URLs; `idTokens`
 * are platform-native doc ids credited to a listed doc when its URL yields the
 * same id via {@link docIdFromUrl} — sourced from BOTH backtick-wrapped bare ids
 * (the manual-ingest citation convention) AND every swept URL's own id (so a
 * full-URL citation credits by id too — one mechanism, not two).
 */
export interface WikiRefs {
  urls: Set<string>;
  idTokens: Set<string>;
}

/**
 * Sweep every `.md` file under a wiki root for URLs + bare id tokens and return
 * the normalized refs. Plain recursive read (mirrors `src/wiki/lint.ts`) — a full
 * scan of ~700 small files is well under a second and the caller TTL-caches the
 * result. Unreadable files are skipped, never fatal.
 */
export async function collectWikiRefs(root: string): Promise<WikiRefs> {
  const urls = new Set<string>();
  const idTokens = new Set<string>();
  const glob = new Bun.Glob("**/*.md");
  for await (const rel of glob.scan({ cwd: root, dot: false })) {
    // Bun.Glob's dot:false skips dot FILES but may still descend dot DIRS —
    // filter path segments explicitly (same guard as store.ts).
    if (rel.split("/").some((seg) => seg.startsWith("."))) continue;
    let content: string;
    try {
      content = await Bun.file(path.join(root, rel)).text();
    } catch {
      continue;
    }
    for (const u of extractUrls(content)) {
      urls.add(u);
      const id = docIdFromUrl(u);
      if (id) idTokens.add(id);
    }
    for (const t of extractIdTokens(content)) idTokens.add(t);
  }
  return { urls, idTokens };
}

/**
 * Partition each collection's listed docs into ingested vs queued (pure).
 *
 * @param listedBySource  collection name → its listed docs (order preserved in output)
 * @param wikiRefs        normalized URLs + platform-native id tokens swept from the wiki
 * @param consumedKeys    `<collection>/<id>` of docs in `applied` proposals
 * @param pendingKeys     `<collection>/<id>` of docs in `draft`/`approved` proposals
 */
export function computeIngestBacklog(
  listedBySource: Record<string, ListedDoc[]>,
  wikiRefs: WikiRefs,
  consumedKeys: Set<string>,
  pendingKeys: Set<string>,
): IngestBacklog {
  const byCollection: CollectionBacklog[] = [];
  let total = 0;
  let ingested = 0;
  let queued = 0;

  for (const [collection, docs] of Object.entries(listedBySource)) {
    let cTotal = 0;
    let cIngested = 0;
    const queuedDocs: QueuedDoc[] = [];

    for (const doc of docs) {
      cTotal += 1;
      const key = `${collection}/${doc.id}`;
      const docId = doc.url !== undefined ? docIdFromUrl(doc.url) : null;
      const credited =
        consumedKeys.has(key) || // consumed-wins
        pendingKeys.has(key) ||
        (doc.url !== undefined && wikiRefs.urls.has(normalizeUrl(doc.url))) || // URL-referenced-wins
        (docId !== null && wikiRefs.idTokens.has(docId)); // id-referenced-wins
      if (credited) {
        cIngested += 1;
      } else {
        queuedDocs.push({
          collection,
          id: doc.id,
          url: doc.url ?? "",
          ...(doc.date ? { date: doc.date } : {}),
        });
      }
    }

    const cQueued = queuedDocs.length;
    byCollection.push({ collection, total: cTotal, ingested: cIngested, queued: cQueued, queuedDocs });
    total += cTotal;
    ingested += cIngested;
    queued += cQueued;
  }

  return { byCollection, total, ingested, queued };
}
