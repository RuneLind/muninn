import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMemberExcerpt,
  harvestMembers,
  buildSynthesisPrompt,
  synthesisShapeGate,
  draftAndPersistSynthesis,
  MEMBER_EXCERPT_MAX,
  SYNTHESIS_EXCERPT_BUDGET,
  type SynthesisMember,
} from "./synthesis-drafter.ts";
import {
  getWikiIndex,
  normalizeRelPath,
  __resetWikiCacheForTest,
  type WikiIndex,
  type WikiPageMeta,
} from "../wiki/store.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { Tracer } from "../tracing/tracer.ts";
import type { InsertWikiProposalParams, WikiProposal } from "../db/wiki-proposals.ts";

/** DB-free recording tracer (mirrors summarizer-shared.test's). */
function fakeTracer(): Tracer {
  return {
    traceId: "trace-1",
    start: () => "span-1",
    end: () => 1,
    finish: () => {},
    addChildSpan: () => "child",
    addSubSpan: () => "sub",
  } as unknown as Tracer;
}

/** Minimal member page on disk. */
async function writePage(root: string, rel: string, title: string, body: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await Bun.write(path.join(root, rel), `---\ntype: plan\ntitle: ${title}\n---\n\n${body}\n`);
}

describe("buildMemberExcerpt", () => {
  const meta = (title: string): WikiPageMeta =>
    ({ name: title, title, type: "plan", domain: "ai", tags: [], aliases: [], relPath: "plans/x.md" }) as WikiPageMeta;

  test("captures title + lead + headings + outcome", () => {
    const body = `---\ntype: plan\ntitle: Foo\n---\n\nThe lead paragraph explaining the arc.\n\n## Approach\nStuff.\n\n## Outcome\nWe shipped it and learned that caching helps.\n`;
    const ex = buildMemberExcerpt(meta("Foo"), body);
    expect(ex).toContain("Title: Foo");
    expect(ex).toContain("Lead: The lead paragraph");
    expect(ex).toContain("Approach");
    expect(ex).toContain("Outcome: We shipped it");
  });

  test("caps at MEMBER_EXCERPT_MAX", () => {
    const huge = "word ".repeat(2000);
    const ex = buildMemberExcerpt(meta("Big"), `---\ntitle: Big\n---\n\n${huge}`);
    expect(ex.length).toBeLessThanOrEqual(MEMBER_EXCERPT_MAX + 5);
    expect(ex).toContain("[…]");
  });
});

describe("harvestMembers + budget", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "synth-harvest-"));
    __resetWikiCacheForTest();
  });
  afterEach(async () => {
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("later members go title-only once the budget is exhausted", async () => {
    // Each member ~ (MEMBER_EXCERPT_MAX) chars ⇒ budget (14000) covers ~11.
    const big = "sentence ".repeat(400);
    const members: string[] = [];
    for (let i = 0; i < 20; i++) {
      const rel = `plans/p${i}.md`;
      await writePage(root, rel, `Plan ${i}`, big);
      members.push(normalizeRelPath(rel));
    }
    const index = (await getWikiIndex({ root, refresh: true }))!;
    const harvested = await harvestMembers(index, members);
    expect(harvested.length).toBe(20);
    // Every member is present with a title; the tail carries empty excerpts.
    expect(harvested.every((m) => m.title.startsWith("Plan"))).toBe(true);
    const withBody = harvested.filter((m) => m.excerpt.length > 0).length;
    const titleOnly = harvested.filter((m) => m.excerpt.length === 0).length;
    expect(withBody).toBeGreaterThan(0);
    expect(titleOnly).toBeGreaterThan(0);
    const total = harvested.reduce((n, m) => n + m.excerpt.length, 0);
    // Overall budget respected (allow one member's overshoot on the boundary).
    expect(total).toBeLessThanOrEqual(SYNTHESIS_EXCERPT_BUDGET + MEMBER_EXCERPT_MAX);
  });
});

describe("synthesisShapeGate", () => {
  let root: string;
  let index: WikiIndex;
  let members: string[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "synth-gate-"));
    __resetWikiCacheForTest();
    await writePage(root, "plans/alpha.md", "Alpha Plan", "Body.");
    await writePage(root, "plans/beta.md", "Beta Plan", "Body.");
    await writePage(root, "plans/gamma.md", "Gamma Plan", "Body.");
    index = (await getWikiIndex({ root, refresh: true }))!;
    members = ["plans/alpha.md", "plans/beta.md", "plans/gamma.md"].map(normalizeRelPath);
  });
  afterEach(async () => {
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const good = `---
type: blog
title: The Trilogy Saga
description: How three plans came together.
tags: [saga]
---

# The Trilogy Saga

We started with [[Alpha Plan]], then [[Beta Plan]], and finally [[Gamma Plan]].

## Sources
- [[Alpha Plan]]
- [[Beta Plan]]
- [[Gamma Plan]]
`;
  const target = "blogs/2026-07-24-the-trilogy-saga.mdx";

  test("accepts a well-formed blog draft that wikilinks every member", () => {
    const r = synthesisShapeGate(good, { wikiDir: root, index, targetPath: target, memberRelPaths: members });
    expect(r.ok).toBe(true);
  });

  test("rejects a draft missing a member wikilink", () => {
    const draft = good.replace("- [[Gamma Plan]]\n", "").replace(", and finally [[Gamma Plan]]", "");
    const r = synthesisShapeGate(draft, { wikiDir: root, index, targetPath: target, memberRelPaths: members });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not wikilinked");
  });

  test("rejects a non-blog type", () => {
    const r = synthesisShapeGate(good.replace("type: blog", "type: concept"), {
      wikiDir: root,
      index,
      targetPath: target,
      memberRelPaths: members,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not");
  });

  test("rejects a target outside blogs/", () => {
    const r = synthesisShapeGate(good, {
      wikiDir: root,
      index,
      targetPath: "concepts/thing.mdx",
      memberRelPaths: members,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("path confinement");
  });

  test("rejects a draft with no frontmatter", () => {
    const r = synthesisShapeGate("# just a heading", {
      wikiDir: root,
      index,
      targetPath: target,
      memberRelPaths: members,
    });
    expect(r.ok).toBe(false);
  });
});

describe("buildSynthesisPrompt", () => {
  test("lists every member title + inlines excerpts", () => {
    const members: SynthesisMember[] = [
      { relPath: "plans/a.md", title: "Alpha Plan", excerpt: "Title: Alpha Plan\nLead: did A" },
      { relPath: "plans/b.md", title: "Beta Plan", excerpt: "" },
    ];
    const p = buildSynthesisPrompt({ wikiName: "mimir", label: "The Saga", members, today: "2026-07-24" });
    expect(p).toContain("Alpha Plan");
    expect(p).toContain("Beta Plan");
    expect(p).toContain('type:" MUST be "blog"');
    expect(p).toContain("content omitted for length"); // beta had no excerpt
    expect(p).toContain("mimir");
  });
});

describe("draftAndPersistSynthesis", () => {
  let root: string;
  let index: WikiIndex;
  const wiki: WikiRegistryEntry = {
    name: "mimir",
    root: "",
    source: "extra",
    collections: ["mimir"],
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "synth-orch-"));
    __resetWikiCacheForTest();
    await writePage(root, "plans/alpha.md", "Alpha Plan", "The alpha arc.");
    await writePage(root, "plans/beta.md", "Beta Plan", "The beta arc.");
    await writePage(root, "plans/gamma.md", "Gamma Plan", "The gamma arc.");
    index = (await getWikiIndex({ root, refresh: true }))!;
    wiki.root = root;
  });
  afterEach(async () => {
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const fakeResult = (text: string): ClaudeExecResult =>
    ({ result: text, model: "m", inputTokens: 1, outputTokens: 1, numTurns: 1, costUsd: 0, toolCalls: [] }) as unknown as ClaudeExecResult;

  const goodDraft = `---
type: blog
title: The Alpha-Gamma Story
description: A saga.
tags: [saga]
---

# The Alpha-Gamma Story

Across [[Alpha Plan]], [[Beta Plan]] and [[Gamma Plan]] we learned a lot.

## Sources
- [[Alpha Plan]]
- [[Beta Plan]]
- [[Gamma Plan]]
`;

  test("persists a synthesis proposal with wiki_name, blogs/ target, member source_docs + related_pages", async () => {
    const members = ["plans/alpha.md", "plans/beta.md", "plans/gamma.md"].map(normalizeRelPath);
    let captured: InsertWikiProposalParams | undefined;
    const res = await draftAndPersistSynthesis({
      wiki,
      members,
      label: "The Alpha-Gamma Story",
      index,
      config: { tracingEnabled: false } as never,
      botConfig: { name: "jarvis", dir: root, connector: "claude-cli" } as never,
      oneShot: (async () => fakeResult(goodDraft)) as never,
      tracer: fakeTracer(),
      insert: async (p) => {
        captured = p;
        return { id: "prop-1", ...p } as unknown as WikiProposal;
      },
      now: () => Date.parse("2026-07-24T12:00:00Z"),
    });

    expect(res.ok).toBe(true);
    expect(captured).toBeDefined();
    expect(captured!.kind).toBe("synthesis");
    expect(captured!.mode).toBe("create");
    expect(captured!.wikiName).toBe("mimir");
    expect(captured!.botName).toBe("jarvis");
    expect(captured!.topicKey).toBe("the-alpha-gamma-story");
    expect(captured!.targetPath).toMatch(/^blogs\/2026-07-24-the-alpha-gamma-story\.mdx$/);
    // source_docs are shaped objects, never bare relPaths.
    expect(captured!.sourceDocs).toHaveLength(3);
    expect(captured!.sourceDocs[0]).toMatchObject({ collection: "mimir", url: "" });
    expect(captured!.sourceDocs.map((d) => d.title).sort()).toEqual([
      "Alpha Plan",
      "Beta Plan",
      "Gamma Plan",
    ]);
    // related_pages carry title + relPath for apply-time See-also wiring.
    expect(captured!.relatedPages).toHaveLength(3);
    expect(captured!.relatedPages![0]).toHaveProperty("relPath");
  });

  test("returns a shape-gate failure (no persist) when a member is not wikilinked", async () => {
    const members = ["plans/alpha.md", "plans/beta.md", "plans/gamma.md"].map(normalizeRelPath);
    const badDraft = goodDraft.replace("- [[Gamma Plan]]\n", "").replace(" and [[Gamma Plan]]", "");
    let inserted = false;
    const res = await draftAndPersistSynthesis({
      wiki,
      members,
      label: "The Alpha-Gamma Story",
      index,
      config: { tracingEnabled: false } as never,
      botConfig: { name: "jarvis", dir: root, connector: "claude-cli" } as never,
      oneShot: (async () => fakeResult(badDraft)) as never,
      tracer: fakeTracer(),
      insert: async (p) => {
        inserted = true;
        return { id: "x", ...p } as unknown as WikiProposal;
      },
    });
    expect(res.ok).toBe(false);
    expect(inserted).toBe(false);
    if (!res.ok) expect(res.reason).toContain("shape-gate");
  });
});
