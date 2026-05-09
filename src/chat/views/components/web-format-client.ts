/**
 * Bundles `web-format-browser.ts` into a self-contained IIFE for injection
 * into the chat page's inline `<script>`. The bundle inlines the server-side
 * `formatWebHtml` and `renderSlackMrkdwn` so the browser uses the SAME
 * functions as the server — eliminating the manual port that previously
 * had to be kept in sync by hand.
 *
 * Result is memoized — Bun.build runs at most once per process.
 */

import { resolve } from "node:path";

let cachedScript: string | null = null;
let inflight: Promise<string> | null = null;

async function buildBundle(): Promise<string> {
  const entry = resolve(import.meta.dir, "web-format-browser.ts");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    minify: false,
  });
  if (!result.success) {
    const logs = result.logs.map((l) => String(l)).join("\n");
    throw new Error(`web-format-browser bundle failed:\n${logs}`);
  }
  const out = result.outputs[0];
  if (!out) throw new Error("web-format-browser bundle produced no outputs");
  return out.text();
}

export async function webFormatClientScript(): Promise<string> {
  if (cachedScript !== null) return cachedScript;
  if (!inflight) {
    inflight = buildBundle().then((text) => {
      cachedScript = text;
      return text;
    });
  }
  return inflight;
}
