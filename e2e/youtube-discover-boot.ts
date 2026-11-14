/**
 * Boots muninn for `e2e/summaries-youtube-discover.spec.ts` with ▶ Find on
 * YouTube's two model calls and its yt-dlp search canned IN-PROCESS
 * (`discoverTestSeam`, the `find-links-boot.ts` precedent), so the spec drives
 * the REAL discover route — the known-video dedup against the fake huginn
 * listing included — with no model and no YouTube.
 *
 * The fixture is a JSON file named by `YOUTUBE_DISCOVER_E2E_FIXTURE` (read here
 * only, never by `src/`): `{queries: string, rank: string, search: {query: YouTubeHit[] | null}}`
 * — the raw model answers and the hits per query (`null` = that search failed).
 * Run as `bun e2e/youtube-discover-boot.ts`, with the spec's usual env.
 */

import { readFileSync } from "node:fs";
import { discoverTestSeam } from "../src/dashboard/routes/summaries-discover.ts";
import type { YouTubeHit } from "../src/youtube/discover.ts";

const path = process.env.YOUTUBE_DISCOVER_E2E_FIXTURE;
if (!path) throw new Error("YOUTUBE_DISCOVER_E2E_FIXTURE is not set");
const fixture = JSON.parse(readFileSync(path, "utf8")) as {
  queries: string;
  rank: string;
  search: Record<string, YouTubeHit[] | null>;
};

discoverTestSeam.queriesCall = async () => {
  // Long enough for the panel to paint its loading state.
  await new Promise((r) => setTimeout(r, 300));
  return fixture.queries;
};
discoverTestSeam.rankCall = async () => fixture.rank;
discoverTestSeam.search = async (query) => (query in fixture.search ? fixture.search[query]! : []);

await import("../src/index.ts");
