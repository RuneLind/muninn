import { describe, test, expect } from "bun:test";
import { extractToolInputLabel, deriveSpanLabelHtml, abbreviateCollection, sortCollectionsByPriority, summarizeSearchTrace } from "./helpers.ts";

describe("extractToolInputLabel", () => {
  test("returns empty string for falsy input", () => {
    expect(extractToolInputLabel(null)).toBe("");
    expect(extractToolInputLabel(undefined)).toBe("");
    expect(extractToolInputLabel("")).toBe("");
  });

  test("extracts priority key 'query' from JSON string", () => {
    expect(extractToolInputLabel('{"query":"search term","other":"ignored"}')).toBe("search term");
  });

  test("extracts priority key 'pattern' over non-priority keys", () => {
    expect(extractToolInputLabel('{"foo":"bar","pattern":"*.ts"}')).toBe("*.ts");
  });

  test("extracts priority key 'command' from object input", () => {
    expect(extractToolInputLabel({ command: "git status", verbose: true })).toBe("git status");
  });

  test("falls back to first string value when no priority key matches", () => {
    expect(extractToolInputLabel('{"count":42,"label":"my label"}')).toBe("my label");
  });

  test("skips non-string and empty string values", () => {
    expect(extractToolInputLabel('{"query":"","count":5,"label":"found"}')).toBe("found");
  });

  test("truncates at 140 characters", () => {
    const long = "a".repeat(160);
    const result = extractToolInputLabel({ query: long });
    expect(result).toBe("a".repeat(137) + "...");
    expect(result.length).toBe(140);
  });

  test("does not truncate string exactly 140 chars", () => {
    const exact = "a".repeat(140);
    expect(extractToolInputLabel({ query: exact })).toBe(exact);
  });

  test("returns empty string for empty object", () => {
    expect(extractToolInputLabel("{}")).toBe("");
  });

  test("returns empty string for invalid JSON", () => {
    expect(extractToolInputLabel("not json")).toBe("");
  });

  test("returns empty string for object with only non-string values", () => {
    expect(extractToolInputLabel('{"count":5,"enabled":true,"items":[1,2]}')).toBe("");
  });

  test("respects priority order: query before command", () => {
    expect(extractToolInputLabel({ command: "ls", query: "search" })).toBe("search");
  });

  test("respects priority order: file_path before arbitrary key", () => {
    expect(extractToolInputLabel({ custom: "custom val", file_path: "/src/index.ts" })).toBe("/src/index.ts");
  });
});

describe("deriveSpanLabelHtml", () => {
  test("returns null when there's no collection to chip", () => {
    expect(deriveSpanLabelHtml({ name: "claude" })).toBeNull();
    expect(deriveSpanLabelHtml({ name: "knowledge-search_knowledge", attributes: { input: { query: "x" } } })).toBeNull();
  });

  test("renders verb chip + collection chip from input.collection", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: { input: { collection: "jira-issues" } },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('class="wf-chip wf-verb wf-verb-search"');
    expect(out!.html).toContain(">search<");
    expect(out!.html).toContain('class="wf-chip wf-coll"');
    expect(out!.html).toContain(">jira-issues<");
    expect(out!.html).not.toContain("wf-coll-more");
    expect(out!.html).not.toContain("wf-trace-dot");
  });

  test("includes a +N chip and tooltip listing the extra collections (wiki promoted to primary)", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{ name: "melosys-confluence-v3" }, { name: "jira-issues" }, { name: "nav-wiki" }],
        },
      },
    });
    expect(out).not.toBeNull();
    // wiki sorts to the front and becomes the primary chip
    expect(out!.html).toContain(">nav-wiki<");
    expect(out!.html).toContain('class="wf-chip wf-coll-more"');
    expect(out!.html).toContain(">+2<");
    // remaining tooltip lists the others in original (non-wiki) order
    expect(out!.html).toContain('title="melosys-confluence-v3, jira-issues"');
  });

  test("does not emit the legacy trace dot (counts chip + detail panel cover the same signal)", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        input: { collection: "kb" },
        searchTrace: { schemaVersion: 1, collections: [{ name: "kb" }] },
      },
    });
    expect(out!.html).not.toContain("wf-trace-dot");
    expect(out!.html.startsWith('<span class="wf-chip wf-verb')).toBe(true);
  });

  test("uses verb class 'other' for tool names that don't reduce to letters-only", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-123foo",
      attributes: { input: { collection: "kb" } },
    });
    expect(out!.html).toContain("wf-verb-other");
  });

  test("escapes HTML in collection names", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: { input: { collection: "<script>alert(1)</script>" } },
    });
    expect(out!.html).toContain("&lt;script&gt;");
    expect(out!.html).not.toContain("<script>alert");
  });

  test("abbreviates the chip for long collection names and puts full name in title", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: { input: { collection: "melosys-confluence-v3" } },
    });
    expect(out!.html).toContain(">mc-v3<");
    expect(out!.html).not.toContain(">melosys-confluence-v3<");
    expect(out!.html).toContain('title="melosys-confluence-v3 (mc-v3)"');
  });

  test("keeps short collection names verbatim with no abbreviation note", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: { input: { collection: "jira-issues" } },
    });
    expect(out!.html).toContain(">jira-issues<");
    expect(out!.html).toContain('title="jira-issues"');
  });

  test("yggdrasil-shaped trace synthesizes a 'yggdrasil' chip and 'search' verb", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-search",
      attributes: { searchTrace: { schemaVersion: 1, tool: "search" } },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain("wf-verb-search");
    expect(out!.html).toContain(">search<");
    expect(out!.html).toContain(">yggdrasil<");
  });

  test("renders a counts chip with kept/fetched for huginn collections", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{
            name: "kb",
            candidates: [
              { kept: true, docTitle: "Top hit", stages: { final: { rank: 1 } } },
              { kept: true, stages: { final: { rank: 2 } } },
              { kept: false, dropReason: "noise" },
            ],
            confidence: { lowConfidence: false },
            timingsMs: { total: 63 },
          }],
          totalMs: 71,
        },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('class="wf-chip wf-counts"');
    expect(out!.html).toContain(">2/3<");
    expect(out!.html).not.toContain("wf-low-conf");
    expect(out!.tooltip).toContain("candidates: 2 kept / 3 fetched");
    expect(out!.tooltip).toContain("top: Top hit");
    expect(out!.tooltip).toContain("total: 71ms");
  });

  test("flips counts chip to low-conf variant when any collection is low-confidence", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          collections: [{
            name: "kb",
            candidates: [{ kept: true, docTitle: "x" }],
            confidence: { lowConfidence: true },
          }],
        },
      },
    });
    expect(out!.html).toContain("wf-chip wf-counts wf-low-conf");
    expect(out!.tooltip).toContain("low confidence");
  });

  test("renders counts chip and tooltip from yggdrasil flat candidates", () => {
    const out = deriveSpanLabelHtml({
      name: "yggdrasil-search",
      attributes: {
        searchTrace: {
          schemaVersion: 1,
          tool: "search",
          candidates: [
            { qualifiedName: "com.example.Foo", stages: { final: { rank: 1 } } },
            { qualifiedName: "com.example.Bar", stages: { final: { rank: 2 } } },
            { qualifiedName: "com.example.Baz" }, // no final stage → not kept
          ],
          timingsMs: { total: 42 },
        },
      },
    });
    expect(out!.html).toContain(">2/3<");
    expect(out!.tooltip).toContain("top: com.example.Foo");
    expect(out!.tooltip).toContain("total: 42ms");
  });
});

describe("summarizeSearchTrace", () => {
  test("returns null for non-objects", () => {
    expect(summarizeSearchTrace(null)).toBeNull();
    expect(summarizeSearchTrace(undefined)).toBeNull();
    expect(summarizeSearchTrace("foo")).toBeNull();
  });

  test("returns null when neither shape has candidates", () => {
    expect(summarizeSearchTrace({ schemaVersion: 1 })).toBeNull();
    expect(summarizeSearchTrace({ collections: [] })).toBeNull();
    expect(summarizeSearchTrace({ candidates: [] })).toBeNull();
  });

  test("aggregates kept/fetched across multiple huginn collections", () => {
    const s = summarizeSearchTrace({
      collections: [
        { candidates: [{ kept: true }, { kept: false }] },
        { candidates: [{ kept: true }, { kept: true }, { kept: false }] },
      ],
    });
    expect(s).toEqual({ kept: 3, fetched: 5, topTitle: null, lowConfidence: false, totalMs: null });
  });

  test("picks top hit by lowest final.rank from first huginn collection", () => {
    const s = summarizeSearchTrace({
      collections: [{
        candidates: [
          { docTitle: "second", stages: { final: { rank: 2 } } },
          { docTitle: "first", stages: { final: { rank: 1 } } },
        ],
      }],
    });
    expect(s!.topTitle).toBe("first");
  });

  test("falls back to documentId when docTitle is missing", () => {
    const s = summarizeSearchTrace({
      collections: [{ candidates: [{ documentId: "doc-abc", stages: { final: { rank: 1 } } }] }],
    });
    expect(s!.topTitle).toBe("doc-abc");
  });

  test("yggdrasil shape: kept counts candidates with stages.final, top picks lowest rank", () => {
    const s = summarizeSearchTrace({
      tool: "search",
      candidates: [
        { qualifiedName: "B", stages: { final: { rank: 2 } } },
        { qualifiedName: "A", stages: { final: { rank: 1 } } },
        { qualifiedName: "C" },
      ],
      timingsMs: { total: 33 },
    });
    expect(s).toEqual({ kept: 2, fetched: 3, topTitle: "A", lowConfidence: false, totalMs: 33 });
  });
});

describe("sortCollectionsByPriority", () => {
  test("moves any wiki-containing entry to the front", () => {
    expect(sortCollectionsByPriority(["melosys-confluence-v3", "jira-issues", "nav-wiki"]))
      .toEqual(["nav-wiki", "melosys-confluence-v3", "jira-issues"]);
  });

  test("preserves original order when no priority match", () => {
    expect(sortCollectionsByPriority(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("preserves original order among multiple wiki entries", () => {
    expect(sortCollectionsByPriority(["jira", "alpha-wiki", "beta-wiki", "confluence"]))
      .toEqual(["alpha-wiki", "beta-wiki", "jira", "confluence"]);
  });

  test("matches case-insensitively", () => {
    expect(sortCollectionsByPriority(["jira", "Internal-WIKI"]))
      .toEqual(["Internal-WIKI", "jira"]);
  });
});

describe("abbreviateCollection", () => {
  test("returns empty string for empty input", () => {
    expect(abbreviateCollection("")).toBe("");
  });

  test("keeps names ≤ 12 chars verbatim", () => {
    expect(abbreviateCollection("jira-issues")).toBe("jira-issues");
    expect(abbreviateCollection("nav-wiki")).toBe("nav-wiki");
    expect(abbreviateCollection("kb")).toBe("kb");
  });

  test("collapses long names to first-letter initials per dash segment", () => {
    expect(abbreviateCollection("very-long-collection-name")).toBe("vlcn");
  });

  test("preserves trailing version-like tokens", () => {
    expect(abbreviateCollection("melosys-confluence-v3")).toBe("mc-v3");
    expect(abbreviateCollection("foo-bar-baz-2")).toBe("fbb-2");
    expect(abbreviateCollection("alpha-beta-gamma-v1-2")).toBe("abg-v1-2");
  });

  test("returns single-token names unchanged when long", () => {
    expect(abbreviateCollection("supercalifragilistic")).toBe("supercalifragilistic");
  });
});
