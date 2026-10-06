/**
 * `POST /api/summaries/factcheck/transcript` — the doc panel's "Check
 * transcript": the saved web check's claims against the document's own
 * `## Transcript` appendix (`src/summaries/transcript-check.ts`).
 *
 * One model call, so a JSON request and a JSON response rather than the SSE
 * engine. `application/json` is required (the re-run POST's rule); being a
 * POST, the origin guard covers it by method. Preflight: a summarizer bot (no
 * web tools needed — the call reads only the transcript), migration 081's
 * columns (503 naming it otherwise), a saved web check with claims that is
 * still fresh (409 `web_check_stale` once the summary changed since it, the
 * `/result` route's `stale` rule), and a transcript. The verdicts are saved onto
 * the web row only while its claim set is still the one they were given.
 */

import type { Hono } from "hono";
import { createHash } from "node:crypto";
import { resolveSummarizerBot } from "../../bots/config.ts";
import { splitTranscript } from "../../summaries/transcript-split.ts";
import { factcheckBodySha256 } from "../../summaries/factcheck-body.ts";
import {
  checkClaimsAgainstTranscript,
  describeCut,
  type SavedTranscriptCheck,
  type TranscriptCheckOptions,
} from "../../summaries/transcript-check.ts";
import type { SavedFactcheckClaim } from "../../db/summary-factchecks.ts";
import { renderTranscriptCheckHtml } from "../views/components/sum-transcript-render.ts";
import { requireJsonRequest } from "./json-request.ts";
import type { SummariesFactcheckDeps } from "./summaries-factcheck.ts";
import { getSummarySource, isSafeDocId } from "../../summaries/sources.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "summaries-factcheck-transcript");

export const TRANSCRIPT_MIGRATION_MISSING =
  "The transcript check needs migration 081 (summary_factchecks.transcript_claims and transcript_sha256). Run `bun run db:migrate`.";

/**
 * The document's transcript appendix, trimmed, or `null` when it has none —
 * the re-run options' `splitTranscript` predicate. `sourceText` is the body
 * `readSummarySourceText` returns, frontmatter already stripped; stripping
 * again would eat a body that opens with a `---` rule.
 */
export function documentTranscript(sourceText: string): string | null {
  const t = splitTranscript(sourceText).transcript?.trim();
  return t ? t : null;
}

export function transcriptSha256(transcript: string): string {
  return createHash("sha256").update(transcript).digest("hex");
}

export function registerSummariesTranscriptCheckRoute(app: Hono, deps: SummariesFactcheckDeps): void {
  const inFlight = new Set<string>();

  app.post("/api/summaries/factcheck/transcript", async (c) => {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const parsed: unknown = await c.req.json().catch(() => undefined);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return c.json({ error: "the body must be a JSON object with source and docId", code: "bad_request" }, 400);
    }
    const body = parsed as { source?: unknown; docId?: unknown };
    const sourceId = typeof body.source === "string" ? body.source.trim() : "";
    const docId = typeof body.docId === "string" ? body.docId.trim() : "";
    if (!sourceId || !docId) return c.json({ error: "source and docId are required", code: "bad_request" }, 400);
    const source = getSummarySource(sourceId);
    if (!source) return c.json({ error: `unknown summary source "${sourceId}"`, code: "bad_source" }, 400);
    if (!isSafeDocId(docId)) return c.json({ error: "docId is not a document path", code: "bad_doc_id" }, 400);
    const collection = source.collection;

    const bot = resolveSummarizerBot(deps.bots());
    if (!bot) return c.json({ error: "No bots configured to run a transcript check.", code: "no_bot" }, 503);
    try {
      if (!(await deps.store.transcriptColumnsPresent())) {
        return c.json({ error: TRANSCRIPT_MIGRATION_MISSING, code: "migration_081" }, 503);
      }
    } catch (err) {
      log.warn("Transcript check: schema probe failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "fact-check lookup failed", code: "db" }, 500);
    }

    const key = `${collection}\u0000${docId}`;
    if (inFlight.has(key)) return c.json({ error: "A transcript check is already running for this document.", code: "in_flight" }, 409);
    inFlight.add(key);
    try {
      let row;
      try {
        row = await deps.store.get(collection, docId);
      } catch (err) {
        log.warn("Transcript check: row lookup failed: {error}", { error: err instanceof Error ? err.message : String(err) });
        return c.json({ error: "fact-check lookup failed", code: "db" }, 500);
      }
      if (!row || row.claims.length === 0) {
        return c.json({ error: "Run the web fact check first: the transcript check reads its claims.", code: "no_web_check" }, 409);
      }
      const sourceText = await deps.readSourceText(collection, docId);
      if (sourceText === null) return c.json({ error: "Could not read the document from the archive.", code: "upstream" }, 502);
      const transcript = documentTranscript(sourceText);
      if (!transcript) return c.json({ error: "This document has no transcript to check against.", code: "no_transcript" }, 409);
      if (factcheckBodySha256(sourceText) !== row.bodySha256) {
        return c.json(
          { error: "The summary changed since the web fact check; re-check it first, then check the transcript.", code: "web_check_stale" },
          409,
        );
      }

      const claims: SavedFactcheckClaim[] = row.claims;
      const opts: TranscriptCheckOptions = {
        botName: bot.name,
        connector: bot.connector,
        haikuBackend: bot.haikuBackend,
        ...(deps.transcriptCall ? { call: deps.transcriptCall } : {}),
      };
      let result;
      try {
        result = await checkClaimsAgainstTranscript(
          claims.map((cl) => ({ index: cl.index, title: cl.title, ...(cl.quote ? { quote: cl.quote } : {}) })),
          transcript,
          opts,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Transcript check failed collection={collection} doc={doc}: {error}", { collection, doc: docId, error: message });
        return c.json({ error: `Transcript check failed: ${message}`, code: "check_failed" }, 502);
      }
      log.info("Transcript check: collection={collection} doc={doc} claims={n} cut={cut} model={model} ms={ms}", {
        collection,
        doc: docId,
        n: result.claims.length,
        cut: result.cut.truncated,
        model: result.model,
        ms: result.latencyMs,
      });

      const check: SavedTranscriptCheck = {
        claims: result.claims,
        cut: result.cut,
        model: result.model,
        ...(result.backend ? { backend: result.backend } : {}),
        botName: bot.name,
        checkedAt: Date.now(),
      };
      let savedOk: boolean;
      try {
        savedOk = await deps.store.saveTranscript({ collection, docId, expectClaims: claims, check, transcriptSha256: transcriptSha256(transcript) });
      } catch (err) {
        log.warn("Transcript check: save failed: {error}", { error: err instanceof Error ? err.message : String(err) });
        return c.json({ error: "Checked, but the result could not be saved.", code: "save_failed" }, 500);
      }
      if (!savedOk) {
        // No row matched: the web check was replaced meanwhile, or deleted.
        const now = await deps.store.get(collection, docId).catch(() => undefined);
        if (now === null) {
          return c.json({ error: "The fact check for this document no longer exists.", code: "not_found" }, 404);
        }
        return c.json({ error: "The web fact check changed while this ran; run the transcript check again.", code: "web_check_changed" }, 409);
      }
      return c.json({
        transcript: check,
        cutNote: describeCut(check.cut),
        html: renderTranscriptCheckHtml(claims, check),
      });
    } finally {
      inFlight.delete(key);
    }
  });
}
