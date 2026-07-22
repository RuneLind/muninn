/**
 * Pure context/prompt assembly for the wiki reader's **Fact check** feature
 * (`GET /api/wiki/factcheck`). Given either a reader-selected passage (`sel`
 * mode) or a whole page (`article` mode), this module composes the fact-checker
 * system prompt + the per-mode user prompt that a tool-enabled one-shot runs
 * against the live web.
 *
 * Unlike Explain/Ask (`explain-context.ts`), fact-check does NOT retrieve over a
 * huginn corpus and cites no numbered sources — the model opens real URLs with
 * WebFetch and cites only those. So this is a self-contained prompt builder, not
 * a retrieval-seed builder.
 *
 * Kept side-effect-free (no Huginn, no `claude` spawn, no filesystem) so the
 * sentinel-strip + prompt shapes unit-test in isolation — this is the test seam.
 */

import { extractJson } from "../ai/json-extract.ts";

/** Server-side cap on the selected passage (chars) — mirrors `EXPLAIN_SELECTION_MAX`. */
export const FACTCHECK_SELECTION_MAX = 1500;
/** Server-side cap on the optional heading/section hint (chars). */
export const FACTCHECK_HEADING_MAX = 200;
/**
 * Cap on the article body handed to the model in `article` mode (chars). A long
 * wiki page can't blow the prompt or the timeout — claims are extracted from the
 * head, which is where a page's factual assertions concentrate.
 */
export const FACTCHECK_ARTICLE_BODY_MAX = 12000;
/**
 * Max checkable claims the model is asked to verify per article. Sized to the
 * timeout budget measured in task 0 (6 web-verified claims ran ~88s wall-clock on
 * jarvis/claude-sdk, ~15s/claim; 8 claims fit comfortably under the 280s
 * `FACTCHECK_TIMEOUT_MS` budget even with a slow-fetch outlier).
 */
export const FACTCHECK_MAX_CLAIMS = 8;

/**
 * HTML-comment sentinels wrapping a persisted fact-check block. PR A never writes
 * this block; PR B will append `<!-- factcheck:start -->…<!-- factcheck:end -->`
 * to a page. We strip it defensively before building context so a re-check of an
 * already-checked page never fact-checks its own prior verdicts (self-reference).
 */
export const FACTCHECK_SENTINEL_START = "<!-- factcheck:start -->";
export const FACTCHECK_SENTINEL_END = "<!-- factcheck:end -->";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove every sentinel-wrapped fact-check block (sentinels included) from a page
 * body, so a re-check never sees its own prior verdicts. Tolerant of multiple
 * blocks and surrounding whitespace; collapses the resulting 3+ blank lines.
 */
export function stripFactcheckBlock(body: string): string {
  const re = new RegExp(
    escapeRegExp(FACTCHECK_SENTINEL_START) + "[\\s\\S]*?" + escapeRegExp(FACTCHECK_SENTINEL_END),
    "g",
  );
  return body.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Build the persisted fact-check block for PR B's "➕ Add to article": a
 * `> [!factcheck]` Obsidian callout (rendered as a styled box by the reader's
 * `upgradeObsidianCallouts`, shipped in #340) wrapping the fact-check answer
 * markdown, fenced by the `<!-- factcheck:start/end -->` sentinels so a re-check
 * strips it (`stripFactcheckBlock`) and a re-append replaces it in place.
 *
 * The answer is blockquoted line-by-line (every line prefixed with `>`, blank
 * lines kept as a bare `>`) so it renders as ONE blockquote — the callout
 * upgrader keys off a single `<blockquote>[!factcheck] …</blockquote>`.
 */
export function buildFactcheckBlock(answer: string, dateOslo: string): string {
  // Neutralize embedded sentinel strings (e.g. the model quoting a page that
  // documents this feature): a literal end-sentinel inside the answer would make
  // the non-greedy strip/replace regexes stop early, stranding prose and
  // accumulating unbalanced sentinels on every re-append.
  const safeAnswer = answer
    .replaceAll(FACTCHECK_SENTINEL_START, "factcheck:start")
    .replaceAll(FACTCHECK_SENTINEL_END, "factcheck:end");
  const lines = safeAnswer.trim().split("\n");
  const quoted = [`> [!factcheck] Fact check (${dateOslo})`];
  for (const line of lines) {
    // Blockquote lines never render headings (the pipeline joins them with <br>
    // and skips block parsing), so a `### ✅ Claim n/m` heading would show as
    // literal "###" text inside the callout — demote claim headings to bold.
    const demoted = /^###\s+/.test(line) ? `**${line.replace(/^###\s+/, "").trim()}**` : line;
    quoted.push(demoted.trim() === "" ? ">" : `> ${demoted}`);
  }
  return [FACTCHECK_SENTINEL_START, quoted.join("\n"), FACTCHECK_SENTINEL_END].join("\n");
}

/**
 * One checkable claim extracted from a page (Phase 1). `title` is a short label
 * used as the verdict-block heading; `quote` is the verbatim supporting text (if
 * the model provided one) threaded into the per-claim verify prompt as context.
 */
export interface Claim {
  title: string;
  quote?: string;
}

/**
 * Phase 1 — the claim-extraction prompt run on Haiku (folded into one string,
 * no system prompt). Extracts up to `cap` checkable factual claims from `body`
 * (the capped article body in article mode, or the selected passage in sel mode)
 * as JSON `{claims:[{title, quote?}]}`, parsed by {@link parseClaimList}. `title`
 * is the page title, supplied only as framing context.
 */
export function buildClaimExtractionPrompt(body: string, title: string, cap: number): string {
  return [
    `Extract the checkable factual claims from the text below (from the article "${title}").`,
    "",
    "TEXT:",
    '"""',
    body,
    '"""',
    "",
    `Return up to ${cap} claims — prefer SPECIFIC, verifiable statements (dates, numbers, named events, attributions, factual assertions). Skip opinions, predictions, recommendations, and first-person notes.`,
    "",
    "Produce ONLY valid JSON (no markdown fences), shaped:",
    '{"claims": [{"title": "short claim label (≤80 chars)", "quote": "the verbatim sentence(s) from the text stating this claim"}]}',
    "",
    "- title: a short label for the claim, not a full sentence.",
    "- quote: the exact supporting text (≤300 chars). Omit it if the claim is implicit.",
    "- Return an empty array if the text contains no checkable factual claims.",
  ].join("\n");
}

/**
 * Tolerant parse of the extractor's raw output (mirrors `parseDistillResult`'s
 * validate-to-null discipline). Accepts `{claims:[…]}` or a bare `[…]` array
 * (defensive against a model that drops the wrapper). Each claim needs a
 * non-empty string `title`; `quote` is an optional non-empty string. Returns null
 * on any parse/shape failure OR when zero valid claims survive — the SSE turns a
 * null into a clean `app_error`, never a crash. Order is preserved; the caller
 * caps the count.
 */
export function parseClaimList(raw: string): Claim[] | null {
  if (!raw || typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = extractJson<unknown>(raw);
  } catch {
    return null;
  }
  let rawClaims: unknown;
  if (Array.isArray(parsed)) rawClaims = parsed;
  else if (parsed && typeof parsed === "object") rawClaims = (parsed as Record<string, unknown>).claims;
  if (!Array.isArray(rawClaims)) return null;

  const claims: Claim[] = [];
  for (const item of rawClaims) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    if (!title) continue;
    const quote = typeof obj.quote === "string" && obj.quote.trim() ? obj.quote.trim() : undefined;
    claims.push(quote ? { title, quote } : { title });
  }
  return claims.length > 0 ? claims : null;
}

/**
 * Shared fact-checker persona + verdict discipline for every per-claim verify
 * call (Phase 2). Each verify call rules on EXACTLY ONE claim and emits exactly
 * one `### <verdict> Claim <n>/<total> — <title>` block (R1's format) — the
 * overall assessment lede is written separately by the compose pass (Phase 3).
 */
function factcheckVerifySystemPrompt(): string {
  return [
    "You are a rigorous fact-checker. You verify a SINGLE factual claim against the LIVE web.",
    "",
    "Rules:",
    "- Use the WebFetch tool (and web search if you have one) to open real sources BEFORE ruling on the claim. Never rule on a claim from memory alone.",
    "- Cite ONLY URLs you actually opened with WebFetch. Never cite a URL you did not fetch. If you could open no source, mark it ❓ unverifiable — do not guess a verdict.",
    "- If the claim is an opinion, prediction, recommendation, or the author's first-person note, mark it ❓ out of scope rather than inventing a verdict.",
    "- Be concise. This is a verification pass, not an essay. Plain markdown only — no HTML, no custom block components (no callouts, cards, verdicts, or pills).",
    "",
    "Verdict discipline:",
    "- A ✅ verdict REQUIRES at least one URL you actually OPENED with WebFetch for this claim. If the claim was only confirmed from search snippets (no page opened), cap the verdict at ⚠️ and say so in the reasoning.",
    "- Verdict markers: ✅ supported · ⚠️ partly supported (or supported by snippets only) · ❌ contradicted · ❓ unverifiable / out of scope.",
    "- Write NO first-person or meta commentary anywhere — no \"I was unable to…\", \"I also…\", \"I could not open…\". If you cannot verify, the block's verdict is ❓ and the reasoning states the fact objectively, never your process.",
    "",
    "Confidence rubric — a 0–100 score for the STRENGTH OF THE EVIDENCE you found, NOT a restatement of the verdict (the emoji is the ruling; the score is how solid the evidence is):",
    "- 90–100: multiple independent authoritative sources directly confirm.",
    "- 70–89: one solid authoritative source, or several weaker/agreeing ones.",
    "- 40–69: mixed or partial evidence — sources conflict, are indirect, or cover only part of the claim.",
    "- below 40: mostly inference — little or no source directly addresses the claim.",
    "",
    "Output format — follow EXACTLY, output ONLY this ONE block and nothing else:",
    "- A heading line: `### <verdict emoji> Claim <n>/<total> — <short claim title>` (e.g. `### ✅ Claim 3/8 — Sleep deprivation raises amyloid beta`). Use the EXACT <n>/<total> you are given.",
    "- A blank line.",
    "- A short reasoning paragraph (one to three sentences).",
    "- A blank line.",
    "- A `Confidence: NN/100` line (NN is your evidence-strength score from the rubric above) as its OWN standalone paragraph — it MUST be preceded by a blank line so it renders on its own line, never merged into the reasoning paragraph.",
    "- A `Sources:` line listing ONLY the URL(s) you actually opened with WebFetch for this claim (omit the line entirely when you opened none — and then the verdict cannot be ✅).",
  ].join("\n");
}

/** Context threaded into a per-claim verify prompt. `index`/`total` fix the
 *  claim's `Claim <n>/<total>` heading; sel mode additionally passes the located
 *  surrounding `excerpt` + nearest `heading` as reference context. */
export interface ClaimVerifyContext {
  index: number;
  total: number;
  pageTitle: string;
  wikiName: string;
  mode: "sel" | "article";
  excerpt?: string;
  heading?: string;
}

/** A system + user prompt pair for a per-claim verify / the compose call. */
export interface FactcheckCallPrompts {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Phase 2 — the per-claim verify prompt. Carries the claim + its source quote
 * (and, in sel mode, the located excerpt / heading) and instructs the model to
 * output exactly ONE verdict block headed with the given `Claim <n>/<total>`.
 */
export function buildClaimVerifyPrompt(claim: Claim, ctx: ClaimVerifyContext): FactcheckCallPrompts {
  const systemPrompt = factcheckVerifySystemPrompt();
  const lines: string[] = [
    `Verify ONE factual claim drawn from "${ctx.pageTitle}" in the "${ctx.wikiName}" knowledge wiki.`,
    "",
    `CLAIM (${ctx.index}/${ctx.total}): ${claim.title}`,
  ];
  if (claim.quote && claim.quote.trim()) {
    lines.push(
      "",
      "SOURCE PASSAGE (the wiki text the claim was drawn from — verify the claim, not this text):",
      '"""',
      claim.quote.trim(),
      '"""',
    );
  }
  if (ctx.mode === "sel" && ctx.excerpt && ctx.excerpt.trim()) {
    lines.push(
      "",
      "SURROUNDING CONTEXT (reference only — verify the claim above, not this):",
      '"""',
      ctx.excerpt.trim(),
      '"""',
    );
    if (ctx.heading && ctx.heading.trim()) lines.push("", `Section: ${ctx.heading.trim()}`);
  }
  lines.push(
    "",
    `Verify this claim against the live web and output EXACTLY ONE block headed \`### <verdict emoji> Claim ${ctx.index}/${ctx.total} — <short claim title>\`, following the output format.`,
  );
  return { systemPrompt, userPrompt: lines.join("\n") };
}

/** Input to {@link buildComposePrompt} — the finished per-claim verdict blocks
 *  (in claim order) plus the page framing. */
export interface ComposePromptInput {
  title: string;
  wikiName: string;
  blocks: string[];
}

/**
 * Phase 3 — the compose prompt (multi-claim only). A small call (thinking off,
 * tools NOT disabled) that reads the finished verdict blocks and writes ONLY the
 * one/two-sentence overall assessment lede; the server prepends it to the blocks.
 * It must NOT re-list the individual claims (the server owns block ordering). The
 * prompt steers away from tool use, but a stray tool excursion just burns the
 * compose budget and degrades to the neutral header (the caller handles it).
 */
export function buildComposePrompt(input: ComposePromptInput): FactcheckCallPrompts {
  const systemPrompt = [
    "You are summarizing the results of a web fact-check.",
    "You are given the per-claim verdict blocks that were already written.",
    "Write a ONE- or TWO-sentence OVERALL ASSESSMENT of how well the article's claims held up.",
    "Output ONLY that plain-paragraph assessment — no heading, no bullet list, and do NOT restate or re-list the individual claims or their verdicts. Plain markdown, no first-person, no meta commentary.",
  ].join("\n");
  const userPrompt = [
    `These are the fact-check verdicts for claims from "${input.title}" (${input.wikiName} wiki):`,
    "",
    input.blocks.join("\n\n"),
    "",
    "Write the overall assessment paragraph now.",
  ].join("\n");
  return { systemPrompt, userPrompt };
}
