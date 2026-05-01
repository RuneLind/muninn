import { describe, test, expect } from "bun:test";
import { extractToolInputLabel, deriveSpanLabelHtml, abbreviateCollection, sortCollectionsByPriority } from "./helpers.ts";

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

  test("emits the trace-dot when searchTrace.schemaVersion === 1", () => {
    const out = deriveSpanLabelHtml({
      name: "knowledge-search_knowledge",
      attributes: {
        input: { collection: "kb" },
        searchTrace: { schemaVersion: 1, collections: [{ name: "kb" }] },
      },
    });
    expect(out!.html.startsWith('<span class="wf-trace-dot"')).toBe(true);
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
