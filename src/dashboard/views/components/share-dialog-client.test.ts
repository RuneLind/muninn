/**
 * Build smoke for the standalone share-dialog bundle.
 *
 * `share-dialog-browser.ts` is an ENTRYPOINT, not an import: nothing in the repo
 * imports it, `tsc --noEmit` type-checks it in isolation, and no page loads it
 * yet (the /wiki reader imports the DOM module directly — see that file's
 * header). So a break in the bundle — an import the browser target cannot
 * resolve, a server-only module dragged in through a type-only-looking import —
 * ships completely silently until /summaries mounts it in PR C.
 *
 * `Bun.build` is the only thing that catches that class, so it is run here. The
 * assertions are deliberately about the BUILD, not the behaviour (the behaviour
 * is `wiki-share-dialog.test.ts` and `e2e/wiki-share.spec.ts`): it succeeds, it
 * produces JS, and that JS actually publishes the two globals the consuming page
 * will call.
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
    // `format: "iife"` — the script is dropped into a page's own scope, so it
    // must not leak bare top-level declarations or carry ESM syntax.
    expect(js).not.toContain("export ");
    // The two things a page reaches for after loading it.
    expect(js).toContain("globalThis");
  }, 30_000);

  test("it is memoized — a second request reuses the first build", async () => {
    const [a, b] = await Promise.all([shareDialogClientScript(), shareDialogClientScript()]);
    expect(a).toBe(b);
  }, 30_000);
});
