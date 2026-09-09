/**
 * Grade the closing takeaway of a capture summary against its own body, and
 * regenerate a stored capture's summary under a different closer line to
 * compare — the acceptance harness for the 2026-09-08 takeaway fix.
 *
 * Two modes, both reading ONE stored document out of huginn (or a local file
 * holding the same markdown: summary body, then `## Transcript`):
 *
 *   bun scripts/eval-takeaway.ts --doc vimeo-summaries/<docId> --check-only
 *       runs the shipped checker (`src/summaries/takeaway-check.ts`) on the
 *       STORED summary and prints the verdict — the red case on real data.
 *
 *   bun scripts/eval-takeaway.ts --doc vimeo-summaries/<docId> \
 *       --closer old|new --kind standard|deep --runs 2 --out <dir>
 *       re-runs the Vimeo summary prompt over the stored transcript on the
 *       resolved summarizer bot, then grades every closer with the checker and
 *       writes each summary + verdict under --out. `old` is the pre-fix closer
 *       line (kept here as a literal so the comparison survives the constant
 *       moving); `new` is whatever `SUMMARY_STRUCTURE_BULLETS` ships.
 *
 * `--check-model <id>` runs the checker on that model instead of the router's
 * default Haiku, for comparing tiers. The model calls are REAL and spend money;
 * nothing here ingests, drafts or writes to the corpus. Frames are never
 * requested, so a run is transcript-only.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/client.ts";
import { discoverAllBots, resolveSummarizerBot } from "../src/bots/config.ts";
import { executeOneShot } from "../src/ai/one-shot.ts";
import { callHaikuWithFallback } from "../src/ai/haiku-direct.ts";
import { parseSummaryResponse } from "../src/utils/summary-parser.ts";
import { buildVimeoSystemPrompt } from "../src/vimeo/summarizer.ts";
import { captureBotConfigFor, captureThinkingFor, findCapturePreset, resolveCapturePresets, type CapturePreset } from "../src/summaries/presets.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "../src/summaries/summary-structure.ts";
import { CAPTURE_THINKING_MAX_TOKENS } from "../src/summaries/summarizer-shared.ts";
import { groundTakeaway, splitClosingTakeaway } from "../src/summaries/takeaway-check.ts";
import { splitTranscript } from "../src/summaries/transcript-split.ts";

const OLD_CLOSER =
  "- End with a closing blockquote takeaway: `> 💬 **Takeaway:** …` — the 1–3 most surprising or headline revelations, distilled into one or two punchy sentences.";

function die(msg: string): never {
  console.error(`eval-takeaway: ${msg}`);
  process.exit(1);
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) return "true";
  return v;
}

const docRef = arg("doc");
const file = arg("file");
const checkOnly = arg("check-only") === "true";
const closer = arg("closer", "new")!;
const kind = arg("kind", "standard")!;
const runs = Number(arg("runs", "1"));
const out = arg("out");
const checkModel = arg("check-model");
const lang = (arg("lang", "nb") as "nb" | "en");
if (!docRef && !file) die("--doc <collection>/<docId> or --file <markdown> is required");
if (closer !== "old" && closer !== "new") die("--closer is old|new");
if (!checkOnly && !out) die("--out <dir> is required for a regeneration run");

const loaded = loadConfig();
initDb(loaded);

async function loadDocument(): Promise<{ title: string; url: string; text: string }> {
  if (file) return { title: file, url: "", text: readFileSync(file, "utf8") };
  const slash = docRef!.indexOf("/");
  if (slash < 0) die("--doc must be <collection>/<docId>");
  const collection = docRef!.slice(0, slash);
  const docId = docRef!.slice(slash + 1);
  const encoded = docId.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${loaded.knowledgeApiUrl}/api/document/${encodeURIComponent(collection)}/${encoded}`);
  if (!res.ok) die(`huginn answered ${res.status} for ${docRef}`);
  const doc = (await res.json()) as { id: string; url?: string; text: string };
  return { title: docId.replace(/^.*\//, "").replace(/\.md$/, ""), url: doc.url ?? "", text: doc.text };
}

/**
 * The stored document's two halves. The split itself is the shared, fence-aware
 * {@link splitTranscript} — the same rule the export page and the capture re-run
 * read, so this script cannot regenerate from a boundary the product does not
 * use. The naive `indexOf` it replaced took a `## Transcript` line quoted inside
 * a fenced code block as the boundary.
 *
 * The breadcrumb strip stays here: it is huginn's JSON `text` form that carries
 * one (`[collection > path]`), and this script reads that form.
 */
function splitStored(text: string): { body: string; transcript: string } {
  const parts = splitTranscript(text);
  const body = parts.body.replace(/^\[[^\]]*\]\n\n/, "");
  return { body, transcript: (parts.transcript ?? "").trim() };
}

const call = checkModel
  ? (p: string) => callHaikuWithFallback(p, { source: "takeaway-check", entrypoint: "eval-takeaway", botName: "eval", model: checkModel })
  : undefined;

const doc = await loadDocument();
const stored = splitStored(doc.text);

if (checkOnly) {
  const split = splitClosingTakeaway(stored.body);
  if (!split) die("the stored summary has no closing takeaway");
  console.log(`closer as stored:\n  ${split.takeaway}\n`);
  const r = await groundTakeaway(stored.body, { botName: "eval", ...(call ? { call } : {}) });
  console.log(`outcome: ${r.outcome}  model: ${r.usage?.model ?? "-"}  tokens: ${r.usage?.inputTokens ?? "-"}/${r.usage?.outputTokens ?? "-"}`);
  for (const i of r.issues) console.log(`  - ${i}`);
  if (r.outcome === "rewritten") console.log(`\nrewrite:\n  ${splitClosingTakeaway(r.text)!.takeaway}`);
  process.exit(0);
}

if (!stored.transcript) die("the stored document carries no `## Transcript` section to regenerate from");
const botConfig = resolveSummarizerBot(discoverAllBots());
if (!botConfig) die("no summarizer bot discovered");
const presets = resolveCapturePresets(botConfig.prompts, botConfig.connector);
const shipped = findCapturePreset(presets, kind);
if (!shipped) die(`kind ${kind} is not offered by ${botConfig.name}`);
const instruction =
  closer === "new"
    ? shipped.instruction
    : shipped.instruction
        .split("\n")
        .map((l) => (l === SUMMARY_STRUCTURE_BULLETS[SUMMARY_STRUCTURE_BULLETS.length - 1] ? OLD_CLOSER : l))
        .join("\n");
if (closer === "old" && instruction === shipped.instruction) die("the old closer line did not replace anything — is the kind's instruction the shared structure?");
const preset: CapturePreset = { ...shipped, instruction };
const systemPrompt = buildVimeoSystemPrompt({ preset, title: doc.title, url: doc.url, captionKind: "auto", outputLang: lang });
const runBot = captureBotConfigFor(botConfig, preset);
const thinking = captureThinkingFor(preset);

mkdirSync(resolvePath(out!), { recursive: true });
console.log(`bot=${botConfig.name} connector=${runBot.connector ?? "claude-cli"} model=${runBot.model ?? "default"} kind=${kind} closer=${closer} runs=${runs}`);
for (let n = 1; n <= runs; n++) {
  const t0 = performance.now();
  const result = await executeOneShot(stored.transcript, loaded, runBot, {
    systemPrompt,
    timeoutMs: 900_000,
    // `null` from captureThinkingFor means the bot's own budget (deep); the
    // seam's default is the capture cap.
    ...(thinking === null ? {} : { thinkingMaxTokens: CAPTURE_THINKING_MAX_TOKENS }),
  });
  const { summary } = parseSummaryResponse(result.result);
  const split = splitClosingTakeaway(summary);
  const check = await groundTakeaway(summary, { botName: "eval", ...(call ? { call } : {}) });
  const stem = resolvePath(out!, `${closer}-${kind}-${n}`);
  writeFileSync(`${stem}.md`, summary);
  writeFileSync(`${stem}.check.json`, JSON.stringify({ closer: split?.takeaway ?? null, outcome: check.outcome, issues: check.issues, rewrite: check.outcome === "rewritten" ? splitClosingTakeaway(check.text)?.takeaway : null, model: result.model, outputTokens: result.outputTokens, secs: Math.round((performance.now() - t0) / 1000) }, null, 2));
  console.log(`\n[${closer}/${kind} #${n}] ${Math.round((performance.now() - t0) / 1000)}s ${result.model} ${result.outputTokens} out tokens\n  closer: ${split?.takeaway ?? "(none)"}\n  check: ${check.outcome}${check.issues.length ? "\n    - " + check.issues.join("\n    - ") : ""}`);
}
process.exit(0);
