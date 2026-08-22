/**
 * What only a whole-page render can see.
 *
 * The composer's behaviour is unit-tested in
 * `views/components/jira-composer-pure.test.ts`; this file pins the three things
 * that live in the SEAM between the page and its bundle, each of which is
 * invisible to tsc and to every pure test:
 *
 *   1. the shell ids the bundle mounts into,
 *   2. that the client bundle is actually inlined (a memoized `Bun.build` that
 *      threw would leave a page with a shell and no behaviour),
 *   3. that the `?draft=` landing, the poll target and the markdown preview
 *      pipeline are all present in the shipped script.
 */

import { describe, expect, test } from "bun:test";
import { renderJiraPage, renderJiraFallback } from "./jira-page.ts";

const page = await renderJiraPage();

describe("the shell", () => {
  test("renders the three columns the bundle mounts into", () => {
    for (const id of ["jcRoot", "jcLeft", "jcMid", "jcRight"]) {
      expect(page).toContain(`id="${id}"`);
    }
  });

  test("marks Jira active inside the Tools dropdown, not the top-level row", () => {
    expect(page).toContain('<a href="/jira" class="nav-dropdown-item active">Jira</a>');
    // The top-level row must not have grown an eleventh link.
    expect(page).not.toContain('<a href="/jira" class="nav-link');
  });

  test("carries the doc panel the citation titles open", () => {
    expect(page).toContain('id="docOverlay"');
    expect(page).toContain("function openDocPanel");
  });

  test("says what to do with no JavaScript rather than rendering a blank page", () => {
    expect(page).toContain("<noscript>");
    expect(page).toContain("POST /api/jira/draft");
  });
});

describe("the inlined bundle", () => {
  test("fetches the picker from the templates endpoint", () => {
    expect(page).toContain("/api/jira/templates");
  });

  test("reads ?draft= and POLLS the draft row — never a stream re-attach", () => {
    // The landing reads the query param…
    expect(page).toMatch(/searchParams\.get\(\s*"draft"\s*\)/);
    // …and drives the GET, which is the only thing a `generating` row answers.
    expect(page).toContain("/api/jira/draft/");
    // A re-POST of identical content would hit the single-flight 409, so the
    // page must not have a second POST path keyed off the draft param.
    expect(page).toContain("shouldStopPolling");
  });

  test("renders the preview through muninn's own markdown pipeline", () => {
    // `formatWebHtml` is published on globalThis by the web-format bundle; a
    // page that shipped without it would fall back to escaped source text.
    expect(page).toContain("formatWebHtml");
    expect(page).toContain("sanitizeHtml");
  });

  test("consumes the stream with fetch + a frame parser, not EventSource", () => {
    // The 409 carries `expiresAtMs` in the body of a NON-200, which an
    // EventSource never surfaces — hence the reader loop and the shared framing.
    expect(page).toContain("getReader");
    expect(page).toContain("makeSseFrameParser");
    expect(page).toContain("expiresAtMs");
  });
});

describe("the fallback", () => {
  test("names the failure and points at the API that still works", () => {
    const html = renderJiraFallback("bundle failed: <boom>");
    expect(html).toContain("bundle failed: &lt;boom&gt;");
    expect(html).toContain("POST /api/jira/draft");
  });
});
