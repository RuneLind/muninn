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

import { facetJiraKeys } from "../dashboard/views/components/wiki-filter.ts";
import { ownerCensus } from "./frontmatter-lists.ts";
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
 * The contribution cap is applied per thread (see `contributions.cut`).
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
  const foldOf = new Map<string, string>();
  for (const [fold, members] of seriesMembersByFoldKey(input.pages)) {
    for (const m of members) {
      foldOf.set(m.relPath, fold);
      if (inFocus.has(m.relPath)) series[m.relPath] = fold;
    }
  }
  // An attachment (rules 1–3, part of its page) counts in its markdown
  // parent's series, the page Save as series writes for it; its own `series:`
  // counts nowhere (the census skips it), and a retired (rule-4) child is its
  // own page. `computeWorkFocus` keys a family's threads by the parent, so no
  // shipped focus page is a rules-1–3 child; this guards a caller whose
  // threads name one.
  for (const rel of focus) {
    const p = byRel.get(rel);
    const fold = p?.parent && p.pairedBy !== "superseded" ? foldOf.get(p.parent) : undefined;
    if (fold) series[rel] = fold;
  }
  const projects: Record<string, string> = {};
  for (const rel of focus) {
    const project = byRel.get(rel)?.project;
    if (project) projects[rel] = project;
  }

  // A `related:` target that is a rail attachment (rules 1–3) names its
  // family, whose focus page is the parent; a retired child is its own page.
  const familyOf = (to: string): string => {
    const p = byRel.get(to);
    return p?.parent && p.pairedBy !== "superseded" ? p.parent : to;
  };
  const related: [string, string][] = [];
  let skipped = 0;
  let ambiguous = 0;
  for (const rel of focus) {
    const page = byRel.get(rel);
    if (!page) continue;
    skipped += page.relatedSkipped ?? 0;
    ambiguous += page.relatedAmbiguous ?? 0;
    const seen = new Set<string>();
    for (const target of page.related ?? []) {
      const to = familyOf(target);
      if (to === rel || seen.has(to) || !inFocus.has(to)) continue;
      seen.add(to);
      related.push([rel, to]);
    }
  }

  // Owners: the whole wiki, reserved and culled pages owning nothing (lint
  // check 14's rule). Named: a focus page's facet keys — a stamped `jira:`
  // entry, or an inferred ref that counts.
  const owners = ownerCensus(
    input.pages.map((p) => ({ relPath: p.relPath, owns: p.owns ?? [], ...(p.culled ? { culled: true } : {}) })),
  );
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
  // The cap cuts on a thread boundary: a thread's rows ship whole or not at
  // all, in thread order, and a thread that does not fit is named in `cut`
  // while a later, smaller one may still fit.
  const byThread = new Map<string, WorkContribution[]>();
  for (const row of input.contributions) {
    const list = byThread.get(row[2]) ?? [];
    list.push(row);
    byThread.set(row[2], list);
  }
  const rows: WorkContribution[] = [];
  const cut: string[] = [];
  for (const t of input.threads) {
    const mine = byThread.get(t.key) ?? [];
    if (rows.length + mine.length <= WORK_EVIDENCE_CONTRIBUTIONS_MAX) rows.push(...mine);
    else cut.push(t.key);
  }
  if (cut.length) contribReasons.push("contributions-cap");

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
    contributions: { complete: contribReasons.length === 0, reasons: contribReasons, cut, rows },
  };
}
