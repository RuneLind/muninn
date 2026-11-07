/**
 * The boundary-crossing share (architecture review 2026-11, F8): of the non-merge
 * commits in a range, how many touch both the knowledge side and the rest. Below
 * about 20% a package boundary around the wiki pays for itself; above 25% it costs
 * more PRs than it saves.
 *
 *   bun scripts/boundary-crossing.ts [--since=<date>] [--until=<date>] [--json]
 *
 * A file is classified by the first matching rule in `SIDE_RULES`; files that are
 * neither (shared registries, docs, CI) do not count toward either side.
 */
import { layerOf } from "../src/test/layers.ts";

export type Side = "knowledge" | "other" | "neutral";
export type CommitClass = "knowledge" | "other" | "crossing" | "neutral";

/**
 * Knowledge-side file names in folders that mix both sides (dashboard, chat, db, test, watchers, e2e, scripts, extensions).
 * Short words are anchored at a path segment's start: bare `component` matched every file under a
 * `components/` folder and `share` matched `shared-styles.ts` (each term's hits since 10-13 reviewed by hand).
 */
const KNOWLEDGE_NAME =
  /wiki|summar|(^|\/)sum-|(^|\/)plans?[-./]|gardener|walkthrough|factcheck|(^|\/)share[-./]|frames|graph|youtube|vimeo|tiktok|x-article|(^|\/)article[-./]|anthropic|(^|\/)component-reference|decision|work-map|theme-map|stale-proposal|diagram|oppfolging|find-links/;

/** First match wins. */
export const SIDE_RULES: readonly (readonly [test: (f: string) => boolean, side: Side, why: string])[] = [
  [(f) => /(^|\/)(CLAUDE|README|AGENTS)\.md$|(^|\/)reference\/notes\.md$/.test(f), "neutral", "instructions and docs"],
  [(f) => /^(docs|\.github|\.claude)\//.test(f), "neutral", "docs, CI, agent config"],
  [(f) => /^(package\.json|bun\.lock|tsconfig\.json|Dockerfile|\.gitignore|\.dockerignore|bunfig\.toml|playwright\.config\.ts)$/.test(f), "neutral", "root config"],
  [(f) => /^scripts\/(test-chain|unit-|e2e-shards|count-tests|layer-|boundary-crossing)/.test(f), "neutral", "test-chain and CI tooling"],
  [(f) => /^e2e\/(ports\.ts|shard-timings\.json|ci-expected-skips\.txt|e2e-env\.ts|own-server\.ts)$/.test(f), "neutral", "e2e shared registries"],
  [(f) => /^src\/test\/(claude-md-budgets\.json|mock-isolation|layers|layer-direction|ambient-env)/.test(f) || f === "e2e/own-server.test.ts", "neutral", "repo guards and the instance-env list"],
  [(f) => /^src\/auth\/(.*inventory\.txt|side-effecting-gets\.test\.ts)$|^src\/dashboard\/(route-groups\.ts|routes-profile\.test\.ts)$/.test(f), "neutral", "route registries every new route joins"],
  // render includes src/web/web-format.ts, which serves chat too (F7). Kept knowledge: its commits since 10-13
  // are wiki component rendering, and the chat formatters a new component touches still count as the other side.
  [(f) => ["wiki-core", "render"].includes(layerOf(f) ?? ""), "knowledge", "layer table: wiki-core and render"],
  [(f) => /^src\/(gardener|plans|summaries|share|youtube|vimeo|tiktok|x-article|article|anthropic|video)\//.test(f), "knowledge", "gardener, plans, capture verticals"],
  [(f) => /^(src\/(dashboard|chat|db|test|watchers)|db\/migrations|e2e|scripts|extensions)\//.test(f) && KNOWLEDGE_NAME.test(f.slice(f.indexOf("/") + 1)), "knowledge", "wiki/capture files in mixed folders"],
];

export function classifyFile(file: string): Side {
  for (const [test, side] of SIDE_RULES) if (test(file)) return side;
  return "other";
}

export function classifyCommit(files: readonly string[]): CommitClass {
  const sides = new Set(files.map(classifyFile));
  if (sides.has("knowledge") && sides.has("other")) return "crossing";
  if (sides.has("knowledge")) return "knowledge";
  if (sides.has("other")) return "other";
  return "neutral";
}

export interface Commit {
  sha: string;
  subject: string;
  files: string[];
}

const MARK = "\u0001";

/** Parses `git log --name-only --format=<MARK>%H %s`. */
export function parseGitLog(text: string): Commit[] {
  return text
    .split(MARK)
    .filter((b) => b.trim() !== "")
    .map((block) => {
      const [head = "", ...rest] = block.split("\n");
      const sp = head.indexOf(" ");
      return { sha: head.slice(0, sp < 0 ? undefined : sp), subject: sp < 0 ? "" : head.slice(sp + 1), files: rest.map((l) => l.trim()).filter(Boolean) };
    });
}

export interface Summary {
  commits: number;
  knowledge: number;
  other: number;
  crossing: number;
  neutral: number;
  /** crossing / (commits that touch at least one side); neutral-only commits are left out. */
  crossingShare: number;
}

export function summarize(commits: readonly Commit[]): Summary {
  const s = { commits: commits.length, knowledge: 0, other: 0, crossing: 0, neutral: 0 };
  for (const c of commits) s[classifyCommit(c.files)]++;
  const counted = s.knowledge + s.other + s.crossing;
  return { ...s, crossingShare: counted === 0 ? 0 : s.crossing / counted };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const since = opt("since") ?? "2026-10-13";
  const until = opt("until");
  const gitArgs = ["log", "--no-merges", "--name-only", `--format=${MARK}%H %s`, `--since=${since}`, ...(until ? [`--until=${until}`] : []), opt("rev") ?? "HEAD"];
  const proc = Bun.spawnSync(["git", ...gitArgs], { cwd: `${import.meta.dir}/..` });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  const commits = parseGitLog(proc.stdout.toString());
  const summary = summarize(commits);
  if (args.includes("--json")) {
    const rows = commits.map((c) => ({ sha: c.sha.slice(0, 8), subject: c.subject, class: classifyCommit(c.files) }));
    console.log(JSON.stringify({ since, until: until ?? null, ...summary, rows }, null, 2));
  } else {
    const counted = summary.knowledge + summary.other + summary.crossing;
    console.log(`since ${since}: ${summary.commits} commits — knowledge ${summary.knowledge}, other ${summary.other}, crossing ${summary.crossing}, neutral-only ${summary.neutral}`);
    console.log(`crossing share: ${(summary.crossingShare * 100).toFixed(1)}% (${summary.crossing} of ${counted}); of all commits ${((summary.crossing / Math.max(1, summary.commits)) * 100).toFixed(1)}%`);
  }
}
