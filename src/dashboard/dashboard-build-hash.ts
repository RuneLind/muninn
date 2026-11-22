import { createHash } from "node:crypto";
import { helpersClientScript } from "./views/components/helpers-client.ts";
import { tracesWaterfallClientScript } from "./views/components/traces-waterfall-client.ts";

/**
 * Stable hash of the inlined browser bundles served into every dashboard page.
 *
 * Dashboard pages embed bundled JS as inline `<script>` strings rather than
 * fetching it from a versioned URL, so a stale-bundle workflow gotcha shows
 * up when an operator's browser tab keeps the previous page's HTML in memory
 * after muninn restarts — the trace data is fresh, but the rendering layer
 * isn't (this bit us on 2026-05-15 around the rescue chip rollout).
 *
 * Pages that inject the {@link buildHashMetaTag} into `<head>` get an
 * automatic visibility-change check (defined in `helpers-browser.ts`):
 * when the tab becomes visible again, the client fetches
 * `/api/dashboard-build-hash` and shows a refresh banner on mismatch.
 *
 * The hash itself is memoized — first call triggers both bundle builds
 * concurrently and SHA-1s their concatenation; every subsequent call is a
 * cache hit. A failed build is not kept: the next call builds again, so one
 * broken client file does not fail every page that embeds the hash until a
 * restart. On muninn restart the memo is reset (new process) and the first
 * request rebuilds. Process restart is the only thing that changes the hash,
 * which is exactly the "should I tell the operator to reload" boundary.
 */
export const getDashboardBuildHash = makeBuildHash([helpersClientScript, tracesWaterfallClientScript]);

/** The memoized hash over `sources`' bundles; exported so a test can hand it a
 *  build that fails once. */
export function makeBuildHash(sources: readonly (() => Promise<string>)[]): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => {
    if (cached) return cached;
    const p = compute(sources);
    cached = p;
    p.catch(() => {
      if (cached === p) cached = null;
    });
    return p;
  };
}

async function compute(sources: readonly (() => Promise<string>)[]): Promise<string> {
  const bundles = await Promise.all(sources.map((s) => s()));
  const h = createHash("sha1");
  for (const b of bundles) h.update(b);
  return h.digest("hex").slice(0, 12);
}

/** `<meta>` tag pages embed in `<head>` so the visibility-change watcher
 *  can read the initial hash without a startup fetch. */
export function buildHashMetaTag(hash: string): string {
  return `<meta name="muninn-build-hash" content="${hash}">`;
}
