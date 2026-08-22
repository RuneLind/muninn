/**
 * Server-side key verification — the mechanical defence against the one output
 * failure that costs more than writing the task by hand.
 *
 * A task that reads beautifully and cites `MELOSYS-4821`, which does not exist,
 * is discovered by someone else, later. Prompts are worst at exactly this failure
 * mode, so the defence is a post-pass over the generated markdown, not a sentence
 * in a template. (The templates carry the sentence too — it is the cheap half.)
 *
 * **Three states, not two.** A prefix allow-list would silently DROP the worst
 * case — a fabricated key from a project retrieval never surfaced, say
 * `TRYGD-99` — and unioning the notes' keys into "verified" would bless a key
 * mistyped in a meeting note, contradicting the acceptance test's *"every Jira
 * key it cites resolves to a real issue"*. So: `verified` (in the retrieved set),
 * `notes` (present in the raw material only — amber), `unknown` (neither — red).
 *
 * `state` and `resolved` are SEPARATE axes on purpose: `state` answers *is the
 * draft grounded in it*, `resolved` answers *does it exist*. A notes-only key
 * that resolves is a real issue retrieval missed; one that does not is a typo.
 *
 * ── The lookup: only ONE shape works, and the two obvious ones are both wrong ──
 * Measured live against huginn at `http://127.0.0.1:8321` on 2026-08-22, and
 * RE-MEASURED with curl on the same date before this file was written:
 *
 *   · `GET /api/document/jira-issues/MELOSYS-1`      → **404**. Doc ids are
 *     `<KEY>_<slug>.md`, never the bare key. A false negative on every real key.
 *   · `GET /api/search?q=MELOSYS-99999&collection=jira-issues` → 200 with three
 *     REAL issues at relevance **0.999 / 0.998 / 0.998** for a key that does not
 *     exist. Semantic search cannot say "no such issue", so this would mark a
 *     hallucinated key **verified** — the exact failure the mechanism exists to
 *     prevent.
 *   · `GET /api/collection/jira-issues/documents`    → **200, 271 518 bytes,
 *     16 ms**, `{documents:[{id, url}]}` — 2107 rows, ids of the form
 *     `<KEY>_<slug>.md`, prefixes MELOSYS (2102) / TESTLOOP (4) / SMOKE (1).
 *     Prefix-match the key against `id`. This is the one that works.
 *
 * The listing is cached behind a TTL: 271 KB per draft would be silly, and issue
 * ids do not churn on a five-minute scale.
 */

import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import type { JiraCitation, JiraKeyVerdict } from "./wire.ts";
import { JIRA_ISSUES_COLLECTION } from "./retrieval.ts";
import { maskFencedCode } from "./markdown-scan.ts";
import { getLog } from "../logging.ts";

const log = getLog("jira", "verify-keys");

/**
 * What a bare `[A-Z][A-Z0-9]+-\d+` matches that is NOT a Jira key.
 *
 * Without this the pass flags `UTF-8`, `ISO-8601`, `SHA-256` and `RFC-2119` in
 * every second technical task and the reader learns to ignore the red rows —
 * which is the only way this mechanism actually fails. The list carries THIS
 * corpus's own vocabulary, not just generic tech: `BUC-02` is the obvious one in
 * a knowledge base whose MCP description literally advertises "BUC/SED types",
 * and `SED-01`-shaped references appear beside it.
 *
 * Bounded by design — a growing denylist is a growing hole, so anything that
 * turns out to need adding should be weighed against just letting the row render
 * amber with a `resolved: false`.
 */
export const JIRA_KEY_DENYLIST = new Set([
  "UTF", "ISO", "SHA", "RFC", "HTTP", "HTTPS", "AES", "RSA", "TLS", "SSL",
  "BUC", "SED", "EU", "EF", "EØS", "ISO8601", "UTF8", "SHA256", "MD", "CVE",
]);

/** The key shape. Anchored on a word boundary so `xMELOSYS-1` does not match. */
const KEY_RE = /\b([A-Z][A-Z0-9]{1,15})-(\d{1,7})\b/g;

/** Every candidate key in the markdown, fenced code excluded, in first-seen order. */
export function extractJiraKeys(markdown: string): string[] {
  const masked = maskFencedCode(markdown);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of masked.matchAll(KEY_RE)) {
    const prefix = m[1]!;
    if (JIRA_KEY_DENYLIST.has(prefix)) continue;
    const key = `${prefix}-${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ── The corpus listing, behind a TTL cache ───────────────────────────────────

/** How long a fetched `jira-issues` listing is reused. Issue ids do not churn
 *  faster than this, and the fetch is 271 KB. */
export const JIRA_KEY_INDEX_TTL_MS = 10 * 60_000;

interface KeyIndex {
  /** key → issue URL (huginn's listing carries `url` per document). */
  byKey: Map<string, string | undefined>;
  fetchedAtMs: number;
}

let cached: KeyIndex | null = null;
let inFlight: Promise<KeyIndex | null> | null = null;

/** Test-only: drop the cached listing. */
export function __resetJiraKeyIndexForTest(): void {
  cached = null;
  inFlight = null;
}

interface ListedDoc { id?: unknown; url?: unknown }

/** Build the key → url map from one listing response. Exported for the unit test. */
export function indexFromListing(docs: ListedDoc[]): Map<string, string | undefined> {
  const byKey = new Map<string, string | undefined>();
  for (const d of docs) {
    if (typeof d?.id !== "string") continue;
    // PREFIX match on the id: `<KEY>_<slug>.md`. The separator is part of the
    // match so `MELOSYS-1` cannot claim `MELOSYS-1234_…`.
    const m = /^([A-Z][A-Z0-9]*-\d+)(?:[_.]|$)/.exec(d.id);
    if (!m) continue;
    if (!byKey.has(m[1]!)) byKey.set(m[1]!, typeof d.url === "string" ? d.url : undefined);
  }
  return byKey;
}

/**
 * Fetch (or reuse) the `jira-issues` document listing.
 *
 * Returns `null` on any failure — a degraded lookup must leave `resolved`
 * UNDEFINED rather than `false`, because "huginn is down" and "this key is
 * fabricated" are opposite conclusions and rendering the first as the second is
 * how a red row stops meaning anything.
 */
export async function loadJiraKeyIndex(
  knowledgeApiUrl: string,
  fetchApi: typeof fetchKnowledgeApi = fetchKnowledgeApi,
  now: number = Date.now(),
): Promise<KeyIndex | null> {
  if (cached && now - cached.fetchedAtMs < JIRA_KEY_INDEX_TTL_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const raw = (await fetchApi(
        knowledgeApiUrl,
        `/api/collection/${JIRA_ISSUES_COLLECTION}/documents`,
        { timeoutMs: 15_000 },
      )) as { documents?: unknown };
      const docs = Array.isArray(raw?.documents) ? (raw.documents as ListedDoc[]) : [];
      if (docs.length === 0) {
        // An EMPTY listing is treated as a failed lookup, not as "no issue
        // exists": it is indistinguishable from a mis-named collection, and
        // believing it would mark every real key in the draft as fabricated.
        log.warn("jira key index came back empty — treating as unavailable");
        return null;
      }
      const index: KeyIndex = { byKey: indexFromListing(docs), fetchedAtMs: now };
      cached = index;
      return index;
    } catch (err) {
      log.warn("jira key index fetch failed error={error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// ── The pass ─────────────────────────────────────────────────────────────────

export interface VerifyKeysInput {
  markdown: string;
  /** The RETAINED citations — after `excludeDocIds` and renumbering. */
  citations: JiraCitation[];
  /** The reader's raw material, scanned for the amber state. */
  notes: string;
  knowledgeApiUrl: string;
  /** Test seam. */
  fetchApi?: typeof fetchKnowledgeApi;
}

/**
 * Classify every Jira key in the generated markdown.
 *
 * Returns one verdict per DISTINCT key, in first-seen order. Never throws: an
 * unavailable listing yields `resolved: undefined` on every row and the three
 * grounding states still hold, because they are computed from the citations and
 * the notes, which are always in hand.
 */
export async function verifyJiraKeys(input: VerifyKeysInput): Promise<JiraKeyVerdict[]> {
  const keys = extractJiraKeys(input.markdown);
  if (keys.length === 0) return [];

  const retrieved = new Map<string, string | undefined>();
  for (const c of input.citations) {
    if (c.key) retrieved.set(c.key, c.url);
  }
  // The notes are scanned with the SAME extractor, denylist included: a
  // `UTF-8` in the raw material must not turn a `UTF-8` in the draft amber.
  const inNotes = new Set(extractJiraKeys(input.notes));

  const index = await loadJiraKeyIndex(input.knowledgeApiUrl, input.fetchApi);

  return keys.map((key) => {
    const state = retrieved.has(key) ? "verified" : inNotes.has(key) ? "notes" : "unknown";
    const resolvedUrl = index?.byKey.get(key);
    const verdict: JiraKeyVerdict = { key, state };
    if (index) verdict.resolved = index.byKey.has(key);
    const url = retrieved.get(key) ?? resolvedUrl;
    if (url) verdict.url = url;
    return verdict;
  });
}
