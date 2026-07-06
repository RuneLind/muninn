import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../tiktok/state.ts";
import { summarizeTikTok } from "../../tiktok/summarizer.ts";
import { extractTikTokVideoId } from "../../tiktok/media.ts";
import { discoverAllBots, resolveSummarizerBot, isCliNativeBot } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const TT_SOURCE = getSummarySource("tiktok")!;
const TT_COLLECTION = TT_SOURCE.collection;

// A browser-like UA so the short-link HEAD isn't met with TikTok's anti-bot wall.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

interface TtDocumentMeta { id: string; url?: string }

/** vm.tiktok.com / vt.tiktok.com share links that redirect to the canonical URL. */
function isShortLink(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "vm.tiktok.com" || host === "vt.tiktok.com";
  } catch {
    return false;
  }
}

/**
 * Resolve the numeric video id from an input URL. A canonical `/video/<id>` URL
 * parses with zero latency; a short link needs one redirect-following HEAD. On
 * any failure we return null so the caller skips the dedup pre-check and proceeds
 * — the yt-dlp-resolved id in the background job still drives the canonical URL,
 * so the only cost is a rare duplicate.
 */
async function resolveVideoId(url: string): Promise<string | null> {
  const direct = extractTikTokVideoId(url);
  if (direct) return direct;
  if (!isShortLink(url)) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return extractTikTokVideoId(res.url);
  } catch (err) {
    log.warn("TikTok short-link resolution failed for {url} — skipping dedup pre-check: {error}", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function findExistingByVideoId(
  baseUrl: string,
  videoId: string,
): Promise<TtDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${TT_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as TtDocumentMeta[];
    return docs.find((d) => d.url != null && extractTikTokVideoId(d.url) === videoId) ?? null;
  } catch (err) {
    log.warn("TikTok duplicate check failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function registerTikTokRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  // Shared plumbing: bare-path redirect, CORS preflight, SSE stream, jobs,
  // document/similar proxies. `completeCarriesSummary` ships the parsed summary
  // on the terminal replay so a live browser drops the frame-reading chatter.
  registerSummaryVertical(app, config, {
    apiBase: TT_SOURCE.apiBase,
    collection: TT_COLLECTION,
    store: { getJob, getRecentJobs, subscribe },
    redirect: { path: "/tiktok", source: "tiktok" },
    corsPreflight: true,
    completeCarriesSummary: true,
  });

  app.post("/api/tiktok/summarize", async (c) => {
    c.header("Access-Control-Allow-Origin", "*");

    const body = await c.req.json<{ title?: string; url?: string; frames?: boolean }>();
    const { title, url, frames } = body;

    if (!url) {
      return c.json({ error: "Missing required field: url" }, 400);
    }

    // Preflight: yt-dlp is a hard runtime dependency for this vertical.
    if (!Bun.which("yt-dlp")) {
      return c.json(
        { error: "yt-dlp not found on PATH. Install it with 'brew install yt-dlp'." },
        500,
      );
    }

    const videoId = await resolveVideoId(url);

    if (videoId) {
      const existing = await findExistingByVideoId(KNOWLEDGE_API_URL, videoId);
      if (existing) {
        log.info("TikTok duplicate detected for {videoId}: {docId}", {
          videoId,
          docId: existing.id,
        });
        return c.json({
          duplicate: true,
          document_id: existing.id,
          existing_url: existing.url,
          dashboard_url: `/summaries?source=tiktok&doc=${encodeURIComponent(existing.id)}&duplicate=1`,
        });
      }
    }

    const jobId = createJob(videoId ?? "", title || url, url);

    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured" }, 500);
    }

    // Fail fast on a non-CLI-native summarizer bot: frame reading runs through a
    // raw `claude` spawn, and a copilot-sdk/openai-compat model id would kill
    // that spawn only AFTER the expensive download + whisper pre-work.
    if (!isCliNativeBot(summarizerBot)) {
      return c.json(
        {
          error: `Summarizer bot "${summarizerBot.name}" uses connector "${summarizerBot.connector}", which cannot drive the TikTok frame-reading Claude CLI spawn. Set SUMMARIZER_BOT to a CLI-native bot (connector "claude-cli" or "claude-sdk").`,
        },
        503,
      );
    }

    // Fire and forget — background summarization
    summarizeTikTok(jobId, url, title || url, config, summarizerBot, { frames }).catch((err) => {
      log.error("TikTok summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });

    return c.json({ job_id: jobId, dashboard_url: `/summaries?source=tiktok&job=${jobId}` });
  });
}
