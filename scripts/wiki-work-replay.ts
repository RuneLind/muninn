#!/usr/bin/env bun
/**
 * Replay the work facts of one wiki as of an instant (plan
 * `muninn-wiki-work-threads`, D17):
 *
 *   bun scripts/wiki-work-replay.ts --wiki <name> --at <iso> [--pos <relPath>]…
 *     [--sessions-json <path> --pre-json <path> [--summary-json <path>]]
 *
 * Builds the index on a `git clone --shared` of the wiki's repo checked out at
 * the newest first-parent commit COMMITTED at or before `at` — content, series,
 * page set and git dates as of `at`, with every file's mtime set to its last
 * commit's committer time, clamped to `at` (`buildExplainerMeta` dates `.html`
 * pages by mtime). Committer time, not author time: a rebased commit keeps its
 * author date but lands on top of commits authored later, so author time would
 * check out content written after `at`. The ledger
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
 * Each capture must be of its form, then echo this replay's window (sessions
 * `since`/`until`, pre-window `until`, summary `until`), as epoch ms. A bound
 * past the window (a later `until`, an earlier `since`) is refused at any
 * offset; one inside it by up to `FROZEN_WINDOW_SLACK_MS` is accepted with a Δ
 * line; further is refused. Capture all three with `until=<ms>`: muninn's live
 * sessions and worked-ledger fetches ask without it, and upstream then echoes
 * the time it answered on the sessions form and no `until` on the summary
 * form. A refusal prints the route to capture with. A pre-window answer inside
 * the slack is re-stamped to this replay's start. `CLAUDE_USAGE_URL` is not read.
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
 * PICK UP (plan `muninn-wiki-pick-up`, PR 3). The grouped rail opens with the
 * Pick up strip `buildRail` draws at that stop: each row's age, title and
 * relPath, its second line (edits, sessions, the card that draws it), and the
 * card and group a click opens, or `opens the page` (D12). Every card line
 * prints `threadMetaLine` in the D14 form: the tally, `since <first>`, then
 * the age chip.
 *
 * Output is local only: melosys-kode-wiki titles are NAV data (D21). Nothing is
 * written anywhere but the temp clone, which is removed on exit and on SIGINT,
 * SIGTERM, SIGHUP and SIGQUIT, after the running git child's process group is
 * killed. SIGTSTP stops that group with the script, SIGCONT resumes it.
 */

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitAt, git, ReplayError, resume, signalHandler, stampMtimes, suspend } from "./wiki-work-replay-git.ts";
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
import { railGhostNote, threadAgeLabel, threadGroupTally, threadInstantLabel, threadMetaLine } from "../src/dashboard/views/components/wiki-thread-view.ts";
import { formatRailAge } from "../src/dashboard/views/components/wiki-activity-rank.ts";
import { pickUpMetaLine } from "../src/dashboard/views/components/wiki-pick-up.ts";
import { groupWorkThreads, type WorkWitness } from "../src/dashboard/views/components/wiki-work-groups.ts";
import { WORK_GROUP_STOPS, type WorkGroupEvidenceToggles, type WorkGroupStop } from "../src/dashboard/views/components/wiki-work-group-prefs.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
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
  const inputWith = (moreOpen: string[]) =>
    railInputFor(
      { allPages: listing, projects: projectCounts(index.pages), activityWeights: DEFAULT_ACTIVITY_WEIGHTS, workedGate: null, work: index.work ?? null },
      { mode: "updated", now: at, filters, showRetired: false, familiesOn: false, pins: [], openFolds: [], threadPin: null, workGroup: { stop, evidence: toggles, splits, moreOpen } },
    );
  const input = inputWith([]);
  // Activity's weights and gate never move the cards, so the defaults serve.
  const ctl = input.workControl;
  console.log(`\nGrouped rail (buildRail, stop ${stop}, evidence ${Object.entries(toggles).filter(([, v]) => v).map(([k]) => k).join("+") || "none"}):`);
  if (ctl) {
    console.log(`  control: drawn ${ctl.stop}${ctl.stop !== ctl.requested ? ` (asked ${ctl.requested})` : ""}; ` + ctl.stops.map((x) => `${x.stop} ${x.available ? x.cards : `— ${x.reasons.join(",")}`}`).join(" · "));
  }
  const built = buildRail(input);
  printPickUp(built.entries, at);
  for (const e of built.entries.filter((x) => x.section === "threads")) {
    if (e.kind === "thread-group") {
      const c = e.card;
      const age = threadAgeLabel(c, at);
      console.log(`  ${e.folded ? "▸" : "▾"} ${c.label.toUpperCase()} ${c.name}${c.pinned ? "  📌" : ""}  — ${threadGroupTally(c, true)}${age ? ` · ${age}` : ""}${c.anchorVisible ? "" : "  (anchor outside the filters)"}`);
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
  // The same cards with every group's `+ N more threads` pressed, so hidden
  // children count. Threads held are the SERVER's threads the cards' pages
  // came from: a split and its remainder are one thread.
  const all = inputWith(cards.filter(isRailGroupCard).map((c) => c.foldKey)).threads ?? [];
  const b = workBoundariesOf(index.work ?? null, listing, { splits, keptApart: [] });
  const sourceOf = new Map(b.threads.map((t) => [t.thread.key, t.source.key] as const));
  const childrenOf = (c: (typeof all)[number]) => (isRailGroupCard(c) ? c.children : [c]);
  const total = index.work?.threads.length ?? 0;
  const held = new Set(all.flatMap((c) => childrenOf(c).map((t) => sourceOf.get(t.key) ?? t.key))).size;
  const first = all[0];
  const firstShape = !first
    ? "none"
    : isRailGroupCard(first)
      ? `${first.label} group «${first.name}», ${first.threads} children, ${childrenOf(cards[0]!).length} drawn, ${first.children.reduce((n, t) => n + t.focus.length, 0)} focus pages`
      : `thread «${first.name}», ${first.focus.length} focus pages`;
  console.log(`  five-card check: ${cards.length} cards hold ${held} of ${total} threads; first card: ${firstShape}`);
  if (!splits.length) return;
  // PR 4: each --split page's own thread and its source's remainder (D15).
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

/** The Pick up strip as `buildRail` draws it (plan `muninn-wiki-pick-up`):
 *  rows newest first, each with its second line and its jump target. */
function printPickUp(entries: ReturnType<typeof buildRail>["entries"], at: number): void {
  const strip = entries.find((e) => e.kind === "pickup");
  console.log(`\nPick up (buildRail): ${strip?.kind === "pickup" ? "" : "none"}`);
  if (strip?.kind !== "pickup") return;
  strip.rows.forEach((r, i) => {
    const t = r.target;
    const jump = t ? `opens ${t.group ? `group «${t.group.name}» › ` : ""}card «${t.card.name}»${t.more ? " (behind + N more)" : ""}` : "opens the page";
    console.log(`  ${i + 1}. ${formatRailAge(r.atMs, at).padStart(3)}  ${r.page.title}  (${r.page.relPath})`);
    console.log(`        ${pickUpMetaLine(r)} · ${threadInstantLabel(r.atMs, at)} · ${r.source === "rows" ? "focus rows" : "page-level fallback"} · ${jump}`);
  });
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

/** How far a frozen capture's echoed bound may sit INSIDE this replay's
 *  window (a later `since`, an earlier `until`) and still be read: a
 *  capture taken by hand a moment before the replay, missing at most this
 *  much, not one from another day. */
const FROZEN_WINDOW_SLACK_MS = 5 * 60_000;

/** One echoed bound a frozen capture must carry. `outward` is the side on
 *  which the capture holds rows this replay's window does not (`later` for an
 *  `until`, `earlier` for a `since`); `pastWhy` says what those rows are. */
interface WindowBound {
  field: "since" | "until";
  want: number;
  outward: "later" | "earlier";
  pastWhy: string;
}

/** Signed seconds or hours, for a refusal or a Δ line. */
function offBy(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  const abs = Math.abs(ms);
  return abs < 3_600_000 ? `${sign}${(abs / 1000).toFixed(1)} s` : `${sign}${(abs / 3_600_000).toFixed(2)} h`;
}

/**
 * Check a frozen capture's echoed window against this replay's. The body's
 * form is checked first (`formError`, from the parse the live path runs), so a body
 * of the wrong form says so instead of "records no window". Then each bound:
 *  - absent, or not a number: refused, naming what it holds;
 *  - past the window (`outward`) by any amount: refused, with `pastWhy`.
 *    Upstream echoes `since` and `until` as asked, so a capture asked for
 *    this window echoes it exactly; asked without `until`, the sessions form
 *    echoes the time it answered. Neither past side can be cut back exactly
 *    (the file lists are capped, a summary row keeps only its newest write);
 *  - inside the window by more than the slack: refused;
 *  - inside it by up to the slack: accepted, with a Δ line on stdout.
 * Every refusal names the query to capture it again with.
 */
function checkWindow(file: string, body: unknown, formError: string | null, bounds: WindowBound[], capture: string): void {
  if (formError) throw new ReplayError(formError);
  const again = `capture it again with \`${capture}\``;
  for (const { field, want, outward, pastWhy } of bounds) {
    const got = (body as Record<string, unknown>)[field];
    if (got === undefined) {
      throw new ReplayError(`${file}: the capture records no window (no \`${field}\`); ${again}`);
    }
    if (typeof got !== "number" || !Number.isFinite(got)) {
      const kind = got === null ? "null" : Array.isArray(got) ? "an array" : typeof got;
      throw new ReplayError(`${file}: the capture records the window as ${kind} (${field} ${JSON.stringify(got)}), expected epoch ms; ${again}`);
    }
    const delta = got - want;
    if (delta === 0) continue;
    const past = outward === "later" ? delta > 0 : delta < 0;
    const at = `${field} ${new Date(got).toISOString()}, this replay needs ${new Date(want).toISOString()}, off by ${offBy(delta)}`;
    if (past) {
      throw new ReplayError(
        `${file}: captured for another window (${at}; ${pastWhy}, so any offset is refused); ${again}`,
      );
    }
    if (Math.abs(delta) > FROZEN_WINDOW_SLACK_MS) {
      throw new ReplayError(`${file}: captured for another window (${at}; more than ${FROZEN_WINDOW_SLACK_MS / 60_000} min is refused); ${again}`);
    }
    console.log(
      `frozen capture ${file}: ${field} ${new Date(got).toISOString()} sits inside this replay's ${new Date(want).toISOString()} ` +
        `(Δ ${offBy(delta)}); what was written in that gap is missing`,
    );
  }
}

/** The ledger queries, live and as printed for a capture. */
const sessionsQuery = (sinceMs: number, untilMs: number) => `sessions=1&since=${sinceMs}&until=${untilMs}`;
const summaryQuery = (untilMs: number) => `summary=1&until=${untilMs}`;

/** The frozen ledger answers, or null when the flags are absent. Each must
 *  be of its form and echo this replay's window (`checkWindow`). */
async function frozenAnswers(
  sinceMs: number,
  atMs: number,
  route: (query: string) => string,
): Promise<{ sessions: unknown; pre: unknown; summary: unknown | null } | null> {
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
  // The same parses and messages `main` runs on a live answer.
  const parsed = (what: string, r: { ok: true } | { ok: false; reason: string; detail: string }) =>
    r.ok ? null : `the ledger's ${what} answer did not parse: ${r.reason}: ${r.detail}`;
  const until = (want: number, pastWhy: string): WindowBound => ({ field: "until", want, outward: "later", pastWhy });
  const afterAt = "it holds writes made after --at";
  checkWindow(
    sessionsPath,
    sessions,
    parsed("sessions", parseWorkSessions(sessions)),
    [{ field: "since", want: sinceMs, outward: "earlier", pastWhy: "it holds sessions that had left the window by --at" }, until(atMs, afterAt)],
    route(sessionsQuery(sinceMs, atMs)),
  );
  checkWindow(
    prePath,
    preRaw,
    parsed("summary at window start", parseWorkedPages(preRaw)),
    [until(sinceMs, "it counts writes made inside the window as before it")],
    route(summaryQuery(sinceMs)),
  );
  if (summaryPath) {
    checkWindow(summaryPath, summary, parsed("summary at --at", parseWorkedPages(summary)), [until(atMs, afterAt)], route(summaryQuery(atMs)));
  }
  // A pre-window answer the slack early is re-stamped to this replay's start,
  // so `parsePreWindow`'s echo check reads it.
  const pre = preRaw as { until: number };
  if (pre.until !== sinceMs) console.log(`frozen capture ${prePath}: until re-stamped to ${new Date(sinceMs).toISOString()}`);
  return { sessions, pre: { ...pre, until: sinceMs }, summary };
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
  const registeredRoot = path.resolve(entry.root);
  const filesRoute = (query: string) => `/api/files?root=${encodeURIComponent(registeredRoot)}&${query}`;
  const frozen = await frozenAnswers(sinceMs, at, filesRoute);
  const baseUrl = frozen ? "frozen" : (process.env.CLAUDE_USAGE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new ReplayError("CLAUDE_USAGE_URL is not set");

  // The three ledger answers, for the REGISTERED root.
  const q = async (p: string): Promise<unknown> => {
    const route = filesRoute(p);
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
        q(summaryQuery(at)),
        q(summaryQuery(sinceMs)),
        q(sessionsQuery(sinceMs, at)),
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

  // The clone, at the commit committed at or before `at`.
  const toplevel = (await git(registeredRoot, ["rev-parse", "--show-toplevel"])).trim();
  const sub = path.relative(toplevel, await realpath(registeredRoot));
  const tmp = await mkdtemp(path.join(tmpdir(), "wiki-work-replay-"));
  let removing: Promise<void> | undefined;
  const cleanup = () => (removing ??= rm(tmp, { recursive: true, force: true }));
  // A signal stops the git children first, so nothing writes into the clone
  // while it is removed; see `signalHandler` for the exit code. Each git runs
  // in its own process group, so the terminal's Ctrl-C, Ctrl-\ and Ctrl-Z
  // reach the script alone, and the script passes each one on.
  const onSignal = signalHandler(cleanup);
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]] as const) {
    process.on(sig, () => onSignal(code));
  }
  process.on("SIGTSTP", () => suspend());
  process.on("SIGCONT", () => resume());
  try {
    const repo = path.join(tmp, "repo");
    await git(tmp, ["clone", "--quiet", "--shared", "--no-checkout", toplevel, repo]);
    const atSec = Math.floor(at / 1000);
    const commit = await commitAt(repo, atSec);
    await git(repo, ["checkout", "--quiet", "--detach", commit.sha]);
    const stamped = await stampMtimes(repo, atSec);
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
