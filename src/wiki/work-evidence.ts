/**
 * The work-thread grouping layer's evidence (plan
 * `muninn-wiki-work-thread-grouping`, «Evidence and payload»): what connects the
 * focus pages of the shipped threads, and each session's kept work on them.
 * Pure — no IO, no clock. `store.ts` runs it after `computeWorkFocus` and ships
 * it as `IndexWork.evidence`.
 *
 * Every witness names focus pages, never threads, so a client can split a page
 * off or regroup threads from this block alone. Witnesses stay inside the wiki
 * and the focus-page set; a relation to a hub focus page counts like any other.
 */

import { isMetaStem, facetJiraKeys } from "../dashboard/views/components/wiki-filter.ts";
import { seriesMembersByFoldKey } from "../dashboard/views/components/wiki-groups.ts";
import type { WikiPageMeta } from "./store.ts";
import {
  WORK_EVIDENCE_VERSION,
  type WorkContribution,
  type WorkEvidence,
  type WorkEvidenceReason,
  type WorkThread,
} from "./work-focus.ts";

/**
 * Bounds with headroom. Measured 2026-10-17 on the named snapshots (the replay
 * with frozen answers): 45 relation entries and 64 contribution rows at 17
 * threads on the largest wiki, ~200 bytes a row. The sessions answer itself
 * stops at 200 sessions, so 1000 rows is five pages a session at that cap.
 * Each relation list holds at most {@link WORK_EVIDENCE_RELATIONS_MAX} entries.
 */
export const WORK_EVIDENCE_RELATIONS_MAX = 300;
export const WORK_EVIDENCE_CONTRIBUTIONS_MAX = 1000;

export interface WorkEvidenceInput {
  /** The shipped threads. */
  threads: readonly WorkThread[];
  /** Threads before the cut. */
  candidates: number;
  contributions: readonly WorkContribution[];
  /** claude-usage clipped the sessions answer. */
  ledgerTruncated: boolean;
  /** Every page of the index (the owner census and series membership read
   *  the whole wiki). */
  pages: readonly WikiPageMeta[];
}

export function buildWorkEvidence(input: WorkEvidenceInput): WorkEvidence {
  const byRel = new Map(input.pages.map((p) => [p.relPath, p]));
  const focus: string[] = [];
  for (const t of input.threads) for (const p of t.pages) if (!focus.includes(p)) focus.push(p);
  const inFocus = new Set(focus);

  const series: Record<string, string> = {};
  for (const [fold, members] of seriesMembersByFoldKey(input.pages)) {
    for (const m of members) if (inFocus.has(m.relPath)) series[m.relPath] = fold;
  }
  const projects: Record<string, string> = {};
  for (const rel of focus) {
    const project = byRel.get(rel)?.project;
    if (project) projects[rel] = project;
  }

  const related: [string, string][] = [];
  let skipped = 0;
  let ambiguous = 0;
  for (const rel of focus) {
    const page = byRel.get(rel);
    if (!page) continue;
    skipped += page.relatedSkipped ?? 0;
    ambiguous += page.relatedAmbiguous ?? 0;
    for (const to of page.related ?? []) if (to !== rel && inFocus.has(to)) related.push([rel, to]);
  }

  // Owners: the whole wiki, reserved and culled pages owning nothing (lint
  // check 14's rule). Named: a focus page's facet keys — a stamped `jira:`
  // entry, or an inferred ref that counts.
  const owners = new Map<string, string[]>();
  for (const p of input.pages) {
    if (!p.owns || p.culled || isMetaStem(p.name)) continue;
    for (const key of p.owns) {
      const list = owners.get(key) ?? [];
      if (!list.includes(p.relPath)) list.push(p.relPath);
      owners.set(key, list);
    }
  }
  const named = new Map<string, string[]>();
  for (const rel of focus) {
    const page = byRel.get(rel);
    if (!page) continue;
    for (const key of facetJiraKeys(page)) {
      const list = named.get(key) ?? [];
      list.push(rel);
      named.set(key, list);
    }
  }
  const keys = new Set<string>(named.keys());
  for (const [key, list] of owners) if (list.some((r) => inFocus.has(r))) keys.add(key);
  const issues: [string, string, string][] = [];
  const ambiguousIssues: { key: string; owners: string[] }[] = [];
  for (const key of [...keys].sort()) {
    const own = owners.get(key) ?? [];
    if (own.length > 1) {
      ambiguousIssues.push({ key, owners: [...own].sort() });
      continue;
    }
    const owner = own[0];
    if (!owner || !inFocus.has(owner)) continue;
    for (const ref of named.get(key) ?? []) if (ref !== owner) issues.push([key, owner, ref]);
  }

  const relReasons: WorkEvidenceReason[] = [];
  const cap = <T>(list: T[]): T[] => {
    if (list.length <= WORK_EVIDENCE_RELATIONS_MAX) return list;
    if (!relReasons.includes("relations-cap")) relReasons.push("relations-cap");
    return list.slice(0, WORK_EVIDENCE_RELATIONS_MAX);
  };
  const relatedOut = cap(related);
  const issuesOut = cap(issues);
  const ambiguousOut = cap(ambiguousIssues);

  const contribReasons: WorkEvidenceReason[] = [];
  if (input.ledgerTruncated) contribReasons.push("ledger-truncated");
  let rows = [...input.contributions];
  if (rows.length > WORK_EVIDENCE_CONTRIBUTIONS_MAX) {
    contribReasons.push("contributions-cap");
    rows = rows.slice(0, WORK_EVIDENCE_CONTRIBUTIONS_MAX);
  }

  return {
    version: WORK_EVIDENCE_VERSION,
    threads: { candidates: input.candidates, shipped: input.threads.length },
    relations: {
      complete: relReasons.length === 0,
      reasons: relReasons,
      series,
      projects,
      related: relatedOut,
      issues: issuesOut,
      ambiguousIssues: ambiguousOut,
      relatedSkipped: { skipped, ambiguous },
    },
    contributions: { complete: contribReasons.length === 0, reasons: contribReasons, rows },
  };
}
