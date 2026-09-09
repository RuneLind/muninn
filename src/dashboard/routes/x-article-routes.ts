import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../x-article/state.ts";
import { summarizeArticle } from "../../x-article/summarizer.ts";
import { summarizeXVideo } from "../../x-article/video.ts";
import { extractXStatusId } from "../../video/media.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { connectorCapabilities } from "../../ai/one-shot.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";
import { applyCors, corsHeaders } from "../../auth/cors.ts";
import { shortVideoCaptureKinds } from "../../video/short-video-kinds.ts";
import {
  DEFAULT_CAPTURE_KIND,
  capturePresetOptions,
  findCapturePreset,
} from "../../summaries/presets.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const XA_SOURCE = getSummarySource("x-article")!;
const XA_COLLECTION = XA_SOURCE.collection;

interface XaDocumentMeta { id: string; url?: string }

/**
 * Video dedup keys on the numeric status id, not URL string equality — the
 * submitted URL may carry a `/video/1` media-slot suffix or query params while
 * the stored doc holds the bare status URL.
 */
async function findExistingByStatusId(
  baseUrl: string,
  statusId: string,
): Promise<XaDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${XA_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as XaDocumentMeta[];
    return docs.find((d) => d.url != null && extractXStatusId(d.url) === statusId) ?? null;
  } catch (err) {
    log.warn("X video duplicate check failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function findExistingByUrl(
  baseUrl: string,
  url: string,
): Promise<XaDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${XA_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as XaDocumentMeta[];
    return docs.find((d) => d.url === url) ?? null;
  } catch (err) {
    log.warn("X article duplicate check failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function registerXArticleRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  // Shared plumbing: bare-path redirect, CORS preflight, SSE stream, jobs,
  // document/similar proxies (the /x-articles page merged into /summaries).
  registerSummaryVertical(app, config, {
    apiBase: XA_SOURCE.apiBase,
    collection: XA_COLLECTION,
    store: { getJob, getRecentJobs, subscribe },
    redirect: { path: "/x-articles", source: "x-article" },
    corsPreflight: true,
    // Video jobs stream frame-reading chatter; the terminal replay ships the
    // parsed summary so a live browser swaps the chatter out (TikTok pattern).
    completeCarriesSummary: true,
  });

  app.post("/api/x-articles/summarize", async (c) => {
    applyCors(c);

    const body = await c.req.json<{
      title?: string;
      url?: string;
      article_id?: string;
      author?: string;
      article_text?: string;
    }>();
    const { title, url, article_id, author, article_text } = body;

    if (!url || !article_id || !article_text) {
      return c.json({ error: "Missing required fields: url, article_id, article_text" }, 400);
    }

    const existing = await findExistingByUrl(KNOWLEDGE_API_URL, url);
    if (existing) {
      log.info("X article duplicate detected for {url}: {docId}", {
        url,
        docId: existing.id,
      });
      return c.json({
        duplicate: true,
        document_id: existing.id,
        existing_url: existing.url,
        dashboard_url: `/summaries?source=x-article&doc=${encodeURIComponent(existing.id)}&duplicate=1`,
      });
    }

    const jobId = createJob(article_id, title || url, url, author || "unknown");

    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured" }, 500);
    }

    // Fire and forget — background summarization
    summarizeArticle(jobId, article_id, title || url, url, author || "unknown", article_text, config, summarizerBot).catch((err) => {
      log.error("X article summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });

    return c.json({ job_id: jobId, dashboard_url: `/summaries?source=x-article&job=${jobId}` });
  });

  // The shared vertical only preflights `<apiBase>/summarize` — the video
  // endpoint needs its own OPTIONS for cross-origin (Chrome extension) POSTs.
  app.options("/api/x-articles/summarize-video", (c) => {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(c, {
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      }),
    });
  });

  /**
   * The kinds this instance offers for an X VIDEO capture — the short-video
   * set, the same resolution `/api/x-articles/summarize-video` validates
   * against, and the same payload shape `/api/tiktok/options` answers. Named
   * `video-options` because the sibling POST on this base is the TEXT path,
   * which has no kind picker.
   *
   * `applyCors` and no preflight, for the reasons the TikTok twin states.
   */
  app.get("/api/x-articles/video-options", (c) => {
    applyCors(c);
    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured", code: "no_bot" }, 500);
    }
    return c.json({
      kinds: capturePresetOptions(shortVideoCaptureKinds(summarizerBot)),
      default_kind: DEFAULT_CAPTURE_KIND,
      frames: { supported: connectorCapabilities(summarizerBot).supportsExtraDirs },
    });
  });

  app.post("/api/x-articles/summarize-video", async (c) => {
    applyCors(c);

    const body = await c.req.json<{
      title?: string;
      url?: string;
      frames?: boolean;
      kind?: string;
    }>();
    const { title, url, frames } = body;

    if (!url) {
      return c.json({ error: "Missing required field: url" }, 400);
    }

    const statusId = extractXStatusId(url);
    if (!statusId) {
      return c.json(
        { error: "Not an X status URL — expected https://x.com/<user>/status/<id>[/video/N]" },
        400,
      );
    }

    // Preflight: yt-dlp is a hard runtime dependency for the video path.
    if (!Bun.which("yt-dlp")) {
      return c.json(
        { error: "yt-dlp not found on PATH. Install it with 'brew install yt-dlp'." },
        500,
      );
    }

    // The summary KIND, validated ABOVE the duplicate lookup and above
    // `createJob` — the TikTok/YouTube/Vimeo ordering, for the same reason: a
    // picker value this instance does not offer is a 400 whatever the video,
    // and it must cost neither a huginn listing read nor a job row. Absent is
    // the default; PRESENT BUT BLANK is refused with the unknown ones, since
    // `findCapturePreset` reads a blank id as absent — right for a key that is
    // not there, wrong for a picker that failed to fill. The bot is resolved
    // here because the offered set is the bot's.
    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured" }, 500);
    }
    if (body.kind !== undefined && typeof body.kind !== "string") {
      return c.json({ error: "Summary kind must be a string", code: "bad_kind" }, 400);
    }
    if (typeof body.kind === "string" && body.kind.trim() === "") {
      return c.json(
        { error: "Summary kind must not be blank", code: "bad_kind", kind: body.kind },
        400,
      );
    }
    const preset = findCapturePreset(shortVideoCaptureKinds(summarizerBot), body.kind);
    if (!preset) {
      return c.json(
        { error: `Unknown summary kind: ${body.kind}`, code: "bad_kind", kind: body.kind },
        400,
      );
    }

    const existing = await findExistingByStatusId(KNOWLEDGE_API_URL, statusId);
    if (existing) {
      log.info("X video duplicate detected for status {statusId}: {docId}", {
        statusId,
        docId: existing.id,
      });
      return c.json({
        duplicate: true,
        document_id: existing.id,
        existing_url: existing.url,
        dashboard_url: `/summaries?source=x-article&doc=${encodeURIComponent(existing.id)}&duplicate=1`,
      });
    }

    // Same pre-flight as TikTok: the frame-reading flow needs --add-dir, which
    // only the claude-cli/claude-sdk connectors express. Reject before the
    // expensive download + whisper work.
    if (!connectorCapabilities(summarizerBot).supportsExtraDirs) {
      return c.json(
        {
          error: `Summarizer bot "${summarizerBot.name}" uses connector "${summarizerBot.connector}", which cannot read the extracted video frames (no extra-dirs support). Set SUMMARIZER_BOT to a claude-cli or claude-sdk bot.`,
        },
        503,
      );
    }

    // Author is resolved from yt-dlp metadata inside the job.
    const jobId = createJob(statusId, title || url, url, "");

    // Fire and forget — background summarization
    summarizeXVideo(jobId, url, title || url, config, summarizerBot, { frames, preset }).catch((err) => {
      log.error("X video summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });

    return c.json({ job_id: jobId, dashboard_url: `/summaries?source=x-article&job=${jobId}` });
  });
}
