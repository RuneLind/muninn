#!/usr/bin/env bun
/**
 * Measure how much of a capture summary's fenced code reaches a wiki source page
 * drafted from it (`measureCodeRetention`, `src/gardener/code-block-retention.ts`).
 *
 *   bun scripts/measure-summary-code.ts --redraft <collection>/<docId> [--redraft …] [--out file.json]
 *   bun scripts/measure-summary-code.ts --proposal <wiki_proposals.id> [--proposal …]
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
 * `--bot` (default `jarvis`) picks the drafting bot and its wiki.
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/client.ts";
import { discoverAllBots } from "../src/bots/config.ts";
import { fetchKnowledgeApi } from "../src/ai/knowledge-api-client.ts";
import { readSummarySourceText } from "../src/summaries/source-text.ts";
import { encodeDocIdPath } from "../src/summaries/sources.ts";
import { splitTranscript } from "../src/summaries/transcript-split.ts";
import { getWikiIndex } from "../src/wiki/store.ts";
import { normalizeUrl } from "../src/wiki/ingest-backlog.ts";
import { getWikiProposalById, type WikiProposal } from "../src/db/wiki-proposals.ts";
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
const outFile = all("out")[0];
const botName = all("bot")[0] ?? "jarvis";
if (redrafts.length === 0 && proposals.length === 0) die("--redraft <collection>/<docId> or --proposal <id> is required");

const config = loadConfig();
initDb(config);
const botConfig = discoverAllBots().find((b) => b.name.toLowerCase() === botName.toLowerCase());
if (!botConfig) die(`bot ${botName} not discovered`);

interface Row {
  doc: string;
  outcome: string;
  title?: string;
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

const rows: Row[] = [];
for (const ref of redrafts) rows.push(await redraft(ref));
for (const id of proposals) rows.push(await stored(id));

let blocks = 0;
let kept = 0;
for (const r of rows) {
  const k = r.blocks.filter((b) => b.verdict === "kept").length;
  const p = r.blocks.filter((b) => b.verdict === "partial").length;
  blocks += r.blocks.length;
  kept += k;
  console.log(`${k}/${r.blocks.length} kept, ${p} partial — ${r.outcome} — ${r.title ?? ""} — ${r.doc}`);
  for (const b of r.blocks) console.log(`    block ${b.index} ${b.lang || "-"}: ${b.found}/${b.lines} lines → ${b.verdict}`);
}
console.log(`TOTAL: ${kept}/${blocks} blocks kept (${blocks ? Math.round((100 * kept) / blocks) : 0}%)`);
if (outFile) writeFileSync(outFile, JSON.stringify(rows, null, 2));
process.exit(0);
