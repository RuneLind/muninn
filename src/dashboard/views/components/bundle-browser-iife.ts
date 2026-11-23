/** Shared `Bun.build → IIFE → memoize` wrapper. Each browser entrypoint
 *  (helpers-browser, web-format-browser, traces-waterfall-browser) gets its
 *  own memoized accessor — concurrent first-request callers share one build,
 *  and subsequent requests return the cached Promise. A failed build is not
 *  kept: the next request builds again, so a fixed client file is picked up
 *  without a restart.
 *
 *  Usage:
 *      const getScript = makeBundledClientScript("traces-waterfall-browser.ts", import.meta.dir);
 *      // …
 *      const js = await getScript();
 *
 *  `minify` defaults to false (the bundles inlined into a page stay readable in
 *  view-source); the /wiki reader passes true because it is served as its own
 *  cached asset (`getWikiAssets`, `wiki-page.ts`).
 */

export function makeBundledClientScript(
  entryFilename: string,
  callerDir: string,
  opts: { minify?: boolean } = {},
): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => {
    if (cached) return cached;
    const p = build(entryFilename, callerDir, opts.minify ?? false);
    cached = p;
    p.catch(() => {
      if (cached === p) cached = null;
    });
    return p;
  };
}

async function build(entryFilename: string, callerDir: string, minify: boolean): Promise<string> {
  const result = await Bun.build({
    entrypoints: [`${callerDir}/${entryFilename}`],
    target: "browser",
    format: "iife",
    minify,
    // Return the failure rather than throw it, so the message below names the entry.
    throw: false,
  });
  if (!result.success) {
    throw new Error(`${entryFilename} bundle failed:\n${result.logs.join("\n")}`);
  }
  return result.outputs[0]!.text();
}
