import { test, expect, describe } from "bun:test";
import {
  buildDocPageMapPrompt,
  mapExcerptOf,
  parseDocPageMap,
  slugifyTopicKey,
  mappablePages,
  mergeDocPageMappings,
  type MappablePage,
} from "./doc-page-map.ts";
import type { ResolvedCluster } from "./cluster.ts";
import type { Cluster, HarvestedDoc } from "./types.ts";
import type { WikiIndex, WikiPageMeta } from "../wiki/store.ts";

const NOW = Date.parse("2026-07-18T12:00:00Z");

function doc(id: string, title: string, text = "Body about the topic."): HarvestedDoc {
  return { key: `youtube-summaries/${id}`, collection: "youtube-summaries", id, url: `https://${id}`, title, text };
}

function page(over: Partial<WikiPageMeta>): WikiPageMeta {
  return {
    name: "x", title: "X", type: "concept", domain: "ai", tags: [], aliases: [],
    relPath: "concepts/X.md", ...over,
  };
}

function indexOf(pages: WikiPageMeta[]): WikiIndex {
  return {
    pages,
    outgoing: new Map(),
    backlinks: new Map(),
    resolve: () => undefined,
    resolveRelPath: () => undefined,
    scannedAt: NOW,
    root: "/tmp/wiki",
  };
}

// ── Prompt builder ───────────────────────────────────────────────────────────

describe("buildDocPageMapPrompt", () => {
  test("bounds docs to maxDocs, most-recent (date-prefixed id) first", () => {
    const docs = [
      doc("2026-07-01_a.md", "Old A"),
      doc("2026-07-10_b.md", "Newer B"),
      doc("2026-07-15_c.md", "Newest C"),
    ];
    const prompt = buildDocPageMapPrompt(docs, [{ title: "P", aliases: [], domain: "ai", type: "concept" }], { maxDocs: 2 });
    // Only the two newest survive the cap.
    expect(prompt).toContain("Newest C");
    expect(prompt).toContain("Newer B");
    expect(prompt).not.toContain("Old A");
  });

  test("inlines page titles + aliases + [domain/type]; frames summaries as untrusted", () => {
    const docs = [doc("2026-07-15_c.md", "Some Doc")];
    const pages: MappablePage[] = [
      { title: "AI Industry Landscape", aliases: ["AI Landscape"], domain: "ai", type: "concept" },
      { title: "Dario Amodei", aliases: [], domain: "ai", type: "entity" },
    ];
    const prompt = buildDocPageMapPrompt(docs, pages);
    expect(prompt).toContain("AI Industry Landscape (aliases: AI Landscape) [ai/concept]");
    expect(prompt).toContain("Dario Amodei [ai/entity]");
    expect(prompt).toContain("UNTRUSTED source material");
    expect(prompt).toContain("--- BEGIN SUMMARIES ---");
    // The doc's stable key is what the model must echo as docId.
    expect(prompt).toContain("ID: youtube-summaries/2026-07-15_c.md");
  });
});

// ── Parser ───────────────────────────────────────────────────────────────────

describe("parseDocPageMap", () => {
  test("parses a clean array", () => {
    const raw = `[{"docId":"c/1","pageTitle":"Foo"},{"docId":"c/2","pageTitle":"Bar"}]`;
    expect(parseDocPageMap(raw)).toEqual([
      { docId: "c/1", pageTitle: "Foo" },
      { docId: "c/2", pageTitle: "Bar" },
    ]);
  });

  test("strips markdown fences", () => {
    const raw = "```json\n[{\"docId\":\"c/1\",\"pageTitle\":\"Foo\"}]\n```";
    expect(parseDocPageMap(raw)).toEqual([{ docId: "c/1", pageTitle: "Foo" }]);
  });

  test("tolerates prose around the array", () => {
    const raw = 'Here you go:\n[{"docId":"c/1","pageTitle":"Foo"}]\nThanks!';
    expect(parseDocPageMap(raw)).toEqual([{ docId: "c/1", pageTitle: "Foo" }]);
  });

  test("drops elements missing docId or pageTitle, and non-object junk", () => {
    const raw = `[{"docId":"c/1","pageTitle":"Foo"},{"docId":"c/2"},{"pageTitle":"Bar"},null,42,{"docId":"","pageTitle":"X"}]`;
    expect(parseDocPageMap(raw)).toEqual([{ docId: "c/1", pageTitle: "Foo" }]);
  });

  test("unparseable / non-array → []", () => {
    expect(parseDocPageMap("not json at all")).toEqual([]);
    expect(parseDocPageMap('{"docId":"c/1","pageTitle":"Foo"}')).toEqual([]);
    expect(parseDocPageMap("[]")).toEqual([]);
  });
});

describe("mapExcerptOf", () => {
  test("surfaces section headings first for a multi-topic roundup", () => {
    // A daily roundup whose LEAD is narrow (one model) but whose sections span a
    // whole existing page — the headings are the breadth signal excerptOf strips.
    const doc = [
      "### Kimi K3 Rumors",
      "- Moonshot AI's Kimi K3 may have soft-launched.",
      "### Thinking Machines & Microsoft",
      "- Give away the model, sell the customization.",
      "### Nvidia & Chips",
      "- Chip supply commentary.",
    ].join("\n\n");
    const ex = mapExcerptOf(doc);
    expect(ex.startsWith("Sections: ")).toBe(true);
    expect(ex).toContain("Kimi K3 Rumors");
    expect(ex).toContain("Thinking Machines & Microsoft");
    expect(ex).toContain("Nvidia & Chips");
  });

  test("a single-heading / heading-less doc is just its lead prose (no Sections: prefix)", () => {
    const doc = "# One Topic\n\nA single focused explanation of one idea, no sub-sections.";
    const ex = mapExcerptOf(doc);
    expect(ex.startsWith("Sections: ")).toBe(false);
    expect(ex).toContain("single focused explanation");
  });

  test("caps at maxChars with an ellipsis", () => {
    const doc = "# T\n\n" + "word ".repeat(500);
    const ex = mapExcerptOf(doc, 100);
    expect(ex.length).toBeLessThanOrEqual(101);
    expect(ex.endsWith("…")).toBe(true);
  });
});

describe("slugifyTopicKey", () => {
  test("kebab-slugs a title, trimming edges", () => {
    expect(slugifyTopicKey("AI Industry Landscape")).toBe("ai-industry-landscape");
    expect(slugifyTopicKey("  Context Compaction!  ")).toBe("context-compaction");
    expect(slugifyTopicKey("Claude 3.5 & Friends")).toBe("claude-3-5-friends");
  });
  test("falls back to 'topic' for an all-symbol title", () => {
    expect(slugifyTopicKey("!!!")).toBe("topic");
  });
});

describe("mappablePages", () => {
  test("keeps concept/entity only, projecting title/aliases/domain/type", () => {
    const index = indexOf([
      page({ title: "Concept A", type: "concept", domain: "ai", aliases: ["CA"] }),
      page({ title: "Entity B", type: "entity", domain: "life" }),
      page({ title: "Some Video", type: "source" }),
    ]);
    expect(mappablePages(index)).toEqual([
      { title: "Concept A", aliases: ["CA"], domain: "ai", type: "concept" },
      { title: "Entity B", aliases: [], domain: "life", type: "entity" },
    ]);
  });
  test("null index → []", () => {
    expect(mappablePages(null)).toEqual([]);
  });
});

// ── Merge logic ──────────────────────────────────────────────────────────────

function cluster(over: Partial<Cluster>): Cluster {
  return { topicKey: "t", kind: "concept", domain: "ai", label: "T", docIds: ["youtube-summaries/x"], ...over };
}

describe("mergeDocPageMappings", () => {
  const LANDSCAPE = page({
    title: "AI Industry Landscape", type: "concept", domain: "ai",
    relPath: "concepts/AI Industry Landscape.md",
  });
  const pages = mappablePages(indexOf([LANDSCAPE]));
  const index = indexOf([LANDSCAPE]);

  test("synthesizes a 1-doc update cluster for an unclustered mapped doc", () => {
    const resolvedAll: ResolvedCluster[] = []; // pass-0 clustered nothing
    const { outcome, skipDrops } = mergeDocPageMappings(
      resolvedAll,
      [{ docId: "youtube-summaries/game.md", pageTitle: "AI Industry Landscape" }],
      { pages, index, validDocKeys: new Set(["youtube-summaries/game.md"]), skipTopicKeys: new Set() },
    );
    expect(outcome).toEqual({ mapped: 1, synthesized: 1, appended: 0, coveredSkipped: 0 });
    expect(skipDrops).toHaveLength(0);
    expect(resolvedAll).toHaveLength(1);
    const rc = resolvedAll[0]!;
    expect(rc.cluster.label).toBe("AI Industry Landscape");
    expect(rc.cluster.topicKey).toBe("ai-industry-landscape");
    expect(rc.cluster.docIds).toEqual(["youtube-summaries/game.md"]);
    expect(rc.target.mode).toBe("update");
    expect(rc.target.existingRelPath).toBe("concepts/AI Industry Landscape.md");
  });

  test("matches a page by alias, not just its title", () => {
    const aliased = page({
      title: "AI Industry Landscape", type: "concept", domain: "ai",
      aliases: ["AI Landscape"], relPath: "concepts/AI Industry Landscape.md",
    });
    const idx = indexOf([aliased]);
    const resolvedAll: ResolvedCluster[] = [];
    const { outcome } = mergeDocPageMappings(
      resolvedAll,
      [{ docId: "youtube-summaries/game.md", pageTitle: "AI Landscape" }],
      { pages: mappablePages(idx), index: idx, validDocKeys: new Set(["youtube-summaries/game.md"]), skipTopicKeys: new Set() },
    );
    expect(outcome.synthesized).toBe(1);
    expect(resolvedAll[0]!.target.existingRelPath).toBe("concepts/AI Industry Landscape.md");
  });

  test("covered-skip: a doc already in an update cluster is not duplicated", () => {
    const resolvedAll: ResolvedCluster[] = [
      {
        cluster: cluster({ topicKey: "landscape", label: "AI Industry Landscape", docIds: ["youtube-summaries/game.md"] }),
        target: { mode: "update", targetPath: "concepts/AI Industry Landscape.md", existingRelPath: "concepts/AI Industry Landscape.md" },
      },
    ];
    const { outcome } = mergeDocPageMappings(
      resolvedAll,
      [{ docId: "youtube-summaries/game.md", pageTitle: "AI Industry Landscape" }],
      { pages, index, validDocKeys: new Set(["youtube-summaries/game.md"]), skipTopicKeys: new Set() },
    );
    expect(outcome).toEqual({ mapped: 1, synthesized: 0, appended: 0, coveredSkipped: 1 });
    expect(resolvedAll).toHaveLength(1); // nothing added
    expect(resolvedAll[0]!.cluster.docIds).toEqual(["youtube-summaries/game.md"]); // not doubled
  });

  test("append-dedupe: a new doc mapped to a page already targeted by an update cluster joins it", () => {
    const resolvedAll: ResolvedCluster[] = [
      {
        cluster: cluster({ topicKey: "landscape", label: "AI Industry Landscape", docIds: ["youtube-summaries/existing.md"] }),
        target: { mode: "update", targetPath: "concepts/AI Industry Landscape.md", existingRelPath: "concepts/AI Industry Landscape.md" },
      },
    ];
    const { outcome } = mergeDocPageMappings(
      resolvedAll,
      [
        { docId: "youtube-summaries/game.md", pageTitle: "AI Industry Landscape" },
        // Duplicate mapping of the same doc → not appended twice.
        { docId: "youtube-summaries/game.md", pageTitle: "AI Industry Landscape" },
      ],
      { pages, index, validDocKeys: new Set(["youtube-summaries/game.md", "youtube-summaries/existing.md"]), skipTopicKeys: new Set() },
    );
    expect(outcome).toEqual({ mapped: 2, synthesized: 0, appended: 1, coveredSkipped: 1 });
    expect(resolvedAll).toHaveLength(1); // no new cluster
    expect(resolvedAll[0]!.cluster.docIds).toEqual(["youtube-summaries/existing.md", "youtube-summaries/game.md"]);
  });

  test("skipTopicKeys honored: a synthesized topic that's live/recently-rejected is dropped", () => {
    const resolvedAll: ResolvedCluster[] = [];
    const { outcome, skipDrops } = mergeDocPageMappings(
      resolvedAll,
      [{ docId: "youtube-summaries/game.md", pageTitle: "AI Industry Landscape" }],
      {
        pages, index, validDocKeys: new Set(["youtube-summaries/game.md"]),
        skipTopicKeys: new Set(["ai-industry-landscape"]),
      },
    );
    expect(outcome).toEqual({ mapped: 1, synthesized: 0, appended: 0, coveredSkipped: 0 });
    expect(resolvedAll).toHaveLength(0); // nothing synthesized
    expect(skipDrops).toEqual([{ topicKey: "ai-industry-landscape", kind: "concept", size: 1, reason: "skip" }]);
  });

  test("unknown docId and unknown pageTitle are dropped (not counted as mapped)", () => {
    const resolvedAll: ResolvedCluster[] = [];
    const { outcome } = mergeDocPageMappings(
      resolvedAll,
      [
        { docId: "youtube-summaries/not-harvested.md", pageTitle: "AI Industry Landscape" }, // unknown doc
        { docId: "youtube-summaries/game.md", pageTitle: "No Such Page" }, // unknown page
      ],
      { pages, index, validDocKeys: new Set(["youtube-summaries/game.md"]), skipTopicKeys: new Set() },
    );
    expect(outcome).toEqual({ mapped: 0, synthesized: 0, appended: 0, coveredSkipped: 0 });
    expect(resolvedAll).toHaveLength(0);
  });

  test("a doc in a pass-0 CREATE cluster still synthesizes an update (no cross-mode dedup)", () => {
    // The doc is already in a create-mode cluster; a mapping to an existing page
    // must still produce a separate update — a create and an update aren't the
    // same proposal.
    const resolvedAll: ResolvedCluster[] = [
      {
        cluster: cluster({ topicKey: "fresh", label: "Fresh Topic", docIds: ["youtube-summaries/game.md"] }),
        target: { mode: "create", targetPath: "concepts/Fresh Topic.md" },
      },
    ];
    const { outcome } = mergeDocPageMappings(
      resolvedAll,
      [{ docId: "youtube-summaries/game.md", pageTitle: "AI Industry Landscape" }],
      { pages, index, validDocKeys: new Set(["youtube-summaries/game.md"]), skipTopicKeys: new Set() },
    );
    expect(outcome.synthesized).toBe(1);
    expect(resolvedAll).toHaveLength(2);
    expect(resolvedAll[1]!.target.mode).toBe("update");
  });
});
