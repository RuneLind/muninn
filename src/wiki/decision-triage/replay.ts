/**
 * Replay: each card read as of its own answer, through the same facts, prompt and
 * model as a night. The page comes from the commit before the answer, facts are
 * cut at that time through tree reads, and that answer is left out. Verdicts go to
 * `replay-<promptVersion>.jsonl`, never the nightly log.
 *
 * This module is handed cards with no labels on them: `baseline.ts` picks the
 * fields, and only the scorer reads a label.
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { commitView, gatherCardFacts, gatherPageFacts, readPageText, type GatherContext, type PageFacts, type PageRead, type ReplayCard, type WikiView } from "./facts.ts";
import { parseRepoRoots, type GitRun } from "./git.ts";
import { buildBatches, CHARS_PER_CALL, momentOf, soloChars, type Batch, type BatchItem } from "./prompt.ts";
import { callBatch, noVerdictReason, overRss, repoResolver, verdictFields, withTimeout, type TriageModel } from "./run.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, type CardLine, type LogLine, type RepoFact, type RunLine, type TriageUsage } from "./schema.ts";

const CARD_GATHER_TIMEOUT_MS = 90_000;
/** A card left with no verdict gets this many more tries. */
export const REPLAY_RETRIES = 2;

/** A setup fault: it must never read as a worse result. */
export class ReplayRefused extends Error {}

export interface ReplayDeps {
  /** The wiki's root per name. */
  roots: ReadonlyMap<string, string>;
  repoRoots: string | null;
  git: GitRun;
  answers: (wiki: string) => Promise<WikiAnswerVersion[]>;
  owner: string | null;
  groups: GatherContext["groups"];
  now: () => number;
}

export interface GatheredReplay {
  items: BatchItem[];
  /** Cards whose facts could not be gathered. Reasons carry no label. */
  refused: { card: ReplayCard; reason: string }[];
  oversized: BatchItem[];
  repos: RepoFact[];
}

export const replayKey = (c: { relPath: string; id: string; answeredAt?: string | null }) => `${c.relPath}\0${c.id}\0${c.answeredAt ?? ""}`;

/** Gather facts for every card, refusing the whole replay on a setup fault. */
export async function gatherReplay(cards: readonly ReplayCard[], deps: ReplayDeps): Promise<GatheredReplay> {
  if (!deps.repoRoots) throw new ReplayRefused("DECISION_TRIAGE_REPO_ROOTS is not set");
  const wikis = [...new Set(cards.map((c) => c.wiki))];
  for (const wiki of wikis) {
    const root = deps.roots.get(wiki);
    if (!root) throw new ReplayRefused(`no root for ${wiki}: run from a checkout that registers it, or pass --root ${wiki}=<path>`);
    if (!(await stat(root).then((s) => s.isDirectory()).catch(() => false))) throw new ReplayRefused(`${wiki}'s root ${root} is missing`);
    if (!(await deps.git(root, ["rev-parse", "--git-dir"])).ok) throw new ReplayRefused(`${wiki}'s root ${root} is not a git repo`);
  }
  const resolver = repoResolver(parseRepoRoots(deps.repoRoots), deps.git, { fetch: true });
  const answers = new Map<string, WikiAnswerVersion[]>();
  for (const wiki of wikis) answers.set(wiki, await deps.answers(wiki));

  const views = new Map<string, WikiView>();
  const pageReads = new Map<string, PageRead | null>();
  const pageFacts = new Map<string, PageFacts>();
  const out: GatheredReplay = { items: [], refused: [], oversized: [], repos: [] };
  const namesByWiki = new Map<string, Set<string>>();
  for (const card of cards) {
    const root = deps.roots.get(card.wiki)!;
    const cutMs = Date.parse(card.answeredAt);
    if (!Number.isFinite(cutMs)) {
      out.refused.push({ card, reason: "the answer time does not parse" });
      continue;
    }
    if (overRss()) {
      out.refused.push({ card, reason: "the memory guard stopped the gather" });
      continue;
    }
    try {
      const viewKey = `${card.wiki}\0${card.commit}\0${card.answeredAt}`;
      let view = views.get(viewKey);
      if (!view) {
        view = commitView(root, card.commit, cutMs, deps.git);
        views.set(viewKey, view);
      }
      const pageKey = `${card.wiki}\0${card.commit}\0${card.relPath}`;
      if (!pageReads.has(pageKey)) {
        const text = await view.readPage(card.relPath);
        pageReads.set(pageKey, text === null ? null : readPageText(card.relPath, text));
      }
      const read = pageReads.get(pageKey)!;
      if (!read) {
        out.refused.push({ card, reason: "the page is not in that commit" });
        continue;
      }
      if (!read.page.questions.some((q) => q.id === card.id)) {
        out.refused.push({ card, reason: "the card is not on the page at that commit" });
        continue;
      }
      const names = namesByWiki.get(card.wiki) ?? new Set<string>();
      namesByWiki.set(card.wiki, names);
      for (const r of read.repos) names.add(r);
      const ctx: GatherContext = { git: deps.git, repo: resolver.repo, answers: answers.get(card.wiki)!, owner: deps.owner, groups: deps.groups };
      const gathered = await withTimeout(gatherCardFacts(card, read, view, ctx), CARD_GATHER_TIMEOUT_MS, "the facts");
      let page = pageFacts.get(pageKey);
      if (!page) {
        page = await gatherPageFacts(read, view);
        pageFacts.set(pageKey, page);
      }
      out.items.push({ gathered, page });
    } catch (err) {
      out.refused.push({ card, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  out.repos = await resolver.facts();
  const byName = new Map(out.repos.map((r) => [r.repo, r]));
  for (const [wiki, names] of namesByWiki) {
    if (names.size > 0 && ![...names].some((n) => byName.get(n)?.found)) {
      throw new ReplayRefused(`none of ${wiki}'s repos resolve under DECISION_TRIAGE_REPO_ROOTS (${[...names].join(", ")})`);
    }
  }
  const kept: BatchItem[] = [];
  for (const item of out.items) {
    if (soloChars(item.gathered.ref.wiki, item) > CHARS_PER_CALL) out.oversized.push(item);
    else kept.push(item);
  }
  out.items = kept;
  return out;
}

/** The real calls over these items, wiki by wiki. */
export function replayBatches(items: readonly BatchItem[]): { wiki: string; batch: Batch }[] {
  const wikis = [...new Set(items.map((i) => i.gathered.ref.wiki))];
  return wikis.flatMap((wiki) => buildBatches(wiki, items.filter((i) => i.gathered.ref.wiki === wiki)).batches.map((batch) => ({ wiki, batch })));
}

/** Read from the rendered message: whether each card's page slot is the page that
 *  card's facts were gathered with, and whether the call mixes moments. */
export function messageMoments(batch: Batch): { pageSlots: number; cardsOnAnotherMoment: number; twoMoments: boolean } {
  const { pages, cards } = JSON.parse(batch.prompt.slice(batch.prompt.indexOf("\n\n") + 2)) as { pages: ({ page: string } & PageFacts)[]; cards: { page: string }[] };
  const slots = new Map(pages.map(({ page, ...facts }) => [page, JSON.stringify(facts)]));
  const cardsOnAnotherMoment = batch.items.filter((item, i) => slots.get(cards[i]!.page) !== JSON.stringify(item.page)).length;
  return { pageSlots: pages.length, cardsOnAnotherMoment, twoMoments: new Set(batch.items.map((i) => momentOf(i.gathered.ref))).size > 1 };
}

/** What `--dry-run` reports: counts only. */
export interface ReplayCounts {
  gathered: number;
  refused: number;
  oversized: number;
  reasons: Record<string, number>;
  medianChars: number;
  maxChars: number;
  codeFactCards: number;
  /** The calls a real run makes, what they carry, and what they must never hold. */
  batches: number;
  pageSlots: number;
  totalChars: number;
  cardsOnAnotherMoment: number;
  batchesWithTwoMoments: number;
  repos: { found: string[]; notFound: { repo: string; reason?: string }[]; fetchFailed: string[] };
}

export function replayCounts(g: GatheredReplay): ReplayCounts {
  const all = [...g.items, ...g.oversized];
  const sizes = all.map((i) => soloChars(i.gathered.ref.wiki, i)).sort((a, b) => a - b);
  const reasons: Record<string, number> = {};
  for (const r of g.refused) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  const batches = replayBatches(g.items).map(({ batch }) => ({ chars: batch.prompt.length, ...messageMoments(batch) }));
  return {
    gathered: all.length,
    refused: g.refused.length,
    oversized: g.oversized.length,
    reasons,
    medianChars: sizes[Math.floor(sizes.length / 2)] ?? 0,
    maxChars: sizes[sizes.length - 1] ?? 0,
    codeFactCards: all.filter((i) => i.gathered.codeFacts).length,
    batches: batches.length,
    pageSlots: batches.reduce((n, b) => n + b.pageSlots, 0),
    totalChars: batches.reduce((n, b) => n + b.chars, 0),
    cardsOnAnotherMoment: batches.reduce((n, b) => n + b.cardsOnAnotherMoment, 0),
    batchesWithTwoMoments: batches.filter((b) => b.twoMoments).length,
    repos: {
      found: g.repos.filter((r) => r.found).map((r) => r.repo),
      notFound: g.repos.filter((r) => !r.found).map((r) => ({ repo: r.repo, ...(r.reason ? { reason: r.reason } : {}) })),
      fetchFailed: g.repos.filter((r) => typeof r.fetch === "object").map((r) => r.repo),
    },
  };
}

export interface ReplayRunDeps {
  call: TriageModel;
  model: string;
  effort?: Parameters<typeof callBatch>[2]["effort"];
  /** The replay log so far, so a re-run keeps verdicts it has. */
  existing: readonly CardLine[];
  append: (lines: readonly LogLine[]) => Promise<void>;
  now: () => number;
  repoRoots: string | null;
}

/** Call the model over gathered cards, with `REPLAY_RETRIES` more tries for any
 *  card left with no verdict. Returns the card lines by {@link replayKey}. */
export async function runReplay(gathered: GatheredReplay, deps: ReplayRunDeps): Promise<{ lines: Map<string, CardLine>; usage: TriageUsage; run: RunLine }> {
  const runId = randomUUID();
  const at = deps.now();
  const usage: TriageUsage = { calls: 0 };
  const lines = new Map<string, CardLine>();
  const keyOf = (item: BatchItem) => replayKey(item.gathered.ref);
  for (const c of deps.existing) {
    if (c.verdict !== "NO_VERDICT") lines.set(replayKey(c), c);
  }
  const lineOf = (item: BatchItem, rest: Pick<CardLine, "verdict"> & Partial<CardLine>): CardLine => ({
    type: "card",
    runId,
    at,
    wiki: item.gathered.ref.wiki,
    relPath: item.gathered.ref.relPath,
    id: item.gathered.ref.id,
    questionHash: item.gathered.questionHash,
    recommendation: item.gathered.recommendation,
    answeredAt: item.gathered.ref.answeredAt!,
    codeFacts: item.gathered.codeFacts,
    ...rest,
  });
  for (let round = 0; round <= REPLAY_RETRIES; round++) {
    const left = gathered.items.filter((i) => !lines.has(keyOf(i)));
    if (left.length === 0) break;
    for (const { wiki, batch } of replayBatches(left)) {
      const result = await callBatch(wiki, batch, deps, usage);
      const landed: CardLine[] = [];
      batch.items.forEach((item, i) => {
        const v = result.verdicts[i];
        if (v) {
          const line = lineOf(item, verdictFields(v));
          lines.set(keyOf(item), line);
          landed.push(line);
        } else if (round === REPLAY_RETRIES) {
          landed.push(lineOf(item, { verdict: "NO_VERDICT", reason: noVerdictReason(result, i) }));
        }
      });
      await deps.append(landed);
    }
  }
  const oversized = gathered.oversized.map((item) => lineOf(item, { verdict: "NO_VERDICT", reason: "over the call's size limit" }));
  await deps.append(oversized);
  const run: RunLine = {
    type: "run",
    runId,
    at,
    wiki: [...new Set(gathered.items.map((i) => i.gathered.ref.wiki))].join(","),
    model: deps.model,
    promptVersion: DECISION_TRIAGE_PROMPT_VERSION,
    usage,
    repoRoots: deps.repoRoots,
    repos: gathered.repos,
    cards: gathered.items.length + gathered.oversized.length + gathered.refused.length,
    floor: null,
    outcome: "ok",
  };
  await deps.append([run]);
  return { lines, usage, run };
}
