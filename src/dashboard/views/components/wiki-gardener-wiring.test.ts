import { test, expect, describe } from "bun:test";
import { wiringHtml, type WiringPreview } from "./wiki-gardener-wiring.ts";

const model = (over: Partial<WiringPreview> = {}): WiringPreview => ({
  indexLine: "- [[Code Mode]] — MCP code exec pattern",
  indexSkip: null,
  seeAlso: ["RAG", "Model Context Protocol"],
  legacyNoRelated: false,
  ...over,
});

describe("wiringHtml", () => {
  test("null model → empty string (terminal rows render nothing)", () => {
    expect(wiringHtml(null)).toBe("");
    expect(wiringHtml(undefined)).toBe("");
  });

  test("renders the planned index line and See-also targets", () => {
    const html = wiringHtml(model());
    expect(html).toContain("Wiring on approve");
    expect(html).toContain("<code>- [[Code Mode]] — MCP code exec pattern</code>");
    expect(html).toContain("RAG, Model Context Protocol");
  });

  test("entity → index entry shows the manual-file skip note", () => {
    const html = wiringHtml(model({ indexSkip: "entity", indexLine: null }));
    expect(html).toContain("skipped (entity — file manually)");
    expect(html).not.toContain("<code>");
  });

  test("not-in-policy (e.g. source on a concept-only wiki) → policy skip note, NOT 'entity'", () => {
    const html = wiringHtml(model({ indexSkip: "not-in-policy", indexLine: null }));
    expect(html).toContain("skipped (not in this wiki's cataloging policy)");
    expect(html).not.toContain("entity");
    expect(html).not.toContain("<code>");
  });

  test("legacy row (null related_pages) → pre-migration note", () => {
    const html = wiringHtml(model({ legacyNoRelated: true, seeAlso: [] }));
    expect(html).toContain("no related-pages data (pre-migration proposal)");
  });

  test("no resolved related pages → 'none'", () => {
    const html = wiringHtml(model({ seeAlso: [] }));
    expect(html).toContain("inbound links:</span> none");
  });

  test("escapes titles", () => {
    const html = wiringHtml(model({ seeAlso: ["<script>"] }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
