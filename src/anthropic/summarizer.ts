import { loadConfig, type Config } from "../config.ts";
import { discoverAllBots, resolveSummarizerBot, type BotConfig } from "../bots/config.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import { getLog } from "../logging.ts";
import { AI_CATEGORIES, parseSummaryResponse } from "../utils/summary-parser.ts";
import { buildSummarySystemPrompt, runCaptureOneShot } from "../summaries/summarizer-shared.ts";
import { triggerSourceDraftFromCapture } from "../gardener/source-drafter-run.ts";
import { setCandidateStatus, type SummaryCandidateKind } from "../db/summary-candidates.ts";
import { extractDocLinks } from "../summaries/doc-links.ts";
import {
  pickEnrichmentLink,
  youTubeVideoId,
  type EnrichmentLink,
} from "./link-enrichment.ts";
import {
  attachRun,
  createJob,
  updateStatus,
  appendText,
  setCategory,
  setSimilar,
  setDocId,
  completeJob,
  failJob,
} from "./state.ts";

const log = getLog("anthropic", "summarizer");

const KNOWLEDGE_COLLECTION = "anthropic-knowledge";
const SUMMARIES_COLLECTION = "anthropic-summaries";
/** Huginn collection the X watcher captures from — content is fetched by doc id (tweet URLs aren't fetchable). */
const X_FEED_COLLECTION = "x-feed";

// Cap resolved content before summarizing. Real docs/blogs/commits are small
// (hundreds to a few thousand chars), but the direct-fetch fallback can pull a
// ~1MB GitHub HTML page (~250k tokens) — without this clamp that overflows the
// model context and the whole job dies with "Prompt is too long".
const MAX_CONTENT_CHARS = 100_000;

function capContent(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n…[content truncated for length]`;
}

/**
 * The anthropic-summaries doc id is the saved file's path *relative to the
 * collection root* — category-prefixed, e.g. `ai/claude/Foo.md` — which is the
 * exact identity `/api/document/<collection>/<id>` and the shelf listing use (a
 * bare basename 404s).
 *
 * Huginn's ingest returns `file_path` ALREADY relative to the collection root
 * (`write_categorized_markdown` returns `os.path.join(category, filename)`, e.g.
 * `ai/general/Foo.md`), so the common path is to use it as-is. Only if a deploy
 * ever hands back an absolute path do we slice everything after the collection
 * dir. The earlier basename-only fallback dropped the category prefix and made the
 * candidate's `doc_id` 502 from the doc panel + "On the shelf" link.
 */
function collectionRelativeId(filePath: string): string {
  const marker = `/${SUMMARIES_COLLECTION}/`;
  const idx = filePath.indexOf(marker);
  if (idx !== -1) return filePath.slice(idx + marker.length);
  // Already collection-relative (the real Huginn response) — trim a leading "./" or "/".
  return filePath.replace(/^\.?\//, "");
}

// The vertical's framing nuance ("lead with what changed and why it matters")
// now rides in the intro sentence — the structured-output rules are the shared
// SUMMARY_STRUCTURE_BULLETS (key-takeaways-first, tables-for-comparative,
// consistent ## headings, plain markdown), so it steers the `## Key takeaways`
// section instead of duplicating the whole bullet list per vertical.
const SUMMARIZE_SYSTEM_PROMPT = buildSummarySystemPrompt(
  "You are an analyst summarizing a new Anthropic / Claude ecosystem release (a docs page, blog post, changelog, or commit) for a personal learning shelf. Lead the Key takeaways with what changed and why it matters.",
  AI_CATEGORIES,
);

/**
 * X variant of the summarize system prompt — for a captured long-form X post/article
 * (borrows the framing of `src/x-article/summarizer.ts`). Same CATEGORY:/SUMMARY:
 * contract + AI_CATEGORIES clamp as the anthropic prompt, so the parser is unchanged;
 * only the framing (a personal note, not an Anthropic release) differs.
 */
const X_SUMMARIZE_SYSTEM_PROMPT = buildSummarySystemPrompt(
  "You are an analyst summarizing a long-form X (Twitter) post or article for a personal learning shelf. The content below is one author's note/thread — distill its argument and takeaways for a senior AI engineer. Lead the Key takeaways with the author's main point and why it matters.",
  AI_CATEGORIES,
);

/**
 * Which link-enrichment path ran on the X source-doc branch, for the capture
 * trace + log. `none` = no enrichable link on the doc (tweet-only, today's
 * behavior); `failed` = a link was picked but its fetch failed (tweet-only,
 * degraded); `youtube`/`article` = the linked content was folded in. Undefined
 * on the non-X (anthropic-by-URL) path, where enrichment doesn't apply.
 */
export type EnrichmentOutcome = "youtube" | "article" | "none" | "failed";

interface ResolvedContent {
  text: string;
  /** Original publish/commit date from the source doc's metadata, if available. */
  date?: string;
  /** Link-enrichment outcome for the X path (see {@link EnrichmentOutcome}). */
  enrichment?: EnrichmentOutcome;
}

interface DocMeta {
  id: string;
  url?: string;
}

/**
 * Resolve the candidate URL to its `anthropic-knowledge` doc id (§8.2).
 *
 * The fetcher writes slug+hash filenames, so the doc id ≠ url and can't be
 * derived. Primary path is an exact-url lookup against the collection's document
 * listing — the same reliable identity path youtube/x-article use for dedup.
 * Title-search is only a fallback: ranking is fragile for near-duplicate commit
 * titles (the exact-url hit can fall out of the top window), and URL-as-query
 * tokenizes badly, so we filter the title hits by exact url.
 */
async function resolveDocId(baseUrl: string, url: string, title: string): Promise<string | null> {
  // 1. Exact-url match against the full document listing (id + url pairs).
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${KNOWLEDGE_COLLECTION}/documents`,
      { timeoutMs: 15000 },
    );
    const docs = (data?.documents ?? []) as DocMeta[];
    const hit = docs.find((d) => d.url === url);
    if (hit?.id) return hit.id;
  } catch (err) {
    log.warn("anthropic-knowledge documents listing failed for {url}: {error}", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Fallback: search by title, keep the exact-url hit (wide window).
  try {
    const params = new URLSearchParams({ q: title, collection: KNOWLEDGE_COLLECTION, limit: "25" });
    const data = await fetchKnowledgeApi(baseUrl, `/api/search?${params}`, { timeoutMs: 12000 });
    const hits = (data?.results ?? []) as DocMeta[];
    const hit = hits.find((h) => h.url === url);
    if (hit?.id) return hit.id;
  } catch (err) {
    log.warn("anthropic-knowledge title search failed for {url}: {error}", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return null;
}

/**
 * Resolve a candidate's full content for summarizing (L7 + §8.2). Pull the
 * already-extracted doc from `anthropic-knowledge` when its id resolves; else
 * fall back to a direct fetch of the candidate URL. Content is always capped
 * (see {@link MAX_CONTENT_CHARS}) so an oversized source can't blow the prompt.
 */
async function resolveContent(
  config: Config,
  url: string,
  title: string,
  sourceDocId?: string | null,
): Promise<ResolvedContent | null> {
  const baseUrl = config.knowledgeApiUrl;

  // 0. Source-doc-id path (X): the candidate carries its huginn `x-feed` doc id, and
  //    tweet URLs aren't fetchable, so resolve content straight from that doc. No URL
  //    fallback here — a direct fetch of x.com would just yield the login wall.
  if (sourceDocId) {
    try {
      const doc = await fetchKnowledgeApi(
        baseUrl,
        `/api/document/${X_FEED_COLLECTION}/${encodeURIComponent(sourceDocId)}`,
        { timeoutMs: 12000 },
      );
      const text = typeof doc?.text === "string" ? doc.text : "";
      const date = typeof doc?.metadata?.date === "string" ? doc.metadata.date : undefined;
      if (text.trim()) {
        // Follow the ONE external link the tweet points to (a YouTube video, an
        // article) so the summary reflects the linked content, not just the tweet
        // text. Single-link by design; any failure degrades to tweet-only content
        // (byte-identical to pre-enrichment behavior) — a dead link never fails the job.
        const picked = pickEnrichmentLink(extractDocLinks(text));
        let combined = text;
        let enrichment: EnrichmentOutcome = "none";
        if (picked) {
          const linked = await fetchEnrichmentContent(baseUrl, picked);
          if (linked) {
            combined = `${text}\n\n--- LINKED CONTENT (${picked.url}) ---\n${linked}`;
            enrichment = picked.kind;
            log.info("Enriched {url} with {kind} link {link} ({len} chars)", {
              url,
              kind: picked.kind,
              link: picked.url,
              len: linked.length,
            });
          } else {
            enrichment = "failed";
            log.warn("Enrichment fetch failed for {kind} link {link} on {url} — tweet-only", {
              url,
              kind: picked.kind,
              link: picked.url,
            });
          }
        }
        log.info("Resolved {url} from {collection} doc {docId} ({len} chars)", {
          url,
          collection: X_FEED_COLLECTION,
          docId: sourceDocId,
          len: text.length,
        });
        // Cap the COMBINED string (tweet text first ⇒ always survives the cap).
        return { text: capContent(combined), date, enrichment };
      }
      log.warn("{collection} doc {docId} was empty for {url}", {
        collection: X_FEED_COLLECTION,
        docId: sourceDocId,
        url,
      });
    } catch (err) {
      log.warn("{collection} document fetch failed for {docId}: {error}", {
        collection: X_FEED_COLLECTION,
        docId: sourceDocId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  // 1. Preferred — the doc Huginn already fetched + extracted.
  const docId = await resolveDocId(baseUrl, url, title);
  if (docId) {
    try {
      const doc = await fetchKnowledgeApi(
        baseUrl,
        `/api/document/${KNOWLEDGE_COLLECTION}/${encodeURIComponent(docId)}`,
        { timeoutMs: 12000 },
      );
      const text = typeof doc?.text === "string" ? doc.text : "";
      const date = typeof doc?.metadata?.date === "string" ? doc.metadata.date : undefined;
      if (text.trim()) {
        log.info("Resolved {url} from {collection} doc {docId} ({len} chars)", {
          url,
          collection: KNOWLEDGE_COLLECTION,
          docId,
          len: text.length,
        });
        return { text: capContent(text), date };
      }
    } catch (err) {
      log.warn("anthropic-knowledge document fetch failed for {docId}: {error}", {
        docId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.info("No exact-url doc in {collection} for {url} — falling back to direct fetch", {
      collection: KNOWLEDGE_COLLECTION,
      url,
    });
  }

  // 2. Fallback — fetch the candidate URL directly. Clean `.md` for doc URLs;
  //    raw HTML otherwise (the summarizer prompt copes with either, and the cap
  //    keeps a heavy HTML page from overflowing the model context).
  try {
    const fetchUrl = directFetchUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(fetchUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      log.warn("Direct fetch of {url} returned {status}", { url: fetchUrl, status: res.status });
      return null;
    }
    const text = await res.text();
    if (!text.trim()) return null;
    log.info("Resolved {url} via direct fetch ({len} chars)", { url: fetchUrl, len: text.length });
    return { text: capContent(text) };
  } catch (err) {
    log.warn("Direct fetch of {url} failed: {error}", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Anthropic/Claude doc URLs serve clean markdown at `<path>.md`. */
function directFetchUrl(url: string): string {
  try {
    const u = new URL(url);
    const isDocHost = u.hostname === "docs.anthropic.com" || u.hostname === "platform.claude.com";
    if (isDocHost && u.pathname.includes("/docs/") && !u.pathname.endsWith(".md")) {
      u.pathname = `${u.pathname.replace(/\/$/, "")}.md`;
      return u.toString();
    }
  } catch {
    // not a parseable URL — fetch verbatim
  }
  return url;
}

/**
 * Fetch the ONE picked enrichment link's content. YouTube ⇒ huginn's transcript
 * endpoint (same shape/timeout as {@link "../youtube/summarizer.ts"}); article ⇒
 * a direct fetch (raw HTML is fine — `capContent` bounds it). Returns the text,
 * or null on any failure (missing id, non-200, empty body, timeout, throw) so the
 * caller degrades to tweet-only content. NEVER throws — enrichment is best-effort.
 */
async function fetchEnrichmentContent(
  baseUrl: string,
  picked: EnrichmentLink,
): Promise<string | null> {
  if (picked.kind === "youtube") {
    const id = youTubeVideoId(picked.url);
    if (!id) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${baseUrl}/api/youtube/transcript/${id}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        log.warn("Transcript fetch for {id} returned {status}", { id, status: res.status });
        return null;
      }
      const data = (await res.json()) as { transcript?: string };
      const transcript = data.transcript ?? "";
      return transcript.trim() ? transcript : null;
    } catch (err) {
      clearTimeout(timeout);
      log.warn("Transcript fetch for {id} failed: {error}", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // article: direct fetch (mirrors the anthropic direct-fetch fallback).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(picked.url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      log.warn("Article fetch of {url} returned {status}", { url: picked.url, status: res.status });
      return null;
    }
    const text = await res.text();
    return text.trim() ? text : null;
  } catch (err) {
    clearTimeout(timeout);
    log.warn("Article fetch of {url} failed: {error}", {
      url: picked.url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Kind-scoped framing appended to the system prompt when the tweet's linked
 * content was folded in. `x-link` (arrives with PR 3) treats the destination as
 * the PRIMARY subject; every other kind (`x-post`, the pre-PR-3 long-form
 * population) treats it as SUPPORTING CONTEXT only, keeping the post the subject.
 */
function enrichmentFraming(kind: string | null | undefined): string {
  if (kind === "x-link") {
    return "The content below includes a `--- LINKED CONTENT ---` section fetched from the link this tweet points to. Treat that linked content as the PRIMARY subject — summarize what the destination says; the tweet itself is just the pointer and context.";
  }
  return "The content below includes a `--- LINKED CONTENT ---` section fetched from a link in the post. Treat it as SUPPORTING CONTEXT only — the author's own post stays the subject of the summary.";
}

/**
 * Background pipeline for one candidate: resolve content → summarize → ingest
 * into `anthropic-summaries` → flip the candidate to `summarized` (+ doc_id) or
 * `error`. The route/auto-promote caller is responsible for setting the
 * candidate to `summarizing` before kicking this; here we only write terminal
 * candidate states so the pipeline is reusable from both call sites.
 */
export async function summarizeCandidate(
  jobId: string,
  candidateId: string,
  title: string,
  url: string,
  config: Config,
  botConfig: BotConfig,
  sourceDocId?: string | null,
  kind?: SummaryCandidateKind | null,
): Promise<void> {
  try {
    // 1. Resolve full content (still `pending` — no separate UI step, per plan). For X
    //    the candidate carries a source doc id; anthropic resolves by URL (sourceDocId
    //    null). The X path may fold in the tweet's linked content (see resolveContent).
    const content = await resolveContent(config, url, title, sourceDocId);
    if (!content) {
      failJob(jobId, "Could not resolve candidate content from its source doc or URL");
      await setCandidateStatus(candidateId, "error");
      return;
    }

    // 2. Summarize with Claude. Source-aware system prompt: an X post gets the note
    //    framing; anthropic keeps the ecosystem-release framing. Same CATEGORY contract.
    //    When linked content was folded in, add kind-scoped framing (supporting vs primary).
    updateStatus(jobId, "summarizing");

    const enriched = content.enrichment === "youtube" || content.enrichment === "article";
    const basePrompt = sourceDocId ? X_SUMMARIZE_SYSTEM_PROMPT : SUMMARIZE_SYSTEM_PROMPT;
    const systemPrompt = `${basePrompt}

Title: ${title}
URL: ${url}${enriched ? `\n\n${enrichmentFraming(kind)}` : ""}`;

    const onProgress: StreamProgressCallback = (event) => {
      if (event.type === "text_delta") {
        appendText(jobId, event.text);
      }
    };

    const result = await runCaptureOneShot({
      // The `anthropic` capture covers both the Anthropic firehose and X-post
      // candidates (`sourceDocId` set) — one shelf, one vertical.
      source: "anthropic",
      jobId,
      title,
      url,
      prompt: content.text,
      systemPrompt,
      config,
      botConfig,
      attachRun,
      onProgress,
      // Record which enrichment path ran on the capture trace (X path only).
      ...(content.enrichment ? { extraTraceAttrs: { enrichment: content.enrichment } } : {}),
    });

    // 3. Parse response. Clamp to ai/* — the anthropic-summaries collection only
    //    accepts those (Huginn allowlist); a stray valid-but-non-ai category
    //    (e.g. "tech") would be rejected at ingest.
    const parsed = parseSummaryResponse(result.result);
    const category = AI_CATEGORIES.includes(parsed.category) ? parsed.category : "ai/general";
    const summary = parsed.summary;
    setCategory(jobId, category);

    log.info("Summarized {url}: category={category}, {tokens} output tokens", {
      url,
      category,
      tokens: result.outputTokens,
    });

    // 4. Ingest into the curated collection.
    updateStatus(jobId, "ingesting");

    const ingestUrl = `${config.knowledgeApiUrl}/api/anthropic-summaries/ingest`;
    const ingestController = new AbortController();
    const ingestTimeout = setTimeout(() => ingestController.abort(), 15_000);

    let docId: string | null = null;
    try {
      const ingestRes = await fetch(ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          url,
          summary,
          category,
          date: content.date ?? new Date().toISOString().split("T")[0],
        }),
        signal: ingestController.signal,
      });
      clearTimeout(ingestTimeout);

      if (!ingestRes.ok) {
        const body = await ingestRes.text().catch(() => "");
        failJob(jobId, `Ingest returned ${ingestRes.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        await setCandidateStatus(candidateId, "error");
        return;
      }

      const ingestData = (await ingestRes.json()) as {
        file_path?: string;
        similar?: Array<{ title: string; url: string; snippet?: string }>;
      };
      // Record the collection-relative doc id so the candidate links straight
      // to its summary doc (and the D-button doc panel resolves it).
      if (ingestData.file_path) {
        docId = collectionRelativeId(ingestData.file_path);
        if (docId) setDocId(jobId, docId);
      }
      if (ingestData.similar && ingestData.similar.length > 0) {
        setSimilar(jobId, ingestData.similar);
      }
    } catch (err) {
      clearTimeout(ingestTimeout);
      const msg = err instanceof Error ? err.message : String(err);
      failJob(jobId, `Ingest failed: ${msg}`);
      await setCandidateStatus(candidateId, "error");
      return;
    }

    // 5. Complete — flip the candidate onto the shelf, linking its summary doc.
    //    The summary is already ingested, so a failure to persist the candidate
    //    bookkeeping must NOT bubble to the outer catch and flip this completed
    //    job to `error`; log it and leave the job `complete`.
    completeJob(jobId, summary, category);

    // Fire-and-forget: draft a per-article source page from this summary. `docId` is
    // huginn's collection-relative id (`string | null`) — skip the trigger when null
    // (no real keyed id ⇒ never coerce a null into a topic_key). Skips silently when
    // the bot has no wikiDir; never fails the job.
    if (docId) {
      triggerSourceDraftFromCapture(botConfig, {
        collection: SUMMARIES_COLLECTION,
        docId,
        url,
        body: summary,
        sourceTitle: title,
        category,
      });
    }

    try {
      await setCandidateStatus(candidateId, "summarized", docId);
      log.info("Candidate {candidateId} summarized → {collection} doc {docId}", {
        candidateId,
        collection: SUMMARIES_COLLECTION,
        docId,
      });
    } catch (err) {
      log.error("Candidate {candidateId} ingested but status update failed: {error}", {
        candidateId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Anthropic summarization failed for job {jobId}: {error}", { jobId, error: msg });
    failJob(jobId, msg);
    await setCandidateStatus(candidateId, "error").catch(() => {});
  }
}

/** The candidate fields needed to kick a summarize job. */
export interface CandidateRef {
  id: string;
  title: string;
  url: string;
  /** Origin doc id for source-doc resolution (X carries the `x-feed` doc id; anthropic null). */
  sourceDocId?: string | null;
  /** Capture-time kind — scopes the linked-content framing (x-post vs x-link). */
  kind?: SummaryCandidateKind | null;
}

/**
 * Start a summarize job for a candidate: create the in-memory job, flip the
 * candidate to `summarizing` (so a concurrent inbox refresh / second kick stops
 * showing it as actionable), then fire {@link summarizeCandidate} in the
 * background. Returns the new job id. Shared by the dashboard route (the
 * `[Summarize]` button) and the watcher's auto-promote path so the
 * createJob → mark-summarizing → fire sequence lives in exactly one place.
 *
 * The caller is responsible for the duplicate/in-flight pre-checks it needs (the
 * route returns 409/duplicate before calling this; the watcher only kicks rows
 * still in status `new`).
 */
export async function kickCandidateSummarize(
  candidate: CandidateRef,
  config: Config,
  botConfig: BotConfig,
): Promise<string> {
  const jobId = createJob(candidate.id, candidate.title, candidate.url);
  await setCandidateStatus(candidate.id, "summarizing");
  // Fire and forget — background summarization.
  summarizeCandidate(
    jobId,
    candidate.id,
    candidate.title,
    candidate.url,
    config,
    botConfig,
    candidate.sourceDocId,
    candidate.kind,
  ).catch((err) => {
    log.error("Anthropic summarization failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return jobId;
}

/**
 * Auto-promote entry point for the watcher (Claude Learning Center, Phase B.3 /
 * D-button). The watcher runs with no muninn {@link Config} or bot in scope, so
 * resolve both here — the summarizer bot via the same `resolveSummarizerBot`
 * the route uses, the config via `loadConfig()` — then kick the same shared
 * pipeline. Returns the job id, or `null` if no summarizer bot is configured.
 * Fire-and-forget friendly: the actual (slow) Claude call inside
 * {@link kickCandidateSummarize} is detached.
 */
export async function autoPromoteCandidate(candidate: CandidateRef): Promise<string | null> {
  const botConfig = resolveSummarizerBot(discoverAllBots());
  if (!botConfig) {
    log.warn("Auto-promote: no summarizer bot configured — skipping {url}", { url: candidate.url });
    return null;
  }
  const config = loadConfig();
  return kickCandidateSummarize(candidate, config, botConfig);
}
