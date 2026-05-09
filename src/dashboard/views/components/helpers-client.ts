/** Bundles `helpers-browser.ts` into an IIFE for injection into a page's
 *  inline `<script>`. Memoized as a Promise — concurrent first-request
 *  callers share one build. */

import { resolve } from "node:path";

let cachedScript: Promise<string> | null = null;

async function buildBundle(): Promise<string> {
  const entry = resolve(import.meta.dir, "helpers-browser.ts");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    minify: false,
  });
  if (!result.success) {
    throw new Error(`helpers-browser bundle failed:\n${result.logs.join("\n")}`);
  }
  return result.outputs[0]!.text();
}

export function helpersClientScript(): Promise<string> {
  return (cachedScript ??= buildBundle());
}
