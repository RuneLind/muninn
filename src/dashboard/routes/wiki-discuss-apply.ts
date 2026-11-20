/**
 * `POST /api/wiki/discuss/apply` — the wiki agent's proposed edit, previewed
 * and applied by its stored turn id (mimir plan muninn-wiki-discuss, P4). The
 * client never sends old or new text: the edit is the turn row's
 * `proposed_edit`, so this cannot become a general edit route.
 *
 *  - `{turnId, preview: true}` answers the diff (the file's text in the range
 *    and what replaces it, with context and lines), the `checkPageText`
 *    findings the edit adds, the page's base hash, the preview hash and the
 *    `log.md` entry. It writes nothing.
 *  - `{turnId, baseHash, previewHash}` applies it.
 *
 * The edit is resolved by `resolveDiscussEdit` (`src/wiki/discuss-apply.ts`).
 * The write copies Done's (`wiki-step-done.ts`) except its scope: the page by
 * `relPath` through the index, the wikis that have the agent (a `.wiki-agent.md`
 * the discuss route accepts) instead of the decision triage's list. Refusals,
 * in order: 403 role not admin · 415 not JSON · 403 `readonly` the instance ·
 * 400 body · 404 unknown turn · 404 the turn's wiki is not configured here ·
 * 403 `readonly` a read-only root · 404 `no-agent` · 409 `not-done` the turn
 * did not end done · 409 `superseded` a newer turn of the discussion exists ·
 * 409 `applied` already applied · 404 no page · 409 unreadable · 409 `stale`
 * the page changed since the preview's base hash · 409 `refused` the edit
 * cannot apply (its `code` names why) · 409 `changed` the preview hash no longer
 * fits · 409 `held` a Gardener card holds the page (503 when the cards cannot
 * be read) · 409 `locked` another process writes the wiki · 409 `dirty` the page
 * has uncommitted changes · 500 a write error. Then `writeWikiPage` (it takes
 * the per-wiki write queue itself), a `log.md` line of kind `update`, the
 * commit after it, the index rebuilt after the commit, and the turn marked
 * applied. In the `wiki` route group, which `MUNINN_PROFILE=nais` drops.
 */

import path from "node:path";
import type { Context, Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { discoverAllBots, type BotConfig } from "../../bots/config.ts";
import { getDiscussTurn, listDiscussTurns, markDiscussEditApplied, type DiscussTurn } from "../../db/wiki-discuss-turns.ts";
import { heldBy, heldMessage, staleProposalStore } from "../../gardener/stale-proposals.ts";
import { sha256, todayOslo } from "../../utils/date-hash.ts";
import { readWikiAgentRules } from "../../wiki/discuss-agent.ts";
import { resolveDiscussEdit, type DiscussEditPlan } from "../../wiki/discuss-apply.ts";
import { commitWikiChange, pageHasUncommittedChanges, type CommitWikiResult } from "../../wiki/commit.ts";
import { checkPageText, pageTextFiles, type LintFinding } from "../../wiki/lint.ts";
import { writeWikiPage } from "../../wiki/page-write.ts";
import { isReadonlyWikiRoot } from "../../wiki/readonly.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { postCollectionUpdate } from "../../wiki/reindex.ts";
import { getWikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { plainSnippet } from "../../wiki/find-everywhere.ts";
import { requireJsonRequest } from "./json-request.ts";
import { isValidUuid } from "./route-utils.ts";
import type { DecisionCloseGuards } from "./wiki-decision-inbox.ts";

const log = getLog("dashboard", "wiki-discuss-apply");

export const WIKI_DISCUSS_APPLY_PATH = "/api/wiki/discuss/apply";
/** The existing `log.md` kind: an edit to a page. */
export const DISCUSS_APPLY_LOG_KIND = "update";

export interface DiscussApplyDeps {
  registry: () => WikiRegistryEntry[];
  isReadonlyRoot: (root: string) => boolean;
  bots: () => BotConfig[];
  turns: { get: typeof getDiscussTurn; list: typeof listDiscussTurns; markApplied: typeof markDiscussEditApplied };
  commit: (root: string, paths: string[], message: string, push: boolean) => Promise<CommitWikiResult>;
  now: () => number;
}

export function realDiscussApplyDeps(): DiscussApplyDeps {
  return {
    registry: getWikiRegistry,
    isReadonlyRoot: isReadonlyWikiRoot,
    bots: discoverAllBots,
    turns: { get: getDiscussTurn, list: listDiscussTurns, markApplied: markDiscussEditApplied },
    commit: (root, paths, message, push) => commitWikiChange(root, paths, message, { push }),
    now: Date.now,
  };
}

/** The page file's text with a leading BOM KEPT: `Bun.file().text()` drops
 *  it, and a write of that text would change the file outside the edit. */
async function readKeepingBom(absPath: string): Promise<string | null> {
  try {
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await Bun.file(absPath).bytes());
  } catch {
    return null;
  }
}

function abbreviate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** The `log.md` line under the `update` heading. */
export function discussApplyLogLine(turn: Pick<DiscussTurn, "seq" | "discussionId">, plan: Pick<DiscussEditPlan, "before" | "after">): string {
  return `Discuss: applied the wiki agent's edit (turn ${turn.seq} of discussion ${turn.discussionId.slice(0, 8)}): "${abbreviate(plan.before, 80)}" → "${abbreviate(plan.after, 80)}"`;
}

/** The commit subject. */
export function discussApplyCommitMessage(turn: Pick<DiscussTurn, "seq">, relPath: string): string {
  return `[discuss] Apply the wiki agent's edit (turn ${turn.seq}): ${relPath}`;
}

/** The findings `checkPageText` raises on `after` and not on `before`, counted per check and message (lines move with the edit). */
export function findingsAdded(before: readonly LintFinding[], after: readonly LintFinding[]): LintFinding[] {
  const key = (f: LintFinding) => `${f.check}\u0000${f.message}`;
  const left = new Map<string, number>();
  for (const f of before) left.set(key(f), (left.get(key(f)) ?? 0) + 1);
  const added: LintFinding[] = [];
  for (const f of after) {
    const n = left.get(key(f)) ?? 0;
    if (n > 0) left.set(key(f), n - 1);
    else added.push(f);
  }
  return added;
}

const LOG_PROMISE = "log.md gets this entry; if appending it fails, the page edit still stands.";

export function registerWikiDiscussApplyRoute(app: Hono, config: Config, guards: DecisionCloseGuards, depsFor: () => DiscussApplyDeps = realDiscussApplyDeps): void {
  app.post(WIKI_DISCUSS_APPLY_PATH, async (c) => {
    try {
      return await apply(c);
    } catch (err) {
      log.error("Discuss apply failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the edit could not be applied" }, 500);
    }
  });

  async function apply(c: Context): Promise<Response> {
    if ((c.get("role") ?? "admin") !== "admin") return c.json({ error: "Discuss's wiki agent is for admins" }, 403);
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const ro = guards.readonlyRefusal(c);
    if (ro) {
      log.info("Discuss apply refused: the instance is read-only");
      return ro;
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
    const [turnId, baseHash, previewHash] = [str("turnId").toLowerCase(), str("baseHash"), str("previewHash")];
    const preview = body.preview === true;
    if (!isValidUuid(turnId)) return c.json({ error: "turnId must be a uuid" }, 400);
    if (!preview && (!baseHash || !previewHash)) return c.json({ error: "baseHash and previewHash are required: preview the edit first" }, 400);
    const deps = depsFor();
    const turn = await deps.turns.get(turnId);
    if (!turn) return c.json({ error: "no discuss turn with that id", reason: "unknown-turn" }, 404);
    const entry = deps.registry().find((e) => e.name.toLowerCase() === turn.wiki.toLowerCase());
    if (!entry) return c.json({ error: `no wiki configured for "${turn.wiki}"` }, 404);
    if (deps.isReadonlyRoot(entry.root)) return c.json({ error: "This wiki is read-only here.", readonly: true }, 403);
    const egress = guards.egressRefusal(c, entry);
    if (egress) return egress;
    // Apply's scope: the wikis that have the agent, as the discuss route reads them.
    if ((await readWikiAgentRules(path.resolve(entry.root))).state !== "ok") {
      return c.json({ error: "this wiki has no wiki agent (no .wiki-agent.md the agent accepts at its root)", reason: "no-agent" }, 404);
    }
    if (turn.endState !== "done") return c.json({ error: `the turn ended ${turn.endState}, not done; only a finished turn's edit applies`, reason: "not-done" }, 409);
    // The newest turn of the discussion (highest seq) is the current one; an older turn's edit is not offered.
    const newest = (await deps.turns.list(turn.discussionId)).reduce((m, t) => Math.max(m, t.seq), turn.seq);
    if (newest > turn.seq) return c.json({ error: `a newer turn (${newest}) of this discussion exists; only the newest turn's edit applies`, reason: "superseded" }, 409);
    if (turn.editAppliedAt !== null) return c.json({ error: "this edit is already applied", reason: "applied" }, 409);

    const index = await getWikiIndex({ root: entry.root });
    if (!index) return c.json({ error: "wiki directory not found" }, 503);
    const target = index.resolveRelPath(turn.relPath);
    if (!target) return c.json({ error: `no page ${turn.relPath}` }, 404);
    const absPath = path.join(entry.root, target.relPath);
    const current = await readKeepingBom(absPath);
    if (current === null) return c.json({ error: `${target.relPath} cannot be read` }, 409);
    const currentHash = sha256(current);
    if (!preview && baseHash !== currentHash) return c.json({ error: "The page changed since the edit was shown. Preview it again.", stale: true }, 409);
    const plan = resolveDiscussEdit(current, target.relPath, turn.proposedEdit);
    if (!plan.ok) return c.json({ error: plan.reason, refused: true, code: plan.code }, 409);
    const title = target.title ?? target.relPath;
    const logLine = discussApplyLogLine(turn, plan);
    const shown = sha256(JSON.stringify([target.relPath, plan.start, plan.end, plan.before, plan.after, logLine]));
    if (preview) {
      return c.json({
        ok: true,
        preview: true,
        turnId: turn.id,
        relPath: target.relPath,
        title,
        before: plan.before,
        after: plan.after,
        beforeCtx: plan.beforeCtx,
        afterCtx: plan.afterCtx,
        fromLine: plan.fromLine,
        toLine: plan.toLine,
        tier: plan.tier,
        // The old text as the reader shows it (markup out, at most 200 characters), for the tab's mark.
        markText: plainSnippet(plan.before).replace(/…$/, ""),
        note: noteOf(turn.proposedEdit),
        findings: await addedFindings(entry.root, target, index.readerConfig?.roleKeys ?? [], current, plan.content),
        pageChangedSinceTurn: currentHash !== turn.pageHash,
        logEntry: `## [${todayOslo(deps.now())}] ${DISCUSS_APPLY_LOG_KIND} | ${title}\n- ${logLine}`,
        logNote: LOG_PROMISE,
        baseHash: currentHash,
        previewHash: shown,
      });
    }
    if (previewHash !== shown) return c.json({ error: "What Apply writes changed since the preview. Preview again.", changed: true }, 409);
    try {
      const held = heldBy(await staleProposalStore().liveHolders(entry.name), target.relPath);
      if (held) return c.json({ error: heldMessage(held), held: true }, 409);
    } catch (err) {
      log.warn("Discuss apply: Gardener cards unavailable: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "The Gardener's cards could not be read, so the page's claim is unknown." }, 503);
    }
    const owningBot = entry.source === "bot" ? deps.bots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase()) : undefined;
    // A wiki no bot owns pushes by default, as Done does.
    const push = owningBot?.wikiAutoCommit?.push ?? true;
    let refusal: string | null = null;
    let dirty: string | null = null;
    let written: string | null = null;
    const result = await writeWikiPage({
      wikiDir: entry.root,
      relPath: target.relPath,
      baseHash,
      staleReason: "The page changed while the edit was applied. Preview it again.",
      collections: entry.collections ?? [],
      logKind: DISCUSS_APPLY_LOG_KIND,
      logTitle: title,
      logLine: () => logLine,
      commitMessage: () => discussApplyCommitMessage(turn, target.relPath),
      now: deps.now,
      proceed: async () => {
        const has = await pageHasUncommittedChanges(entry.root, target.relPath);
        if (has === false) return true;
        dirty =
          has === null
            ? `${target.relPath}: git status failed, so its uncommitted edits are unknown`
            : `${target.relPath} has changes that are not committed yet: a session is editing it, or an earlier write could not be committed. Commit or discard them, then try again.`;
        return false;
      },
      transform: (raw) => {
        // The CAS passed, so `raw` is the previewed text; resolved again all the same, never from the preview.
        const again = resolveDiscussEdit(raw, target.relPath, turn.proposedEdit);
        if (!again.ok) {
          refusal = again.reason;
          return null;
        }
        written = again.content;
        return again.content;
      },
      readFile: readKeepingBom,
      writeFile: async (p, content) => {
        await Bun.write(p, content);
      },
      refreshIndex: async () => {
        await getWikiIndex({ root: entry.root, refresh: true });
      },
      reindex: async (collection) => {
        await postCollectionUpdate(config.knowledgeApiUrl, collection);
      },
      commit: (paths, message) => deps.commit(entry.root, paths, message, push),
    });
    if (result.outcome === "forbidden") return c.json({ error: result.reason, readonly: true }, 403);
    if (result.outcome === "stale") return c.json({ error: result.reason, stale: true }, 409);
    if (result.outcome === "locked") return c.json({ error: `A session is writing to this wiki: ${result.reason}. Try again in a moment.`, locked: true }, 409);
    if (dirty) return c.json({ error: dirty, dirty: true }, 409);
    if (refusal) return c.json({ error: refusal, refused: true }, 409);
    if (result.outcome !== "written" || written === null) return c.json({ error: result.outcome === "error" ? result.reason : "nothing was written" }, 500);
    const committed = result.commit?.committed ?? false;
    const commitReason = result.commit?.reason ?? "error";
    await getWikiIndex({ root: entry.root, refresh: true }).catch(() => null);
    // The use count's record; the page edit stands whether or not it lands.
    await deps.turns.markApplied(turn.id).catch((err) => log.warn("Discuss apply: the turn could not be marked applied: {error}", { error: err instanceof Error ? err.message : String(err), turnId: turn.id }));
    log.info("discuss edit applied on {wiki} {relPath}", { wiki: entry.name, relPath: target.relPath, turnId: turn.id, seq: turn.seq, committed });
    return c.json({
      ok: true,
      page: target.relPath,
      committed,
      ...(committed ? {} : { commitReason, uncommitted: commitReason === "error" || commitReason === "not-default-branch" }),
    });
  }
}

function noteOf(proposed: unknown): string | null {
  const note = proposed && typeof proposed === "object" ? (proposed as { note?: unknown }).note : undefined;
  return typeof note === "string" && note.trim() ? note.trim() : null;
}

async function addedFindings(root: string, page: WikiPageMeta, roleKeys: readonly string[], before: string, after: string): Promise<{ check: string; message: string; line?: number; severity?: string }[]> {
  const run = async (text: string) => checkPageText(page, text, roleKeys, await pageTextFiles(root, page, text));
  try {
    return findingsAdded(await run(before), await run(after)).map((f) => ({ check: f.check, message: f.message, ...(f.line ? { line: f.line } : {}), ...(f.severity ? { severity: f.severity } : {}) }));
  } catch (err) {
    log.warn("Discuss apply: the lint of the result failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
