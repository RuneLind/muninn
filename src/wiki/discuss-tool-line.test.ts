/** `discussToolLine`: a Discuss tool call in a reader's words, for every tool
 *  the surfaces produce, a cut input and garbage. */
import { describe, expect, test } from "bun:test";
import { discussToolLine, discussToolText, toolLineText } from "./discuss-tool-line.ts";

const j = (o: unknown) => JSON.stringify(o);

describe("discussToolLine", () => {
  test("research wiki tools (copilot-sdk names)", () => {
    expect(discussToolLine("research-wiki_grep", j({ pattern: "2032", wiki: "melosys-kode-wiki", glob: "plans/2026-11-27-fnr-maskering-i-claude-code-og-opencode.mdx", maxResults: 10 }))).toEqual({
      label: "Searching the wiki",
      detail: '"2032" in plans/2026-11-27-fnr-maskering-i-claude-code-og-opencode.mdx',
    });
    expect(discussToolLine("research-wiki_grep", j({ pattern: "T-nummer", wiki: "w" }))).toEqual({ label: "Searching the wiki", detail: '"T-nummer"' });
    expect(discussToolLine("research-wiki_read", j({ wiki: "w", path: "plans/2026-11-19-syntetisk-fnr-kosovo-testperson.mdx", offset: 28, limit: 40 }))).toEqual({
      label: "Reading",
      detail: "plans/2026-11-19-syntetisk-fnr-kosovo-testperson.mdx, lines 28–67",
    });
    expect(discussToolLine("research-wiki_read", j({ wiki: "w", path: "a.md", offset: 5 })).detail).toBe("a.md, from line 5");
    expect(discussToolLine("research-wiki_read", j({ wiki: "w", path: "a.md", limit: 20 })).detail).toBe("a.md, lines 1–20");
    expect(discussToolLine("research-wiki_history", j({ wiki: "w", term: "MEL-1", path: "plans" }))).toEqual({ label: "Reading the wiki's history", detail: '"MEL-1" in plans' });
  });
  test("claude-cli MCP spelling reads the same", () => {
    expect(discussToolLine("mcp__research__wiki_grep", j({ pattern: "x" }))).toEqual({ label: "Searching the wiki", detail: '"x"' });
  });
  test("yggdrasil and knowledge tools", () => {
    expect(discussToolLine("yggdrasil-search", j({ query: "fnr-guard idnr D-nummer" }))).toEqual({ label: "Searching code", detail: "fnr-guard idnr D-nummer" });
    expect(discussToolLine("yggdrasil-search", j({ query: "q", repo: "melosys-api" })).detail).toBe("q in melosys-api");
    expect(discussToolLine("yggdrasil-file_outline", j({ repo: "muninn", path: "src/wiki/x.ts" }))).toEqual({ label: "Outlining", detail: "muninn: src/wiki/x.ts" });
    expect(discussToolLine("yggdrasil-symbol_context", j({ symbol: "startTurn" }))).toEqual({ label: "Looking up a symbol", detail: "startTurn" });
    expect(discussToolLine("yggdrasil-impact", j({ symbol: "startTurn" }))).toEqual({ label: "Checking impact", detail: "startTurn" });
    expect(discussToolLine("yggdrasil-list_repos", "{}")).toEqual({ label: "Listing repos", detail: "" });
    expect(discussToolLine("yggdrasil-list_files", j({ repo: "muninn", path: "src" }))).toEqual({ label: "Listing files", detail: "muninn: src" });
    expect(discussToolLine("knowledge-search_knowledge", j({ query: "trygdeavtale" }))).toEqual({ label: "Searching knowledge", detail: "trygdeavtale" });
  });
  test("claude-cli built-ins; an absolute snapshot path shows its tail", () => {
    expect(discussToolLine("Read", j({ file_path: "/var/folders/x/T/muninn-snap-abc/wiki/plans/p.mdx", offset: 10, limit: 5 }))).toEqual({ label: "Reading", detail: "…/wiki/plans/p.mdx, lines 10–14" });
    expect(discussToolLine("Read", j({ file_path: "/a/b.md" })).detail).toBe("/a/b.md");
    expect(discussToolLine("Grep", j({ pattern: "fnr", path: "/tmp/snap/repo/src/guard", glob: "*.ts" }))).toEqual({ label: "Searching files", detail: '"fnr" in *.ts' });
    expect(discussToolLine("Grep", j({ pattern: "fnr", path: "/tmp/snap/repo/src/guard" })).detail).toBe('"fnr" in …/repo/src/guard');
    expect(discussToolLine("Glob", j({ pattern: "**/*.mdx", path: "/tmp/s/wiki" }))).toEqual({ label: "Listing files", detail: "**/*.mdx in /tmp/s/wiki" });
  });
  test("an input cut at 200 chars still gives its fields", () => {
    const full = j({ pattern: "T-nummer", wiki: "melosys-kode-wiki", glob: `plans/${"x".repeat(300)}.mdx` });
    const cutInput = `${full.slice(0, 199)}…`;
    expect(() => JSON.parse(cutInput)).toThrow();
    const l = discussToolLine("research-wiki_grep", cutInput);
    expect(l.label).toBe("Searching the wiki");
    expect(l.detail.startsWith('"T-nummer" in plans/xxx')).toBe(true);
    expect(l.detail.length).toBeLessThanOrEqual(160);
    expect(discussToolLine("research-wiki_read", '{"wiki":"w","path":"plans/a.mdx","offset":3,"lim').detail).toBe("plans/a.mdx, from line 3");
    // An escape in a cut input is read as JSON would.
    expect(discussToolLine("research-wiki_grep", '{"pattern":"say \\"hi\\"","glob":"pla').detail).toBe('"say "hi"" in pla');
    // A long detail is cut to 160 characters.
    const long = discussToolLine("yggdrasil-search", j({ query: "q".repeat(400) })).detail;
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
  });
  test("an unknown tool: its name with spaces and a short key: value detail", () => {
    expect(discussToolLine("other-do_thing", j({ alpha: "one", beta: 2, gamma: "three", delta: "four" }))).toEqual({ label: "other-do thing", detail: "alpha: one, beta: 2, gamma: three" });
  });
  test("garbage never throws", () => {
    expect(discussToolLine("Read", "not json at all")).toEqual({ label: "Reading", detail: "" });
    expect(discussToolLine("", "")).toEqual({ label: "tool", detail: "" });
    expect(discussToolLine("research-wiki_grep", "[1,2,3]")).toEqual({ label: "Searching the wiki", detail: "" });
    expect(discussToolLine(undefined as unknown as string, null as unknown as string)).toEqual({ label: "tool", detail: "" });
    expect(discussToolLine("x", '{"a":"\\u12')).toEqual({ label: "x", detail: "a: \\u12" });
  });
  // A row stored before #913 carries only the input, cut (300 chars stored,
  // 200 live); the server now ships each call's line made from the full input.
  const cutAt = (s: string, max = 200) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
  test("PR 913 R2: a path cut inside its file name shows the tail it has left, with the file name's start", () => {
    const p = "/Users/rune/.muninn/agent-cwd/.snapshots/mimir-" + "3f9c".repeat(10) + "/projects/muninn/discuss/2026-11-27-wiki-discuss-model-user-tools-follow-up-plan-and-fix-rounds.mdx";
    const line = discussToolLine("Read", cutAt(j({ file_path: p, offset: 40, limit: 80 })));
    expect(line.detail).toContain("2026-11-27-wiki-discuss-model-user-tools");
    expect(line.detail).not.toContain(".snapshots");
    expect(line.detail.endsWith("…")).toBe(true);
    // An uncut absolute path still shows its tail.
    expect(discussToolLine("Read", j({ file_path: "/a/b/c/d/e.ts" })).detail).toBe("…/c/d/e.ts");
  });

  test("PR 913 R2: a number the cut reached is not read as a smaller number", () => {
    for (const n of [158, 159, 160]) {
      const input = cutAt(j({ pad: "y".repeat(n), file_path: "a.md", offset: 1234, limit: 80 }));
      expect(input).toMatch(/"offset":\d{1,3}…$/);
      expect(discussToolLine("Read", input).detail).toBe("a.md");
    }
  });

  test("PR 913 R2: a key with an escaped quote in its name never passes for a top-level field", () => {
    const input = cutAt(j({ 'x"pattern': "evil", pattern: "real", path: "p/" + "x".repeat(300) }));
    expect(discussToolLine("Grep", input).detail.startsWith('"real"')).toBe(true);
  });

  test("PR 913 R1: on a cut input a nested key never shadows the top-level one", () => {
    const input = cutAt(j({ nested: { pattern: "inner" }, pattern: "outer", path: "p/" + "x".repeat(300) }));
    expect(discussToolLine("Grep", input).detail.startsWith('"outer"')).toBe(true);
    // …nor one inside an array of objects.
    expect(discussToolLine("Grep", cutAt(j({ list: [{ pattern: "in-array" }], pattern: "outer", path: "p/" + "x".repeat(300) }))).detail.startsWith('"outer"')).toBe(true);
    // A key named like an Object.prototype member is read, not skipped.
    expect(discussToolLine("mystery", cutAt(j({ constructor: "c", pad: "y".repeat(300) }))).detail).toContain("constructor: c");
  });

  test("discussToolText joins label and detail the way /chat's tool line splits it", () => {
    expect(discussToolText("yggdrasil-search", j({ query: "q" }))).toBe("Searching code: q");
    expect(discussToolText("yggdrasil-list_repos", "")).toBe("Listing repos");
    // /chat's mirror sends the engine's line through toolLineText.
    expect(toolLineText({ label: "Reading", detail: "…/d/the-file.mdx" })).toBe("Reading: …/d/the-file.mdx");
    expect(toolLineText({ label: "Listing repos", detail: "" })).toBe("Listing repos");
  });
});
