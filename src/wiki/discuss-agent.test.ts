/**
 * The wiki agent's pure half (`discuss-agent.ts`): the rules-file loader, the
 * repos a page asks for and the ones in reach, the turn prompt, the card's
 * paths and the proposed edit read from an answer. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDir } from "../test/temp-dir.ts";
import type { GitRun } from "./decision-triage/git.ts";
import { parseRepoRoots } from "./decision-triage/git.ts";
import { buildContextPack } from "./discuss-pack.ts";
import {
  NOT_IN_REACH,
  WIKI_AGENT_RULES_FILE,
  WIKI_AGENT_RULES_MAX_BYTES,
  cardForSnapshot,
  extractProposedEdit,
  pageReposAsked,
  readWikiAgentRules,
  renderAgentSystemPrompt,
  renderAgentTurnPrompt,
  reposInReach,
  rulesForMode,
  stripProposedEdit,
  wikiThreadName,
  STORED_EDIT_MARKER,
} from "./discuss-agent.ts";
import { parseDiscussBody } from "./discuss-engine.ts";
import { parseDiscussReaderConfig } from "./store.ts";

let dir = "";

beforeAll(async () => {
  dir = await realpath(await testTempDir(path.join(tmpdir(), "muninn-discuss-agent-unit-")));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readWikiAgentRules", () => {
  test("absent, empty, present, over the bound, a symlink", async () => {
    const w = path.join(dir, "rules");
    await mkdir(w, { recursive: true });
    expect(await readWikiAgentRules(w)).toEqual({ state: "absent" });
    await writeFile(path.join(w, WIKI_AGENT_RULES_FILE), "  \n");
    expect(await readWikiAgentRules(w)).toEqual({ state: "absent" });
    await writeFile(path.join(w, WIKI_AGENT_RULES_FILE), "# Rules\n\nBe brief.\n");
    expect(await readWikiAgentRules(w)).toMatchObject({ state: "ok", text: "# Rules\n\nBe brief." });
    await writeFile(path.join(w, WIKI_AGENT_RULES_FILE), "x".repeat(WIKI_AGENT_RULES_MAX_BYTES + 1));
    expect(await readWikiAgentRules(w)).toEqual({ state: "too-large", bytes: WIKI_AGENT_RULES_MAX_BYTES + 1 });
    const l = path.join(dir, "linked");
    await mkdir(l, { recursive: true });
    await writeFile(path.join(dir, "elsewhere.md"), "Be brief.");
    await symlink(path.join(dir, "elsewhere.md"), path.join(l, WIKI_AGENT_RULES_FILE));
    expect(await readWikiAgentRules(l)).toEqual({ state: "not-a-file" });
  });
});

describe("parseDiscussReaderConfig repos", () => {
  test("a list of repo names is kept; a bad entry is dropped with a warning; a non-list puts none in reach", () => {
    expect(parseDiscussReaderConfig({ handoff: true, repos: ["alpha", "beta"] })).toEqual({ handoff: true, repos: ["alpha", "beta"] });
    const bad = parseDiscussReaderConfig({ repos: ["alpha", "../x", 3] });
    expect(bad.repos).toEqual(["alpha"]);
    expect(bad.warning).toBeDefined();
    const notList = parseDiscussReaderConfig({ handoff: true, repos: "alpha" });
    expect(notList.repos).toBeUndefined();
    expect(notList.handoff).toBe(true);
    expect(notList.warning).toBeDefined();
  });
});

describe("pageReposAsked", () => {
  test("repos: wins, then the listing's project, else none", () => {
    expect(pageReposAsked({ repos: ["alpha", "beta"] }, "gamma")).toEqual(["alpha", "beta"]);
    expect(pageReposAsked({ repos: "alpha" }, "gamma")).toEqual(["alpha"]);
    expect(pageReposAsked({}, "gamma")).toEqual(["gamma"]);
    expect(pageReposAsked({}, undefined)).toEqual([]);
  });
});

describe("reposInReach", () => {
  const git: GitRun = async (cwd, args) => {
    const real = await realpath(cwd).catch(() => cwd);
    if (args[1] === "--show-toplevel") return { ok: true, stdout: real, stderr: "", timedOut: false, capped: false } as never;
    if (args[0] === "remote") return { ok: true, stdout: `https://example.com/org/${path.basename(real)}.git`, stderr: "", timedOut: false, capped: false } as never;
    return { ok: false, stdout: "", stderr: "", timedOut: false, capped: false } as never;
  };
  test("only a listed name with a checkout is in reach; the wiki's own repo is apart; no list means none", async () => {
    const roots = path.join(dir, "src");
    for (const r of ["alpha", "navrepo", "wiki"]) await mkdir(path.join(roots, r), { recursive: true });
    const wikiRoot = path.join(roots, "wiki");
    const asked = ["alpha", "navrepo", "wiki", "ghost"];
    const reach = await reposInReach({ asked, allow: ["alpha", "ghost"], roots: parseRepoRoots(roots), wikiRoot, git });
    expect(reach.inReach).toEqual([{ name: "alpha", dir: path.join(roots, "alpha") }]);
    expect(reach.own).toEqual(["wiki"]);
    expect(reach.missed.map((m) => m.name)).toEqual(["navrepo", "ghost"]);
    expect(reach.missed[0]!.why).toBe(NOT_IN_REACH);
    expect(reach.missed[1]!.why.startsWith(NOT_IN_REACH)).toBe(true);
    const none = await reposInReach({ asked, allow: null, roots: parseRepoRoots(roots), wikiRoot, git });
    expect(none.inReach).toEqual([]);
    expect(none.missed.map((m) => m.name)).toEqual(["alpha", "navrepo", "ghost"]);
  });
});

describe("the prompt", () => {
  const raw = "---\ntitle: T\n---\n\n# T\n\n## A\n\nOne line.\n";
  const pack = buildContextPack({ wiki: "w", relPath: "p.md", title: "T", absPath: "/snap/w/p.md", raw });
  test("no repo in reach is said in so many words, with every repo the page asked for", () => {
    const p = renderAgentTurnPrompt({ pack, reach: { kind: "readSearch", wikiSnapshot: "/snap/w", repos: [], missed: [{ name: "navrepo", why: NOT_IN_REACH }], own: [] }, card: null, earlier: [], question: "Q?" });
    expect(p).toContain("No repo in reach");
    expect(p).toContain(`- navrepo: ${NOT_IN_REACH}`);
    expect(p).toContain("## The question is about the whole page");
    expect(p).toContain("9: One line.");
    expect(p.endsWith("## Question\nQ?")).toBe(true);
  });
  test("the system prompt carries the rules and no persona, and frames a thread", () => {
    const s = renderAgentSystemPrompt("w", "Be brief.");
    expect(s).toContain("<wiki_rules>\nBe brief.\n</wiki_rules>");
    expect(s).toContain("in a thread");
    expect(s).toContain("The context pack describes this turn");
    expect(s).not.toContain("one turn at a time");
  });
  test("earlier turns are bounded to the newest few", () => {
    const earlier = Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, selection: null, answer: `a${i}`, endState: "done" }));
    const p = renderAgentTurnPrompt({ pack, reach: { kind: "mcpTools", tools: { k: ["s"] } }, card: null, earlier, question: "Q?" });
    expect(p).toContain("(3 earlier turns left out)");
    expect(p).not.toContain("Question: q2");
    expect(p).toContain("Question: q3");
  });
});

describe("cardForSnapshot", () => {
  test("the live root becomes the snapshot's, and nothing else moves", () => {
    expect(cardForSnapshot("path: /w/live/plans/a.mdx\nother /w/livestock", "/w/live", "/snap/x")).toBe("path: /snap/x/plans/a.mdx\nother /w/livestock");
  });
});

describe("extractProposedEdit", () => {
  const block = (o: unknown) => "Answer.\n\n```json\n" + JSON.stringify(o) + "\n```\n";
  test("the fenced edit list parseEditList reads", () => {
    const e = extractProposedEdit(block({ edits: [{ claimIndex: 1, verdict: "❌", old: "six", new: "seven", reason: "r" }] }));
    expect(e?.edits).toEqual([{ claimIndex: 1, verdict: "❌", old: "six", new: "seven", reason: "r" }]);
    expect(e?.overLimit).toBe(false);
  });
  test("none, an empty new (dropped, never a deletion), more than one edit", () => {
    expect(extractProposedEdit("No edit here. [[a page]] and {braces}.")).toBeNull();
    const empty = extractProposedEdit(block({ edits: [{ old: "six", new: "" }] }));
    expect(empty?.edits).toEqual([]);
    expect(empty?.dropped).toHaveLength(1);
    const two = extractProposedEdit(block({ edits: [{ old: "a", new: "b" }, { old: "c", new: "d" }] }));
    expect(two?.overLimit).toBe(true);
  });
});

describe("extractProposedEdit: the fences an answer really has", () => {
  const EDIT = '{"edits":[{"claimIndex":1,"verdict":"❌","old":"opens at six","new":"opens at seven","reason":"harbour.ts:3"}]}';
  const found = (answer: string) => extractProposedEdit(answer)?.edits.map((e) => e.new);
  const cited = "Code:\n\n```ts\nconst opens = 7;\n```\n\nThe edit:\n\n";
  test("a cited ```ts block before the ```json edits block", () => {
    expect(found(`${cited}\`\`\`json\n${EDIT}\n\`\`\``)).toEqual(["opens at seven"]);
  });
  test("the same with the Read: and Not checked: lines after it", () => {
    expect(found(`${cited}\`\`\`json\n${EDIT}\n\`\`\`\n\nRead: alpha/src/harbour.ts\nNot checked: nothing`)).toEqual(["opens at seven"]);
  });
  test("a ```JSON label, a ```jsonc label and a ~~~json fence", () => {
    expect(found(`${cited}\`\`\`JSON\n${EDIT}\n\`\`\``)).toEqual(["opens at seven"]);
    expect(found(`${cited}\`\`\`jsonc\n${EDIT}\n\`\`\``)).toEqual(["opens at seven"]);
    expect(found(`${cited}~~~json\n${EDIT}\n~~~\n`)).toEqual(["opens at seven"]);
  });
  test("CRLF line endings", () => {
    expect(found(`${cited}\`\`\`json\n${EDIT}\n\`\`\`\n\nRead: x`.replace(/\n/g, "\r\n"))).toEqual(["opens at seven"]);
  });
  test("a longer fence holding a ``` line closes only on a fence at least as long; two edits keep overLimit", () => {
    const two = '{"edits":[{"old":"a","new":"b"},{"old":"c","new":"d"}]}';
    // A ``` line inside the 4-backtick block: shorter than the opener, it does not close it.
    const e = extractProposedEdit(`${cited}\`\`\`\`json\n\`\`\`\n${two}\n\`\`\`\`\n`);
    expect(e?.edits.map((x) => x.new)).toEqual(["b", "d"]);
    expect(e?.overLimit).toBe(true);
  });
});

describe("Discuss v2: the stored answer, the thread name and the body", () => {
  test("the stored answer replaces the block extractProposedEdit reads with the marker line; an answer with none is unchanged", () => {
    const answer = 'Wrong.\n\n```json\n{"edits": [{"old": "a", "new": "b"}]}\n```\n\nRead: x';
    expect(extractProposedEdit(answer)).not.toBeNull();
    expect(stripProposedEdit(answer)).toBe(`Wrong.\n\n${STORED_EDIT_MARKER}\n\nRead: x`);
    const plain = "Fine.\n\n```ts\nconst a = 1;\n```";
    expect(stripProposedEdit(plain)).toBe(plain);
  });
  test("the thread name: `wiki: <title>` lowercased, cut to 50 units with its suffix, never splitting a pair", () => {
    expect(wikiThreadName("Ferry   Timetable", "")).toBe("wiki: ferry timetable");
    expect(wikiThreadName("x".repeat(60), " #ab12")).toBe(`wiki: ${"x".repeat(38)} #ab12`);
    expect(wikiThreadName("😀".repeat(30), "").length).toBeLessThanOrEqual(50);
  });
  test("parseDiscussBody reads mode and userId and refuses a bad one", () => {
    const base = { relPath: "a.md", question: "q" };
    expect(parseDiscussBody({ ...base, mode: "edit", userId: "kari" })).toMatchObject({ mode: "edit", userId: "kari" });
    expect(parseDiscussBody({ ...base, mode: "write" })).toBeString();
    expect(parseDiscussBody({ ...base, userId: "" })).toBeString();
    expect(parseDiscussBody({ ...base, userId: 7 })).toBeString();
  });
});

describe("rulesForMode: a plain line scan for start/end marker pairs (D8)", () => {
  const S = "<!-- discuss:edit -->";
  const E = "<!-- /discuss:edit -->";
  const lines = (...ls: string[]) => ls.join("\n");
  /** Both modes plus the warnings each call made. */
  const run = (rules: string) => {
    const exploreWarns: string[] = [];
    const editWarns: string[] = [];
    const explore = rulesForMode(rules, "explore", (m) => exploreWarns.push(m));
    const edit = rulesForMode(rules, "edit", (m) => editWarns.push(m));
    return { explore, edit, exploreWarns, editWarns };
  };

  test("the exported markers are the start and end lines", async () => {
    const mod = await import("./discuss-agent.ts");
    expect((mod as Record<string, unknown>).DISCUSS_EDIT_START_MARKER).toBe(S);
    expect((mod as Record<string, unknown>).DISCUSS_EDIT_END_MARKER).toBe(E);
  });

  test("no marker line: the text comes back unchanged in both modes, CRLF included, with no warning", () => {
    for (const plain of ["# A\n\n## Changing the page\n- edits\n", "a\r\nb\r\n", "", "\n"]) {
      const r = run(plain);
      expect(r.explore).toBe(plain);
      expect(r.edit).toBe(plain);
      expect(r.exploreWarns).toEqual([]);
      expect(r.editWarns).toEqual([]);
    }
  });

  test("one pair: Explore drops the start line through the end line; Edit drops only the two marker lines", () => {
    const rules = lines("# Agent", "", "## Answering", "- First.", "", S, "## Changing the page", "- One edit.", E, "", "## Language", "- Reply.");
    const r = run(rules);
    expect(r.explore).toBe(lines("# Agent", "", "## Answering", "- First.", "", "", "## Language", "- Reply."));
    expect(r.edit).toBe(lines("# Agent", "", "## Answering", "- First.", "", "## Changing the page", "- One edit.", "", "## Language", "- Reply."));
    expect(r.exploreWarns).toEqual([]);
    expect(r.editWarns).toEqual([]);
  });

  test("two pairs: each is dropped in Explore, and only the four marker lines in Edit", () => {
    const r = run(lines("a", S, "e1", E, "b", S, "e2", "e2b", E, "c"));
    expect(r.explore).toBe(lines("a", "b", "c"));
    expect(r.edit).toBe(lines("a", "e1", "b", "e2", "e2b", "c"));
    expect(r.exploreWarns.length + r.editWarns.length).toBe(0);
  });

  test("a pair's content is opaque: headings, fences, a thematic break and Setext lines go with it", () => {
    const body = ["## Edit", "```md", "## inner", "```", "---", "Setext", "===", "> quote", "    indented"];
    const r = run(lines("# T", S, ...body, E, "## B", "b"));
    expect(r.explore).toBe(lines("# T", "## B", "b"));
    expect(r.edit).toBe(lines("# T", ...body, "## B", "b"));
  });

  test("no markdown awareness: a marker line inside a code fence is still a marker", () => {
    const r = run(lines("a", "```", S, "```", "x", E, "b"));
    expect(r.explore).toBe(lines("a", "```", "b"));
    expect(r.edit).toBe(lines("a", "```", "```", "x", "b"));
  });

  test("frontmatter and a paragraph with --- above a start marker stay in Explore", () => {
    const top = ["---", "title: Rules", "---", "# Title", "Intro paragraph", "---"];
    const r = run(lines(...top, S, "## Changing the page", "edit rule", E, "## After", "after"));
    expect(r.explore).toBe(lines(...top, "## After", "after"));
    expect(r.edit).toBe(lines(...top, "## Changing the page", "edit rule", "## After", "after"));
  });

  test("leading and trailing whitespace around a marker is trimmed, so an indented marker under a paragraph counts", () => {
    const r = run(lines("para", `    ${S}`, "x", `\t${E} \t`, "y", `  ${S}  `, "z", ` ${E}`));
    expect(r.explore).toBe(lines("para", "y"));
    expect(r.edit).toBe(lines("para", "x", "y", "z"));
    expect(r.exploreWarns.length + r.editWarns.length).toBe(0);
  });

  test("a line that only contains a marker among other text is not a marker", () => {
    for (const near of [`${S} x`, `x ${E}`, "<!--discuss:edit-->", "<!-- DISCUSS:EDIT -->", `> ${S}`, `- ${S}`, "<!-- discuss:edit  -->"]) {
      const rules = lines("a", near, "b");
      const r = run(rules);
      expect(r.explore).toBe(rules);
      expect(r.edit).toBe(rules);
      expect(r.exploreWarns.length + r.editWarns.length).toBe(0);
    }
  });

  test("CRLF and lone-CR input is normalised to \\n before the scan", () => {
    const crlf = run(["a", S, "x", E, "b", ""].join("\r\n"));
    expect(crlf.explore).toBe("a\nb\n");
    expect(crlf.edit).toBe("a\nx\nb\n");
    const cr = run(["a", S, "x", E, "b"].join("\r"));
    expect(cr.explore).toBe("a\nb");
    expect(cr.edit).toBe("a\nx\nb");
  });

  test("trailing newline: a file ending in \\n gives back text ending in \\n, also when the end marker is its last line", () => {
    expect(run("a\n" + S + "\nx\n" + E + "\nb\n")).toMatchObject({ explore: "a\nb\n", edit: "a\nx\nb\n" });
    expect(run("a\n" + S + "\nx\n" + E + "\n")).toMatchObject({ explore: "a\n", edit: "a\nx\n" });
    expect(run("a\n" + S + "\nx\n" + E)).toMatchObject({ explore: "a", edit: "a\nx" });
    expect(run(S + "\n" + E)).toMatchObject({ explore: "", edit: "" });
  });

  // Each: [name, rules, the 1-based lines the warning names]. The line-1 starts
  // pin the open-pair sentinel against index 0 (review of dce19ccc).
  const MALFORMED: [string, string, number[]][] = [
    ["a start with no end", lines("a", S, "x", "b"), [2]],
    ["an end with no start", lines("a", "x", E, "b"), [3]],
    ["a start inside an open pair", lines("a", S, "x", S, "y", E, "b"), [4, 2]],
    ["an end after an end", lines("a", S, "x", E, "y", E, "b"), [6]],
    ["a good pair followed by a start with no end", lines(S, "x", E, "a", S, "b"), [5]],
    ["several faults in one file still warn once", lines(E, E, S, S), [1]],
    ["a start on line 1 with no end", lines(S, "secret", "b"), [1]],
    ["a start inside a pair opened on line 1", lines(S, "leak", S, "y", E), [3, 1]],
  ];
  for (const [name, rules, named] of MALFORMED) {
    test(`malformed, ${name}: the whole text unchanged in both modes, one warning per call naming line ${named.join(" and ")}`, () => {
      const r = run(rules);
      expect(r.explore).toBe(rules);
      expect(r.edit).toBe(rules);
      expect(r.exploreWarns.length).toBe(1);
      expect(r.editWarns.length).toBe(1);
      for (const line of named) expect(r.exploreWarns[0]).toContain(`line ${line} `);
      expect(r.editWarns[0]).toBe(r.exploreWarns[0]!);
    });
  }

  test("malformed CRLF input comes back exactly as given, \\r\\n included", () => {
    const rules = ["a", S, "x"].join("\r\n");
    const r = run(rules);
    expect(r.explore).toBe(rules);
    expect(r.edit).toBe(rules);
    expect(r.exploreWarns.length).toBe(1);
  });

  test("a malformed file with no warn callback does not throw", () => {
    expect(rulesForMode(lines("a", S), "explore")).toBe(lines("a", S));
    expect(rulesForMode(lines(E, "a"), "edit")).toBe(lines(E, "a"));
  });

  test("performance: 16 KiB of short Setext-like lines, 10k `>` lines and one 10k-deep `>` line scan well under 100 ms", () => {
    const setext = "a\n=\n-\n".repeat(Math.ceil((16 * 1024) / 6));
    const quotes = Array.from({ length: 10_000 }, (_, i) => ">".repeat(1 + (i % 50))).join("\n");
    const deep = ">".repeat(10_000);
    const big = [setext, quotes, deep, S, "edit only", E, "tail"].join("\n");
    const plain = [setext, quotes, deep, "tail"].join("\n");
    const t0 = performance.now();
    const explore = rulesForMode(big, "explore");
    const edit = rulesForMode(big, "edit");
    const unmarked = rulesForMode(plain, "explore");
    const ms = performance.now() - t0;
    expect(explore).toBe(plain);
    expect(edit).toBe([setext, quotes, deep, "edit only", "tail"].join("\n"));
    expect(unmarked).toBe(plain);
    expect(ms).toBeLessThan(100);
  });
});
