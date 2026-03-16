import { test, expect, describe } from "bun:test";
import { researchCardScript } from "./research-card.ts";

// research-card.ts only exports researchCardScript() — a browser-injectable JS string.
// parseResearchContent is defined inside that string, NOT as a TS export.
// We test the exported function and verify the JS string contains the expected definitions.

describe("researchCardScript", () => {
  test("returns a non-empty string", () => {
    const script = researchCardScript();
    expect(typeof script).toBe("string");
    expect(script.length).toBeGreaterThan(0);
  });

  test("contains RESEARCH_MARKER definition", () => {
    const script = researchCardScript();
    expect(script).toContain("RESEARCH_MARKER");
    expect(script).toContain("<!-- research:jira -->");
  });

  test("contains parseResearchContent function", () => {
    const script = researchCardScript();
    expect(script).toContain("function parseResearchContent(text)");
  });

  test("contains renderResearchCard function", () => {
    const script = researchCardScript();
    expect(script).toContain("function renderResearchCard(parsed)");
  });

  test("contains showResearchActions function", () => {
    const script = researchCardScript();
    expect(script).toContain("function showResearchActions(phase)");
  });

  test("contains saveResearchReport function", () => {
    const script = researchCardScript();
    expect(script).toContain("function saveResearchReport()");
  });

  test("parseResearchContent handles title + prompt + body", () => {
    // Evaluate the JS string in a controlled scope to test parseResearchContent
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input =
      "<!-- research:jira -->Analyze this task\n---\n# MELOSYS-7546 Fix login bug\n\nDescription here";
    const result = fn(input);
    expect(result.title).toBe("MELOSYS-7546 Fix login bug");
    expect(result.prompt).toBe("Analyze this task");
    expect(result.issueKey).toBe("MELOSYS-7546");
    expect(result.content).toContain("MELOSYS-7546 Fix login bug");
    expect(result.content).toContain("Description here");
  });

  test("parseResearchContent handles missing prompt (no --- separator)", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input = "<!-- research:jira --># PROJ-123 Some task\n\nBody text";
    const result = fn(input);
    expect(result.prompt).toBe("");
    expect(result.title).toBe("PROJ-123 Some task");
    expect(result.issueKey).toBe("PROJ-123");
  });

  test("parseResearchContent handles missing title (no heading)", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input = "<!-- research:jira -->Just some plain text without a heading";
    const result = fn(input);
    expect(result.title).toBe(
      "Just some plain text without a heading",
    );
    expect(result.issueKey).toBeNull();
  });

  test("parseResearchContent extracts issue key from heading with hash prefix", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input = "<!-- research:jira -->\n---\n## ABC-999 Title here";
    const result = fn(input);
    expect(result.issueKey).toBe("ABC-999");
  });

  test("parseResearchContent uses fallback title when content is empty-ish", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input = "<!-- research:jira -->";
    const result = fn(input);
    expect(result.title).toBe("Jira Task");
  });

  test("parseResearchContent truncates long non-heading first lines", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const longLine = "A".repeat(100);
    const input = "<!-- research:jira -->" + longLine;
    const result = fn(input);
    expect(result.title.length).toBeLessThanOrEqual(80);
    expect(result.title).toContain("...");
  });
});
