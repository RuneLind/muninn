import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { allowsCaptureSnapshotRead } from "../../auth/resource-guard.ts";
import { getLatestCaptureSnapshotByUrl } from "../../db/prompt-snapshots.ts";
import { traceExists } from "../../db/traces.ts";

const log = getLog("dashboard");

/**
 * The prompt a capture's SUMMARY PASS was sent, addressed by the document's URL.
 *
 * The seam a /summaries doc-panel control will call. **That control does not
 * exist yet** — the UI half is PR 3's — so today this route is reached by
 * `curl` and by the route test, and nothing on any page links to it.
 *
 * Its own module, beside `summaries-share.ts`, for the reason that module has:
 * it is an adapter onto another layer, and its lookups are injectable so the
 * route test drives the shapes rather than a database.
 *
 * **"the prompt the summary pass was sent", not "the prompt that produced the
 * summary".** The snapshot is written straight after the model call and BEFORE
 * the closing-takeaway grounding check, which can rewrite or remove the closer
 * (`src/summaries/takeaway-check.ts`) — so the stored summary may not be the
 * verbatim output of the stored prompt. The grounding call itself stores no
 * snapshot, so `/api/prompts/<traceId>?pass=claude:takeaway-check` 404s even
 * though that span is on the waterfall.
 *
 * **The url match is EXACT — no trimming past the query's own, no
 * normalization, no scheme or trailing-slash tolerance.** It is compared against
 * whatever string the vertical handed `runCaptureOneShot`, which is:
 *
 *  - YouTube — `youtubeWatchUrl(videoId)`
 *  - Vimeo — `canonicalVimeoUrl(id)`
 *  - TikTok — the download's `canonicalUrl`
 *  - X video — `canonicalUrl` (`canonicalXStatusUrl`)
 *  - X article / Anthropic — the url as submitted
 *  - pasted article — `""`, stored as NULL, so it is not addressable here at all
 *
 * A caller must pass that same string.
 *
 * **Why the URL and not the trace id.** A capture's trace is swept after 7 days
 * and its prompt snapshot is kept for 90, so the document is the durable
 * handle and the trace is the perishable one. `traceExists` is what lets the
 * caller offer a `/traces#<traceId>/prompt/<pass>` link only while the
 * waterfall behind it is still there — the body itself never depends on it, and
 * a lookup that throws degrades to `false` rather than withholding the prompt.
 */
export interface SummariesPromptDeps {
  loadSnapshot: (url: string) => Promise<{
    traceId: string;
    pass: string;
    systemPrompt: string;
    userPrompt: string;
    createdAt: number;
  } | null>;
  traceExists: (traceId: string) => Promise<boolean>;
}

const DEFAULT_DEPS: SummariesPromptDeps = {
  loadSnapshot: (url) => getLatestCaptureSnapshotByUrl(url),
  traceExists,
};

export function registerSummariesPromptRoutes(
  app: Hono,
  deps: SummariesPromptDeps = DEFAULT_DEPS,
): void {
  app.get("/api/summaries/prompt", async (c) => {
    // Its OWN guard, not `requireOwnedResource(c, "trace", …)`: this row is not
    // owned by anybody and outlives its trace, so the trace guard would refuse
    // every snapshot whose trace has been swept. See `decideCaptureSnapshotAccess`.
    if (!allowsCaptureSnapshotRead(c)) {
      return c.json({ error: "forbidden" }, 403);
    }
    // Trimmed BEFORE the empty check, so a whitespace-only `?url=` is the 400 it
    // is rather than a lookup that 404s with a message about the document.
    const url = (c.req.query("url") ?? "").trim();
    if (!url) return c.json({ error: "url is required" }, 400);

    try {
      const snapshot = await deps.loadSnapshot(url);
      if (!snapshot) return c.json({ error: "no snapshot for this document" }, 404);
      // Fail-SOFT, unlike the snapshot lookup below: this decides only whether
      // the waterfall link is offered, so a dead `traces` table must degrade to
      // "no link" rather than withhold the prompt the route exists to serve.
      const stillTraced = await deps.traceExists(snapshot.traceId).catch((err) => {
        log.warn("Trace existence check failed for {traceId}: {error}", {
          traceId: snapshot.traceId,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      });
      return c.json({
        traceId: snapshot.traceId,
        pass: snapshot.pass,
        systemPrompt: snapshot.systemPrompt,
        userPrompt: snapshot.userPrompt,
        createdAt: snapshot.createdAt,
        traceExists: stillTraced,
      });
    } catch (err) {
      log.error("Failed to fetch capture prompt snapshot: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to fetch prompt snapshot" }, 500);
    }
  });
}
