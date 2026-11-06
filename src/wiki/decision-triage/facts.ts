/**
 * What the model reads about a card, gathered by scripts so the model needs no
 * tools (D1). One gatherer serves both tonight and a past moment: a `WikiView`
 * says what a page, `log.md` and the pages linking it looked like, either in
 * today's index and working tree or in one commit's tree.
 *
 * A replay's input is a {@link CardRef} with no label on it, and nothing here
 * reads an answer given at or after the moment the card is read as of.
 */

import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { parseBlocks, type Block } from "../../format/markdown-ast.ts";
import { pageLedgers } from "../../format/pr-ledger.ts";
import { unclosedCards, type UnclosedCard } from "../../format/question-unclosed.ts";
import {
  formatQuestionTarget,
  isAskedAuthor,
  namedQuestionIds,
  parseQuestionPage,
  parseQuestionsTo,
  parseRecommendation,
  QUESTION_NOT_SURE,
  resolveQuestionTargets,
  type ParsedQuestion,
  type QuestionPage,
} from "../../format/question.ts";
import { sha256 } from "../../gardener/util.ts";
import { extractNextMoves, waitOwnerFrom, type PageNextMoves, type WaitOwner } from "../next-moves.ts";
import { splitFrontmatter, WIKILINK_WITH_LABEL_RE } from "../page-text.ts";
import { normalizeRelPath } from "../rel-path.ts";
import { extractMarkdownLinks, extractWikilinks, parseFrontmatter, readPlanStatus, resolveMarkdownTargets, wikiPageStem, type WikiIndex } from "../store.ts";
import { cardTokens, cutLine, failureOf, type GitResult, type GitRun, type ResolvedRepo } from "./git.ts";
import type { SearchFailure } from "./schema.ts";

export const CODE_LINES_PER_CARD = 40;
export const SUBJECTS_PER_REPO = 30;
const LINKERS_MAX = 20;
/** Files to read for a stem at a commit: a mention costs a read and links nothing. */
const LINKER_CANDIDATES_MAX = 300;
const LOG_ENTRIES_MAX = 8;
const ANSWER_BODY_CHARS = 2000;
/** How close to the moment an answer counts as the answer being replayed: a
 *  question's label reads what its author settled on within ten minutes. */
const LEFT_OUT_WINDOW_MS = 10 * 60_000;
/** A rendered sha's length: git's `%h` follows the packed object count, so a `gc`
 *  would change it and with it the message and its digest. */
const SHA_CHARS = 10;

/** The card a fact gatherer may know of: the replay file's fields it needs, and
 *  no label. `commit` and `answeredAt` are null for tonight's read. */
export interface CardRef {
  wiki: string;
  relPath: string;
  id: string;
  answeredAt: string | null;
  commit: string | null;
}

/** The one shape a replay's cards reach facts and prompt in. */
export interface ReplayCard extends CardRef {
  answeredAt: string;
  commit: string;
  hashMatches: boolean;
  replayable: true;
}

/** A file read from a commit that failed, as distinct from a file not in it. */
export class GitReadFailed extends Error {
  constructor(readonly failure: SearchFailure) {
    super(`git could not read a file: ${failure}`);
  }
}

export interface LinkedFrom {
  relPath: string;
  date: string | null;
}

export interface WikiView {
  root: string;
  /** The commit being read, or null for today's working tree. */
  commit: string | null;
  cutMs: number | null;
  /** Null when the file is not there. A commit's read throws {@link GitReadFailed}. */
  readPage(relPath: string): Promise<string | null>;
  readLog(): Promise<string | null>;
  /** When the commit being read was made; null for today's tree. */
  madeAt(): Promise<string | null>;
  /** The linkers read; `failed` when some could not be, so the rows may be short. */
  linkers(relPath: string): Promise<{ rows: LinkedFrom[]; failed?: SearchFailure }>;
}

const dayOf = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

/** Today's view: the rebuilt index and the working tree. */
export function liveView(index: WikiIndex, readFile: (abs: string) => Promise<string | null>): WikiView {
  return {
    root: index.root,
    commit: null,
    cutMs: null,
    readPage: (rel) => readFile(`${index.root}/${rel}`),
    readLog: () => readFile(`${index.root}/log.md`),
    madeAt: async () => null,
    linkers: async (rel) => ({
      rows: (index.backlinks.get(normalizeRelPath(rel)) ?? []).filter((back) => back !== "log.md").slice(0, LINKERS_MAX).map((back) => {
        const meta = index.resolveRelPath(back);
        return { relPath: meta?.relPath ?? back, date: dayOf(meta?.gitTouchedMs ?? meta?.mtimeMs) };
      }),
    }),
  };
}

/**
 * Does this text name the page: a wikilink, a relative markdown link, or the plain
 * relPath? Links read as the reader reads them, except that a bare `[[stem]]` names
 * every page of that stem, since a past commit has no index to say which one won.
 */
export function namesPage(text: string, fromRelPath: string, relPath: string): boolean {
  const rel = normalizeRelPath(relPath);
  const noExtension = rel.replace(/\.mdx?$/, "");
  const stem = wikiPageStem(rel);
  for (const target of extractWikilinks(text)) {
    const t = normalizeRelPath(target).replace(/\.mdx?$/, "");
    if (t === stem || t === noExtension) return true;
  }
  if (resolveMarkdownTargets(fromRelPath, extractMarkdownLinks(text)).includes(rel)) return true;
  const plain = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_./-])${plain}(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}])`, "iu").test(text);
}

export const isCommitId = (commit: string) => /^[0-9a-f]{7,64}$/.test(commit);

/** A past moment: every read goes to the tree of `commit`. */
export function commitView(root: string, commit: string, cutMs: number, git: GitRun): WikiView {
  if (!isCommitId(commit)) throw new Error(`not a commit id: ${commit}`);
  const show = async (rel: string) => {
    const res = await git(root, ["show", `${commit}:./${rel}`]);
    if (res.ok) return res.stdout;
    if (/^fatal: path '.*' (does not exist in|exists on disk, but not in) /m.test(res.stderr ?? "")) return null;
    throw new GitReadFailed(failureOf(res));
  };
  return {
    root,
    commit,
    cutMs,
    readPage: show,
    readLog: () => show("log.md"),
    madeAt: async () => {
      const made = await git(root, ["log", "-1", "--format=%cI", commit, "--"]);
      if (!made.ok || !made.stdout.trim()) throw new Error(`no date for commit ${commit}`);
      return new Date(made.stdout.trim()).toISOString();
    },
    linkers: async (rel) => {
      const hits = await git(root, ["-c", "core.quotepath=off", "grep", "-I", "-l", "-i", "-F", "-e", wikiPageStem(rel), commit, "--"], { maxLines: LINKER_CANDIDATES_MAX });
      let failed = grepFailure(hits);
      const rows: LinkedFrom[] = [];
      for (const line of hits.stdout.split("\n")) {
        if (rows.length === LINKERS_MAX) break;
        const hit = line.slice(commit.length + 1);
        if (!hit || hit === rel || hit === "log.md" || !/\.mdx?$/i.test(hit)) continue;
        let text: string | null;
        try {
          text = await show(hit);
        } catch (err) {
          if (!(err instanceof GitReadFailed)) throw err;
          failed ??= err.failure;
          continue;
        }
        if (text === null || !namesPage(text, hit, rel)) continue;
        const dated = await git(root, ["log", "-1", "--format=%cs", commit, "--", hit]);
        if (!dated.ok) failed ??= failureOf(dated);
        rows.push({ relPath: hit, date: dated.stdout.trim() || null });
      }
      return { rows, ...(failed ? { failed } : {}) };
    },
  };
}

/** What every card on one page shares. */
export interface PageRead {
  relPath: string;
  body: string;
  fm: Record<string, string | string[]>;
  blocks: Block[];
  page: QuestionPage;
  moves: PageNextMoves | null;
  status: string | null;
  repos: string[];
  hints: UnclosedCard[];
  prRefs: string[];
}

export function readPageText(relPath: string, text: string): PageRead {
  const fm = parseFrontmatter(text);
  const blocks = parseBlocks(splitFrontmatter(text).body);
  const page = parseQuestionPage(blocks);
  const status = readPlanStatus(fm) ?? null;
  const reposRaw = fm.repos;
  const repos = (Array.isArray(reposRaw) ? reposRaw : typeof reposRaw === "string" && reposRaw.trim() ? [reposRaw] : []).map((r) => r.trim()).filter(Boolean);
  const prRefs = new Set<string>();
  for (const ledger of pageLedgers(blocks, status === "proposed", { everyRow: true })) {
    for (const row of ledger.rows) {
      for (const own of row.ownPrs ?? []) prRefs.add(`${own.repo}#${own.n}`);
      if (!row.ownPrs?.length && row.link !== null) prRefs.add(`#${row.link}`);
    }
  }
  return { relPath, body: text, fm, blocks, page, moves: extractNextMoves(text), status, repos, hints: unclosedCards(page), prRefs: [...prRefs] };
}

/** The page half of the facts, sent once per page and moment in a batch. */
export interface PageFacts {
  relPath: string;
  /** When the commit this page was read from was made. Absent tonight. */
  asOf?: string;
  status: string | null;
  decisionLog: { id: string; state: string; struck: boolean; text: string }[];
  linkedFrom: LinkedFrom[];
  logEntries: string[];
  prReferences: string[];
  /** Git could not read these lists: a list named here is short or empty for that
   *  reason. Absent when both were read. */
  searchFailed?: { linkedFrom?: SearchFailure; logEntries?: SearchFailure };
}

export async function gatherPageFacts(read: PageRead, view: WikiView): Promise<PageFacts> {
  const { page } = read;
  const asOf = await view.madeAt();
  const linkers = await view.linkers(read.relPath);
  const searchFailed: NonNullable<PageFacts["searchFailed"]> = linkers.failed ? { linkedFrom: linkers.failed } : {};
  let log: string | null = null;
  try {
    log = await view.readLog();
  } catch (err) {
    if (!(err instanceof GitReadFailed)) throw err;
    searchFailed.logEntries = err.failure;
  }
  return {
    relPath: read.relPath,
    ...(asOf ? { asOf } : {}),
    status: read.status,
    decisionLog: page.entries.map((e) => ({ id: e.id, state: page.states.get(e.id)?.kind ?? "open", struck: e.dim, text: e.text })),
    linkedFrom: linkers.rows,
    logEntries: logEntriesNaming(log, read.relPath),
    prReferences: read.prRefs,
    ...(Object.keys(searchFailed).length > 0 ? { searchFailed } : {}),
  };
}

/** The newest `log.md` entries naming the page ({@link namesPage}), newest first
 *  up to the cap. A past moment's log is that commit's file, so it ends there. */
export function logEntriesNaming(text: string | null, relPath: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const entry of text.split(/^(?=## \[)/m)) {
    if (!entry.startsWith("## [")) continue;
    if (namesPage(entry, "log.md", relPath)) out.push(cutLine(entry.trim().replace(/\s+/g, " ")));
  }
  // A log may run either way: keep the entries with the newest dates.
  return out.sort((a, b) => (a.slice(0, 15) < b.slice(0, 15) ? 1 : a.slice(0, 15) > b.slice(0, 15) ? -1 : 0)).slice(0, LOG_ENTRIES_MAX);
}

/** One author's latest live answer, as a fact. */
export interface AnswerFact {
  author: string;
  choice: string | null;
  body: string;
  at: string;
  /** The question's wording changed after this answer. */
  questionChanged: boolean;
}

/** Every author's latest live answer to one question, oldest first, as of
 *  `cutMs`: an answer redacted in any version is gone, a version at or after the
 *  cut does not exist yet, and the answer being replayed is left out whole. */
export function liveAnswers(versions: readonly WikiAnswerVersion[], relPath: string, id: string, questionHash: string, cutMs: number | null): AnswerFact[] {
  const mine = versions.filter((v) => v.relPath === relPath && v.questionId === id);
  const redacted = new Set(mine.filter((v) => v.redactedAt !== null).map((v) => v.answerId));
  const leftOut = new Set(cutMs === null ? [] : mine.filter((v) => v.createdAt >= cutMs - LEFT_OUT_WINDOW_MS && v.createdAt <= cutMs + 1000).map((v) => v.answerId));
  const latest = new Map<string, WikiAnswerVersion>();
  for (const v of mine) {
    if (redacted.has(v.answerId) || leftOut.has(v.answerId) || (cutMs !== null && v.createdAt >= cutMs)) continue;
    const key = v.author.userId ?? v.author.name;
    const held = latest.get(key);
    if (!held || v.createdAt > held.createdAt) latest.set(key, v);
  }
  return [...latest.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((v) => ({
      author: v.author.name,
      choice: v.choice,
      body: v.body.slice(0, ANSWER_BODY_CHARS),
      at: new Date(v.createdAt).toISOString(),
      questionChanged: v.questionHash !== questionHash,
    }));
}

/** Does the latest live answer settle the card without a model call? A choice
 *  other than not sure, on the wording it answered. */
export function answeredByChoice(answers: readonly AnswerFact[]): boolean {
  const latest = answers[answers.length - 1];
  return !!latest && latest.choice !== null && latest.choice !== QUESTION_NOT_SURE && !latest.questionChanged;
}

export interface RepoCodeFact {
  repo: string;
  found: boolean;
  notFoundBecause?: string;
  ref?: string;
  /** The ref's tip date at the moment the card is read as of. */
  tipDate?: string;
  fetch?: ResolvedRepo["fact"]["fetch"];
  subjectsSinceCard?: string[];
  subjectsCapped?: boolean;
  /** Git could not read this repo's tip or subjects; what it did read stays. */
  searchFailed?: SearchFailure;
  code?: { token: string; grep: string[]; capped?: boolean; pathLastChanged?: string; searchFailed?: SearchFailure }[];
}

/** `git grep` exits 1 when nothing matched; any other exit, or none, is a failure. */
const grepFailure = (res: GitResult): SearchFailure | undefined => (res.ok || res.exitCode === 1 ? undefined : failureOf(res));

/** A `%H %cs %s` line with its sha at the rendered length. */
const shortShaLine = (line: string) => cutLine(line.replace(/^[0-9a-f]+/, (sha) => sha.slice(0, SHA_CHARS)));

export interface CardFacts {
  relPath: string;
  id: string;
  body: string;
  choices: string[];
  recommendation: string | null;
  targets: string[];
  /** Whether the targets include the owner; null when they name nobody. */
  ownerAsked: boolean | null;
  owner: string | null;
  waitingLanes: { who: string | null; role: string | null; since: string | null }[];
  /** A prose reading of the page that may be wrong: see the system prompt. */
  unclosedHint: { decision: string | null; namedBy: string | null; word: string | null } | null;
  /** "none": no commit holds the card. "lookup failed": the history read failed. */
  addedCommit: { sha: string; date: string; subject: string } | "none" | "lookup failed";
  answers: AnswerFact[];
  repos: RepoCodeFact[];
  /** Tonight, or the moment this reads as of. */
  asOf: string | null;
}

export interface GatheredCard {
  ref: CardRef;
  questionHash: string;
  recommendation: string | null;
  card: CardFacts;
  codeFacts: boolean;
}

/** The commit that added the card: the oldest changing the count of its `id="…"`,
 *  which a later edit elsewhere in the tag leaves alone. */
async function addedCommit(view: WikiView, read: PageRead, q: ParsedQuestion, git: GitRun): Promise<CardFacts["addedCommit"]> {
  const idAttr = read.body.match(new RegExp(`<Question\\b[^>\\n]*?\\b(id=(["'])${q.id!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\2)`))?.[1];
  if (!idAttr) return "none";
  const res = await git(view.root, ["log", "--follow", "--format=%H%x09%cI%x09%s", `-S${idAttr}`, view.commit ?? "HEAD", "--", read.relPath]);
  if (!res.ok) return "lookup failed";
  const oldest = res.stdout.trim().split("\n").filter(Boolean).pop();
  if (!oldest) return "none";
  const [sha, date, ...subject] = oldest.split("\t");
  return { sha: sha!, date: date!, subject: cutLine(subject.join("\t")) };
}

async function repoFacts(
  repo: ResolvedRepo,
  tokens: readonly string[],
  added: CardFacts["addedCommit"],
  cutMs: number | null,
  budget: { lines: number; tokensLeft: number },
  git: GitRun,
): Promise<RepoCodeFact> {
  const { fact, dir, branch } = repo;
  if (!dir || !branch) return { repo: fact.repo, found: false, ...(fact.reason ? { notFoundBecause: fact.reason } : {}) };
  const shape = (tipDate?: string): RepoCodeFact => ({ repo: fact.repo, found: true, ref: fact.ref!, ...(tipDate ? { tipDate } : {}), ...(fact.fetch ? { fetch: fact.fetch } : {}) });
  // The tip then: --first-parent keeps a feature commit dated before the moment and
  // merged after it out, and what this tip reaches was merged by then, so the reads
  // below walk every parent. It takes the wrong side of a pull-merge or a foxtrot,
  // where main is the second parent: a commit on main before the cut can drop out of
  // `code` and `subjectsSinceCard`. Three real repos hold that shape (20, 13 and 1
  // merges on the first-parent chain), with 0 of the 98 baseline rows hit. It can leak
  // too: `--before` takes the first chain commit dated at or before the cut, assuming
  // dates fall down the chain, and a real repo has first-parent links whose parent is
  // up to 885 s younger than its child, so a card answered in such a window can read a
  // commit up to minutes after its answer. 0 of the 98 baseline rows hit; a follow-up
  // PR takes it. A commit made before the moment and pushed after it cannot be told apart.
  let rev = `refs/remotes/origin/${branch}`;
  let out: RepoCodeFact;
  if (cutMs === null) {
    out = { ...shape(fact.tipDate), ...(fact.searchFailed ? { searchFailed: fact.searchFailed } : {}) };
  } else {
    // Nothing of today's tip read reaches a past moment, neither its date nor its failure.
    const then = await git(dir, ["rev-list", "-1", "--first-parent", `--before=${new Date(cutMs).toISOString()}`, rev, "--"]);
    if (!then.ok) return { ...shape(), searchFailed: failureOf(then) };
    const sha = then.stdout.trim();
    if (!sha) return { ...shape("none at that time"), subjectsSinceCard: [], code: [] };
    rev = sha;
    const dated = await git(dir, ["log", "-1", "--format=%cI", rev, "--"]);
    out = dated.ok ? shape(dated.stdout.trim()) : { ...shape(), searchFailed: failureOf(dated) };
  }
  if (added === "none") out.subjectsSinceCard = [];
  else if (added !== "lookup failed") {
    const log = await git(dir, ["log", `-n${SUBJECTS_PER_REPO + 1}`, "--format=%H %cs %s", `--since=${added.date}`, rev, "--"]);
    if (log.ok) {
      const lines = log.stdout.split("\n").filter(Boolean);
      out.subjectsSinceCard = lines.slice(0, SUBJECTS_PER_REPO).map(shortShaLine);
      if (lines.length > SUBJECTS_PER_REPO) out.subjectsCapped = true;
    } else out.searchFailed = failureOf(log);
  }
  out.code = [];
  for (const token of tokens) {
    if (budget.lines <= 0) break;
    const share = Math.max(1, Math.ceil(budget.lines / Math.max(1, budget.tokensLeft)));
    budget.tokensLeft--;
    const hits = await git(dir, ["grep", "-I", "-n", "-F", "-e", token, rev, "--"], { maxLines: share });
    const grep = hits.ok ? hits.stdout.split("\n").filter(Boolean).slice(0, share).map((l) => cutLine(l.startsWith(`${rev}:`) ? l.slice(rev.length + 1) : l)) : [];
    budget.lines -= grep.length;
    let pathLastChanged: string | undefined;
    let searchFailed = grepFailure(hits);
    if (/[/.]/.test(token)) {
      const last = await git(dir, ["log", "-1", "--format=%H %cs %s", rev, "--", token]);
      if (last.ok && last.stdout.trim()) pathLastChanged = shortShaLine(last.stdout.trim());
      // A URL such as `/admin/run` is a fine token and no path git can look up.
      else if (!last.ok && !/outside repository|Invalid path/i.test(last.stderr ?? "")) searchFailed ??= failureOf(last);
    }
    if (grep.length || pathLastChanged || searchFailed) {
      out.code.push({ token, grep, ...(hits.capped ? { capped: true } : {}), ...(pathLastChanged ? { pathLastChanged } : {}), ...(searchFailed ? { searchFailed } : {}) });
    }
  }
  return out;
}

export interface GatherContext {
  git: GitRun;
  /** The run's repo resolver, one fetch per repo. */
  repo: (name: string) => Promise<ResolvedRepo>;
  answers: readonly WikiAnswerVersion[];
  /** `WIKI_ANSWER_OWNER` and `WIKI_ANSWER_GROUPS`. */
  owner: string | null;
  groups: Parameters<typeof waitOwnerFrom>[0]["groups"];
}

/** One card's facts, with its page already read. */
export async function gatherCardFacts(ref: CardRef, read: PageRead, view: WikiView, ctx: GatherContext): Promise<GatheredCard> {
  const q = read.page.questions.find((x) => x.id === ref.id);
  if (!q) throw new Error(`no card ${ref.id} on the page`);
  const questionHash = sha256(q.hashInput);
  const recommendation = parseRecommendation(q.body, q.choices);
  const owner = waitOwnerFrom({ owner: ctx.owner, ...(ctx.groups ? { groups: ctx.groups } : {}) });
  const { to } = resolveQuestionTargets(q.to, parseQuestionsTo(read.fm.questions_to), ctx.owner);
  const added = await addedCommit(view, read, q, ctx.git);
  const tokens = cardTokens(q.body);
  const budget = { lines: CODE_LINES_PER_CARD, tokensLeft: tokens.length * read.repos.length };
  const repos: RepoCodeFact[] = [];
  for (const name of read.repos) {
    repos.push(await repoFacts(await ctx.repo(name), tokens, added, view.cutMs, budget, ctx.git));
  }
  const hint = read.hints.find((h) => h.id === ref.id);
  const card: CardFacts = {
    relPath: read.relPath,
    id: ref.id,
    body: q.body,
    choices: q.choices,
    recommendation,
    targets: to.map(formatQuestionTarget),
    ownerAsked: askedOwner(owner, to, ctx),
    owner: owner?.author.name ?? null,
    waitingLanes: lanesNaming(read.moves, ref.id),
    unclosedHint: hint ? { decision: hint.decision, namedBy: hint.namedBy, word: hint.word } : null,
    addedCommit: added,
    answers: liveAnswers(ctx.answers, ref.relPath, ref.id, questionHash, view.cutMs),
    repos,
    asOf: view.cutMs === null ? null : new Date(view.cutMs).toISOString(),
  };
  return { ref, questionHash, recommendation, card, codeFacts: repos.some((r) => (r.code ?? []).some((c) => c.grep.length > 0 || c.pathLastChanged)) };
}

function askedOwner(owner: WaitOwner | null, to: Parameters<typeof isAskedAuthor>[1], ctx: GatherContext): boolean | null {
  return owner ? isAskedAuthor(owner.author, to, ctx.groups ?? new Map()) : null;
}

/** The counted `waiting` lanes whose items name this card. */
function lanesNaming(moves: PageNextMoves | null, id: string): CardFacts["waitingLanes"] {
  return (moves?.waiting ?? [])
    .filter((lane) => lane.items.some((item) => namedQuestionIds(item.replace(WIKILINK_WITH_LABEL_RE, "\x00"), [id]).length > 0))
    .map((lane) => ({ who: lane.who, role: lane.role, since: lane.since }));
}
