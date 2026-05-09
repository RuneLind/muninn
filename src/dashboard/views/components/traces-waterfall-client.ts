/** Bundles `traces-waterfall-browser.ts` into an IIFE for injection into the
 *  traces page's inline `<script>`. Memoized as a Promise — concurrent
 *  first-request callers share one build. */

import { resolve } from "node:path";

let cachedScript: Promise<string> | null = null;

async function buildBundle(): Promise<string> {
  const entry = resolve(import.meta.dir, "traces-waterfall-browser.ts");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    minify: false,
  });
  if (!result.success) {
    throw new Error(`traces-waterfall-browser bundle failed:\n${result.logs.join("\n")}`);
  }
  return result.outputs[0]!.text();
}

export function tracesWaterfallClientScript(): Promise<string> {
  return (cachedScript ??= buildBundle());
}
