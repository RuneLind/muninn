/**
 * The status date check: for ONE page, is its frontmatter `status_date` older
 * than the newest merge among the PRs its `prs:` names? Then the status was
 * written before the last thing landed (`GET /api/wiki/claim-check`).
 *
 * The judgement ({@link readStatusDateInputs}, {@link judgeStatusDate}) is pure;
 * {@link checkStatusDate} fetches the PR facts through the work map check's
 * per-wiki cache, flight and hourly budget (`work-map/gh-check.ts`). The caller
 * applies the work map's `gh` gate (`workMapGhGate`) first.
 *
 * Nothing here writes to a wiki.
 */

import { todayOslo } from "../utils/date-hash.ts";
import { normalizePrRef, readStatusDate, type WikiPageMeta } from "./store.ts";
import { parseRefString, prFactsFor, type GhCheckDeps, type PrFact, type PrFacts, type PrRef } from "./work-map/gh-check.ts";

export type StatusDateNotChecked = "no-prs" | "no-status-date" | "no-state" | "budget" | "auth" | "no-gh" | "disabled";

export interface NewestMerge {
  /** `owner/repo#n`. */
  pr: string;
  repo: string;
  n: number;
  mergedAt: string;
  /** The Europe/Oslo day of `mergedAt`. */
  mergedDay: string;
}

export type StatusDateVerdict =
  | { verdict: "late"; statusDate: string; newest: NewestMerge }
  | { verdict: "clear"; statusDate: string; newest?: NewestMerge }
  | { verdict: "notChecked"; reason: StatusDateNotChecked; repos?: string[] };

export type StatusDateBody = StatusDateVerdict & { wiki: string; relPath: string; at: number; refreshing?: true };

/** Only these pages carry frontmatter the check reads. */
export function isStatusDatePage(relPath: string): boolean {
  return /\.mdx?$/i.test(relPath);
}

/**
 * The page's `status_date` and its `prs:` as PR refs, deduped. `prs` is the
 * index's read of the field (`parseFrontmatter` through `asStringArray`), each
 * entry normalised by `normalizePrRef`; an entry of no PR shape is dropped.
 */
export function readStatusDateInputs(
  meta: Pick<WikiPageMeta, "prs" | "status_date">,
): { ok: true; statusDate: string; refs: PrRef[] } | { ok: false; verdict: StatusDateVerdict } {
  const refs = new Map<string, PrRef>();
  for (const raw of meta.prs ?? []) {
    const norm = normalizePrRef(raw);
    const ref = norm ? parseRefString(norm) : null;
    if (ref && !refs.has(ref.id)) refs.set(ref.id, ref);
  }
  if (!refs.size) return { ok: false, verdict: { verdict: "notChecked", reason: "no-prs" } };
  const statusDate = readStatusDate(meta.status_date);
  if (!statusDate) return { ok: false, verdict: { verdict: "notChecked", reason: "no-status-date" } };
  return { ok: true, statusDate, refs: [...refs.values()] };
}

/** Why one PR's state is unknown. */
export type UnknownReason = "no-state" | "budget" | "auth" | "no-gh";

const UNKNOWN_ORDER: readonly UnknownReason[] = ["no-gh", "auth", "budget", "no-state"];

/**
 * The verdict. A PR GitHub answered NOT_FOUND for (`facts` holds null) is no PR
 * and is left out. A known merge on a later Oslo day than `statusDate` fires
 * even beside an unknown entry; otherwise any unknown entry makes the page not
 * checked, with the worst of their reasons.
 */
export function judgeStatusDate(
  statusDate: string,
  refs: readonly PrRef[],
  facts: ReadonlyMap<string, PrFact | null>,
  unknownReason: (ref: PrRef) => UnknownReason = () => "no-state",
): StatusDateVerdict {
  let newest: NewestMerge | undefined;
  let prs = 0;
  const unknown: PrRef[] = [];
  for (const ref of refs) {
    const fact = facts.get(ref.id);
    if (fact === null) continue;
    prs++;
    const mergedMs = fact?.state === "MERGED" && fact.mergedAt ? Date.parse(fact.mergedAt) : NaN;
    if (fact === undefined || (fact.state === "MERGED" && Number.isNaN(mergedMs))) {
      unknown.push(ref);
      continue;
    }
    if (Number.isNaN(mergedMs)) continue;
    if (!newest || mergedMs > Date.parse(newest.mergedAt)) {
      newest = { pr: ref.key, repo: ref.repo, n: ref.n, mergedAt: fact.mergedAt!, mergedDay: todayOslo(mergedMs) };
    }
  }
  if (!prs) return { verdict: "notChecked", reason: "no-prs" };
  if (newest && newest.mergedDay > statusDate) return { verdict: "late", statusDate, newest };
  if (unknown.length) {
    const reasons = unknown.map((ref) => ({ ref, reason: unknownReason(ref) }));
    const reason = UNKNOWN_ORDER.find((r) => reasons.some((x) => x.reason === r))!;
    const repos = [...new Set(reasons.filter((x) => x.reason === reason).map((x) => x.ref.repo))];
    return reason === "auth" || reason === "no-gh" ? { verdict: "notChecked", reason, repos } : { verdict: "notChecked", reason };
  }
  return newest ? { verdict: "clear", statusDate, newest } : { verdict: "clear", statusDate };
}

/** A fetch's unknown PR, by cause: the budget cut it, its repo failed (`sso`
 *  and `no-access` are login refusals too, so they read as `auth`), else no state. */
export function unknownReasonOf(fetched: Pick<PrFacts, "overBudget" | "failures">): (ref: PrRef) => UnknownReason {
  return (ref) => {
    if (fetched.overBudget.has(ref.id)) return "budget";
    const failure = fetched.failures.get(ref.repo.toLowerCase());
    if (failure === "no-gh") return "no-gh";
    if (failure) return "auth";
    return "no-state";
  };
}

/** The check for one page of a wiki the `gh` gate let through. */
export async function checkStatusDate(
  input: { wiki: string; meta: Pick<WikiPageMeta, "relPath" | "prs" | "status_date"> },
  gh: GhCheckDeps,
  now: () => number,
): Promise<StatusDateBody> {
  const head = { wiki: input.wiki, relPath: input.meta.relPath };
  const read = readStatusDateInputs(input.meta);
  if (!read.ok) return { ...head, at: now(), ...read.verdict };
  const fetched = await prFactsFor(input.wiki, read.refs, gh, now);
  const verdict = judgeStatusDate(read.statusDate, read.refs, fetched.facts, unknownReasonOf(fetched));
  return { ...head, at: now(), ...verdict, ...(fetched.refreshing ? { refreshing: true as const } : {}) };
}

export function disabledStatusDateBody(wiki: string, relPath: string, at: number): StatusDateBody {
  return { wiki, relPath, at, verdict: "notChecked", reason: "disabled" };
}
