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
  runSynthesisOneShot,
  SYNTHESIS_ONESHOT_IDENTITY,
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
import { FENCED_EXCLUDED_TOOLS } from "../core/fenced-one-shot.ts";
import { agentStatus } from "../observability/agent-status.ts";

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

/**
 * The tool fence on the synthesis one-shot.
 *
 * The product is the call's RETURN TEXT, so a reachable `Write` is a way to LOSE
 * the draft: the model writes the `.mdx`, replies "File created successfully at:
 * …", `synthesisShapeGate` rejects it ("no frontmatter fence"), nothing persists,
 * and the stray file lands under the bot folder. Same escape the source drafter
 * measured (28 of 101 runs reached for Write/Edit) — this seam ran unfenced.
 */
describe("runSynthesisOneShot — tool fence + observability identity", () => {
  afterEach(() => agentStatus.clearRequest());

  const bot = (over: Record<string, unknown> = {}) =>
    ({ name: "jarvis", connector: "claude-sdk", model: "sonnet", ...over }) as never;

  /** Recording tracer — records every `start` attribute set. */
  function recordingTracer(sink: Record<string, unknown>[]): Tracer {
    return {
      traceId: "trace-1",
      start: (_label: string, attrs?: Record<string, unknown>) => {
        sink.push(attrs ?? {});
        return "span-1";
      },
      end: () => 1,
      finish: () => {},
      addChildSpan: () => "child",
      addSubSpan: () => "sub",
      spanStartedAt: () => new Date(),
    } as unknown as Tracer;
  }

  /** Runs the seam; hands back the botConfig + options the connector actually saw. */
  async function run(botConfig: never, label = "The Alpha-Gamma Story") {
    const startAttrs: Record<string, unknown>[] = [];
    let seenBot: Record<string, unknown> | undefined;
    let seenOpts: Record<string, unknown> | undefined;
    await runSynthesisOneShot({
      label,
      prompt: "draft it",
      config: { tracingEnabled: false, tracingCaptureToolOutputs: false } as never,
      botConfig,
      tracer: recordingTracer(startAttrs),
      oneShot: (async (_p: string, _c: unknown, b: unknown, o: unknown) => {
        seenBot = b as Record<string, unknown>;
        seenOpts = o as Record<string, unknown>;
        return { result: "---\ntype: blog\n---\n", inputTokens: 1, outputTokens: 1, numTurns: 1 };
      }) as never,
    });
    if (!seenBot) throw new Error("one-shot seam was never called");
    return { seenBot, seenOpts, startAttrs };
  }

  test("excludes every file-writing tool on the model call", async () => {
    const { seenBot } = await run(bot());
    for (const tool of FENCED_EXCLUDED_TOOLS) {
      expect(seenBot.excludedTools as string[]).toContain(tool);
    }
  });

  test("keeps the bot's own exclusions and never duplicates an overlap", async () => {
    const { seenBot } = await run(bot({ excludedTools: ["mcp__gmail", "Write"] }));
    const excluded = seenBot.excludedTools as string[];
    expect(excluded).toContain("mcp__gmail");
    expect(excluded.filter((t) => t === "Write").length).toBe(1);
  });

  test("does not mutate the shared discovered botConfig", async () => {
    // Every `discoverAllBots()` caller holds THIS object — an in-place union would
    // fence the bot's chat turns too.
    const botConfig = bot({ excludedTools: ["mcp__gmail"] });
    const before = structuredClone(botConfig);
    await run(botConfig);
    expect(botConfig).toEqual(before);
  });

  test("leaves connector and model identity untouched", async () => {
    const { seenBot } = await run(bot());
    expect(seenBot.name).toBe("jarvis");
    expect(seenBot.connector).toBe("claude-sdk");
    expect(seenBot.model).toBe("sonnet");
  });

  // Moving onto the shared seam must not renumber the vertical: these strings are
  // what `/traces`, `/agents` Recent and the gate deep-link key off, and existing
  // rows carry them.
  test("pins the six observability strings, wired end to end", async () => {
    expect(SYNTHESIS_ONESHOT_IDENTITY).toEqual({
      traceName: "consolidation:draft",
      platform: "capture",
      kind: "capture",
      phase: "drafting",
      runNamePrefix: "Synthesis page: ",
      sourcePage: "/wiki/gardener",
      source: "consolidation-draft",
    });

    const { startAttrs, seenOpts } = await run(bot(), "Alpha Saga");
    const row = agentStatus
      .getRecentCompleted()
      .find((r) => r.name === "Synthesis page: Alpha Saga");
    expect(row).toBeDefined();
    expect(row!.kind).toBe("capture");
    expect(row!.phase).toBe("drafting");
    expect(row!.sourcePage).toBe("/wiki/gardener");
    expect(startAttrs[0]!.source).toBe("consolidation-draft");
    expect(startAttrs[0]!.title).toBe("Alpha Saga");
    // The 8k cap survived the move (claude-sdk supports a thinking budget).
    expect(seenOpts!.thinkingMaxTokens).toBe(8000);
  });
});
