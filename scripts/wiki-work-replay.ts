#!/usr/bin/env bun
/**
 * Replay the work facts of one wiki as of an instant (plan
 * `muninn-wiki-work-threads`, D17):
 *
 *   bun scripts/wiki-work-replay.ts --wiki <name> --at <iso> [--pos <relPath>]…
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
 * Environment (Bun loads `.env` from the checkout; a worktree or CI checkout
 * has none, so set these by hand there):
 *   - `CLAUDE_USAGE_URL` — the ledger's base URL.
 *   - The wiki registry `--wiki` is looked up in: `WIKI_EXTRA` (standalone
 *     wikis, e.g. mimir) and the bots under `MUNINN_BOTS_DIR` (absolute; default
 *     the checkout's `bots/`), whose `wikiDir` registers a bot wiki.
 *
 * A session that spans `at` (resumed after it) is CLIPPED, not dropped
 * (`clipSessionsAt`): it keeps the file rows upstream returns at `until = at`,
 * with its `last` clamped to the newest of those rows, else `at`. The summary
 * form at `until = at` drops the same rows, so the two inputs agree.
 *
 * Known limits: upstream drops a whole (session, path, op) row whose last write
 * is after `at`, so a clipped session keeps only the files it finished before
 * `at`. A file it first wrote before `at` and wrote again after is missing,
 * though the live rail at `at` saw it; `bulk` is computed over the kept rows
 * and can differ from the live answer (`first` is unaffected). Its
 * prompt-to-file attribution (`text`) is not cut at `at`. Opencode titles are
 * latest-wins upstream, so `named` reads today's title.
 *
 * It prints the threads, the pre-lift Activity ranking (rows 1–10, with each
 * row's derivation), the rendered Work threads section (cards, open state,
 * rows), the post-lift Activity section, every series the lift left ghosts in,
 * and the Worked-on top 10 (sort instant, state, shown date). The sections come
 * from `railInputFor` + `buildRail`, never a re-assembly (D20).
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
import { clipSessionsAt, parsePreWindow, parseWorkSessions, refreshWorkSessions } from "../src/wiki/work-sessions.ts";
import { parseWorkedPages } from "../src/wiki/worked-ledger.ts";
import { threadScore, WORK_WINDOW_MS, type WorkThread } from "../src/wiki/work-focus.ts";
import { claudeUsageHttpStatus, claudeUsageJson } from "../src/utils/claude-usage-fetch.ts";
import { projectCounts, toListing } from "../src/dashboard/routes/wiki-routes.ts";
import { railInputFor } from "../src/dashboard/views/components/wiki-rail-input.ts";
import {
  DEFAULT_ACTIVITY_WEIGHTS,
  pageWorkTerm,
  parseActivityWeights,
  rankActivity,
  workedGateFor,
  type ActivityWeights,
  type WorkedGate,
} from "../src/dashboard/views/components/wiki-activity-rank.ts";
import {
  isMetaPage,
  resolveSortMode,
  sortPages,
  workedShownSignal,
  workedSortMs,
  type WikiFilters,
  type WikiListing,
} from "../src/dashboard/views/components/wiki-filter.ts";
import { buildRail, type RailInput } from "../src/dashboard/views/components/wiki-recents.ts";
import { railGhostNote, threadMetaLine } from "../src/dashboard/views/components/wiki-thread-view.ts";

/** A failure the script explains in one stderr line instead of a stack. */
class ReplayError extends Error {}

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
function defaultRailInput(
  index: WikiIndex,
  listing: WikiListing[],
  now: number,
): { input: RailInput; sort: string; weights: ActivityWeights; gate: WorkedGate } {
  const filters: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };
  const coverage = index.workedCoverage;
  const mode = resolveSortMode({
    current: "updated",
    stored: null,
    touched: false,
    workedShown: coverage ? coverage.matched > 0 : null,
  });
  const weights = index.readerConfig?.activity ? parseActivityWeights(index.readerConfig.activity).weights : DEFAULT_ACTIVITY_WEIGHTS;
  const gate = workedGateFor(listing, weights, now, coverage?.asOfMs);
  const input = railInputFor(
    {
      allPages: listing,
      projects: projectCounts(index.pages),
      activityWeights: weights,
      workedGate: gate,
      work: index.work ?? null,
    },
    { mode, now, filters, showRetired: false, familiesOn: false, pins: [], openFolds: [], threadPin: null },
  );
  return { input, sort: mode, weights, gate };
}

/** The pre-lift Activity ranking, rows 1–10: the same `rankActivity` call
 *  `railInputFor` makes over the same rows, with room for ten. */
function printActivity(input: RailInput, weights: ActivityWeights, gate: WorkedGate, at: number): void {
  const rows = rankActivity(input.filtered, { ...weights, rows: Math.max(weights.rows, 10) }, at, gate).slice(0, 10);
  console.log(`\nActivity, pre-lift (gate ${gate.open ? "open" : "closed"}: ${gate.covered}/${gate.candidates}, rows ${weights.rows}):`);
  rows.forEach((r, i) => {
    const work = pageWorkTerm(r.page, at);
    const bar = r.page.work ? `  work ${work.toFixed(2)}` : "";
    console.log(`${String(i + 1).padStart(2)}. ${r.score.toFixed(2)} ${r.kind.padEnd(7)} ${r.page.relPath}${bar}`);
    console.log(`    ${r.why}`);
  });
}

/** The Work threads section `buildRail` draws: each card (open or closed, 📌),
 *  an open card's focus rows (NEW, work term) and its touched line. */
function printThreadsSection(input: RailInput, at: number): void {
  const entries = buildRail(input).entries.filter((e) => e.section === "threads");
  console.log(`\nWork threads section (buildRail): ${entries.length ? "" : "none"}`);
  let row = 0;
  for (const e of entries) {
    if (e.kind === "thread") {
      const c = e.card;
      // The header the rail draws: name, then `threadMetaLine` — the view's own
      // meta line, ✋ included (the owner's view: `movesPersonal` on).
      console.log(`  ${e.folded ? "▸" : "▾"} ${c.name}${c.pinned ? "  📌" : ""}  [score ${c.score.toFixed(2)}]`);
      console.log(`      ${threadMetaLine(c, at, true)}`);
    } else if (e.kind === "row") {
      row++;
      const fresh = e.created ? " NEW" : "";
      console.log(`     ${String(row).padStart(2)}. ${e.page.relPath}  work ${pageWorkTerm(e.page, at).toFixed(2)}${fresh}`);
    } else if (e.kind === "touched") {
      console.log(`     touched: ${e.pages.map((p) => p.relPath).join(" · ")}`);
    }
  }
}

/** Every series that holds a ghost after the lift, and why each ghost is one —
 *  read off the group entry (`ghostReasons`), which carries them whether its
 *  fold is open or closed; absent, no card lifted anything and every ghost is
 *  a pin's. The note is the view's own (`railGhostNote`). */
function printSeriesGhosts(input: RailInput): void {
  const rail = buildRail(input);
  console.log(`\nSeries ghosts after the lift:`);
  let any = false;
  for (const e of rail.entries) {
    if (e.kind !== "group" || !e.ghosts?.length) continue;
    any = true;
    console.log(`  ${e.group.label} (${e.section}${e.folded ? ", closed" : ""}):`);
    e.ghosts.forEach((g, i) => console.log(`     ghost ${g.relPath} — ${railGhostNote(e.ghostReasons?.[i] ?? "pinned")}`));
  }
  if (!any) console.log("  none");
}

/** The Activity section `buildRail` draws from that input, AFTER the work-thread
 *  lift — each row, and each closed series with the members its peek shows (D12). */
function printActivitySection(input: RailInput): void {
  console.log(`\nActivity section (buildRail, post-lift):`);
  for (const e of buildRail(input).entries) {
    if (e.section !== "activity" || e.kind === "header") continue;
    if (e.kind === "group") console.log(`  ▸ series ${e.group.label} (${e.members.length} members${e.folded ? ", closed" : ""})`);
    else if (e.kind === "row") console.log(`  ${e.member ? "    " : ""}${e.page.relPath}`);
    else if (e.kind === "more") console.log(`      +${e.hidden} more`);
  }
}

/** The Worked-on order, top 10, plus the position of every `--pos` page: the
 *  rail's own sort, bookkeeping sunk. */
function printWorkedOn(input: RailInput, at: number): void {
  const all = sortPages(input.filtered, "worked", at).filter((p) => !isMetaPage(p));
  const watch = process.argv.flatMap((a, i) => (process.argv[i - 1] === "--pos" ? [a] : []));
  const rows = all.slice(0, 10);
  console.log(`\nWorked on, top 10:`);
  for (const rel of watch) {
    const i = all.findIndex((p) => p.relPath === rel);
    console.log(`   --pos ${rel}: ${i < 0 ? "not listed" : `row ${i + 1} of ${all.length}`}`);
  }
  rows.forEach((p, i) => {
    const shown = workedShownSignal(p, at);
    const state = p.work?.state ?? "N";
    const mark = shown.touched ? `  touched ${shown.touched.label}` : "";
    console.log(`${String(i + 1).padStart(2)}. ${new Date(workedSortMs(p, at)).toISOString().slice(0, 16)} [${state}] ${p.relPath}  shown ${shown.label}${mark}`);
  });
}

function displayTitle(index: WikiIndex, relPath: string): string {
  const p = index.pages.find((m) => m.relPath === relPath);
  const title = p ? (p.displayTitle ?? p.title) : relPath;
  const cut = title.indexOf(" — ");
  return cut > 0 ? title.slice(0, cut) : title;
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
  if (!entry) {
    const names = registry.map((e) => e.name).join(", ") || "none";
    throw new ReplayError(
      `no registered wiki named ${wikiName} (registered: ${names}). A wiki registers through WIKI_EXTRA or a bot's wikiDir under MUNINN_BOTS_DIR; set them when the checkout has no .env`,
    );
  }
  const baseUrl = (process.env.CLAUDE_USAGE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new ReplayError("CLAUDE_USAGE_URL is not set");
  const registeredRoot = path.resolve(entry.root);

  // The three ledger answers, for the REGISTERED root.
  const q = async (p: string): Promise<unknown> => {
    const route = `/api/files?root=${encodeURIComponent(registeredRoot)}&${p}`;
    try {
      return await claudeUsageJson(baseUrl, route, { label: baseUrl });
    } catch (err) {
      const status = claudeUsageHttpStatus(err);
      const why = status === null ? (err instanceof Error ? err.message : String(err)) : `HTTP ${status}`;
      throw new ReplayError(`${baseUrl}${route}: ${why}`);
    }
  };
  const [summaryAt, preWindow, sessionsBody] = await Promise.all([
    q(`summary=1&until=${at}`),
    q(`summary=1&until=${sinceMs}`),
    q(`sessions=1&since=${sinceMs}&until=${at}`),
  ]);
  // Parsed here, so a bad answer names its reason: the memos' own warns go to
  // LogTape, which this script does not configure.
  const checks = [
    ["summary at --at", parseWorkedPages(summaryAt)],
    ["summary at window start", parsePreWindow(preWindow, sinceMs)],
    ["sessions", parseWorkSessions(sessionsBody)],
  ] as const;
  for (const [what, r] of checks) {
    if (!r.ok) throw new ReplayError(`the ledger's ${what} answer did not parse: ${r.reason}: ${r.detail}`);
  }
  const raw = sessionsBody as { sessions: { last: number; files?: { lastMs: number }[] }[] };
  const { sessions: kept, clipped } = clipSessionsAt(raw.sessions, at);

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
    if (!memo) throw new ReplayError("the work-sessions memo did not build from answers that parsed");

    delete process.env.CLAUDE_USAGE_URL;
    const index = await buildWikiIndex(cloneRoot);
    const listing = index.pages.map((m) => toListing(index, m, { includeWork: true })) as WikiListing[];

    console.log(`wiki ${entry.name} at ${new Date(at).toISOString()}`);
    console.log(`commit ${commit.sha.slice(0, 10)} (${new Date(commit.at * 1000).toISOString()}), ${index.pages.length} pages, ${stamped} mtimes set`);
    console.log(`sessions: ${kept.length} kept, ${clipped} clipped (span --at); window from ${new Date(sinceMs).toISOString()}`);
    printThreads(index, index.work?.threads ?? [], at);

    // The rail input the shipped viewer defaults produce — PR 4 prints
    // `rankActivity` rows 1–10 and the Worked-on top 10 from it, PR 5 the
    // `buildRail` sections (Work threads, post-lift Activity, series ghosts).
    const rail = defaultRailInput(index, listing, at);
    console.log(`\nRail input: sort ${rail.sort}, ${rail.input.filtered.length} rows, ${rail.input.activity?.length ?? 0} Activity rows`);
    printActivity(rail.input, rail.weights, rail.gate, at);
    printThreadsSection(rail.input, at);
    printActivitySection(rail.input);
    printSeriesGhosts(rail.input);
    printWorkedOn(rail.input, at);
  } finally {
    await cleanup();
  }
}

try {
  await main();
} catch (err) {
  if (!(err instanceof ReplayError)) throw err;
  console.error(`wiki-work-replay: ${err.message}`);
  process.exit(1);
}
