import { test, expect } from "bun:test";
import {
  checkConsolidationGardener,
  rankCandidates,
  type ConsolidationGardenerDeps,
} from "./consolidation-gardener.ts";
import type { Watcher } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";
import type { WikiIndex } from "../wiki/store.ts";
import type { SemanticOverlay } from "../wiki/atlas-semantic.ts";
import { synthesisTopicKey } from "../dashboard/views/components/wiki-atlas-semantic.ts";
import type { DraftSynthesisResult } from "../gardener/synthesis-drafter.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WIKI = "mimir";

function watcher(config: Record<string, unknown> = { wiki: WIKI }): Watcher {
  return {
    id: "w1",
    userId: "u1",
    botName: "jarvis",
    name: "Consolidation Gardener",
    type: "consolidation-gardener",
    config,
    intervalMs: 604_800_000,
    enabled: true,
    lastRunAt: null,
    lastNotifiedIds: [],
    forceNextRun: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

const bot: BotConfig = { name: "jarvis", cwd: "/tmp/jarvis" } as unknown as BotConfig;

function entry(over: Partial<WikiRegistryEntry> = {}): WikiRegistryEntry {
  return {
    name: WIKI,
    root: "/tmp/mimir",
    source: "extra",
    collections: ["wiki"],
    ...over,
  } as WikiRegistryEntry;
}

const fakeIndex = {} as unknown as WikiIndex;

/**
 * Build an overlay whose real `computeClusters` yields ONE synthesis-candidate:
 * three narrative-type ("plan") pages fully connected above the default 0.98
 * threshold, tagged so the cluster gets a stable label.
 */
function candidateOverlay(members: string[] = ["a.md", "b.md", "c.md"], tag = "rag"): SemanticOverlay {
  const edges: [string, string, number][] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      edges.push([members[i]!, members[j]!, 0.99]);
    }
  }
  const nodeType: Record<string, string> = {};
  const nodeTags: Record<string, string[]> = {};
  for (const m of members) {
    nodeType[m] = "plan"; // narrative
    nodeTags[m] = [tag];
  }
  return { edges, communities: [], nodeCommunity: {}, nodeType, nodeTags };
}

/** The label real computeClusters will produce for the fixture above. */
const CANDIDATE_LABEL = "rag";
const CANDIDATE_TOPIC = synthesisTopicKey(CANDIDATE_LABEL);

function deps(over: Partial<ConsolidationGardenerDeps> = {}): ConsolidationGardenerDeps {
  const drafted: DraftSynthesisResult = {
    ok: true,
    proposal: { id: "p1" } as never,
    topicKey: CANDIDATE_TOPIC,
  };
  return {
    findWikiEntry: () => entry(),
    getBots: () => [bot],
    getIndex: async () => fakeIndex,
    getOverlay: async () => candidateOverlay(),
    getLiveOrAppliedTopics: async () => [],
    draft: async () => drafted,
    knowledgeApiUrl: "http://localhost:8321",
    config: {} as Config,
    ...over,
  };
}

// ── rankCandidates (pure) ──────────────────────────────────────────────────────

test("rankCandidates: size DESC, then narrative-share DESC, then id ASC", () => {
  const overlay: SemanticOverlay = {
    edges: [],
    communities: [],
    nodeCommunity: {},
    nodeType: { a: "plan", b: "plan", c: "concept", x: "plan", y: "plan", z: "plan" },
    nodeTags: {},
  };
  const clusters = [
    { id: "small-hi", members: ["x", "y", "z"], size: 3, label: "L1", candidate: true, tooBroad: false },
    { id: "big", members: ["a", "b", "c", "d"], size: 4, label: "L2", candidate: true, tooBroad: false },
  ];
  const ranked = rankCandidates(clusters, overlay);
  // Size 4 wins outright over size 3.
  expect(ranked[0]!.cluster.id).toBe("big");
});

// ── checkConsolidationGardener ──────────────────────────────────────────────────

test("drafts a fresh candidate cluster and alerts with a per-run-unique id", async () => {
  const draftCalls: string[] = [];
  const alerts = await checkConsolidationGardener(watcher(), bot, undefined, {
    ...deps(),
    draft: async (opts) => {
      draftCalls.push(opts.label);
      return { ok: true, proposal: { id: "p1" } as never, topicKey: CANDIDATE_TOPIC };
    },
  });
  expect(draftCalls).toHaveLength(1);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]!.source).toBe("consolidation-gardener");
  expect(alerts[0]!.id).toContain("p1");
  expect(alerts[0]!.summary).toContain("/wiki/gardener?wiki=mimir");
});

test("PRIMARY dedup: a cluster already drafted/applied is SKIPPED (no draft, no alert)", async () => {
  let drafted = 0;
  const alerts = await checkConsolidationGardener(watcher(), bot, undefined, {
    ...deps(),
    getLiveOrAppliedTopics: async () => [CANDIDATE_TOPIC], // the only candidate is already live
    draft: async () => {
      drafted++;
      return { ok: true, proposal: { id: "p1" } as never, topicKey: CANDIDATE_TOPIC };
    },
  });
  expect(drafted).toBe(0);
  expect(alerts).toHaveLength(0);
});

test("no-alert on zero drafts (draft returns a swallowed dedup no-op)", async () => {
  const alerts = await checkConsolidationGardener(watcher(), bot, undefined, {
    ...deps(),
    draft: async () => ({ ok: true, proposal: null, topicKey: CANDIDATE_TOPIC }),
  });
  expect(alerts).toHaveLength(0);
});

test("no-alert when every draft fails the shape-gate", async () => {
  const alerts = await checkConsolidationGardener(watcher(), bot, undefined, {
    ...deps(),
    draft: async () => ({ ok: false, reason: "shape-gate: empty body", topicKey: CANDIDATE_TOPIC }),
  });
  expect(alerts).toHaveLength(0);
});

test("cap: capPerRun bounds the number of drafts", async () => {
  // Two disjoint candidate clusters; cap = 1 ⇒ only one draft.
  const cluster1 = candidateOverlay(["a.md", "b.md", "c.md"], "rag");
  const cluster2 = candidateOverlay(["x.md", "y.md", "z.md"], "agents");
  const merged: SemanticOverlay = {
    edges: [...cluster1.edges, ...cluster2.edges],
    communities: [],
    nodeCommunity: {},
    nodeType: { ...cluster1.nodeType, ...cluster2.nodeType },
    nodeTags: { ...cluster1.nodeTags, ...cluster2.nodeTags },
  };
  let drafted = 0;
  const alerts = await checkConsolidationGardener(
    watcher({ wiki: WIKI, capPerRun: 1 }),
    bot,
    undefined,
    {
      ...deps(),
      getOverlay: async () => merged,
      draft: async (opts) => {
        drafted++;
        return { ok: true, proposal: { id: `p${drafted}` } as never, topicKey: synthesisTopicKey(opts.label) };
      },
    },
  );
  expect(drafted).toBe(1);
  expect(alerts).toHaveLength(1);
});

test("skip WITHOUT alert: no registry entry", async () => {
  const alerts = await checkConsolidationGardener(watcher(), bot, undefined, {
    ...deps(),
    findWikiEntry: () => undefined,
  });
  expect(alerts).toHaveLength(0);
});

test("skip WITHOUT alert: wiki has no collections", async () => {
  const alerts = await checkConsolidationGardener(watcher(), bot, undefined, {
    ...deps(),
    findWikiEntry: () => entry({ collections: [] }),
  });
  expect(alerts).toHaveLength(0);
});

test("skip WITHOUT alert: huginn overlay unavailable (non-sticky)", async () => {
  const alerts = await checkConsolidationGardener(watcher(), bot, undefined, {
    ...deps(),
    getOverlay: async () => null,
  });
  expect(alerts).toHaveLength(0);
});

test("skip WITHOUT alert: no config.wiki", async () => {
  const alerts = await checkConsolidationGardener(watcher({}), bot, undefined, deps());
  expect(alerts).toHaveLength(0);
});

test("skip WITHOUT alert: no synthesis bot resolves", async () => {
  const alerts = await checkConsolidationGardener(watcher(), bot, undefined, {
    ...deps(),
    getBots: () => [], // resolveWikiSynthesisBot → { bot: undefined }
  });
  expect(alerts).toHaveLength(0);
});
