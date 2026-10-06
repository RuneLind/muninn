/**
 * Measure the transcript check (`src/summaries/transcript-check.ts`) on the
 * synthesized fixtures in `src/summaries/__fixtures__/transcript-check-fixtures.ts`.
 *
 *   bun scripts/eval-transcript-check.ts [--only 03-startup] [--out <file.json>]
 *       [--backend cli|anthropic|copilot|vertex] [--max-chars 60000] [--timeout-ms 120000]
 *
 * One fixture at a time, one model call each, through the Haiku router with the
 * shipped Sonnet request (withheld on vertex, as in production). Reports:
 *
 *   - hit rate: known mismatches (expected `not in transcript` or `contradicts
 *     transcript`) the check flagged as anything but `supported`;
 *   - class accuracy: claims given exactly the expected verdict;
 *   - false positives: claims expected `supported` flagged otherwise;
 *   - past a cut, `beyondCut` against each claim's `expectedBeyondCut`, and the
 *     panel's reading of every claim with a `webVerdict`;
 *   - latency per call, and each fixture's cut.
 *
 * The calls are REAL and spend money; nothing reads or writes the database or
 * the corpus.
 */

import { writeFileSync } from "node:fs";
import { TRANSCRIPT_FIXTURES } from "../src/summaries/__fixtures__/transcript-check-fixtures.ts";
import {
  checkClaimsAgainstTranscript,
  describeCut,
  transcriptReading,
  TRANSCRIPT_CHECK_MAX_CHARS,
  type TranscriptCut,
  TRANSCRIPT_CHECK_TIMEOUT_MS,
  type TranscriptClaimVerdict,
} from "../src/summaries/transcript-check.ts";
import type { HaikuBackend } from "../src/ai/haiku-direct.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

const only = arg("only");
const out = arg("out");
const backend = arg("backend") as HaikuBackend | undefined;
const maxChars = Number(arg("max-chars") ?? TRANSCRIPT_CHECK_MAX_CHARS);
const timeoutMs = Number(arg("timeout-ms") ?? TRANSCRIPT_CHECK_TIMEOUT_MS);

const fixtures = TRANSCRIPT_FIXTURES.filter((f) => !only || f.id === only);
if (!fixtures.length) {
  console.error(`eval-transcript-check: no fixture ${only}`);
  process.exit(1);
}

let mismatches = 0;
let hits = 0;
let exact = 0;
let total = 0;
let supportedExpected = 0;
let falsePositives = 0;
let failures = 0;
let beyondAsked = 0;
let beyondRight = 0;
const latencies: number[] = [];
const report: unknown[] = [];

for (const f of fixtures) {
  const claims = f.claims.map(({ index, title, quote }) => ({ index, title, ...(quote ? { quote } : {}) }));
  let got: TranscriptClaimVerdict[] = [];
  let gotCut: TranscriptCut | undefined;
  let line = "";
  try {
    const r = await checkClaimsAgainstTranscript(claims, f.transcript, {
      botName: "eval",
      entrypoint: "eval-transcript-check",
      maxChars,
      timeoutMs,
      ...(backend ? { haikuBackend: backend } : {}),
    });
    got = r.claims;
    gotCut = r.cut;
    latencies.push(r.latencyMs);
    line = `${(r.latencyMs / 1000).toFixed(1)}s ${r.model}${r.backend ? `/${r.backend}` : ""} ${r.inputTokens}/${r.outputTokens} tok`;
    const cut = describeCut(r.cut);
    if (cut) line += `\n    ${cut}`;
    report.push({ id: f.id, latencyMs: r.latencyMs, model: r.model, backend: r.backend, cut: r.cut, claims: r.claims });
  } catch (err) {
    failures += 1;
    line = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    report.push({ id: f.id, error: line });
  }
  console.log(`\n[${f.id}] ${f.transcript.length} chars — ${line}`);
  for (const c of f.claims) {
    const g = got.find((x) => x.index === c.index);
    total += 1;
    const mismatch = c.expected !== "supported";
    if (mismatch) mismatches += 1;
    else supportedExpected += 1;
    if (!g) {
      console.log(`  ${c.index}. ?? expected ${c.expected} — ${c.title}`);
      continue;
    }
    if (g.verdict === c.expected) exact += 1;
    if (mismatch && g.verdict !== "supported") hits += 1;
    if (!mismatch && g.verdict !== "supported") falsePositives += 1;
    const mark = g.verdict === c.expected ? "ok " : mismatch === (g.verdict !== "supported") ? "~  " : "XX ";
    let extra = "";
    if (c.expectedBeyondCut !== undefined && g.verdict === "not in transcript") {
      beyondAsked += 1;
      if (g.beyondCut === c.expectedBeyondCut) beyondRight += 1;
      extra += ` beyondCut=${g.beyondCut} (expected ${c.expectedBeyondCut})`;
    }
    if (c.webVerdict) extra += ` reading(web ${c.webVerdict}): ${transcriptReading(c.webVerdict, g.verdict, gotCut, g.beyondCut) ?? "none"}`;
    console.log(`  ${mark}${c.index}. ${g.verdict} (expected ${c.expected})${extra} — ${c.title}\n       ${g.note}`);
  }
}

const sorted = [...latencies].sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
const summary = {
  fixtures: fixtures.length,
  claims: total,
  mismatches,
  hits,
  hitRate: mismatches ? hits / mismatches : null,
  exact,
  classAccuracy: total ? exact / total : null,
  supportedExpected,
  falsePositives,
  callFailures: failures,
  beyondCut: { asked: beyondAsked, right: beyondRight },
  latencyMs: { median, max: sorted.at(-1) ?? 0, min: sorted[0] ?? 0 },
  maxChars,
  timeoutMs,
};
console.log(`\n${JSON.stringify(summary, null, 2)}`);
if (out) writeFileSync(out, JSON.stringify({ summary, report }, null, 2));
process.exit(0);
