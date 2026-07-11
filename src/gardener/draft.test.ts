import { test, expect, describe } from "bun:test";
import { shapeGate, isPathConfined, buildDraftPrompt, normalizeDraftOutput, stripOwnedAliases, WIKI_CONVENTIONS_DIGEST } from "./draft.ts";
import type { WikiIndex, WikiPageMeta } from "../wiki/store.ts";
import type { Cluster, HarvestedDoc } from "./types.ts";

const WIKI = "/tmp/wiki-root";

function draftFile(opts: { type?: string; title?: string; body?: string } = {}): string {
  const type = opts.type ?? "concept";
  const title = opts.title === undefined ? "Context Compaction" : opts.title;
  const titleLine = opts.title === undefined || opts.title ? `title: ${title}\n` : "";
  const body = opts.body === undefined ? "# Context Compaction\n\nLead.\n\n## See also\n- [[X]]" : opts.body;
  return `---\ntype: ${type}\n${titleLine}aliases: []\ncreated: 2026-07-08\nupdated: 2026-07-08\ntags: []\nsources: []\n---\n\n${body}`;
}

describe("isPathConfined", () => {
  test("accepts a create path in the domain+kind dir", () => {
    expect(isPathConfined({ targetPath: "concepts/Foo.md", wikiDir: WIKI, domain: "ai", kind: "concept" })).toBe(true);
    expect(isPathConfined({ targetPath: "life/concepts/Foo.md", wikiDir: WIKI, domain: "life", kind: "concept" })).toBe(true);
    expect(isPathConfined({ targetPath: "entities/Bar.md", wikiDir: WIKI, domain: "ai", kind: "entity" })).toBe(true);
  });

  test("rejects `..` traversal", () => {
    expect(isPathConfined({ targetPath: "../escape.md", wikiDir: WIKI, domain: "ai", kind: "concept" })).toBe(false);
    expect(isPathConfined({ targetPath: "concepts/../../escape.md", wikiDir: WIKI, domain: "ai", kind: "concept" })).toBe(false);
  });

  test("rejects an absolute path", () => {
    expect(isPathConfined({ targetPath: "/etc/passwd.md", wikiDir: WIKI, domain: "ai", kind: "concept" })).toBe(false);
  });

  test("rejects the wrong dir for the kind", () => {
    expect(isPathConfined({ targetPath: "entities/Foo.md", wikiDir: WIKI, domain: "ai", kind: "concept" })).toBe(false);
  });

  test("rejects a domain mismatch (life cluster into the ai subtree)", () => {
    expect(isPathConfined({ targetPath: "concepts/Foo.md", wikiDir: WIKI, domain: "life", kind: "concept" })).toBe(false);
  });

  test("rejects a non-.md path", () => {
    expect(isPathConfined({ targetPath: "concepts/Foo.txt", wikiDir: WIKI, domain: "ai", kind: "concept" })).toBe(false);
  });

  test("update mode: only the exact existing path passes", () => {
    expect(isPathConfined({ targetPath: "concepts/Foo.md", wikiDir: WIKI, domain: "ai", kind: "concept", existingRelPath: "concepts/Foo.md" })).toBe(true);
    expect(isPathConfined({ targetPath: "concepts/Other.md", wikiDir: WIKI, domain: "ai", kind: "concept", existingRelPath: "concepts/Foo.md" })).toBe(false);
  });

  test("forbidden infrastructure basenames are rejected in both modes", () => {
    for (const base of ["log.md", "index.md", "CLAUDE.md", "LOG.md"]) {
      expect(isPathConfined({ targetPath: `concepts/${base}`, wikiDir: WIKI, domain: "ai", kind: "concept" })).toBe(false);
      expect(isPathConfined({ targetPath: `concepts/${base}`, wikiDir: WIKI, domain: "ai", kind: "concept", existingRelPath: `concepts/${base}` })).toBe(false);
    }
    // A page merely containing one of the words is fine.
    expect(isPathConfined({ targetPath: "concepts/Logging.md", wikiDir: WIKI, domain: "ai", kind: "concept" })).toBe(true);
  });
});

describe("shapeGate", () => {
  const okOpts = { kind: "concept" as const, targetPath: "concepts/Context Compaction.md", wikiDir: WIKI, domain: "ai" as const };

  test("accepts a well-formed create draft", () => {
    expect(shapeGate(draftFile(), okOpts)).toEqual({ ok: true });
  });

  test("rejects missing frontmatter", () => {
    expect(shapeGate("# just a body", okOpts).ok).toBe(false);
  });

  test("rejects a type/kind mismatch", () => {
    expect(shapeGate(draftFile({ type: "entity" }), okOpts).ok).toBe(false);
  });

  test("rejects a missing title", () => {
    expect(shapeGate(draftFile({ title: "" }), okOpts).ok).toBe(false);
  });

  test("rejects an empty body", () => {
    expect(shapeGate(draftFile({ body: "" }), okOpts).ok).toBe(false);
  });

  test("rejects a path-confinement violation", () => {
    expect(shapeGate(draftFile(), { ...okOpts, targetPath: "../evil.md" }).ok).toBe(false);
  });

  test("rejects forbidden infrastructure basenames", () => {
    expect(shapeGate(draftFile(), { ...okOpts, targetPath: "concepts/log.md" }).ok).toBe(false);
    expect(shapeGate(draftFile(), { ...okOpts, targetPath: "concepts/index.md" }).ok).toBe(false);
    expect(shapeGate(draftFile(), { ...okOpts, targetPath: "concepts/CLAUDE.md" }).ok).toBe(false);
  });

  test("rejects a type value with a trailing inline comment (prompt regression guard)", () => {
    // parseFrontmatter does NOT strip trailing comments — `type: concept # …`
    // parses to the literal string and fails the kind match. The conventions
    // digest must therefore never show inline comments in its example (it did
    // once, and drafts imitating it were silently dropped here).
    const draft = draftFile({ type: 'concept # "concept" for an idea' });
    const result = shapeGate(draft, okOpts);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match cluster kind");
    expect(WIKI_CONVENTIONS_DIGEST).not.toMatch(/^type: concept\s+#/m);
  });
});

describe("buildDraftPrompt", () => {
  const cluster: Cluster = { topicKey: "t", kind: "concept", domain: "ai", label: "T", docIds: ["c/1"] };
  const docs: HarvestedDoc[] = [{ key: "c/1", collection: "c", id: "1", url: "https://x", title: "Doc", text: "summary body" }];

  test("create prompt inlines summaries as untrusted", () => {
    const p = buildDraftPrompt({ cluster, mode: "create", docs, today: "2026-07-08" });
    expect(p).toContain("UNTRUSTED source material");
    expect(p).toContain("https://x");
    expect(p).not.toContain("BEGIN CURRENT PAGE");
  });

  test("update prompt inlines the current page body", () => {
    const p = buildDraftPrompt({ cluster, mode: "update", docs, today: "2026-07-08", currentBody: "existing content" });
    expect(p).toContain("BEGIN CURRENT PAGE");
    expect(p).toContain("existing content");
  });

  test("bounds the prompt: caps docs (most recent first) and per-doc length", () => {
    const many: HarvestedDoc[] = Array.from({ length: 15 }, (_, i) => ({
      key: `c/2026-07-${String(i + 1).padStart(2, "0")}_d.md`,
      collection: "c",
      id: `2026-07-${String(i + 1).padStart(2, "0")}_d.md`,
      url: "",
      title: `Doc ${i + 1}`,
      text: i === 14 ? "x".repeat(7000) : `body ${i + 1}`,
    }));
    const bigCluster = { ...cluster, docIds: many.map((d) => d.key) };
    const p = buildDraftPrompt({ cluster: bigCluster, mode: "create", docs: many, today: "2026-07-08" });
    // 8-doc cap, most recent first: the 7 OLDEST (Doc 1–7) are dropped.
    expect(p).toContain("Doc 15");
    expect(p).toContain("Doc 8");
    expect(p).not.toContain("Doc 7:");
    // The 7000-char doc (Doc 15, kept as most recent) is truncated with a marker.
    expect(p).toContain("[… truncated for length]");
    expect(p).not.toContain("x".repeat(4500));
  });
});

describe("normalizeDraftOutput", () => {
  const file = `---\ntype: concept\ntitle: T\n---\n\n# T\n\nBody.`;

  test("passes bare file content through unchanged", () => {
    expect(normalizeDraftOutput(file)).toBe(file);
  });

  test("unwraps a whole-output markdown code fence", () => {
    expect(normalizeDraftOutput("```markdown\n" + file + "\n```")).toBe(file);
    expect(normalizeDraftOutput("```\n" + file + "\n```\n")).toBe(file);
  });

  test("drops conversational preamble before the frontmatter fence", () => {
    expect(normalizeDraftOutput("Here is the wiki page you asked for:\n\n" + file)).toBe(file);
  });

  test("leaves text without a terminated frontmatter block untouched", () => {
    const junk = "Sorry, I cannot draft this page.";
    expect(normalizeDraftOutput(junk)).toBe(junk);
    // A stray `---` divider with no closing fence is not mistaken for frontmatter.
    const divider = "Intro\n---\nno closing fence here";
    expect(normalizeDraftOutput(divider)).toBe(divider);
  });
});

describe("stripOwnedAliases", () => {
  const page = (over: Partial<WikiPageMeta>): WikiPageMeta => ({
    name: "x",
    title: "X",
    type: "concept",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: "concepts/x.md",
    ...over,
  });
  const index = (pages: WikiPageMeta[]): WikiIndex => ({
    pages,
    outgoing: new Map(),
    backlinks: new Map(),
    resolve: () => undefined,
    resolveRelPath: () => undefined,
    scannedAt: 0,
    root: WIKI,
  });
  const draftWith = (aliases: string) =>
    `---\ntype: concept\ntitle: New Page\naliases: [${aliases}]\ncreated: 2026-07-11\nupdated: 2026-07-11\ntags: []\nsources: []\n---\n\n# New Page\n\nBody.\n\n## See also\n- [[X]]`;

  test("strips an alias another page owns as its TITLE (case-insensitive)", () => {
    const idx = index([page({ title: "Context Engineering", relPath: "concepts/Context Engineering.md" })]);
    const out = stripOwnedAliases(draftWith("context engineering, Fresh Alias"), { index: idx });
    expect(out.stripped).toEqual(["context engineering"]);
    expect(out.draft).toContain("aliases: [Fresh Alias]");
  });

  test("strips an alias another page owns as an ALIAS or its name", () => {
    const idx = index([
      page({ title: "Agent Loops", name: "Agent Loops", aliases: ["Loops"], relPath: "concepts/Agent Loops.md" }),
    ]);
    const out = stripOwnedAliases(draftWith("Loops, agent loops, Mine"), { index: idx });
    expect(out.stripped).toEqual(["Loops", "agent loops"]);
    expect(out.draft).toContain("aliases: [Mine]");
  });

  test("update mode keeps the page's OWN aliases via selfRelPath", () => {
    const idx = index([
      page({ title: "Agent Loops", aliases: ["Loops"], relPath: "concepts/Agent Loops.md" }),
    ]);
    const out = stripOwnedAliases(draftWith("Loops"), {
      index: idx,
      selfRelPath: "concepts/Agent Loops.md",
    });
    expect(out.stripped).toEqual([]);
    expect(out.draft).toContain("aliases: [Loops]");
  });

  test("no collisions, no aliases line, or null index → draft unchanged", () => {
    const idx = index([page({ title: "Unrelated" })]);
    const clean = draftWith("Fresh One, Fresh Two");
    expect(stripOwnedAliases(clean, { index: idx }).draft).toBe(clean);
    expect(stripOwnedAliases(clean, { index: null }).stripped).toEqual([]);
    const noAliases = clean.replace(/^aliases:.*\n/m, "");
    expect(stripOwnedAliases(noAliases, { index: idx }).draft).toBe(noAliases);
  });

  test("all aliases stripped → empty inline array; body 'aliases:' lines untouched", () => {
    const idx = index([page({ title: "Taken" })]);
    const draft = draftWith("Taken") + "\n\naliases: [in body, not frontmatter]";
    const out = stripOwnedAliases(draft, { index: idx });
    expect(out.draft).toContain("aliases: []\ncreated:");
    expect(out.draft).toContain("aliases: [in body, not frontmatter]");
  });

  test("kept aliases survive RAW — apostrophes and quoting are never rewritten", () => {
    const idx = index([page({ title: "Taken" })]);
    const out = stripOwnedAliases(draftWith(`Taken, "Say, hi", Conway's Law`), { index: idx });
    expect(out.stripped).toEqual(["Taken"]);
    expect(out.draft).toContain(`aliases: ["Say, hi", Conway's Law]`);
  });

  test("quoted owned alias is stripped (comparison unquotes)", () => {
    const idx = index([page({ title: "Context Engineering" })]);
    const out = stripOwnedAliases(draftWith(`"Context Engineering", Mine`), { index: idx });
    expect(out.stripped).toEqual(["Context Engineering"]);
    expect(out.draft).toContain("aliases: [Mine]");
  });

  test("duplicate aliases: lines are BOTH processed — no smuggling past the guard", () => {
    const idx = index([page({ title: "Taken" })]);
    const draft = `---\ntype: concept\ntitle: New Page\naliases: [Fresh]\naliases: [Taken]\n---\n\n# New Page\n\nBody.`;
    const out = stripOwnedAliases(draft, { index: idx });
    expect(out.stripped).toEqual(["Taken"]);
    expect(out.draft).toContain("aliases: [Fresh]");
    expect(out.draft).toContain("aliases: []");
    expect(out.draft).not.toContain("aliases: [Taken]");
  });
});
