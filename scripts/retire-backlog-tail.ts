/**
 * Retire the historical gardener backlog tail.
 *
 * The manual "Ingest backlog" drain (`/wiki/gardener`) works through the
 * never-ingested summary tail in bounded batches. A large slice of that tail is
 * historical material a human already read and judged low-signal during manual
 * ingest sessions — it should stop surfacing as a drain candidate. This one-shot
 * RETIRES that tail by adding its keys to the drain's **offered** set
 * (`backlog:offered` in `watcher_snapshots`) — the exact set the drain already
 * excludes.
 *
 * REVERSIBILITY: retirement is offered-set membership, nothing is deleted. The
 * "Reset offered" button on `/wiki/gardener` re-pools everything at any time.
 *
 * Usage:
 *   bun scripts/retire-backlog-tail.ts                     # DRY-RUN (default) — prints the plan
 *   bun scripts/retire-backlog-tail.ts --apply             # writes the offered union
 *   bun scripts/retire-backlog-tail.ts --before 2026-06-01 # retire only docs dated BEFORE the cutoff
 *   OWNER_BOT_NAME=jarvis bun scripts/retire-backlog-tail.ts
 *
 * Env: OWNER_BOT_NAME (default "jarvis"), DASHBOARD_URL (default http://127.0.0.1:<DASHBOARD_PORT>).
 */
import { loadConfig } from "../src/config.ts";
import { initDb, closeDb } from "../src/db/client.ts";
import { discoverAllBots } from "../src/bots/config.ts";
import { getWikiGardenerWatcher, getWatcherSnapshot, setWatcherSnapshot } from "../src/db/watchers.ts";
import { getConsumedDocIds, getPendingDocIds } from "../src/db/wiki-proposals.ts";
import { listSummaryCollections } from "../src/summaries/list-collections.ts";
import { collectWikiRefs } from "../src/wiki/ingest-backlog.ts";
import { WIKI_GARDENER_OFFERED_KEY, WIKI_GARDENER_RUN_KEY } from "../src/gardener/backlog.ts";
import { assembleRetireBacklog, computeRetirePlan, parseCutoffDate } from "../src/gardener/retire.ts";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const apply = process.argv.includes("--apply");
const before = arg("--before");

async function main() {
  const config = loadConfig();
  initDb(config);

  const botName = process.env.OWNER_BOT_NAME ?? "jarvis";
  const dashboardUrl = process.env.DASHBOARD_URL ?? `http://127.0.0.1:${config.dashboardPort}`;

  // Resolve the bot + its wiki root (wikiDir is absolute after discovery).
  const bot = discoverAllBots().find((b) => b.name.toLowerCase() === botName.toLowerCase());
  if (!bot) {
    console.error(`No discovered bot named "${botName}". Set OWNER_BOT_NAME to a real bot.`);
    process.exit(1);
  }
  if (!bot.wikiDir) {
    console.error(`Bot "${bot.name}" has no wikiDir configured — nothing to retire against.`);
    process.exit(1);
  }
  const wikiDir = bot.wikiDir;

  // The offered snapshot is keyed by the wiki-gardener watcher id — same no-watcher
  // branch the routes take. Abort clearly when the bot has no such row.
  const watcher = await getWikiGardenerWatcher(bot.name);
  if (!watcher) {
    console.error(
      `Bot "${bot.name}" has no 'wiki-gardener' watcher row — the offered memory has ` +
        `nowhere to live (its watcher_snapshots FK is missing). Seed it first:\n` +
        `  bun scripts/setup-wiki-gardener.ts --apply`,
    );
    process.exit(1);
  }

  const cutoffMs = before !== undefined ? parseCutoffDate(before) : null;

  console.log(`Bot: ${bot.name}`);
  console.log(`Wiki: ${wikiDir}`);
  console.log(`Cutoff: ${cutoffMs !== null ? `${before} (retire docs dated BEFORE this)` : "none (retire all queued-and-unoffered)"}`);
  console.log();

  // ── Cross-process guards ────────────────────────────────────────────────────
  // The in-memory gardener mutex lives inside the running muninn PROCESS; this
  // standalone import gets a fresh, always-empty map and can never observe a live
  // drain. So the guards are (1) the DB run journal and (2) the dashboard endpoint.
  if (apply) {
    // (1) Primary guard — the run journal. Present ⇒ a drain is mid-flight OR a
    // crashed batch awaits Recover at /wiki/gardener. Either way, refuse.
    const journal = await getWatcherSnapshot(watcher.id, WIKI_GARDENER_RUN_KEY);
    if (journal !== null) {
      console.error(
        `Refusing --apply: a backlog run journal ('${WIKI_GARDENER_RUN_KEY}') exists. Either a\n` +
          `drain is in flight (wait for it to finish) OR a crashed batch is stranded — open\n` +
          `/wiki/gardener and click Recover (or Dismiss) first, then re-run.`,
      );
      process.exit(1);
    }

    // (2) Belt-and-braces — the endpoint sees the in-memory mutex, covering the
    // drain's assemble phase (seconds of listing + sweep) before the journal is
    // written. Unreachable ⇒ warn but continue (the journal check is primary).
    try {
      const url = `${dashboardUrl}/api/wiki/ingest-backlog?bot=${encodeURIComponent(bot.name)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const body = (await res.json()) as { running?: boolean };
        if (body.running === true) {
          console.error(
            `Refusing --apply: the dashboard reports a backlog drain is running for ${bot.name}\n` +
              `(in-memory mutex held — likely the assemble phase). Wait for it to finish.`,
          );
          process.exit(1);
        }
      } else {
        console.warn(`Warning: ${url} returned HTTP ${res.status} — skipping the live-drain check.`);
      }
    } catch (err) {
      console.warn(
        `Warning: could not reach ${dashboardUrl} to check for a live drain ` +
          `(${err instanceof Error ? err.message : String(err)}) — relying on the DB journal check.`,
      );
    }
  }

  // ── Read → compute → (write) ────────────────────────────────────────────────
  const assembled = await assembleRetireBacklog({
    botName: bot.name,
    wikiDir,
    apiUrl: config.knowledgeApiUrl,
    listCollections: listSummaryCollections,
    sweepWikiRefs: collectWikiRefs,
    getConsumed: getConsumedDocIds,
    getPending: getPendingDocIds,
    getOffered: async () => {
      const snap = await getWatcherSnapshot(watcher.id, WIKI_GARDENER_OFFERED_KEY);
      return new Set(Array.isArray(snap) ? (snap as string[]) : []);
    },
  });

  if (assembled.errors.length) {
    console.warn(`Warning: ${assembled.errors.length} collection(s) failed to list — plan is partial:`);
    for (const e of assembled.errors) console.warn(`  - ${e.source || e.collection}: ${e.error}`);
    console.warn();
  }

  const plan = computeRetirePlan(assembled.byCollection, assembled.offeredBefore, cutoffMs);

  console.log("Per-collection (queued = all-time never-ingested; to-retire = queued & unoffered & pre-cutoff):");
  for (const c of plan.perCollection) {
    console.log(`  ${c.collection.padEnd(22)} queued=${String(c.queued).padStart(4)}  to-retire=${String(c.toRetire).padStart(4)}`);
  }
  console.log();
  console.log(`Already offered (previously retired): ${plan.alreadyOffered}`);
  console.log(`Queued total (incl. offered):         ${plan.queuedTotal}`);
  console.log(`Keys to retire this run:              ${plan.keysToRetire.length}`);
  console.log(`Offered set after this run:           ${plan.newOffered.length}`);
  console.log();

  if (!apply) {
    console.log("Keys that WOULD be retired (dry-run):");
    for (const k of plan.keysToRetire) console.log(`  ${k}`);
    console.log();
    console.log(`Dry run — pass --apply to write the offered union (${plan.newOffered.length} keys).`);
    console.log("Reversible: retirement is offered-set membership; nothing is deleted.");
    console.log('Re-pool everything anytime with "Reset offered" on /wiki/gardener.');
    return;
  }

  if (plan.keysToRetire.length === 0) {
    console.log("Nothing to retire (every queued-and-unoffered doc is already offered). No-op.");
    return;
  }

  await setWatcherSnapshot(watcher.id, WIKI_GARDENER_OFFERED_KEY, plan.newOffered);
  console.log(`✓ Retired ${plan.keysToRetire.length} keys — offered set is now ${plan.newOffered.length}.`);
  console.log("Reversible: nothing was deleted. Retirement = offered-set membership.");
  console.log('Re-pool everything anytime with "Reset offered" on /wiki/gardener.');
  console.log();
  console.log(
    "NOTE: the read→union→write ran immediately after the guard checks. The residual race\n" +
      "(an operator clicks Ingest in that same instant) is accepted — one human operates both.",
  );
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => closeDb());
