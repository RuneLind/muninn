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
import { JIRA_ISSUES_COLLECTION, jiraKeyFromDocId } from "../../jira/retrieval.ts";
import { getLog } from "../../logging.ts";
import type { IssueFacts } from "./types.ts";

const log = getLog("wiki", "issue-fields");

/** Same freshness as `loadJiraKeyIndex`: a status is as stale as huginn's
 *  capture anyway, and the listing is one fetch per ten minutes. */
const ISSUE_FIELDS_TTL_MS = 10 * 60_000;
/** A failed fetch is remembered this long, so a down huginn does not cost every
 *  page open its timeout. */
const ISSUE_FIELDS_FAIL_TTL_MS = 60_000;
const ISSUE_FIELDS_TIMEOUT_MS = 15_000;

/** A Jira `updated` stamp with a YAML-escaped `\:` read as `:`. */
const unescapeStamp = (s: string) => s.trim().replace(/\\:/g, ":");

/**
 * A Jira `updated` stamp as epoch ms, or null. Offsets come as `+0100` or
 * `+02:00`, at most ±14:00; a YAML-escaped `\:` is read as `:`. Parsed by hand
 * rather than by `Date.parse`, whose acceptance of `+0100` is an engine detail,
 * and every component range-checked, since `Date.UTC` rolls `2026-13-01` over
 * into the next year instead of refusing it.
 */
export function parseIssueUpdated(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    unescapeStamp(raw),
  );
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [
    number, number, number, number, number, number,
  ];
  const frac = m[7];
  const tz = m[8];
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || sec > 59) return null;
  let t = Date.UTC(y, mo - 1, d, h, mi, sec, frac ? Number((frac + "00").slice(0, 3)) : 0);
  if (tz && tz !== "Z") {
    const digits = tz.slice(1).replace(":", "");
    const offH = Number(digits.slice(0, 2));
    const offM = Number(digits.slice(2, 4));
    if (offM > 59 || offH * 60 + offM > 14 * 60) return null;
    t -= (tz[0] === "-" ? -1 : 1) * (offH * 60 + offM) * 60_000;
  }
  return t;
}

interface ListedIssueDoc {
  id?: unknown;
  status?: unknown;
  title?: unknown;
  epic_link?: unknown;
  epic_summary?: unknown;
  updated?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * One fact set per key. The key is `jiraKeyFromDocId`'s — the Jira composer's
 * own reading of a `KEY_Summary_words.md` id — so the strip, Connections and the
 * composer agree on which keys huginn holds; an id that yields none is skipped.
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
    const key = jiraKeyFromDocId(JIRA_ISSUES_COLLECTION, id);
    if (!key) continue;
    const at = parseIssueUpdated(doc.updated);
    const facts: IssueFacts = {
      ...(str(doc.title) ? { title: str(doc.title) } : {}),
      ...(str(doc.status) ? { status: str(doc.status) } : {}),
      ...(str(doc.epic_link) ? { epicLink: str(doc.epic_link) } : {}),
      ...(str(doc.epic_summary) ? { epicSummary: str(doc.epic_summary) } : {}),
      ...(at !== null ? { updated: unescapeStamp(doc.updated as string) } : {}),
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
/** Base URLs already warned about, so an outage warns once and then logs info
 *  (`verify-keys.ts`'s rule). Cleared on the next success. */
const warnedFailure = new Set<string>();
const inFlight = new Map<string, Promise<Map<string, IssueFacts> | null>>();

/** Test-only: forget every cached listing and failure. */
export function __resetIssueFieldsCacheForTest(): void {
  cached.clear();
  failedAt.clear();
  warnedFailure.clear();
  inFlight.clear();
}

/**
 * The per-key facts, or null when huginn could not be read and no listing was
 * ever read. Never throws. Past the TTL a failed refetch keeps serving the last
 * good listing (a status a little staler beats none); only a host with no good
 * listing answers null. An EMPTY listing is a failure too: it cannot be told
 * from a mis-named collection, and believing it would report every key as
 * unknown.
 */
export async function loadIssueFields(
  knowledgeApiUrl: string,
  fetchApi: typeof fetchKnowledgeApi = fetchKnowledgeApi,
  now: number = Date.now(),
): Promise<Map<string, IssueFacts> | null> {
  const held = cached.get(knowledgeApiUrl);
  if (held && now - held.fetchedAtMs < ISSUE_FIELDS_TTL_MS) return held.facts;
  const failed = failedAt.get(knowledgeApiUrl);
  if (failed !== undefined && now - failed < ISSUE_FIELDS_FAIL_TTL_MS) return held?.facts ?? null;
  const running = inFlight.get(knowledgeApiUrl);
  if (running) return running;

  const pending = (async () => {
    try {
      const raw = (await fetchApi(
        knowledgeApiUrl,
        `/api/collection/${JIRA_ISSUES_COLLECTION}/documents?include_issue_fields=true`,
        { timeoutMs: ISSUE_FIELDS_TIMEOUT_MS },
      )) as { documents?: unknown };
      const docs = Array.isArray(raw?.documents) ? raw.documents : [];
      if (docs.length === 0) throw new Error("listing came back empty");
      const facts = pickIssueFields(docs);
      cached.set(knowledgeApiUrl, { facts, fetchedAtMs: now });
      failedAt.delete(knowledgeApiUrl);
      warnedFailure.delete(knowledgeApiUrl);
      return facts;
    } catch (err) {
      failedAt.set(knowledgeApiUrl, now);
      const props = {
        url: knowledgeApiUrl,
        error: err instanceof Error ? err.message : String(err),
        stale: held ? "serving the last good listing" : "no listing to serve",
      };
      if (warnedFailure.has(knowledgeApiUrl)) log.info("issue fields still unavailable from {url}: {error} ({stale})", props);
      else {
        warnedFailure.add(knowledgeApiUrl);
        log.warn("issue fields unavailable from {url}: {error} ({stale})", props);
      }
      return held?.facts ?? null;
    } finally {
      inFlight.delete(knowledgeApiUrl);
    }
  })();
  inFlight.set(knowledgeApiUrl, pending);
  return pending;
}
