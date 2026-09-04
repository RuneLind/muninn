import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { createJob, getJob, getRecentJobs, subscribe } from "../../vimeo/state.ts";
import { summarizeVimeo, VIMEO_MAX_DURATION_SEC } from "../../vimeo/summarizer.ts";
import { canonicalVimeoUrl, resolveVimeoRef } from "../../vimeo/url.ts";
import { fetchVimeoOembed, isNotPublic } from "../../vimeo/oembed.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { getSummarySource } from "../../summaries/sources.ts";
import { registerSummaryVertical } from "./summary-vertical.ts";

const log = getLog("dashboard");

// Single source of truth for the collection name lives in the registry.
const VIMEO_SOURCE = getSummarySource("vimeo")!;
const VIMEO_COLLECTION = VIMEO_SOURCE.collection;

interface VimeoDocumentMeta { id: string; url?: string }

/**
 * Look for an already-captured document with this video's CANONICAL url.
 *
 * Compared as whole strings rather than by re-extracting an id: every writer of
 * this collection posts `canonicalVimeoUrl(id)`, so the stored url is the key by
 * construction, and re-parsing would be a second, weaker copy of that rule.
 * A failed listing degrades to "not a duplicate" — the same call the other
 * verticals make, since the cost is a rare re-capture and the alternative is
 * refusing to capture while huginn is down.
 */
async function findExistingByUrl(
  baseUrl: string,
  canonicalUrl: string,
): Promise<VimeoDocumentMeta | null> {
  try {
    const data = await fetchKnowledgeApi(
      baseUrl,
      `/api/collection/${VIMEO_COLLECTION}/documents`,
      { timeoutMs: 10000 },
    );
    const docs = (data?.documents ?? []) as VimeoDocumentMeta[];
    return docs.find((d) => d.url === canonicalUrl) ?? null;
  } catch (err) {
    log.warn("Vimeo duplicate check failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function registerVimeoRoutes(app: Hono, config: Config): void {
  const KNOWLEDGE_API_URL = config.knowledgeApiUrl;

  // Shared plumbing: bare-path redirect, SSE stream, jobs, document/similar
  // proxies. NO CORS preflight and no `applyCors` on the POST below: there is no
  // Chrome extension for this vertical (PR 3 adds a URL field on /summaries,
  // which is same-origin), and a cross-origin summarize entry is a way for any
  // page to spend the operator's model budget.
  registerSummaryVertical(app, config, {
    apiBase: VIMEO_SOURCE.apiBase,
    collection: VIMEO_COLLECTION,
    store: { getJob, getRecentJobs, subscribe },
    redirect: { path: "/vimeo", source: "vimeo" },
    corsPreflight: false,
  });

  app.post("/api/vimeo/summarize", async (c) => {
    const body = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
    const url = body.url;

    if (!url) {
      return c.json({ error: "Missing required field: url" }, 400);
    }

    const ref = resolveVimeoRef(url);
    if (!ref) {
      return c.json({ error: `Not a Vimeo video URL: ${url}` }, 400);
    }

    // oEmbed FIRST, and everything that can refuse the capture happens on its
    // answer — before a job exists. A job created above an early return is never
    // settled and lingers for the whole in-flight grace at the top of
    // /summaries with a "running" /agents card (the ordering
    // capture-route-job-ordering.test.ts pins for the other verticals).
    let meta;
    try {
      meta = await fetchVimeoOembed(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Vimeo oEmbed failed for {url}: {error}", { url, error: message });
      return c.json({ error: "oembed_failed", detail: message }, 502);
    }

    if (isNotPublic(meta)) {
      return c.json({ error: "not_public", status: meta.status }, 422);
    }

    if (meta.durationSec > VIMEO_MAX_DURATION_SEC) {
      return c.json(
        { error: "too_long", durationSec: meta.durationSec, maxSec: VIMEO_MAX_DURATION_SEC },
        413,
      );
    }

    const canonicalUrl = canonicalVimeoUrl(ref.id);
    // oEmbed can answer 200 with no title (`toMetadata` degrades every field to
    // ""), and huginn derives the document's FILENAME from the title — an empty
    // one would collide with every other title-less capture. The url is a
    // usable, unique stand-in.
    const title = meta.title || canonicalUrl;
    const existing = await findExistingByUrl(KNOWLEDGE_API_URL, canonicalUrl);
    if (existing) {
      log.info("Vimeo duplicate detected for {videoId}: {docId}", {
        videoId: ref.id,
        docId: existing.id,
      });
      return c.json({
        duplicate: true,
        document_id: existing.id,
        existing_url: existing.url,
        dashboard_url: `/summaries?source=vimeo&doc=${encodeURIComponent(existing.id)}&duplicate=1`,
      });
    }

    const summarizerBot = resolveSummarizerBot(discoverAllBots());
    if (!summarizerBot) {
      return c.json({ error: "No bots configured" }, 500);
    }

    const jobId = createJob(ref.id, title, canonicalUrl);

    // Fire and forget — background capture.
    summarizeVimeo(
      jobId,
      {
        videoId: ref.id,
        ...(ref.hash ? { hash: ref.hash } : {}),
        url: canonicalUrl,
        title,
        durationSec: meta.durationSec,
        uploadDate: meta.uploadDate,
      },
      config,
      summarizerBot,
    ).catch((err) => {
      log.error("Vimeo summarization failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({ job_id: jobId, dashboard_url: `/summaries?source=vimeo&job=${jobId}` });
  });
}
