/**
 * Where a key is mentioned in one wiki (Discuss v2, mimir plan
 * muninn-wiki-discuss-v2, PR 2): the tracked files and lines that hold it, the
 * commits that added or removed it, the `log.md` entries it appears in, and the
 * PRs those lines name with what the GitHub caches know of them. No model call.
 *
 * The key is a literal, searched as a fixed string (`grepTracked`, `historyFor`
 * in `tracked-files.ts`). Its `kind` comes from the wiki's `trackers` or its
 * `keys` (`key-kinds.ts`) and never decides whether it is searched.
 *
 * PR refs are read from the matched lines with the live chips' parser
 * (`prMentions`) and the wiki's `prGrammar`, so `api #3625` resolves the way a
 * fact chip does. A bare `#n` is not read: it needs a page's home repo and a
 * facts title, which a lone line does not have. States come only from the
 * caches (`cachedPrFacts`); a miss is `unknown`/`stale` and starts one
 * background refresh (`askPrsInBackground`), so `gh` never runs on the request.
 *
 * The route is a thin caller (`dashboard/routes/wiki-mentions.ts`); the Trace
 * view (PR 6) imports this module. Nothing here writes to a wiki.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { displayTitleOf } from "./core/wiki-filter.ts";
import type { GitRun } from "./decision-triage/git.ts";
import { classifyKey } from "./key-kinds.ts";
import { prMentions } from "./live-facts.ts";
import { parseLogEntries } from "./log-entries.ts";
import type { WikiIndex } from "./store.ts";
import { GREP_MAX_RESULTS, grepTracked, historyFor } from "./tracked-files.ts";
import { askPrsInBackground, cachedPrFacts, parseRefString, type GhCheckDeps, type PrRef } from "./work-map/gh-check.ts";

export const MENTION_KEY_MIN = 3;
export const MENTION_KEY_MAX = 80;
/** Matching lines returned; past it the answer says `truncated`. */
export const MENTIONS_MAX_LINES = GREP_MAX_RESULTS;
export const MENTIONS_MAX_COMMITS = 50;
const LOG_FILE = "log.md";

/** The key as searched, or why it is refused: 3–80 characters, no line break, NUL or other control character. Surrounding blanks are trimmed. */
export function parseMentionKey(raw: string | undefined): { key: string } | { error: string } {
  const key = (raw ?? "").trim();
  if (key.length < MENTION_KEY_MIN || key.length > MENTION_KEY_MAX) return { error: `key must be ${MENTION_KEY_MIN}–${MENTION_KEY_MAX} characters` };
  if (/[\u0000-\u001f\u007f]/.test(key)) return { error: "key may not hold a line break or control character" };
  return { key };
}

export type PrStateWord = "open" | "merged" | "closed" | "unknown" | "not-a-pr";

export interface MentionsBody {
  key: string;
  /** A tracker id (`jira`) or a `keys` name (`case`); null when neither claims the key. */
  kind: string | null;
  /** Each file with matching lines, in git's order; `title` from the index where the file is a page, else null. */
  files: { relPath: string; title: string | null; lines: { n: number; text: string }[] }[];
  /** Commits whose diff changes how often the key occurs, newest first. */
  commits: { sha: string; date: string; subject: string; files: string[] }[];
  /** The matched lines of `log.md`, each with the date and kind of the entry it sits in (null before the first entry). */
  log: { date: string | null; kind: string | null; line: string; n: number }[];
  prs: { repo: string; number: number; state: PrStateWord; mergedAt: string | null; url: string; stale: boolean }[];
  /** A bound cut the lines or the commits: more exist than are listed. */
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
  /** `log.md`'s text, or null. Default: the root's `log.md`, unless it is a symlink. */
  readLog?: (root: string) => Promise<string | null>;
  /** The background refresh's `gh`; null starts none (a read-only root, a test). */
  gh: Pick<GhCheckDeps, "runGh" | "disabled"> | null;
  now: () => number;
}

async function readRootLog(root: string): Promise<string | null> {
  const file = path.join(root, LOG_FILE);
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile()) return null;
  return Bun.file(file).text().catch(() => null);
}

const stateWord = (s: "OPEN" | "MERGED" | "CLOSED"): PrStateWord => (s === "OPEN" ? "open" : s === "MERGED" ? "merged" : "closed");

export async function buildMentions(input: MentionsInput, deps: MentionsDeps): Promise<{ ok: true; body: MentionsBody } | { ok: false; error: string }> {
  const { root, key } = input;
  const [grep, history] = await Promise.all([
    grepTracked(root, key, { git: deps.git, max: MENTIONS_MAX_LINES }),
    historyFor(root, key, { git: deps.git, limit: MENTIONS_MAX_COMMITS }),
  ]);
  if (!grep.ok) return grep;
  if (!history.ok) return history;
  const cfg = input.index?.readerConfig ?? null;

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
  const logHits = byFile.get(LOG_FILE)?.lines ?? [];
  if (logHits.length) {
    const text = await (deps.readLog ?? readRootLog)(root);
    const entries = text === null ? [] : parseLogEntries(text);
    for (const hit of logHits) {
      // The entry a line sits in: the last header at or above it.
      let entry: (typeof entries)[number] | undefined;
      for (const e of entries) if ((e.line ?? Infinity) <= hit.n && (!entry || (e.line ?? 0) > (entry.line ?? 0))) entry = e;
      log.push({ date: entry?.date ?? null, kind: entry?.kind || null, line: hit.text, n: hit.n });
    }
  }

  const refs = new Map<string, PrRef>();
  for (const h of grep.hits) {
    for (const m of prMentions(h.text, cfg?.prGrammar ?? null, null)) {
      const ref = parseRefString(m.id);
      if (ref && !refs.has(ref.id)) refs.set(ref.id, ref);
    }
  }
  const cached = cachedPrFacts(input.wiki, [...refs.values()], deps.now());
  const misses: PrRef[] = [];
  const prs: MentionsBody["prs"] = [...refs.values()].map((ref) => {
    const url = `https://github.com/${ref.repo}/pull/${ref.n}`;
    const fact = cached.facts.get(ref.id);
    if (fact === undefined) {
      // A repo whose last query failed within the hour is not asked again until that answer ages out.
      if (!cached.failures.has(ref.repo.toLowerCase())) misses.push(ref);
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
      kind: classifyKey(key, cfg?.trackers ?? [], cfg?.keys ?? []),
      files: [...byFile.values()],
      commits: history.commits.map((c) => ({ sha: c.hash, date: c.date, subject: c.subject, files: c.files })),
      log,
      prs,
      truncated: grep.atLeast || grep.totalLines > grep.hits.length || history.partial || history.commits.length >= MENTIONS_MAX_COMMITS,
    },
  };
}
