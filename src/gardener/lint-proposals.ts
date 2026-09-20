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
 * **ONE PAGE, ONE LIVE GROUP.** Two live rows on one `target_path` share a
 * `base_hash`, so applying either group leaves the other permanently `stale` —
 * and since the skip rule is by group key, that key is then never re-proposed
 * and the series is unnameable forever. `seedLintProposals` therefore runs four
 * rules rather than one dedup: a self-heal, a blocked-key set, a page claim and
 * a processing order. Each is documented there.
 *
 * **Dismiss is durable and has no TTL**: rejecting a group leaves its `rejected`
 * rows in place, and every later pass sees the key and skips the finding. A
 * model can draft a better page next week, but a lint finding is deterministic
 * and would come back identical forever.
 */

import path from "node:path";
import type { LintFinding } from "../wiki/lint.ts";
import type { LintPageEdit } from "../wiki/lint-series.ts";
import {
  listLintGroupRowsByWiki,
  markLintGroupStale,
  insertWikiProposal,
  type InsertWikiProposalParams,
  type LintGroupRow,
  type WikiProposal,
} from "../db/wiki-proposals.ts";
import { lintMeta, type LintSeeder } from "./lint-markers.ts";
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
  /** The page the FINDING was filed against — the same value on every row of
   *  one group, and not in general this row's own `targetPath`. */
  findingRelPath: string;
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

/**
 * Processing order within one pass: CLUSTER findings (8.2 `series-unnamed`,
 * 8.3 `series-inconsistent`) first, then 8.1 pairs.
 *
 * Both can want the same page and only one may have it. An 8.1 pair is one page
 * and one `See also` line, and skipping it costs a pass — the finding is
 * deterministic and returns unchanged. Skipping a cluster costs its HEAD, which
 * is the page the key and the label are derived from, so the finding does not
 * return unchanged: it returns as a different series.
 */
function findingRank(finding: LintFinding): number {
  return finding.check === "same-work-no-link" ? 1 : 0;
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
      findingRelPath: finding.relPath,
    });
  }
  return { rows, refusals };
}

export interface SeedLintProposalsResult {
  /** Groups whose rows were inserted. */
  proposed: number;
  /** Rows inserted across those groups. */
  rows: number;
  /** Groups skipped because this wiki already holds a `rejected` row (a durable
   *  dismissal) or a LIVE one for that key. */
  skipped: number;
  /** Findings skipped because a page they touch is already held by a live row —
   *  see the page-claim rule in {@link seedLintProposals}. */
  claimed: number;
  /** Findings every page of which refused the edit. Counted once per pass, so a
   *  wiki with one fenceless blog does not read as a growing problem. */
  refused: number;
  /** Live `draft` groups the self-heal retired because no current finding
   *  carries their key any more. */
  staled: number;
  /** Pages a finding wanted to edit and the builder would not. */
  refusals: LintProposalRefusal[];
}

export interface SeedLintProposalsDeps extends LintProposalDeps {
  /** The wiki registry name every row is keyed to — `wiki_name` AND `bot_name`.
   *  Lint rows are drafted by no bot, and the gate's bot-wiki listing reads
   *  wiki-keyed rows beside bot-keyed ones, so one name covers both shapes. */
  wikiName: string;
  /** Which SEEDER is proposing — the attribution the apply's `log.md` entry
   *  carries. Defaults to the weekly watcher. */
  seededBy?: LintSeeder;
  listGroupRows?: (wikiName: string) => Promise<LintGroupRow[]>;
  markGroupStale?: (wikiName: string, groupKey: string) => Promise<number>;
  insert?: (params: InsertWikiProposalParams) => Promise<WikiProposal | null>;
}

export type { LintSeeder };

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
  const listGroupRows = deps.listGroupRows ?? listLintGroupRowsByWiki;
  const markGroupStale = deps.markGroupStale ?? markLintGroupStale;
  const insert = deps.insert ?? insertWikiProposal;
  const existing = await listGroupRows(deps.wikiName);
  const seededBy: LintSeeder = deps.seededBy ?? "wiki-linter";

  const result: SeedLintProposalsResult = {
    proposed: 0,
    rows: 0,
    skipped: 0,
    claimed: 0,
    refused: 0,
    staled: 0,
    refusals: [],
  };

  const fixable = findings.filter((f) => !!f.fix);
  const currentKeys = new Set(fixable.map((f) => f.fix!.groupKey));

  // 1. SELF-HEAL. A live `draft` group whose key no current finding mints is a
  //    card describing a finding that no longer exists in that shape — the
  //    superseded 8.2 group after an 8.1 accept grew its member set by one, so
  //    the key moved and the old card can only ever apply a stale edit. Retire
  //    it, and do it BEFORE the claim pass so its pages are released in this
  //    same run rather than a week later.
  const vanished = new Set<string>();
  for (const row of existing) {
    if (row.status === "draft" && !currentKeys.has(row.groupKey)) vanished.add(row.groupKey);
  }
  for (const key of vanished) {
    result.staled += await markGroupStale(deps.wikiName, key);
  }
  if (vanished.size > 0) {
    log.info(
      "Lint proposals: retired {groups} superseded draft group(s) ({rows} row(s)) on {wiki}",
      { wiki: deps.wikiName, groups: vanished.size, rows: result.staled },
    );
  }

  // 2. BLOCKED KEYS and CLAIMED PAGES, over the rows the self-heal left alone.
  //    A `rejected` row blocks its key forever (Dismiss is durable); a LIVE row
  //    blocks its key AND claims its page. `applied`/`stale`/`error` do neither:
  //    the remaining pages get fresh rows with fresh hashes, and the partial
  //    unique index covers live rows only, so `topic_key` cannot collide.
  const blocked = new Set<string>();
  const claimedPaths = new Set<string>();
  for (const row of existing) {
    if (vanished.has(row.groupKey)) continue;
    if (row.status === "rejected") {
      blocked.add(row.groupKey);
      continue;
    }
    if (row.status === "draft" || row.status === "approved") {
      blocked.add(row.groupKey);
      claimedPaths.add(row.targetPath);
    }
  }

  // 3. ORDER. Cluster findings (8.2 / 8.3) before 8.1 pairs. Both can touch one
  //    page, only one of them may hold it, and the pair is the cheaper loss: a
  //    one-page `See also` comes back identically on the next pass, while a
  //    starved cluster loses its head and proposes a different series.
  const ordered = [...fixable].sort((a, b) => findingRank(a) - findingRank(b));

  const seen = new Set<string>(blocked);
  for (const finding of ordered) {
    const groupKey = finding.fix!.groupKey;
    if (seen.has(groupKey)) {
      result.skipped += 1;
      continue;
    }
    // 4. CLAIM. One page belongs to at most one LIVE group. Two live rows on one
    //    `target_path` share a `base_hash`, so applying either one leaves the
    //    other permanently `stale` — and the skip rule then refuses to re-propose
    //    the loser's key, which is how a series becomes unnameable forever.
    const wanted = new Set(finding.fix!.edits.map((e) => e.relPath));
    if ([...wanted].some((relPath) => claimedPaths.has(relPath))) {
      result.claimed += 1;
      continue;
    }
    const { rows, refusals } = await buildLintProposalRows(finding, deps);
    result.refusals.push(...refusals);
    if (rows.length === 0) {
      // Every page either already carried the edit or refused it. Either way the
      // key is settled for this pass — counted once, not once per page.
      seen.add(groupKey);
      if (refusals.length > 0) result.refused += 1;
      continue;
    }
    seen.add(groupKey);
    for (const row of rows) claimedPaths.add(row.targetPath);
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
        lintMeta: lintMeta(seededBy, row.findingRelPath),
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
