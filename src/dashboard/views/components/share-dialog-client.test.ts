/**
 * Build smoke for the standalone share-dialog bundle.
 *
 * `share-dialog-browser.ts` is an ENTRYPOINT, not an import: nothing in the repo
 * imports it and `tsc --noEmit` type-checks it in isolation. `/summaries` is its
 * one consumer (`summaries-page.ts` renders it into a `<script>`; the /wiki
 * reader imports the DOM module directly instead — see that file's header). So a
 * break in the bundle — an import the browser target cannot resolve, a
 * server-only module dragged in through a type-only-looking import — reaches the
 * page silently, and the page has no console anyone is watching.
 *
 * `Bun.build` is the only thing that catches that class, so it is run here. The
 * assertions are deliberately about the BUILD, not the behaviour (the behaviour
 * is `wiki-share-dialog.test.ts`, `e2e/wiki-share.spec.ts` and
 * `e2e/summaries-share.spec.ts`): it succeeds, it produces JS, that JS publishes
 * the globals the consuming page calls — and it does NOT carry the stylesheet.
 */

import { test, expect, describe } from "bun:test";
import { shareDialogClientScript } from "./share-dialog-client.ts";

describe("the standalone share-dialog bundle", () => {
  test("builds, and publishes the globals a bundler-less page calls", async () => {
    // A `Bun.build` failure throws out of the memoized accessor — the failure
    // mode this file exists to make loud.
    const js = await shareDialogClientScript();
    expect(js.length).toBeGreaterThan(1000);
    expect(js).toContain("openShareDialog");
    expect(js).toContain("closeShareDialog");
    // The retarget seam — /summaries calls it on every panel open, so a page
    // loading this bundle must find it beside the other two.
    expect(js).toContain("closeShareDialogOnNavigate");
    // `format: "iife"` — the script is dropped into a page's own scope, so it
    // must not leak bare top-level declarations or carry ESM syntax.
    expect(js).not.toContain("export ");
    // The two things a page reaches for after loading it.
    expect(js).toContain("globalThis");
  }, 30_000);

  test("it TREE-SHAKES the stylesheet — the host page must render that itself", async () => {
    // `shareDialogStyles()` lives in the pure module the entrypoint imports, but
    // nothing in the entrypoint's reachable graph calls it, so the bundler drops
    // it. That is fine and intended — but it means a page that loads ONLY this
    // script gets a transparent, unpositioned dialog (`e2e/summaries-share.spec.ts`
    // asserts the computed background for exactly that reason, and
    // `summaries-page.ts` renders `shareDialogStyles()` server-side).
    //
    // Pinned here because it is the cheap half of that pair: if a future refactor
    // makes the bundle START carrying the CSS, the page would then ship it TWICE
    // — and, worse, the /summaries z-index override would be racing a duplicate
    // rule set. The `{` is what makes this a CSS-RULE test: the class NAME appears
    // in the bundle legitimately (the scrim element is built in JS).
    const js = await shareDialogClientScript();
    expect(js).toContain("wiki-share-scrim");
    expect(js).not.toContain("wiki-share-scrim {");
  }, 30_000);

  test("it is memoized — a second request reuses the first build", async () => {
    const [a, b] = await Promise.all([shareDialogClientScript(), shareDialogClientScript()]);
    expect(a).toBe(b);
  }, 30_000);
});
