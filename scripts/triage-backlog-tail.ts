/**
 * Triage the RETIRED backlog tail — score the offered-and-passed-over summary
 * docs once with Haiku so a human can see whether retirement
 * (`scripts/retire-backlog-tail.ts`) buried anything worth a wiki page.
 *
 * The tail = the drain's **offered** keys (`backlog:offered`) minus the gardener's
 * consumed set (source_docs of `applied` proposals): docs that were offered (and
 * so excluded from the drain) but never became a wiki page. The one legitimate
 * worry about retirement is "good content passed over"; this stage answers it.
 *
 * Flow: list collections once → harvest exactly the tail's bodies (the
 * consumed-complement trick, batched 20) → score each batch of ~40 with Haiku
 * (novelty vs the existing wiki + interest-profile fit) → rank → write a markdown
 * report for review. It writes NOTHING to the offered set unless `--unoffer`.
 *
 * Usage:
 *   bun scripts/triage-backlog-tail.ts                     # report-only (no writes, no guard)
 *   bun scripts/triage-backlog-tail.ts --dry-run           # print the cost estimate + tail size, then stop
 *   bun scripts/triage-backlog-tail.ts --unoffer-top 20    # report, then unoffer the top-20 picks
 *   bun scripts/triage-backlog-tail.ts --unoffer c/id1,c/id2   # report, then unoffer exactly these keys
 *   OWNER_BOT_NAME=jarvis bun scripts/triage-backlog-tail.ts
 *
 * After an --unoffer run, run the drain IMMEDIATELY (see the workflow note the
 * script prints): fresh queued-and-unoffered docs sort ABOVE these old picks in
 * selectBacklogBatch (newest-first), so a long gap could evict them past the
 * 40-doc batch.
 *
 * Env: OWNER_BOT_NAME (default "jarvis"), DASHBOARD_URL (default http://127.0.0.1:<DASHBOARD_PORT>).
 */
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { initDb, closeDb } from "../src/db/client.ts";
import { discoverAllBots } from "../src/bots/config.ts";
import { getWikiGardenerWatcher, getWatcherSnapshot, setWatcherSnapshot } from "../src/db/watchers.ts";
import { getConsumedDocIds, getPendingDocIds } from "../src/db/wiki-proposals.ts";
import { listSummaryCollections } from "../src/summaries/list-collections.ts";
import { getWikiIndex } from "../src/wiki/store.ts";
import { loadInterestProfileForBot } from "../src/profile/generator.ts";
import { callHaikuWithFallback } from "../src/ai/haiku-direct.ts";
import { buildGardenerSeams } from "../src/watchers/wiki-gardener.ts";
import { harvestDocs, docDateMs } from "../src/gardener/harvest.ts";
import { excerptOf, existingPageLines } from "../src/gardener/cluster.ts";
import {
  buildTriagePrompt,
  parseTriage,
  rankTriage,
  computeUnoffer,
  TRIAGE_BATCH_SIZE,
  type TriageDoc,
  type TriageResult,
} from "../src/gardener/triage.ts";
import {
  WIKI_GARDENER_OFFERED_KEY,
  WIKI_GARDENER_RUN_KEY,
  BACKLOG_LOOKBACK_DAYS,
} from "../src/gardener/backlog.ts";
import type { ListedDoc } from "../src/gardener/types.ts";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} requires a value (e.g. ${flag} 20)`);
    process.exit(1);
  }
  return value;
}

const dryRun = process.argv.includes("--dry-run");
const unofferTopRaw = arg("--unoffer-top");
const unofferKeysRaw = arg("--unoffer");

if (unofferTopRaw !== undefined && unofferKeysRaw !== undefined) {
  console.error("Pass at most one of --unoffer-top or --unoffer, not both.");
  process.exit(1);
}

let unofferTop: number | undefined;
if (unofferTopRaw !== undefined) {
  unofferTop = Number(unofferTopRaw);
  if (!Number.isInteger(unofferTop) || unofferTop <= 0) {
    console.error(`--unoffer-top must be a positive integer, got "${unofferTopRaw}"`);
    process.exit(1);
  }
}
const explicitUnofferKeys =
  unofferKeysRaw !== undefined
    ? unofferKeysRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
if (explicitUnofferKeys !== undefined && explicitUnofferKeys.length === 0) {
  console.error("--unoffer got an empty key list — nothing to do.");
  process.exit(1);
}
const isUnoffer = unofferTop !== undefined || explicitUnofferKeys !== undefined;

// The report lands in the mimir wiki (sibling of the muninn repo), resolved from
// the repo root (scripts/ → ..).
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const REPORT_PATH = path.resolve(
  REPO_ROOT,
  "..",
  "mimir",
  "archive",
  "muninn",
  `${new Date().toISOString().slice(0, 10)}-backlog-triage-report.md`,
);

async function main() {
  const config = loadConfig();
  initDb(config);

  const botName = process.env.OWNER_BOT_NAME ?? "jarvis";
  const dashboardUrl = process.env.DASHBOARD_URL ?? `http://127.0.0.1:${config.dashboardPort}`;

  const bot = discoverAllBots().find((b) => b.name.toLowerCase() === botName.toLowerCase());
  if (!bot) {
    console.error(`No discovered bot named "${botName}". Set OWNER_BOT_NAME to a real bot.`);
    process.exit(1);
  }
  if (!bot.wikiDir) {
    console.error(`Bot "${bot.name}" has no wikiDir configured — nothing to triage against.`);
    process.exit(1);
  }
  const wikiDir = bot.wikiDir;

  const watcher = await getWikiGardenerWatcher(bot.name);
  if (!watcher) {
    console.error(
      `Bot "${bot.name}" has no 'wiki-gardener' watcher row — the offered memory has ` +
        `nowhere to live. Seed it first:\n  bun scripts/setup-wiki-gardener.ts --apply`,
    );
    process.exit(1);
  }

  console.log(`Bot: ${bot.name}`);
  console.log(`Wiki: ${wikiDir}`);
  console.log(
    `Mode: ${
      isUnoffer
        ? unofferTop !== undefined
          ? `unoffer-top ${unofferTop}`
          : `unoffer ${explicitUnofferKeys!.length} explicit key(s)`
        : dryRun
          ? "dry-run (estimate only)"
          : "report-only"
    }`,
  );
  console.log();

  // ── Guards (unoffer modes only — a report-only/dry-run run writes nothing).
  // Re-run right before the write too: the harvest+score phase takes minutes,
  // long enough for a drain to start after the initial check.
  const refuseIfDrainActive = async () => {
    const journal = await getWatcherSnapshot(watcher.id, WIKI_GARDENER_RUN_KEY);
    if (journal !== null) {
      console.error(
        `Refusing --unoffer: a backlog run journal ('${WIKI_GARDENER_RUN_KEY}') exists. Either a\n` +
          `drain is in flight (wait for it to finish) OR a crashed batch is stranded — open\n` +
          `/wiki/gardener and click Recover (or Dismiss) first, then re-run.`,
      );
      process.exit(1);
    }
    try {
      const url = `${dashboardUrl}/api/wiki/ingest-backlog?bot=${encodeURIComponent(bot.name)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const body = (await res.json()) as { running?: boolean };
        if (body.running === true) {
          console.error(
            `Refusing --unoffer: the dashboard reports a backlog drain is running for ${bot.name}\n` +
              `(in-memory mutex held). Wait for it to finish.`,
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
  };
  if (isUnoffer) await refuseIfDrainActive();

  // ── Assemble the tail: offered − consumed, intersected with the live listing ─
  const { byCollection: listedRaw, errors } = await listSummaryCollections(config.knowledgeApiUrl);
  if (errors.length) {
    console.warn(`Warning: ${errors.length} collection(s) failed to list — tail is partial:`);
    for (const e of errors) console.warn(`  - ${e.source || e.collection}: ${e.error}`);
    console.warn();
  }

  // Gardener-shaped listing (id/url/date) keyed by collection + a flat key set.
  const listedBySource: Record<string, ListedDoc[]> = {};
  const listedKeys = new Set<string>();
  const dateByKey = new Map<string, number>();
  for (const [collection, docs] of Object.entries(listedRaw)) {
    listedBySource[collection] = docs.map((d) => ({
      id: d.id,
      ...(d.url ? { url: d.url } : {}),
      ...(d.date ? { date: d.date } : {}),
    }));
    for (const d of docs) {
      const key = `${collection}/${d.id}`;
      listedKeys.add(key);
      const ms = docDateMs({ id: d.id, ...(d.date ? { date: d.date } : {}) });
      if (ms !== undefined) dateByKey.set(key, ms);
    }
  }

  const offeredSnap = await getWatcherSnapshot(watcher.id, WIKI_GARDENER_OFFERED_KEY);
  const offered = new Set(Array.isArray(offeredSnap) ? (offeredSnap as string[]) : []);
  const consumed = await getConsumedDocIds(bot.name);
  const pending = await getPendingDocIds(bot.name);

  // Tail = offered & !consumed & !pending, restricted to keys still in the
  // listing (only those can be harvested + scored). Pending docs sit in an open
  // draft/approved proposal — unoffering one would let the next drain create a
  // duplicate proposal, so they are not "passed over".
  const tailKeys = [...offered].filter(
    (k) => !consumed.has(k) && !pending.has(k) && listedKeys.has(k),
  );
  const tailSet = new Set(tailKeys);
  const N = tailKeys.length;

  console.log(`Offered set size:            ${offered.size}`);
  console.log(`Consumed (applied) docs:     ${consumed.size}`);
  console.log(`Pending (in-review) docs:    ${pending.size}`);
  console.log(`Retired tail to triage (N):  ${N}  (offered − consumed − pending, still listed)`);
  console.log();

  // ── Cost honesty — BEFORE the expensive fetch ────────────────────────────────
  const haikuCalls = Math.ceil(N / TRIAGE_BATCH_SIZE);
  console.log(
    `Cost estimate: ${N} doc fetches (batched 20 — the dominant time factor) + ` +
      `${haikuCalls} Haiku call(s) (batches of ${TRIAGE_BATCH_SIZE}).`,
  );
  console.log();

  if (N === 0) {
    console.log("Nothing to triage — the retired tail is empty. No report written.");
    return;
  }

  if (dryRun) {
    console.log("Dry run — stopping after the estimate. Re-run without --dry-run to fetch + score.");
    return;
  }

  // ── Harvest exactly the tail (consumed-complement: everything EXCEPT the tail) ─
  const complement = new Set<string>();
  for (const key of listedKeys) if (!tailSet.has(key)) complement.add(key);

  const seams = buildGardenerSeams({
    botConfig: bot,
    config,
    apiUrl: config.knowledgeApiUrl,
    wikiDir,
  });

  console.log(`Harvesting ${N} doc bodies (batched 20)…`);
  const harvested = await harvestDocs(
    Object.keys(listedBySource),
    {
      listDocs: async (collection) => listedBySource[collection] ?? [],
      fetchDoc: seams.fetchDoc,
    },
    { lookbackDays: BACKLOG_LOOKBACK_DAYS, consumed: complement, now: Date.now(), botName: bot.name },
  );
  console.log(`Harvested ${harvested.length} of ${N} tail doc(s).`);
  console.log();

  const harvestedByKey = new Map(harvested.map((d) => [d.key, d]));

  // ── Score in batches of ~40 ──────────────────────────────────────────────────
  const [interestProfile, index] = await Promise.all([
    loadInterestProfileForBot(bot.name),
    getWikiIndex({ root: wikiDir }),
  ]);
  const existingPages = existingPageLines(index);

  const results: TriageResult[] = [];
  for (let i = 0; i < harvested.length; i += TRIAGE_BATCH_SIZE) {
    const batch = harvested.slice(i, i + TRIAGE_BATCH_SIZE);
    const batchDocs: TriageDoc[] = batch.map((d) => ({
      key: d.key,
      title: d.title,
      excerpt: excerptOf(d.text),
    }));
    const prompt = buildTriagePrompt(batchDocs, { interestProfile, existingPages });
    const batchNo = Math.floor(i / TRIAGE_BATCH_SIZE) + 1;
    console.log(`Scoring batch ${batchNo}/${Math.ceil(harvested.length / TRIAGE_BATCH_SIZE)} (${batch.length} docs)…`);
    let raw: string;
    try {
      const { result } = await callHaikuWithFallback(prompt, {
        source: "wiki_gardener_triage",
        entrypoint: `${bot.name}-triage`,
        botName: bot.name,
        connector: bot.connector,
        haikuBackend: bot.haikuBackend,
      });
      raw = result;
    } catch (err) {
      console.warn(`  batch ${batchNo} Haiku call failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const validKeys = new Set(batch.map((d) => d.key));
    const parsed = parseTriage(raw, validKeys);
    for (const r of parsed) results.push({ ...r, dateMs: dateByKey.get(r.key) });
    console.log(`  → ${parsed.length} scored.`);
  }

  const ranked = rankTriage(results);
  console.log();
  console.log(`Scored ${ranked.length} of ${harvested.length} harvested doc(s).`);

  // ── Write the report ─────────────────────────────────────────────────────────
  const now = new Date();
  const lines: string[] = [];
  lines.push(`# Backlog triage report — ${bot.name}`);
  lines.push("");
  lines.push(`_Generated ${now.toISOString()} by \`scripts/triage-backlog-tail.ts\`._`);
  lines.push("");
  lines.push(
    `Retired tail: **${N}** docs (offered − consumed, still listed). ` +
      `Scored ${ranked.length} in ${haikuCalls} Haiku batch(es). ` +
      `Score = novelty vs the existing wiki + interest-profile fit (0 = redundant/thin, 5 = novel gem).`,
  );
  lines.push("");
  // Score distribution.
  const dist = new Map<number, number>();
  for (const r of ranked) dist.set(r.score, (dist.get(r.score) ?? 0) + 1);
  const distStr = [5, 4, 3, 2, 1, 0].map((s) => `${s}: ${dist.get(s) ?? 0}`).join(" · ");
  lines.push(`Score distribution — ${distStr}`);
  lines.push("");
  lines.push("To drain the top picks: re-run with `--unoffer-top N` (or `--unoffer <keys>`), then run the drain immediately.");
  lines.push("");
  lines.push("---");
  lines.push("");
  ranked.forEach((r, idx) => {
    const d = harvestedByKey.get(r.key);
    const title = d?.title ?? r.key;
    lines.push(`## ${idx + 1}. ${title} — ${r.score}/5`);
    lines.push("");
    lines.push(`- **Score:** ${r.score}/5`);
    lines.push(`- **Why:** ${r.reason || "(no reason given)"}`);
    if (d?.url) lines.push(`- **URL:** ${d.url}`);
    lines.push(`- **Source:** \`${r.key}\``);
    lines.push("");
  });

  await Bun.write(REPORT_PATH, lines.join("\n"));
  console.log(`✓ Report written: ${REPORT_PATH}`);
  console.log();

  // ── Optional --unoffer ───────────────────────────────────────────────────────
  if (!isUnoffer) {
    console.log("Report-only — nothing written to the offered set.");
    console.log("Re-run with --unoffer-top N (or --unoffer <keys>) to drain the picks.");
    return;
  }

  let keysToRemove: string[];
  if (unofferTop !== undefined) {
    keysToRemove = ranked.slice(0, unofferTop).map((r) => r.key);
    console.log(`Unoffering the top ${keysToRemove.length} pick(s) (requested ${unofferTop}).`);
  } else {
    keysToRemove = explicitUnofferKeys!;
    console.log(`Unoffering ${keysToRemove.length} explicit key(s).`);
  }

  // Re-guard + re-read: the initial offered read is minutes stale by now (harvest
  // + scoring), and a drain that ran in between may have unioned new keys into
  // the snapshot — computing from the stale set would silently drop them.
  await refuseIfDrainActive();
  const freshSnap = await getWatcherSnapshot(watcher.id, WIKI_GARDENER_OFFERED_KEY);
  const freshOffered = new Set(Array.isArray(freshSnap) ? (freshSnap as string[]) : []);
  const { newOffered, removed } = computeUnoffer(freshOffered, keysToRemove);
  if (removed.length === 0) {
    console.log("No matching keys were in the offered set — nothing to unoffer. No write.");
    return;
  }
  await setWatcherSnapshot(watcher.id, WIKI_GARDENER_OFFERED_KEY, newOffered);
  console.log(`✓ Unoffered ${removed.length} key(s) — offered set is now ${newOffered.length}.`);
  for (const k of removed) console.log(`  - ${k}`);
  console.log();
  console.log(
    `WORKFLOW: run the drain NOW (Ingest backlog on /wiki/gardener). These ${removed.length} picks\n` +
      `are back in the pool, but fresh queued-and-unoffered docs sort ABOVE them (newest-first in\n` +
      `selectBacklogBatch). If the progress panel shows more than ${Math.max(0, 40 - removed.length)} FRESH docs in the batch,\n` +
      `the picks were evicted past the 40-doc batch — run a second drain to pick them up.`,
  );
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => closeDb());
