#!/usr/bin/env bun
/**
 * Backfill the fenced code an applied wiki source page lost — the one-off driver
 * for PR 2 of mimir `plans/muninn-summary-code-in-wiki.mdx`.
 *
 *   bun scripts/backfill-summary-code.ts --page "sources/Software 3.0.mdx" [--page …]
 *   bun scripts/backfill-summary-code.ts --from survey.json [--limit N] [--skip N]
 *
 * 39 source pages were drafted before the drafter's verbatim rule existed, so they
 * paraphrase away the prompt / config file / snippet their summary quoted. For each
 * page this REVISES it in place: the drafter is given the current page plus the
 * summary and told to put the missing blocks back and change nothing else
 * (`buildSourceRevisePrompt`), and the result is persisted as a `mode: "update"`
 * proposal for the `/wiki/gardener` gate — which already renders a current→draft
 * diff. NOTHING here writes to the wiki; a human approves each page, or doesn't.
 *
 * Two guards, both mechanical:
 *  - a page whose blocks are all `kept` is not a candidate and costs no model call;
 *  - a revision that scores worse, or recovers nothing, is NOT persisted
 *    (`judgeBackfill`) — it is reported and dropped, so no reviewer is handed a
 *    diff that makes the page worse.
 *
 * `--from` reads `scripts/measure-summary-code.ts --survey --out`'s JSON, which is
 * how the candidate list is regenerated rather than copied from the plan's table.
 * `--dry-run` runs the model and the measurement but persists no proposal.
 * `--bot` (default `jarvis`) picks the drafting bot and its wiki.
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/client.ts";
import { discoverAllBots } from "../src/bots/config.ts";
import { readSummarySourceText } from "../src/summaries/source-text.ts";
import { encodeDocIdPath } from "../src/summaries/sources.ts";
import { splitTranscript } from "../src/summaries/transcript-split.ts";
import { getWikiIndex } from "../src/wiki/store.ts";
import { collectWikiRefs } from "../src/wiki/ingest-backlog.ts";
import {
  getLiveSourceDocUrls,
  getLiveTopicKeys,
  insertWikiProposal,
  listAllWikiProposals,
  type InsertWikiProposalParams,
  type WikiProposal,
} from "../src/db/wiki-proposals.ts";
import { draftSourcePage } from "../src/gardener/source-drafter.ts";
import { runDrafterOneShot } from "../src/gardener/drafter-oneshot.ts";
import { DRAFT_TIMEOUT_MS } from "../src/gardener/backlog.ts";
import { categoryFromDocId } from "../src/gardener/source-drafter-run.ts";
import { todayOslo } from "../src/gardener/util.ts";
import { measureCodeRetention, type BlockRetention } from "../src/gardener/code-block-retention.ts";
import {
  appliedSourcePages,
  backfillOutcomeLabel,
  judgeBackfill,
  retentionScore,
  type AppliedSourcePage,
} from "../src/gardener/source-backfill.ts";

const API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";

function die(msg: string): never {
  console.error(`backfill-summary-code: ${msg}`);
  process.exit(1);
}

function all(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

function num(name: string, fallback: number): number {
  const raw = all(name)[0];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) die(`--${name} "${raw}" is not a non-negative number`);
  return n;
}

const explicitPages = all("page");
const fromFile = all("from")[0];
const dryRun = process.argv.includes("--dry-run");
const outFile = all("out")[0];
const botName = all("bot")[0] ?? "jarvis";
const limit = num("limit", Number.POSITIVE_INFINITY);
const skip = num("skip", 0);
if (explicitPages.length === 0 && !fromFile) die("--page <relPath> or --from <survey.json> is required");

const config = loadConfig();
initDb(config);
const botConfig = discoverAllBots().find((b) => b.name.toLowerCase() === botName.toLowerCase());
if (!botConfig) die(`bot ${botName} not discovered`);
const wikiDir = botConfig.wikiDir;
if (!wikiDir) die(`bot ${botConfig.name} has no wikiDir`);

interface Result {
  relPath: string;
  doc: string;
  outcome: string;
  verdict: string;
  before: BlockRetention[];
  after?: BlockRetention[];
  proposalId?: string;
  /** The revised page, for `--out` — the only way to read back WHY a refusal scored as it did. */
  draft?: string;
}

/** The pages named on the command line, or read from a survey file, in that order. */
async function targets(): Promise<AppliedSourcePage[]> {
  const applied = appliedSourcePages(await listAllWikiProposals(botConfig!.name));
  const byPath = new Map(applied.map((p) => [p.relPath, p]));
  let wanted = explicitPages;
  if (fromFile) {
    const rows = (await Bun.file(fromFile).json()) as { relPath?: string; blocks?: BlockRetention[] }[];
    if (!Array.isArray(rows)) die(`${fromFile} is not a survey JSON array`);
    // A survey row whose blocks are all kept has nothing to restore: skipping it
    // here is what keeps `--from` from spending a model call per already-good page.
    wanted = wanted.concat(
      rows
        .filter((r) => typeof r.relPath === "string" && (r.blocks ?? []).some((b) => b.verdict !== "kept"))
        .map((r) => r.relPath!),
    );
  }
  const seen = new Set<string>();
  const out: AppliedSourcePage[] = [];
  for (const relPath of wanted) {
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    const hit = byPath.get(relPath);
    if (!hit) die(`no applied source proposal targets "${relPath}"`);
    out.push(hit);
  }
  return out.slice(skip, skip + limit);
}

async function backfill(target: AppliedSourcePage): Promise<Result> {
  const { relPath, collection, docId } = target;
  const base: Result = { relPath, doc: `${collection}/${docId}`, outcome: "skipped", verdict: "", before: [] };

  const file = Bun.file(path.join(wikiDir!, relPath));
  if (!(await file.exists())) return { ...base, verdict: "page is not on disk" };
  const currentText = await file.text();

  // The source FILE, not huginn's JSON copy — the copy has no fenced code at all,
  // so a backfill read from it would restore nothing and score every page "no block
  // recovered" (muninn #551/#552).
  const source = await readSummarySourceText(API_URL, collection, encodeDocIdPath(docId), 15_000);
  if (source === null) return { ...base, verdict: "huginn served no source file (?raw=1)" };
  const body = splitTranscript(source).body;

  const before = measureCodeRetention(body, currentText);
  if (before.length === 0) return { ...base, verdict: "summary quotes no code" };
  if (before.every((b) => b.verdict === "kept")) {
    return { ...base, before, verdict: "every block is already on the page" };
  }

  let after: BlockRetention[] | undefined;
  let draft: string | undefined;
  let verdict = "";
  let judgedOk = false;
  let proposalId: string | undefined;
  const index = await getWikiIndex({ root: wikiDir! });
  const outcome = await draftSourcePage({
    botName: botConfig!.name,
    wikiDir: wikiDir!,
    input: { collection, docId, url: target.url, body, sourceTitle: target.sourceTitle, category: categoryFromDocId(docId) },
    index,
    today: todayOslo(Date.now()),
    collectWikiRefs,
    liveTopicKeys: () => getLiveTopicKeys(botConfig!.name),
    liveSourceDocUrls: () => getLiveSourceDocUrls(botConfig!.name),
    update: { relPath, currentText },
    callDrafter: async (prompt, title) =>
      (
        await runDrafterOneShot({
          title,
          url: target.url,
          prompt,
          config,
          botConfig: botConfig!,
          timeoutMs: DRAFT_TIMEOUT_MS,
        })
      ).result,
    // The score guard sits INSIDE the insert seam: it is the last point where the
    // draft is in hand and no row exists yet. A refusal returns NULL rather than a
    // fake row — a fake row makes the drafter log "persisted proposal refused →
    // <path>", which is the opposite of what happened, on the one surface an
    // operator greps during a 39-page run. Null costs the drafter's `covered`
    // outcome, which this function then declines to report (see below); nothing
    // else reads it, because no ledger row is written either.
    insertProposal: async (params: InsertWikiProposalParams) => {
      draft = params.draft;
      after = measureCodeRetention(body, params.draft);
      const judged = judgeBackfill({ before, after, currentPage: currentText, draft: params.draft });
      verdict = judged.reason;
      judgedOk = judged.ok;
      if (!judged.ok || dryRun) return null;
      const row = await insertWikiProposal(params);
      proposalId = row?.id;
      return row;
    },
  });

  // Deliberately NO `source_draft_attempts` write. That ledger answers "why does
  // this doc have no page", is keyed `(bot, collection, doc)` and upserts every
  // column — so a row written here REPLACES the capture attempt that links the doc
  // to its applied proposal, for a doc that demonstrably HAS a page. Measured: the
  // five-page batch that proved this mechanism erased five capture rows, including
  // their `proposal_id`, which `deleteSourceDraftAttemptForProposal` needs on
  // reject. This script's record is its own `--out` file and the proposal it
  // persists.
  const persisted = backfillOutcomeLabel({ proposalId, dryRun, judgedOk });
  // The drafter's own outcome is reported only when the draft never reached the
  // score: once it did, the decision is THIS script's, and the drafter answers
  // `covered` for a refusal (see `insertProposal` above).
  return {
    relPath,
    doc: `${collection}/${docId}`,
    outcome: after
      ? `drafted (${persisted})`
      : `${outcome.outcome}: ${"reason" in outcome ? outcome.reason : ""}`,
    verdict,
    before,
    ...(after ? { after } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(draft ? { draft } : {}),
  };
}

const list = await targets();
console.log(`${list.length} page(s)${dryRun ? " (dry run — nothing persisted)" : ""}`);
const results: Result[] = [];
for (const target of list) {
  const r = await backfill(target);
  results.push(r);
  const b = retentionScore(r.before);
  const a = r.after ? retentionScore(r.after) : null;
  console.log(
    `${b.kept}/${b.blocks} → ${a ? `${a.kept}/${a.blocks}` : "—"} — ${r.outcome} — ${r.verdict} — ${r.relPath}`,
  );
}
const persisted = results.filter((r) => r.proposalId).length;
console.log(`TOTAL: ${persisted} proposal(s) persisted of ${results.length} page(s)`);
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
process.exit(0);
