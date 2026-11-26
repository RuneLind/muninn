/**
 * Where a key is mentioned in one wiki (Discuss v2, mimir plan
 * muninn-wiki-discuss-v2, PR 2): the tracked files and lines that hold it, the
 * commits that added or removed it, the `log.md` entries it appears in, and the
 * PRs those lines name with what the GitHub caches know of them. No model call.
 *
 * The key is a literal, searched as a fixed string (`grepTracked`, `historyFor`
 * in `tracked-files.ts`). Its `kind` comes from the wiki's `trackers` or its
 * `keys` (`key-kinds.ts`) and never decides whether it is searched, only how:
 * a classified key counts only where it stands whole (`wholeKey`: no Unicode
 * letter or digit right before or after it), so `MEL-1` is not found inside
 * `MEL-10` or `MEL-1029036`, in its lines, its totals, its commits or its log
 * lines. A free phrase (`kind` null: «Where else» on a selection) is matched
 * as a substring.
 *
 * Every read goes through `tracked-files.ts`: the whole-wiki grep, and the
 * root `log.md` on a grep of its own (`grepRootLog`, `rootLogHeaders`), so a
 * busy key's hits elsewhere cannot use up the log's budget. The headers are
 * parsed with the reader's `parseLogEntries`.
 *
 * PR refs are read from the matched lines, uncut (`fullText`), with the live chips' parser
 * (`prMentions`) and the wiki's `prGrammar`, so `api #3625` resolves the way a
 * fact chip does. A bare `#n` is not read: it needs a page's home repo and a
 * facts title, which a lone line does not have. States come only from the
 * caches (`cachedPrFacts`); a miss is `unknown`/`stale` and is handed to the
 * background refresh (`askPrsInBackground`), so `gh` never runs on the request.
 * A miss no refresh will ask is `not-checked`, with the reason and not stale: a
 * repo whose query failed within the hour, a read-only root (`read-only`) and
 * the check turned off (`disabled`).
 *
 * The route is a thin caller (`dashboard/routes/wiki-mentions.ts`); the Trace
 * view (PR 6) imports this module. Nothing here writes to a wiki.
 */

import { displayTitleOf } from "./core/wiki-filter.ts";
import { realGit, type GitRun } from "./decision-triage/git.ts";
import { classifyKey } from "./key-kinds.ts";
import { prMentions } from "./live-facts.ts";
import { parseLogEntries } from "./log-entries.ts";
import type { WikiIndex } from "./store.ts";
import { GREP_MAX_RESULTS, grepRootLog, grepTracked, historyFor, rootLogHeaders } from "./tracked-files.ts";
import { askPrsInBackground, cachedPrFacts, parseRefString, type GhCheckDeps, type NotCheckedReason, type PrRef } from "./work-map/gh-check.ts";

// The key check lives in a dependency-free module the reader bundle imports too.
export { MENTION_KEY_MAX, MENTION_KEY_MIN, parseMentionKey } from "./mention-key.ts";
/** Matching lines returned; past it the answer says `truncated`. */
export const MENTIONS_MAX_LINES = GREP_MAX_RESULTS;
export const MENTIONS_MAX_COMMITS = 50;
/** Matching `log.md` lines returned, on a budget of their own. */
export const MENTIONS_MAX_LOG = GREP_MAX_RESULTS;

/** Why a miss is not asked: a repo failure from the caches, or no refresh at all on this root. */
export type MentionNotCheckedReason = NotCheckedReason | "read-only";

export type PrStateWord = "open" | "merged" | "closed" | "unknown" | "not-a-pr" | "not-checked";

export interface MentionsBody {
  key: string;
  /** A tracker id (`jira`) or a `keys` name (`case`); null when neither claims the key. */
  kind: string | null;
  /** Each file with matching lines, in git's order; `title` from the index where the file is a page, else null. */
  files: { relPath: string; title: string | null; lines: { n: number; text: string }[] }[];
  /** Commits whose diff changes how often the key occurs, newest first. */
  commits: { sha: string; date: string; subject: string; files: string[] }[];
  /** The matched lines of the root `log.md`, from a search of its own, each with the date and kind of the entry it sits in (null before the first entry, or past the last header read when the header bound was hit). */
  log: { date: string | null; kind: string | null; line: string; n: number }[];
  /** `stale`: no current answer, and a refresh has been started or will be by a later request (one past the unanswered retry window, or past the hourly cap). A `not-checked` ref is never stale, since no refresh asks it: its repo's query failed within the hour (`reason` says why), the root is read-only (`read-only`) or the check is off (`disabled`). */
  prs: { repo: string; number: number; state: PrStateWord; mergedAt: string | null; url: string; stale: boolean; reason?: MentionNotCheckedReason }[];
  /** Matching lines and files in the whole wiki, `log.md` included: every one the search saw, not only those listed. */
  totalLines: number;
  totalFiles: number;
  /** The search stopped at its scan bound, so the totals are lower bounds. */
  totalsAtLeast: boolean;
  /** A bound cut the lines, the log lines or the commits: more exist than are listed. */
  truncated: boolean;
}

export interface MentionsInput {
  /** The registry name: the GitHub caches are keyed on it. */
  wiki: string;
  root: string;
  key: string;
  index: Pick<WikiIndex, "resolveRelPath" | "readerConfig"> | null;
}

export interface MentionsDeps {
  git?: GitRun;
  /** The background refresh's `gh`; null on a read-only root, where no refresh starts. */
  gh: Pick<GhCheckDeps, "runGh" | "disabled"> | null;
  now: () => number;
}

/** How long {@link mentionsWorkTree} keeps its answer for a root. */
export const WORK_TREE_TTL_MS = 60_000;
const workTrees = new Map<string, { at: number; inside: Promise<boolean> }>();

/**
 * Whether `root` is in a git work tree, which the mentions route's `git grep`
 * and `git log` need (it answers 500 elsewhere). The page route asks on every
 * open before it marks a key (fix round 1 J3), so the answer is kept per root
 * for {@link WORK_TREE_TTL_MS}.
 */
export function mentionsWorkTree(root: string, git: GitRun = realGit, now = Date.now()): Promise<boolean> {
  const kept = workTrees.get(root);
  if (kept && now - kept.at < WORK_TREE_TTL_MS) return kept.inside;
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: 5_000 }).then(
    (r) => r.ok && r.stdout.trim() === "true",
    () => false,
  );
  workTrees.set(root, { at: now, inside });
  return inside;
}

const stateWord = (s: "OPEN" | "MERGED" | "CLOSED"): PrStateWord => (s === "OPEN" ? "open" : s === "MERGED" ? "merged" : "closed");

export async function buildMentions(input: MentionsInput, deps: MentionsDeps): Promise<{ ok: true; body: MentionsBody } | { ok: false; error: string }> {
  const { root, key } = input;
  const cfg = input.index?.readerConfig ?? null;
  const kind = classifyKey(key, cfg?.trackers ?? [], cfg?.keys ?? []);
  const wholeKey = kind !== null;
  const [grep, history, logGrep] = await Promise.all([
    grepTracked(root, key, { git: deps.git, max: MENTIONS_MAX_LINES, fullText: true, wholeKey }),
    // One more than shown: only a 51st commit says there are more than 50.
    historyFor(root, key, { git: deps.git, limit: MENTIONS_MAX_COMMITS + 1, wholeKey }),
    grepRootLog(root, key, { git: deps.git, max: MENTIONS_MAX_LOG, fullText: true, wholeKey }),
  ]);
  if (!grep.ok) return grep;
  if (!history.ok) return history;
  if (!logGrep.ok) return logGrep;

  const byFile = new Map<string, MentionsBody["files"][number]>();
  for (const h of grep.hits) {
    let f = byFile.get(h.relPath);
    if (!f) {
      const meta = input.index?.resolveRelPath(h.relPath);
      f = { relPath: h.relPath, title: meta ? displayTitleOf(meta) : null, lines: [] };
      byFile.set(h.relPath, f);
    }
    f.lines.push({ n: h.line, text: h.text });
  }

  const log: MentionsBody["log"] = [];
  let headersCut = false;
  if (logGrep.hits.length) {
    const headers = await rootLogHeaders(root, { git: deps.git });
    if (!headers.ok) return headers;
    headersCut = headers.atLeast;
    // A `##` line is an entry only where the reader's parser says so (`## [draft]` is body text).
    const entries = headers.headers.flatMap((h) => parseLogEntries(h.text).map((e) => ({ ...e, line: h.line })));
    const lastRead = headers.headers.at(-1)?.line ?? 0;
    for (const hit of logGrep.hits) {
      // The entry a line sits in: the last header at or above it. Past the last header read, an unread one may own it.
      let entry: (typeof entries)[number] | undefined;
      if (!(headersCut && hit.line > lastRead)) for (const e of entries) if (e.line <= hit.line && (!entry || e.line > entry.line)) entry = e;
      log.push({ date: entry?.date ?? null, kind: entry?.kind || null, line: hit.text, n: hit.line });
    }
  }

  // From the uncut lines: a ref late in a long paragraph is past the 300-character display cut.
  const refs = new Map<string, PrRef>();
  for (const h of [...grep.hits, ...logGrep.hits]) {
    for (const m of prMentions(h.full ?? h.text, cfg?.prGrammar ?? null, null)) {
      const ref = parseRefString(m.id);
      if (ref && !refs.has(ref.id)) refs.set(ref.id, ref);
    }
  }
  const cached = cachedPrFacts(input.wiki, [...refs.values()], deps.now());
  const misses: PrRef[] = [];
  // No refresh will ever ask a miss here, so it is not stale.
  const noRefresh: MentionNotCheckedReason | null = !deps.gh ? "read-only" : deps.gh.disabled() ? "disabled" : null;
  const prs: MentionsBody["prs"] = [...refs.values()].map((ref) => {
    const url = `https://github.com/${ref.repo}/pull/${ref.n}`;
    const fact = cached.facts.get(ref.id);
    if (fact === undefined) {
      const reason = cached.failures.get(ref.repo.toLowerCase());
      // The same test `askPrsInBackground` skips a repo by, so no refresh is on its way for this one.
      if (reason) return { repo: ref.repo, number: ref.n, state: "not-checked", mergedAt: null, url, stale: false, reason };
      if (noRefresh) return { repo: ref.repo, number: ref.n, state: "not-checked", mergedAt: null, url, stale: false, reason: noRefresh };
      // `askPrsInBackground` decides which of the rest are due: not a repo that went unanswered within minutes.
      misses.push(ref);
      return { repo: ref.repo, number: ref.n, state: "unknown", mergedAt: null, url, stale: true };
    }
    if (fact === null) return { repo: ref.repo, number: ref.n, state: "not-a-pr", mergedAt: null, url, stale: false };
    return { repo: ref.repo, number: ref.n, state: stateWord(fact.state), mergedAt: fact.mergedAt, url, stale: false };
  });
  if (misses.length && deps.gh) askPrsInBackground(input.wiki, misses, deps.gh, deps.now);

  return {
    ok: true,
    body: {
      key,
      kind,
      files: [...byFile.values()],
      commits: history.commits.slice(0, MENTIONS_MAX_COMMITS).map((c) => ({ sha: c.hash, date: c.date, subject: c.subject, files: c.files })),
      log,
      prs,
      totalLines: grep.totalLines,
      totalFiles: grep.totalFiles,
      totalsAtLeast: grep.atLeast,
      truncated:
        grep.atLeast ||
        grep.totalLines > grep.hits.length ||
        logGrep.atLeast ||
        logGrep.totalLines > logGrep.hits.length ||
        headersCut ||
        history.partial ||
        history.commits.length > MENTIONS_MAX_COMMITS,
    },
  };
}
