import { test, expect, describe } from "bun:test";
import {
  computeColoring,
  neighborsFor,
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
