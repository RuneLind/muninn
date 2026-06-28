import { describe, test, expect } from "bun:test";
import { docPanelHtml, docPanelScript } from "./doc-panel.ts";

describe("docPanelHtml askFollowUp", () => {
  test("omits the follow-up action by default (Research/Search use this)", () => {
    const html = docPanelHtml();
    expect(html).not.toContain("docPanelFollowUp");
    expect(html).not.toContain("Ask a follow-up");
  });

  test("default render is byte-identical to passing askFollowUp:false", () => {
    expect(docPanelHtml()).toBe(docPanelHtml({ askFollowUp: false }));
  });

  test("opt-in render adds an 'Ask a follow-up' action linking into /research", () => {
    const html = docPanelHtml({ askFollowUp: true });
    expect(html).toContain('id="docPanelFollowUp"');
    expect(html).toContain("Ask a follow-up");
    expect(html).toContain('href="/research"');
  });

  test("the shared opener seeds the follow-up href from the doc title", () => {
    const script = docPanelScript();
    expect(script).toContain("setFollowUpHref");
    expect(script).toContain("/research?q=");
  });
});
