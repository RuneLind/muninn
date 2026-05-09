/** Shared `Bun.build → IIFE → memoize` wrapper. Each browser entrypoint
 *  (helpers-browser, web-format-browser, traces-waterfall-browser) gets its
 *  own memoized accessor — concurrent first-request callers share one build,
 *  and subsequent requests return the cached Promise.
 *
 *  Usage:
 *      const getScript = makeBundledClientScript("traces-waterfall-browser.ts", import.meta.dir);
 *      // …
 *      const js = await getScript();
 */

export function makeBundledClientScript(
  entryFilename: string,
  callerDir: string,
): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => (cached ??= build(entryFilename, callerDir));
}

async function build(entryFilename: string, callerDir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [`${callerDir}/${entryFilename}`],
    target: "browser",
    format: "iife",
    minify: false,
  });
  if (!result.success) {
    throw new Error(`${entryFilename} bundle failed:\n${result.logs.join("\n")}`);
  }
  return result.outputs[0]!.text();
}
