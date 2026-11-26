/**
 * `buildMentions` on a real temp git repo: a classified key (`keys`:
 * `MEL-\d+`) counts only where it stands whole, so `MEL-1` is never found
 * inside `MEL-10` or `MEL-1029036`: not in its lines, totals, commits, log
 * lines or PR refs. A free phrase (`kind` null) stays a substring search.
 * Invented content only.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realGit } from "./decision-triage/git.ts";
import { buildMentions, mentionsGitState, mentionsWorkTree, type MentionsBody } from "./mentions.ts";
import { getWikiIndex } from "./store.ts";
import { testTempDir } from "../test/temp-dir.ts";

let root = "";
const sha: Record<string, string> = {};
const at = (name: string) => sha[name]!;

async function git(...args: string[]): Promise<string> {
  const res = await realGit(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
  if (!res.ok) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}
async function put(rel: string, text: string) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}
async function commit(name: string, msg: string) {
  await git("add", "-A");
  await git("commit", "-q", "-m", msg);
  sha[name] = await git("rev-parse", "HEAD");
}

const ONE = (first: string, second: string) =>
  ["# One", "", first, second, "MEL-1_notes and MEL-1-fix stay MEL-1's.", "Not XMEL-1 nor MEL-1å nor MEL-1٣ nor æMEL-1.", ""].join("\n");
const SMALL = "MEL-1 is the small case.";
const SEE = "See MEL-10 and MEL-1029036 (api #3625).";

beforeAll(async () => {
  root = path.join(await realpath(await testTempDir(path.join(tmpdir(), "muninn-mentions-whole-"))), "wiki");
  await mkdir(root, { recursive: true });
  await git("init", "-q", "-b", "main");
  await put(".wiki-reader.json", JSON.stringify({ prGrammar: { owner: "acme", aliases: { api: "acme-api" } }, keys: [{ name: "case", pattern: "MEL-\\d+" }] }));
  await put("plans/one.md", ONE(SMALL, SEE));
  await put("plans/swap.md", "Swap MEL-1 here.\n");
  await put("log.md", "# Log\n\n## [2026-11-01] note | MEL-1029036 filed\n\n- MEL-1029036 goes to api #3625.\n- MEL-10 too.\n\n## [2026-11-02] note | small\n\n- MEL-1 closed.\n");
  await commit("first", "first: MEL-1, MEL-10 and MEL-1029036");
  // Only longer keys: MEL-1's substring count changes, its whole count does not.
  await put("plans/ten.md", "MEL-10 waits on api #3556.\n");
  await commit("ten", "only MEL-10");
  // MEL-1 becomes MEL-12: the whole count changes, the substring count does not.
  await put("plans/swap.md", "Swap MEL-12 here.\n");
  await commit("swap", "MEL-1 becomes MEL-12");
  // Behind a non-ASCII letter: not a whole MEL-1, though git's C-locale ERE lets it by.
  await put("plans/nordic.md", "Saken æMEL-1 er ikke vår.\n");
  await commit("nordic", "æMEL-1 only");
  // A moved line: the count stays the same.
  await put("plans/one.md", ONE(SEE, SMALL));
  await commit("move", "move the MEL-1 line");
});

const mentions = async (key: string): Promise<MentionsBody> => {
  const res = await buildMentions({ wiki: "whole-fixture", root, key, index: await getWikiIndex({ root }) }, { gh: null, now: Date.now });
  if (!res.ok) throw new Error(res.error);
  return res.body;
};
const lines = (b: MentionsBody) => b.files.flatMap((f) => f.lines.map((l) => `${f.relPath}:${l.n} ${l.text}`));

describe("buildMentions: a classified key counts only where it stands whole", () => {
  test("MEL-1 holds none of MEL-10 or MEL-1029036: lines, totals, commits, log lines and PRs are its own", async () => {
    const b = await mentions("MEL-1");
    expect(b.kind).toBe("case");
    expect(lines(b)).toEqual(["log.md:10 - MEL-1 closed.", `plans/one.md:4 ${SMALL}`, "plans/one.md:5 MEL-1_notes and MEL-1-fix stay MEL-1's."]);
    expect([b.totalLines, b.totalFiles, b.totalsAtLeast, b.truncated]).toEqual([3, 2, false, false]);
    expect(b.log).toEqual([{ date: "2026-11-02", kind: "note", line: "- MEL-1 closed.", n: 10 }]);
    // The swap (whole count 1 → 0) and the first commit; not «only MEL-10», «æMEL-1 only» or the move.
    expect(b.commits.map((c) => c.sha)).toEqual([at("swap"), at("first")]);
    expect(b.commits[0]!.files).toEqual(["plans/swap.md"]);
    expect(b.prs).toEqual([]);
  });

  test("a long key keeps every mention: MEL-1029036", async () => {
    const b = await mentions("MEL-1029036");
    expect(lines(b)).toEqual(["log.md:3 ## [2026-11-01] note | MEL-1029036 filed", "log.md:5 - MEL-1029036 goes to api #3625.", `plans/one.md:3 ${SEE}`]);
    expect([b.totalLines, b.totalFiles]).toEqual([3, 2]);
    expect(b.log.map((l) => l.n)).toEqual([3, 5]);
    expect(b.commits.map((c) => c.sha)).toEqual([at("first")]);
    expect(b.prs.map((p) => `${p.repo}#${p.number}`)).toEqual(["acme/acme-api#3625"]);
  });

  test("a free phrase (kind null) is still a substring search", async () => {
    const b = await mentions("EL-1");
    expect(b.kind).toBeNull();
    expect(lines(b)).toContain("plans/ten.md:1 MEL-10 waits on api #3556.");
    expect(lines(b)).toContain("plans/nordic.md:1 Saken æMEL-1 er ikke vår.");
    expect(b.commits.map((c) => c.sha)).toContain(at("ten"));
    expect(b.prs.map((p) => `${p.repo}#${p.number}`).sort()).toEqual(["acme/acme-api#3556", "acme/acme-api#3625"]);
  });
});

// Fix round 2: the reader offers the peek and Trace only where the mentions can
// answer, and a repo before its first commit cannot (its `git log` fails).
describe("mentionsWorkTree: a git work tree whose HEAD names a commit", () => {
  test("a repo with staged files and no commit is not offered; after its first commit it is, once the 60 s answer expires", async () => {
    const fresh = path.join(await realpath(await testTempDir(path.join(tmpdir(), "muninn-mentions-fresh-"))), "wiki");
    await mkdir(fresh, { recursive: true });
    const run = async (...args: string[]) => {
      const res = await realGit(fresh, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
      if (!res.ok) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    };
    await run("init", "-q", "-b", "main");
    await writeFile(path.join(fresh, "a.md"), "MEL-5 is new.\n");
    await run("add", "-A");
    const t0 = 1_000_000;
    expect(await mentionsGitState(fresh)).toBe("no-commit");
    expect(await mentionsWorkTree(fresh, realGit, t0)).toBe(false);
    await run("commit", "-q", "-m", "first");
    expect(await mentionsGitState(fresh)).toBe("ok");
    // Kept for the TTL, then asked again.
    expect(await mentionsWorkTree(fresh, realGit, t0 + 1_000)).toBe(false);
    expect(await mentionsWorkTree(fresh, realGit, t0 + 61_000)).toBe(true);
    expect(await mentionsGitState(path.dirname(fresh))).toBe("not-a-work-tree");
  });
});
