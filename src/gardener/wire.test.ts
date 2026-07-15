import { test, expect, describe } from "bun:test";
import { buildIndexEntry, insertIndexLine, buildSeeAlsoEdit } from "./wire.ts";

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
