/**
 * Fact check for `/summaries` — the doc panel's ✓ Fact check.
 *
 *  - `GET /api/summaries/factcheck?source=&docId=` (SSE) runs the wiki's engine
 *    (`streamFactcheckSSE`, article mode) over the summary's source text, cut
 *    above `## Transcript` / `## Visual reference` (`summaryFactcheckBody`), on
 *    the SUMMARIZER bot. A run that reaches `done` saves its result through the
 *    engine's `onDone` hook; a failed or aborted one saves nothing, so an earlier
 *    result survives it.
 *  - `GET /api/summaries/factcheck/result?source=&docId=` — the saved row, plus
 *    `stale` when the summary text changed since the check (`null` when the
 *    source file could not be read to compare).
 *  - `GET /api/summaries/factcheck/badges` — every checked document's ✓/❌N
 *    badge, one query, for the Latest rail.
 *  - `POST /api/summaries/factcheck/transcript` — the saved claims against the
 *    document's transcript (`summaries-factcheck-transcript.ts`); `/result`
 *    carries its verdicts and `hasTranscript`, which gates the button.
 *
 * Addressed by `{source, docId}` like share and export: the doc id is what the
 * panel holds, and a re-run keeps it. Registered inside the `summaries` route
 * group, so the `nais` drop and the admin zone apply unchanged.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { executeOneShot } from "../../ai/one-shot.ts";
import { connectorCapabilities } from "../../ai/one-shot.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { filterDocumentText, readSummarySourceText } from "../../summaries/source-text.ts";
import { buildSummaryFactcheckBlock, factcheckBlockDate } from "../../summaries/factcheck-block.ts";
import { encodeDocIdPath, getSummarySource, isSafeDocId, SUMMARY_SOURCES } from "../../summaries/sources.ts";
import { factcheckBodySha256, summaryFactcheckBody } from "../../summaries/factcheck-body.ts";
import {
  getSummaryFactcheck,
  listSummaryFactcheckBadges,
  saveSummaryTranscriptCheck,
  summaryFactcheckTranscriptColumnsPresent,
  summaryFactchecksHasAppliedAt,
  upsertSummaryFactcheck,
  type SavedFactcheckClaim,
  type SummaryFactcheck,
  type SummaryFactcheckBadge,
  type SummaryFactcheckInput,
} from "../../db/summary-factchecks.ts";
import { sourcesLineUrls, streamFactcheckSSE, type ClaimOutcome, type FactcheckDoneResult } from "./factcheck-sse.ts";
import { summaryDocTitle, type SummaryShareDoc } from "./summaries-share.ts";
import { renderAskAnswerHtml } from "../../wiki/ask-render.ts";
import { enhanceConfidenceHtml } from "../views/components/wiki-ask-render.ts";
import { getLog } from "../../logging.ts";
import { documentTranscript, registerSummariesTranscriptCheckRoute, transcriptSha256 } from "./summaries-factcheck-transcript.ts";
import { renderTranscriptCheckHtml } from "../views/components/sum-transcript-render.ts";
import type { TranscriptCheckOptions } from "../../summaries/transcript-check.ts";
import { MIGRATION_080_ERROR } from "./summaries-factcheck-writeback.ts";

const log = getLog("dashboard", "summaries-factcheck");

const DOC_FETCH_TIMEOUT_MS = 10_000;

/** A fact-check answer as reader HTML — the wiki's own pipeline plus its
 *  confidence chips, rendered here so the /summaries bundle carries no
 *  markdown renderer. */
export function renderSummaryFactcheckHtml(answer: string): string {
  return enhanceConfidenceHtml(renderAskAnswerHtml(answer, []));
}

/** The engine's `ClaimOutcome`s that mean "no ruling was reached". */
const PARTIAL_OUTCOMES: ReadonlySet<ClaimOutcome> = new Set(["error", "timeout", "skipped"]);

/** Did any claim end without a ruling? */
export function isPartialRun(result: Pick<FactcheckDoneResult, "claims">): boolean {
  return result.claims.some((c) => PARTIAL_OUTCOMES.has(c.outcome));
}

export interface SummariesFactcheckDeps {
  /** The source file, frontmatter stripped (`readSummarySourceText`); `null` when unreadable. */
  readSourceText: (collection: string, docId: string) => Promise<string | null>;
  /** huginn's document JSON, for the title and url. `null` when unreadable. */
  fetchDocMeta: (collection: string, docId: string) => Promise<SummaryShareDoc | null>;
  store: {
    upsert: (row: SummaryFactcheckInput) => Promise<SummaryFactcheck>;
    get: (collection: string, docId: string) => Promise<SummaryFactcheck | null>;
    listBadges: () => Promise<SummaryFactcheckBadge[]>;
    /** Save a transcript check; `false` when the row's claims are no longer `expectClaims`. */
    saveTranscript: typeof saveSummaryTranscriptCheck;
    /** Whether migration 081's columns exist. */
    transcriptColumnsPresent: () => Promise<boolean>;
    /** Migration 080's `applied_at` exists. The check route's upsert writes it,
     *  so without it a full web check would end in a failed save: refused
     *  first. Absent ⇒ assumed present (tests). */
    schemaReady?: () => Promise<boolean>;
  };
  bots: () => BotConfig[];
  /** Test seam threaded into the engine; production leaves it unset. */
  oneShot?: typeof executeOneShot;
  /** Test seam for the transcript check's model call; production leaves it unset. */
  transcriptCall?: TranscriptCheckOptions["call"];
}

export function defaultSummariesFactcheckDeps(knowledgeApiUrl: string): SummariesFactcheckDeps {
  return {
    readSourceText: (collection, docId) =>
      readSummarySourceText(knowledgeApiUrl, collection, encodeDocIdPath(docId), DOC_FETCH_TIMEOUT_MS),
    fetchDocMeta: async (collection, docId) =>
      (await fetchKnowledgeApi(
        knowledgeApiUrl,
        `/api/document/${encodeURIComponent(collection)}/${encodeDocIdPath(docId)}`,
        { timeoutMs: DOC_FETCH_TIMEOUT_MS },
      )) as SummaryShareDoc | null,
    store: {
      upsert: upsertSummaryFactcheck,
      get: getSummaryFactcheck,
      listBadges: listSummaryFactcheckBadges,
      saveTranscript: saveSummaryTranscriptCheck,
      transcriptColumnsPresent: summaryFactcheckTranscriptColumnsPresent,
      schemaReady: summaryFactchecksHasAppliedAt,
    },
    bots: discoverAllBots,
  };
}

/** The rows a `done` saves: the engine's per-claim results, sources pulled off
 *  each block's `Sources:` line. */
export function savedClaims(result: FactcheckDoneResult): SavedFactcheckClaim[] {
  return result.claims.map((c) => ({
    index: c.index,
    title: c.title,
    ...(c.quote ? { quote: c.quote } : {}),
    verdict: c.verdict,
    outcome: c.outcome,
    ...(typeof c.confidence === "number" ? { confidence: c.confidence } : {}),
    sources: sourcesLineUrls(c.markdown),
  }));
}

/** The reason a bot cannot run the check, or `null` when it can. */
export function summaryFactcheckBotRefusal(bot: BotConfig | undefined): string | null {
  if (!bot) return "No bots configured to run a fact check.";
  if (!connectorCapabilities(bot).supportsWebTools) {
    return (
      `The summarizer bot (${bot.name}) can't run web fact-checks — its connector has no web tools. ` +
      `Set SUMMARIZER_BOT to a claude-cli or claude-sdk bot.`
    );
  }
  return null;
}

type Resolved = { ok: true; collection: string; docId: string } | { ok: false; error: string };

function resolveDoc(sourceId: string, docId: string): Resolved {
  if (!sourceId || !docId) return { ok: false, error: "Missing query parameter: source and docId" };
  const source = getSummarySource(sourceId);
  if (!source) return { ok: false, error: `unknown summary source "${sourceId}"` };
  if (!isSafeDocId(docId)) return { ok: false, error: "docId is not a document path" };
  return { ok: true, collection: source.collection, docId };
}

export function registerSummariesFactcheckRoutes(
  app: Hono,
  config: Config,
  deps: SummariesFactcheckDeps = defaultSummariesFactcheckDeps(config.knowledgeApiUrl),
): void {
  app.get("/api/summaries/factcheck", async (c) => {
    const doc = resolveDoc(c.req.query("source") ?? "", c.req.query("docId") ?? "");
    if (!doc.ok) return c.json({ error: doc.error }, 400);
    const { collection, docId } = doc;

    const bot = resolveSummarizerBot(deps.bots());
    const refusal = summaryFactcheckBotRefusal(bot);
    if (refusal || !bot) return c.json({ error: refusal }, 503);
    try {
      if (deps.store.schemaReady && !(await deps.store.schemaReady())) {
        return c.json({ error: MIGRATION_080_ERROR, code: "migration_080" }, 503);
      }
    } catch (err) {
      log.warn("Summary factcheck: schema check failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "fact-check lookup failed" }, 500);
    }

    const [sourceText, meta] = await Promise.all([
      deps.readSourceText(collection, docId),
      deps.fetchDocMeta(collection, docId).catch(() => null),
    ]);
    const title = summaryDocTitle(docId, meta);
    const body = sourceText === null ? "" : summaryFactcheckBody(sourceText);
    let preflightError: string | null = null;
    if (sourceText === null) preflightError = `Could not read "${title}" from the archive.`;
    else if (!body.trim()) preflightError = `"${title}" has no summary text to check.`;
    const bodySha256 = sourceText === null ? "" : factcheckBodySha256(sourceText);
    if (!preflightError) {
      log.info("Summary factcheck: collection={collection} doc={doc} bot={bot}", { collection, doc: docId, bot: bot.name });
    }

    return streamFactcheckSSE(c, {
      config,
      botConfig: bot,
      preflightError,
      body,
      meta: { title, tags: [], type: "summary" },
      // The prompts name the "wiki" the claim came from; the collection is the
      // honest answer for a capture.
      wikiName: collection,
      mode: "article",
      baseHash: bodySha256,
      renderAnswerHtml: renderSummaryFactcheckHtml,
      ...(deps.oneShot ? { oneShot: deps.oneShot } : {}),
      onDone: async (result) => {
        // A run where every claim timed out or was skipped holds no verdict;
        // saving it would replace a real earlier result with nothing.
        if (result.claimCount === 0) return { saved: false, reason: "no-verdict" };
        try {
          // A partial run (a claim errored, timed out or was skipped) never
          // replaces a FRESH earlier result. A stale one describes text that
          // is gone, and with none at all a partial result is still better.
          if (isPartialRun(result)) {
            const earlier = await deps.store.get(collection, docId);
            if (earlier && earlier.bodySha256 === bodySha256) return { saved: false, reason: "partial" };
          }
          const row = await deps.store.upsert({
            collection,
            docId,
            url: meta?.url?.trim() || null,
            bodySha256,
            answer: result.answer,
            claims: savedClaims(result),
            botName: bot.name,
          });
          return { saved: true, checkedAt: row.createdAt };
        } catch (err) {
          log.warn("Summary factcheck: save failed collection={collection} doc={doc}: {error}", {
            collection,
            doc: docId,
            error: err instanceof Error ? err.message : String(err),
          });
          return { saved: false };
        }
      },
    });
  });

  app.get("/api/summaries/factcheck/result", async (c) => {
    const doc = resolveDoc(c.req.query("source") ?? "", c.req.query("docId") ?? "");
    if (!doc.ok) return c.json({ error: doc.error }, 400);
    c.header("Cache-Control", "no-store");
    let row: SummaryFactcheck | null;
    try {
      row = await deps.store.get(doc.collection, doc.docId);
    } catch (err) {
      log.warn("Summary factcheck: result lookup failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "fact-check lookup failed" }, 500);
    }
    if (!row) return c.json({ result: null, stale: null });
    const sourceText = await deps.readSourceText(doc.collection, doc.docId);
    // The transcript check's button needs a transcript (the re-run options'
    // `hasTranscript`, same split); `null` when the file is unreadable.
    const transcript = sourceText === null ? null : documentTranscript(sourceText);
    const hasTranscript = sourceText === null ? null : transcript !== null;
    const stale = sourceText === null ? null : factcheckBodySha256(sourceText) !== row.bodySha256;
    const transcriptStale =
      !row.transcript || !row.transcriptSha256 || sourceText === null
        ? null
        : transcript === null || transcriptSha256(transcript) !== row.transcriptSha256;
    // Whether the document carries THIS check's block (➕ Add shows "added").
    const blockAdded =
      sourceText === null
        ? null
        : sourceText.includes(filterDocumentText(buildSummaryFactcheckBlock(row.answer, factcheckBlockDate(row.createdAt))));
    return c.json({
      result: row,
      stale,
      blockAdded,
      html: renderSummaryFactcheckHtml(row.answer),
      hasTranscript,
      transcriptStale,
      transcriptHtml: row.transcript ? renderTranscriptCheckHtml(row.claims, row.transcript, { stale: transcriptStale }) : null,
    });
  });

  registerSummariesTranscriptCheckRoute(app, deps);

  app.get("/api/summaries/factcheck/badges", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const sourceOf = new Map(SUMMARY_SOURCES.map((s) => [s.collection, s.id]));
      const badges = (await deps.store.listBadges()).flatMap((b) => {
        const source = sourceOf.get(b.collection);
        return source ? [{ source, docId: b.docId, bad: b.bad, total: b.total }] : [];
      });
      return c.json({ badges });
    } catch (err) {
      log.warn("Summary factcheck: badge lookup failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ badges: [], error: "badge lookup failed" });
    }
  });
}
