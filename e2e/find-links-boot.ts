/**
 * Boots muninn for `e2e/summaries-find-links.spec.ts` with Find links' two
 * model calls and its page fetch canned IN-PROCESS (`findLinksTestSeam`, the
 * `toolSurfaceTestSeam` precedent), so the spec drives the REAL options,
 * candidates, search (SSE) and save routes — the run pool, the labeller and the
 * server-held verified results included — with no model and no public web.
 *
 * The fixture is a JSON file named by `FIND_LINKS_E2E_FIXTURE` (read here only,
 * never by `src/`): `{candidates, agents: {topic: rawAnswer}, pages: {url: SafePage}}`.
 * Run as `bun e2e/find-links-boot.ts`, with the spec's usual env.
 */

import { readFileSync } from "node:fs";
import { findLinksTestSeam } from "../src/dashboard/routes/summaries-links.ts";
import type { SafePage } from "../src/summaries/safe-fetch.ts";

const path = process.env.FIND_LINKS_E2E_FIXTURE;
if (!path) throw new Error("FIND_LINKS_E2E_FIXTURE is not set");
const fixture = JSON.parse(readFileSync(path, "utf8")) as {
  candidates: unknown[];
  agents: Record<string, string>;
  pages: Record<string, SafePage>;
};

findLinksTestSeam.candidatesCall = async () => JSON.stringify(fixture.candidates);
findLinksTestSeam.agent = async (c) => {
  // Long enough for the panel to paint the "searching" state.
  await new Promise((r) => setTimeout(r, 150));
  return fixture.agents[c.topic] ?? '{"results": []}';
};
findLinksTestSeam.fetchPage = async (url) => fixture.pages[url] ?? null;

await import("../src/index.ts");
