import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import {
  listCandidates,
  getCandidateById,
  setCandidateStatus,
} from "../../db/summary-candidates.ts";
import { isValidUuid } from "./route-utils.ts";

const log = getLog("dashboard");

/**
 * Anthropic vertical — the candidate inbox half of the Claude Learning Center.
 *
 * Today this exposes the read-only candidate list (Phase D-list) plus a Dismiss
 * action. The Summarize button on the `/summaries` inbox is intentionally inert
 * until Phases A+C land — there is no `anthropic-summaries` collection to ingest
 * into and no summarizer pipeline yet, so no summarize endpoint exists here. When
 * Phase C builds the vertical (state + summarizer + ingest), it extends this
 * module with `/api/anthropic/{summarize,stream,jobs,document,similar}` and a
 * `POST /api/anthropic/candidates/:id/summarize`, mirroring youtube-routes.ts.
 */
export function registerAnthropicRoutes(app: Hono, _config: Config): void {
  // The ranked, pre-annotated candidate inbox. Defaults to the unworked queue
  // (status `new`); the watcher captures these on its 2h Highlights cadence.
  app.get("/api/anthropic/candidates", async (c) => {
    try {
      const candidates = await listCandidates({ source: "anthropic", status: "new" });
      return c.json({ candidates });
    } catch (err) {
      log.error("Listing anthropic candidates failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to load candidates" }, 500);
    }
  });

  // Drop a candidate from the inbox. Idempotent-ish: a missing row 404s, an
  // already-dismissed one stays dismissed (setCandidateStatus is an unconditional
  // UPDATE, so re-dismissing is a harmless no-op).
  app.post("/api/anthropic/candidates/:id/dismiss", async (c) => {
    const id = c.req.param("id");
    if (!isValidUuid(id)) {
      return c.json({ error: "Invalid candidate id" }, 400);
    }
    try {
      const candidate = await getCandidateById(id);
      if (!candidate) {
        return c.json({ error: "Candidate not found" }, 404);
      }
      await setCandidateStatus(id, "dismissed");
      return c.json({ ok: true });
    } catch (err) {
      log.error("Dismissing anthropic candidate {id} failed: {error}", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to dismiss candidate" }, 500);
    }
  });
}
