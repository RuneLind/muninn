/**
 * The wiki read tools over the research MCP server's HTTP endpoint
 * (`/mcp/<bot>`): `tools/list` and `tools/call` for a bot with two wikis, an
 * unknown wiki, a wiki that turned read-only after registration, a bot with
 * no wiki, and an authenticating instance. Real temp git repos, invented content.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { __setAuthPolicyForTest } from "../auth/policy.ts";
import { realGit, type GitRun } from "../wiki/decision-triage/git.ts";
import { __setReadonlyWikiRootsForTest } from "../wiki/readonly.ts";
import { botWikis, type WikiRegistryEntry } from "../wiki/registry.ts";
import { testTempDir } from "../test/temp-dir.ts";
import { ResearchMcpServer } from "./mcp-server.ts";
import { resolveToolWiki, wikiGrepTool, wikiHistoryTool, wikiReadTool } from "./wiki-tools.ts";

let base = "";
let one = "";
let two = "";
const server = new ResearchMcpServer(0);

async function makeWiki(root: string, files: Record<string, string>) {
  await mkdir(root, { recursive: true });
  const git = (...a: string[]) => realGit(root, ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a]);
  await git("init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  await git("add", "-A");
  const res = await git("commit", "-q", "-m", "add CASE-7");
  if (!res.ok) throw new Error(res.stderr);
}

async function connect(bot: string) {
  const client = new Client({ name: "wiki-tools-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp/${bot}`)));
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

beforeAll(async () => {
  base = await realpath(await testTempDir(path.join(tmpdir(), "muninn-wiki-tools-")));
  one = path.join(base, "one");
  two = path.join(base, "two");
  await makeWiki(one, { "plans/ferry.md": "# Ferry\n\nCASE-7 is the ferry case.\n", "log.md": "- CASE-7 logged\n" });
  await makeWiki(two, { "notes/kai — ære.md": "Kai\nCASE-7 at the quay\n" });
  await writeFile(path.join(one, "draft.md"), "CASE-7 untracked\n");
  // The registry as `index.ts` reads it: the bot's own wiki, an extra pinned to it, one pinned elsewhere.
  const registry: WikiRegistryEntry[] = [
    { name: "harbour", root: one, source: "bot" },
    { name: "Quay-Wiki", root: two, source: "extra", synthesisBot: "HARBOUR" },
    { name: "other", root: one, source: "extra", synthesisBot: "someone" },
  ];
  server.registerBot({ botName: "harbour", knowledgeApiUrl: "http://127.0.0.1:1", wikis: botWikis(registry, "harbour", () => false) });
  server.registerBot({ botName: "solo", knowledgeApiUrl: "http://127.0.0.1:1", wikis: [{ name: "quay", root: two }] });
  server.registerBot({ botName: "plain", knowledgeApiUrl: "http://127.0.0.1:1", wikis: botWikis(registry, "plain", () => false) });
  server.start();
});

afterEach(() => {
  __setReadonlyWikiRootsForTest();
  __setAuthPolicyForTest(null);
});

afterAll(async () => {
  await server.stop();
  await rm(base, { recursive: true, force: true });
});

describe("botWikis", () => {
  test("the bot's own wiki and the extras pinned to it, ignoring case; a read-only root left out", () => {
    const registry: WikiRegistryEntry[] = [
      { name: "harbour", root: "/w/one", source: "bot" },
      { name: "Quay", root: "/w/two", source: "extra", synthesisBot: "Harbour" },
      { name: "other", root: "/w/three", source: "extra" },
      { name: "pier", root: "/w/four", source: "bot", synthesisBot: "harbour" },
    ];
    expect(botWikis(registry, "HARBOUR", () => false)).toEqual([
      { name: "harbour", root: "/w/one" },
      { name: "Quay", root: "/w/two" },
    ]);
    expect(botWikis(registry, "harbour", (r) => r === "/w/two")).toEqual([{ name: "harbour", root: "/w/one" }]);
    expect(botWikis(registry, "nobody", () => false)).toEqual([]);
  });
  test("resolveToolWiki: case-insensitive, the only wiki when none is named, else the allowed names", () => {
    const w = [{ name: "harbour", root: "/a" }, { name: "Quay-Wiki", root: "/b" }];
    expect(resolveToolWiki(w, "quay-wiki")).toEqual(w[1]!);
    expect(resolveToolWiki(w, undefined)).toBe('name the wiki: `wiki` is required when this bot has more than one wiki. Allowed: "harbour", "Quay-Wiki".');
    expect(resolveToolWiki([w[0]!], undefined)).toEqual(w[0]!);
    expect(resolveToolWiki(w, "nope")).toBe('unknown wiki "nope". Allowed: "harbour", "Quay-Wiki".');
  });
});

describe("wikiGrepTool", () => {
  test("wiki_grep on a git without PCRE says the regex ran as ERE, with hits and without", async () => {
    const noPcre: GitRun = async (cwd, args, opts) =>
      args.includes("-P") ? { ok: false, stdout: "", stderr: "fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE", exitCode: 128 } : realGit(cwd, args, opts);
    const wikis = [{ name: "quay", root: two }];
    const hit = textOf(await wikiGrepTool(wikis, { pattern: "CASE-[0-9]", regex: true }, { git: noPcre, isReadonlyRoot: () => false }));
    expect(hit).toContain("1 matching line(s)");
    expect(hit).toContain("no PCRE");
    const miss = textOf(await wikiGrepTool(wikis, { pattern: "\\bCASE-\\d\\b", regex: true }, { git: noPcre, isReadonlyRoot: () => false }));
    expect(miss).toContain("No tracked file");
    expect(miss).toContain("\\b, \\d, \\w and \\s match nothing");
    const pcre = textOf(await wikiGrepTool(wikis, { pattern: "\\bCASE-\\d\\b", regex: true }, { isReadonlyRoot: () => false }));
    expect(pcre).toContain("1 matching line(s)");
    expect(pcre).not.toContain("no PCRE");
  });
  test("a glob selecting no file is an error the model can act on; a bare folder name searches the folder", async () => {
    const wikis = [{ name: "harbour", root: one }];
    const deps = { isReadonlyRoot: () => false };
    const folder = await wikiGrepTool(wikis, { pattern: "CASE-7", glob: "plans" }, deps);
    expect(textOf(folder)).toBe('1 matching line(s) in 1 file(s) of "harbour" (files matching plans):\nplans/ferry.md:3: CASE-7 is the ferry case.');
    const none = await wikiGrepTool(wikis, { pattern: "CASE-7", glob: "*.MD" }, deps);
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('glob "*.MD" selects no tracked file');
    expect(textOf(none)).toContain("plans/**");
  });
});

describe("ResearchMcpServer.servesWikiTools", () => {
  test("true only while running, with MUNINN_AUTH=off and a live wiki registered for that bot", async () => {
    expect(server.servesWikiTools("harbour")).toBe(true);
    expect(server.servesWikiTools("HARBOUR")).toBe(false); // the URL's bot name is exact
    expect(server.servesWikiTools("plain")).toBe(false);
    expect(server.servesWikiTools("nobody")).toBe(false);
    __setReadonlyWikiRootsForTest([two]);
    expect(server.servesWikiTools("solo")).toBe(false);
    __setReadonlyWikiRootsForTest();
    __setAuthPolicyForTest({ mode: "entra", authenticating: true });
    expect(server.servesWikiTools("harbour")).toBe(false);
    __setAuthPolicyForTest(null);
    const idle = new ResearchMcpServer(0);
    idle.registerBot({ botName: "harbour", knowledgeApiUrl: "http://127.0.0.1:1", wikis: [{ name: "harbour", root: one }] });
    expect(idle.servesWikiTools("harbour")).toBe(false);
  });
});

describe("wikiReadTool", () => {
  test("an empty tracked file is reported as empty, not as one line", async () => {
    const root = path.join(base, "empty-wiki");
    await makeWiki(root, { "empty.md": "", "a.md": "x\n" });
    const res = await wikiReadTool([{ name: "harbour", root }], { path: "empty.md" }, { isReadonlyRoot: () => false });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe('empty.md (wiki "harbour") is empty: it has no lines.');
  });
});

describe("wikiHistoryTool", () => {
  const rec = (hash: string, subject: string, files: string[]) => `\x1e${hash}\x1f2026-01-02T03:04:05+01:00\x1fAnn\x1f${subject}\0\n${files.join("\0")}\0`;
  const deps = (stdout: string, capped: boolean): { git: GitRun; isReadonlyRoot: () => boolean } => ({
    git: async () => ({ ok: true, stdout, ...(capped ? { capped } : { exitCode: 0 }) }),
    isReadonlyRoot: () => false,
  });
  const wikis = [{ name: "harbour", root: "/nowhere" }];
  test("a commit's file list is bounded, with the rest counted", async () => {
    const files = Array.from({ length: 415 }, (_, i) => `sources/s-${i}.md`);
    const out = textOf(await wikiHistoryTool(wikis, { term: "type: source" }, deps(rec("c".repeat(40), "bulk", files), false)));
    const line = out.split("\n").find((l) => l.startsWith("  files: "))!;
    expect(line).toEndWith("sources/s-19.md, … and 395 more");
    expect(line.length).toBeLessThan(600);
  });
  test("cut output reads as at least N commits, never as the whole history", async () => {
    const cut = rec("a".repeat(40), "whole", ["a.md"]) + rec("b".repeat(40), "cut", ["b.m"]).slice(0, -1);
    const out = textOf(await wikiHistoryTool(wikis, { term: "KEY" }, deps(cut, true)));
    expect(out).toStartWith('at least 1 commit(s) in "harbour"');
    expect(out).toContain("output cut");
    expect(out).not.toContain("Ann: cut");
  });
  test("a glob as path is refused, saying it takes a file or folder path", async () => {
    const res = await wikiHistoryTool([{ name: "harbour", root: one }], { term: "CASE-7", path: "plans/*.md" }, { isReadonlyRoot: () => false });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("a file or folder path");
  });
});

describe("over HTTP on /mcp/<bot>", () => {
  test("tools/list holds the three wiki tools beside research_knowledge", async () => {
    const client = await connect("harbour");
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["research_knowledge", "wiki_grep", "wiki_history", "wiki_read"]);
      const grep = tools.find((t) => t.name === "wiki_grep")!;
      expect(grep.description).toContain('Use wiki_grep for an exact key, id or "where else"');
      expect(grep.description).toContain("paths it returns are valid wiki_read paths");
    } finally {
      await client.close();
    }
  });
  test("wiki_grep, then wiki_read on a returned non-ASCII path, then wiki_history", async () => {
    const client = await connect("harbour");
    try {
      const grep = textOf(await client.callTool({ name: "wiki_grep", arguments: { wiki: "quay-wiki", pattern: "CASE-7" } }));
      expect(grep).toBe('1 matching line(s) in 1 file(s) of "Quay-Wiki":\nnotes/kai — ære.md:2: CASE-7 at the quay');
      const read = textOf(await client.callTool({ name: "wiki_read", arguments: { wiki: "Quay-Wiki", path: "notes/kai — ære.md" } }));
      expect(read).toBe('notes/kai — ære.md (wiki "Quay-Wiki"), lines 1–2 of 2:\n1: Kai\n2: CASE-7 at the quay');
      const own = textOf(await client.callTool({ name: "wiki_grep", arguments: { wiki: "harbour", pattern: "CASE-7", maxResults: 1 } }));
      // draft.md is untracked: not found. The cap's line counts what is past it.
      expect(own).toBe('2 matching line(s) in 2 file(s) of "harbour":\nlog.md:1: - CASE-7 logged\n… 1 more line(s) past the cap of 1, and 1 more file(s) with no line shown. Narrow with glob or a longer pattern, or raise maxResults.');
      const hist = textOf(await client.callTool({ name: "wiki_history", arguments: { wiki: "harbour", term: "CASE-7" } }));
      expect(hist).toContain("1 commit(s) in \"harbour\"");
      expect(hist).toContain("files: log.md, plans/ferry.md");
    } finally {
      await client.close();
    }
  });
  test("an unknown or missing wiki name is an error naming the allowed wikis", async () => {
    const client = await connect("harbour");
    try {
      const unknown = await client.callTool({ name: "wiki_grep", arguments: { wiki: "other", pattern: "CASE-7" } });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toBe('unknown wiki "other". Allowed: "harbour", "Quay-Wiki".');
      const missing = await client.callTool({ name: "wiki_read", arguments: { path: "log.md" } });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("Allowed: \"harbour\", \"Quay-Wiki\"");
    } finally {
      await client.close();
    }
  });
  test("a bot with one wiki may leave wiki out", async () => {
    const client = await connect("solo");
    try {
      expect(textOf(await client.callTool({ name: "wiki_grep", arguments: { pattern: "CASE-7" } }))).toContain("notes/kai — ære.md:2:");
    } finally {
      await client.close();
    }
  });
  test("a wiki whose root turned read-only after registration is refused on the call", async () => {
    const client = await connect("harbour");
    try {
      __setReadonlyWikiRootsForTest([two]);
      const res = await client.callTool({ name: "wiki_grep", arguments: { wiki: "Quay-Wiki", pattern: "CASE-7" } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('unknown wiki "Quay-Wiki". Allowed: "harbour".');
    } finally {
      await client.close();
    }
  });
  test("a bot whose only wiki is read-only at session start gets no wiki tools", async () => {
    __setReadonlyWikiRootsForTest([two]);
    const client = await connect("solo");
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["research_knowledge"]);
    } finally {
      await client.close();
    }
  });
  test("a bot with no wiki registers no wiki tools", async () => {
    const client = await connect("plain");
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["research_knowledge"]);
    } finally {
      await client.close();
    }
  });
  test("an authenticating instance registers no wiki tools", async () => {
    __setAuthPolicyForTest({ mode: "entra", authenticating: true });
    const client = await connect("harbour");
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["research_knowledge"]);
    } finally {
      await client.close();
    }
  });
});
