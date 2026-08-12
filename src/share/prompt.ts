/**
 * Prompt assembly for the share flow — the last pure step before the model call.
 *
 * The order here is the contract: **preset (or the reader's edit of it) → the
 * language rider → the reader's extra steer → the fenced source**. The rider goes
 * AFTER the instruction on purpose. A reader who rewrites the prompt in the dialog
 * is rewriting the *shape* of the post, not un-picking the language toggle they
 * left on "Norsk" — putting the rider first let an edited prompt ("summarize this
 * in English for the team") silently win, and the toggle became decorative.
 *
 * Pure + IO-free, like its two siblings in this folder: no filesystem, no model,
 * no huginn. `prepareShareBody` (`body-prep.ts`) does the on-disk → prose step and
 * is the intended and only producer of `body`.
 */

import type { ShareLang } from "./wire.ts";
import type { ShareBodyKind } from "./body-prep.ts";

/**
 * Tools a SHARE one-shot must not have, ON TOP of `FENCED_EXCLUDED_TOOLS`
 * (the runner unions the two — this list is the share-specific half).
 *
 * The web tools are excluded because the product is a summary OF A SOURCE THE
 * SENDER CHOSE. A model that fetches the web mid-summary produces a post carrying
 * claims that are not in the page the sender is sharing — under the sender's name,
 * in their company Slack, where nobody re-checks a summary. The shipped presets
 * already say "keep every claim traceable to the source"; this is that rule made
 * structural rather than requested. It also removes the dominant latency tail from
 * a call whose whole input is already in the prompt.
 */
export const SHARE_EXCLUDED_TOOLS = ["WebSearch", "WebFetch"];

/**
 * Collapse any `"""` run to a single quote.
 *
 * The source body and the reader's own fields are written INTO a `"""`-fenced
 * block below, so a field carrying its own fence can close the block early and
 * have whatever follows read as instructions. Same treatment (and same rationale)
 * as `neutralizePromptFence` in the claim-retry route and
 * `neutralizeFactcheckSentinels` on the integrate path — keep the readable
 * content, destroy the structural marker; idempotent, since the result no longer
 * matches. Spelled locally rather than imported: those live in modules that drag
 * the whole fact-check/route graph behind them, and this file is pure by contract.
 */
export function neutralizeShareFence(text: string): string {
  return text.replace(/"{3,}/g, '"');
}

/** The rider that pins the output language. English is stated as explicitly as
 *  Norwegian — an unstated default is what a strongly-worded source page overrides. */
export function languageRider(lang: ShareLang): string {
  if (lang === "nb") {
    return (
      "LANGUAGE: write the post in Norwegian (bokmål), whatever language the source is in. " +
      "Keep product names, proper nouns, code identifiers and quoted strings in their original form — " +
      "translate the prose around them, not them."
    );
  }
  return "LANGUAGE: write the post in English, whatever language the source is in.";
}

/**
 * The system prompt. Deliberately thin: the PRESET carries the instruction and
 * the shipped rules (markdown only, no derived numbers, no copied headings), so
 * anything restated here would be a second, drifting copy of the contract a bot's
 * `prompts/share.md` is allowed to replace.
 */
export function buildShareSystemPrompt(wikiName: string): string {
  const where = wikiName ? ` from the "${wikiName}" knowledge wiki` : "";
  return (
    `You turn one source document${where} into a short post the reader will paste ` +
    "to a colleague under their own name. Follow the instruction below exactly. " +
    "Answer with the post itself and nothing else — no preamble, no commentary on the task."
  );
}

export interface ShareTaskInput {
  /** The preset's content, or the reader's edited version of it. */
  instruction: string;
  lang: ShareLang;
  /** Free-text steer from the dialog ("focus on the migration risk"). */
  extra?: string;
  /** The prepared source prose — `prepareShareBody` output. */
  body: string;
  /** Page/document title, for framing the source block. */
  title: string;
  /** Registered wiki name, when the source came from one. */
  wikiName?: string;
}

/**
 * Assemble the user prompt: instruction → rider → extra → fenced source.
 *
 * Every interpolated string is fence-neutralized, including the instruction: a
 * per-bot `prompts/share.md` is a file on disk rather than reader input, but it is
 * the same delimiter contract and a preset that happened to quote a `"""` block
 * would break the source fence for every share that used it.
 */
export function buildShareUserPrompt(input: ShareTaskInput): string {
  const parts: string[] = [neutralizeShareFence(input.instruction.trim())];
  parts.push(languageRider(input.lang));
  const extra = neutralizeShareFence((input.extra ?? "").trim());
  if (extra) parts.push(`ALSO FROM THE SENDER (follow this too):\n${extra}`);
  const title = neutralizeShareFence(input.title.trim()) || "(untitled)";
  const where = input.wikiName ? ` — from the "${neutralizeShareFence(input.wikiName)}" wiki` : "";
  parts.push(
    `SOURCE: "${title}"${where}\n"""\n${neutralizeShareFence(input.body).trim()}\n"""`,
  );
  return parts.join("\n\n");
}

/**
 * Drop a fence that wraps the WHOLE post.
 *
 * Every shipped preset says "no wrapping code fence" — and a model that ignores it
 * doesn't produce a slightly-off post, it produces garbage in all three tabs at
 * once: `formatSlackMrkdwn` and `formatEmailHtml` both see one code block, so the
 * reader gets a monospaced blob with the markdown syntax showing. Cheaper to undo
 * here than to explain.
 *
 * Deliberately narrow: the fence must open on the FIRST line and close on the LAST
 * one, and the info string must not name a language (a post that legitimately IS
 * one ```ts block — rare, but possible from a code-heavy page — opens with
 * ```` ```ts ````, and unwrapping that would destroy real formatting). Anything
 * else is returned untouched.
 */
export function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  const m = /^(`{3,}|~{3,})[ \t]*\r?\n([\s\S]*)\r?\n\1[ \t]*$/.exec(trimmed);
  return m ? m[2]!.trim() : trimmed;
}

/**
 * Which body preparer a page's `type` calls for.
 *
 * The three kinds are `body-prep.ts`'s, and this is the only place the mapping
 * from a wiki page's `type` to one of them lives. Capture summary docs (`summary`)
 * have no page type — they arrive from the `/summaries` side, which passes the
 * kind directly.
 */
export function shareBodyKindForPageType(type: string): ShareBodyKind {
  return type === "explainer" ? "explainer" : "wiki";
}
