import { test, expect, describe } from "bun:test";
import { joinSemantic, type SimilarityGraph } from "./atlas-semantic.ts";
import { normalizeRelPath, type WikiPageMeta } from "./store.ts";

/** Minimal WikiPageMeta — joinSemantic reads only `relPath`. */
function pg(relPath: string): WikiPageMeta {
  return { relPath } as unknown as WikiPageMeta;
}

/** Terse similarity-graph builder. */
function graph(
  nodes: { id: string; community?: number }[],
  edges: { source: string; target: string; similarity: number }[],
  communities: SimilarityGraph["communities"] = [],
): SimilarityGraph {
  return { nodes, edges, communities };
}

describe("joinSemantic", () => {
  test("returns null when no graphs are supplied", () => {
    expect(joinSemantic([pg("a.md")], new Map(), ["wiki"])).toBeNull();
  });

  test("NFC id normalization — matching key differs from emitted key (NFD file)", () => {
    // Index page relPath in NFD (macOS file API form); huginn id in NFC.
    const nfd = "concepts/Blåbær.md".normalize("NFD");
    const nfc = "concepts/Blåbær.md".normalize("NFC");
    expect(nfd).not.toBe(nfc); // sanity: the å decomposes, so the forms differ

    const graphs = new Map<string, SimilarityGraph>([
      [
        "wiki",
        graph(
          [
            { id: nfc, community: 0 },
            { id: "concepts/other.md", community: 0 },
          ],
          [{ source: nfc, target: "concepts/other.md", similarity: 0.97 }],
          [{ id: 0, size: 2, top_tags: [{ tag: "berries", count: 2 }] }],
        ),
      ],
    ]);

    const overlay = joinSemantic([pg(nfd), pg("concepts/other.md")], graphs, ["wiki"]);
    expect(overlay).not.toBeNull();

    // Emitted key is the bare normalizeRelPath of the NFD index relPath — NOT the
    // NFC-folded matching key.
    const emit = normalizeRelPath(nfd);
    expect(overlay!.nodeCommunity[emit]).toBe("wiki:0");
    expect(emit).not.toBe(emit.normalize("NFC")); // matched key ≠ emitted key
    // The edge resolved despite the NFD/NFC mismatch on both ends.
    expect(overlay!.edges).toHaveLength(1);
    expect(overlay!.edges[0]!.slice(0, 2).sort()).toEqual(
      [emit, "concepts/other.md"].sort(),
    );
  });

  test("drops huginn ids that match no index page", () => {
    const graphs = new Map<string, SimilarityGraph>([
      [
        "wiki",
        graph(
          [
            { id: "a.md", community: 0 },
            { id: "blogs/src/ghost.mdx", community: 0 }, // no index page
          ],
          [{ source: "a.md", target: "blogs/src/ghost.mdx", similarity: 0.95 }],
          [{ id: 0, size: 2, top_tags: [{ tag: "topic", count: 1 }] }],
        ),
      ],
    ]);
    const overlay = joinSemantic([pg("a.md")], graphs, ["wiki"]);
    expect(overlay).not.toBeNull();
    // Only the resolvable node survives; the edge to the unresolved end is dropped.
    expect(Object.keys(overlay!.nodeCommunity)).toEqual(["a.md"]);
    expect(overlay!.edges).toHaveLength(0);
  });

  test("two-collection union namespaces colliding community ids", () => {
    // BOTH collections' communities start at id 0.
    const graphs = new Map<string, SimilarityGraph>([
      [
        "wiki",
        graph(
          [{ id: "a.md", community: 0 }],
          [],
          [{ id: 0, size: 1, top_tags: [{ tag: "alpha", count: 1 }] }],
        ),
      ],
      [
        "wiki-life",
        graph(
          [{ id: "b.md", community: 0 }],
          [],
          [{ id: 0, size: 1, top_tags: [{ tag: "beta", count: 1 }] }],
        ),
      ],
    ]);
    const overlay = joinSemantic([pg("a.md"), pg("b.md")], graphs, ["wiki", "wiki-life"]);
    expect(overlay).not.toBeNull();
    // Namespaced, so the two community-0s stay distinct — colors keyed off these.
    expect(overlay!.nodeCommunity["a.md"]).toBe("wiki:0");
    expect(overlay!.nodeCommunity["b.md"]).toBe("wiki-life:0");
    const ids = overlay!.communities.map((c) => c.id).sort();
    expect(ids).toEqual(["wiki-life:0", "wiki:0"]);
    // Labels derived from top_tags, not huginn's `name`.
    expect(overlay!.communities.find((c) => c.id === "wiki:0")!.label).toBe("alpha");
    expect(overlay!.communities.find((c) => c.id === "wiki-life:0")!.label).toBe("beta");
  });

  test("overlap tie-break — first collection in order wins; orphan communities filtered", () => {
    // `shared.md` is in BOTH graphs (wiki-life is a subset of wiki), with
    // different community assignments. `onlylife.md` is only in wiki-life.
    const graphs = new Map<string, SimilarityGraph>([
      [
        "wiki",
        graph(
          [{ id: "shared.md", community: 0 }],
          [],
          [{ id: 0, size: 1, top_tags: [{ tag: "fromwiki", count: 1 }] }],
        ),
      ],
      [
        "wiki-life",
        graph(
          [
            { id: "shared.md", community: 1 },
            { id: "onlylife.md", community: 2 },
          ],
          [],
          [
            { id: 1, size: 1, top_tags: [{ tag: "life-b", count: 1 }] },
            { id: 2, size: 1, top_tags: [{ tag: "life-c", count: 1 }] },
          ],
        ),
      ],
    ]);
    // Fetch/merge order is irrelevant — collectionsOrder decides. wiki wins.
    const overlay = joinSemantic(
      [pg("shared.md"), pg("onlylife.md")],
      graphs,
      ["wiki", "wiki-life"],
    );
    expect(overlay).not.toBeNull();
    expect(overlay!.nodeCommunity["shared.md"]).toBe("wiki:0");
    expect(overlay!.nodeCommunity["onlylife.md"]).toBe("wiki-life:2");
    // wiki-life:1 is referenced by NO node (shared went to wiki:0) → orphan-filtered.
    const ids = overlay!.communities.map((c) => c.id).sort();
    expect(ids).toEqual(["wiki-life:2", "wiki:0"]);
    expect(ids).not.toContain("wiki-life:1");
  });

  test("max-sim edge dedup keeps the higher similarity for a repeated pair", () => {
    const graphs = new Map<string, SimilarityGraph>([
      [
        "wiki",
        graph(
          [
            { id: "a.md", community: 0 },
            { id: "b.md", community: 0 },
          ],
          [
            // Same unordered pair, twice, different sims + reversed direction.
            { source: "a.md", target: "b.md", similarity: 0.91 },
            { source: "b.md", target: "a.md", similarity: 0.97 },
          ],
        ),
      ],
    ]);
    const overlay = joinSemantic([pg("a.md"), pg("b.md")], graphs, ["wiki"]);
    expect(overlay).not.toBeNull();
    expect(overlay!.edges).toHaveLength(1);
    expect(overlay!.edges[0]![2]).toBe(0.97);
  });

  test("isolate fallback — nodeCommunity id with no community row survives", () => {
    // huginn assigns isolates a community id ≥ len(communities), with no entry.
    const graphs = new Map<string, SimilarityGraph>([
      [
        "wiki",
        graph(
          [
            { id: "a.md", community: 0 },
            { id: "lonely.md", community: 5 }, // isolate — no communities[5]
          ],
          [],
          [{ id: 0, size: 1, top_tags: [{ tag: "topic", count: 1 }] }],
        ),
      ],
    ]);
    const overlay = joinSemantic([pg("a.md"), pg("lonely.md")], graphs, ["wiki"]);
    expect(overlay).not.toBeNull();
    // The isolate node assignment is KEPT (client renders it as neutral "Other").
    expect(overlay!.nodeCommunity["lonely.md"]).toBe("wiki:5");
    // …but it contributes no communities row.
    expect(overlay!.communities.map((c) => c.id)).toEqual(["wiki:0"]);
  });
});
