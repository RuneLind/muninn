import { test, expect, describe } from "bun:test";
import { runGardener, type GardenerDeps } from "./runner.ts";
import type { WikiProposal, InsertWikiProposalParams } from "../db/wiki-proposals.ts";
import type { ListedDoc, RawFetchedDoc } from "./types.ts";

const WIKI = "/tmp/wiki-root";
const NOW = Date.parse("2026-07-08T12:00:00Z");

const IDS = ["2026-07-07_a.md", "2026-07-07_b.md", "2026-07-07_c.md"];
const KEYS = IDS.map((id) => `youtube-summaries/${id}`);

function validDraft(): string {
  return `---\ntype: concept\ntitle: Context Compaction\naliases: []\ncreated: 2026-07-08\nupdated: 2026-07-08\ntags: []\nsources: []\n---\n\n# Context Compaction\n\nLead.\n\n## See also\n- [[X]]`;
}

function makeDeps(overrides: Partial<GardenerDeps> = {}): { deps: GardenerDeps; inserted: InsertWikiProposalParams[] } {
  const inserted: InsertWikiProposalParams[] = [];
  let seq = 0;
  const listed: ListedDoc[] = IDS.map((id) => ({ id }));
  const bodies: Record<string, RawFetchedDoc> = Object.fromEntries(
    IDS.map((id) => [id, { text: `# Doc ${id}\n\nAbout context compaction.`, metadata: { url: `https://${id}` } }]),
  );

  const deps: GardenerDeps = {
    botName: "jarvis",
    wikiDir: WIKI,
    collections: ["youtube-summaries"],
    minClusterSize: 3,
    lookbackDays: 14,
    maxProposalsPerRun: 3,
    draftTimeoutMs: 1000,
    now: () => NOW,
    listDocs: async () => listed,
    fetchDoc: async (_c, id) => bodies[id] ?? null,
    callCluster: async () =>
      JSON.stringify([
        { topicKey: "context-compaction", kind: "concept", domain: "ai", label: "Context Compaction", docIds: KEYS, rationale: "clusters" },
      ]),
    loadInterestProfile: async () => null,
    getWikiIndex: async () => null,
    callDraft: async () => validDraft(),
    readWikiFile: async () => null,
    liveTopicKeys: async () => [],
    rejectedTopicKeys: async () => [],
    consumedDocIds: async () => new Set(),
    insertProposal: async (params) => {
      inserted.push(params);
      seq += 1;
      const row: WikiProposal = {
        id: String(seq),
        botName: params.botName,
        topicKey: params.topicKey,
        kind: params.kind,
        mode: params.mode,
        targetPath: params.targetPath,
        baseHash: params.baseHash ?? null,
        draft: params.draft,
        sourceDocs: params.sourceDocs,
        rationale: params.rationale ?? null,
        status: "draft",
        createdAt: NOW,
        resolvedAt: null,
      };
      return row;
    },
    ...overrides,
  };
  return { deps, inserted };
}

describe("runGardener", () => {
  test("drafts, persists, and returns one alert naming the topic", async () => {
    const { deps, inserted } = makeDeps();
    const alerts = await runGardener(deps);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.mode).toBe("create");
    expect(inserted[0]!.targetPath).toBe("concepts/Context Compaction.md");
    expect(inserted[0]!.sourceDocs).toHaveLength(3);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.summary).toContain("Context Compaction");
    expect(alerts[0]!.id).toBe("wiki-gardener:1");
  });

  test("alert id is per-run-unique so repeat runs deliver", async () => {
    const a = await runGardener(makeDeps().deps);
    const b = await runGardener(makeDeps().deps);
    // Both persist proposal id "1" (independent fakes), but a real run's ids differ
    // per run; the id shape embeds them so the runner's dedup never drops run 2.
    expect(a[0]!.id).toBe("wiki-gardener:1");
    // Simulate a second run whose proposal got a different id.
    let seq = 41;
    const c = await runGardener(
      makeDeps({
        insertProposal: async (params) => ({
          id: String((seq += 1)),
          botName: params.botName, topicKey: params.topicKey, kind: params.kind, mode: params.mode,
          targetPath: params.targetPath, baseHash: params.baseHash ?? null, draft: params.draft,
          sourceDocs: params.sourceDocs, rationale: params.rationale ?? null, status: "draft",
          createdAt: NOW, resolvedAt: null,
        }),
      }).deps,
    );
    expect(c[0]!.id).toBe("wiki-gardener:42");
    expect(c[0]!.id).not.toBe(a[0]!.id);
    expect(b).toHaveLength(1);
  });

  test("drops a draft that fails the shape gate — no proposal, no alert", async () => {
    const { deps, inserted } = makeDeps({ callDraft: async () => "no frontmatter here" });
    const alerts = await runGardener(deps);
    expect(inserted).toHaveLength(0);
    expect(alerts).toEqual([]);
  });

  test("returns [] when too few docs to cluster", async () => {
    const { deps, inserted } = makeDeps({ listDocs: async () => [{ id: IDS[0]! }] });
    const alerts = await runGardener(deps);
    expect(inserted).toHaveLength(0);
    expect(alerts).toEqual([]);
  });

  test("skips clusters whose topic is already rejected", async () => {
    const { deps, inserted } = makeDeps({ rejectedTopicKeys: async () => ["context-compaction"] });
    const alerts = await runGardener(deps);
    expect(inserted).toHaveLength(0);
    expect(alerts).toEqual([]);
  });
});
