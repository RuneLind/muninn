import { describe, expect, test } from "bun:test";
import { railTypeIconHtml } from "./wiki-type-icon.ts";

describe("railTypeIconHtml", () => {
  test("a built-in type gets its own icon, class and accessible name", () => {
    const plan = railTypeIconHtml("plan");
    expect(plan).toContain('class="wiki-type-icon ti-plan"');
    expect(plan).toContain('aria-label="plan"');
    expect(plan).toContain("<title>plan</title>");
    expect(plan).not.toBe(railTypeIconHtml("explainer").replace(/explainer/g, "plan"));
  });

  test("a custom ontology type falls back to the generic page icon, escaped", () => {
    const custom = railTypeIconHtml('decision"<x>&R');
    expect(custom).toContain("<title>decision&quot;&lt;x&gt;&amp;R</title>");
    expect(custom).not.toContain("<x>");
    // Same drawing as any other unknown type: the generic page.
    expect(custom.split("</title>")[1]).toBe(railTypeIconHtml("other-type").split("</title>")[1]);
  });

  test("an empty type reads as `page`", () => {
    expect(railTypeIconHtml("")).toContain("<title>page</title>");
    expect(railTypeIconHtml(undefined)).toContain('aria-label="page"');
  });

  test("an inherited object key is no icon: `constructor` gets the generic page, not function source", () => {
    const c = railTypeIconHtml("constructor");
    expect(c).not.toContain("function");
    expect(c.replace(/constructor/g, "T")).toBe(railTypeIconHtml("other-type").replace(/other-type/g, "T"));
  });

  test("the type is matched case-insensitively, the hover keeps the authored word", () => {
    const up = railTypeIconHtml("Plan");
    expect(up).toContain('class="wiki-type-icon ti-plan"');
    expect(up).toContain("<title>Plan</title>");
    expect(up.replace(/Plan/g, "plan")).toBe(railTypeIconHtml("plan"));
  });

  test("a type with spaces or punctuation becomes ONE class token", () => {
    const icon = railTypeIconHtml("design doc");
    expect(icon).toContain('class="wiki-type-icon ti-design-doc"');
    expect(icon).toContain("<title>design doc</title>");
    expect(railTypeIconHtml('a"b<c')).toContain('class="wiki-type-icon ti-a-b-c"');
  });
});
