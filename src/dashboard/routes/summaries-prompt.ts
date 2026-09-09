import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { allowsCaptureSnapshotRead } from "../../auth/resource-guard.ts";
import { getLatestCaptureSnapshotByUrl } from "../../db/prompt-snapshots.ts";
import { getTraceOwner } from "../../db/traces.ts";

const log = getLog("dashboard");

/**
 * The prompt a stored summary was written from, addressed by the document's URL.
 *
 * Its own module, beside `summaries-share.ts`, for the reason that module has:
 * it is an adapter onto another layer, and its lookups are injectable so the
 * route test drives the shapes rather than a database.
 *
 * **Why the URL and not the trace id.** A capture's trace is swept after 7 days
 * and its prompt snapshot is kept for 90, so the document is the durable
 * handle and the trace is the perishable one. `traceExists` is what lets the
 * caller offer a `/traces#<traceId>/prompt/<pass>` link only while the
 * waterfall behind it is still there — the body itself never depends on it.
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
  traceExists: async (traceId) => (await getTraceOwner(traceId)).found,
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
    const url = c.req.query("url");
    if (!url) return c.json({ error: "url is required" }, 400);

    try {
      const snapshot = await deps.loadSnapshot(url);
      if (!snapshot) return c.json({ error: "no snapshot for this document" }, 404);
      return c.json({
        traceId: snapshot.traceId,
        pass: snapshot.pass,
        systemPrompt: snapshot.systemPrompt,
        userPrompt: snapshot.userPrompt,
        createdAt: snapshot.createdAt,
        traceExists: await deps.traceExists(snapshot.traceId),
      });
    } catch (err) {
      log.error("Failed to fetch capture prompt snapshot: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to fetch prompt snapshot" }, 500);
    }
  });
}
