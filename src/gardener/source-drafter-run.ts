/**
 * Production wiring for the source-page drafter — binds `draftSourcePage`'s
 * injected seams to the real huginn / wiki-index / DB / one-shot implementations.
 *
 * Two entry points:
 *  - `runSourceDraftForNewest` — the RUN-NOW trigger: pick the newest doc in a
 *    collection (metadata-only listing → fetch its body + url), then draft it.
 *  - `triggerSourceDraftFromCapture` — the fire-and-forget AUTO trigger: draft
 *    the just-finished capture IN-PROCESS from the summary already in hand (no
 *    huginn re-fetch — ingest is best-effort and indexing may lag).
 */

import type { BotConfig } from "../bots/config.ts";
import type { ListedDoc, RawFetchedDoc } from "./types.ts";
import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import { getWikiIndex } from "../wiki/store.ts";
import { collectWikiRefs } from "../wiki/ingest-backlog.ts";
import { getLiveTopicKeys, insertWikiProposal } from "../db/wiki-proposals.ts";
import { loadConfig } from "../config.ts";
import { docDateMs } from "./harvest.ts";
import { todayOslo } from "./util.ts";
import { DRAFT_TIMEOUT_MS } from "./backlog.ts";
import { runDrafterOneShot } from "./drafter-oneshot.ts";
import {
  draftSourcePage,
  type SourceDraftInput,
  type SourceDraftOutcome,
} from "./source-drafter.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "source-drafter");

const DEFAULT_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";
const DOC_FETCH_TIMEOUT_MS = 15_000;

/** The first public http(s) URL among the candidates, or "" when none is public. */
function firstHttpUrl(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//i.test(c.trim())) return c.trim();
  }
  return "";
}

/**
 * Build the real-seam deps and run `draftSourcePage` for one input. `wikiDir` must
 * be the bot's resolved wiki root. `apiUrl` defaults to the env knowledge API.
 */
export async function runSourceDraftForInput(
  botConfig: BotConfig,
  wikiDir: string,
  input: SourceDraftInput,
  apiUrl: string = DEFAULT_API_URL,
): Promise<SourceDraftOutcome> {
  const config = loadConfig();
  const index = await getWikiIndex({ root: wikiDir });
  return draftSourcePage({
    botName: botConfig.name,
    wikiDir,
    input,
    index,
    today: todayOslo(Date.now()),
    collectWikiRefs,
    liveTopicKeys: () => getLiveTopicKeys(botConfig.name),
    insertProposal: (params) => insertWikiProposal(params),
    callDrafter: async (prompt, title) => {
      const res = await runDrafterOneShot({
        title,
        url: input.url,
        prompt,
        config,
        botConfig,
        timeoutMs: DRAFT_TIMEOUT_MS,
      });
      return res.result;
    },
  });
}

/**
 * RUN-NOW: draft the NEWEST doc in `collection`. Lists metadata only
 * (`?include_dates=1` → id/url/date, no title/content — the drafter synthesizes the
 * title), picks the newest by date, fetches its body + url via
 * `GET /api/document/<collection>/<id>`, then drafts it. Returns a "skipped" outcome
 * (never throws) when the collection is empty or the fetch yields no body/url.
 */
export async function runSourceDraftForNewest(
  botConfig: BotConfig,
  wikiDir: string,
  collection: string,
  apiUrl: string = DEFAULT_API_URL,
): Promise<SourceDraftOutcome> {
  let listed: ListedDoc[];
  try {
    const data = await fetchKnowledgeApi(
      apiUrl,
      `/api/collection/${encodeURIComponent(collection)}/documents?include_dates=1`,
    );
    listed = Array.isArray(data?.documents) ? (data.documents as ListedDoc[]) : [];
  } catch (err) {
    return { outcome: "error", reason: `listing ${collection} failed: ${errMsg(err)}` };
  }
  if (listed.length === 0) {
    return { outcome: "skipped", reason: `collection ${collection} is empty` };
  }

  // Newest-first by listing date (undated sorts last).
  const newest = [...listed].sort(
    (a, b) =>
      (docDateMs({ id: b.id, date: b.date }) ?? Number.NEGATIVE_INFINITY) -
      (docDateMs({ id: a.id, date: a.date }) ?? Number.NEGATIVE_INFINITY),
  )[0]!;

  let doc: RawFetchedDoc | null;
  try {
    doc = await fetchKnowledgeApi(
      apiUrl,
      `/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(newest.id)}`,
      { timeoutMs: DOC_FETCH_TIMEOUT_MS },
    );
  } catch (err) {
    return { outcome: "error", reason: `fetching ${collection}/${newest.id} failed: ${errMsg(err)}` };
  }

  const body = (doc?.text ?? "").trim();
  const url = firstHttpUrl(doc?.metadata?.url, doc?.url, newest.url);
  if (!body) return { outcome: "skipped", reason: `doc ${collection}/${newest.id} has no body` };
  if (!url) return { outcome: "skipped", reason: `doc ${collection}/${newest.id} has no public URL` };

  log.info("Source drafter run-now: newest doc {collection}/{id}", { collection, id: newest.id });
  return runSourceDraftForInput(
    botConfig,
    wikiDir,
    { collection, docId: newest.id, url, body },
    apiUrl,
  );
}

/**
 * AUTO trigger: draft a source page for a just-finished capture, fire-and-forget.
 * The summary is handed in IN-PROCESS (no huginn re-fetch — best-effort ingest may
 * lag). Swallows every failure (logged) — a drafter hiccup must never fail the
 * capture job it rides behind. Skips silently when the bot has no `wikiDir`.
 */
export function triggerSourceDraftFromCapture(
  botConfig: BotConfig,
  input: SourceDraftInput,
  apiUrl: string = DEFAULT_API_URL,
): void {
  if (!botConfig.wikiDir) return;
  const wikiDir = botConfig.wikiDir;
  void runSourceDraftForInput(botConfig, wikiDir, input, apiUrl)
    .then((outcome) => {
      log.info("Source drafter auto-trigger for {collection}/{id}: {outcome}", {
        collection: input.collection,
        id: input.docId,
        outcome: outcome.outcome,
        ...("reason" in outcome ? { reason: outcome.reason } : {}),
      });
    })
    .catch((err) => {
      log.warn("Source drafter auto-trigger threw for {collection}/{id}: {error}", {
        collection: input.collection,
        id: input.docId,
        error: errMsg(err),
      });
    });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
