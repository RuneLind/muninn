/**
 * `loadIssueFields` — huginn's `jira-issues` listing WITH issue fields
 * (`include_issue_fields=true`, huginn #138), reduced to one fact set per key.
 *
 * Its own loader and its own cache: the Jira composer's `loadJiraKeyIndex`
 * (`src/jira/verify-keys.ts`) keeps the cheap key → url listing, and this one
 * pays for the wider payload only where Connections renders.
 *
 * Only the `jira-issues` collection is read. Other collections carry `status`
 * values of their own that mean nothing here.
 */

import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getLog } from "../../logging.ts";
import { JIRA_KEY_SHAPE } from "../provenance.ts";
import type { IssueFacts } from "./types.ts";

const log = getLog("wiki", "issue-fields");

export const ISSUE_FIELDS_COLLECTION = "jira-issues";
/** Same freshness as `loadJiraKeyIndex`: a status is as stale as huginn's
 *  capture anyway, and the listing is one fetch per ten minutes. */
export const ISSUE_FIELDS_TTL_MS = 10 * 60_000;
/** A failed fetch is remembered this long, so a down huginn does not cost every
 *  page open its timeout. */
export const ISSUE_FIELDS_FAIL_TTL_MS = 60_000;
const ISSUE_FIELDS_TIMEOUT_MS = 15_000;

/**
 * A Jira `updated` stamp as epoch ms, or null. Offsets come as `+0100` or
 * `+02:00`; a YAML-escaped `\:` is read as `:`. Parsed by hand rather than by
 * `Date.parse`, whose acceptance of `+0100` is an engine detail.
 */
export function parseIssueUpdated(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\\:/g, ":");
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac, tz] = m;
  const ms = frac ? Number((frac + "00").slice(0, 3)) : 0;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0), ms);
  if (Number.isNaN(t)) return null;
  if (tz && tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  return t;
}

interface ListedIssueDoc {
  id?: unknown;
  status?: unknown;
  title?: unknown;
  issue_type?: unknown;
  epic_link?: unknown;
  epic_summary?: unknown;
  updated?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * One fact set per key. The key is the document id's prefix before the first
 * `_` (`KEY_Summary_words.md`), uppercased; an id that yields no key shape is
 * skipped.
 *
 * Some keys have two documents. The one with the NEWEST parsed `updated` wins;
 * a document whose `updated` fails to parse loses to any that parses; a tie —
 * equal instants, or neither parses — goes to the lexically smaller id, so the
 * pick never depends on listing order. A string comparison of the stamps would
 * pick the wrong twin across a `+0100`/`+0200` offset change.
 */
export function pickIssueFields(docs: readonly unknown[]): Map<string, IssueFacts> {
  const best = new Map<string, { id: string; at: number | null; facts: IssueFacts }>();
  for (const raw of docs) {
    if (!raw || typeof raw !== "object") continue;
    const doc = raw as ListedIssueDoc;
    const id = typeof doc.id === "string" ? doc.id : "";
    const cut = id.indexOf("_");
    const key = (cut > 0 ? id.slice(0, cut) : id.replace(/\.md$/i, "")).trim().toUpperCase();
    if (!JIRA_KEY_SHAPE.test(key)) continue;
    const at = parseIssueUpdated(doc.updated);
    const updated = str(doc.updated)?.replace(/\\:/g, ":");
    const facts: IssueFacts = {
      ...(str(doc.title) ? { title: str(doc.title) } : {}),
      ...(str(doc.status) ? { status: str(doc.status) } : {}),
      ...(str(doc.issue_type) ? { issueType: str(doc.issue_type) } : {}),
      ...(str(doc.epic_link) ? { epicLink: str(doc.epic_link) } : {}),
      ...(str(doc.epic_summary) ? { epicSummary: str(doc.epic_summary) } : {}),
      ...(at !== null && updated ? { updated } : {}),
    };
    const held = best.get(key);
    if (!held || newer({ id, at }, held)) best.set(key, { id, at, facts });
  }
  const out = new Map<string, IssueFacts>();
  for (const [key, { facts }] of best) out.set(key, facts);
  return out;
}

function newer(a: { id: string; at: number | null }, b: { id: string; at: number | null }): boolean {
  if (a.at !== null && b.at === null) return true;
  if (a.at === null && b.at !== null) return false;
  if (a.at !== null && b.at !== null && a.at !== b.at) return a.at > b.at;
  return a.id < b.id;
}

interface Held {
  facts: Map<string, IssueFacts>;
  fetchedAtMs: number;
}
const cached = new Map<string, Held>();
const failedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<Map<string, IssueFacts> | null>>();

/** Test-only: forget every cached listing and failure. */
export function __resetIssueFieldsCacheForTest(): void {
  cached.clear();
  failedAt.clear();
  inFlight.clear();
}

/**
 * The per-key facts, or null when huginn could not be read. Never throws. An
 * EMPTY listing is a failure too: it cannot be told from a mis-named
 * collection, and believing it would report every key as unknown.
 */
export async function loadIssueFields(
  knowledgeApiUrl: string,
  fetchApi: typeof fetchKnowledgeApi = fetchKnowledgeApi,
  now: number = Date.now(),
): Promise<Map<string, IssueFacts> | null> {
  const held = cached.get(knowledgeApiUrl);
  if (held && now - held.fetchedAtMs < ISSUE_FIELDS_TTL_MS) return held.facts;
  const failed = failedAt.get(knowledgeApiUrl);
  if (failed !== undefined && now - failed < ISSUE_FIELDS_FAIL_TTL_MS) return null;
  const running = inFlight.get(knowledgeApiUrl);
  if (running) return running;

  const pending = (async () => {
    try {
      const raw = (await fetchApi(
        knowledgeApiUrl,
        `/api/collection/${ISSUE_FIELDS_COLLECTION}/documents?include_issue_fields=true`,
        { timeoutMs: ISSUE_FIELDS_TIMEOUT_MS },
      )) as { documents?: unknown };
      const docs = Array.isArray(raw?.documents) ? raw.documents : [];
      if (docs.length === 0) throw new Error("listing came back empty");
      const facts = pickIssueFields(docs);
      cached.set(knowledgeApiUrl, { facts, fetchedAtMs: now });
      failedAt.delete(knowledgeApiUrl);
      return facts;
    } catch (err) {
      failedAt.set(knowledgeApiUrl, now);
      log.info("issue fields unavailable from {url}: {error}", {
        url: knowledgeApiUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      inFlight.delete(knowledgeApiUrl);
    }
  })();
  inFlight.set(knowledgeApiUrl, pending);
  return pending;
}
