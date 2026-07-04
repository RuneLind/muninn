import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe as subscribeTikTokJob } from "../../tiktok/state.ts";
import { summarizeTikTok } from "../../tiktok/summarizer.ts";
import { extractTikTokVideoId } from "../../tiktok/media.ts";
import { discoverAllBots, resolveSummarizerBot, isCliNativeBot } from "../../bots/config.ts";
import { knowledgeApiHandler, fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const TT_COLLECTION = getSummarySource("tiktok")!.collection;

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

  // The TikTok view lives in the unified /summaries page. Keep this route as a
  // redirect so a bare /tiktok?job=… link lands there, carrying the source tag.
  app.get("/tiktok", (c) => {
    const qs = new URL(c.req.url).searchParams;
    qs.set("source", "tiktok");
    // 302 (not 301): the target is computed from transient query params.
    return c.redirect(`/summaries?${qs.toString()}`, 302);
  });

  // CORS preflight for Chrome extension
  app.options("/api/tiktok/summarize", () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
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

  app.get("/api/tiktok/stream/:jobId", (c) => {
    const jobId = c.req.param("jobId");
    const job = getJob(jobId);

    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      // Replay current state
      await stream.writeSSE({ event: "status", data: JSON.stringify({ status: job.status }) });
      if (job.text) {
        await stream.writeSSE({ event: "text_delta", data: JSON.stringify({ text: job.text }) });
      }
      if (job.category) {
        await stream.writeSSE({ event: "category", data: JSON.stringify({ category: job.category }) });
      }
      if (job.similar) {
        await stream.writeSSE({ event: "similar", data: JSON.stringify({ articles: job.similar }) });
      }

      // If already terminal, send final event and close. The complete event
      // carries the parsed summary so the client can drop any replayed chatter.
      if (job.status === "complete") {
        await stream.writeSSE({ event: "complete", data: JSON.stringify({ summary: job.summary }) });
        return;
      }
      if (job.status === "error") {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: job.error }) });
        return;
      }

      // Subscribe to live updates
      let alive = true;
      const unsubscribe = subscribeTikTokJob(jobId, async (event) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === "complete" || event.type === "error") {
            alive = false;
          }
        } catch {
          alive = false;
        }
      });

      // Heartbeat every 30s
      const heartbeat = setInterval(async () => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
        } catch {
          alive = false;
        }
      }, 30_000);

      stream.onAbort(() => {
        alive = false;
        unsubscribe();
        clearInterval(heartbeat);
      });

      while (alive) {
        await Bun.sleep(1000);
      }
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  app.get("/api/tiktok/jobs", (c) => {
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const jobs = getRecentJobs(Math.min(Math.max(limit, 1), 100));
    return c.json({ jobs });
  });

  // --- TikTok browse (proxy to knowledge API) ---
  // The merged /summaries view reads /api/summaries/documents for the listing;
  // the /document/* + /similar endpoints stay — the unified client still calls
  // them per-source via SOURCES[].apiBase.

  app.get("/api/tiktok/document/*", async (c) => {
    // Read the still-encoded path from the raw URL — c.req.path decodes lossily
    // (decodeURI-style) and re-encoding it would double-encode reserved chars
    // like %2C/%24, 404ing upstream (surfaced as 502). The client already
    // encodeURIComponent'd each segment, so forward that encoding verbatim.
    const encodedDocId = new URL(c.req.url).pathname.replace("/api/tiktok/document/", "");
    if (!encodedDocId) return c.json({ error: "Missing document ID" }, 400);
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/document/${TT_COLLECTION}/${encodedDocId}`);
  });

  app.get("/api/tiktok/similar", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Missing query parameter" }, 400);
    const params = new URLSearchParams({ q, collection: TT_COLLECTION, limit: "7" });
    return knowledgeApiHandler(c, KNOWLEDGE_API_URL, `/api/search?${params}`, 10000);
  });
}
