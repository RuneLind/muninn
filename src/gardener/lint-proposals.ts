/**
 * LINT FIXES → `wiki_proposals` rows.
 *
 * The wiki linter's check 8 (`src/wiki/lint-series.ts`) is the only check whose
 * findings carry a machine-readable `fix`. This module turns one into the rows
 * the existing human review gate already knows how to render and apply:
 *
 *  - **one row per touched PAGE** — its own `target_path`, its own `base_hash`
 *    (the CAS `apply.ts` already checks), its own draft, its own status;
 *  - **all of them sharing a `group_key`**, so the gate shows one card with N
 *    diffs and one Accept. Approving half a series is a worse state than not
 *    approving it at all.
 *
 * `kind: "lint"`, `mode: "update"`, `source_docs: []`. No model call is made
 * anywhere on this path: the draft is the page's own bytes with one mechanical
 * edit applied, which is also why `apply.ts` skips the alias-strip and
 * body-link containment for this kind (see `applyInner`).
 *
 * **Dedup is by GROUP KEY in ANY status** (`getLintGroupKeysByWiki`), which is
 * what makes Dismiss durable: rejecting a group leaves its `rejected` rows in
 * place, and a later re-seed — the weekly `wiki-linter` watcher, or a click on
 * `Propose fixes` — sees the key and skips the finding rather than proposing it
 * again. There is no TTL, unlike the concept gardener's rejection skip list: a
 * model can draft a better page next week, but a lint finding is deterministic
 * and would come back identical forever.
 */

import path from "node:path";
import type { LintFinding } from "../wiki/lint.ts";
import type { LintPageEdit } from "../wiki/lint-series.ts";
import {
  getLintGroupKeysByWiki,
  insertWikiProposal,
  type InsertWikiProposalParams,
  type WikiProposal,
} from "../db/wiki-proposals.ts";
import { setFrontmatterScalar } from "../plans/frontmatter.ts";
import { buildSeeAlsoEdit } from "./wire.ts";
import { sha256 } from "./util.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "lint-proposals");

/** One page's proposed row, before it reaches the DB. */
export interface LintProposalRow {
  topicKey: string;
  groupKey: string;
  targetPath: string;
  baseHash: string;
  draft: string;
  rationale: string;
}

/** A page a finding wanted to edit and this builder would not. */
export interface LintProposalRefusal {
  relPath: string;
  reason: string;
}

export interface LintProposalDeps {
  /** Absolute wiki root the `relPath`s are resolved against. */
  wikiDir: string;
  /** Read a file's text, or null when it does not exist / is unreadable. */
  readFile: (absPath: string) => Promise<string | null>;
}

/** The default disk reader — the same shape `apply.ts` uses. */
export const DEFAULT_LINT_PROPOSAL_DEPS: Omit<LintProposalDeps, "wikiDir"> = {
  readFile: async (absPath) => {
    try {
      return await Bun.file(absPath).text();
    } catch {
      return null;
    }
  },
};

/** Apply ONE edit to a page's current content. `null` means "nothing to do" and
 *  a string message means "this page cannot take this edit". */
function applyEdit(content: string, edit: LintPageEdit): string | null | { refused: string } {
  if (edit.op === "see-also") {
    // Returns null when the page already links the target — idempotent, exactly
    // as the apply-time wire stage is.
    return buildSeeAlsoEdit(content, edit.title);
  }
  const result = setFrontmatterScalar(content, edit.key, edit.value);
  if (result.kind === "refused") return { refused: result.reason };
  if (result.kind === "noop") return null;
  return result.content;
}

/** Why this group is being proposed, one line, shown on every card. */
function rationaleFor(finding: LintFinding): string {
  return finding.detail ? `${finding.message} — ${finding.detail}` : finding.message;
}

/**
 * The rows for ONE finding. Edits are grouped by page and applied IN ORDER, so
 * the 8.2 head — which takes both `series:` and `series_label:` — ends up as one
 * row carrying both lines rather than two rows racing on one `target_path`.
 *
 * A page whose edits all no-op (already linked, key already correct) contributes
 * no row; a page that REFUSES the edit (no frontmatter fence, unreadable file)
 * contributes a refusal and no row. Either way the rest of the group still
 * proposes: a blog with no fence must not cost the series its other five
 * members, and the reviewer sees the members that could be written.
 */
export async function buildLintProposalRows(
  finding: LintFinding,
  deps: LintProposalDeps,
): Promise<{ rows: LintProposalRow[]; refusals: LintProposalRefusal[] }> {
  const rows: LintProposalRow[] = [];
  const refusals: LintProposalRefusal[] = [];
  if (!finding.fix) return { rows, refusals };
  const { groupKey, edits } = finding.fix;

  const byPage = new Map<string, LintPageEdit[]>();
  for (const edit of edits) {
    const list = byPage.get(edit.relPath);
    if (list) list.push(edit);
    else byPage.set(edit.relPath, [edit]);
  }

  const rationale = rationaleFor(finding);
  for (const [relPath, pageEdits] of byPage) {
    const content = await deps.readFile(path.join(deps.wikiDir, relPath));
    if (content === null) {
      refusals.push({ relPath, reason: "page is unreadable" });
      continue;
    }
    let draft = content;
    let refused: string | null = null;
    for (const edit of pageEdits) {
      const next = applyEdit(draft, edit);
      if (next === null) continue;
      if (typeof next === "object") {
        refused = next.refused;
        break;
      }
      draft = next;
    }
    if (refused) {
      refusals.push({ relPath, reason: refused });
      continue;
    }
    if (draft === content) continue; // every edit was already in place
    rows.push({
      // `topic_key` is unique per LIVE row (`wiki_proposals_wiki_topic_live_idx`),
      // so the page's path has to be in it — the group key alone would let only
      // one member of a group be live at a time.
      topicKey: `${groupKey}:${relPath}`,
      groupKey,
      targetPath: relPath,
      baseHash: sha256(content),
      draft,
      rationale,
    });
  }
  return { rows, refusals };
}

export interface SeedLintProposalsResult {
  /** Groups whose rows were inserted. */
  proposed: number;
  /** Rows inserted across those groups. */
  rows: number;
  /** Groups skipped because the wiki already holds rows for that key, in any
   *  status — including the `rejected` rows a Dismiss leaves behind. */
  skipped: number;
  /** Pages a finding wanted to edit and the builder would not. */
  refusals: LintProposalRefusal[];
}

export interface SeedLintProposalsDeps extends LintProposalDeps {
  /** The wiki registry name every row is keyed to — `wiki_name` AND `bot_name`.
   *  Lint rows are drafted by no bot, and the gate's bot-wiki listing reads
   *  wiki-keyed rows beside bot-keyed ones, so one name covers both shapes. */
  wikiName: string;
  usedGroupKeys?: (wikiName: string) => Promise<Set<string>>;
  insert?: (params: InsertWikiProposalParams) => Promise<WikiProposal | null>;
}

/**
 * Turn every check-8 finding that carries a fix into proposal rows, skipping the
 * groups this wiki has already seen.
 *
 * The caller is responsible for the read-only refusals — this function writes DB
 * rows for a wiki the instance may not be allowed to write at all, and both the
 * watcher and the route check `isWikiReadonly()` / `isReadonlyWikiRoot()` before
 * calling it.
 */
export async function seedLintProposals(
  findings: readonly LintFinding[],
  deps: SeedLintProposalsDeps,
): Promise<SeedLintProposalsResult> {
  const usedGroupKeys = deps.usedGroupKeys ?? getLintGroupKeysByWiki;
  const insert = deps.insert ?? insertWikiProposal;
  const used = await usedGroupKeys(deps.wikiName);

  const result: SeedLintProposalsResult = { proposed: 0, rows: 0, skipped: 0, refusals: [] };
  // A finding's group key is deterministic, so two findings never share one —
  // but a seeding pass must still not insert the same key twice if it did.
  const seen = new Set<string>(used);
  for (const finding of findings) {
    if (!finding.fix) continue;
    if (seen.has(finding.fix.groupKey)) {
      result.skipped += 1;
      continue;
    }
    const { rows, refusals } = await buildLintProposalRows(finding, deps);
    result.refusals.push(...refusals);
    if (rows.length === 0) continue;
    seen.add(finding.fix.groupKey);
    let inserted = 0;
    for (const row of rows) {
      const created = await insert({
        botName: deps.wikiName,
        wikiName: deps.wikiName,
        topicKey: row.topicKey,
        groupKey: row.groupKey,
        kind: "lint",
        mode: "update",
        targetPath: row.targetPath,
        baseHash: row.baseHash,
        draft: row.draft,
        sourceDocs: [],
        rationale: row.rationale,
      });
      if (created) inserted += 1;
    }
    if (inserted > 0) {
      result.proposed += 1;
      result.rows += inserted;
    }
  }
  if (result.refusals.length > 0) {
    log.warn("Lint proposals: {count} page(s) could not take their fix on {wiki}: {detail}", {
      wiki: deps.wikiName,
      count: result.refusals.length,
      detail: result.refusals.map((r) => `${r.relPath} (${r.reason})`).join("; "),
    });
  }
  return result;
}
