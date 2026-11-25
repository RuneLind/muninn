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

describe("Discuss v2: modes, the stored answer, the thread name and the body", () => {
  const RULES = [
    "# Agent",
    "",
    "## Answering",
    "- First sentence answers.",
    "",
    "## Changing the page",
    "<!-- discuss:edit -->",
    "- One edit per turn.",
    "### Shape",
    "```md",
    "## not a heading inside a fence",
    "```",
    "",
    "## Language",
    "- Reply in kind.",
  ].join("\n");
  test("the marked section (to the next heading of its level, fences skipped) goes only to Edit; the marker line never", () => {
    const explore = rulesForMode(RULES, "explore");
    expect(explore).not.toContain("Changing the page");
    expect(explore).not.toContain("One edit per turn");
    expect(explore).not.toContain("not a heading inside a fence");
    expect(explore).toContain("## Answering");
    expect(explore).toContain("## Language\n- Reply in kind.");
    const edit = rulesForMode(RULES, "edit");
    expect(edit).toContain("## Changing the page\n- One edit per turn.");
    expect(edit).toContain("## not a heading inside a fence");
    expect(edit).not.toContain("<!-- discuss:edit -->");
  });
  test("every marked section goes only to Edit, and no marker line reaches either mode", () => {
    const two = "# T\n## A\na\n## E1\n<!-- discuss:edit -->\ne1\n## B\nb\n## E2\n<!-- discuss:edit -->\ne2";
    const explore = rulesForMode(two, "explore");
    expect(explore).toBe("# T\n## A\na\n## B\nb");
    const edit = rulesForMode(two, "edit");
    expect(edit).toBe("# T\n## A\na\n## E1\ne1\n## B\nb\n## E2\ne2");
  });
  test("a marker under the document's single H1 marks nothing: the file goes whole (marker dropped) and a warning is logged", () => {
    const warned: string[] = [];
    const h1 = "# Title\n<!-- discuss:edit -->\n## A\na\n## B\nb";
    expect(rulesForMode(h1, "explore", (m) => warned.push(m))).toBe("# Title\n## A\na\n## B\nb");
    expect(rulesForMode(h1, "edit")).toBe("# Title\n## A\na\n## B\nb");
    expect(warned.length).toBe(1);
  });
  test("a closing fence takes no info string, so a ```js line inside a fence does not end it", () => {
    const fenced = "# T\n## A\n```md\nx\n```js\ny\n```\n## E\n<!-- discuss:edit -->\ne\n## B\nb";
    const explore = rulesForMode(fenced, "explore");
    expect(explore).not.toContain("## E");
    expect(explore).not.toContain("\ne\n");
    expect(explore).toContain("## B\nb");
    expect(rulesForMode(fenced, "edit")).toContain("## E\ne\n## B");
  });
  test("a file with no marker is sent whole in both modes", () => {
    const plain = "# A\n\n## Changing the page\n- edits\n";
    expect(rulesForMode(plain, "explore")).toBe(plain);
    expect(rulesForMode(plain, "edit")).toBe(plain);
  });
  // Each probe: [name, rules, Explore, Edit, warnings per call].
  const PROBES: [string, string, string, string, number][] = [
    ["a whole-file section under a top H2", "## Rules\n<!-- discuss:edit -->\n### a\nx\n### b\ny", "## Rules\n### a\nx\n### b\ny", "## Rules\n### a\nx\n### b\ny", 1],
    ["two markers under a whole-file heading warn once", "## Rules\n<!-- discuss:edit -->\nr\n<!-- discuss:edit -->\ns", "## Rules\nr\ns", "## Rules\nr\ns", 1],
    ["a whole-file section after intro text","intro\n## Rules\n<!-- discuss:edit -->\nr", "intro\n## Rules\nr", "intro\n## Rules\nr", 1],
    ["a lone H1 after an earlier H2", "## Intro\ni\n# Title\n<!-- discuss:edit -->\n## A\na", "## Intro\ni", "## Intro\ni\n# Title\n## A\na", 0],
    ["a lone ATX H1 after a Setext H1", "Top\n===\n# T\n<!-- discuss:edit -->\n## A\na", "Top\n===", "Top\n===\n# T\n## A\na", 0],
    // CommonMark: `a` and `Edit` are one Setext heading's two lines, so `a` goes with it.
    ["a Setext H2 that takes the paragraph above it", "# T\n## A\na\nEdit\n----\n<!-- discuss:edit -->\ne\n## B\nb", "# T\n## A\n## B\nb", "# T\n## A\na\nEdit\n----\ne\n## B\nb", 0],
    ["a Setext H2 after a blank line", "# T\n## A\na\n\nEdit\n----\n<!-- discuss:edit -->\ne\n## B\nb", "# T\n## A\na\n\n## B\nb", "# T\n## A\na\n\nEdit\n----\ne\n## B\nb", 0],
    ["a tilde fence with an info string hides a heading and a marker", "# T\n## E\n<!-- discuss:edit -->\n~~~md x\n## F\n<!-- discuss:edit -->\n~~~\ne\n## B\nb", "# T\n## B\nb", "# T\n## E\n~~~md x\n## F\n<!-- discuss:edit -->\n~~~\ne\n## B\nb", 0],
    ["an unclosed fence runs to the end", "# T\n## A\na\n## E\n<!-- discuss:edit -->\n```\n# not a heading\n", "# T\n## A\na", "# T\n## A\na\n## E\n```\n# not a heading", 0],
    // The lexer emits no token for a link definition and merges an indented line into the paragraph above: lines still count.
    ["a link definition and an indented continuation above the section", "# T\n[x]: http://e\np\n    q\n## E\n<!-- discuss:edit -->\ne\n## B\nb", "# T\n[x]: http://e\np\n    q\n## B\nb", "# T\n[x]: http://e\np\n    q\n## E\ne\n## B\nb", 0],
    ["a marker inside a list item or indented as code is not a marker", "# T\n## A\n- x\n  <!-- discuss:edit -->\n\n    <!-- discuss:edit -->\n## B\nb", "# T\n## A\n- x\n  <!-- discuss:edit -->\n\n    <!-- discuss:edit -->\n## B\nb", "# T\n## A\n- x\n  <!-- discuss:edit -->\n\n    <!-- discuss:edit -->\n## B\nb", 0],
  ];
  for (const [name, rules, explore, edit, warns] of PROBES) {
    test(`probe: ${name}`, () => {
      const warned: string[] = [];
      expect(rulesForMode(rules, "explore", (m) => warned.push(m))).toBe(explore);
      expect(warned.length).toBe(warns);
      expect(rulesForMode(rules, "edit", (m) => warned.push(m))).toBe(edit);
      expect(warned.length).toBe(2 * warns);
    });
  }
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

describe("rulesForMode: heading style × marker position × prefix, against an explicit section list", () => {
  type Style = "ATX H1" | "ATX H2" | "Setext H1" | "Setext H2";
  const MARK = "<!-- discuss:edit -->";
  /** One block of the file: a section's own lines (its heading and body, never the marker), or the intro text (`level` null). */
  type Section = { name: string; level: number | null; lines: string[] };
  const heading = (text: string, level: number, setext: boolean): string[] =>
    setext && level <= 2 ? [text, level === 1 ? "===" : "---"] : [`${"#".repeat(level)} ${text}`];
  const sectionsOf = (style: Style, shape: "full" | "single", prefix: "none" | "intro" | "earlier"): Section[] => {
    const lv = style.endsWith("H1") ? 1 : 2;
    const setext = style.startsWith("Setext");
    const out: Section[] = [];
    if (prefix === "intro") out.push({ name: "intro", level: null, lines: ["intro text"] });
    if (prefix === "earlier") out.push({ name: "earlier", level: lv + 1, lines: [`${"#".repeat(lv + 1)} Earlier`, "earlier body"] });
    out.push({ name: "top", level: lv, lines: [...heading("Top", lv, setext), "top body"] });
    out.push({ name: "child", level: lv + 1, lines: [...heading("Child", lv + 1, setext), "child body"] });
    if (shape === "full") {
      out.push({ name: "sibling", level: lv, lines: [...heading("Sibling", lv, setext), "sibling body"] });
      out.push({ name: "grandchild", level: lv + 1, lines: [...heading("Grandchild", lv + 1, setext), "grandchild body"] });
    }
    return out;
  };
  /** The file: the blocks one blank line apart, the marker right under the marked block's heading (every body is one line). */
  const fileOf = (secs: Section[], marked: number): string =>
    secs
      .map((s, i) => (i === marked ? [...s.lines.slice(0, -1), MARK, s.lines.at(-1)!] : s.lines).join("\n"))
      .join("\n\n");
  /** The reference: the marked section runs to the next block of the same or a higher level; when it starts at the
   *  first heading and runs to the end it is the whole file, which marks nothing and warns once. */
  const reference = (secs: Section[], marked: number) => {
    const lv = secs[marked]!.level!;
    let end = marked + 1;
    while (end < secs.length && (secs[end]!.level ?? Infinity) > lv) end++;
    const whole = marked === secs.findIndex((s) => s.level !== null) && end === secs.length;
    const join = (keep: Section[]) => keep.map((s) => s.lines.join("\n")).join("\n\n");
    return { explore: join(whole ? secs : secs.filter((_, i) => i < marked || i >= end)), edit: join(secs), warns: whole ? 1 : 0 };
  };
  const cases: [string, string, ReturnType<typeof reference>][] = [];
  for (const style of ["ATX H1", "ATX H2", "Setext H1", "Setext H2"] as const)
    for (const shape of ["full", "single"] as const)
      for (const position of ["top", "sibling", "child"] as const)
        for (const prefix of ["none", "intro", "earlier"] as const) {
          if (shape === "single" && position === "sibling") continue;
          const secs = sectionsOf(style, shape, prefix);
          const marked = secs.findIndex((s) => s.name === position);
          cases.push([`${style}, ${shape}, marker under ${position}, prefix ${prefix}`, fileOf(secs, marked), reference(secs, marked)]);
        }
  test("the table holds every combination, the whole-file one among them", () => {
    expect(cases.length).toBe(4 * (3 * 3 + 2 * 3));
    // A single-shape file marked under its top heading, with no earlier heading: one per style and prefix none/intro.
    expect(cases.filter(([, , r]) => r.warns === 1).length).toBe(4 * 2);
  });
  test.each(cases)("%s", (_name, rules, want) => {
    const warned: string[] = [];
    expect(rulesForMode(rules, "explore", (m) => warned.push(m))).toBe(want.explore);
    expect(rulesForMode(rules, "edit", (m) => warned.push(m))).toBe(want.edit);
    expect(warned.length).toBe(2 * want.warns);
  });
});
