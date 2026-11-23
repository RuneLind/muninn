import { test, expect, describe } from "bun:test";
import {
  clusterLabel,
  computeClusters,
  computeColoring,
  neighborsFor,
  overlayWithout,
  RAIL_BLOB_MAX,
  railClusters,
  synthesisMembers,
  SEM_COLOR_SLOTS,
  SEM_OTHER_ID,
  SEM_OTHER_SLOT,
  type SemanticOverlay,
} from "./wiki-atlas-semantic.ts";

function community(id: string, label: string): SemanticOverlay["communities"][number] {
  return { id, label, size: 1, tags: [] };
}

describe("computeColoring", () => {
  test("colours communities by rendered-pill count, top-6 get distinct slots", () => {
    const communities = Array.from({ length: 7 }, (_, i) => community(`c:${i}`, `C${i}`));
    // c:0 gets 3 pills, c:1 → 2, c:2..c:6 → 1 each. Ranked desc puts the big ones first.
    const nodeCommunity: Record<string, string> = {
      a: "c:0", b: "c:0", c: "c:0",
      d: "c:1", e: "c:1",
      f: "c:2", g: "c:3", h: "c:4", i: "c:5", j: "c:6",
    };
    const overlay: SemanticOverlay = { edges: [], communities, nodeCommunity };
    const rendered = Object.keys(nodeCommunity);
    const coloring = computeColoring(overlay, rendered);

    // Exactly 6 coloured legend rows + one folded "Other" (c:6 is the 7th community).
    const coloured = coloring.legend.filter((r) => r.slot >= 0);
    expect(coloured.length).toBe(SEM_COLOR_SLOTS);
    expect(coloured.map((r) => r.slot)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(coloured[0]!.id).toBe("c:0"); // biggest cluster → slot 0
    expect(coloured[0]!.count).toBe(3);

    // The 7th-ranked community folds into Other, and its pill turns grey.
    expect(coloring.hasOther).toBe(true);
    const other = coloring.legend.find((r) => r.id === SEM_OTHER_ID);
    expect(other?.slot).toBe(SEM_OTHER_SLOT);
    expect(coloring.slotByKey["j"]).toBe(SEM_OTHER_SLOT);
    expect(coloring.slotByKey["a"]).toBe(0);
  });

  test("legend gating: a community colouring ZERO rendered pills is excluded (mimir archive path)", () => {
    // Mirrors the live mimir case: `archive` communities survive the server's
    // index-level orphan filter but colour zero RENDERED pills (all capped out).
    const overlay: SemanticOverlay = {
      edges: [],
      communities: [
        community("mimir:0", "muninn + hivemind"),
        community("mimir:6", "archive"), // zero rendered members
        community("mimir:7", "archive"), // zero rendered members
      ],
      // Only mimir:0 members are in the rendered set; mimir:6/7 members are capped out.
      nodeCommunity: { r1: "mimir:0", r2: "mimir:0", capped1: "mimir:6", capped2: "mimir:7" },
    };
    const rendered = ["r1", "r2"]; // capped1/capped2 NOT rendered
    const coloring = computeColoring(overlay, rendered);

    expect(coloring.legend.map((r) => r.id)).toEqual(["mimir:0"]);
    // No dim-others row for the zero-rendered communities — its click would dim everything.
    expect(coloring.legend.some((r) => r.id === "mimir:6" || r.id === "mimir:7")).toBe(false);
    expect(coloring.hasOther).toBe(false);
  });

  test("isolate (nodeCommunity id with no community row) folds into Other independently", () => {
    const overlay: SemanticOverlay = {
      edges: [],
      communities: [community("c:0", "Real")],
      nodeCommunity: { a: "c:0", iso: "c:99" }, // c:99 has no communities entry
    };
    const coloring = computeColoring(overlay, ["a", "iso"]);
    expect(coloring.slotByKey["a"]).toBe(0);
    expect(coloring.slotByKey["iso"]).toBe(SEM_OTHER_SLOT);
    expect(coloring.hasOther).toBe(true);
    // Only the real community gets a coloured row; Other is the sole extra.
    expect(coloring.legend.map((r) => r.id)).toEqual(["c:0", SEM_OTHER_ID]);
  });

  test("a node with no community assignment gets no dot", () => {
    const overlay: SemanticOverlay = {
      edges: [],
      communities: [community("c:0", "Real")],
      nodeCommunity: { a: "c:0" },
    };
    const coloring = computeColoring(overlay, ["a", "unassigned"]);
    expect(coloring.slotByKey["a"]).toBe(0);
    expect("unassigned" in coloring.slotByKey).toBe(false);
  });
});

describe("neighborsFor", () => {
  const overlay: SemanticOverlay = {
    edges: [
      ["target", "near-rendered", 0.99],
      ["far-rendered", "target", 0.985],
      ["target", "below-thresh", 0.97],
      ["target", "capped-out", 0.99], // ≥ threshold but not rendered
      ["x", "y", 0.999], // unrelated
    ],
    communities: [community("c:0", "A")],
    nodeCommunity: { target: "c:0", "near-rendered": "c:0", "far-rendered": "c:0" },
  };
  const rendered = ["target", "near-rendered", "far-rendered"];
  const slotByKey = computeColoring(overlay, rendered).slotByKey;

  test("splits neighbours ≥ threshold into rendered (drawable) and hidden (+N not shown)", () => {
    const res = neighborsFor(overlay, "target", 0.98, rendered, slotByKey);
    expect(res.rendered.map((n) => n.key)).toEqual(["near-rendered", "far-rendered"]); // sim desc
    expect(res.rendered[0]!.sim).toBe(0.99);
    expect(res.hidden).toBe(1); // capped-out counted, never silently dropped
    // below-thresh (0.97) excluded at threshold 0.98.
    expect(res.rendered.some((n) => n.key === "below-thresh")).toBe(false);
  });

  test("raising the threshold drops edges live", () => {
    const res = neighborsFor(overlay, "target", 0.99, rendered, slotByKey);
    expect(res.rendered.map((n) => n.key)).toEqual(["near-rendered"]);
    expect(res.hidden).toBe(1); // capped-out still ≥ 0.99
  });

  test("neighbour edge carries the neighbour's community slot", () => {
    const res = neighborsFor(overlay, "target", 0.98, rendered, slotByKey);
    expect(res.rendered.every((n) => n.slot === 0)).toBe(true);
  });
});

// ── Cluster rail (PR 3) ──────────────────────────────────────────────────────

/** Build a single-component chain overlay of `n` members (p000…) with one type/tags. */
function chainOverlay(n: number, type = "source", tags: string[] = []): SemanticOverlay {
  const key = (i: number) => `p${String(i).padStart(3, "0")}`;
  const edges: [string, string, number][] = [];
  const nodeType: Record<string, string> = {};
  const nodeTags: Record<string, string[]> = {};
  for (let i = 0; i < n; i++) {
    nodeType[key(i)] = type;
    nodeTags[key(i)] = tags;
  }
  for (let i = 0; i < n - 1; i++) edges.push([key(i), key(i + 1), 0.99]);
  return { edges, communities: [], nodeCommunity: {}, nodeType, nodeTags };
}

/** A single component whose members carry the given types (m0…m{n-1}), edges 0.99. */
function typedComponent(types: string[]): SemanticOverlay {
  const key = (i: number) => `m${i}`;
  const edges: [string, string, number][] = [];
  const nodeType: Record<string, string> = {};
  types.forEach((ty, i) => (nodeType[key(i)] = ty));
  for (let i = 0; i < types.length - 1; i++) edges.push([key(i), key(i + 1), 0.99]);
  return { edges, communities: [], nodeCommunity: {}, nodeType, nodeTags: {} };
}

describe("computeClusters (union-find)", () => {
  test("components at threshold, ≥3-member filter, sorted by size desc", () => {
    const overlay: SemanticOverlay = {
      communities: [],
      nodeCommunity: {},
      edges: [
        ["a", "b", 0.99],
        ["b", "c", 0.985], // {a,b,c} — kept (3)
        ["d", "e", 0.99], // {d,e} — dropped (< 3)
        ["f", "g", 0.95], // sub-threshold — never unioned
        ["m", "n", 0.99],
        ["n", "o", 0.99],
        ["o", "p", 0.99], // {m,n,o,p} — kept (4, bigger)
      ],
    };
    const clusters = computeClusters(overlay, 0.98);
    expect(clusters.map((c) => c.size)).toEqual([4, 3]); // size desc
    expect(clusters[0]!.members).toEqual(["m", "n", "o", "p"]);
    expect(clusters[1]!.members).toEqual(["a", "b", "c"]);
    expect(clusters[1]!.id).toBe("a"); // id = smallest member key
    const all = clusters.flatMap((c) => c.members);
    expect(all).not.toContain("d"); // pair dropped
    expect(all).not.toContain("f"); // sub-threshold edge never connected
  });

  test("raising the slider splits a component live", () => {
    const overlay: SemanticOverlay = {
      communities: [],
      nodeCommunity: {},
      edges: [
        ["a", "b", 0.99],
        ["b", "c", 0.97],
      ],
    };
    expect(computeClusters(overlay, 0.96)[0]!.members).toEqual(["a", "b", "c"]);
    // at 0.98 the b-c edge drops → only the {a,b} pair remains → no ≥3 cluster
    expect(computeClusters(overlay, 0.98)).toEqual([]);
  });

  test("blob guard boundary: 40 renders a member list, 41 trips the guard", () => {
    expect(RAIL_BLOB_MAX).toBe(40);
    const at40 = computeClusters(chainOverlay(40), 0.98)[0]!;
    expect(at40.size).toBe(40);
    expect(at40.tooBroad).toBe(false);
    expect(at40.members.length).toBe(40);

    const at41 = computeClusters(chainOverlay(41), 0.98)[0]!;
    expect(at41.size).toBe(41);
    expect(at41.tooBroad).toBe(true);
    expect(at41.candidate).toBe(false); // no badge on a blob
    expect(at41.label).toBe(""); // no label computed on a blob
  });
});

describe("synthesis-candidate badge (type-set map, per-wiki ontology)", () => {
  test("mimir narrative set: ≥3 plan/report, no synthesis → candidate", () => {
    expect(computeClusters(typedComponent(["plan", "report", "plan"]), 0.98)[0]!.candidate).toBe(true);
  });

  test("default narrative set: source/analysis, no concept → candidate", () => {
    expect(
      computeClusters(typedComponent(["source", "analysis", "source"]), 0.98)[0]!.candidate,
    ).toBe(true);
  });

  test("badge withheld when a mimir synthesis-type member exists (gardener state-blog case)", () => {
    // 3 narrative plans/report + 1 blog (synthesis) → NOT a candidate
    expect(
      computeClusters(typedComponent(["plan", "report", "plan", "blog"]), 0.98)[0]!.candidate,
    ).toBe(false);
    // subsystem is also synthesis
    expect(
      computeClusters(typedComponent(["plan", "report", "plan", "subsystem"]), 0.98)[0]!.candidate,
    ).toBe(false);
  });

  test("badge withheld when a default synthesis type (concept) is present", () => {
    expect(
      computeClusters(typedComponent(["source", "analysis", "source", "concept"]), 0.98)[0]!
        .candidate,
    ).toBe(false);
  });

  test("< 3 narrative-type members → no badge even with zero synthesis", () => {
    // 2 narrative + 1 unmapped 'note' type (neither narrative nor synthesis)
    expect(
      computeClusters(typedComponent(["source", "analysis", "note"]), 0.98)[0]!.candidate,
    ).toBe(false);
  });
});

describe("clusterLabel (informative-tag rule)", () => {
  test("top-2 non-generic tags by frequency; generic plan/wiki/blog excluded", () => {
    const lists = [
      ["rag", "wiki", "plan"],
      ["rag", "retrieval"],
      ["rag", "retrieval", "blog"],
    ];
    // rag×3, retrieval×2, generic dropped → "rag + retrieval"
    expect(clusterLabel(lists)).toBe("rag + retrieval");
  });

  test("empty when only generic tags survive", () => {
    expect(clusterLabel([["plan"], ["wiki", "blog"]])).toBe("");
  });

  test("computeClusters falls back to the smallest member stem when unlabeled", () => {
    const overlay: SemanticOverlay = {
      communities: [],
      nodeCommunity: {},
      edges: [
        ["plans/z.md", "plans/a.md", 0.99],
        ["plans/a.md", "plans/m.md", 0.99],
      ],
      nodeType: {},
      nodeTags: { "plans/z.md": ["plan"], "plans/a.md": ["wiki"], "plans/m.md": [] },
    };
    // members sort to [plans/a.md, plans/m.md, plans/z.md]; all tags generic/empty
    // ⇒ label falls back to stemOf(smallest) = "a".
    expect(computeClusters(overlay, 0.98)[0]!.label).toBe("a");
  });
});

describe("retired (culled) pages in the semantic overlay", () => {
  // s1–s4 and a retired s5, all narrative (`source`): s5 bridges s3 and s4,
  // and s3–s4 are also linked, so the live pages stay one component without it.
  const overlay: SemanticOverlay = {
    communities: [community("k:1", "K")],
    nodeCommunity: { s1: "k:1", s5: "k:1" },
    nodeType: { s1: "source", s2: "source", s3: "source", s4: "source", s5: "source" },
    nodeTags: { s1: ["live"], s2: ["live"], s3: ["live"], s4: ["live"], s5: ["dead", "dead2"] },
    edges: [
      ["s1", "s2", 0.99],
      ["s2", "s3", 0.99],
      ["s3", "s5", 0.99],
      ["s4", "s5", 0.99],
      ["s3", "s4", 0.99],
    ],
  };
  const culled = new Set(["s5"]);

  test("overlayWithout drops the pages' edges and per-node entries, and copies", () => {
    const o = overlayWithout(overlay, culled);
    expect(o.edges.flat().filter((x) => x === "s5")).toEqual([]);
    expect(o.edges).toHaveLength(3);
    expect(Object.keys(o.nodeCommunity)).toEqual(["s1"]);
    expect(o.nodeType!.s5).toBeUndefined();
    expect(o.nodeTags!.s5).toBeUndefined();
    expect(overlay.edges).toHaveLength(5); // the served overlay is untouched
  });

  test("railClusters with nothing retired is computeClusters", () => {
    expect(railClusters(overlay, 0.98, new Set())).toEqual(computeClusters(overlay, 0.98));
  });

  test("a cluster holding a retired page keeps it as a member but drafts the live pages", () => {
    const [c] = railClusters(overlay, 0.98, culled);
    expect(c!.members).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(c!.candidate).toBe(true);
    expect(synthesisMembers(c!, culled)).toEqual(["s1", "s2", "s3", "s4"]);
    // The label is the live cluster's, so the topic key matches what the
    // hidden view would draft (s5's own tags do not lead it).
    expect(c!.label).toBe(computeClusters(overlayWithout(overlay, culled), 0.98)[0]!.label);
    expect(c!.label).not.toContain("dead");
  });

  test("a retired page that bridges two parts leaves no candidate: the server could not confirm it", () => {
    const bridged: SemanticOverlay = { ...overlay, edges: overlay.edges.filter((e) => !(e[0] === "s3" && e[1] === "s4")) };
    const [c] = railClusters(bridged, 0.98, culled);
    expect(c!.members).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(c!.candidate).toBe(false);
  });

  test("retired narrative pages do not make a candidate out of too few live ones", () => {
    const thin: SemanticOverlay = {
      communities: [],
      nodeCommunity: {},
      nodeType: { a: "source", b: "source", x: "source" },
      edges: [
        ["a", "b", 0.99],
        ["b", "x", 0.99],
      ],
    };
    const [c] = railClusters(thin, 0.98, new Set(["x"]));
    expect(c!.members).toEqual(["a", "b", "x"]);
    expect(c!.candidate).toBe(false);
  });

  test("synthesisMembers never returns a retired page", () => {
    expect(synthesisMembers({ members: ["a", "x", "b"] }, new Set(["x"]))).toEqual(["a", "b"]);
    expect(synthesisMembers({ members: ["a", "b"] }, new Set())).toEqual(["a", "b"]);
  });
});
