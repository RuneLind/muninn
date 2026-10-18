#!/usr/bin/env bun
/**
 * Replay the work facts of one wiki as of an instant (plan
 * `muninn-wiki-work-threads`, D17):
 *
 *   bun scripts/wiki-work-replay.ts --wiki <name> --at <iso> [--pos <relPath>]…
 *     [--sessions-json <path> --pre-json <path> [--summary-json <path>]]
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
 * FROZEN ANSWERS. `--sessions-json` (the sessions form) and `--pre-json` (the
 * summary form at the window start) read captured ledger answers from files
 * instead of calling claude-usage, so a reaped session cannot change the
 * outcome; both or neither. `--summary-json` (the summary form at `until = at`)
 * is optional: without it the worked ledger is not loaded, and the Activity and
 * Worked-on sections run without worked dates (the threads do not read them).
 * A pre-window answer captured for a slightly different window start is
 * re-stamped to this replay's start, and the script says by how much and how
 * many of its rows land inside that gap. `CLAUDE_USAGE_URL` is not read.
 *
 * It prints the threads, the pre-lift Activity ranking (rows 1–10, with each
 * row's derivation), the rendered Work threads section (cards, open state,
 * rows), the post-lift Activity section, every series the lift left ghosts in,
 * and the Worked-on top 10 (sort instant, state, shown date), then the grouping
 * evidence (`IndexWork.evidence`: edges by kind, completeness, contribution
 * counts) and the `related:` census over every page. The sections come
 * from `railInputFor` + `buildRail`, never a re-assembly (D20).
 *
 * GROUPS (plan `muninn-wiki-work-thread-grouping`). Last, the work-thread
 * grouping model's cards over the full listing, before facets and the
 * five-card cap: `--group-stop <sessions|threads|related|areas>` (default
 * `related`) and `--group-evidence <series,related,issue|none>` (default all
 * three, D1). Then the matrix the plan measured: cards · threads in the
 * largest card, per stop and evidence set. `--split <relPath>` (repeatable,
 * PR 4) applies Make own thread to that page before grouping and prints each
 * split's own sessions and its remainder's key and sessions.
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
import { threadScore, WORK_WINDOW_MS, workSessionRef, type WorkEvidence, type WorkThread } from "../src/wiki/work-focus.ts";
import { claudeUsageHttpStatus, claudeUsageJson } from "../src/utils/claude-usage-fetch.ts";
import { projectCounts, toListing } from "../src/dashboard/routes/wiki-routes.ts";
import { railInputFor, workBoundariesOf } from "../src/dashboard/views/components/wiki-rail-input.ts";
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
import { buildRail, isRailGroupCard, type RailInput } from "../src/dashboard/views/components/wiki-recents.ts";
import { railGhostNote, threadGroupTally, threadMetaLine } from "../src/dashboard/views/components/wiki-thread-view.ts";
import { groupWorkThreads, type WorkWitness } from "../src/dashboard/views/components/wiki-work-groups.ts";
import { WORK_GROUP_STOPS, type WorkGroupEvidenceToggles, type WorkGroupStop } from "../src/dashboard/views/components/wiki-work-group-prefs.ts";

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

/** The GROUPED rail at `--group-stop` / `--group-evidence` (D1 by default):
 *  the Work threads section `buildRail` draws through `railInputFor` with the
 *  Group control — group cards, their children with the why line, an open
 *  child's rows, `+ N more threads`, shared context — then the five-card
 *  check: cards drawn, threads they hold, and the first card's shape. */
function printGroupedRail(index: WikiIndex, listing: WikiListing[], at: number): void {
  const { stop, toggles } = groupFlags();
  const splits = process.argv.flatMap((a, i) => (process.argv[i - 1] === "--split" ? [{ id: `replay${i}`, page: a }] : []));
  const filters: WikiFilters = { q: "", domain: "", folder: "", type: "", tag: "", status: "", followups: "", waiting: "", project: "", jira: "" };
  const input = railInputFor(
    { allPages: listing, projects: projectCounts(index.pages), activityWeights: DEFAULT_ACTIVITY_WEIGHTS, workedGate: null, work: index.work ?? null },
    { mode: "updated", now: at, filters, showRetired: false, familiesOn: false, pins: [], openFolds: [], threadPin: null, workGroup: { stop, evidence: toggles, splits } },
  );
  // Activity's weights and gate never move the cards, so the defaults serve.
  const ctl = input.workControl;
  console.log(`\nGrouped rail (buildRail, stop ${stop}, evidence ${Object.entries(toggles).filter(([, v]) => v).map(([k]) => k).join("+") || "none"}):`);
  if (ctl) {
    console.log(`  control: drawn ${ctl.stop}${ctl.stop !== ctl.requested ? ` (asked ${ctl.requested})` : ""}; ` + ctl.stops.map((x) => `${x.stop} ${x.available ? x.cards : `— ${x.reasons.join(",")}`}`).join(" · "));
  }
  for (const e of buildRail(input).entries.filter((x) => x.section === "threads")) {
    if (e.kind === "thread-group") {
      const c = e.card;
      console.log(`  ${e.folded ? "▸" : "▾"} ${c.label.toUpperCase()} ${c.name}${c.pinned ? "  📌" : ""}  — ${threadGroupTally(c, true)}${c.anchorVisible ? "" : "  (anchor outside the filters)"}`);
    } else if (e.kind === "thread") {
      const c = e.card;
      const pad = c.child ? "      " : "  ";
      console.log(`${pad}${e.folded ? "▸" : "▾"} ${c.name}${c.pinned ? "  📌" : ""}${c.boundary ? `  [${c.boundary === "split" ? "own thread" : "kept separate"}]` : ""}  — ${threadMetaLine(c, at, true)}${c.child ? `  · ${c.child.why}${c.child.also.length ? `  [also ${c.child.also.join(", ")}]` : ""}` : ""}`);
    } else if (e.kind === "row") {
      console.log(`           ${e.page.relPath}`);
    } else if (e.kind === "thread-group-end") {
      if (e.hidden) console.log(`      + ${e.hidden} more threads`);
      if (e.context.length) console.log(`      shared context: ${e.context.map((p) => p.relPath).join(" · ")}`);
    } else if (e.kind === "touched") {
      console.log(`      touched: ${e.pages.map((p) => p.relPath).join(" · ")}`);
    }
  }
  const cards = input.threads ?? [];
  const total = index.work?.threads.length ?? 0;
  const held = cards.reduce((n, c) => n + (isRailGroupCard(c) ? c.threads : 1), 0);
  const first = cards[0];
  const firstShape = !first
    ? "none"
    : isRailGroupCard(first)
      ? `${first.label} group «${first.name}», ${first.threads} children, ${first.children.length} drawn, ${new Set(groupWorkThreads({ work: index.work ?? null, allPages: listing, now: at, stop, toggles }).groups[0]?.children.flatMap((c) => c.owned.map((p) => p.relPath)) ?? []).size} focus pages`
      : `thread «${first.name}», ${first.focus.length} focus pages`;
  console.log(`  five-card check: ${cards.length} cards hold ${held} of ${total} threads; first card: ${firstShape}`);
  if (!splits.length) return;
  // PR 4: each --split page's own thread and its source's remainder (D15).
  const b = workBoundariesOf(index.work ?? null, listing, { splits, keptApart: [] });
  const ids = (t: { sessions: { id: string }[] }) => t.sessions.map((x) => x.id.slice(0, 8)).join(",");
  for (const d of b.definitions) {
    const own = b.threads.find((x) => x.split?.id === d.id);
    if (!own) {
      console.log(`  split ${d.stored}: ${d.state}`);
      continue;
    }
    const rem = b.threads.find((x) => x.source.key === own.source.key && x.sub === 0);
    console.log(`  split ${d.stored}: own thread, ${own.thread.sessions.length} sessions (${ids(own.thread)}); source ${own.source.key} had ${own.source.pages.length} pages, ${own.source.sessions.length} sessions`);
    console.log(rem ? `    remainder key ${rem.thread.key}, ${rem.thread.pages.length} pages, ${rem.thread.sessions.length} sessions (${ids(rem.thread)})` : `    remainder: none (the source emptied)`);
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

/** The grouping evidence: completeness, edges by kind (page pairs), the
 *  ambiguous issues and the contributions per thread. */
function printEvidence(index: WikiIndex, evidence: WorkEvidence | undefined): void {
  console.log(`\nGrouping evidence:`);
  if (!evidence) {
    console.log("  absent (no evidence block on this build)");
    return;
  }
  const r = evidence.relations;
  const c = evidence.contributions;
  const why = (complete: boolean, reasons: readonly string[]) => (complete ? "complete" : `INCOMPLETE (${reasons.join(", ")})`);
  console.log(`  version ${evidence.version}; threads ${evidence.threads.shipped} shipped of ${evidence.threads.candidates} candidates`);
  console.log(`  relations: ${why(r.complete, r.reasons)}; contributions: ${why(c.complete, c.reasons)}${c.cut.length ? `, ${c.cut.length} threads cut whole` : ""}`);
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const { evidence: _e, ...bare } = index.work!;
  console.log(
    `  bytes: IndexWork ${bytes(index.work)} with evidence, ${bytes(bare)} without; evidence ${bytes(evidence)} ` +
      `(relations ${bytes(r)}, contributions ${bytes(c)}); ${r.related.length + r.issues.length + r.ambiguousIssues.length} relation entries, ${c.rows.length} rows`,
  );
  const threadOf = new Map<string, number>();
  (index.work?.threads ?? []).forEach((t, i) => t.pages.forEach((p) => threadOf.has(p) || threadOf.set(p, i + 1)));
  const at = (p: string) => `${p} [t${threadOf.get(p) ?? "?"}]`;
  const seriesKeys = new Map<string, string[]>();
  for (const [p, k] of Object.entries(r.series)) seriesKeys.set(k, [...(seriesKeys.get(k) ?? []), p]);
  const projectKeys = new Map<string, string[]>();
  for (const [p, k] of Object.entries(r.projects)) projectKeys.set(k, [...(projectKeys.get(k) ?? []), p]);
  const cross = (pages: string[]) => new Set(pages.map((p) => threadOf.get(p))).size > 1;
  console.log(`  series: ${Object.keys(r.series).length} focus pages in ${seriesKeys.size} series (${[...seriesKeys.values()].filter(cross).length} spanning more than one thread)`);
  for (const [k, ps] of [...seriesKeys].sort()) console.log(`    ${k}: ${ps.map(at).join(", ")}`);
  console.log(`  projects: ${Object.keys(r.projects).length} focus pages in ${projectKeys.size} projects (${[...projectKeys.values()].filter(cross).length} spanning more than one thread)`);
  for (const [k, ps] of [...projectKeys].sort()) console.log(`    ${k}: ${ps.map(at).join(", ")}`);
  const relCross = r.related.filter(([a, b]) => threadOf.get(a) !== threadOf.get(b)).length;
  console.log(`  related: ${r.related.length} edges (${relCross} across threads); skipped ${r.relatedSkipped.skipped}, ambiguous ${r.relatedSkipped.ambiguous} on focus pages`);
  for (const [a, b] of r.related) console.log(`    ${at(a)} → ${at(b)}`);
  const issueCross = r.issues.filter(([, o, ref]) => threadOf.get(o) !== threadOf.get(ref)).length;
  console.log(`  owned issues: ${r.issues.length} edges (${issueCross} across threads); ${r.ambiguousIssues.length} ambiguous`);
  for (const [k, o, ref] of r.issues) console.log(`    ${k}: owner ${at(o)} ← ${at(ref)}`);
  for (const a of r.ambiguousIssues) console.log(`    ${a.key}: ambiguous, owners ${a.owners.join(", ")}`);
  const perThread = new Map<string, { rows: number; focus: number; sessions: Set<string> }>();
  for (const [s, , t, kind] of c.rows) {
    const e = perThread.get(t) ?? { rows: 0, focus: 0, sessions: new Set<string>() };
    e.rows++;
    if (kind === "focus") e.focus++;
    e.sessions.add(s);
    perThread.set(t, e);
  }
  console.log(`  contributions: ${c.rows.length} rows (${c.rows.filter((x) => x[3] === "focus").length} focus) over ${new Set(c.rows.map((x) => x[0])).size} sessions`);
  (index.work?.threads ?? []).forEach((t, i) => {
    const e = perThread.get(t.key);
    const joined = t.sessions.filter((x) => e?.sessions.has(workSessionRef(x))).length;
    const cut = c.cut.includes(t.key) ? " (cut)" : "";
    console.log(`    t${i + 1}: ${e?.rows ?? 0} rows, ${e?.focus ?? 0} focus, ${joined}/${t.sessions.length} sessions joined${cut}`);
  });
}

/** The `related:` and `owns:` census over EVERY page of the build, as the
 *  shipped readers see them. */
function printRelatedCensus(index: WikiIndex): void {
  const withRelated = index.pages.filter((p) => p.related || p.relatedSkipped || p.relatedAmbiguous);
  const sum = (f: (p: (typeof index.pages)[number]) => number) => index.pages.reduce((n, p) => n + f(p), 0);
  console.log(`\nrelated:/owns: census (all pages):`);
  console.log(`  related: ${withRelated.length} pages with entries; ${sum((p) => p.related?.length ?? 0)} resolved targets, ${sum((p) => p.relatedSkipped ?? 0)} skipped, ${sum((p) => p.relatedAmbiguous ?? 0)} ambiguous`);
  console.log(`  owns: ${index.pages.filter((p) => p.owns).length} pages own ${new Set(index.pages.flatMap((p) => p.owns ?? [])).size} keys`);
}

/** The `--group-stop` and `--group-evidence` flags (D1 defaults). */
function groupFlags(): { stop: WorkGroupStop; toggles: WorkGroupEvidenceToggles } {
  const stop = (arg("group-stop") ?? "related") as WorkGroupStop;
  if (!WORK_GROUP_STOPS.includes(stop)) throw new ReplayError(`--group-stop must be one of ${WORK_GROUP_STOPS.join(", ")}`);
  const raw = arg("group-evidence") ?? "series,related,issue";
  const kinds = raw === "none" ? [] : raw.split(",").map((k) => k.trim());
  for (const k of kinds) if (!["series", "related", "issue"].includes(k)) throw new ReplayError(`--group-evidence: unknown kind ${k}`);
  return { stop, toggles: { series: kinds.includes("series"), related: kinds.includes("related"), issue: kinds.includes("issue") } };
}

function witnessLine(w: WorkWitness): string {
  if (w.kind === "series") return `series ${w.label}`;
  if (w.kind === "project") return `project ${w.key}`;
  if (w.kind === "related") return `related ${w.from} → ${w.to}`;
  return `issue ${w.key}: owner ${w.owner} ← ${w.referrer}`;
}

/** The grouping model's cards at the chosen stop, then the measured matrix. */
function printGroups(index: WikiIndex, listing: WikiListing[], at: number): void {
  const { stop, toggles } = groupFlags();
  const run = (s: WorkGroupStop, t: WorkGroupEvidenceToggles) =>
    groupWorkThreads({ work: index.work ?? null, allPages: listing, now: at, stop: s, toggles: t });
  const g = run(stop, toggles);
  const on = (Object.keys(toggles) as (keyof WorkGroupEvidenceToggles)[]).filter((k) => toggles[k]);
  console.log(`\nWork-thread groups (stop ${g.stop}${g.stop !== g.requested ? `, asked ${g.requested}` : ""}; evidence ${on.join("+") || "none"}):`);
  for (const [k, a] of Object.entries(g.availability)) if (!a.available) console.log(`  ${k} unavailable: ${a.reasons.join(", ")}`);
  if (g.stop === "sessions") {
    g.sessions.forEach((c, i) => {
      console.log(`  ${i + 1}. session ${c.ref} «${c.title}» last ${new Date(c.last).toISOString().slice(0, 16)} (thread ${c.threadKey})`);
      for (const p of c.rows) console.log(`       ${p.relPath}`);
      if (c.alsoIn.length) console.log(`       also in: ${c.alsoIn.map((p) => p.relPath).join(" · ")}`);
    });
    console.log(`  ${g.sessions.length} session cards`);
    return;
  }
  const threads = g.groups.reduce((n, x) => n + x.children.length, 0);
  g.groups.forEach((x, i) => {
    const focus = x.children.reduce((n, c) => n + c.owned.length, 0);
    console.log(`  ${i + 1}. [${x.label}] ${x.name}  — ${x.children.length} threads, ${focus} focus pages  fold=${x.foldKey}`);
    for (const c of x.children) {
      const why = c.joinedBy.length ? `  via ${c.joinedBy.join("+")}` : "";
      const also = c.also.length ? `  also ${c.also.map((a) => a.label).join(", ")}` : "";
      console.log(`       - ${c.name} [${c.score.toFixed(2)}] (${c.owned.length} pages)${why}${also}`);
    }
    if (x.kind === "group") for (const w of x.witnesses) console.log(`         · ${witnessLine(w)}`);
  });
  console.log(`  ${g.groups.length} cards hold ${threads}/${index.work?.threads.length ?? 0} threads`);

  const all = { series: true, related: true, issue: true };
  const none = { series: false, related: false, issue: false };
  const matrix: [string, WorkGroupStop, WorkGroupEvidenceToggles][] = [
    ["Threads", "threads", all],
    ["Related · related link", "related", { ...none, related: true }],
    ["Related · link + owned issue", "related", { ...none, related: true, issue: true }],
    ["Related · link + issue + series (D1)", "related", all],
    ["Related · no evidence", "related", none],
    ["Areas · D1 + project", "areas", all],
  ];
  console.log(`\nGrouping matrix (cards · threads in the largest card, before facets and the cap):`);
  for (const [label, s, t] of matrix) {
    const r = run(s, t);
    const largest = Math.max(0, ...r.groups.map((x) => x.children.length));
    console.log(`  ${label.padEnd(38)} ${r.groups.length} · ${largest}${r.stop !== s ? ` (drawn as ${r.stop})` : ""}`);
  }
}

/** The frozen ledger answers, or null when the flags are absent. */
async function frozenAnswers(sinceMs: number): Promise<{ sessions: unknown; pre: unknown; summary: unknown | null } | null> {
  const sessionsPath = arg("sessions-json");
  const prePath = arg("pre-json");
  const summaryPath = arg("summary-json");
  if (!sessionsPath && !prePath && !summaryPath) return null;
  if (!sessionsPath || !prePath) throw new ReplayError("--sessions-json and --pre-json go together (--summary-json is optional)");
  const read = async (p: string): Promise<unknown> => {
    try {
      return JSON.parse(await Bun.file(p).text());
    } catch (err) {
      throw new ReplayError(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const [sessions, preRaw, summary] = await Promise.all([read(sessionsPath), read(prePath), summaryPath ? read(summaryPath) : null]);
  const pre = preRaw as { until?: unknown; pages?: { w?: number; b?: number }[] };
  if (typeof pre?.until === "number" && pre.until !== sinceMs) {
    const late = (pre.pages ?? []).filter((r) => Math.max(r.w ?? 0, r.b ?? 0) > sinceMs).length;
    console.log(
      `frozen pre-window answer: until ${new Date(pre.until).toISOString()} re-stamped to ${new Date(sinceMs).toISOString()} ` +
        `(Δ ${((pre.until - sinceMs) / 1000).toFixed(1)} s; ${late} row(s) written inside the gap)`,
    );
  }
  return { sessions, pre: { ...(pre as object), until: sinceMs }, summary };
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
  const frozen = await frozenAnswers(sinceMs);
  const baseUrl = frozen ? "frozen" : (process.env.CLAUDE_USAGE_URL ?? "").trim().replace(/\/+$/, "");
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
  const [summaryAt, preWindow, sessionsBody] = frozen
    ? [frozen.summary, frozen.pre, frozen.sessions]
    : await Promise.all([
        q(`summary=1&until=${at}`),
        q(`summary=1&until=${sinceMs}`),
        q(`sessions=1&since=${sinceMs}&until=${at}`),
      ]);
  // Parsed here, so a bad answer names its reason: the memos' own warns go to
  // LogTape, which this script does not configure.
  const checks = [
    ...(summaryAt === null ? [] : [["summary at --at", parseWorkedPages(summaryAt)] as const]),
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
    if (summaryAt !== null) {
      await refreshWorkedLedger(cloneRoot, { urlConfigured: true, baseUrl, now, fetchPages: async () => summaryAt });
    }
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
    if (frozen) {
      console.log(`ledger answers: frozen (files)${summaryAt === null ? "; worked ledger not loaded (no --summary-json)" : ""}`);
    }
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
    printEvidence(index, index.work?.evidence);
    printRelatedCensus(index);
    printGroups(index, listing, at);
    printGroupedRail(index, listing, at);
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
