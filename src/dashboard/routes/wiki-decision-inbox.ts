/**
 * `GET /api/wiki/decision-inbox?wiki=` (P3a of mimir plans/muninn-wiki-decision-triage.mdx):
 * a covered wiki's open cards, each with its live answers, the P1 hint, its
 * targets, when it was added and its lane (`inboxLane`), oldest first. Read-only:
 * the page files, `wiki_answers` and one `git log` per card on the wiki's own
 * repo (`gatherCardFacts`' added commit). No code-repo reads, no model call.
 * Admin-only by the zone model's default; in the tool group, so nais drops it.
 */

import type { Hono } from "hono";
import { resolveWikiAnswerConfig, type Config, type WikiAnswerConfig } from "../../config.ts";
import { listWikiAnswerHistory, type WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { foldName, parseQuestionTarget } from "../../format/question.ts";
import { getLog } from "../../logging.ts";
import { collectOpenCards } from "../../wiki/decision-triage/cards.ts";
import { gatherCardFacts, liveView, type AnswerFact } from "../../wiki/decision-triage/facts.ts";
import { realGit, type GitRun } from "../../wiki/decision-triage/git.ts";
import { inboxLane, sortByAge, type InboxLane } from "../../wiki/decision-triage/inbox.ts";
import { scopeVerdict, triageScope } from "../../wiki/decision-triage/scope.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { getWikiIndex } from "../../wiki/store.ts";

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
  /** The owner has a live answer (not sure, in a lane that is not «close?»): an inbox answer would 409. */
  ownerAnswered: boolean;
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

export async function readDecisionInbox(entry: WikiRegistryEntry, deps: DecisionInboxDeps): Promise<DecisionInboxBody> {
  const answerConfig = deps.answerConfig();
  const index = await getWikiIndex({ root: entry.root });
  if (!index) throw new Error("the wiki could not be indexed");
  const view = liveView(index, readFile);
  const open = await collectOpenCards(index, (m) => view.readPage(m.relPath).catch(() => null));
  // As the night refuses (run.ts): an inbox read from no readable page is no inbox.
  if (open.inScope > 0 && open.readable === 0) throw new Error(`none of ${open.inScope} pages could be read`);
  const answers = await deps.answers(entry.name);
  const ownerName = answerConfig.owner ? parseQuestionTarget(answerConfig.owner)?.name : undefined;
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
      ownerAnswered: ownerName !== undefined && card.answers.some((a) => foldName(a.author) === foldName(ownerName)),
      lane: inboxLane({ wiki: entry.name, answers: card.answers, hinted: hint !== null, ownerAsked: card.ownerAsked }),
    });
  }
  return { wiki: entry.name, cards: sortByAge(cards, deps.now()) };
}

export function registerWikiDecisionInboxRoute(app: Hono, config: Config, depsFor: () => DecisionInboxDeps = () => realDecisionInboxDeps(config)): void {
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
      return c.json(await readDecisionInbox(verdict.entry, deps));
    } catch (err) {
      log.error("The decision inbox for {wiki} failed: {error}", { wiki, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the decision inbox could not be read" }, 500);
    }
  });
}
