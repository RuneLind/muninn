import { describe, test, expect } from "bun:test";
import {
  docPanelHtml,
  docPanelScript,
  DOC_PANEL_SHARE_BTN_ID,
  DOC_PANEL_DELETE_BTN_ID,
  DOC_PANEL_RERUN_BTN_ID,
  DOC_PANEL_RERUN_MENU_ID,
  DOC_PANEL_MORE_BTN_ID,
  DOC_PANEL_MORE_MENU_ID,
  DOC_PANEL_COPY_LINK_ID,
  DOC_PANEL_EXPORT_LINK_ID,
  DOC_PANEL_DISCOVER_BTN_ID,
} from "./doc-panel.ts";
import { MARKED_CDN_SCRIPT } from "./doc-panel.ts";

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

  test("▶ Find on YouTube is opt-in: without the flag every other page's markup is unchanged", () => {
    expect(docPanelHtml()).not.toContain(DOC_PANEL_DISCOVER_BTN_ID);
    const everyOther = { askFollowUp: true, share: true, remove: true, exportPage: true, rerun: true, moreMenu: true, factcheck: true, findLinks: true };
    expect(docPanelHtml(everyOther)).toBe(docPanelHtml({ ...everyOther, discover: false }));
    expect(docPanelHtml(everyOther)).not.toContain(DOC_PANEL_DISCOVER_BTN_ID);
    // Hidden until the client sees a youtube document.
    expect(docPanelHtml({ discover: true })).toMatch(new RegExp(`id="${DOC_PANEL_DISCOVER_BTN_ID}" type="button" hidden`));
  });

  test("the re-run control is a real MENU button, so a screen reader announces the popup", () => {
    // `aria-haspopup="menu"` (not the default `true`, which announces a plain
    // menu-less popup) plus the `aria-controls` pointing at the `role="menu"`
    // node and an initial `aria-expanded="false"` the script toggles. Every one
    // of them is invisible on screen, so nothing but this asserts them.
    const html = docPanelHtml({ rerun: true });
    expect(html).toContain(`id="${DOC_PANEL_RERUN_BTN_ID}"`);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain(`aria-controls="${DOC_PANEL_RERUN_MENU_ID}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`id="${DOC_PANEL_RERUN_MENU_ID}" role="menu"`);
    // Opt-in like its three siblings: /search, /research and chat render none.
    expect(docPanelHtml()).not.toContain(DOC_PANEL_RERUN_BTN_ID);
  });

  test("the shared opener seeds the follow-up href from the doc title", () => {
    const script = docPanelScript();
    expect(script).toContain("setFollowUpHref");
    expect(script).toContain("/research?q=");
  });

  test("a summary collection adds factcheck=<source>:<docId>; any other collection does not", () => {
    const el = { href: "" };
    const doc = { getElementById: () => el, addEventListener: () => {} };
    const setFollowUpHref = new Function("document", `${docPanelScript()}; return setFollowUpHref;`)(doc) as (
      title: string,
      collection?: string,
      docId?: string,
    ) => void;
    setFollowUpHref("A Talk", "x-articles", "tech/A: Talk.md");
    expect(el.href).toBe("/research?q=A%20Talk&factcheck=" + encodeURIComponent("x-article:tech/A: Talk.md"));
    setFollowUpHref("A Talk", "wiki", "concepts/a.md");
    expect(el.href).toBe("/research?q=A%20Talk");
    setFollowUpHref("A Talk", "toString", "x.md");
    expect(el.href).toBe("/research?q=A%20Talk");
  });
});

// A document's stored `url` is any scheme; "Open source" links only when
// isSafeLinkHref allows it (arch review 2026-11-16, F70).
describe("openDocPanel: the source link is gated", () => {
  async function open(webUrl: string, fetchedUrl: string): Promise<{ before: string; after: string }> {
    const els: Record<string, { innerHTML: string; textContent: string; href: string; classList: { add(): void; contains(): boolean } }> = {};
    const el = (id: string) =>
      (els[id] ??= { innerHTML: "", textContent: "", href: "", classList: { add() {}, contains: () => false } });
    const doc = { getElementById: el, addEventListener: () => {}, body: { style: {} } };
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const fetchStub = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "a/T.md", text: "x", url: fetchedUrl }) });
    const openDocPanel = new Function("document", "fetch", "esc", "marked", `${docPanelScript()}; return openDocPanel;`)(
      doc, fetchStub, (s: string) => String(s).replace(/"/g, "&quot;"), undefined,
    ) as (c: string, d: string, u: string) => void;
    openDocPanel("c", "a/T.md", webUrl);
    const before = els.docPanelLinks!.innerHTML;
    setTimeout(resolve, 10);
    await done;
    return { before, after: els.docPanelLinks!.innerHTML };
  }

  test("a javascript: url renders no link, before or after the fetch", async () => {
    const r = await open("javascript:window.__pwn=1", "javascript:window.__pwn=1");
    expect(r.before).toBe("");
    expect(r.after).toBe("");
  });

  test("an https url links, before and after the fetch", async () => {
    const r = await open("https://example.com/a", "https://example.com/b");
    expect(r.before).toContain('href="https://example.com/a"');
    expect(r.after).toContain('href="https://example.com/b"');
  });
});

describe("docPanelHtml moreMenu", () => {
  const menuOf = (html: string) => {
    const start = html.indexOf(`id="${DOC_PANEL_MORE_MENU_ID}"`);
    return html.slice(start, html.indexOf("</div>", start));
  };

  test("Export, Copy link and Delete sit inside a role=menu popup opened by ⋯ More", () => {
    const html = docPanelHtml({ askFollowUp: true, remove: true, exportPage: true, moreMenu: true });
    expect(html).toContain(`id="${DOC_PANEL_MORE_BTN_ID}"`);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain(`aria-controls="${DOC_PANEL_MORE_MENU_ID}"`);
    const menu = menuOf(html);
    expect(menu).toContain('role="menu"');
    expect(menu).toContain(`id="${DOC_PANEL_EXPORT_LINK_ID}"`);
    expect(menu).toContain(`id="${DOC_PANEL_COPY_LINK_ID}"`);
    expect(menu).toContain(`id="${DOC_PANEL_DELETE_BTN_ID}"`);
    expect((menu.match(/role="menuitem"/g) ?? []).length).toBe(3);
  });

  test("no delete target: no Delete item; no exportPage: no Export item", () => {
    const menu = menuOf(docPanelHtml({ moreMenu: true }));
    expect(menu).not.toContain(DOC_PANEL_DELETE_BTN_ID);
    expect(menu).not.toContain(DOC_PANEL_EXPORT_LINK_ID);
    expect(menu).toContain(DOC_PANEL_COPY_LINK_ID);
  });

  test("Ask a follow-up, the primary action, and the source link follow the title in the DOM, as on screen", () => {
    const html = docPanelHtml({ askFollowUp: true, share: true, rerun: true, moreMenu: true });
    const at = (needle: string) => html.indexOf(needle);
    expect(at('id="docPanelTitle"')).toBeLessThan(at('id="docPanelFollowUp"'));
    expect(at('id="docPanelFollowUp"')).toBeLessThan(at('id="docPanelLinks"'));
    expect(at('id="docPanelLinks"')).toBeLessThan(at(`id="${DOC_PANEL_RERUN_BTN_ID}"`));
    expect(at(`id="${DOC_PANEL_SHARE_BTN_ID}"`)).toBeLessThan(at(`id="${DOC_PANEL_MORE_BTN_ID}"`));
    expect(html.match(/id="docPanelFollowUp"/g)).toHaveLength(1);
    expect(html).toContain('class="doc-panel-followup doc-panel-primary" id="docPanelFollowUp"');
  });

  test("off, it changes nothing: the /summaries flag set renders as it did before", () => {
    const flags = { askFollowUp: true, share: true, remove: true, exportPage: true, rerun: true };
    expect(docPanelHtml(flags)).toBe(docPanelHtml({ ...flags, moreMenu: false }));
    expect(docPanelHtml(flags)).not.toContain(DOC_PANEL_MORE_BTN_ID);
  });
});

/**
 * The flagless header, pinned byte for byte. /search, /research and chat call
 * `docPanelHtml()` with no arguments; every /summaries control is an opt-in
 * flag, and this string is what keeps a new flag from leaking into the others.
 */
const FLAGLESS_DOC_PANEL_HTML = `
  <div class="doc-overlay" id="docOverlay" onclick="if(event.target===this)closeDocPanel()">
    <div class="doc-panel">
      <div class="doc-panel-header">
        <button class="doc-panel-close" onclick="closeDocPanel()">&larr; Back</button>
        <span class="doc-panel-title" id="docPanelTitle"></span>
        <div class="doc-panel-links" id="docPanelLinks"></div>
      </div>
      <div class="doc-panel-body" id="docPanelBody"></div>
    </div>
  </div>`;

test("the flagless docPanelHtml() is byte-identical to the pinned golden string", () => {
  expect(docPanelHtml()).toBe(FLAGLESS_DOC_PANEL_HTML);
});

/**
 * The export (`src/summaries/export.ts`) renders with the npm `marked` and
 * promises to match the article view, which loads marked from this CDN tag.
 * Two literals, one promise — pinned so a `bun update marked` cannot make the
 * export drift from the page the reader compared it against.
 */
test("the marked CDN tag and the marked dependency are the same version", async () => {
  const pkg = (await import("../../../../package.json")) as { dependencies: Record<string, string> };
  const version = pkg.dependencies["marked"];
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(MARKED_CDN_SCRIPT).toContain(`marked@${version}/`);
});
