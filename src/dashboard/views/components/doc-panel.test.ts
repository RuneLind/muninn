import { describe, test, expect } from "bun:test";
import { docPanelHtml, docPanelScript, DOC_PANEL_SHARE_BTN_ID, DOC_PANEL_DELETE_BTN_ID } from "./doc-panel.ts";

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

  test("the Share action is opt-in too — /search, /research and chat get neither", () => {
    // It needs the share-dialog bundle AND its (server-rendered) CSS, which only
    // /summaries mounts; on any other page the button would be a dead control.
    expect(docPanelHtml()).not.toContain(DOC_PANEL_SHARE_BTN_ID);
    expect(docPanelHtml()).toBe(docPanelHtml({ askFollowUp: false, share: false }));
    const html = docPanelHtml({ askFollowUp: true, share: true });
    expect(html).toContain(`id="${DOC_PANEL_SHARE_BTN_ID}"`);
    expect(html).toContain("Share");
    // …and the two opt-ins are independent.
    expect(docPanelHtml({ share: true })).not.toContain("docPanelFollowUp");
  });

  test("the Delete action is opt-in too, and independent of the other two", () => {
    // It posts to the gardener's doc-delete route, which only means something for a
    // captured summary — /search and /research show arbitrary collections.
    expect(docPanelHtml()).not.toContain(DOC_PANEL_DELETE_BTN_ID);
    expect(docPanelHtml()).toBe(docPanelHtml({ remove: false }));
    const html = docPanelHtml({ remove: true });
    expect(html).toContain(`id="${DOC_PANEL_DELETE_BTN_ID}"`);
    expect(html).toContain("Delete");
    expect(html).not.toContain(DOC_PANEL_SHARE_BTN_ID);
    expect(html).not.toContain("docPanelFollowUp");
  });

  test("the shared opener seeds the follow-up href from the doc title", () => {
    const script = docPanelScript();
    expect(script).toContain("setFollowUpHref");
    expect(script).toContain("/research?q=");
  });
});
