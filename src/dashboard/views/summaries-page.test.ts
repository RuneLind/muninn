/**
 * `/summaries` COMPOSITION — the four things about mounting the share dialog on a
 * second page that only the rendered document can see.
 *
 * The dialog's own behaviour is `wiki-share-dialog.test.ts` + the two e2e specs.
 * What is asserted here is the wiring those cannot reach cheaply, and every one
 * of them fails silently in a browser rather than loudly anywhere:
 *
 *   1. The 📤 button is actually rendered (the `docPanelHtml({share:true})` flag).
 *   2. The stylesheet is rendered SERVER-side — the standalone bundle tree-shakes
 *      `shareDialogStyles()` (pinned from the other side in
 *      `share-dialog-client.test.ts`), so without this the dialog ships
 *      transparent and unpositioned.
 *   3. The z-index override is present — the dialog ships 59/60 for /wiki, which
 *      has no overlay, and this page's doc panel is a 1000.
 *   4. **Exactly one copy of the dialog module.** A page must reach it EITHER by
 *      import OR through the bundle, never both: two copies is two module states,
 *      two document-listener registrations, and a Generate button rendering from
 *      one while writing to the other.
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { renderSummariesPage } from "./summaries-page.ts";
import { DOC_PANEL_SHARE_BTN_ID, DOC_PANEL_DELETE_BTN_ID } from "./components/doc-panel.ts";
import { SHARE_DIALOG_ID } from "./components/wiki-share-dialog.ts";
import { VIMEO_MAX_DURATION_SEC } from "../../vimeo/limits.ts";
import { sumJobCardScript } from "./components/sum-job-card.ts";

let html = "";
// One render for the whole file: it runs a real `Bun.build` for each bundled
// client script.
beforeAll(async () => {
  html = await renderSummariesPage();
}, 60_000);

/**
 * Same guard as `/models`: a template-literal escape slip (`\\n` written as `\n`
 * inside the page script) emits a RAW newline into a JS string, and the browser
 * drops the WHOLE block — every renderer on the page dead behind a 200 and a
 * green string-assertion suite. Measured on this page: the Delete confirm
 * message did exactly that on its first draft. `new Function` parses without
 * executing, which is the check the browser performs.
 */
test("every inline script on /summaries parses as JavaScript", () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1] as string,
  );
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  expect(blocks.join("").length).toBeGreaterThan(10_000);
  const failures: string[] = [];
  blocks.forEach((body, i) => {
    try {
      new Function(body);
    } catch (err) {
      failures.push(`block ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  expect(failures).toEqual([]);
});

describe("renderSummariesPage — the share mount", () => {
  test("renders the 📤 Share button in the doc panel header", () => {
    expect(html).toContain(`id="${DOC_PANEL_SHARE_BTN_ID}"`);
  });

  test("renders the 🗑 Delete button, its notice slot, and the collection the click posts", () => {
    expect(html).toContain(`id="${DOC_PANEL_DELETE_BTN_ID}"`);
    // The panel closes on success, so the outcome needs a home on the page.
    expect(html).toContain('id="deleteNotice"');
    // The click posts a huginn COLLECTION, read off the injected source map — the
    // source id and the collection diverge (`x-article` → `x-articles`).
    expect(html).toContain('"collection":"x-articles"');
    expect(html).toContain("/api/wiki/gardener/backlog-doc-delete");
    // …with an EXPLICIT ?wiki= from the server-resolved target — the route's own
    // defaults answer a WIKI_DIR instance with a 404 and a WIKI_EXTRA one with a 400.
    // Non-null, since the button IS rendered above — the two are gated together.
    expect(html).toMatch(/const DELETE_TARGET = \{"wiki":"[^"]+"\};/);
    expect(html).toContain("'wiki=' + encodeURIComponent(DELETE_TARGET.wiki)");
  });

  test("renders the dialog stylesheet server-side — the bundle drops it", () => {
    // The CSS RULE, not just the class name: the bundle carries the name (it
    // builds the scrim element in JS) and nothing else.
    expect(html).toContain(".wiki-share-scrim {");
    expect(html).toContain(".wiki-share {");
  });

  test("scopes the z-index over the doc panel's 1000 overlay", () => {
    expect(html).toContain(".wiki-share-scrim { z-index: 1001; }");
    expect(html).toContain(".wiki-share { z-index: 1002; }");
  });

  test("mounts EXACTLY ONE copy of the dialog module", () => {
    // The bundle's own definition of the entry point. Two occurrences means the
    // page loaded the standalone script AND something imported the module into
    // another bundle on the same page.
    const copies = html.split("function openShareDialog").length - 1;
    expect(copies).toBe(1);
    // …and the globals it publishes are the ones the page script calls.
    expect(html).toContain("closeShareDialogOnNavigate");
  });

  test("the panel's Escape guard names the dialog's real id", () => {
    // Interpolated from `SHARE_DIALOG_ID`, not hand-spelled — a rename that
    // missed this guard would silently restore the one-Escape-closes-both bug.
    expect(html).toContain(`document.getElementById('${SHARE_DIALOG_ID}')`);
  });

  test("the share target is emitted from the builder, keys and all", () => {
    // The page script must post the field NAMES the route reads, and carry the
    // surface's own copy rather than /wiki's nouns.
    expect(html).toContain('"endpoint":"/api/summaries/share"');
    expect(html).toContain('"presetsUrl":"/api/summaries/share/presets"');
    expect(html).toContain('"source":_shareDoc.source');
    expect(html).toContain('"docId":_shareDoc.docId');
    expect(html).toContain("A share is already running for this document.");
  });
});

describe("summaries page: the Vimeo cap is injected, not spelled", () => {
  /**
   * The job card's two cap-naming sentences read a bare global. If the page
   * stops emitting it the card throws a ReferenceError the moment a refusal
   * arrives — a silent break, since nothing else on the page touches it.
   */
  test("renders the kind + language picker beside the URL field, shipped kinds by default", () => {
    expect(html).toContain('<select id="captureKind"');
    expect(html).toContain('<option value="standard">Standard</option>');
    expect(html).toContain('<option value="deep">');
    expect(html).toContain('<option value="talk-notes">');
    expect(html).toContain('<select id="captureLang"');
    expect(html).toContain('<option value="talk">');
    expect(html).toContain('<option value="nb">Norsk (bokmål)</option>');
    expect(html).toContain('<option value="en">English</option>');
  });

  test("a caller-supplied kind list (the summarizer bot's) is what the picker offers", async () => {
    const custom = await renderSummariesPage({
      captureKinds: [{ id: "standard", label: "Standard" }, { id: "brief", label: "Brief (ours)" }],
    });
    expect(custom).toContain('<option value="brief">Brief (ours)</option>');
    expect(custom).not.toContain('<option value="deep">');
  });

  test("declares VIMEO_MAX_DURATION_SEC with the SERVER's value", () => {
    expect(html).toContain(`const VIMEO_MAX_DURATION_SEC = ${VIMEO_MAX_DURATION_SEC};`);
    // …and the constant it names is the one the route enforces.
    expect(VIMEO_MAX_DURATION_SEC).toBe(3 * 60 * 60);
  });

  test("the card script reads that global rather than a literal cap", () => {
    expect(sumJobCardScript()).toContain("VIMEO_MAX_DURATION_SEC");
    // The old spelling: the number as prose inside the sentences.
    expect(sumJobCardScript()).not.toContain("the 3 h cap");
  });
});
