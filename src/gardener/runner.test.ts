import { test, expect, describe } from "bun:test";
import { runGardener, type GardenerDeps, type GardenerProgress } from "./runner.ts";
import type { WikiProposal, InsertWikiProposalParams } from "../db/wiki-proposals.ts";
import type { ListedDoc, RawFetchedDoc } from "./types.ts";
import type { WikiIndex, WikiPageMeta } from "../wiki/store.ts";

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
    recentlyRejectedTopicKeys: async () => [],
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
        containedLinks: params.containedLinks ?? null,
        relatedPages: params.relatedPages ?? null,
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

  test("all-http source urls → no pending-ingestion callout (byte-identical draft)", async () => {
    const { deps, inserted } = makeDeps();
    await runGardener(deps);
    expect(inserted).toHaveLength(1);
    // Common case: every doc has a real https URL → the draft is unchanged.
    expect(inserted[0]!.draft).not.toContain("Source pending ingestion");
    expect(inserted[0]!.draft).toBe(validDraft());
  });

  test("file:// source url is filtered from sources and gets a pending-ingestion callout", async () => {
    const bodies: Record<string, RawFetchedDoc> = {
      [IDS[0]!]: {
        text: "# Doc a\n\nAbout context compaction.",
        metadata: { url: "file:///Users/rune/source/private/huginn/data/sources/a.md" },
      },
      [IDS[1]!]: { text: "# Doc b\n\nAbout context compaction.", metadata: { url: `https://${IDS[1]}` } },
      [IDS[2]!]: { text: "# Doc c\n\nAbout context compaction.", metadata: { url: `https://${IDS[2]}` } },
    };
    const { deps, inserted } = makeDeps({ fetchDoc: async (_c, id) => bodies[id] ?? null });
    await runGardener(deps);
    expect(inserted).toHaveLength(1);

    // The raw file:// url survives in source_docs (provenance) …
    const fileDoc = inserted[0]!.sourceDocs.find((d) => d.url.startsWith("file://"));
    expect(fileDoc).toBeDefined();

    // … but never leaks into the rendered draft body, and a single callout lists it.
    const draft = inserted[0]!.draft;
    expect(draft).not.toContain("file://");
    expect(draft.match(/> \[!note\] Source pending ingestion/g)).toHaveLength(1);
    expect(draft).toContain(`> \`youtube-summaries/${IDS[0]}\` has no public URL yet.`);
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
          sourceDocs: params.sourceDocs, rationale: params.rationale ?? null,
          containedLinks: params.containedLinks ?? null, relatedPages: params.relatedPages ?? null, status: "draft",
          createdAt: NOW, resolvedAt: null,
        }),
      }).deps,
    );
    expect(c[0]!.id).toBe("wiki-gardener:42");
    expect(c[0]!.id).not.toBe(a[0]!.id);
    expect(b).toHaveLength(1);
  });

  test("searchRelated hits are inlined into the draft prompt", async () => {
    let captured = "";
    const { deps } = makeDeps({
      callDraft: async (prompt) => {
        captured = prompt;
        return validDraft();
      },
      searchRelated: async () => [{ title: "Sibling Page", snippet: "already covers this" }],
    });
    await runGardener(deps);
    expect(captured).toContain("POSSIBLY-RELATED EXISTING PAGES");
    expect(captured).toContain("### Sibling Page");
  });

  test("absent searchRelated seam → no POSSIBLY-RELATED block (silent no-op)", async () => {
    let captured = "";
    const { deps } = makeDeps({
      callDraft: async (prompt) => {
        captured = prompt;
        return validDraft();
      },
      // no searchRelated
    });
    await runGardener(deps);
    expect(captured).not.toContain("BEGIN POSSIBLY-RELATED EXISTING PAGES");
  });

  test("searchRelated error degrades to no block, never aborts the draft", async () => {
    let captured = "";
    const { deps, inserted } = makeDeps({
      callDraft: async (prompt) => {
        captured = prompt;
        return validDraft();
      },
      searchRelated: async () => {
        throw new Error("huginn down");
      },
    });
    const alerts = await runGardener(deps);
    expect(captured).not.toContain("BEGIN POSSIBLY-RELATED EXISTING PAGES");
    expect(inserted).toHaveLength(1); // draft still persisted
    expect(alerts).toHaveLength(1);
  });

  test("searchRelated hits are persisted as related_pages, titles resolved to relPaths", async () => {
    const sibling: WikiPageMeta = {
      name: "Sibling Page",
      title: "Sibling Page",
      type: "concept",
      domain: "ai",
      tags: [],
      aliases: [],
      relPath: "concepts/Sibling Page.md",
    };
    const index: WikiIndex = {
      pages: [sibling],
      outgoing: new Map(),
      backlinks: new Map(),
      resolve: (t) => (t.toLowerCase() === "sibling page" ? sibling : undefined),
      resolveRelPath: () => undefined,
      scannedAt: NOW,
      root: WIKI,
    };
    const { deps, inserted } = makeDeps({
      getWikiIndex: async () => index,
      searchRelated: async () => [
        { title: "Sibling Page", snippet: "resolves" },
        { title: "Unknown Page", snippet: "does not resolve" },
      ],
    });
    await runGardener(deps);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.relatedPages).toEqual([
      { title: "Sibling Page", relPath: "concepts/Sibling Page.md" },
      { title: "Unknown Page" },
    ]);
  });

  test("no searchRelated seam → related_pages is [] (not NULL — a fresh, empty run)", async () => {
    const { deps, inserted } = makeDeps(); // no searchRelated
    await runGardener(deps);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.relatedPages).toEqual([]);
  });

  test("unresolved [[source page]] in frontmatter is replaced with source URLs at persist time", async () => {
    const draftWithPhantom =
      `---\ntype: concept\ntitle: Context Compaction\naliases: []\ncreated: 2026-07-08\nupdated: 2026-07-08\ntags: []\nsources: [[[Phantom Source]]]\n---\n\n# Context Compaction\n\nLead.\n\n## See also\n- [[X]]`;
    const { deps, inserted } = makeDeps({ callDraft: async () => draftWithPhantom });
    await runGardener(deps);
    expect(inserted).toHaveLength(1);
    // The phantom wikilink is gone; the cluster's real source_docs URLs are in.
    expect(inserted[0]!.draft).not.toContain("[[Phantom Source]]");
    expect(inserted[0]!.draft).toContain("https://2026-07-07_a.md");
  });

  test("unresolvable body [[wikilink]] is de-linked at persist time; contained_links persisted", async () => {
    // validDraft()'s body has `[[X]]` in the See-also section. With a real index
    // where X doesn't resolve, the persist-time guard de-links it to plain text.
    const index: WikiIndex = {
      pages: [],
      outgoing: new Map(),
      backlinks: new Map(),
      resolve: () => undefined, // nothing resolves ⇒ [[X]] is a phantom
      resolveRelPath: () => undefined,
      scannedAt: NOW,
      root: WIKI,
    };
    const { deps, inserted } = makeDeps({ getWikiIndex: async () => index });
    await runGardener(deps);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.draft).not.toContain("[[X]]");
    expect(inserted[0]!.draft).toContain("**X**");
    expect(inserted[0]!.containedLinks).toEqual({ delinked: ["X"] });
  });

  test("null wiki index → body-link containment skipped (link left intact, no report)", async () => {
    // The default makeDeps has getWikiIndex → null: containment must not run (an
    // index outage must not de-link a whole draft), so [[X]] survives verbatim.
    const { deps, inserted } = makeDeps();
    await runGardener(deps);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.draft).toContain("[[X]]");
    expect(inserted[0]!.containedLinks ?? null).toBeNull();
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

  test("skips clusters whose topic was RECENTLY rejected (within the TTL window)", async () => {
    // A fresh rejection is in both the all-rejections set and the recent set, so
    // the cluster is skipped — nothing drafted.
    const { deps, inserted } = makeDeps({
      rejectedTopicKeys: async () => ["context-compaction"],
      recentlyRejectedTopicKeys: async () => ["context-compaction"],
    });
    const alerts = await runGardener(deps);
    expect(inserted).toHaveLength(0);
    expect(alerts).toEqual([]);
  });

  test("an EXPIRED rejection reaches the cluster-prompt hint but NOT the skip set (re-proposable)", async () => {
    // The topic was rejected long ago (in the all-rejections set that feeds the
    // hint) but is OUTSIDE the TTL window (absent from the recent skip set). It
    // must be re-proposable: the draft is inserted, AND the expired label still
    // appears in the cluster prompt so the model reuses the topicKey rather than
    // coining a near-synonym.
    let clusterPrompt = "";
    const { deps, inserted } = makeDeps({
      rejectedTopicKeys: async () => ["context-compaction"],
      recentlyRejectedTopicKeys: async () => [],
      callCluster: async (prompt) => {
        clusterPrompt = prompt;
        return JSON.stringify([
          { topicKey: "context-compaction", kind: "concept", domain: "ai", label: "Context Compaction", docIds: KEYS, rationale: "clusters" },
        ]);
      },
    });
    const alerts = await runGardener(deps);
    // Hint saw the expired rejection…
    expect(clusterPrompt).toContain("context-compaction");
    // …but the skip set did not, so the topic was re-proposed.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.topicKey).toBe("context-compaction");
    expect(alerts).toHaveLength(1);
  });

  test("existing concept/entity titles reach the cluster prompt; exact title match becomes an update", async () => {
    const page = (over: Partial<WikiPageMeta>): WikiPageMeta => ({
      name: "x", title: "X", type: "concept", domain: "ai", tags: [], aliases: [], relPath: "concepts/x.md",
      ...over,
    });
    const index: WikiIndex = {
      pages: [
        page({ name: "Context Compaction", title: "Context Compaction", aliases: ["Compaction"], relPath: "concepts/Context Compaction.md" }),
        page({ name: "Some Video", title: "Some Video Title", type: "source", relPath: "sources/Some Video.md" }),
      ],
      outgoing: new Map(),
      backlinks: new Map(),
      resolve: () => undefined,
      resolveRelPath: () => undefined,
      scannedAt: NOW,
      root: WIKI,
    };
    let clusterPrompt = "";
    const { deps, inserted } = makeDeps({
      getWikiIndex: async () => index,
      callCluster: async (prompt) => {
        clusterPrompt = prompt;
        // The model labels the cluster with the existing page's exact title.
        return JSON.stringify([
          { topicKey: "context-compaction", kind: "concept", domain: "ai", label: "Context Compaction", docIds: KEYS, rationale: "clusters" },
        ]);
      },
      readWikiFile: async () => "# Context Compaction\n\nExisting body.",
    });
    await runGardener(deps);

    // Concept titles (with aliases) are inlined; source-page titles are not.
    expect(clusterPrompt).toContain("Context Compaction (aliases: Compaction)");
    expect(clusterPrompt).not.toContain("Some Video Title");
    // The exact-title label resolves to an UPDATE of the canonical page.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.mode).toBe("update");
    expect(inserted[0]!.targetPath).toBe("concepts/Context Compaction.md");
    expect(inserted[0]!.baseHash).toBeTruthy();
  });

  test("cross-kind title match re-kinds the cluster and updates the canonical page", async () => {
    const index: WikiIndex = {
      pages: [
        {
          name: "Context Compaction", title: "Context Compaction", type: "concept", domain: "ai",
          tags: [], aliases: [], relPath: "concepts/Context Compaction.md",
        },
      ],
      outgoing: new Map(),
      backlinks: new Map(),
      resolve: () => undefined,
      resolveRelPath: () => undefined,
      scannedAt: NOW,
      root: WIKI,
    };
    let draftPrompt = "";
    const { deps, inserted } = makeDeps({
      getWikiIndex: async () => index,
      // The model classifies the cluster as an ENTITY, but the wiki's page is a concept.
      callCluster: async () =>
        JSON.stringify([
          { topicKey: "context-compaction", kind: "entity", domain: "ai", label: "Context Compaction", docIds: KEYS, rationale: "clusters" },
        ]),
      callDraft: async (prompt) => {
        draftPrompt = prompt;
        return validDraft(); // type: concept — matches the ADOPTED kind
      },
      readWikiFile: async () => "# Context Compaction\n\nExisting body.",
    });
    await runGardener(deps);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.mode).toBe("update");
    expect(inserted[0]!.kind).toBe("concept");
    expect(inserted[0]!.targetPath).toBe("concepts/Context Compaction.md");
    // The draft prompt asked for the page's kind, not the model's guess.
    expect(draftPrompt).toContain(`The page's "type:" MUST be "concept"`);
  });

  test("a create draft hijacking another page's alias is persisted with that alias stripped", async () => {
    const index: WikiIndex = {
      pages: [
        {
          name: "Context Engineering", title: "Context Engineering", type: "concept", domain: "ai",
          tags: [], aliases: [], relPath: "concepts/Context Engineering.md",
        },
      ],
      outgoing: new Map(),
      backlinks: new Map(),
      resolve: () => undefined,
      resolveRelPath: () => undefined,
      scannedAt: NOW,
      root: WIKI,
    };
    const hijackingDraft = validDraft().replace(
      "aliases: []",
      "aliases: [Context Engineering, Compaction Tricks]",
    );
    const { deps, inserted } = makeDeps({
      getWikiIndex: async () => index,
      callDraft: async () => hijackingDraft,
    });
    await runGardener(deps);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.draft).toContain("aliases: [Compaction Tricks]");
    expect(inserted[0]!.draft).not.toContain("Context Engineering,");
  });
});

// ── Progress + soft-cancel seams (backlog drain) ─────────────────────────────

/**
 * A 2-cluster fixture (each cluster 3 docs). Both drafts share the same valid
 * body — enough to exercise the draft loop twice for the progress/cancel seams.
 */
function makeTwoClusterDeps(overrides: Partial<GardenerDeps> = {}): {
  deps: GardenerDeps;
  inserted: InsertWikiProposalParams[];
  c1Keys: string[];
  c2Keys: string[];
} {
  const inserted: InsertWikiProposalParams[] = [];
  let seq = 0;
  const ids = ["a", "b", "c", "d", "e", "f"].map((x) => `2026-07-07_${x}.md`);
  const keys = ids.map((id) => `youtube-summaries/${id}`);
  const c1Keys = keys.slice(0, 3);
  const c2Keys = keys.slice(3, 6);
  const bodies: Record<string, RawFetchedDoc> = Object.fromEntries(
    ids.map((id) => [id, { text: `# Doc ${id}\n\nAbout context compaction.`, metadata: { url: `https://${id}` } }]),
  );

  const deps: GardenerDeps = {
    botName: "jarvis",
    wikiDir: WIKI,
    collections: ["youtube-summaries"],
    minClusterSize: 3,
    lookbackDays: 14,
    maxProposalsPerRun: 8,
    draftTimeoutMs: 1000,
    now: () => NOW,
    listDocs: async () => ids.map((id) => ({ id })),
    fetchDoc: async (_c, id) => bodies[id] ?? null,
    callCluster: async () =>
      JSON.stringify([
        { topicKey: "topic-one", kind: "concept", domain: "ai", label: "Topic One", docIds: c1Keys, rationale: "r" },
        { topicKey: "topic-two", kind: "concept", domain: "ai", label: "Topic Two", docIds: c2Keys, rationale: "r" },
      ]),
    loadInterestProfile: async () => null,
    getWikiIndex: async () => null,
    callDraft: async () => validDraft(),
    readWikiFile: async () => null,
    liveTopicKeys: async () => [],
    rejectedTopicKeys: async () => [],
    recentlyRejectedTopicKeys: async () => [],
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
        containedLinks: params.containedLinks ?? null,
        relatedPages: params.relatedPages ?? null,
        status: "draft",
        createdAt: NOW,
        resolvedAt: null,
      };
      return row;
    },
    ...overrides,
  };
  return { deps, inserted, c1Keys, c2Keys };
}

describe("runGardener — progress + soft cancel", () => {
  test("onProgress reports the pipeline stages in order, with drafting k/n", async () => {
    const seen: GardenerProgress[] = [];
    const { deps } = makeTwoClusterDeps({ onProgress: (p) => seen.push({ ...p }) });
    await runGardener(deps);

    // harvest → cluster → resolve, then the pre-loop total emit, then per
    // cluster: before-draft + after-persist.
    expect(seen.map((p) => p.stage)).toEqual([
      "harvesting",
      "clustering",
      "resolving",
      "drafting", // pre-loop total emit (0/n)
      "drafting", // before c1
      "drafting", // after c1 persist
      "drafting", // before c2
      "drafting", // after c2 persist
    ]);
    const drafting = seen.filter((p) => p.stage === "drafting");
    expect(drafting.map((p) => p.draftsDone)).toEqual([0, 0, 1, 1, 2]);
    expect(drafting.every((p) => p.draftsTotal === 2)).toBe(true);
    expect(drafting[1]!.currentTopic).toBe("Topic One");
    expect(drafting[3]!.currentTopic).toBe("Topic Two");
  });

  test("shouldAbort after draft 1 → 1 persisted, no 2nd draft, onAborted has cluster 2's docs", async () => {
    let draftCalls = 0;
    let abortedKeys: string[] = [];
    const { deps, inserted, c2Keys } = makeTwoClusterDeps({
      callDraft: async () => {
        draftCalls += 1;
        return validDraft();
      },
      // Abort once the first draft has run — caught at the top of iteration 2.
      shouldAbort: () => draftCalls >= 1,
      onAborted: (keys) => {
        abortedKeys = keys;
      },
    });
    const alerts = await runGardener(deps);

    expect(draftCalls).toBe(1); // cluster 2 never drafted
    expect(inserted).toHaveLength(1);
    expect(abortedKeys.slice().sort()).toEqual([...c2Keys].sort());
    // One proposal persisted → still one alert (the run proceeds to the notify path).
    expect(alerts).toHaveLength(1);
  });

  test("a doc shared by a drafted cluster is NOT returned to the queue on cancel", async () => {
    // c2 shares c1's first doc — that shared doc already produced a proposal, so it
    // must be subtracted from the aborted set (only c2's unique docs return).
    let draftCalls = 0;
    let abortedKeys: string[] = [];
    const ids = ["a", "b", "c", "d", "e"].map((x) => `2026-07-07_${x}.md`);
    const keys = ids.map((id) => `youtube-summaries/${id}`);
    const c1 = keys.slice(0, 3); // a,b,c
    const c2 = [keys[0]!, keys[3]!, keys[4]!]; // a (shared), d, e
    const bodies: Record<string, RawFetchedDoc> = Object.fromEntries(
      ids.map((id) => [id, { text: `# ${id}\n\nBody.`, metadata: { url: `https://${id}` } }]),
    );
    const { deps } = makeTwoClusterDeps({
      listDocs: async () => ids.map((id) => ({ id })),
      fetchDoc: async (_c, id) => bodies[id] ?? null,
      callCluster: async () =>
        JSON.stringify([
          { topicKey: "t1", kind: "concept", domain: "ai", label: "T1", docIds: c1, rationale: "r" },
          { topicKey: "t2", kind: "concept", domain: "ai", label: "T2", docIds: c2, rationale: "r" },
        ]),
      callDraft: async () => {
        draftCalls += 1;
        return validDraft();
      },
      shouldAbort: () => draftCalls >= 1,
      onAborted: (k) => {
        abortedKeys = k;
      },
    });
    await runGardener(deps);
    // c2's unique docs (d, e) return; the shared doc a stays (its cluster drafted).
    expect(abortedKeys.slice().sort()).toEqual([keys[3]!, keys[4]!].sort());
    expect(abortedKeys).not.toContain(keys[0]!);
  });

  test("shouldAbort right after clustering → no drafts, onAborted has every cluster's docs", async () => {
    let draftCalls = 0;
    let abortedKeys: string[] = [];
    const total: number[] = [];
    const { deps, inserted, c1Keys, c2Keys } = makeTwoClusterDeps({
      callDraft: async () => {
        draftCalls += 1;
        return validDraft();
      },
      shouldAbort: () => true, // fires at the post-cluster checkpoint
      onAborted: (k) => {
        abortedKeys = k;
      },
      onProgress: (p) => {
        if (p.draftsTotal !== undefined) total.push(p.draftsTotal);
      },
    });
    const alerts = await runGardener(deps);
    expect(draftCalls).toBe(0);
    expect(inserted).toHaveLength(0);
    expect(alerts).toEqual([]);
    expect(abortedKeys.slice().sort()).toEqual([...c1Keys, ...c2Keys].sort());
    // The checkpoint emits draftsTotal = clusters.length so the outcome records k/n.
    expect(total).toContain(2);
  });

  test("cancel during resolve → aborts at iteration 0 with a real draftsTotal, not 0/0", async () => {
    // The cancel flag flips true AFTER the post-cluster checkpoint (first
    // shouldAbort call) but before the first draft iteration — i.e. during the
    // resolve await. The pre-loop progress emit must still carry
    // draftsTotal = resolved.length so the outcome never records 0/0.
    let abortChecks = 0;
    let abortedKeys: string[] = [];
    const totals: number[] = [];
    const { deps, inserted, c1Keys, c2Keys } = makeTwoClusterDeps({
      shouldAbort: () => ++abortChecks >= 2, // post-cluster check passes; iteration 0 aborts
      onAborted: (k) => {
        abortedKeys = k;
      },
      onProgress: (p) => {
        if (p.draftsTotal !== undefined) totals.push(p.draftsTotal);
      },
    });
    const alerts = await runGardener(deps);
    expect(inserted).toHaveLength(0);
    expect(alerts).toEqual([]);
    expect(abortedKeys.slice().sort()).toEqual([...c1Keys, ...c2Keys].sort());
    expect(totals).toContain(2); // the pre-loop emit carried the real total
  });

  test("all three seams omitted → identical behavior (one proposal, one alert)", async () => {
    const { deps, inserted } = makeTwoClusterDeps();
    const alerts = await runGardener(deps);
    // Both clusters draft + persist; no cancel path touched.
    expect(inserted).toHaveLength(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.id).toBe("wiki-gardener:1,2");
  });
});

describe("runGardener — tracer threading (one connected trace)", () => {
  // The watcher checker now reuses the runner's `watcher:wiki-gardener` span as
  // `deps.tracer` (no self-minted second root). This asserts runGardener drives
  // EVERY stage span off the single injected tracer — the structural guarantee
  // behind "one connected tree" on /traces.
  test("drives all stage spans off the injected tracer, in order", async () => {
    const started: string[] = [];
    const ended: string[] = [];
    const endAttrs: Record<string, Record<string, unknown>> = {};
    const childSpans: Array<{ parent: string; name: string }> = [];
    const tracer = {
      start: (label: string) => {
        started.push(label);
        return "id";
      },
      end: (label: string, attributes?: Record<string, unknown>) => {
        ended.push(label);
        if (attributes) endAttrs[label] = attributes;
        return 0;
      },
      addChildSpan: (parent: string, name: string) => {
        childSpans.push({ parent, name });
        return "child-id";
      },
      traceId: "trace-abc",
    } as unknown as import("../tracing/index.ts").Tracer;

    // A callDraft that stamps a `claude` child span the way the real seam does,
    // proving the child attaches under the SAME injected tracer's "draft" stage.
    const { deps } = makeDeps({
      tracer,
      callDraft: async () => {
        tracer.addChildSpan("draft", "claude", 10, { model: "m", inputTokens: 1, outputTokens: 2 });
        return validDraft();
      },
    });

    await runGardener(deps);

    expect(started).toEqual(["harvest", "cluster", "resolve", "draft"]);
    expect(ended).toEqual(expect.arrayContaining(["harvest", "cluster", "resolve", "draft"]));
    // The draft `claude` span hangs off the "draft" stage span — a child, never
    // the root — so it can never make the watcher span token-bearing.
    expect(childSpans).toEqual([{ parent: "draft", name: "claude" }]);
    // The drop tally rides the cluster span's end attributes — pin the wiring,
    // not just the pure summarizeClusterDrops fold.
    expect(endAttrs["cluster"]).toMatchObject({
      clusters_dropped: expect.any(Number),
      clusters_dropped_size: expect.any(Number),
      clusters_dropped_skip: expect.any(Number),
      clusters_dropped_topics: expect.any(String),
    });
  });

  test("runs unchanged when no tracer is injected (drain path / tracing off)", async () => {
    const { deps, inserted } = makeDeps({ tracer: undefined });
    const alerts = await runGardener(deps);
    expect(inserted).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });
});
