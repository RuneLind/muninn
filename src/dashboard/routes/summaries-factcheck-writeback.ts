/**
 * Fact-check write-back for `/summaries`: `POST /api/summaries/factcheck/append`
 * (➕ Add), `…/integrate` (propose; writes nothing) and `…/integrate/apply`. The
 * contract — the D12 CAS, the claim, what apply refuses and how the row is
 * stamped — is in `src/summaries/CLAUDE.md` ("Fact-check write-back").
 */

import type { Context, Hono } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApiText, KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import { encodeDocIdPath, getSummarySource, isSafeDocId } from "../../summaries/sources.ts";
import {
  preflightSummarySave,
  readStoredCapture,
  requireSaveDescriptor,
  saveSummaryBody,
  summarySaveClaims,
  type SummarySaveClaims,
  type SummarySaveResult,
} from "../../summaries/summary-save.ts";
import type { SummaryIngest } from "../../summaries/summarizer-shared.ts";
import { filterDocumentText } from "../../summaries/source-text.ts";
import { checkedSha256OfRaw, summaryFactcheckBody } from "../../summaries/factcheck-body.ts";
import { sha256 } from "../../gardener/util.ts";
import {
  buildSummaryFactcheckBlock,
  factcheckBlockDate,
  insertSummaryFactcheckBlock,
} from "../../summaries/factcheck-block.ts";
import {
  claimEditCounts,
  proposeSummaryEdits,
  rebuildSummaryBody,
  resolveSummaryEdits,
  structuralLineRefusal,
  summaryEditorVoice,
  summaryEditSlices,
  summaryIntegrateBodyLen,
  summaryIntegratePreviewHtml,
  summaryPromptBody,
  summaryStructureChanged,
  unattributedEdits,
} from "../../summaries/factcheck-integrate.ts";
import { sourceKindNoun } from "../../summaries/source-noun.ts";
import { correctableClaims as savedCorrectableClaims } from "../../gardener/factcheck-carry.ts";
import {
  buildIntegratePrompt,
  changedCharsOfOutcomes,
  enforceEditBounds,
  INTEGRATE_BODY_MAX,
  INTEGRATE_MAX_EDIT_CHARS,
  INTEGRATE_MAX_EDITS,
  maxChangedChars,
  neutralizeFactcheckSentinels,
  parseEditList,
  type DroppedEdit,
  type IntegrateEdit,
} from "../../wiki/integrate-edits.ts";
import { runIntegrateOneShot } from "../../wiki/integrate-oneshot.ts";
import { parseFactcheckClaims } from "../views/components/wiki-integrate.ts";
import {
  getSummaryFactcheckVersioned,
  markSummaryFactcheckApplied,
  summaryFactchecksHasAppliedAt,
  type VersionedSummaryFactcheck,
} from "../../db/summary-factchecks.ts";
import { requireJsonRequest } from "./json-request.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "summaries-factcheck-writeback");

const RAW_READ_TIMEOUT_MS = 10_000;

/** How long append or apply may hold the document: a raw read, an ingest and a
 *  re-read, each bounded well under this. */
export const WRITEBACK_CLAIM_BUDGET_MS = 5 * 60_000;

export const MIGRATION_080_ERROR =
  "The summary_factchecks table has no applied_at column. Run migration 080 (bun run db:migrate) and retry.";

export interface SummariesFactcheckWritebackDeps {
  /** The raw file (`?raw=1`), or `null` when huginn has no such document.
   *  Throws on any other failure. */
  readRaw: (collection: string, docId: string) => Promise<string | null>;
  store: {
    get: (collection: string, docId: string) => Promise<VersionedSummaryFactcheck | null>;
    markApplied: typeof markSummaryFactcheckApplied;
    schemaReady: () => Promise<boolean>;
  };
  /** The model call: returns the one-shot's raw text. */
  integrate: (input: { title: string; collection: string; prompt: string; systemPrompt: string; bot: BotConfig }) => Promise<string>;
  bots: () => BotConfig[];
  ingest?: SummaryIngest;
  claims?: SummarySaveClaims;
  now?: () => number;
}

export function defaultSummariesFactcheckWritebackDeps(config: Config): SummariesFactcheckWritebackDeps {
  return {
    readRaw: async (collection, docId) => {
      try {
        return await fetchKnowledgeApiText(
          config.knowledgeApiUrl,
          `/api/document/${encodeURIComponent(collection)}/${encodeDocIdPath(docId)}?raw=1`,
          { timeoutMs: RAW_READ_TIMEOUT_MS },
        );
      } catch (err) {
        if (err instanceof KnowledgeApiError && err.upstreamStatus === 404) return null;
        throw err;
      }
    },
    store: {
      get: getSummaryFactcheckVersioned,
      markApplied: markSummaryFactcheckApplied,
      schemaReady: summaryFactchecksHasAppliedAt,
    },
    integrate: async ({ title, collection, prompt, systemPrompt, bot }) =>
      (
        await runIntegrateOneShot({
          pageTitle: title,
          wikiName: collection,
          prompt,
          systemPrompt,
          config,
          botConfig: bot,
          sourcePage: "/summaries",
        })
      ).result ?? "",
    bots: discoverAllBots,
  };
}

/** The row version propose hands out and apply compares (D12). */
export function factcheckRowVersion(row: Pick<VersionedSummaryFactcheck, "createdAtText" | "answer">): string {
  return `${row.createdAtText}|${sha256(row.answer)}`;
}

type Fail = { status: 400 | 404 | 409 | 500 | 502 | 503; body: Record<string, unknown> };
const fail = (status: Fail["status"], code: string, error: string, extra: Record<string, unknown> = {}): Fail => ({
  status,
  body: { error, code, ...extra },
});

interface Target {
  sourceId: string;
  collection: string;
  docId: string;
}

/** The JSON gate, the body's `{source, docId}`, and the migration check. */
async function readTarget(
  c: Context,
  deps: SummariesFactcheckWritebackDeps,
): Promise<{ ok: true; target: Target; body: Record<string, unknown> } | { ok: false; res: Response }> {
  const notJson = requireJsonRequest(c);
  if (notJson) return { ok: false, res: notJson };
  const parsed: unknown = await c.req.json().catch(() => null);
  const body: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const sourceId = typeof body.source === "string" ? body.source.trim() : "";
  const docId = typeof body.docId === "string" ? body.docId.trim() : "";
  const source = getSummarySource(sourceId);
  if (!source) return { ok: false, res: c.json({ error: `unknown summary source "${sourceId}"`, code: "bad_source" }, 400) };
  if (!docId || !isSafeDocId(docId)) {
    return { ok: false, res: c.json({ error: "docId is not a document path", code: "bad_doc_id" }, 400) };
  }
  let ready: boolean;
  try {
    ready = await deps.store.schemaReady();
  } catch (err) {
    log.warn("Summary factcheck write-back: schema check failed: {error}", { error: errText(err) });
    return { ok: false, res: c.json({ error: "fact-check lookup failed", code: "db" }, 500) };
  }
  if (!ready) return { ok: false, res: c.json({ error: MIGRATION_080_ERROR, code: "migration_080" }, 503) };
  return { ok: true, target: { sourceId, collection: source.collection, docId }, body };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadRow(deps: SummariesFactcheckWritebackDeps, t: Target): Promise<VersionedSummaryFactcheck | Fail> {
  try {
    const row = await deps.store.get(t.collection, t.docId);
    return row ?? fail(404, "no_result", "This summary has no saved fact check. Run ✓ Fact check first.");
  } catch (err) {
    log.warn("Summary factcheck write-back: row lookup failed: {error}", { error: errText(err) });
    return fail(500, "db", "fact-check lookup failed");
  }
}

async function loadRaw(deps: SummariesFactcheckWritebackDeps, t: Target): Promise<string | Fail> {
  try {
    const raw = await deps.readRaw(t.collection, t.docId);
    return raw ?? fail(404, "not_found", "No such document.");
  } catch (err) {
    log.warn("Summary factcheck write-back: raw read failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
    return fail(502, "upstream", "Could not read the stored document.");
  }
}

/** The propose/append CAS: the file's checked text against the row (D12), with
 *  D11's already-applied rule and D13's notice folded in. */
function hashRefusal(row: VersionedSummaryFactcheck, raw: string, forIntegrate: boolean): Fail | null {
  const fresh = checkedSha256OfRaw(raw) === row.bodySha256;
  if (!fresh) {
    return row.appliedAt
      ? fail(409, "recheck", "The summary changed since the integrate — re-check to re-apply.", { changedSinceApply: true })
      : fail(409, "recheck", "The summary changed since this fact check. Re-check it first.");
  }
  if (forIntegrate && row.appliedAt) {
    return fail(409, "already_applied", "These corrections are already integrated into the summary.");
  }
  return null;
}

/** A save that did not write, as a response body. */
function saveFailure(res: Extract<SummarySaveResult, { ok: false }>): Fail {
  return fail(res.status, res.code, res.error, res.siblingDocId !== undefined ? { siblingDocId: res.siblingDocId } : {});
}

/** The client's accepted edits, bounded HARD (the client echoes them). Each
 *  carries `claimEdits`, its claim's edit count from propose. */
function coerceAcceptedEdits(raw: unknown): { edits: IntegrateEdit[]; claimEdits: number[] } | string {
  if (!Array.isArray(raw) || raw.length === 0) return "edits must be a non-empty array";
  if (raw.length > INTEGRATE_MAX_EDITS) return `too many edits — the cap is ${INTEGRATE_MAX_EDITS} per apply`;
  const out: IntegrateEdit[] = [];
  const claimEdits: number[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return "every edit must be an object";
    const o = item as Record<string, unknown>;
    if (typeof o.old !== "string" || !o.old.trim() || typeof o.new !== "string" || !o.new) {
      return "every edit needs a non-empty old and new";
    }
    if (o.old.length > INTEGRATE_MAX_EDIT_CHARS || o.new.length > INTEGRATE_MAX_EDIT_CHARS) {
      return `an edit exceeds the ${INTEGRATE_MAX_EDIT_CHARS}-char per-edit limit`;
    }
    if (typeof o.claimEdits !== "number" || !Number.isInteger(o.claimEdits) || o.claimEdits < 1) {
      return "every edit needs its claim's edit count (claimEdits) from the preview";
    }
    claimEdits.push(o.claimEdits);
    out.push({
      claimIndex: typeof o.claimIndex === "number" && o.claimIndex > 0 ? Math.trunc(o.claimIndex) : 0,
      verdict: typeof o.verdict === "string" ? o.verdict : "",
      old: o.old,
      new: neutralizeFactcheckSentinels(o.new),
      reason: typeof o.reason === "string" ? o.reason : "",
    });
  }
  return { edits: out, claimEdits };
}

const PARTIAL_CLAIM_ERROR = "Apply takes a claim's edits together: this request carries only some of one claim's edits. Nothing was written.";

/** What became of the row after a written apply. */
export type ApplyStamp = "stamped" | "rechecked" | "row_gone" | "not_stamped" | "db_error";

const STAMP_MESSAGES: Record<Exclude<ApplyStamp, "stamped">, string> = {
  rechecked: "The summary was written, but the fact check was re-checked during apply, so it is not marked applied.",
  row_gone: "The summary was written, but its fact check was deleted during apply, so nothing is marked applied.",
  not_stamped: "The summary was written, but the fact check could not be marked applied. Re-check the summary to bring it up to date.",
  db_error:
    "The summary was written, but the fact check could not be marked applied (database error). Re-check the summary to bring it up to date.",
};

/** The row CAS, then — when it matched nothing — which of the three reasons it was. */
async function stampApplied(
  deps: SummariesFactcheckWritebackDeps,
  t: Target,
  row: VersionedSummaryFactcheck,
  bodySha256: string,
): Promise<ApplyStamp> {
  try {
    const ok = await deps.store.markApplied({
      collection: t.collection,
      docId: t.docId,
      createdAtText: row.createdAtText,
      answerSha256: sha256(row.answer),
      bodySha256,
    });
    if (ok) return "stamped";
    const now = await deps.store.get(t.collection, t.docId);
    if (!now) return "row_gone";
    return factcheckRowVersion(now) !== factcheckRowVersion(row) ? "rechecked" : "not_stamped";
  } catch (err) {
    log.warn("Summary factcheck apply: stamping the row failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
    return "db_error";
  }
}

export function registerSummariesFactcheckWritebackRoutes(
  app: Hono,
  config: Config,
  deps: SummariesFactcheckWritebackDeps = defaultSummariesFactcheckWritebackDeps(config),
): void {
  const claims = deps.claims ?? summarySaveClaims;
  const now = deps.now ?? Date.now;
  const respond = (c: Context, f: Fail) => c.json(f.body, f.status);

  app.post("/api/summaries/factcheck/append", async (c) => {
    const req = await readTarget(c, deps);
    if (!req.ok) return req.res;
    const t = req.target;
    // Claim BEFORE the read this write rebuilds from.
    const claim = claims.claim(t.sourceId, t.docId, WRITEBACK_CLAIM_BUDGET_MS);
    if (!claim) return c.json({ error: "Another write on this summary is under way.", code: "in_flight" }, 409);
    try {
      const raw = await loadRaw(deps, t);
      if (typeof raw !== "string") return respond(c, raw);
      const stored = readStoredCapture(raw);
      // The document's own refusals first: a URL-less summary is `no_url`
      // whether or not it was ever checked.
      const pre = preflightSummarySave(stored, t.docId);
      if (!pre.ok) return c.json({ error: pre.error, code: pre.code }, pre.status);
      const row = await loadRow(deps, t);
      if ("status" in row) return respond(c, row);
      const refusal = hashRefusal(row, raw, false);
      if (refusal) return respond(c, refusal);

      const summary = insertSummaryFactcheckBlock(stored.body, buildSummaryFactcheckBlock(row.answer, factcheckBlockDate(row.createdAt)));
      // D11 by construction; asserted, because a write that moved the hash would
      // make the row describe text that is no longer there.
      if (sha256(summaryFactcheckBody(filterDocumentText(summary))) !== row.bodySha256) {
        log.error("Summary factcheck append: the block would move the checked text of {doc} — not written", { doc: t.docId });
        return c.json({ error: "Adding the block would change the checked text. Nothing was written.", code: "hash_drift" }, 500);
      }
      const saved = await saveSummaryBody({
        descriptor: requireSaveDescriptor(t.sourceId),
        stored,
        docId: t.docId,
        summary,
        claim,
        knowledgeApiUrl: config.knowledgeApiUrl,
        ...(deps.ingest ? { ingest: deps.ingest } : {}),
        logContext: { route: "factcheck-append" },
      });
      if (!saved.ok) return respond(c, saveFailure(saved));
      log.info("Summary factcheck appended: {collection}/{doc}", { collection: t.collection, doc: t.docId });
      return c.json({ ok: true, filePath: saved.filePath });
    } finally {
      claims.release(claim);
    }
  });

  app.post("/api/summaries/factcheck/integrate", async (c) => {
    const req = await readTarget(c, deps);
    if (!req.ok) return req.res;
    const t = req.target;
    const raw = await loadRaw(deps, t);
    if (typeof raw !== "string") return respond(c, raw);
    const stored = readStoredCapture(raw);
    // Before any model spend: the save's fork refusals, then the row and its CAS.
    const pre = preflightSummarySave(stored, t.docId);
    if (!pre.ok) return c.json({ error: pre.error, code: pre.code }, pre.status);
    const row = await loadRow(deps, t);
    if ("status" in row) return respond(c, row);
    const refusal = hashRefusal(row, raw, true);
    if (refusal) return respond(c, refusal);

    const rawSha256 = sha256(raw);
    const rowVersion = factcheckRowVersion(row);
    const slices = summaryEditSlices(stored.body);
    const bodyLen = summaryIntegrateBodyLen(slices);
    const budget = { bodyLen, maxEdits: INTEGRATE_MAX_EDITS, maxEditChars: INTEGRATE_MAX_EDIT_CHARS, maxChangedChars: maxChangedChars(bodyLen) };
    if (bodyLen > INTEGRATE_BODY_MAX) {
      return c.json({ error: "summary too long to integrate", code: "too_long", bodyLen, max: INTEGRATE_BODY_MAX }, 400);
    }
    // Which claims are ❌/⚠️ is the saved claims' verdict (#649's predicate); the
    // model is shown each one's verdict block from the answer.
    const correctableIdx = new Set(savedCorrectableClaims(row).map((cl) => cl.index));
    const correctable = parseFactcheckClaims(row.answer).filter((a) => correctableIdx.has(a.index));
    if (correctable.length === 0) {
      return c.json({ edits: [], dropped: [], note: "No ❌ or ⚠️ claims to integrate.", html: "", rawSha256, rowVersion, budget });
    }
    const bot = resolveSummarizerBot(deps.bots());
    if (!bot) return c.json({ error: "No bots configured to run the integrate.", code: "no_bot" }, 503);

    const noun = sourceKindNoun(t.collection, pre.url);
    const prompts = buildIntegratePrompt({
      pageTitle: pre.title,
      wikiName: t.collection,
      claims: correctable,
      maskedBody: summaryPromptBody(slices),
      hasSourcesSection: false,
      voice: summaryEditorVoice(noun, stored.frontmatter.summary_lang),
    });
    let text: string;
    try {
      text = await deps.integrate({ title: pre.title, collection: t.collection, prompt: prompts.userPrompt, systemPrompt: prompts.systemPrompt, bot });
    } catch (err) {
      log.warn("Summary factcheck integrate: one-shot failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
      return c.json({ error: "the editor model call failed", code: "model_failed" }, 502);
    }
    const parsed = parseEditList(text);
    if (!parsed) {
      log.warn("Summary factcheck integrate: unparseable edit list for {doc}: {raw}", { doc: t.docId, raw: text.slice(0, 200) });
      return c.json({ error: "the editor model returned no usable edit list", code: "model_unparseable" }, 502);
    }
    const bounded = enforceEditBounds(parsed.edits);
    const screened = proposeSummaryEdits({
      slices,
      edits: bounded.kept,
      priorDrops: [...parsed.dropped, ...bounded.dropped],
      sourceNoun: noun,
      summaryLang: stored.frontmatter.summary_lang,
      correctable: correctableIdx,
      bodyLen,
    });
    const kept = screened.outcomes.filter((o) => o.applied);
    // Apply takes whole claims: each edit names its claim's edit count.
    const counts = claimEditCounts(kept.map((o) => o.edit));
    const edits = kept
      .map((o, i) => ({
        ...o.edit,
        claimEdits: counts[i]!,
        slice: o.slice,
        resolvedText: o.resolvedText,
        ...(o.beforeCtx !== undefined ? { beforeCtx: o.beforeCtx } : {}),
        ...(o.afterCtx !== undefined ? { afterCtx: o.afterCtx } : {}),
      }));
    const dropped: DroppedEdit[] = [...parsed.dropped, ...bounded.dropped, ...screened.dropped];
    const titles = new Map(correctable.map((cl) => [cl.index, cl.title]));
    log.info("Summary factcheck integrate: {collection}/{doc} noun={noun} proposed={n} dropped={d}", {
      collection: t.collection,
      doc: t.docId,
      noun,
      n: edits.length,
      d: dropped.length,
    });
    return c.json({
      edits,
      dropped,
      ...(parsed.note ? { note: parsed.note } : {}),
      html: summaryIntegratePreviewHtml(edits, dropped, titles),
      rawSha256,
      rowVersion,
      budget: { ...budget, proposedChangedChars: screened.changedChars },
    });
  });

  app.post("/api/summaries/factcheck/integrate/apply", async (c) => {
    const req = await readTarget(c, deps);
    if (!req.ok) return req.res;
    const t = req.target;
    const rawSha256 = typeof req.body.rawSha256 === "string" ? req.body.rawSha256 : "";
    const rowVersion = typeof req.body.rowVersion === "string" ? req.body.rowVersion : "";
    if (!rawSha256 || !rowVersion) return c.json({ error: "rawSha256 and rowVersion are required", code: "bad_request" }, 400);
    const accepted = coerceAcceptedEdits(req.body.edits);
    if (typeof accepted === "string") return c.json({ error: accepted, code: "bad_edits" }, 400);
    const { edits } = accepted;
    const sent = claimEditCounts(edits);
    if (sent.some((n, i) => n !== accepted.claimEdits[i])) {
      return c.json({ error: PARTIAL_CLAIM_ERROR, code: "partial_claim" }, 400);
    }
    for (const edit of edits) {
      const refusal = structuralLineRefusal(edit.new);
      if (refusal) return c.json({ error: `An accepted edit ${refusal}. Nothing was written.`, code: "structural_edit" }, 400);
    }

    const claim = claims.claim(t.sourceId, t.docId, WRITEBACK_CLAIM_BUDGET_MS);
    if (!claim) return c.json({ error: "Another write on this summary is under way.", code: "in_flight" }, 409);
    try {
      const raw = await loadRaw(deps, t);
      if (typeof raw !== "string") return respond(c, raw);
      if (sha256(raw) !== rawSha256) {
        return c.json({ error: "The summary changed since this preview. Integrate again.", code: "recheck" }, 409);
      }
      const stored = readStoredCapture(raw);
      const pre = preflightSummarySave(stored, t.docId);
      if (!pre.ok) return c.json({ error: pre.error, code: pre.code }, pre.status);
      // The row is read under the claim, after the raw read, so its freshness and
      // its applied state are checked against the file this write rebuilds from.
      const row = await loadRow(deps, t);
      if ("status" in row) return respond(c, row);
      if (factcheckRowVersion(row) !== rowVersion) {
        return c.json({ error: "The fact check was re-run since this preview. Integrate again.", code: "recheck" }, 409);
      }
      const refusal = hashRefusal(row, raw, true);
      if (refusal) return respond(c, refusal);

      const slices = summaryEditSlices(stored.body);
      const resolved = resolveSummaryEdits(slices, edits);
      const max = maxChangedChars(summaryIntegrateBodyLen(slices));
      const changed = changedCharsOfOutcomes(resolved.outcomes);
      if (changed > max) {
        return c.json({ error: `the accepted edits change ${changed} chars, over the ${max}-char limit for this summary`, code: "over_budget" }, 400);
      }
      if (resolved.appliedCount === 0) {
        return c.json({ error: "None of the accepted edits anchors in the summary. Nothing was written.", code: "nothing_applied" }, 409);
      }
      // A claim that anchors only in part would be half a correction.
      const anchored = new Map<number, boolean[]>();
      for (const o of resolved.outcomes) {
        if (o.edit.claimIndex > 0) anchored.set(o.edit.claimIndex, [...(anchored.get(o.edit.claimIndex) ?? []), o.applied]);
      }
      if ([...anchored.values()].some((a) => a.includes(true) && a.includes(false))) {
        return c.json({ error: PARTIAL_CLAIM_ERROR, code: "partial_claim" }, 400);
      }
      // The propose-side attribution check, re-run on what the client sent.
      const placed = resolved.outcomes.filter((o) => o.applied).map((o) => ({ edit: o.edit, slice: o.slice, start: o.start ?? 0 }));
      const unattributed = unattributedEdits(placed, {
        sourceNoun: sourceKindNoun(t.collection, pre.url),
        summaryLang: stored.frontmatter.summary_lang,
        correctable: new Set(savedCorrectableClaims(row).map((cl) => cl.index)),
      });
      if (unattributed.size > 0) {
        const claimsOut = [...new Set([...unattributed].map((p) => p.edit.claimIndex))].join(", ");
        return c.json(
          { error: `The edits for claim ${claimsOut} do not say what the source says. Nothing was written.`, code: "not_attributed" },
          400,
        );
      }
      const summary = insertSummaryFactcheckBlock(
        rebuildSummaryBody(slices, resolved.texts),
        buildSummaryFactcheckBlock(row.answer, factcheckBlockDate(row.createdAt)),
      );
      if (summaryStructureChanged(stored.body, summary)) {
        log.warn("Summary factcheck apply: the edits would move the structure of {doc} — not written", { doc: t.docId });
        return c.json(
          {
            error: "The accepted edits would change where the summary's transcript, visual reference or checked text begin. Nothing was written.",
            code: "structure_changed",
          },
          409,
        );
      }
      const saved = await saveSummaryBody({
        descriptor: requireSaveDescriptor(t.sourceId),
        stored,
        docId: t.docId,
        summary,
        claim,
        knowledgeApiUrl: config.knowledgeApiUrl,
        ...(deps.ingest ? { ingest: deps.ingest } : {}),
        logContext: { route: "factcheck-integrate-apply" },
      });
      if (!saved.ok) return respond(c, saveFailure(saved));

      // Re-stamp from the WRITTEN file; the predicted hash only when the re-read fails.
      let bodySha256 = sha256(summaryFactcheckBody(filterDocumentText(summary)));
      try {
        const written = await deps.readRaw(t.collection, t.docId);
        if (written !== null) bodySha256 = checkedSha256OfRaw(written);
        else log.warn("Summary factcheck apply: re-read of {doc} found nothing; stamping the predicted hash", { doc: t.docId });
      } catch (err) {
        log.warn("Summary factcheck apply: re-read of {doc} failed ({error}); stamping the predicted hash", { doc: t.docId, error: errText(err) });
      }
      const stamp = await stampApplied(deps, t, row, bodySha256);
      const applied = resolved.appliedCount;
      const notApplied = resolved.outcomes.filter((o) => !o.applied).map((o) => ({ edit: o.edit, reason: o.reason ?? "could not be placed" }));
      log.info("Summary factcheck integrated: {collection}/{doc} applied={applied} stamp={stamp}", {
        collection: t.collection,
        doc: t.docId,
        applied,
        stamp,
      });
      return c.json({
        ok: true,
        applied,
        notApplied,
        filePath: saved.filePath,
        stamp,
        ...(stamp === "stamped" ? { appliedAt: now() } : { message: STAMP_MESSAGES[stamp] }),
        ...(stamp === "rechecked" ? { recheckedDuringApply: true } : {}),
      });
    } finally {
      claims.release(claim);
    }
  });
}
