/**
 * Done on a step of a page's `<Lane kind="you">` (mimir plan
 * muninn-wiki-first-screen-claims, PR 1). The pure edit is `src/format/step-done.ts`.
 *
 *  - `GET  /api/wiki/step-done?wiki=&relPath=` lists the page's open `you` steps
 *    with their keys (a read: one page file, no spawn). For a wiki outside the
 *    triage scope it answers 200 with `offered: false` and no steps, since the
 *    reader asks on every page that has a `you` lane.
 *  - `POST /api/wiki/step-done` with `{wiki, relPath, step, baseHash, preview: true}`
 *    answers what would go and the log line; with `{…, previewHash}` it writes.
 *    `steps: [keys]` in place of `step` removes every named step in one pass:
 *    one preview, one write, one log entry, one commit (the reader's «Remove N
 *    checked»). One key the page cannot remove refuses the whole list. No
 *    probe runs again here: the preview naming every step is the confirmation.
 *
 * The write copies the decision-inbox close (`wiki-decision-inbox.ts`): JSON
 * only, readonly refusal, the triage scope, egress, base hash, the hash of what
 * the preview showed, the Gardener-held check, `writeWikiPage` inside the
 * per-wiki queue with a dirty-page `proceed`, the commit after it, the index
 * rebuilt after the commit. A step's key belongs to the page bytes it was
 * listed from, so a second Done on the same page starts from a new list: a
 * key read before the first one names no step afterwards.
 */

import path from "node:path";
import type { Context, Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { scopeVerdict, triageScope } from "../../wiki/decision-triage/scope.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { isReadonlyWikiRoot } from "../../wiki/readonly.ts";
import { defaultPageWriteIo, writeWikiPage } from "../../wiki/page-write.ts";
import { commitWikiChange, pageHasUncommittedChanges, type CommitWikiResult } from "../../wiki/commit.ts";
import { heldBy, heldMessage, staleProposalStore } from "../../gardener/stale-proposals.ts";
import { sha256, todayOslo } from "../../utils/date-hash.ts";
import { postCollectionUpdate } from "../../wiki/reindex.ts";
import { discoverAllBots } from "../../bots/config.ts";
import { requireJsonRequest } from "./json-request.ts";
import { listYouSteps, stepDoneEdit, stepDoneLogLine, stepsDoneEdit, stepsDoneLogLine, youLaneRows } from "../../format/step-done.ts";
import { realDecisionInboxDeps, type DecisionCloseGuards, type DecisionInboxDeps } from "./wiki-decision-inbox.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";

const log = getLog("dashboard", "wiki-step-done");

export const STEP_DONE_PATH = "/api/wiki/step-done";
export const STEP_DONE_LOG_KIND = "step-done";

export interface StepDoneDeps extends Pick<DecisionInboxDeps, "registry" | "workMapWikis" | "answerConfig" | "now"> {
  isReadonlyRoot: (root: string) => boolean;
  commit: (root: string, paths: string[], message: string, push: boolean) => Promise<CommitWikiResult>;
}

export function realStepDoneDeps(config: Config): StepDoneDeps {
  const inbox = realDecisionInboxDeps(config);
  return {
    registry: inbox.registry,
    workMapWikis: inbox.workMapWikis,
    answerConfig: inbox.answerConfig,
    now: inbox.now,
    isReadonlyRoot: isReadonlyWikiRoot,
    commit: (root, paths, message, push) => commitWikiChange(root, paths, message, { push }),
  };
}

/** What {@link stepWikiScope} reads: the owner-step checks route resolves through it too. */
export type StepWikiScopeDeps = Pick<StepDoneDeps, "registry" | "workMapWikis" | "answerConfig" | "isReadonlyRoot">;

/**
 * Where Done is offered: the wiki `name` names, unless its root is read-only
 * (`WIKI_READONLY_ROOTS`) or it is outside the close route's triage scope
 * (`outside` says why). The instance switch is not read here: Done's POST
 * refuses it, the checks route does not.
 */
export async function stepWikiScope(deps: StepWikiScopeDeps, name: string): Promise<{ entry: WikiRegistryEntry } | { readonlyRoot: true } | { outside: string }> {
  const registry = deps.registry();
  const entryOf = (n: string) => registry.find((e) => e.name.toLowerCase() === n.toLowerCase());
  const named = entryOf(name);
  if (named && deps.isReadonlyRoot(named.root)) return { readonlyRoot: true };
  const scope = await triageScope({ workMapWikis: deps.workMapWikis(), answerWikis: deps.answerConfig().wikis, entryOf, isReadonlyRoot: deps.isReadonlyRoot });
  const verdict = scopeVerdict(scope, name);
  return "reason" in verdict ? { outside: verdict.reason } : { entry: verdict.entry };
}

/** The wiki `name` names, if Done may write it: a 403 for a readonly root, a 404 outside the close route's scope.
 *  `outside` is set with that 404 and says why, so the list can answer it without failing. */
async function resolveWiki(c: Context, deps: StepDoneDeps, name: string): Promise<{ entry: WikiRegistryEntry } | { res: Response; outside?: string }> {
  const found = await stepWikiScope(deps, name);
  if ("readonlyRoot" in found) return { res: c.json({ error: "This wiki is read-only here.", readonly: true }, 403) };
  if ("outside" in found) return { res: c.json({ error: `no Done here: ${found.outside}` }, 404), outside: found.outside };
  return found;
}

const LOG_PROMISE = "log.md gets this entry; if appending it fails, the page edit still stands.";

/** The most keys one list request may name before the page is read; the page's own step count bounds it after. */
export const MAX_STEPS_PER_REQUEST = 200;

/** `steps` as a list of distinct non-empty keys, or why it is not one. */
function stepsList(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string" || k.trim() === "")) return "steps must be a list of step keys";
  if (raw.length === 0) return "steps must name at least one step";
  if (raw.length > MAX_STEPS_PER_REQUEST) return `steps names more than ${MAX_STEPS_PER_REQUEST} steps`;
  const keys = (raw as string[]).map((k) => k.trim());
  if (new Set(keys).size !== keys.length) return "steps names a step twice";
  return keys;
}

/** What one Done form removes from a page text: the preview's body, what its hash covers, the log line and the new text. */
type Planned =
  | { ok: true; content: string; logLine: string; body: Record<string, unknown>; shown: unknown[] }
  | { ok: false; reason: string; code: string; key?: string };

function planOne(text: string, step: string): Planned {
  const edit = stepDoneEdit(text, step);
  if (!edit.ok) return edit;
  const logLine = stepDoneLogLine(edit);
  return {
    ok: true,
    content: edit.content,
    logLine,
    body: { removed: edit.removed, renumbered: edit.renumbered, laneRemoved: edit.laneRemoved, nextMovesRemoved: edit.nextMovesRemoved },
    shown: [edit.removed, edit.renumbered, edit.laneRemoved, edit.nextMovesRemoved, logLine],
  };
}

function planMany(text: string, keys: string[]): Planned {
  const edit = stepsDoneEdit(text, keys);
  if (!edit.ok) return edit;
  const logLine = stepsDoneLogLine(edit);
  return {
    ok: true,
    content: edit.content,
    logLine,
    body: {
      steps: edit.steps,
      removed: edit.removed,
      renumbered: edit.renumbered,
      laneRemoved: edit.lanesRemoved > 0,
      nextMovesRemoved: edit.blocksRemoved > 0,
      lanesRemoved: edit.lanesRemoved,
      blocksRemoved: edit.blocksRemoved,
    },
    shown: ["steps", edit.steps, edit.removed, edit.renumbered, edit.lanesRemoved, edit.blocksRemoved, logLine],
  };
}

export function registerWikiStepDoneRoutes(app: Hono, config: Config, guards: DecisionCloseGuards, depsFor: () => StepDoneDeps = () => realStepDoneDeps(config)): void {
  app.get(STEP_DONE_PATH, async (c) => {
    const wiki = c.req.query("wiki")?.trim();
    const relPath = c.req.query("relPath")?.trim();
    if (!relPath) return c.json({ error: "relPath is required" }, 400);
    // A bare `/wiki` served from an unregistered `WIKI_DIR` has no name to send. The
    // reader asks on every page with a `you` lane, so that is an answer with no steps.
    if (!wiki) return c.json({ relPath, offered: false, reason: "the wiki has no registry name", steps: [], laneRows: [], readable: false });
    try {
      const found = await resolveWiki(c, depsFor(), wiki);
      // The reader asks on every page with a `you` lane, in any wiki: outside the
      // scope that is an ordinary answer with no steps, not a failed request.
      if ("res" in found) return found.outside === undefined ? found.res : c.json({ relPath, offered: false, reason: found.outside, steps: [], laneRows: [], readable: false });
      const index = await getWikiIndex({ root: found.entry.root });
      if (!index) return c.json({ error: "wiki directory not found" }, 503);
      const target = index.resolveRelPath(relPath);
      if (!target) return c.json({ error: `no page ${relPath}` }, 404);
      const current = await defaultPageWriteIo(found.entry.root).readFile(path.join(found.entry.root, target.relPath));
      if (current === null) return c.json({ error: `${target.relPath} cannot be read` }, 409);
      const steps = listYouSteps(current);
      return c.json({ relPath: target.relPath, baseHash: sha256(current), steps: steps ?? [], laneRows: youLaneRows(current) ?? [], readable: steps !== null });
    } catch (err) {
      log.error("Step list failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the steps could not be read" }, 500);
    }
  });

  app.post(STEP_DONE_PATH, async (c) => {
    try {
      return await markDone(c);
    } catch (err) {
      log.error("Step done failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the step could not be marked done" }, 500);
    }
  });

  async function markDone(c: Context): Promise<Response> {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const ro = guards.readonlyRefusal(c);
    if (ro) {
      log.info("Step done refused: the instance is read-only");
      return ro;
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
    const [wiki, relPath, step, baseHash, previewHash] = [str("wiki"), str("relPath"), str("step"), str("baseHash"), str("previewHash")];
    const preview = body.preview === true;
    // Exactly one form: `step` (one key) or `steps` (a list of keys, removed in one write).
    if (body.step !== undefined && body.steps !== undefined) return c.json({ error: "send step or steps, not both" }, 400);
    const keys = body.steps === undefined ? null : stepsList(body.steps);
    if (typeof keys === "string") return c.json({ error: keys }, 400);
    if (!wiki || !relPath || (!step && keys === null) || !baseHash) return c.json({ error: "wiki, relPath, step (or steps) and baseHash are required" }, 400);
    if (!preview && !previewHash) return c.json({ error: "previewHash is required: preview the step first" }, 400);
    const deps = depsFor();
    const found = await resolveWiki(c, deps, wiki);
    if ("res" in found) return found.res;
    const entry = found.entry;
    const egress = guards.egressRefusal(c, entry);
    if (egress) return egress;
    const index = await getWikiIndex({ root: entry.root });
    if (!index) return c.json({ error: "wiki directory not found" }, 503);
    const target = index.resolveRelPath(relPath);
    if (!target) return c.json({ error: `no page ${relPath}` }, 404);
    const io = defaultPageWriteIo(entry.root);
    const current = await io.readFile(path.join(entry.root, target.relPath));
    if (current === null) return c.json({ error: `${target.relPath} cannot be read` }, 409);
    if (baseHash !== sha256(current)) return c.json({ error: "The page changed since it was shown. Reload it and try again.", stale: true }, 409);
    const plan = (text: string): Planned => (keys === null ? planOne(text, step) : planMany(text, keys));
    const planned = plan(current);
    if (!planned.ok) return c.json({ error: planned.reason, refused: true, code: planned.code, ...(planned.key ? { key: planned.key } : {}) }, 409);
    const title = target.title ?? target.relPath;
    const logLine = planned.logLine;
    const logEntry = `## [${todayOslo(deps.now())}] ${STEP_DONE_LOG_KIND} | ${title}\n- ${logLine}`;
    const shown = sha256(JSON.stringify(planned.shown));
    if (preview) {
      return c.json({
        ok: true,
        preview: true,
        ...planned.body,
        logEntry,
        logNote: LOG_PROMISE,
        baseHash,
        previewHash: shown,
      });
    }
    if (previewHash !== shown) return c.json({ error: "What Done removes changed since the preview. Preview again.", changed: true }, 409);
    try {
      const held = heldBy(await staleProposalStore().liveHolders(entry.name), target.relPath);
      if (held) return c.json({ error: heldMessage(held), held: true }, 409);
    } catch (err) {
      log.warn("Step done: Gardener cards unavailable: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "The Gardener's cards could not be read, so the page's claim is unknown." }, 503);
    }
    const owningBot = entry.source === "bot" ? discoverAllBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase()) : undefined;
    const push = owningBot?.wikiAutoCommit?.push ?? true;
    let refusal: string | null = null;
    let dirty: string | null = null;
    let written: string | null = null;
    let line = logLine;
    const result = await writeWikiPage({
      wikiDir: entry.root,
      relPath: target.relPath,
      baseHash,
      staleReason: "The page changed while the step was marked done. Reload it and try again.",
      collections: entry.collections ?? [],
      logKind: STEP_DONE_LOG_KIND,
      logTitle: title,
      logLine: () => line,
      // A one-key list logs the single form's line, so it takes the single form's subject too.
      commitMessage: () => (keys === null || keys.length === 1 ? `[step-done] ${line.replace(/^Step done: /, "")}: ${target.relPath}` : `[step-done] ${keys.length} steps: ${target.relPath}`),
      now: deps.now,
      proceed: async () => {
        const has = await pageHasUncommittedChanges(entry.root, target.relPath);
        if (has === false) return true;
        // Git cannot tell a session's edits from an earlier Done whose commit failed, so the text names both.
        dirty =
          has === null
            ? `${target.relPath}: git status failed, so its uncommitted edits are unknown`
            : `${target.relPath} has changes that are not committed yet: a session is editing it, or an earlier Done could not be committed. Commit or discard them, then try again.`;
        return false;
      },
      transform: (raw) => {
        const again = plan(raw);
        if (!again.ok) {
          refusal = again.reason;
          return null;
        }
        line = again.logLine;
        written = again.content;
        return again.content;
      },
      ...io,
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
    // Rebuilt after the commit tail, as the close does: the write's own refresh read an uncommitted page.
    await getWikiIndex({ root: entry.root, refresh: true }).catch(() => null);
    return c.json({
      ok: true,
      page: target.relPath,
      committed,
      // `uncommitted`: the commit failed, so the page now carries edits no commit holds, and the next Done would be refused.
      ...(committed ? {} : { commitReason, uncommitted: commitReason === "error" || commitReason === "not-default-branch" }),
    });
  }
}
