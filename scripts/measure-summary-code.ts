#!/usr/bin/env bun
/**
 * Measure how much of a capture summary's fenced code reaches a wiki source page
 * drafted from it (`measureCodeRetention`, `src/gardener/code-block-retention.ts`).
 *
 *   bun scripts/measure-summary-code.ts --redraft <collection>/<docId> [--redraft …] [--out file.json]
 *   bun scripts/measure-summary-code.ts --proposal <wiki_proposals.id> [--proposal …]
 *   bun scripts/measure-summary-code.ts --page "sources/Some Page.mdx" [--page …]
 *   bun scripts/measure-summary-code.ts --survey [--out survey.json]
 *
 * `--redraft` runs the REAL source drafter (the bot's connector, the current
 * `SOURCE_CONVENTIONS_DIGEST`) on the summary's source file with the transcript
 * appendix cut — the body the capture trigger hands over — and writes no
 * proposal: the insert seam only captures the draft. The coverage and
 * live-proposal checks answer "not covered", and the doc's own page is dropped
 * from the index, so an already-applied summary is not answered `covered` or sent
 * down the title-collision retry. Each run costs one model call per doc (more on
 * a retry) and records a trace.
 *
 * `--proposal` measures a stored draft against its source summary, with no model
 * call.
 *
 * `--page` measures the page ON DISK against the summary its applied proposal
 * names — the draft as it was persisted is not the same artefact as the file after
 * apply-time containment and any later write, and a backfill has to be judged
 * against the file a reader opens. `--survey` runs that over every applied source
 * page, newest first, and is how the candidate list is regenerated rather than
 * trusted: it prints one line per page whose summary quotes code, and with `--out`
 * writes the rows a backfill run reads back (`scripts/backfill-summary-code.ts
 * --from`). Neither costs a model call.
 *
 * `--bot` (default `jarvis`) picks the drafting bot and its wiki.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/client.ts";
import { discoverAllBots } from "../src/bots/config.ts";
import { fetchKnowledgeApi } from "../src/ai/knowledge-api-client.ts";
import { readSummarySourceText } from "../src/summaries/source-text.ts";
import { encodeDocIdPath } from "../src/summaries/sources.ts";
import { splitTranscript } from "../src/summaries/transcript-split.ts";
import { getWikiIndex } from "../src/wiki/store.ts";
import { normalizeUrl } from "../src/wiki/ingest-backlog.ts";
import { getWikiProposalById, listAllWikiProposals, type WikiProposal } from "../src/db/wiki-proposals.ts";
import { appliedSourcePages, retentionScore } from "../src/gardener/source-backfill.ts";
import { draftSourcePage } from "../src/gardener/source-drafter.ts";
import { runDrafterOneShot } from "../src/gardener/drafter-oneshot.ts";
import { DRAFT_TIMEOUT_MS } from "../src/gardener/backlog.ts";
import { categoryFromDocId } from "../src/gardener/source-drafter-run.ts";
import { todayOslo } from "../src/gardener/util.ts";
import { measureCodeRetention, type BlockRetention } from "../src/gardener/code-block-retention.ts";

const API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";

function die(msg: string): never {
  console.error(`measure-summary-code: ${msg}`);
  process.exit(1);
}

function all(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

const redrafts = all("redraft");
const proposals = all("proposal");
const pages = all("page");
const survey = process.argv.includes("--survey");
const outFile = all("out")[0];
const botName = all("bot")[0] ?? "jarvis";
if (redrafts.length === 0 && proposals.length === 0 && pages.length === 0 && !survey)
  die("one of --redraft <collection>/<docId>, --proposal <id>, --page <relPath> or --survey is required");

const config = loadConfig();
initDb(config);
const botConfig = discoverAllBots().find((b) => b.name.toLowerCase() === botName.toLowerCase());
if (!botConfig) die(`bot ${botName} not discovered`);

interface Row {
  doc: string;
  outcome: string;
  title?: string;
  /** Wiki-relative path, on a `--page` / `--survey` row. */
  relPath?: string;
  blocks: BlockRetention[];
  draft?: string;
}

async function readSummary(collection: string, docId: string): Promise<{ body: string; url: string }> {
  const [source, doc] = await Promise.all([
    readSummarySourceText(API_URL, collection, encodeDocIdPath(docId), 15_000),
    fetchKnowledgeApi(API_URL, `/api/document/${encodeURIComponent(collection)}/${encodeDocIdPath(docId)}`, {
      timeoutMs: 15_000,
    }),
  ]);
  if (source === null) die(`${collection}/${docId}: huginn served no source file (?raw=1)`);
  return { body: splitTranscript(source).body.trim(), url: String(doc?.metadata?.url ?? doc?.url ?? "") };
}

function splitRef(ref: string): [string, string] {
  const slash = ref.indexOf("/");
  if (slash < 0) die(`--redraft ${ref}: expected <collection>/<docId>`);
  return [ref.slice(0, slash), ref.slice(slash + 1)];
}

async function redraft(ref: string): Promise<Row> {
  const [collection, docId] = splitRef(ref);
  const { body, url } = await readSummary(collection, docId);
  const wikiDir = botConfig!.wikiDir;
  if (!wikiDir) die(`bot ${botConfig!.name} has no wikiDir`);
  const full = await getWikiIndex({ root: wikiDir });
  const own = normalizeUrl(url);
  const index = full ? { ...full, pages: full.pages.filter((p) => !p.url || normalizeUrl(p.url) !== own) } : null;

  let draft: string | undefined;
  const outcome = await draftSourcePage({
    botName: botConfig!.name,
    wikiDir,
    input: { collection, docId, url, body, category: categoryFromDocId(docId) },
    index,
    today: todayOslo(Date.now()),
    collectWikiRefs: async () => ({ urls: new Set(), idTokens: new Set() }),
    liveTopicKeys: async () => [],
    liveSourceDocUrls: async () => [],
    insertProposal: async (params) => {
      draft = params.draft;
      return { id: "dry-run" } as WikiProposal;
    },
    callDrafter: async (prompt, title) =>
      (await runDrafterOneShot({ title, url, prompt, config, botConfig: botConfig!, timeoutMs: DRAFT_TIMEOUT_MS })).result,
  });
  return {
    doc: ref,
    outcome: outcome.outcome === "drafted" ? "drafted" : `${outcome.outcome}: ${"reason" in outcome ? outcome.reason : ""}`,
    ...(outcome.outcome === "drafted" ? { title: outcome.title } : {}),
    blocks: draft ? measureCodeRetention(body, draft) : [],
    ...(draft ? { draft } : {}),
  };
}

async function stored(id: string): Promise<Row> {
  const row = await getWikiProposalById(id);
  if (!row) die(`proposal ${id} not found`);
  const src = row.sourceDocs[0];
  if (!src) die(`proposal ${id} has no source doc`);
  const { body } = await readSummary(src.collection, src.docId);
  return {
    doc: `${src.collection}/${src.docId}`,
    outcome: row.status,
    title: row.targetPath,
    blocks: measureCodeRetention(body, row.draft),
  };
}

/**
 * The applied source pages of this bot's wiki, newest apply first, each with the
 * summary doc it was drafted from.
 */
async function appliedPages() {
  return appliedSourcePages(await listAllWikiProposals(botConfig!.name));
}

function wikiRoot(): string {
  const dir = botConfig!.wikiDir;
  if (!dir) die(`bot ${botConfig!.name} has no wikiDir`);
  return dir;
}

/** Measure one page ON DISK against the summary its applied proposal names. */
async function onDisk(relPath: string, known?: { collection: string; docId: string }): Promise<Row> {
  let src = known;
  if (!src) {
    const hit = (await appliedPages()).find((p) => p.relPath === relPath);
    if (!hit) die(`no applied source proposal targets "${relPath}"`);
    src = { collection: hit.collection, docId: hit.docId };
  }
  const file = Bun.file(path.join(wikiRoot(), relPath));
  if (!(await file.exists())) die(`page "${relPath}" is not on disk`);
  const { body } = await readSummary(src.collection, src.docId);
  return {
    doc: `${src.collection}/${src.docId}`,
    outcome: "applied",
    relPath,
    blocks: measureCodeRetention(body, await file.text()),
  };
}

const rows: Row[] = [];
for (const ref of redrafts) rows.push(await redraft(ref));
for (const id of proposals) rows.push(await stored(id));
for (const relPath of pages) rows.push(await onDisk(relPath));
if (survey) {
  const applied = await appliedPages();
  const root = wikiRoot();
  console.log(`surveying ${applied.length} applied source pages…`);
  // Bounded concurrency: one huginn source read per page, and a 469-page sweep
  // serially is minutes of round-trips for a measurement that has no model call.
  const queue = [...applied];
  const found: Row[] = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const file = Bun.file(path.join(root, next.relPath));
        if (!(await file.exists())) continue; // page deleted since it was applied
        const source = await readSummarySourceText(API_URL, next.collection, encodeDocIdPath(next.docId), 15_000);
        if (source === null) continue; // no source file to measure against
        const blocks = measureCodeRetention(splitTranscript(source).body, await file.text());
        if (blocks.length > 0) {
          found.push({ doc: `${next.collection}/${next.docId}`, outcome: "applied", relPath: next.relPath, blocks });
        }
      }
    }),
  );
  found.sort((a, b) => retentionScore(a.blocks).kept - retentionScore(b.blocks).kept);
  rows.push(...found);
}

let blocks = 0;
let kept = 0;
for (const r of rows) {
  const k = r.blocks.filter((b) => b.verdict === "kept").length;
  const p = r.blocks.filter((b) => b.verdict === "partial").length;
  blocks += r.blocks.length;
  kept += k;
  console.log(`${k}/${r.blocks.length} kept, ${p} partial — ${r.outcome} — ${r.relPath ?? r.title ?? ""} — ${r.doc}`);
  for (const b of r.blocks) console.log(`    block ${b.index} ${b.lang || "-"}: ${b.found}/${b.lines} lines → ${b.verdict}`);
}
console.log(`TOTAL: ${kept}/${blocks} blocks kept (${blocks ? Math.round((100 * kept) / blocks) : 0}%)`);
if (outFile) writeFileSync(outFile, JSON.stringify(rows, null, 2));
process.exit(0);
