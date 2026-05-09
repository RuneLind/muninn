/**
 * Bundles `web-format-browser.ts` into a self-contained IIFE for injection
 * into the chat page's inline `<script>`. The bundle inlines the server-side
 * `formatWebHtml` and `renderSlackMrkdwn` so the browser uses the SAME
 * functions as the server — eliminating the manual port that previously
 * had to be kept in sync by hand.
 *
 * Memoized as a Promise — concurrent first-request callers share one build.
 */

import { resolve } from "node:path";

let cachedScript: Promise<string> | null = null;

async function buildBundle(): Promise<string> {
  const entry = resolve(import.meta.dir, "web-format-browser.ts");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    minify: false,
  });
  if (!result.success) {
    throw new Error(`web-format-browser bundle failed:\n${result.logs.join("\n")}`);
  }
  return result.outputs[0]!.text();
}

export function webFormatClientScript(): Promise<string> {
  return (cachedScript ??= buildBundle());
}
