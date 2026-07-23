import { test, expect, describe } from "bun:test";
import { buildIndexEntry, catalogPage, insertIndexLine, buildSeeAlsoEdit, selectWirablePages } from "./wire.ts";
import type { WikiIndex, WikiPageMeta } from "../wiki/store.ts";

/**
 * Minimal WikiIndex fake: `pages` are { title → relPath }. `resolve` matches by
 * title (case-insensitive), `resolveRelPath` by exact relPath — enough to drive
 * `selectWirablePages` without a filesystem.
 */
function fakeIndex(pages: Record<string, string>): WikiIndex {
  const metas: WikiPageMeta[] = Object.entries(pages).map(([name, relPath]) => ({
    name,
    title: name,
    type: "concept",
    domain: relPath.startsWith("life/") ? "life" : "ai",
    tags: [],
    aliases: [],
    relPath,
  }));
  return {
    pages: metas,
    outgoing: new Map(),
    backlinks: new Map(),
    resolve: (target: string) => metas.find((m) => m.name.toLowerCase() === target.toLowerCase()),
    resolveRelPath: (relPath: string) => metas.find((m) => m.relPath === relPath),
    scannedAt: 0,
    root: "/fake",
  };
}

describe("buildIndexEntry", () => {
  test("concept + ai → AI / Claude / Coding section, rationale one-liner", () => {
    const e = buildIndexEntry({ title: "Code Mode", kind: "concept", domain: "ai", rationale: "MCP code exec pattern" });
    expect(e).not.toBeNull();
    expect(e!.section).toBe("AI / Claude / Coding");
    expect(e!.line).toBe("- [[Code Mode]] — MCP code exec pattern");
  });

  test("concept + life → Health / Learning section", () => {
    const e = buildIndexEntry({ title: "Zone 2", kind: "concept", domain: "life", rationale: "aerobic base training" });
    expect(e!.section).toBe("Health / Learning");
    expect(e!.line).toBe("- [[Zone 2]] — aerobic base training");
  });

  test("falls back to first body paragraph when no rationale", () => {
    const body = "\n# Code Mode\n\nA pattern where the model writes code that calls tools.\n\n## See also\n";
    const e = buildIndexEntry({ title: "Code Mode", kind: "concept", domain: "ai", rationale: "", body });
    expect(e!.line).toBe("- [[Code Mode]] — A pattern where the model writes code that calls tools.");
  });

  test("one-liner is capped at 120 chars with an ellipsis", () => {
    const long = "x".repeat(200);
    const e = buildIndexEntry({ title: "T", kind: "concept", domain: "ai", rationale: long });
    // "- [[T]] — " + ≤120 chars
    const oneLiner = e!.line.replace("- [[T]] — ", "");
    expect(oneLiner.length).toBeLessThanOrEqual(120);
    expect(oneLiner.endsWith("…")).toBe(true);
  });

  test("no rationale and no body → bare bullet, no em-dash", () => {
    const e = buildIndexEntry({ title: "Bare", kind: "concept", domain: "ai" });
    expect(e!.line).toBe("- [[Bare]]");
  });

  test("entity → null (People/Orgs/Products not derivable, file manually)", () => {
    expect(buildIndexEntry({ title: "Anthropic", kind: "entity", domain: "ai", rationale: "AI lab" })).toBeNull();
  });

  test("source → null (per-article archive, no Concepts index line)", () => {
    expect(
      buildIndexEntry({ title: "RAG Explained", kind: "source", domain: "ai", rationale: "video" }),
    ).toBeNull();
  });

  // ── Per-wiki cataloging policy (catalogKinds) ────────────────────────────────

  test("jarvis policy [concept, source] → source page gets a ## Sources line", () => {
    const e = buildIndexEntry(
      { title: "RAG Explained", kind: "source", domain: "ai", rationale: "video on retrieval" },
      ["concept", "source"],
    );
    expect(e).not.toBeNull();
    expect(e!.section).toBe("Sources");
    expect(e!.headingLevel).toBe(2);
    expect(e!.line).toBe("- [[RAG Explained]] — video on retrieval");
  });

  test("jarvis policy still catalogs concepts under their ### domain section", () => {
    const e = buildIndexEntry(
      { title: "Code Mode", kind: "concept", domain: "ai", rationale: "MCP code exec" },
      ["concept", "source"],
    );
    expect(e!.section).toBe("AI / Claude / Coding");
    expect(e!.headingLevel).toBe(3);
  });

  test("entity is NEVER cataloged even when the policy lists it", () => {
    expect(
      buildIndexEntry({ title: "Anthropic", kind: "entity", domain: "ai" }, ["concept", "source", "entity"]),
    ).toBeNull();
  });

  test("default policy (concept-only) still skips source pages", () => {
    expect(buildIndexEntry({ title: "S", kind: "source", domain: "ai", rationale: "x" })).toBeNull();
  });
});

describe("catalogPage", () => {
  test("default policy catalogs concept only", () => {
    expect(catalogPage("concept")).toBe(true);
    expect(catalogPage("source")).toBe(false);
    expect(catalogPage("entity")).toBe(false);
  });

  test("jarvis policy adds source, keeps entity skipped", () => {
    const policy = ["concept", "source"];
    expect(catalogPage("concept", policy)).toBe(true);
    expect(catalogPage("source", policy)).toBe(true);
    expect(catalogPage("entity", policy)).toBe(false);
  });

  test("entity is hard-skipped even if explicitly listed", () => {
    expect(catalogPage("entity", ["entity"])).toBe(false);
  });
});

describe("insertIndexLine", () => {
  // A deliberately case-MIXED, NOT-real-file-ordered block: the placement must be
  // deterministic ASCII order, independent of the curated file's loose ordering.
  const INDEX = [
    "# Index",
    "",
    "## Concepts",
    "",
    "### AI / Claude / Coding",
    "",
    "- [[Banana]] — b",
    "- [[Zebra]] — z",
    "- [[apple]] — lowercase sorts after uppercase in ASCII",
    "",
    "### Health / Learning",
    "",
    "- [[Sleep]] — s",
    "",
  ].join("\n");

  test("inserts in case-sensitive ASCII order within the matched ### block", () => {
    const e = { line: "- [[Mango]] — m", section: "AI / Claude / Coding" };
    const { content, changed, reason } = insertIndexLine(INDEX, e);
    expect(changed).toBe(true);
    expect(reason).toBe("inserted");
    const lines = content.split("\n");
    const iBanana = lines.indexOf("- [[Banana]] — b");
    const iMango = lines.indexOf("- [[Mango]] — m");
    const iZebra = lines.indexOf("- [[Zebra]] — z");
    const iApple = lines.indexOf("- [[apple]] — lowercase sorts after uppercase in ASCII");
    // ASCII: Banana < Mango < Zebra < apple. Mango lands between Banana and Zebra.
    expect(iBanana).toBeLessThan(iMango);
    expect(iMango).toBeLessThan(iZebra);
    expect(iZebra).toBeLessThan(iApple);
  });

  test("routes to the correct ### block, not the first one", () => {
    const e = { line: "- [[Napping]] — n", section: "Health / Learning" };
    const { content } = insertIndexLine(INDEX, e);
    const lines = content.split("\n");
    const iHealth = lines.indexOf("### Health / Learning");
    const iNapping = lines.indexOf("- [[Napping]] — n");
    const iSleep = lines.indexOf("- [[Sleep]] — s");
    expect(iNapping).toBeGreaterThan(iHealth);
    // Napping < Sleep (ASCII) → before Sleep.
    expect(iNapping).toBeLessThan(iSleep);
  });

  test("idempotent: a line whose [[Title]] already appears anywhere ⇒ no-op", () => {
    const e = { line: "- [[Banana]] — different body", section: "AI / Claude / Coding" };
    const { content, changed, reason } = insertIndexLine(INDEX, e);
    expect(changed).toBe(false);
    expect(reason).toBe("already-present");
    expect(content).toBe(INDEX);
  });

  test("missing ### section ⇒ skip, never creates a heading", () => {
    const e = { line: "- [[Ghost]] — g", section: "Nonexistent Section" };
    const { content, changed, reason } = insertIndexLine(INDEX, e);
    expect(changed).toBe(false);
    expect(reason).toBe("section-not-found");
    expect(content).toBe(INDEX);
    expect(content).not.toContain("Nonexistent Section");
  });

  test("empty index (no headings) ⇒ section-not-found, no write", () => {
    const { changed, reason } = insertIndexLine("", { line: "- [[X]] — x", section: "AI / Claude / Coding" });
    expect(changed).toBe(false);
    expect(reason).toBe("section-not-found");
  });

  test("headingLevel 2 routes a source line under the ## Sources section", () => {
    const idx = [
      "# Index",
      "",
      "## Sources",
      "",
      "- [[Sources — AI General]] — aggregate",
      "",
      "### Focused source pages — old batch",
      "",
      "- [[Old Page]] — o",
      "",
      "## Concepts",
      "",
      "### AI / Claude / Coding",
      "",
      "- [[Banana]] — b",
      "",
    ].join("\n");
    const e = { line: "- [[New Source]] — a fresh capture", section: "Sources", headingLevel: 2 as const };
    const { content, changed, reason } = insertIndexLine(idx, e);
    expect(changed).toBe(true);
    expect(reason).toBe("inserted");
    const lines = content.split("\n");
    const iSources = lines.indexOf("## Sources");
    const iNew = lines.indexOf("- [[New Source]] — a fresh capture");
    const iSubsection = lines.indexOf("### Focused source pages — old batch");
    // Lands inside the ## Sources direct-bullet block, above the first subsection.
    expect(iNew).toBeGreaterThan(iSources);
    expect(iNew).toBeLessThan(iSubsection);
    // Did not leak into the Concepts section.
    expect(iNew).toBeLessThan(lines.indexOf("## Concepts"));
  });

  test("a level-2 section name is NOT matched by the default (level-3) lookup", () => {
    const idx = "# Index\n\n## Sources\n\n- [[A]] — a\n";
    // Default headingLevel (3) looks for `### Sources` — absent → section-not-found.
    const { changed, reason } = insertIndexLine(idx, { line: "- [[B]] — b", section: "Sources" });
    expect(changed).toBe(false);
    expect(reason).toBe("section-not-found");
  });
});

describe("buildSeeAlsoEdit", () => {
  const PAGE = [
    "---",
    "type: concept",
    "title: Related Page",
    "---",
    "",
    "# Related Page",
    "",
    "Body prose.",
    "",
    "## See also",
    "- [[Existing Link]]",
    "",
  ].join("\n");

  test("appends a bullet under an existing ## See also", () => {
    const out = buildSeeAlsoEdit(PAGE, "New Page");
    expect(out).not.toBeNull();
    const lines = out!.split("\n");
    const iSeeAlso = lines.indexOf("## See also");
    const iExisting = lines.indexOf("- [[Existing Link]]");
    const iNew = lines.indexOf("- [[New Page]]");
    expect(iNew).toBeGreaterThan(iSeeAlso);
    // Appended after the existing bullet.
    expect(iNew).toBe(iExisting + 1);
    // Frontmatter untouched.
    expect(out!.startsWith("---\ntype: concept")).toBe(true);
  });

  test("creates a ## See also section when the page has none", () => {
    const noSeeAlso = "---\ntitle: Bare\n---\n\n# Bare\n\nJust prose.\n";
    const out = buildSeeAlsoEdit(noSeeAlso, "New Page");
    expect(out).not.toBeNull();
    expect(out).toContain("## See also");
    expect(out).toContain("- [[New Page]]");
    expect(out!.endsWith("- [[New Page]]\n")).toBe(true);
  });

  test("idempotent: already-linked page ⇒ null", () => {
    expect(buildSeeAlsoEdit(PAGE, "Existing Link")).toBeNull();
  });

  test("blank title ⇒ null", () => {
    expect(buildSeeAlsoEdit(PAGE, "  ")).toBeNull();
  });
});

describe("selectWirablePages", () => {
  test("reproduced case: [unresolvable, A, B, C] — slice(0,3) BEFORE resolve, so C is dropped", () => {
    // The exact review-finding case: the old preview did filter-then-slice, which
    // kept A,B,C and promised C a backlink apply never made (apply slices first,
    // seeing [unresolvable, A, B] → only A, B resolve). Both now agree on A, B.
    const index = fakeIndex({
      A: "concepts/A.md",
      B: "concepts/B.md",
      C: "concepts/C.md",
    });
    const related = [
      { title: "Nope" }, // unresolvable
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ];
    const picked = selectWirablePages(related, index, "concepts/New.md");
    expect(picked.map((p) => p.title)).toEqual(["A", "B"]);
    expect(picked.map((p) => p.page.relPath)).toEqual(["concepts/A.md", "concepts/B.md"]);
  });

  test("falls back to relPath when the title no longer resolves", () => {
    const index = fakeIndex({ Renamed: "concepts/RAG.md" });
    const picked = selectWirablePages(
      [{ title: "RAG", relPath: "concepts/RAG.md" }],
      index,
      "concepts/New.md",
    );
    expect(picked.map((p) => p.page.relPath)).toEqual(["concepts/RAG.md"]);
  });

  test("skips a self-link (a related page resolving to targetPath)", () => {
    const index = fakeIndex({ Self: "concepts/New.md", Other: "concepts/Other.md" });
    const picked = selectWirablePages(
      [{ title: "Self" }, { title: "Other" }],
      index,
      "concepts/New.md",
    );
    expect(picked.map((p) => p.title)).toEqual(["Other"]);
  });

  test("null / empty related pages, or null index ⇒ []", () => {
    const index = fakeIndex({ A: "concepts/A.md" });
    expect(selectWirablePages(null, index, "concepts/New.md")).toEqual([]);
    expect(selectWirablePages([], index, "concepts/New.md")).toEqual([]);
    expect(selectWirablePages([{ title: "A" }], null, "concepts/New.md")).toEqual([]);
  });
});
