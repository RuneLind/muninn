import { test, expect, describe } from "bun:test";
import {
  factcheckBadgeHtml,
  factcheckProgressHtml,
  factcheckVerdictChipsHtml,
  factcheckVerdictCounts,
} from "./sum-factcheck-render.ts";
import { docPanelHtml, DOC_PANEL_FACTCHECK_BTN_ID } from "./doc-panel.ts";

describe("verdict chips", () => {
  test("counts in ✅ ⚠️ ❌ ❓ order, a bare ⚠ counted as ⚠️", () => {
    const claims = [{ verdict: "❌" }, { verdict: "✅" }, { verdict: "⚠" }, { verdict: "❌" }];
    expect(factcheckVerdictCounts(claims)).toEqual({ "✅": 1, "⚠️": 1, "❌": 2, "❓": 0 });
    const html = factcheckVerdictChipsHtml(claims);
    expect(html.indexOf("✅ 1")).toBeLessThan(html.indexOf("❌ 2"));
    expect(html).not.toContain("❓");
  });
});

describe("progress", () => {
  test("pending claims show ⏳, finished ones their verdict, titles escaped", () => {
    const html = factcheckProgressHtml([
      { index: 1, title: "a <b>", verdict: "✅" },
      { index: 2, title: "c" },
    ]);
    expect(html).toContain("a &lt;b&gt;");
    expect(html).toMatch(/class="done"><span class="sum-fc-v">✅/);
    expect(html).toMatch(/class="pending"><span class="sum-fc-v">⏳/);
    expect(factcheckProgressHtml([])).toContain("Extracting claims");
  });
});

describe("factcheckBadgeHtml", () => {
  test("✓ with no contradicted claim, ❌N with some, nothing when unchecked", () => {
    expect(factcheckBadgeHtml({ bad: 0, total: 4 })).toContain(">✓<");
    expect(factcheckBadgeHtml({ bad: 2, total: 4 })).toContain(">❌2<");
    expect(factcheckBadgeHtml(undefined)).toBe("");
  });
});

describe("doc panel ✓ Fact check button", () => {
  test("opt-in, rendered hidden (the client reveals it for a registered source)", () => {
    expect(docPanelHtml()).not.toContain(DOC_PANEL_FACTCHECK_BTN_ID);
    const html = docPanelHtml({ share: true, factcheck: true });
    expect(html).toMatch(new RegExp(`id="${DOC_PANEL_FACTCHECK_BTN_ID}" type="button" hidden`));
    expect(html.indexOf("docPanelShare")).toBeLessThan(html.indexOf(DOC_PANEL_FACTCHECK_BTN_ID));
  });
});
