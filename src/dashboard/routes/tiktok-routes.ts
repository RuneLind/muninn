import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../tiktok/state.ts";
import { summarizeTikTok } from "../../tiktok/summarizer.ts";
import { extractTikTokVideoId } from "../../video/media.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";
import {
  isShortLink,
  parseAllowedTikTokUrl,
  resolveTikTokShortLink,
  tiktokDownloadUrl,
} from "./tiktok-url.ts";
import { applyCors } from "../../auth/cors.ts";
import {
  shortVideoCaptureBlocker,
  shortVideoCaptureKinds,
} from "../../video/short-video-kinds.ts";
import {
  DEFAULT_CAPTURE_KIND,
  capturePresetOptions,
  findCapturePreset,
} from "../../summaries/presets.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const TT_SOURCE = getSummarySource("tiktok")!;
const TT_COLLECTION = TT_SOURCE.collection;

/** This vertical's word for the frames in the capture-blocked sentence. */
const TT_FRAME_NOUN = "TikTok frames";

interface TtDocumentMeta { id: string; url?: string }

/**
 * Resolve the numeric video id from an input URL. A canonical `/video/<id>` URL
 * parses with zero latency; a short link is followed hop by hop. A short link
 * that leaves TikTok is refused; any other failure returns a null id so the
 * caller skips the dedup pre-check and proceeds — the yt-dlp-resolved id in the
 * background job still drives the canonical URL, so the only cost is a rare
 * duplicate.
 */
async function resolveVideoId(
  url: string,
): Promise<{ videoId: string | null } | { refused: string }> {
  const direct = extractTikTokVideoId(url);
  if (direct) return { videoId: direct };
  if (!isShortLink(url)) return { videoId: null };

  const res = await resolveTikTokShortLink(url);
  if (res.kind === "refused") {
    log.warn("TikTok short link {url} refused: {reason}", { url, reason: res.reason });
    return { refused: res.reason };
  }
  if (res.kind === "failed") {
    log.warn("TikTok short-link resolution failed for {url} — skipping dedup pre-check: {error}", {
      url,
      error: res.reason,
    });
    return { videoId: null };
  }
  return { videoId: extractTikTokVideoId(res.url) };
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

  /**
   * The kinds this instance offers, so a client renders its picker from the
   * server instead of from a catalog of its own — the `/api/youtube/options`
   * shape, and the same resolution the POST validates against.
   *
   * `applyCors` for the reason the POST has it: the entry point is a Chrome
   * extension, whose `muninnUrl` is user-editable past the manifest's
   * `localhost:3010` grant, so without the header this GET fails silently on
   * every other install and the picker falls back to Standard-only. It stays a
   * CORS *simple* request — a `GET` with no custom headers — so no preflight is
   * needed and none is registered.
   *
   * `capture.supported` is the POST's own 503 pre-flight, asked ahead of time
   * and carrying the same sentence — the honest field, because that pre-flight
   * does not depend on `frames` (see `shortVideoCaptureBlocker`).
   * `frames.supported` is the same answer under its older name, kept so an
   * already-installed extension keeps reading the field it knows.
   */
  app.get("/api/tiktok/options", (c) => {
    applyCors(c);
    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured", code: "no_bot" }, 500);
    }
    const blocker = shortVideoCaptureBlocker(summarizerBot, TT_FRAME_NOUN);
    return c.json({
      kinds: capturePresetOptions(shortVideoCaptureKinds(summarizerBot)),
      // The id a client sends when the reader picks nothing. Named rather than
      // left as "the first entry", so a picker never has to assume an order.
      default_kind: DEFAULT_CAPTURE_KIND,
      frames: { supported: blocker === null },
      capture: blocker === null ? { supported: true } : { supported: false, reason: blocker },
    });
  });

  app.post("/api/tiktok/summarize", async (c) => {
    applyCors(c);

    // `kind` is `unknown`, not `string?`: typed as a string, the `typeof`
    // guard below narrows to `never` and the shape it exists to refuse is the
    // one TypeScript says cannot happen. `youtube-routes.ts` has the same.
    const body = await c.req.json<{
      title?: string;
      url?: string;
      frames?: boolean;
      kind?: unknown;
    }>();
    const { title, url: rawUrl, frames } = body;

    if (!rawUrl) {
      return c.json({ error: "Missing required field: url" }, 400);
    }
    const accepted = typeof rawUrl === "string" ? parseAllowedTikTokUrl(rawUrl) : null;
    if (!accepted) {
      return c.json(
        { error: "Not a TikTok URL: expected an https link on tiktok.com", code: "bad_url" },
        400,
      );
    }
    // Everything below — dedup, the job row, yt-dlp — gets a URL built from the
    // parsed one, in the form the `TikTok`/`vm.tiktok` extractors match.
    const url = tiktokDownloadUrl(accepted);
    // The popup sends the pasted URL as its title; a title equal to the URL is
    // how the job knows to use yt-dlp's title instead, so follow the rewrite.
    const jobTitle = !title || title === rawUrl || title === accepted.href ? url : title;

    // Preflight: yt-dlp is a hard runtime dependency for this vertical.
    if (!Bun.which("yt-dlp")) {
      return c.json(
        { error: "yt-dlp not found on PATH. Install it with 'brew install yt-dlp'." },
        500,
      );
    }

    // The summary KIND, validated ABOVE the duplicate lookup and above
    // `createJob` — the YouTube/Vimeo ordering, for the same reason: a picker
    // value this instance does not offer is a 400 whatever the video, and it
    // must cost neither a huginn listing read nor a job row. Absent is the
    // default (an older extension, a curl); PRESENT BUT BLANK is refused with
    // the unknown ones, because `findCapturePreset` reads a blank id as ABSENT
    // and that is the wrong answer for a picker that failed to fill. `error` is
    // prose and `code` is the machine token — the shape a popup renders.
    //
    // The bot is resolved here rather than below for the same reason: the
    // offered set is the bot's, so the 400 cannot be answered without it.
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

    const resolved = await resolveVideoId(url);
    if ("refused" in resolved) {
      return c.json(
        { error: `Not a TikTok URL: the short link was refused (${resolved.refused})`, code: "bad_url" },
        400,
      );
    }
    const { videoId } = resolved;

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

    // Pre-flight BEFORE createJob: a job created above an early return is never
    // settled, and an unsettled job lingers for the in-flight grace (hours) at
    // the TOP of /summaries with a "running" /agents card. The bot itself is
    // resolved further up now, because the kind check needs it.
    //
    // Fail fast if the summarizer bot's connector can't grant --add-dir access:
    // the multi-turn flow Reads frame JPEGs from a tmp dir, which only the
    // Claude CLI connector can express. Reject here, before the expensive
    // download + whisper pre-work.
    const blocker = shortVideoCaptureBlocker(summarizerBot, TT_FRAME_NOUN);
    if (blocker !== null) {
      return c.json({ error: blocker }, 503);
    }

    const jobId = createJob(videoId ?? "", jobTitle, url);

    // Fire and forget — background summarization
    summarizeTikTok(jobId, url, jobTitle, config, summarizerBot, { frames, preset }).catch((err) => {
      log.error("TikTok summarization failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    });

    return c.json({ job_id: jobId, dashboard_url: `/summaries?source=tiktok&job=${jobId}` });
  });
}
