/** Shared `Bun.build → IIFE → memoize` wrapper. Each browser entrypoint
 *  (helpers-browser, web-format-browser, traces-waterfall-browser) gets its
 *  own memoized accessor — concurrent first-request callers share one build,
 *  and subsequent requests return the cached Promise.
 *
 *  Usage:
 *      const getScript = makeBundledClientScript("traces-waterfall-browser.ts", import.meta.dir);
 *      // …
 *      const js = await getScript();
 *
 *  `minify` defaults to false (the bundles inlined into a page stay readable in
 *  view-source); the /wiki reader passes true because it is served as its own
 *  cached asset (`getWikiAssets`, `wiki-page.ts`).
 *
 *  Every build goes through `bundleRecorderPlugin`, which hands the bundler
 *  muninn's own sources itself and records their hashes, so the `restart=`
 *  step check can tell a memoized bundle from the disk (`boot-fingerprint.ts`).
 */

import { bundleRecorderPlugin, MUNINN_CHECKOUT } from "../../../wiki/step-checks/boot-fingerprint.ts";

export function makeBundledClientScript(
  entryFilename: string,
  callerDir: string,
  opts: { minify?: boolean } = {},
): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => (cached ??= build(entryFilename, callerDir, opts.minify ?? false));
}

async function build(entryFilename: string, callerDir: string, minify: boolean): Promise<string> {
  const result = await Bun.build({
    entrypoints: [`${callerDir}/${entryFilename}`],
    target: "browser",
    format: "iife",
    minify,
    plugins: [bundleRecorderPlugin(MUNINN_CHECKOUT)],
  });
  if (!result.success) {
    throw new Error(`${entryFilename} bundle failed:\n${result.logs.join("\n")}`);
  }
  return result.outputs[0]!.text();
}
