import type { Hono } from "hono";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { renderWikiGardenerPage } from "../views/wiki-gardener-page.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { parseFrontmatter } from "../../wiki/store.ts";
import { resolveBotWikiRoot, listWikiBots, resolveWikiRequest } from "../../wiki/bot-root.ts";
import { discoverAllBots, type BotConfig } from "../../bots/config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { lineDiff, type DiffLine } from "../../gardener/diff.ts";
import { applyWikiProposal, type ApplyDeps } from "../../gardener/apply.ts";
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
  previewHtml: string;
  diff: DiffLine[] | null;
}

function draftTitle(proposal: WikiProposal): string {
  const fm = parseFrontmatter(proposal.draft);
  const title = Array.isArray(fm.title) ? fm.title[0] : fm.title;
  return (title && title.trim()) || proposal.topicKey;
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

/** Build the filesystem/reindex seams the apply step needs for a given wiki root. */
function applyDepsFor(wikiDir: string): ApplyDeps {
  return {
    wikiDir,
    now: () => Date.now(),
    readFile: async (absPath) => {
      try {
        return await Bun.file(absPath).text();
      } catch {
        return null;
      }
    },
    writeFile: async (absPath, content) => {
      await mkdir(path.dirname(absPath), { recursive: true });
      await Bun.write(absPath, content);
    },
    fileExists: (absPath) => Bun.file(absPath).exists(),
    refreshIndex: async () => {
      await getWikiIndex({ root: wikiDir, refresh: true });
    },
    reindex: triggerReindex,
  };
}

export function registerWikiGardenerRoutes(app: Hono): void {
  // Review page.
  app.get("/wiki/gardener", async (c) => {
    const bots = getBots();
    const wikiBots = listWikiBots(bots);
    const { bot: selected, envOverride } = resolveWikiRequest(
      bots,
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    return c.html(await renderWikiGardenerPage({ wikiBots, selected, envOverride }));
  });

  // List a bot's proposals (all statuses, newest first) with rendered preview + diff.
  app.get("/api/wiki/proposals", async (c) => {
    const { root, unknownBot } = resolveBotWikiRoot(getBots(), c.req.query("bot"));
    if (unknownBot) {
      return c.json({ proposals: [], error: "no wiki configured for that bot" });
    }
    const bot = resolveProposalBot(c.req.query("bot"));
    if (!bot) return c.json({ proposals: [], error: "no wiki bot resolved" });

    const rows = await listAllWikiProposals(bot.name);
    const index = await getWikiIndex({ root });
    const resolve = index ? index.resolve : () => undefined;

    const proposals: ProposalView[] = await Promise.all(
      rows.map(async (p) => {
        const title = draftTitle(p);
        let diff: DiffLine[] | null = null;
        if (p.mode === "update" && root) {
          const current = await readWikiFile(path.join(root, p.targetPath));
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
          previewHtml: renderWikiHtml(p.draft, resolve, { stripTitle: title }),
          diff,
        };
      }),
    );
    return c.json({ proposals });
  });

  // Approve → CAS draft→approved, run the apply step, flip to applied|stale|error.
  app.post("/api/wiki/proposals/:id/approve", async (c) => {
    const id = c.req.param("id");
    const existing = await getWikiProposalById(id);
    if (!existing) return c.json({ error: "proposal not found" }, 404);

    const claimed = await approveWikiProposal(id);
    if (!claimed) {
      return c.json({ error: "proposal is no longer a draft", status: existing.status }, 409);
    }

    const bot = getBots().find((b) => b.name === claimed.botName);
    if (!bot || !bot.wikiDir) {
      await markWikiProposalError(id);
      log.error("Wiki-gardener approve: bot {bot} has no wikiDir — cannot apply proposal {id}", {
        bot: claimed.botName,
        id,
      });
      return c.json({ outcome: "error", reason: "bot has no wikiDir configured" }, 500);
    }

    let result;
    try {
      result = await applyWikiProposal(claimed, applyDepsFor(bot.wikiDir));
    } catch (err) {
      await markWikiProposalError(id);
      const reason = err instanceof Error ? err.message : String(err);
      log.error("Wiki-gardener apply threw for {id}: {error}", { id, error: reason });
      return c.json({ outcome: "error", reason }, 500);
    }

    if (result.outcome === "applied") {
      await markWikiProposalApplied(id);
      log.info("Wiki-gardener applied proposal {id} → {path}", { id, path: result.writtenPath });
      return c.json({ outcome: "applied", writtenPath: result.writtenPath });
    }
    if (result.outcome === "stale") {
      await markWikiProposalStale(id);
      log.info("Wiki-gardener proposal {id} stale: {reason}", { id, reason: result.reason });
      return c.json({ outcome: "stale", reason: result.reason });
    }
    await markWikiProposalError(id);
    log.error("Wiki-gardener apply error for {id}: {reason}", { id, reason: result.reason });
    return c.json({ outcome: "error", reason: result.reason }, 500);
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

/** Resolve the BotConfig backing a `?bot=` query (or the default wiki bot). */
function resolveProposalBot(rawBot: string | undefined): BotConfig | undefined {
  const bots = getBots();
  const { bot: selected } = resolveWikiRequest(bots, rawBot, process.env.WIKI_DIR);
  if (!selected) return undefined;
  return bots.find((b) => b.name.toLowerCase() === selected.toLowerCase() && !!b.wikiDir);
}

async function readWikiFile(absPath: string): Promise<string | null> {
  try {
    return await Bun.file(absPath).text();
  } catch {
    return null;
  }
}
