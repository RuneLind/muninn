/**
 * One-shot: unwedge the anthropic watchers' `tier2:llms` snapshot.
 *
 * WHY: Anthropic restructured `llms.txt` on 2026-07-21, dropping ~1417 per-SDK
 * duplicate API-reference URLs (1953 → 549 doc URLs). The anti-poison guard in
 * `fetchTier2` (`freshUrls.length < prior.length / 2`) has skipped the source on every
 * run since — 53 consecutive skips across three watchers, with no counter, bound or
 * surface. No diff has run, so six days of Anthropic docs (the whole Opus 5 wave)
 * never reached the Haiku gate.
 *
 * WHAT IT DOES: rewrites each anthropic watcher's `tier2:llms` snapshot to **that
 * watcher's own** `prior ∩ fresh`. Every number is computed per row — the three rows
 * are NOT in the same state (the weekly row was already a run behind at 1894/2026-07-19,
 * so it also missed the 07-19→07-21 additions and will diff ~69 URLs, not 13).
 *
 * WHY INTERSECTION: `inter ≤ fresh` always holds, so an intersection baseline can never
 * trip the shrink guard on the following run — that is the load-bearing property.
 *   - Deleting the row instead would hit `fetchTier2`'s cold-start branch and silently
 *     baseline 549, swallowing the pending docs forever.
 *   - A union baseline (1966) is impossible while the guard compares `fresh.length`
 *     against `prior.length`; Phase 2 of the plan removes that coupling.
 *   - Idempotent in either order (536 ∩ 549 = 536; 549 ∩ 549 = 549).
 *
 * KNOWN CONSEQUENCE: the 1417 dropped URLs become eligible to re-appear as "new" if
 * Anthropic ever restores them. That is bounded by Phase 2's candidate burst cap, not
 * by this script — one reason Phase 2 should land soon after.
 *
 * WHY A SCRIPT, NOT A MIGRATION: this is a one-time correction to THIS machine's
 * watcher state. A migration would replay on any environment created later and clobber
 * a legitimate baseline.
 *
 * Usage:
 *   bun scripts/rebaseline-anthropic-llms.ts                # DRY-RUN (default)
 *   bun scripts/rebaseline-anthropic-llms.ts --execute      # write the snapshots
 *   bun scripts/rebaseline-anthropic-llms.ts --execute --force-next-run
 *                                                           # ...and force all three rows
 *                                                           # to run on the next tick
 *   bun scripts/rebaseline-anthropic-llms.ts --url https://…/llms.txt   # override the source
 *
 * `setWatcherSnapshot` is a plain upsert with no history, so an unpreviewed write is
 * unrecoverable — hence dry-run by default (matching `sweep-x-hype-backlog.ts`).
 */
import { loadConfig } from "../src/config.ts";
import { initDb, getDb, closeDb } from "../src/db/client.ts";
import { setWatcherSnapshot } from "../src/db/watchers.ts";
import { parseLlmsTxtDocs } from "../src/watchers/anthropic.ts";

const DEFAULT_LLMS_TXT_URL = "https://platform.claude.com/llms.txt";
const SNAP_LLMS = "tier2:llms";

/**
 * Fetch-sanity floors. This script writes OUTSIDE `fetchTier2` and therefore outside the
 * guard it exists to unwedge — without these, running it during exactly the failure the
 * guard protects against (JS challenge, truncated body, stale CDN edge) would hand-write
 * a poisoned baseline. Deliberately generous: the file legitimately shrank 72% once and
 * may shrink again.
 */
const MIN_FRESH_URLS = 400;
/**
 * Each row's intersection must retain at least this share of the fresh set. NOTE what
 * this does and does not catch: because `inter = prior ∩ fresh`, a TRUNCATED response is
 * a subset of the real set and scores share = 1.0. This check only fires when fresh
 * barely overlaps prior (a genuinely DIFFERENT doc set) — truncation is caught by the
 * double-fetch agreement below, not here.
 */
const MIN_INTERSECTION_SHARE = 0.5;

const USAGE = `Usage: bun scripts/rebaseline-anthropic-llms.ts [--url <llms.txt>] [--execute] [--force-next-run]

  --url <url>         Override the llms.txt source (default: ${DEFAULT_LLMS_TXT_URL}).
  --execute           Actually write. Without it the script is a read-only dry-run.
  --force-next-run    With --execute, also set force_next_run = true on every rebaselined
                      watcher so the daily (hour 12) and weekly (hour 18) rows can be
                      observed today instead of waiting for their natural slot.

Both --flag value and --flag=value forms are accepted.`;

const VALUE_FLAGS = new Set(["--url"]);
const BOOL_FLAGS = new Set(["--execute", "--force-next-run"]);

function usageError(msg: string): never {
  console.error(msg);
  console.error(`\n${USAGE}`);
  process.exit(1);
}

/** Strict parse — an unrecognized `--token` is an error, never a silent no-op. */
function parseArgs(argv: string[]): { execute: boolean; forceNextRun: boolean; url: string } {
  const values = new Map<string, string>();
  const bools = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) usageError(`Unexpected argument "${token}"`);

    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);

    if (BOOL_FLAGS.has(flag)) {
      if (eq !== -1) usageError(`${flag} does not take a value`);
      bools.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) usageError(`Unknown flag "${flag}"`);

    let value: string | undefined;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      value = argv[++i];
      if (value !== undefined && value.startsWith("--")) value = undefined;
    }
    if (value === undefined || value === "") {
      usageError(`${flag} requires a value (e.g. ${flag} ${DEFAULT_LLMS_TXT_URL})`);
    }
    values.set(flag, value);
  }

  return {
    execute: bools.has("--execute"),
    forceNextRun: bools.has("--force-next-run"),
    url: values.get("--url") ?? DEFAULT_LLMS_TXT_URL,
  };
}

const { execute, forceNextRun, url } = parseArgs(process.argv.slice(2));

/** Fetch + parse the doc-URL set with the watcher's own parser. Throws on a non-2xx. */
async function fetchDocSet(src: string): Promise<Set<string>> {
  const res = await fetch(src, {
    headers: { "User-Agent": "muninn-rebaseline-script", Accept: "text/plain, text/markdown, */*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${src} — aborting (no writes)`);
  return new Set(parseLlmsTxtDocs(await res.text()).keys());
}

async function main() {
  if (forceNextRun && !execute) {
    usageError("--force-next-run only applies with --execute (a dry-run writes nothing)");
  }

  const config = loadConfig();
  initDb(config);
  const sql = getDb();

  console.log(`Mode: ${execute ? "EXECUTE (writes)" : "DRY-RUN (no writes) — pass --execute to apply"}`);
  console.log(`Source: ${url}\n`);

  // --- Fetch the current set; every row diffs against the same fresh set. ---
  const fresh = await fetchDocSet(url);
  console.log(`Fetched ${fresh.size} doc URL(s) from llms.txt.`);

  if (fresh.size < MIN_FRESH_URLS) {
    throw new Error(
      `Fetch sanity floor: only ${fresh.size} URLs (< ${MIN_FRESH_URLS}). This looks like exactly ` +
        `the broken response the guard exists for — aborting without writing.`,
    );
  }

  // Truncation discriminator. A partial transfer is a SUBSET of the real set, so it clears
  // both floors above (share = 1.0) — a 450-URL truncation of a 549-URL file would be
  // written as a baseline, and the next healthy fetch would emit ~99 already-seen docs as
  // "new". A truncation is transient, so a second fetch disagreeing is the cheap signal;
  // a legitimate restructure is stable across seconds.
  const confirm = await fetchDocSet(url);
  if (confirm.size !== fresh.size || [...fresh].some((u) => !confirm.has(u))) {
    throw new Error(
      `Two consecutive fetches disagree (${fresh.size} vs ${confirm.size} URLs). One of them is ` +
        `truncated or the file is mid-deploy — aborting without writing. Re-run in a minute.`,
    );
  }

  const rows = await sql`
    SELECT w.id, w.name, w.interval_ms, w.config ->> 'llmsTxtUrl' AS llms_txt_url,
           s.value, s.updated_at
    FROM watcher_snapshots s
    JOIN watchers w ON w.id = s.watcher_id
    WHERE s.key = ${SNAP_LLMS}
    ORDER BY w.name
  `;

  // `buildTier2Sources` reads `config.llmsTxtUrl ?? DEFAULT_LLMS_TXT_URL` PER WATCHER, so a
  // row pointed at a different index must not be rebaselined against this one — its next
  // run would diff its own source against a foreign baseline and burst. Null (the live
  // state for all three rows) means the row uses the default, which is what `url` is.
  const mismatched = rows.filter((r: any) => r.llms_txt_url != null && r.llms_txt_url !== url);
  if (mismatched.length > 0) {
    throw new Error(
      `These watcher(s) have their own config.llmsTxtUrl differing from ${url}: ` +
        `${mismatched.map((r: any) => `${r.name} (${r.llms_txt_url})`).join(", ")}. ` +
        `Re-run per source with --url — aborting without writing anything.`,
    );
  }

  if (rows.length === 0) {
    console.warn(`\nWARNING: no '${SNAP_LLMS}' snapshot rows found — nothing to rebaseline.`);
    return;
  }

  // --- Compute per row. Never a global figure: the three rows differ. ---
  const plans: { id: string; name: string; prior: number; inter: string[]; added: string[] }[] = [];
  for (const row of rows) {
    // A corrupt (non-array) snapshot is the state `fetchTier2` treats as a benign cold
    // start. Skip the row with a warning rather than aborting — one bad row must not keep
    // the healthy rows this script exists to fix wedged.
    if (!Array.isArray(row.value)) {
      console.warn(
        `\n${row.name} (${String(row.id).slice(0, 8)}): snapshot is not an array ` +
          `(${typeof row.value}) — skipping. Its next run cold-starts and baselines silently.`,
      );
      continue;
    }
    const prior: string[] = row.value;
    const priorSet = new Set(prior);
    const inter = prior.filter((u) => fresh.has(u));
    const added = [...fresh].filter((u) => !priorSet.has(u));
    const removed = prior.length - inter.length;
    const share = inter.length / fresh.size;

    console.log(`\n${row.name} (${String(row.id).slice(0, 8)})`);
    console.log(`  snapshot frozen at : ${new Date(row.updated_at).toISOString()}`);
    console.log(`  prior → intersection: ${prior.length} → ${inter.length}  (removed ${removed})`);
    console.log(`  new URLs after rebaseline: ${added.length}`);

    if (share < MIN_INTERSECTION_SHARE) {
      throw new Error(
        `${row.name}: intersection is only ${(share * 100).toFixed(1)}% of the fresh set ` +
          `(< ${MIN_INTERSECTION_SHARE * 100}%) — the fetched set barely overlaps this baseline, ` +
          `which is the poisoned-response shape. Aborting without writing anything.`,
      );
    }

    for (const u of added) console.log(`    + ${u}`);
    plans.push({ id: row.id, name: row.name, prior: prior.length, inter, added });
  }

  if (plans.length === 0) {
    console.warn(`\nWARNING: every '${SNAP_LLMS}' row was skipped — nothing to rebaseline.`);
    return;
  }

  if (!execute) {
    console.log(
      `\nDry-run — nothing written. Re-run with --execute (add --force-next-run to also ` +
        `trigger the daily/weekly rows on the next tick).`,
    );
    return;
  }

  for (const p of plans) {
    await setWatcherSnapshot(p.id, SNAP_LLMS, p.inter);
    console.log(`\nRebaselined ${p.name}: ${p.prior} → ${p.inter.length} (${p.added.length} pending new URLs)`);
  }

  if (forceNextRun) {
    const forced = await sql`
      UPDATE watchers SET force_next_run = true, updated_at = now()
      WHERE id = ANY(${plans.map((p) => p.id)})
      RETURNING name
    `;
    console.log(`\nforce_next_run set on ${forced.length} watcher(s): ${forced.map((r: any) => r.name).join(", ")}`);
    console.log(
      "Expect ONE digest message per digest watcher on that forced run. Only the Highlights row " +
        "(gate + captureCandidates) can produce summary_candidates rows.",
    );
  }
}

main()
  .catch((err) => {
    console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(closeDb);
