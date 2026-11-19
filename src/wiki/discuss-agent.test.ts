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
} from "./discuss-agent.ts";
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
  test("the system prompt carries the rules and no persona", () => {
    const s = renderAgentSystemPrompt("w", "Be brief.");
    expect(s).toContain("<wiki_rules>\nBe brief.\n</wiki_rules>");
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
