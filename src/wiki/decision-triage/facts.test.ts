/** Facts as of a date, against real git repos: nothing written after the moment
 *  reaches them, and a card's label cannot change a byte of them. */

import { beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { readBaselineCards } from "./baseline.ts";
import { answeredByChoice, commitView, gatherCardFacts, gatherPageFacts, liveAnswers, logEntriesNaming, readPageText, type GatherContext } from "./facts.ts";
import { parseRepoRoots, realGit, resolveRepo } from "./git.ts";
import { renderBatch } from "./prompt.ts";
import { gatherReplay, replayCounts, ReplayRefused, type ReplayDeps } from "./replay.ts";
import { commitAt, pushMain, repoWithOrigin, write } from "./test-repo.ts";

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

function ctx(answers: WikiAnswerVersion[] = []): GatherContext {
  const roots = parseRepoRoots(codeRoot);
  return {
    git: realGit,
    repo: (name) => resolveRepo(name, roots, realGit, { fetch: false }),
    answers,
    owner: "Eier (X123456)",
    groups: new Map(),
  };
}

async function asOf(commit: string, cutMs: number, answers: WikiAnswerVersion[] = []) {
  const view = commitView(wiki, commit, cutMs, realGit);
  const read = readPageText("plans/testplan.mdx", (await view.readPage("plans/testplan.mdx"))!);
  const gathered = await gatherCardFacts({ wiki: "w", relPath: read.relPath, id: "O1", answeredAt: new Date(cutMs).toISOString(), commit }, read, view, ctx(answers));
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
