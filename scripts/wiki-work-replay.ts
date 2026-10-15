#!/usr/bin/env bun
/**
 * Replay the work facts of one wiki as of an instant (plan
 * `muninn-wiki-work-threads`, D17):
 *
 *   bun scripts/wiki-work-replay.ts --wiki <name> --at <iso>
 *
 * Builds the index on a `git clone --shared` of the wiki's repo checked out at
 * the newest first-parent commit authored at or before `at` — content, series,
 * page set and git dates as of `at`, with every file's mtime set to its last
 * commit time (`buildExplainerMeta` dates `.html` pages by mtime). The ledger
 * answers come from `CLAUDE_USAGE_URL` (Bun loads `.env`) for the REGISTERED
 * root: the summary form at `until = at` and at `until = at − 8 d`, and the
 * sessions form over `[at − 8 d, at]`. They are injected through the memos'
 * deps with `now = at`, then `CLAUDE_USAGE_URL` is unset so the build itself
 * fetches nothing for the clone's path.
 *
 * Known limits: a session's per-file counts are aggregates, so a session that
 * spans `at` (its `last` is after it) cannot be split and is dropped; opencode
 * titles are latest-wins upstream, so `named` reads today's title; a page
 * written only by a dropped session gets a pre-`at` worked date from the summary
 * form but no events.
 *
 * Output is local only: melosys-kode-wiki titles are NAV data (D21). Nothing is
 * written anywhere but the temp clone, which is removed on exit.
 */

import { mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getWikiRegistry } from "../src/wiki/registry-memo.ts";
import { buildWikiIndex, type WikiIndex } from "../src/wiki/store.ts";
import { refreshWorkedLedger } from "../src/wiki/worked-ledger.ts";
import { refreshWorkSessions } from "../src/wiki/work-sessions.ts";
import { threadScore, WORK_WINDOW_MS, type WorkThread } from "../src/wiki/work-focus.ts";
import { claudeUsageJson } from "../src/utils/claude-usage-fetch.ts";
import { projectCounts, toListing } from "../src/dashboard/routes/wiki-routes.ts";
import { railInputFor } from "../src/dashboard/views/components/wiki-rail-input.ts";
import { DEFAULT_ACTIVITY_WEIGHTS, parseActivityWeights, workedGateFor } from "../src/dashboard/views/components/wiki-activity-rank.ts";
import { resolveSortMode, type WikiFilters, type WikiListing } from "../src/dashboard/views/components/wiki-filter.ts";
import type { RailInput } from "../src/dashboard/views/components/wiki-recents.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "core.quotePath=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim()}`);
  return out;
}

/** The newest first-parent commit authored at or before `atSec`. */
async function commitAt(repo: string, atSec: number): Promise<{ sha: string; at: number }> {
  for (const line of (await git(repo, ["log", "--first-parent", "--format=%H %at", "HEAD"])).split("\n")) {
    const [sha, t] = line.split(" ");
    if (sha && Number(t) <= atSec) return { sha, at: Number(t) };
  }
  throw new Error("no commit at or before --at");
}

/** Every tracked file's mtime set to its last commit time (all ≤ `at` after
 *  the checkout). */
async function stampMtimes(repo: string): Promise<number> {
  const newest = new Map<string, number>();
  let t = 0;
  for (const line of (await git(repo, ["log", "--format=%x00%at", "--name-only", "HEAD"])).split("\n")) {
    if (line.startsWith("\u0000")) t = Number(line.slice(1));
    else if (line && !newest.has(line)) newest.set(line, t);
  }
  let n = 0;
  for (const file of (await git(repo, ["ls-files"])).split("\n")) {
    const at = newest.get(file);
    if (!file || at === undefined) continue;
    try {
      await utimes(path.join(repo, file), at, at);
      n++;
    } catch {
      // A file the checkout did not produce (a submodule path) keeps its time.
    }
  }
  return n;
}

/** The viewer defaults the shipped rail opens with: no stored sort, families
 *  off, no pins, no open folds, no filters. */
function defaultRailInput(index: WikiIndex, listing: WikiListing[], now: number): { input: RailInput; sort: string } {
  const filters: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };
  const coverage = index.workedCoverage;
  const mode = resolveSortMode({
    current: "updated",
    stored: null,
    touched: false,
    workedShown: coverage ? coverage.matched > 0 : null,
  });
  const weights = index.readerConfig?.activity ? parseActivityWeights(index.readerConfig.activity).weights : DEFAULT_ACTIVITY_WEIGHTS;
  const input = railInputFor(
    {
      allPages: listing,
      projects: projectCounts(index.pages),
      activityWeights: weights,
      workedGate: workedGateFor(listing, weights, now, coverage?.asOfMs),
    },
    { mode, now, filters, showRetired: false, familiesOn: false, pins: [], openFolds: [] },
  );
  return { input, sort: mode };
}

function displayTitle(index: WikiIndex, relPath: string): string {
  const p = index.pages.find((m) => m.relPath === relPath);
  const title = p ? (p.displayTitle ?? p.title) : relPath;
  const cut = title.indexOf(" — ");
  return cut === -1 ? title : title.slice(0, cut);
}

function printThreads(index: WikiIndex, threads: WorkThread[], at: number): void {
  const work = (relPath: string) => index.pages.find((m) => m.relPath === relPath)?.work;
  console.log(`\nWork threads (${threads.length}), raw-work order at --at:`);
  threads.forEach((t, i) => {
    console.log(`${i + 1}. ${displayTitle(index, t.pages[0]!)}  [${threadScore(t, work, at).toFixed(2)}]  key=${t.key}`);
    console.log(`   pages:   ${t.pages.join(", ")}`);
    if (t.touched.length) console.log(`   touched: ${t.touched.join(", ")}`);
    console.log(`   sessions: ${t.sessions.length}`);
  });
}

async function main(): Promise<void> {
  const wikiName = arg("wiki");
  const atIso = arg("at");
  if (!wikiName || !atIso || Number.isNaN(Date.parse(atIso))) {
    console.error("usage: bun scripts/wiki-work-replay.ts --wiki <name> --at <iso>");
    process.exit(2);
  }
  const at = Date.parse(atIso);
  const sinceMs = at - WORK_WINDOW_MS;
  const registry = getWikiRegistry();
  const entry = registry.find((e) => e.name.toLowerCase() === wikiName.toLowerCase());
  if (!entry) throw new Error(`no registered wiki named ${wikiName}`);
  const baseUrl = (process.env.CLAUDE_USAGE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("CLAUDE_USAGE_URL is not set");
  const registeredRoot = path.resolve(entry.root);

  // The three ledger answers, for the REGISTERED root.
  const q = (p: string) => claudeUsageJson(baseUrl, `/api/files?root=${encodeURIComponent(registeredRoot)}&${p}`, { label: baseUrl });
  const [summaryAt, preWindow, sessionsBody] = await Promise.all([
    q(`summary=1&until=${at}`),
    q(`summary=1&until=${sinceMs}`),
    q(`sessions=1&since=${sinceMs}&until=${at}`),
  ]);
  const raw = sessionsBody as { sessions?: { last: number }[] };
  const all = raw.sessions ?? [];
  const kept = all.filter((s) => s.last <= at);
  const spanning = all.length - kept.length;

  // The clone, at the commit authored at or before `at`.
  const toplevel = (await git(registeredRoot, ["rev-parse", "--show-toplevel"])).trim();
  const sub = path.relative(toplevel, await realpath(registeredRoot));
  const tmp = await mkdtemp(path.join(tmpdir(), "wiki-work-replay-"));
  const cleanup = () => rm(tmp, { recursive: true, force: true });
  process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));
  try {
    const repo = path.join(tmp, "repo");
    await git(tmp, ["clone", "--quiet", "--shared", "--no-checkout", toplevel, repo]);
    const commit = await commitAt(repo, Math.floor(at / 1000));
    await git(repo, ["checkout", "--quiet", "--detach", commit.sha]);
    const stamped = await stampMtimes(repo);
    const cloneRoot = path.join(repo, sub);

    const now = () => at;
    await refreshWorkedLedger(cloneRoot, { urlConfigured: true, baseUrl, now, fetchPages: async () => summaryAt });
    const memo = await refreshWorkSessions(
      cloneRoot,
      {
        urlConfigured: true,
        baseUrl,
        now,
        registry: async () => registry,
        fetchSessions: async () => ({ ...(sessionsBody as object), sessions: kept }),
        fetchPreWindow: async () => preWindow,
      },
      { identityRoot: registeredRoot },
    );
    if (!memo) throw new Error("the ledger answers did not parse (see the warn above)");

    delete process.env.CLAUDE_USAGE_URL;
    const index = await buildWikiIndex(cloneRoot);
    const listing = index.pages.map((m) => toListing(index, m, { includeWork: true })) as WikiListing[];

    console.log(`wiki ${entry.name} at ${new Date(at).toISOString()}`);
    console.log(`commit ${commit.sha.slice(0, 10)} (${new Date(commit.at * 1000).toISOString()}), ${index.pages.length} pages, ${stamped} mtimes set`);
    console.log(`sessions: ${kept.length} kept, ${spanning} dropped (span --at); window from ${new Date(sinceMs).toISOString()}`);
    printThreads(index, index.work?.threads ?? [], at);

    // The rail input the shipped viewer defaults produce — PR 4 prints
    // `rankActivity` rows 1–10 and the Worked-on top 10 from it, PR 5 the
    // `buildRail` sections.
    const rail = defaultRailInput(index, listing, at);
    console.log(`\nRail input: sort ${rail.sort}, ${rail.input.filtered.length} rows, ${rail.input.activity?.length ?? 0} Activity rows`);
  } finally {
    await cleanup();
  }
}

await main();
