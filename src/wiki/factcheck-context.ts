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

import { locateExcerpt } from "./explain-context.ts";

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

/** The four verdict markers the output contract uses (one per claim block). */
export const FACTCHECK_VERDICT_MARKERS = ["✅", "⚠️", "❌", "❓"] as const;

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
 * Count the fact-check verdicts in a finished answer — one per claim block per the
 * output contract. Counts occurrences of the four verdict markers; used only to
 * drive the client status line ("Checked N claims against the web"), so a loose
 * count is fine. Returns 0 when the model emitted no markers.
 */
export function countFactcheckClaims(answer: string): number {
  let n = 0;
  for (const marker of FACTCHECK_VERDICT_MARKERS) {
    // Escape needed for the regex metacharacter-free emoji (defensive) + global count.
    const re = new RegExp(escapeRegExp(marker), "gu");
    n += (answer.match(re) ?? []).length;
  }
  return n;
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
    quoted.push(line.trim() === "" ? ">" : `> ${line}`);
  }
  return [FACTCHECK_SENTINEL_START, quoted.join("\n"), FACTCHECK_SENTINEL_END].join("\n");
}

/** Shared fact-checker persona + output contract (both modes). */
function factcheckSystemPrompt(): string {
  return [
    "You are a rigorous fact-checker. You verify factual claims against the LIVE web.",
    "",
    "Rules:",
    "- Use the WebFetch tool (and web search if you have one) to open real sources BEFORE ruling on any claim. Never rule on a claim from memory alone.",
    "- Cite ONLY URLs you actually opened with WebFetch. Never cite a URL you did not fetch. If you could open no source for a claim, mark it ❓ unverifiable — do not guess a verdict.",
    "- Skip opinions, predictions, recommendations, and the author's first-person notes — mark those ❓ out of scope rather than inventing a verdict.",
    "- Be concise. This is a verification pass, not an essay. Plain markdown only — no HTML, no custom block components (no callouts, cards, verdicts, or pills).",
    "",
    "Output format:",
    "- Start with a one- or two-sentence OVERALL ASSESSMENT.",
    "- Then ONE block per claim. Each block is:",
    "  - A line starting with the verdict marker, then the claim in **bold**: ✅ supported · ⚠️ partly supported · ❌ contradicted · ❓ unverifiable / out of scope",
    "  - One line of reasoning.",
    "  - A `Source(s):` line listing ONLY the URL(s) you actually opened (omit the line when you opened none).",
  ].join("\n");
}

export interface FactcheckPromptInput {
  mode: "sel" | "article";
  meta: { title: string; tags: string[]; type: string };
  /** Page body — raw markdown, or `htmlToText(explainer)` for explainer pages.
   *  Sentinel-wrapped prior fact-check blocks are stripped here. */
  body: string;
  /** The reader-selected passage (`sel` mode only). */
  sel?: string;
  /** Nearest-heading hint for the selection (`sel` mode only). */
  ctx?: string;
  wikiName: string;
  maxClaims?: number;
}

export interface FactcheckPrompts {
  /** Display label + `/agents` run name. */
  question: string;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * End-to-end prompt composition for the fact-check route. Strips any prior
 * fact-check block from the body, then builds the mode-specific user prompt:
 *  - `sel`: verify the selected passage, with a located excerpt as surrounding
 *    context (reusing `locateExcerpt`).
 *  - `article`: extract up to `maxClaims` checkable claims from the (capped) body
 *    and verify each.
 */
export function buildFactcheckPrompts(input: FactcheckPromptInput): FactcheckPrompts {
  const { mode, meta, wikiName } = input;
  const maxClaims = input.maxClaims ?? FACTCHECK_MAX_CLAIMS;
  const body = stripFactcheckBlock(input.body);
  const systemPrompt = factcheckSystemPrompt();
  const tagsLine = meta.tags.length ? `   Tags: ${meta.tags.join(", ")}` : "";

  if (mode === "sel") {
    const sel = (input.sel ?? "").trim();
    const excerpt = locateExcerpt(body, sel, input.ctx);
    const question = `Fact-check: "${sel}"`;
    const userPrompt = [
      `Verify the following passage from "${meta.title}" in the "${wikiName}" knowledge wiki.`,
      "",
      "PASSAGE TO VERIFY:",
      '"""',
      sel,
      '"""',
      "",
      "SURROUNDING CONTEXT (reference only — verify the passage above, not this):",
      '"""',
      excerpt,
      '"""',
      "",
      `Extract the checkable factual claims in the passage (up to ${maxClaims}) and verify each against the live web, following the output format.`,
    ].join("\n");
    return { question, systemPrompt, userPrompt };
  }

  // article mode
  const capped = body.slice(0, FACTCHECK_ARTICLE_BODY_MAX);
  const question = `Fact-check article: ${meta.title}`;
  const userPrompt = [
    `Fact-check the article below from the "${wikiName}" knowledge wiki.`,
    "",
    `ARTICLE: "${meta.title}"${tagsLine}   Type: ${meta.type}`,
    "",
    "BODY:",
    '"""',
    capped,
    '"""',
    "",
    `Extract up to ${maxClaims} checkable factual claims from the article — prefer specific, dated, verifiable statements (dates, numbers, named events, attributions). Skip opinions, predictions, and first-person notes (mark those ❓ out of scope). Verify each claim against the live web, following the output format.`,
  ].join("\n");
  return { question, systemPrompt, userPrompt };
}
