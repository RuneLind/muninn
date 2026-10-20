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
import { themeTokenStyles } from "./shared-styles.ts";
import { DOC_PANEL_SHARE_BTN_ID, DOC_PANEL_DELETE_BTN_ID, DOC_PANEL_EXPORT_LINK_ID } from "./components/doc-panel.ts";
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

/**
 * The ⬇ Export link: rendered hidden as a download anchor (the browser's own
 * download handling is the whole client), and the opener's href builder names
 * the route with both identity keys — so the anchor cannot point at a route
 * that 400s the source it was opened for.
 */
test("the doc panel renders the Export download link and the opener targets the export route", () => {
  const anchor = new RegExp(`<a[^>]*id="${DOC_PANEL_EXPORT_LINK_ID}"[^>]*>`).exec(html)?.[0] ?? "";
  expect(anchor).toContain("download");
  expect(anchor).toContain("hidden");
  expect(html).toContain("'/api/summaries/export?source=' + encodeURIComponent(source) + '&docId=' + encodeURIComponent(docId)");
});

/**
 * The page's scripts share one scope, so a helper declared twice is decided
 * by whichever declaration runs last, and the other copy (and any test that
 * pins it) is dead. The reader's injected functions call `mapProseLines` and
 * the library script declares it; the reader must not inject a second one.
 */
test("mapProseLines and the reader's imports are declared once on the page", () => {
  for (const name of ["mapProseLines", "extractYouTubeVideoId"]) {
    // A named function expression (`var x = function x(`) is not a declaration.
    const decls = html.match(new RegExp(`(?<!=\\s*)\\bfunction\\s+${name}\\s*\\(|\\b(?:var|let|const)\\s+${name}\\s*=`, "g")) ?? [];
    expect(decls.length, name).toBe(1);
  }
});

/**
 * The `.duplicate-banner` fill and the `.delete-notice` link, resolved through
 * each palette the page ships. Both banners share the fill, so the link and the
 * body text are measured on it in both themes. Before the fix the fill fell
 * back to a fixed #2a2f3a (`--accent-dim` was defined nowhere) and the light
 * link measured 2.65:1.
 */
describe("banner contrast in both themes", () => {
  const block = (re: RegExp) => re.exec(themeTokenStyles())?.[1] ?? "";
  const palettes: Record<string, Map<string, string>> = {
    dark: tokenMap(block(/:root \{([^}]*)\}/)),
    light: tokenMap(block(/html\[data-theme="light"\] \{([^}]*)\}/)),
  };
  const rule = (selector: string, prop: string) => {
    const body = new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(html)?.[1] ?? "";
    return new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? "";
  };
  for (const [theme, tokens] of Object.entries(palettes)) {
    test(`${theme}: the banner's link and text reach 4.5:1 on its fill`, () => {
      expect(tokens.size).toBeGreaterThan(10);
      const fill = resolveColor(rule(".duplicate-banner", "background"), tokens);
      const link = resolveColor(rule(".delete-notice a", "color"), tokens);
      const text = resolveColor(rule(".duplicate-banner", "color"), tokens);
      expect(contrast(link, fill)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    });
    // The banner sits on the body, so its fill must read as a fill against the
    // body's own ground. `--bg-surface` measured 1.017:1 on the light page (an
    // invisible banner); 1.1 is a floor that `--bg-surface` (light) and
    // `--bg-panel` (dark, 1.06) both miss.
    test(`${theme}: the banner's fill is visibly different from the page`, () => {
      const body = /(?:^|[\s}])body\s*\{([^}]*)\}/.exec(html)?.[1] ?? "";
      const page = resolveColor(/(?:^|[;\s])background:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? "", tokens);
      const fill = resolveColor(rule(".duplicate-banner", "background"), tokens);
      expect(contrast(fill, page)).toBeGreaterThanOrEqual(1.1);
    });
  }
});

function tokenMap(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1] ?? "", (m[2] ?? "").trim());
  return out;
}

/** `var(--x[, fallback])` resolved against a palette, as a browser would:
 *  the token when defined, else the fallback. */
function resolveColor(value: string, tokens: Map<string, string>): string {
  const m = /^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/.exec(value);
  if (!m) return value;
  const v = tokens.get(m[1] ?? "") ?? m[2]?.trim() ?? "";
  return v.startsWith("var(") ? resolveColor(v, tokens) : v;
}

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    expect(full).toMatch(/^[0-9a-f]{6}$/i);
    const [r, g, bl] = [0, 2, 4]
      .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
