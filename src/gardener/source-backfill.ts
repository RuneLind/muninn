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
  return [...byPath.values()].sort((a, b) => b.appliedAt - a.appliedAt);
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
 * Is this revision worth a reviewer's time — i.e. may it be persisted as a proposal?
 *
 * The plan's rule is "a re-draft that scores worse should not be applied", and the
 * cheapest place to enforce it is before the insert: a proposal that recovers
 * nothing costs a human a diff to read and an approve to regret. Both halves of the
 * score matter, and a block-count drop alone is not enough — a revision can keep
 * the same three blocks whole and quietly drop half the lines of a fourth, which
 * reads as unchanged by `kept` and as a loss by `found`.
 *
 * Equal-on-both is refused too, deliberately: the reviser is told to output the
 * page unchanged when nothing is missing, so "no block recovered" is its honest
 * no-op answer, not a diff to review.
 */
export function judgeBackfill(before: BlockRetention[], after: BlockRetention[]): BackfillVerdict {
  const b = retentionScore(before);
  const a = retentionScore(after);
  const score = `${a.kept}/${a.blocks} kept, ${a.found} lines (was ${b.kept}/${b.blocks}, ${b.found})`;
  if (a.kept < b.kept || a.found < b.found) return { ok: false, reason: `scores worse — ${score}` };
  if (a.kept === b.kept && a.found === b.found) return { ok: false, reason: `no block recovered — ${score}` };
  return { ok: true, reason: score };
}
