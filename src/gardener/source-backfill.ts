/**
 * Selecting and judging a source-page BACKFILL — the two decisions the one-off
 * backfill driver (`scripts/backfill-summary-code.ts`) must not get wrong, kept
 * here as pure functions so they are unit-tested rather than script-shaped.
 *
 * Context: 39 applied source pages were drafted before the drafter's verbatim rule
 * existed, so they paraphrase away the prompt / config / snippet their summary
 * quoted (mimir `plans/muninn-summary-code-in-wiki.mdx`). The backfill revises each
 * page in place through the normal review gate — a `mode: "update"` proposal, see
 * {@link SourceUpdateTarget} — and the two things it has to decide are WHICH page a
 * summary belongs to and WHETHER the revision is an improvement.
 */
import type { WikiProposal } from "../db/wiki-proposals.ts";
import type { BlockRetention } from "./code-block-retention.ts";

/** An applied source page, with the summary doc it was drafted from. */
export interface AppliedSourcePage {
  /** The applied proposal this page came from. */
  proposalId: string;
  /** Wiki-relative path of the page on disk. */
  relPath: string;
  collection: string;
  docId: string;
  /** The capture URL (`url:` on the page). */
  url: string;
  /** The source doc's stored title — raw material, not the page's title. */
  sourceTitle: string;
  /** When the proposal was applied (or created, for a row with no resolution). */
  appliedAt: number;
}

/**
 * The applied source pages among `proposals`, newest first, ONE per target path.
 *
 * A path can carry several applied rows — a page applied, later revised by another
 * proposal (what this very backfill produces) — and the summary doc to re-read is
 * the one the LATEST apply used. Taking an older row would measure today's page
 * against a summary it was not built from. Rows missing a source doc are dropped:
 * a source page without one cannot be scored at all.
 */
export function appliedSourcePages(proposals: WikiProposal[]): AppliedSourcePage[] {
  const byPath = new Map<string, AppliedSourcePage>();
  const sorted = [...proposals]
    .filter((p) => p.kind === "source" && p.status === "applied")
    .map((p) => ({ p, at: p.resolvedAt ?? p.createdAt }))
    .sort((a, b) => b.at - a.at);
  for (const { p, at } of sorted) {
    if (byPath.has(p.targetPath)) continue;
    const src = p.sourceDocs[0];
    if (!src) continue;
    byPath.set(p.targetPath, {
      proposalId: p.id,
      relPath: p.targetPath,
      collection: src.collection,
      docId: src.docId,
      url: src.url ?? "",
      sourceTitle: src.title ?? "",
      appliedAt: at,
    });
  }
  // Already newest-first: the scan above runs in descending `at` and a Map keeps
  // insertion order, so each path enters at its own newest apply, in order. A second
  // sort here would be dead code — and dead code no test can kill.
  return [...byPath.values()];
}

/** Blocks kept whole, and total summary lines found anywhere on the page. */
export function retentionScore(blocks: BlockRetention[]): { kept: number; found: number; blocks: number } {
  return {
    kept: blocks.filter((b) => b.verdict === "kept").length,
    found: blocks.reduce((n, b) => n + b.found, 0),
    blocks: blocks.length,
  };
}

export type BackfillVerdict = { ok: true; reason: string } | { ok: false; reason: string };

/**
 * Sentences of the page's PROSE — frontmatter and fenced code removed, each
 * whitespace-normalized. Long enough that a heading, a list marker or a lone
 * wikilink cannot match by accident.
 *
 * Sentences, not lines: a reviser that splits one paragraph around a restored
 * block keeps every sentence word for word but writes three lines where there was
 * one, and a line-level check would refuse exactly the revision the design asks
 * for (measured on `sources/Software Minimalism.mdx`, whose good revision splits a
 * paragraph in two).
 */
/**
 * Prose as the comparison sees it: wikilink and bold syntax reduced to the words
 * they carry.
 *
 * The draft handed to the score has already been through persist-time containment
 * (`containDraftBodyLinks` turns an unresolvable `[[Foo]]` into `**Foo**`,
 * `replaceUnresolvedSourceLinks` rewrites `sources:` links), and every one of those
 * rewrites happens INSIDE prose. Compared raw, a sentence whose only change is a
 * link the containment step delinked reads as deleted prose — the guard would then
 * refuse a revision that changed nothing, on exactly the pages whose links do not
 * resolve.
 */
function normalizeProse(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ");
}

export function proseSentences(page: string): string[] {
  const withoutFrontmatter = page.startsWith("---")
    ? page.slice(Math.max(0, page.indexOf("\n---", 3) + 4))
    : page;
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of withoutFrontmatter.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) fence = m[1]!.charAt(0);
      else if (m[1]!.charAt(0) === fence) fence = null;
      continue;
    }
    if (fence === null) lines.push(line);
  }
  return lines
    .join("\n")
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => normalizeProse(s).trim())
    .filter((s) => s.length >= MIN_PROSE_SENTENCE_CHARS);
}

/**
 * A sentence shorter than this is a heading, a bullet stub or a link line, and
 * short strings match by accident inside longer ones.
 */
export const MIN_PROSE_SENTENCE_CHARS = 40;

/**
 * The fraction of the page's prose sentences that survive verbatim in the draft.
 *
 * Measured on the five revisions that proved this mechanism (2026-09-16): 1.0 on
 * four of them (30/30, 21/21, 22/22, 35/35) and 28/29 on `Software Minimalism`,
 * whose reviser split one sentence in two to introduce a restored block. A full
 * re-draft of the same doc scored 0/29 on the same page. The floor only has to
 * separate "kept every sentence but one" from "kept none", so it is not a tuned
 * number.
 */
export function proseRetention(currentPage: string, draft: string): { total: number; found: number; ratio: number } {
  const haystack = normalizeProse(draft);
  const sentences = proseSentences(currentPage);
  const found = sentences.filter((s) => haystack.includes(s)).length;
  return { total: sentences.length, found, ratio: sentences.length === 0 ? 1 : found / sentences.length };
}

/** Below this fraction of surviving prose sentences, the revision is a re-draft. */
export const MIN_PROSE_RETENTION = 0.9;

/**
 * Is this revision worth a reviewer's time — i.e. may it be persisted as a proposal?
 *
 * Two independent properties, because the design makes two promises and a score
 * over code blocks alone can only see one of them.
 *
 * **It put the code back.** The plan's rule is "a re-draft that scores worse should
 * not be applied", and the cheapest place to enforce it is before the insert: a
 * proposal that recovers nothing costs a human a diff to read and an approve to
 * regret. Both halves of the score matter, and a block-count drop alone is not
 * enough — a revision can keep the same three blocks whole and quietly drop half
 * the lines of a fourth, which reads as unchanged by `kept` and as a loss by
 * `found`. Equal-on-both is refused too: a revision that recovers nothing is not a
 * diff to review.
 *
 * **It deleted nothing.** Precisely that, not "it changed nothing else": the guard
 * measures how much of the page's prose SURVIVES, so a rewrite or a dropped
 * `## See also` is refused, while prose the reviser ADDS is invisible to it. The
 * asymmetry is deliberate — every restored block is introduced by a one-line lead
 * the prompt asks for, so added prose is the designed output and a bound on it
 * would refuse good revisions. What it catches is the failure this whole design
 * chose update-in-place to avoid: a model that restores the blocks and rewrites the
 * page around them scores perfectly on code retention ({@link proseRetention}).
 */
export function judgeBackfill(opts: {
  before: BlockRetention[];
  after: BlockRetention[];
  currentPage: string;
  draft: string;
}): BackfillVerdict {
  const b = retentionScore(opts.before);
  const a = retentionScore(opts.after);
  const prose = proseRetention(opts.currentPage, opts.draft);
  const score = `${a.kept}/${a.blocks} kept, ${a.found} lines (was ${b.kept}/${b.blocks}, ${b.found}), prose ${prose.found}/${prose.total}`;
  if (a.kept < b.kept || a.found < b.found) return { ok: false, reason: `scores worse — ${score}` };
  if (a.kept === b.kept && a.found === b.found) return { ok: false, reason: `no block recovered — ${score}` };
  if (prose.ratio < MIN_PROSE_RETENTION) return { ok: false, reason: `rewrote the page — ${score}` };
  return { ok: true, reason: score };
}

/**
 * What a backfill run did with one page, for the operator's line — and in
 * particular, WHY nothing was persisted.
 *
 * Three different non-persisting outcomes reach this point and only one of them is
 * the guard's doing: a dry run, the score guard's refusal, and `insertWikiProposal`
 * answering null because a live draft or approved proposal already exists for this
 * doc (`ON CONFLICT … WHERE status IN ('draft','approved')`). Reporting the last as
 * a refusal beside a PASSING score tells the operator a working page was rejected.
 */
export function backfillOutcomeLabel(state: {
  /** The id `insertWikiProposal` returned, if it inserted a row. */
  proposalId: string | undefined;
  dryRun: boolean;
  /** Whether {@link judgeBackfill} passed — false when the score guard refused. */
  judgedOk: boolean;
}): string {
  if (state.proposalId) return "persisted";
  if (!state.judgedOk) return "refused, not persisted";
  if (state.dryRun) return "dry-run, not persisted";
  return "insert conflict — a live proposal already exists for this doc";
}
