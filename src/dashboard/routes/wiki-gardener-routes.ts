import type { Hono } from "hono";
import path from "node:path";
import { renderWikiGardenerPage } from "../views/wiki-gardener-page.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { listWikis, resolveWikiRequest, type WikiRegistryEntry } from "../../wiki/registry.ts";
import { getWikiRegistry } from "./wiki-routes.ts";
import { discoverAllBots, type BotConfig } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { lineDiff, type DiffLine } from "../../gardener/diff.ts";
import { applyWikiProposal, draftTitle, type ApplyDeps } from "../../gardener/apply.ts";
import {
  approveWikiProposal,
  rejectWikiProposal,
  markWikiProposalApplied,
  markWikiProposalStale,
  markWikiProposalError,
  listAllWikiProposals,
  getWikiProposalById,
  type WikiProposal,
} from "../../db/wiki-proposals.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "wiki-gardener");

const KNOWLEDGE_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";

/** Bot configs are static until restart — discover once and memoize (see wiki-routes.ts). */
let cachedBots: BotConfig[] | null = null;
function getBots(): BotConfig[] {
  return (cachedBots ??= discoverAllBots());
}

/**
 * The gardener is bot-scoped — proposals are keyed by bot, and applying writes
 * into a bot's wiki. It shares the reader's memoized registry (one bot discovery
 * + `WIKI_EXTRA` parse for the whole dashboard) and filters to bot-source wikis
 * so the picker only lists bot wikis. Resolution still runs against the full
 * registry so a `?wiki=<extra>` (e.g. mimir) is recognized as a non-bot wiki
 * rather than silently falling through to the default bot.
 */
function getBotRegistry(): WikiRegistryEntry[] {
  return getWikiRegistry().filter((e) => e.source === "bot");
}

/** The rich per-proposal shape the review page renders (meta + server-computed preview/diff). */
interface ProposalView {
  id: string;
  topicKey: string;
  title: string;
  kind: string;
  mode: string;
  targetPath: string;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
  rationale: string | null;
  sourceDocs: { collection: string; docId: string; title: string; url: string }[];
  /** Rendered draft preview — empty for terminal rows (applied/rejected/error). */
  previewHtml: string;
  diff: DiffLine[] | null;
}

async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await Bun.file(absPath).text();
  } catch {
    return null;
  }
}

/** Real huginn reindex seam — best-effort POST, never throws (swallowed for apply). */
async function triggerReindex(collection: string): Promise<void> {
  try {
    await fetchKnowledgeApi(
      KNOWLEDGE_API_URL,
      `/api/collections/${encodeURIComponent(collection)}/update`,
      { method: "POST", timeoutMs: 10_000 },
    );
    log.info("Wiki-gardener: triggered reindex of collection {collection}", { collection });
  } catch (err) {
    log.warn("Wiki-gardener: reindex trigger failed for {collection}: {error}", {
      collection,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Build the filesystem/index/reindex seams the apply step needs for a wiki root. */
function applyDepsFor(wikiDir: string): ApplyDeps {
  return {
    wikiDir,
    now: () => Date.now(),
    readFile: readFileOrNull,
    // Bun.write creates parent directories itself.
    writeFile: async (absPath, content) => {
      await Bun.write(absPath, content);
    },
    getWikiIndex: () => getWikiIndex({ root: wikiDir }),
    refreshIndex: async () => {
      await getWikiIndex({ root: wikiDir, refresh: true });
    },
    reindex: triggerReindex,
  };
}

/** Flip the terminal status via CAS; a null result means the row's state changed
 *  under us — surface that instead of reporting success. */
async function finishProposal(
  id: string,
  mark: (id: string) => Promise<WikiProposal | null>,
  label: string,
): Promise<boolean> {
  const row = await mark(id);
  if (!row) {
    log.error("Wiki-gardener: terminal CAS to {label} lost for proposal {id} — state changed during apply", {
      label,
      id,
    });
    return false;
  }
  return true;
}

export function registerWikiGardenerRoutes(app: Hono): void {
  // Review page.
  app.get("/wiki/gardener", async (c) => {
    const wikiBots = listWikis(getBotRegistry());
    // Resolve against the FULL registry so a `?wiki=<extra>` (e.g. mimir) is
    // recognized as a non-bot wiki and gets a clean "unavailable" state instead
    // of a picker that mis-highlights the first bot while the body errors.
    const { wiki: selected, envOverride, entry } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    const notBotWiki = !!entry && entry.source !== "bot";
    return c.html(await renderWikiGardenerPage({ wikiBots, selected, envOverride, notBotWiki }));
  });

  // List a bot's proposals (all statuses, newest first). Preview + diff are only
  // computed for the rows a reviewer actually inspects (draft/stale) so the page
  // cost doesn't grow unbounded with terminal history.
  app.get("/api/wiki/proposals", async (c) => {
    // One resolution against the full registry — root + source + bot all come from
    // the single resolved entry (no separate root lookup + re-resolve dance).
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) {
      return c.json({ proposals: [], error: "no wiki configured for that name" });
    }
    if (entry && entry.source !== "bot") {
      return c.json({ proposals: [], error: "the gardener is only available for bot wikis" });
    }
    // The default wiki (bare request) resolves to a concrete bot entry, so `root`
    // matches the bot the proposals are drawn from — previews + update-diffs read
    // the same wiki the gardener writes into.
    const root = entry?.root;
    const bot = entry ? getBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase() && !!b.wikiDir) : undefined;
    if (!bot) return c.json({ proposals: [], error: "no wiki bot resolved" });

    const rows = await listAllWikiProposals(bot.name);
    const index = await getWikiIndex({ root });
    const resolve = index ? index.resolve : () => undefined;

    const proposals: ProposalView[] = await Promise.all(
      rows.map(async (p) => {
        const title = draftTitle(p);
        const reviewable = p.status === "draft" || p.status === "stale";
        let diff: DiffLine[] | null = null;
        if (reviewable && p.mode === "update" && root) {
          const current = await readFileOrNull(path.join(root, p.targetPath));
          if (current !== null) diff = lineDiff(current, p.draft);
        }
        return {
          id: p.id,
          topicKey: p.topicKey,
          title,
          kind: p.kind,
          mode: p.mode,
          targetPath: p.targetPath,
          status: p.status,
          createdAt: p.createdAt,
          resolvedAt: p.resolvedAt,
          rationale: p.rationale,
          sourceDocs: p.sourceDocs,
          previewHtml: reviewable ? renderWikiHtml(p.draft, resolve, { stripTitle: title }) : "",
          diff,
        };
      }),
    );
    return c.json({ proposals });
  });

  // Approve → CAS draft→approved, run the apply step, flip to applied|stale|error.
  // A row already in `approved` is re-runnable (recovery for a crash between the
  // approve CAS and the terminal CAS — apply itself is re-run safe).
  app.post("/api/wiki/proposals/:id/approve", async (c) => {
    const id = c.req.param("id");
    const existing = await getWikiProposalById(id);
    if (!existing) return c.json({ error: "proposal not found" }, 404);

    let claimed: WikiProposal | null = null;
    if (existing.status === "draft") {
      claimed = await approveWikiProposal(id);
      if (!claimed) {
        return c.json({ error: "proposal is no longer a draft", status: existing.status }, 409);
      }
    } else if (existing.status === "approved") {
      claimed = existing;
      log.info("Wiki-gardener: re-running apply for stuck approved proposal {id}", { id });
    } else {
      return c.json({ error: "proposal is not reviewable", status: existing.status }, 409);
    }

    const bot = getBots().find((b) => b.name === claimed.botName);
    if (!bot || !bot.wikiDir) {
      await finishProposal(id, markWikiProposalError, "error");
      log.error("Wiki-gardener approve: bot {bot} has no wikiDir — cannot apply proposal {id}", {
        bot: claimed.botName,
        id,
      });
      return c.json({ outcome: "error", error: "bot has no wikiDir configured" }, 500);
    }

    let result;
    try {
      result = await applyWikiProposal(claimed, applyDepsFor(bot.wikiDir));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await finishProposal(id, markWikiProposalError, "error");
      log.error("Wiki-gardener apply threw for {id}: {error}", { id, error: reason });
      return c.json({ outcome: "error", error: reason }, 500);
    }

    if (result.outcome === "applied") {
      if (!(await finishProposal(id, markWikiProposalApplied, "applied"))) {
        return c.json({ error: "proposal state changed during apply" }, 409);
      }
      log.info("Wiki-gardener applied proposal {id} → {path}", { id, path: result.writtenPath });
      return c.json({ outcome: "applied", writtenPath: result.writtenPath });
    }
    if (result.outcome === "stale") {
      if (!(await finishProposal(id, markWikiProposalStale, "stale"))) {
        return c.json({ error: "proposal state changed during apply" }, 409);
      }
      log.info("Wiki-gardener proposal {id} stale: {reason}", { id, reason: result.reason });
      return c.json({ outcome: "stale", reason: result.reason });
    }
    await finishProposal(id, markWikiProposalError, "error");
    log.error("Wiki-gardener apply error for {id}: {reason}", { id, reason: result.reason });
    return c.json({ outcome: "error", error: result.reason }, 500);
  });

  // Reject → CAS draft→rejected. Rejected topicKeys are skipped by the cluster filter.
  app.post("/api/wiki/proposals/:id/reject", async (c) => {
    const id = c.req.param("id");
    const existing = await getWikiProposalById(id);
    if (!existing) return c.json({ error: "proposal not found" }, 404);

    const rejected = await rejectWikiProposal(id);
    if (!rejected) {
      return c.json({ error: "proposal is no longer a draft", status: existing.status }, 409);
    }
    return c.json({ outcome: "rejected" });
  });
}
