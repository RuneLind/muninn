/** Facts as of a date, against real git repos: nothing written after the moment
 *  reaches them, and a card's label cannot change a byte of them. */

import { beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { readBaselineCards } from "./baseline.ts";
import type { WikiIndex } from "../store.ts";
import { answeredByChoice, commitView, gatherCardFacts, gatherPageFacts, liveAnswers, liveView, logEntriesNaming, readPageText, type GatherContext } from "./facts.ts";
import { parseRepoRoots, realGit, resolveRepo, type GitRun } from "./git.ts";
import { renderBatch } from "./prompt.ts";
import { gatherReplay, messageMoments, replayBatches, replayCounts, replayDigest, ReplayRefused, runReplay, type ReplayDeps } from "./replay.ts";
import { readBaselineLabels } from "./baseline.ts";
import { replayLogPath } from "./log.ts";
import { replayKey, type CardLine, type LogLine } from "./schema.ts";
import { commitAt, git, mergeAt, pushMain, repoWithOrigin, write } from "./test-repo.ts";

const PAGE = (extra = "") => `---
title: Testplan
plan_status: in-flight
repos: [code, nowhere]
---
# Testplan

<NextMoves>
<Lane kind="waiting" who="Eier" since="2026-10-02">
- Svar på O1.
</Lane>
</NextMoves>

<Question id="O1" choices="A|B">
Skal \`needle_token\` og \`src/a.ts\` bort?

**Recommendation: A.** Fordi.
</Question>

<DecisionLog>
- **O1** — Åpent.
- **D1** — Vi valgte ramme. Eier, 01.10.2026.${extra}
</DecisionLog>
`;

let wiki: string;
let codeRoot: string;
let first: string;
let second: string;
let linkWiki: string;
let linkCommit: string;
const CUT = Date.parse("2026-10-05T12:00:00Z");

beforeAll(() => {
  const root = testTempDirSync(path.join(tmpdir(), "triage-facts-"));
  wiki = path.join(root, "wiki");
  codeRoot = path.join(root, "src");
  repoWithOrigin(wiki, path.join(root, "bare"), "wiki");
  write(wiki, "plans/testplan.mdx", PAGE());
  write(wiki, "notes/linker.md", "Se [[testplan]].\n");
  write(wiki, "log.md", "## [2026-10-01] plan | Testplan — [[testplan]]\n\nStart.\n");
  first = commitAt(wiki, "2026-10-01T10:00:00Z", "add the plan");
  write(wiki, "plans/testplan.mdx", PAGE("\n- **D2** — LATER DECISION. Eier, 06.10.2026."));
  write(wiki, "notes/late-linker.md", "Se [[testplan]].\n");
  write(wiki, "log.md", "## [2026-10-06] plan | LATE ENTRY — [[testplan]]\n\n## [2026-10-01] plan | Testplan — [[testplan]]\n\nStart.\n");
  second = commitAt(wiki, "2026-10-06T10:00:00Z", "later");

  const code = path.join(codeRoot, "code");
  repoWithOrigin(code, path.join(root, "bare"), "code");
  write(code, "src/a.ts", `const needle_token = 1;\n${"// x\n".repeat(3)}`);
  commitAt(code, "2026-10-03T10:00:00Z", "code before the moment");
  write(code, "src/late.ts", "const needle_token = 2;\n");
  commitAt(code, "2026-10-07T10:00:00Z", "code after the moment");
  pushMain(code);

  // A feature branch's commit dated before the cut, merged after it.
  const merged = path.join(codeRoot, "merged");
  repoWithOrigin(merged, path.join(root, "bare"), "merged");
  write(merged, "src/main.ts", "const main_token = 1;\n");
  commitAt(merged, "2026-10-03T10:00:00Z", "main before the moment");
  git(merged, "switch", "-q", "-c", "feature");
  write(merged, "src/feature.ts", "const feature_token = 1;\n");
  commitAt(merged, "2026-10-04T10:00:00Z", "feature before the moment");
  git(merged, "switch", "-q", "main");
  mergeAt(merged, "2026-10-06T10:00:00Z", "feature", "merge after the moment");
  pushMain(merged);

  linkWiki = path.join(root, "link-wiki");
  repoWithOrigin(linkWiki, path.join(root, "bare"), "link-wiki");
  write(linkWiki, "plans/teststem.mdx", "# Siden\n\nSe [[teststem]] selv.\n");
  const links: Record<string, string> = {
    "notes/wl-bare.md": "Se [[teststem]].",
    "notes/wl-path.md": "Se [[plans/teststem]].",
    "notes/wl-label.md": "Se [[plans/teststem|merkelapp]].",
    "notes/wl-heading.md": "Se [[plans/teststem#overskrift]].",
    "notes/wl-case.md": "Se [[Plans/TestStem]].",
    "notes/wl-årsak.md": "Se [[teststem]].",
    "plans/md-sibling.md": "Se [her](./teststem.mdx).",
    "archive/md-up.md": "Se [her](../plans/teststem.mdx).",
    "md-root.md": "Se [her](plans/teststem.mdx).",
    "notes/plain.md": "Se plans/teststem.mdx.",
    "notes/no-longer.md": "Se [[teststem-longer]].",
    "notes/no-longer-path.md": "Se [[plans/teststem-longer]].",
    "notes/no-other-page.md": "Se [her](./teststem.mdx).",
    "notes/no-mention.md": "Ordet teststem i prosa.",
    "notes/no-deeper.md": "Se archive/plans/teststem.mdx og plans/teststem.mdx-gammel.",
    "plans/teststem.txt": "[[teststem]]",
  };
  for (const [rel, text] of Object.entries(links)) write(linkWiki, rel, `${text}\n`);
  write(linkWiki, "log.md", "## [2026-10-01] plan | [[plans/teststem]]\n");
  // Mentions sorting ahead of the one link, more of them than the linker cap.
  for (let i = 0; i < 25; i++) write(linkWiki, `aaa/mention-${i}.md`, "Ordet crowded i prosa.\n");
  write(linkWiki, "plans/crowded.mdx", "# Trang\n");
  write(linkWiki, "zzz/late-link.md", "Se [[crowded]].\n");
  // More real links than the cap.
  write(linkWiki, "plans/popular.mdx", "# Populær\n");
  for (let i = 0; i < 25; i++) write(linkWiki, `pop/l${String(i).padStart(2, "0")}.md`, "Se [[popular]].\n");
  linkCommit = commitAt(linkWiki, "2026-10-01T10:00:00Z", "the link forms");
});

const version = (over: Partial<WikiAnswerVersion>): WikiAnswerVersion => ({
  answerId: "a1",
  version: 1,
  wiki: "w",
  relPath: "plans/testplan.mdx",
  questionId: "O1",
  author: { userId: null, oid: null, navIdent: null, name: "Eier" },
  choice: "A",
  body: "",
  questionHash: "h",
  createdAt: CUT - 3_600_000,
  exportedAt: null,
  redactedAt: null,
  ...over,
});

function ctx(answers: WikiAnswerVersion[] = [], git: GitRun = realGit): GatherContext {
  const roots = parseRepoRoots(codeRoot);
  return {
    git,
    repo: (name) => resolveRepo(name, roots, realGit, { fetch: false }),
    answers,
    owner: "Eier (X123456)",
    groups: new Map(),
  };
}

async function asOf(commit: string, cutMs: number, answers: WikiAnswerVersion[] = [], git: GitRun = realGit) {
  const view = commitView(wiki, commit, cutMs, realGit);
  const read = readPageText("plans/testplan.mdx", (await view.readPage("plans/testplan.mdx"))!);
  const gathered = await gatherCardFacts({ wiki: "w", relPath: read.relPath, id: "O1", answeredAt: new Date(cutMs).toISOString(), commit }, read, view, ctx(answers, git));
  return { gathered, page: await gatherPageFacts(read, view) };
}

describe("facts as of a date", () => {
  test("the page, its log, its links and its code stop at the moment", async () => {
    const { gathered, page } = await asOf(first, CUT);
    const text = JSON.stringify({ gathered, page });
    expect(text).not.toContain("LATER DECISION");
    expect(text).not.toContain("LATE ENTRY");
    expect(text).not.toContain("late-linker");
    expect(text).not.toContain("src/late.ts");
    expect(text).not.toContain("code after the moment");
    expect(page.decisionLog.map((d) => d.id)).toEqual(["O1", "D1"]);
    expect(page.linkedFrom.map((l) => l.relPath)).toEqual(["notes/linker.md"]);
    expect(page.linkedFrom[0]!.date).toBe("2026-10-01");
    expect(page.logEntries).toHaveLength(1);
    expect(page.status).toBe("in-flight");
  });

  test("the card carries its facts: body, choices, recommendation, owner, lane, added commit, code", async () => {
    const { gathered } = await asOf(first, CUT);
    const c = gathered.card;
    expect(c.choices).toEqual(["A", "B"]);
    expect(c.recommendation).toBe("A");
    expect(c.owner).toBe("Eier");
    expect(c.ownerAsked).toBe(true);
    expect(c.waitingLanes).toEqual([{ who: "Eier", role: null, since: "2026-10-02" }]);
    expect(c.addedCommit).toMatchObject({ sha: first, subject: "add the plan" });
    const code = c.repos.find((r) => r.repo === "code")!;
    expect(code.ref).toBe("origin/main");
    expect(code.tipDate).toStartWith("2026-10-03");
    expect(code.subjectsSinceCard!.join("\n")).toContain("code before the moment");
    const needle = code.code!.find((x) => x.token === "needle_token")!;
    expect(needle.grep).toHaveLength(1);
    expect(code.code!.find((x) => x.token === "src/a.ts")!.pathLastChanged).toContain("code before the moment");
    expect(c.repos.find((r) => r.repo === "nowhere")).toEqual({ repo: "nowhere", found: false, notFoundBecause: "no such folder under the roots" });
    expect(gathered.codeFacts).toBe(true);
  });

  test("a later commit read later does see the later text", async () => {
    const { page } = await asOf(second, Date.parse("2026-10-08T00:00:00Z"));
    expect(page.decisionLog.map((d) => d.id)).toContain("D2");
    expect(page.linkedFrom.map((l) => l.relPath)).toContain("notes/late-linker.md");
  });

  test("a card naming no token gets commit subjects only", async () => {
    const view = commitView(wiki, first, CUT, realGit);
    const read = readPageText("plans/testplan.mdx", PAGE().replace("`needle_token` og `src/a.ts`", "det"));
    const { card } = await gatherCardFacts({ wiki: "w", relPath: read.relPath, id: "O1", answeredAt: null, commit: first }, read, view, ctx());
    const code = card.repos.find((r) => r.repo === "code")!;
    expect(code.code).toEqual([]);
    expect(code.subjectsSinceCard!.length).toBeGreaterThan(0);
  });
});

describe("the page slot's moment", () => {
  test("a commit's page facts say when that commit was made", async () => {
    const { page } = await asOf(first, CUT);
    expect(page.asOf).toBe("2026-10-01T10:00:00.000Z");
  });
});

describe("the ref's tip then follows the branch, not a merged-in feature", () => {
  const mergedPage = `---\ntitle: T\nrepos: [merged]\n---\n# T\n\n<Question id="O1" choices="A|B">\nSkal \`feature_token\` bort?\n</Question>\n`;
  const read = async (cutMs: number) => {
    const view = commitView(wiki, first, cutMs, realGit);
    const page = readPageText("plans/testplan.mdx", mergedPage);
    const { card } = await gatherCardFacts({ wiki: "w", relPath: page.relPath, id: "O1", answeredAt: new Date(cutMs).toISOString(), commit: first }, page, view, ctx());
    return card.repos[0]!;
  };

  test("a feature commit dated before the cut and merged after it is not there yet", async () => {
    const repo = await read(CUT);
    expect(repo.tipDate).toStartWith("2026-10-03");
    expect(repo.code).toEqual([]);
    expect(repo.subjectsSinceCard!.map((s) => s.replace(/^\S+ \S+ /, ""))).toEqual(["main before the moment"]);
  });

  test("after the merge, the feature's file and its own subject are there", async () => {
    const repo = await read(Date.parse("2026-10-07T00:00:00Z"));
    expect(repo.tipDate).toStartWith("2026-10-06");
    expect(repo.code!.map((c) => c.token)).toEqual(["feature_token"]);
    expect(repo.subjectsSinceCard!.map((s) => s.replace(/^\S+ \S+ /, ""))).toEqual(["merge after the moment", "feature before the moment", "main before the moment"]);
  });
});

describe("a search that failed is not a search that found nothing", () => {
  const TIMED_OUT = { ok: false, stdout: "", stderr: "git grep timed out after 15000 ms", timedOut: true };
  const GIT_ERROR = { ok: false, stdout: "", stderr: "fatal: bad object" };
  /** Real git, except calls `when` picks. */
  const failing = (when: (args: readonly string[]) => boolean, res: Awaited<ReturnType<GitRun>> = GIT_ERROR): GitRun => (cwd, args, opts) => (when(args) ? Promise.resolve(res) : realGit(cwd, args, opts));
  const codeRepo = (g: Awaited<ReturnType<typeof asOf>>["gathered"]) => g.card.repos.find((r) => r.repo === "code")!;

  test("a grep that timed out marks its token", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a[0] === "grep" && a.includes("needle_token"), TIMED_OUT));
    const entry = codeRepo(gathered).code!.find((c) => c.token === "needle_token");
    expect(entry).toEqual({ token: "needle_token", grep: [], searchFailed: "timed out" });
    expect(codeRepo(gathered).code!.find((c) => c.token === "src/a.ts")!.searchFailed).toBeUndefined();
  });

  test("a grep git could not run marks its token apart from a timeout", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a[0] === "grep" && a.includes("needle_token")));
    expect(codeRepo(gathered).code!.find((c) => c.token === "needle_token")).toEqual({ token: "needle_token", grep: [], searchFailed: "git error" });
  });

  test("git's own no-match is exit 1 with nothing on stderr, and marks nothing", async () => {
    const dir = path.join(codeRoot, "code");
    const none = await realGit(dir, ["grep", "-I", "-n", "-F", "-e", "no_such_token_anywhere", "HEAD", "--"]);
    expect(none).toEqual({ ok: false, stdout: "" });
    const { gathered } = await asOf(first, CUT, [], failing((a) => a[0] === "grep" && a.includes("needle_token"), none));
    expect(codeRepo(gathered).code!.some((c) => c.token === "needle_token")).toBe(false);
  });

  test("a failed path read marks the token and keeps its lines", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a[0] === "log" && a[a.length - 1] === "src/a.ts"));
    const entry = codeRepo(gathered).code!.find((c) => c.token === "src/a.ts")!;
    expect(entry.searchFailed).toBe("git error");
    expect(entry.pathLastChanged).toBeUndefined();
  });

  test("a token no path can be fails no search: a URL or a climb out of the repo is only grepped", async () => {
    const root = testTempDirSync(path.join(tmpdir(), "triage-urltoken-"));
    git(root, "init", "-q");
    write(root, "p.mdx", `---\ntitle: T\nrepos: [code]\n---\n\n<Question id="O1" choices="A|B">\nSkal \`/admin/run\` og \`../utenfor.ts\` bort?\n</Question>\n`);
    const sha = commitAt(root, "2026-10-01T10:00:00Z", "the card");
    const view = commitView(root, sha, CUT, realGit);
    const read = readPageText("p.mdx", (await view.readPage("p.mdx"))!);
    const { card } = await gatherCardFacts({ wiki: "w", relPath: "p.mdx", id: "O1", answeredAt: new Date(CUT).toISOString(), commit: sha }, read, view, ctx());
    expect(card.repos[0]!.found).toBe(true);
    expect(card.repos[0]!.code).toEqual([]);
  });

  test("a failed search is no code fact", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a[0] === "grep" || (a[0] === "log" && a[a.length - 1] === "src/a.ts")));
    expect(codeRepo(gathered).code!.every((c) => c.searchFailed === "git error")).toBe(true);
    expect(gathered.codeFacts).toBe(false);
  });

  test("a failed read of the tip then marks the repo, not «none at that time»", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a[0] === "rev-list"));
    const repo = codeRepo(gathered);
    expect(repo.searchFailed).toBe("git error");
    expect(repo.tipDate).not.toBe("none at that time");
    expect(repo.subjectsSinceCard).toBeUndefined();
    expect(repo.code).toBeUndefined();
  });

  test("a failed read of the tip's date marks the repo and keeps the search going", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a[0] === "log" && a.includes("--format=%cI") && !a.includes("--follow")));
    const repo = codeRepo(gathered);
    expect(repo.searchFailed).toBe("git error");
    expect(repo.tipDate).toBeUndefined();
    expect(repo.code!.length).toBeGreaterThan(0);
  });

  test("no commit by then stays «none at that time», with no mark", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a[0] === "rev-list", { ok: true, stdout: "" }));
    const repo = codeRepo(gathered);
    expect(repo.tipDate).toBe("none at that time");
    expect(repo.searchFailed).toBeUndefined();
  });

  test("a failed read of the subjects marks the repo and leaves them absent", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a[0] === "log" && a.some((x) => x.startsWith("--since="))));
    const repo = codeRepo(gathered);
    expect(repo.searchFailed).toBe("git error");
    expect(repo.subjectsSinceCard).toBeUndefined();
    expect(repo.code!.length).toBeGreaterThan(0);
  });

  test("a failed history read of the card reads «lookup failed», not uncommitted", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a.includes("--follow")));
    expect(gathered.card.addedCommit).toBe("lookup failed");
    expect(codeRepo(gathered).subjectsSinceCard).toBeUndefined();
  });

  test("no commit holding the card stays «none», with an empty subject list", async () => {
    const { gathered } = await asOf(first, CUT, [], failing((a) => a.includes("--follow"), { ok: true, stdout: "" }));
    expect(gathered.card.addedCommit).toBe("none");
    expect(codeRepo(gathered).subjectsSinceCard).toEqual([]);
  });

  test("adding an attribute to the tag later does not move the commit that added the card", async () => {
    const root = testTempDirSync(path.join(tmpdir(), "triage-added-"));
    git(root, "init", "-q");
    const card = (tag: string) => `---\ntitle: T\n---\n\n${tag}\nSkal vi?\n</Question>\n`;
    write(root, "p.mdx", card(`<Question id="O1" choices="A|B">`));
    const added = commitAt(root, "2026-10-01T10:00:00Z", "the card");
    write(root, "p.mdx", card(`<Question id="O1" to="Eier" choices="A|B">`));
    const edited = commitAt(root, "2026-10-02T10:00:00Z", "the addressee");
    const view = commitView(root, edited, CUT, realGit);
    const read = readPageText("p.mdx", (await view.readPage("p.mdx"))!);
    const { card: facts } = await gatherCardFacts({ wiki: "w", relPath: "p.mdx", id: "O1", answeredAt: new Date(CUT).toISOString(), commit: edited }, read, view, ctx());
    expect(facts.addedCommit).toMatchObject({ sha: added, subject: "the card" });
  });
});

describe("answers as facts", () => {
  test("every author's latest live answer; redacted rows skipped", () => {
    const rows = [
      version({ answerId: "a1", version: 1, body: "old", createdAt: 1000 }),
      version({ answerId: "a1", version: 2, body: "new", createdAt: 2000 }),
      version({ answerId: "a2", author: { userId: "u2", oid: null, navIdent: null, name: "Fag" }, createdAt: 1500 }),
      version({ answerId: "a3", author: { userId: "u3", oid: null, navIdent: null, name: "Gone" }, createdAt: 1600, redactedAt: 1700, choice: null }),
      version({ answerId: "a9", questionId: "O2", createdAt: 1000 }),
    ];
    const out = liveAnswers(rows, "plans/testplan.mdx", "O1", "h", null);
    expect(out.map((a) => [a.author, a.body])).toEqual([["Fag", ""], ["Eier", "new"]]);
  });

  test("as of a moment: later versions do not exist, and the replayed answer is left out whole", () => {
    const rows = [
      version({ answerId: "early", author: { userId: "u2", oid: null, navIdent: null, name: "Fag" }, createdAt: CUT - 86_400_000 }),
      version({ answerId: "scored", choice: "not-sure", createdAt: CUT - 7 * 60_000 }),
      version({ answerId: "scored", version: 2, choice: "B", createdAt: CUT }),
      version({ answerId: "after", author: { userId: "u3", oid: null, navIdent: null, name: "Sen" }, createdAt: CUT + 60_000 }),
    ];
    expect(liveAnswers(rows, "plans/testplan.mdx", "O1", "h", CUT).map((a) => a.author)).toEqual(["Fag"]);
  });

  test("the ANSWERED test: a choice other than not sure, on unchanged wording", () => {
    const of = (over: Partial<WikiAnswerVersion>) => liveAnswers([version(over)], "plans/testplan.mdx", "O1", "h", null);
    expect(answeredByChoice(of({ choice: "A" }))).toBe(true);
    expect(answeredByChoice(of({ choice: "not-sure" }))).toBe(false);
    expect(answeredByChoice(of({ choice: null, body: "tekst" }))).toBe(false);
    expect(answeredByChoice(of({ choice: "A", questionHash: "other" }))).toBe(false);
    expect(answeredByChoice(of({ choice: "A", redactedAt: 5 }))).toBe(false);
    expect(answeredByChoice([])).toBe(false);
  });
});

test("log entries: the newest naming the page, by wikilink or path, others left out", () => {
  const log = "## [2026-10-01] a | one [[p]]\n\n## [2026-10-03] a | other\n\n## [2026-10-02] a | two plans/p.mdx\n";
  expect(logEntriesNaming(log, "plans/p.mdx").map((e) => e.slice(0, 15))).toEqual(["## [2026-10-02]", "## [2026-10-01]"]);
  expect(logEntriesNaming(null, "plans/p.mdx")).toEqual([]);
});

describe("what names a page in log.md", () => {
  const named = (line: string, relPath = "plans/teststem.mdx") => logEntriesNaming(`## [2026-10-01] a | ${line}\n`, relPath).length === 1;

  test("a bare wikilink", () => expect(named("[[teststem]]")).toBe(true));
  test("a path wikilink", () => expect(named("[[plans/teststem]]")).toBe(true));
  test("a path wikilink with a label", () => expect(named("[[plans/teststem|merkelapp]]")).toBe(true));
  test("a path wikilink with a heading", () => expect(named("[[plans/teststem#overskrift]]")).toBe(true));
  test("a bare wikilink with an extension", () => expect(named("[[teststem.mdx]]")).toBe(true));
  test("a path wikilink with an extension", () => expect(named("[[plans/teststem.mdx]]")).toBe(true));
  test("a path wikilink in other case", () => expect(named("[[Plans/TestStem]]")).toBe(true));
  test("a markdown link from the root", () => expect(named("[her](plans/teststem.mdx)")).toBe(true));
  test("a markdown link with a heading", () => expect(named("[her](plans/teststem.mdx#o1)")).toBe(true));
  test("a dot-slash link beside a root page", () => expect(named("[her](./rootstem.md)", "rootstem.md")).toBe(true));
  test("the plain path", () => expect(named("endret plans/teststem.mdx i dag")).toBe(true));
  test("the plain path ending a sentence", () => expect(named("endret plans/teststem.mdx.")).toBe(true));
  test("the plain path in backticks", () => expect(named("endret `plans/teststem.mdx`")).toBe(true));

  test("the plain path in other case", () => expect(named("endret Plans/TestStem.mdx i dag")).toBe(true));

  test("never a longer stem as a wikilink", () => expect(named("[[teststem-longer]]")).toBe(false));
  test("never a longer stem as a path wikilink", () => expect(named("[[plans/teststem-longer]]")).toBe(false));
  test("never the same stem in another folder by path", () => expect(named("[[archive/teststem]]")).toBe(false));
  test("never a longer path ending in the page's", () => expect(named("endret archive/plans/teststem.mdx")).toBe(false));
  test("never a longer file name starting with the page's", () => expect(named("endret plans/teststem.mdx-gammel")).toBe(false));
  test("never the stem in prose", () => expect(named("teststem i prosa")).toBe(false));
  test("never a dot-slash link from the root to a page elsewhere", () => expect(named("[her](./teststem.mdx)")).toBe(false));
  test("never the path with another extension after it", () => expect(named("![bilde](plans/teststem.mdx.png)")).toBe(false));

  test("the cap keeps the eight newest, newest first, whichever way the log runs", () => {
    const days = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"];
    const up = days.map((d) => `## [2026-10-${d}] a | [[plans/teststem]]`).join("\n\n");
    const down = [...days].reverse().map((d) => `## [2026-10-${d}] a | [[plans/teststem]]`).join("\n\n");
    const expected = ["10", "09", "08", "07", "06", "05", "04", "03"];
    expect(logEntriesNaming(up, "plans/teststem.mdx").map((e) => e.slice(12, 14))).toEqual(expected);
    expect(logEntriesNaming(down, "plans/teststem.mdx").map((e) => e.slice(12, 14))).toEqual(expected);
  });
});

describe("what links a page tonight", () => {
  const index = (backlinks: string[]) => ({ root: "/w", backlinks: new Map([["plans/p.mdx", backlinks]]), resolveRelPath: () => undefined }) as unknown as WikiIndex;

  test("log.md is not a linker, as at a commit: its entries reach the card as logEntries", async () => {
    const view = liveView(index(["log.md", "notes/a.md"]), async () => null);
    expect((await view.linkers("plans/p.mdx")).map((l) => l.relPath)).toEqual(["notes/a.md"]);
  });

  test("a today's view names no moment", async () => {
    expect(await liveView(index([]), async () => null).madeAt()).toBeNull();
  });
});

describe("what links a page at a commit", () => {
  const linkers = async (relPath: string) => (await commitView(linkWiki, linkCommit, CUT, realGit).linkers(relPath)).map((l) => l.relPath);

  test("every link form, and nothing else", async () => {
    expect((await linkers("plans/teststem.mdx")).sort()).toEqual([
      "archive/md-up.md",
      "md-root.md",
      "notes/plain.md",
      "notes/wl-bare.md",
      "notes/wl-case.md",
      "notes/wl-heading.md",
      "notes/wl-label.md",
      "notes/wl-path.md",
      "notes/wl-årsak.md",
      "plans/md-sibling.md",
    ]);
  });

  test("more mentions than the cap do not crowd out the link behind them", async () => {
    expect(await linkers("plans/crowded.mdx")).toEqual(["zzz/late-link.md"]);
  });

  test("real links stop at the cap", async () => {
    const hits = await linkers("plans/popular.mdx");
    expect(hits).toHaveLength(20);
    expect(hits[0]).toBe("pop/l00.md");
  });
});

describe("replay's mechanics, with no score", () => {
  const baseline = (flip: boolean) =>
    JSON.stringify({
      answersUntil: "2026-10-30T00:00:00Z",
      population: { added: 1, other: 2 },
      items: [
        { wiki: "w", relPath: "plans/testplan.mdx", id: "O1", answeredAt: "2026-10-05T12:00:00Z", commit: first, hashMatches: true, replayable: true, stateAtCommit: "open", gapHours: 3, addedSomething: flip, textAlonePredict: flip ? "HUMAN" : "DEFAULT" },
        { wiki: "w", relPath: "plans/gone.mdx", id: "O9", answeredAt: "2026-10-05T12:00:00Z", replayable: false, reason: "first committed later", addedSomething: !flip, textAlonePredict: "DEFAULT" },
      ],
    });
  const deps = (over: Partial<ReplayDeps> = {}): ReplayDeps => ({
    roots: new Map([["w", wiki]]),
    repoRoots: codeRoot,
    git: realGit,
    answers: async () => [],
    owner: "Eier (X123456)",
    groups: new Map(),
    now: Date.now,
    ...over,
  });

  test("flipping every label leaves the facts and the prompt byte-identical", async () => {
    const a = await gatherReplay(readBaselineCards(baseline(false)).cards, deps());
    const b = await gatherReplay(readBaselineCards(baseline(true)).cards, deps());
    expect(a.items).toHaveLength(1);
    const prompt = (g: typeof a) => renderBatch("w", g.items);
    expect(prompt(a)).toBe(prompt(b));
    expect(prompt(a)).not.toContain("addedSomething");
    expect(prompt(a)).not.toContain("textAlonePredict");
  });

  test("a card reaches facts with the seven named fields and nothing else", () => {
    const { cards, unreplayable } = readBaselineCards(baseline(true));
    expect(unreplayable).toBe(1);
    expect(Object.keys(cards[0]!).sort()).toEqual(["answeredAt", "commit", "hashMatches", "id", "relPath", "replayable", "wiki"]);
  });

  test("the dry run's report holds counts and no label", async () => {
    const counts = replayCounts(await gatherReplay(readBaselineCards(baseline(true)).cards, deps()));
    expect(counts).toMatchObject({ gathered: 1, refused: 0, oversized: 0, codeFactCards: 1 });
    expect(JSON.stringify(counts)).not.toMatch(/added|textAlone|HUMAN|plans\//);
    expect(counts.repos.notFound).toEqual([{ repo: "nowhere", reason: "no such folder under the roots" }]);
  });

  test("two moments on one page: two calls, no card on the other moment's page, the later ruling out of the earlier message", async () => {
    const cards = [
      { wiki: "w", relPath: "plans/testplan.mdx", id: "O1", answeredAt: "2026-10-05T12:00:00Z", commit: first, hashMatches: true, replayable: true as const },
      { wiki: "w", relPath: "plans/testplan.mdx", id: "O1", answeredAt: "2026-10-08T12:00:00Z", commit: second, hashMatches: true, replayable: true as const },
    ];
    const gathered = await gatherReplay(cards, deps());
    expect(replayCounts(gathered)).toMatchObject({ gathered: 2, batches: 2, pageSlots: 2, cardsOnAnotherMoment: 0, batchesWithTwoMoments: 0 });
    expect(replayCounts(gathered).totalChars).toBe(replayBatches(gathered.items).reduce((n, b) => n + b.batch.prompt.length, 0));
    const earlier = replayBatches(gathered.items).find((b) => b.batch.items[0]!.gathered.ref.commit === first)!;
    expect(earlier.batch.prompt).not.toContain("LATER DECISION");
    expect(earlier.batch.prompt).not.toContain("LATE ENTRY");
    expect(earlier.batch.prompt).not.toContain("late-linker");
  });

  test("a replay run makes those calls, one per moment, and every card lands", async () => {
    const cards = [
      { wiki: "w", relPath: "plans/testplan.mdx", id: "O1", answeredAt: "2026-10-05T12:00:00Z", commit: first, hashMatches: true, replayable: true as const },
      { wiki: "w", relPath: "plans/testplan.mdx", id: "O1", answeredAt: "2026-10-08T12:00:00Z", commit: second, hashMatches: true, replayable: true as const },
    ];
    const prompts: string[] = [];
    const { lines, usage } = await runReplay(await gatherReplay(cards, deps()), {
      call: async (req) => {
        prompts.push(req.prompt);
        const ids = [...req.prompt.matchAll(/"card": "(c\d+)"/g)].map((m) => m[1]!);
        return { text: JSON.stringify({ verdicts: ids.map((card) => ({ card, verdict: "DEFAULT", costOfDelay: "low", reversible: true, onlyOwnerHas: null, why: "x", evidence: [], restsOnPrs: [] })) }) };
      },
      model: "m",
      existing: [],
      append: async () => {},
      now: Date.now,
      repoRoots: codeRoot,
    });
    expect(usage.calls).toBe(2);
    expect(lines.size).toBe(2);
    expect(prompts.filter((p) => p.includes("LATER DECISION"))).toHaveLength(1);
  });

  test("the count sees a message that puts a card on another moment's page", () => {
    const pageFacts = (asOf: string, text: string) => ({ relPath: "plans/p.mdx", asOf, status: null, decisionLog: [{ id: "D1", state: "open", struck: false, text }], linkedFrom: [], logEntries: [], prReferences: [] });
    const card = (commit: string, page: ReturnType<typeof pageFacts>) => ({ gathered: { ref: { wiki: "w", relPath: "plans/p.mdx", id: "O1", answeredAt: "2026-10-02T09:00:00Z", commit }, questionHash: "h", recommendation: null, card: { relPath: "plans/p.mdx", id: "O1" } as never, codeFacts: false }, page });
    const a = card("aaaaaaa", pageFacts("2026-10-01T00:00:00.000Z", "one"));
    const b = card("bbbbbbb", pageFacts("2026-10-06T00:00:00.000Z", "two"));
    // The old message's shape: both cards pointing at the first page's slot.
    const prompt = `x\n\n${JSON.stringify({ pages: [{ page: "p1", ...a.page }], cards: [{ card: "c1", page: "p1" }, { card: "c2", page: "p1" }] })}`;
    expect(messageMoments({ items: [a, b], prompt })).toEqual({ pageSlots: 1, cardsOnAnotherMoment: 1, twoMoments: true });
    expect(messageMoments({ items: [a], prompt: `x\n\n${JSON.stringify({ pages: [{ page: "p1", ...a.page }], cards: [{ card: "c1", page: "p1" }] })}` })).toEqual({ pageSlots: 1, cardsOnAnotherMoment: 0, twoMoments: false });
  });

  describe("a kept verdict is one for this very message", () => {
    const CARD = { wiki: "w", relPath: "plans/testplan.mdx", id: "O1", answeredAt: "2026-10-05T12:00:00Z", commit: "", hashMatches: true, replayable: true as const };
    const earlier = version({ answerId: "early", author: { userId: "u2", oid: null, navIdent: null, name: "Fag" }, body: "tidligere", createdAt: CUT - 86_400_000 });
    function replay(existing: readonly CardLine[]) {
      let calls = 0;
      const appended: LogLine[] = [];
      return {
        run: (g: Awaited<ReturnType<typeof gatherReplay>>) =>
          runReplay(g, {
            call: async (req) => {
              calls++;
              const ids = [...req.prompt.matchAll(/"card": "(c\d+)"/g)].map((m) => m[1]!);
              return { text: JSON.stringify({ verdicts: ids.map((card) => ({ card, verdict: "ASK_OWNER", costOfDelay: "low", reversible: true, onlyOwnerHas: "x", why: "fresh", evidence: [], restsOnPrs: [] })) }) };
            },
            model: "m",
            existing,
            append: async (l) => void appended.push(...l),
            now: Date.now,
            repoRoots: codeRoot,
          }),
        calls: () => calls,
        cardLines: () => appended.filter((l): l is CardLine => l.type === "card"),
      };
    }
    const once = async (answers: WikiAnswerVersion[] = []) => {
      const gathered = await gatherReplay([{ ...CARD, commit: first }], deps({ answers: async () => answers }));
      const r = replay([]);
      await r.run(gathered);
      return { gathered, lines: r.cardLines() };
    };

    test("a line from another wiki, on stale wording, is not kept", async () => {
      const { gathered, lines } = await once();
      const stale: CardLine = { ...lines[0]!, wiki: "OTHER", questionHash: "stale-hash", verdict: "DEFAULT" };
      const r = replay([stale]);
      const out = await r.run(gathered);
      expect(r.calls()).toBe(1);
      expect(out.lines.get(replayKey(gathered.items[0]!.gathered.ref))!.verdict).toBe("ASK_OWNER");
    });

    test("a line with no digest is not kept", async () => {
      const { gathered, lines } = await once();
      const { messageDigest: _gone, ...bare } = lines[0]!;
      const r = replay([bare as CardLine]);
      await r.run(gathered);
      expect(r.calls()).toBe(1);
    });

    test("the same message keeps its verdict with no call, and says so", async () => {
      const { lines } = await once();
      const again = await gatherReplay([{ ...CARD, commit: first }], deps());
      const r = replay([{ ...lines[0]!, verdict: "VOID" }]);
      const out = await r.run(again);
      expect(r.calls()).toBe(0);
      expect(out.kept).toBe(1);
      expect(out.rejudged).toBe(0);
      expect(out.lines.get(replayKey(again.items[0]!.gathered.ref))!.verdict).toBe("VOID");
    });

    test("facts that moved re-judge the card, and say so", async () => {
      const { lines } = await once();
      const moved = await gatherReplay([{ ...CARD, commit: first }], deps({ answers: async () => [earlier] }));
      const r = replay([{ ...lines[0]!, verdict: "VOID" }]);
      const out = await r.run(moved);
      expect(r.calls()).toBe(1);
      expect(out.kept).toBe(0);
      expect(out.rejudged).toBe(1);
      expect(out.lines.get(replayKey(moved.items[0]!.gathered.ref))!.verdict).toBe("ASK_OWNER");
      expect(r.cardLines()[0]!.messageDigest).toBe(replayDigest(moved.items[0]!));
    });

    test("a card gathered with no matching line is new, not re-judged", async () => {
      const gathered = await gatherReplay([{ ...CARD, commit: first }], deps());
      const out = await replay([]).run(gathered);
      expect(out.kept).toBe(0);
      expect(out.rejudged).toBe(0);
    });

    test("the key holds the wiki: one path in two wikis is two cards", async () => {
      const gathered = await gatherReplay([{ ...CARD, commit: first }, { ...CARD, wiki: "v", commit: first }], deps({ roots: new Map([["w", wiki], ["v", wiki]]) }));
      expect(gathered.items).toHaveLength(2);
      const r = replay([]);
      const out = await r.run(gathered);
      expect(out.lines.size).toBe(2);
      expect(r.cardLines().map((l) => l.wiki).sort()).toEqual(["v", "w"]);
    });

    test("a verdict on a card this run did not gather is not handed back", async () => {
      const { lines } = await once();
      const none = await gatherReplay([], deps());
      const out = await replay(lines).run(none);
      expect(out.lines.size).toBe(0);
    });

    test("a card left with no verdict is asked again, on the same message", async () => {
      const { gathered, lines } = await once();
      const r = replay([{ ...lines[0]!, verdict: "NO_VERDICT" }]);
      const out = await r.run(gathered);
      expect(r.calls()).toBe(1);
      expect(out.kept).toBe(0);
      expect(out.rejudged).toBe(0);
      expect(out.lines.get(replayKey(gathered.items[0]!.gathered.ref))!.verdict).toBe("ASK_OWNER");
    });

    test("a line with no digest on a card not gathered is not handed back either", async () => {
      const { lines } = await once();
      const { messageDigest: _gone, ...bare } = lines[0]!;
      const out = await replay([bare as CardLine]).run(await gatherReplay([], deps()));
      expect(out.lines.size).toBe(0);
    });

    test("the digest moves with the prompt version, the card and the page; a new version is a new file", async () => {
      const { gathered } = await once();
      const item = gathered.items[0]!;
      expect(replayDigest(item, "a")).not.toBe(replayDigest(item, "b"));
      expect(replayDigest(item)).toBe(replayDigest(item));
      expect(replayDigest({ ...item, gathered: { ...item.gathered, card: { ...item.gathered.card, body: "annet" } } })).not.toBe(replayDigest(item));
      expect(replayDigest({ ...item, page: { ...item.page, status: "annet" } })).not.toBe(replayDigest(item));
      expect(replayDigest({ ...item, gathered: { ...item.gathered, ref: { ...item.gathered.ref, wiki: "annen" } } })).not.toBe(replayDigest(item));
      expect(replayLogPath("a", "/d")).not.toBe(replayLogPath("b", "/d"));
    });

    test("the scorer finds a card's label by the same key", () => {
      const text = baseline(true);
      const { cards } = readBaselineCards(text);
      expect(readBaselineLabels(text).labels.get(replayKey(cards[0]!))).toMatchObject({ added: true });
    });
  });

  test("a commit this repo does not hold is refused as that, alone or wholesale", async () => {
    const { cards } = readBaselineCards(baseline(false));
    const lost = { ...cards[0]!, commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", answeredAt: "2026-10-05T12:30:00Z" };
    const some = await gatherReplay([lost, cards[0]!], deps());
    expect(some.items).toHaveLength(1);
    expect(some.refused.map((r) => r.reason)).toEqual(["the commit is not in this repo"]);
    await expect(gatherReplay([lost], deps())).rejects.toThrow("none of w's 1 commit(s) are in");
    await expect(gatherReplay([lost], deps())).rejects.toBeInstanceOf(ReplayRefused);
  });

  test("a card missing from its commit is refused alone; a commit id that is not one too", async () => {
    const { cards } = readBaselineCards(baseline(false));
    const gathered = await gatherReplay([{ ...cards[0]!, id: "O7" }, { ...cards[0]!, commit: "--bad" }, cards[0]!], deps());
    expect(gathered.items).toHaveLength(1);
    expect(gathered.refused.map((r) => r.reason)).toEqual(["the card is not on the page at that commit", "not a commit id: --bad"]);
  });

  test("a setup fault refuses: no variable, a missing root, no repo resolving", async () => {
    const { cards } = readBaselineCards(baseline(false));
    await expect(gatherReplay(cards, deps({ repoRoots: null }))).rejects.toBeInstanceOf(ReplayRefused);
    await expect(gatherReplay(cards, deps({ roots: new Map() }))).rejects.toThrow("no root for w");
    await expect(gatherReplay(cards, deps({ roots: new Map([["w", "/nonexistent/wiki"]]) }))).rejects.toThrow("is missing");
    await expect(gatherReplay(cards, deps({ repoRoots: "/nonexistent/roots" }))).rejects.toThrow("none of w's repos resolve");
  });
});
