/**
 * Boots muninn for `e2e/summaries-find-links.spec.ts` with Find links' two
 * model calls and its page fetch canned IN-PROCESS (`findLinksTestSeam`, the
 * `toolSurfaceTestSeam` precedent), so the spec drives the REAL options,
 * candidates, search (SSE) and save routes — the run pool, the labeller and the
 * server-held verified results included — with no model and no public web.
 *
 * The fixture is a JSON file named by `FIND_LINKS_E2E_FIXTURE` (read here only,
 * never by `src/`):
 * `{candidates, candidatesByMarker?: {marker: candidates}, agents: {topic: rawAnswer},
 * agentDelays?: {topic: ms}, pages: {url: SafePage}}` — a summary carrying a
 * marker gets that marker's list. Each agent launch appends its topic to the
 * file `FIND_LINKS_E2E_LAUNCH_LOG` names, when set, so the spec can count launches.
 * Run as `bun e2e/find-links-boot.ts`, with the spec's usual env.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { findLinksTestSeam } from "../src/dashboard/routes/summaries-links.ts";
import type { SafePage } from "../src/summaries/safe-fetch.ts";

const path = process.env.FIND_LINKS_E2E_FIXTURE;
if (!path) throw new Error("FIND_LINKS_E2E_FIXTURE is not set");
const fixture = JSON.parse(readFileSync(path, "utf8")) as {
  candidates: unknown[];
  candidatesByMarker?: Record<string, unknown[]>;
  agents: Record<string, string>;
  agentDelays?: Record<string, number>;
  pages: Record<string, SafePage>;
};

const launchLog = process.env.FIND_LINKS_E2E_LAUNCH_LOG;

findLinksTestSeam.candidatesCall = async (prompt) => {
  const marked = Object.entries(fixture.candidatesByMarker ?? {}).find(([marker]) => prompt.includes(marker));
  return JSON.stringify(marked ? marked[1] : fixture.candidates);
};
findLinksTestSeam.agent = async (c) => {
  if (launchLog) appendFileSync(launchLog, `${c.topic}\n`);
  // Long enough for the panel to paint the "searching" state.
  await new Promise((r) => setTimeout(r, fixture.agentDelays?.[c.topic] ?? 150));
  return fixture.agents[c.topic] ?? '{"results": []}';
};
findLinksTestSeam.fetchPage = async (url) => fixture.pages[url] ?? null;

await import("../src/index.ts");
