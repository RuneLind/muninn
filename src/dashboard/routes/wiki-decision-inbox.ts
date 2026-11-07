/**
 * `GET /api/wiki/decision-inbox?wiki=` (P3a of mimir plans/muninn-wiki-decision-triage.mdx):
 * a covered wiki's open cards, each with its live answers, the P1 hint, its
 * targets, when it was added and its lane (`inboxLane`), oldest first. Read-only:
 * the page files, `wiki_answers` and one `git log` per card on the wiki's own
 * repo (`gatherCardFacts`' added commit). No code-repo reads, no model call.
 * Admin-only by the zone model's default; in the tool group, so nais drops it.
 */

import path from "node:path";
import type { Context, Hono } from "hono";
import { resolveWikiAnswerConfig, type Config, type WikiAnswerConfig } from "../../config.ts";
import { authorKeyOf, listWikiAnswerHistory, type WikiAnswerAuthor, type WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { answerAuthorFor } from "./wiki-answers.ts";
import { getLog } from "../../logging.ts";
import { collectOpenCards } from "../../wiki/decision-triage/cards.ts";
import { gatherCardFacts, liveView, type AnswerFact } from "../../wiki/decision-triage/facts.ts";
import { realGit, type GitRun } from "../../wiki/decision-triage/git.ts";
import { inboxLane, sortByAge, type InboxLane } from "../../wiki/decision-triage/inbox.ts";
import { scopeVerdict, triageScope } from "../../wiki/decision-triage/scope.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { getWikiIndex, stripFrontmatter } from "../../wiki/store.ts";
import { parseBlocks } from "../../format/markdown-ast.ts";
import { parseQuestionPage, QUESTION_NOT_SURE } from "../../format/question.ts";
import { unclosedCards } from "../../format/question-unclosed.ts";
import { closeCardEdit, type CloseRuling } from "../../format/question-close.ts";
import { defaultPageWriteIo, writeWikiPage } from "../../wiki/page-write.ts";
import { commitWikiChange, pageHasUncommittedChanges } from "../../wiki/commit.ts";
import { heldBy, heldMessage, staleProposalStore } from "../../gardener/stale-proposals.ts";
import { sha256, todayOslo } from "../../gardener/util.ts";
import { postCollectionUpdate } from "../../wiki/reindex.ts";
import { discoverAllBots } from "../../bots/config.ts";
import { requireJsonRequest } from "./json-request.ts";

const log = getLog("dashboard", "wiki-decision-inbox");

export const DECISION_INBOX_PATH = "/api/wiki/decision-inbox";

export interface InboxCard {
  relPath: string;
  id: string;
  title: string;
  body: string;
  choices: string[];
  recommendation: string | null;
  targets: string[];
  /** The commit that added the card, ISO; null when none holds it or the lookup failed. */
  added: string | null;
  laneSince: string | null;
  answers: AnswerFact[];
  hint: { decision: string | null; decisionText: string | null; namedBy: string | null; word: string | null; ownItem: string | null } | null;
  /** The viewer has a live answer, by the key `POST /api/wiki/answers` holds one
   *  live answer to (`authorKeyOf`), so an inbox answer would 409. */
  viewerAnswered: boolean;
  lane: InboxLane;
}

export interface DecisionInboxBody {
  wiki: string;
  cards: InboxCard[];
}

export interface DecisionInboxDeps {
  registry: () => readonly WikiRegistryEntry[];
  workMapWikis: () => readonly string[];
  answerConfig: () => Pick<WikiAnswerConfig, "wikis" | "owner" | "groups">;
  answers: (wiki: string) => Promise<WikiAnswerVersion[]>;
  git: GitRun;
  now: () => number;
}

export function realDecisionInboxDeps(config: Config): DecisionInboxDeps {
  return {
    registry: getWikiRegistry,
    workMapWikis: () => config.workMapWikis ?? [],
    answerConfig: () => config.wikiAnswers ?? resolveWikiAnswerConfig(),
    answers: listWikiAnswerHistory,
    git: realGit,
    now: Date.now,
  };
}

const readFile = async (abs: string) => {
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
};

export async function readDecisionInbox(entry: WikiRegistryEntry, deps: DecisionInboxDeps, viewer: WikiAnswerAuthor | null = null): Promise<DecisionInboxBody> {
  const answerConfig = deps.answerConfig();
  const index = await getWikiIndex({ root: entry.root });
  if (!index) throw new Error("the wiki could not be indexed");
  const view = liveView(index, readFile);
  const open = await collectOpenCards(index, (m) => view.readPage(m.relPath).catch(() => null));
  // As the night refuses (run.ts): an inbox read from no readable page is no inbox.
  if (open.inScope > 0 && open.readable === 0) throw new Error(`none of ${open.inScope} pages could be read`);
  const answers = await deps.answers(entry.name);
  const viewerKey = viewer ? authorKeyOf(viewer) : null;
  const redacted = new Set(answers.filter((v) => v.redactedAt !== null).map((v) => v.answerId));
  const viewerHas = (relPath: string, id: string) =>
    viewerKey !== null && answers.some((v) => v.relPath === relPath && v.questionId === id && !redacted.has(v.answerId) && authorKeyOf(v.author) === viewerKey);
  const ctx = {
    git: deps.git,
    // `repos: []` below: nothing asks for a code repo.
    repo: () => Promise.reject(new Error("the inbox reads no code repo")),
    answers,
    owner: answerConfig.owner,
    groups: answerConfig.groups,
  };
  const cards: InboxCard[] = [];
  for (const ref of open.cards) {
    const read = open.pages.find((p) => p.relPath === ref.relPath)!;
    const { card } = await gatherCardFacts({ wiki: entry.name, ...ref, answeredAt: null, commit: null }, { ...read, repos: [] }, view, ctx);
    const itemText = (id: string | null) => (id ? (read.page.entries.find((e) => e.id === id)?.itemText ?? null) : null);
    const hint = read.hints.find((h) => h.id === ref.id) ?? null;
    cards.push({
      relPath: ref.relPath,
      id: ref.id,
      title: index.resolveRelPath(ref.relPath)?.title ?? ref.relPath,
      body: card.body,
      choices: card.choices,
      recommendation: card.recommendation,
      targets: card.targets,
      added: typeof card.addedCommit === "object" ? card.addedCommit.date : null,
      laneSince: card.waitingLanes.find((l) => l.since)?.since ?? null,
      answers: card.answers,
      hint: hint ? { decision: hint.decision, decisionText: itemText(hint.decision), namedBy: hint.namedBy, word: hint.word, ownItem: itemText(ref.id) } : null,
      viewerAnswered: viewerHas(ref.relPath, ref.id),
      lane: inboxLane({ wiki: entry.name, answers: card.answers, hinted: hint !== null, ownerAsked: card.ownerAsked }),
    });
  }
  return { wiki: entry.name, cards: sortByAge(cards, deps.now()) };
}

export const DECISION_CLOSE_PATH = "/api/wiki/decision-inbox/close";

/** The refusals `staleRequest` runs, from `wiki-routes.ts`, so the close refuses as Apply does. */
export interface DecisionCloseGuards {
  readonlyRefusal: (c: Context) => Response | null;
  egressRefusal: (c: Context, entry: WikiRegistryEntry) => Response | null;
}

/** `DD.MM.YYYY` in Europe/Oslo, as a decision's date tail writes it. */
const logDate = (ms: number) => todayOslo(ms).split("-").reverse().join(".");

/**
 * What a close records when the page holds no ruling: the newest live answer
 * that is not not sure, full body (the inbox's facts cut it), or null.
 */
export function closingAnswer(versions: readonly WikiAnswerVersion[], relPath: string, id: string): WikiAnswerVersion | null {
  const mine = versions.filter((v) => v.relPath === relPath && v.questionId === id);
  const redacted = new Set(mine.filter((v) => v.redactedAt !== null).map((v) => v.answerId));
  const latest = new Map<string, WikiAnswerVersion>();
  for (const v of mine) {
    if (redacted.has(v.answerId)) continue;
    const key = authorKeyOf(v.author);
    const held = latest.get(key);
    if (!held || v.createdAt > held.createdAt) latest.set(key, v);
  }
  return [...latest.values()].filter((v) => v.choice !== QUESTION_NOT_SURE).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** The ruling the close writes: the P1 hint's decision first, else the closing answer,
 *  with what the preview should say about it: an answer to an older wording, and
 *  every other author's live answer that differs. Null when nothing rules. */
export function closeRulingFor(raw: string, id: string, versions: readonly WikiAnswerVersion[], relPath: string): { ruling: CloseRuling; warnings: string[] } | null {
  const page = parseQuestionPage(parseBlocks(stripFrontmatter(raw)));
  const hint = unclosedCards(page).find((h) => h.id === id);
  if (hint?.decision) return { ruling: { kind: "decision", decision: hint.decision }, warnings: [] };
  const a = closingAnswer(versions, relPath, id);
  if (!a) return null;
  const warnings: string[] = [];
  const q = page.questions.find((x) => x.id === id);
  if (q && a.questionHash !== sha256(q.hashInput)) warnings.push(`${a.author.name} answered an older wording of the card.`);
  const others = new Map<string, WikiAnswerVersion>();
  const redacted = new Set(versions.filter((v) => v.redactedAt !== null).map((v) => v.answerId));
  for (const v of versions) {
    if (v.relPath !== relPath || v.questionId !== id || redacted.has(v.answerId) || authorKeyOf(v.author) === authorKeyOf(a.author)) continue;
    const held = others.get(authorKeyOf(v.author));
    if (!held || v.createdAt > held.createdAt) others.set(authorKeyOf(v.author), v);
  }
  for (const o of others.values()) {
    if (o.choice === a.choice && (o.choice !== null || o.body.trim() === a.body.trim())) continue;
    warnings.push(o.choice === QUESTION_NOT_SURE ? `${o.author.name} is not sure.` : o.choice !== null ? `${o.author.name} answered ${o.choice}.` : `${o.author.name} answered in text.`);
  }
  return { ruling: { kind: "answer", choice: a.choice, body: a.body, author: a.author.name, date: logDate(a.createdAt) }, warnings };
}

function registerDecisionCloseRoute(app: Hono, config: Config, depsFor: () => DecisionInboxDeps, guards: DecisionCloseGuards): void {
  // `{wiki, relPath, questionId, preview: true}` answers the lines a close would
  // add and the page's hash; `{…, baseHash}` writes them, through the per-wiki
  // queue with a CAS on that hash (Apply's sequence: `POST /api/wiki/stale/apply`).
  app.post(DECISION_CLOSE_PATH, async (c) => {
    try {
      return await closeCard(c);
    } catch (err) {
      log.error("Decision close failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the card could not be closed" }, 500);
    }
  });

  async function closeCard(c: Context): Promise<Response> {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const ro = guards.readonlyRefusal(c);
    if (ro) return ro;
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
    const [wiki, relPath, id, baseHash, rulingHash] = [str("wiki"), str("relPath"), str("questionId"), str("baseHash"), str("rulingHash")];
    const preview = body.preview === true;
    if (!wiki || !relPath || !id) return c.json({ error: "wiki, relPath and questionId are required" }, 400);
    if (!preview && (!baseHash || !rulingHash)) return c.json({ error: "baseHash and rulingHash are required: preview the close first" }, 400);
    const deps = depsFor();
    const registry = deps.registry();
    const scope = await triageScope({
      workMapWikis: deps.workMapWikis(),
      answerWikis: deps.answerConfig().wikis,
      entryOf: (name) => registry.find((e) => e.name.toLowerCase() === name.toLowerCase()),
    });
    const verdict = scopeVerdict(scope, wiki);
    if ("reason" in verdict) return c.json({ error: `no decision inbox here: ${verdict.reason}` }, 404);
    const entry = verdict.entry;
    const egress = guards.egressRefusal(c, entry);
    if (egress) return egress;
    const index = await getWikiIndex({ root: entry.root });
    if (!index) return c.json({ error: "wiki directory not found" }, 503);
    const target = index.resolveRelPath(relPath);
    if (!target) return c.json({ error: `no page ${relPath}` }, 404);
    const io = defaultPageWriteIo(entry.root);
    const current = await io.readFile(path.join(entry.root, target.relPath));
    if (current === null) return c.json({ error: `${target.relPath} cannot be read` }, 409);
    let found: { ruling: CloseRuling; warnings: string[] } | null;
    try {
      found = closeRulingFor(current, id, await deps.answers(entry.name), target.relPath);
    } catch (err) {
      log.warn("Decision close: answers unavailable: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the answers could not be read" }, 503);
    }
    if (!found) return c.json({ error: `nothing on the page or in the answers rules on ${id}: open it on the page`, refused: true }, 409);
    const { ruling, warnings } = found;
    const today = todayOslo(deps.now());
    const edit = closeCardEdit(current, id, ruling, today);
    if (!edit.ok) return c.json({ error: edit.reason, refused: true, code: edit.code }, 409);
    // The page hash guards the page; the ruling hash guards the answers the lines came from.
    const shown = sha256(JSON.stringify(edit.lines));
    if (preview) return c.json({ ok: true, preview: true, decision: edit.decision, lines: edit.lines, warnings, baseHash: sha256(current), rulingHash: shown });
    if (baseHash !== sha256(current)) return c.json({ error: "The page changed since the preview. Preview again.", stale: true }, 409);
    if (rulingHash !== shown) return c.json({ error: "The answers changed since the preview. Preview again.", changed: true }, 409);
    try {
      const held = heldBy(await staleProposalStore().liveHolders(entry.name), target.relPath);
      if (held) return c.json({ error: heldMessage(held), held: true }, 409);
    } catch (err) {
      log.warn("Decision close: Gardener cards unavailable: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "The Gardener's cards could not be read, so the page's claim is unknown." }, 503);
    }
    const owningBot = entry.source === "bot" ? discoverAllBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase()) : undefined;
    const push = owningBot?.wikiAutoCommit?.push ?? true;
    let refusal: string | null = null;
    let dirty: string | null = null;
    let decision = edit.decision;
    const result = await writeWikiPage({
      wikiDir: entry.root,
      relPath: target.relPath,
      baseHash,
      staleReason: "The page changed while the card was closed. Preview again.",
      collections: entry.collections ?? [],
      logKind: "decision-inbox",
      logTitle: target.title ?? target.relPath,
      logLine: () => `${id} closed (${decision}) from the decision inbox`,
      commitMessage: () => `[decision-inbox] close ${id} (${decision}): ${target.relPath}`,
      now: deps.now,
      proceed: async () => {
        const has = await pageHasUncommittedChanges(entry.root, target.relPath);
        if (has === false) return true;
        dirty = has === null ? `${target.relPath}: git status failed, so its uncommitted edits are unknown` : `${target.relPath} has uncommitted edits — commit them first`;
        return false;
      },
      transform: (raw) => {
        const again = closeCardEdit(raw, id, ruling, today);
        if (!again.ok) {
          refusal = again.reason;
          return null;
        }
        decision = again.decision;
        return again.content;
      },
      ...io,
      reindex: async (collection) => {
        await postCollectionUpdate(config.knowledgeApiUrl, collection);
      },
      commit: (paths, message) => commitWikiChange(entry.root, paths, message, { push }),
    });
    if (result.outcome === "forbidden") return c.json({ error: result.reason, readonly: true }, 403);
    if (result.outcome === "stale") return c.json({ error: result.reason, stale: true }, 409);
    if (result.outcome === "locked") return c.json({ error: result.reason, locked: true }, 409);
    if (dirty) return c.json({ error: dirty, dirty: true }, 409);
    if (refusal) return c.json({ error: refusal, refused: true }, 409);
    if (result.outcome !== "written") return c.json({ error: result.outcome === "error" ? result.reason : "nothing was written" }, 500);
    // Rebuilt after the commit tail, as Apply does: the write's own refresh read an uncommitted page.
    await getWikiIndex({ root: entry.root, refresh: true }).catch(() => null);
    return c.json({ ok: true, page: target.relPath, decision, committed: result.commit?.committed ?? false });
  }
}

export function registerWikiDecisionInboxRoute(
  app: Hono,
  config: Config,
  depsFor: () => DecisionInboxDeps = () => realDecisionInboxDeps(config),
  guards?: DecisionCloseGuards,
): void {
  if (guards) registerDecisionCloseRoute(app, config, depsFor, guards);
  app.get(DECISION_INBOX_PATH, async (c) => {
    const wiki = c.req.query("wiki")?.trim();
    if (!wiki) return c.json({ error: "wiki is required" }, 400);
    const deps = depsFor();
    try {
      const registry = deps.registry();
      const scope = await triageScope({
        workMapWikis: deps.workMapWikis(),
        answerWikis: deps.answerConfig().wikis,
        entryOf: (name) => registry.find((e) => e.name.toLowerCase() === name.toLowerCase()),
      });
      const verdict = scopeVerdict(scope, wiki);
      if ("reason" in verdict) return c.json({ error: `no decision inbox here: ${verdict.reason}` }, 404);
      return c.json(await readDecisionInbox(verdict.entry, deps, answerAuthorFor(c, deps.answerConfig().owner)));
    } catch (err) {
      log.error("The decision inbox for {wiki} failed: {error}", { wiki, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the decision inbox could not be read" }, 500);
    }
  });
}
