import { test, expect, describe } from "bun:test";
import {
  factcheckAnswerHtml,
  factcheckBadgeHtml,
  factcheckCheckedLabel,
  factcheckProgressHtml,
  factcheckVerdictChipsHtml,
  factcheckVerdictCounts,
} from "./sum-factcheck-render.ts";
import { docPanelHtml, DOC_PANEL_FACTCHECK_BTN_ID } from "./doc-panel.ts";

describe("factcheckAnswerHtml", () => {
  test("renders through the wiki reader's formatter: confidence chip, clickable source", () => {
    const html = factcheckAnswerHtml(
      "### ❌ Claim 1/1 — x\n\nWrong.\n\nConfidence: 35/100\n\nSources: [who.int](https://who.int/a)",
    );
    expect(html).toContain('<span class="wiki-fc-conf-chip lo">35/100</span>');
    expect(html).toContain('href="https://who.int/a"');
    expect(html).not.toContain("Confidence: 35/100");
  });

  test("escapes HTML in the answer", () => {
    expect(factcheckAnswerHtml("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });
});

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

describe("factcheckCheckedLabel", () => {
  test("minutes, hours, days", () => {
    const now = 10 * 86_400_000;
    expect(factcheckCheckedLabel(now - 5_000, now)).toBe("checked just now");
    expect(factcheckCheckedLabel(now - 5 * 60_000, now)).toBe("checked 5 min ago");
    expect(factcheckCheckedLabel(now - 3 * 3_600_000, now)).toBe("checked 3 h ago");
    expect(factcheckCheckedLabel(now - 2 * 86_400_000, now)).toBe("checked 2 d ago");
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
