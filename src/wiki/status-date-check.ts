/**
 * The status date check: for ONE page, is its frontmatter `status_date` older
 * than the newest merge among the PRs its `prs:` names? Then the status was
 * written before the last thing landed (`GET /api/wiki/claim-check`).
 *
 * It never asks GitHub. The work map card's check (`work-map/gh-check.ts`) asks
 * for the `prs:` of every live plan page in its own flight, and this module
 * reads what that left in the per-wiki cache ({@link cachedPrFacts}). A PR the
 * card has not asked within the hour is `not-asked`. So is every PR of a wiki
 * whose card never asks: one with no work map, a read-only one, or the check
 * switched off.
 *
 * It answers only for the pages the card's check reads (`isLiveCheckPage`);
 * any other page is `not-live`, since the card never asks for its `prs:`.
 *
 * Nothing here writes to a wiki or spawns a process.
 */

import { todayOslo } from "../utils/date-hash.ts";
import { readStatusDate, type WikiPageMeta } from "./store.ts";
import { cachedPrFacts, isLiveCheckPage, prsRefsOf, type NotCheckedReason, type PrFact, type PrRef } from "./work-map/gh-check.ts";

export type StatusDateNotChecked = "no-prs" | "unreadable-prs" | "no-status-date" | "not-asked" | "auth" | "no-gh" | "not-live";

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
  | { verdict: "notChecked"; reason: StatusDateNotChecked; repos?: string[]; unreadable?: string[] };

export type StatusDateBody = StatusDateVerdict & { wiki: string; relPath: string; at: number };

/** Only these pages carry frontmatter the check reads. */
export function isStatusDatePage(relPath: string): boolean {
  return /\.mdx?$/i.test(relPath);
}

/**
 * The page's `status_date` and its `prs:` as PR refs ({@link prsRefsOf}: the
 * index's read of the field, so `no-prs` means no `prs:` the index could
 * read). With no readable entry the page is `unreadable-prs` when an entry was
 * no PR reference, else `no-prs`; both come before `no-status-date`.
 */
export function readStatusDateInputs(
  meta: Pick<WikiPageMeta, "prs" | "status_date">,
): { ok: true; statusDate: string; refs: PrRef[]; unreadable: string[] } | { ok: false; verdict: StatusDateVerdict } {
  const { refs, unreadable } = prsRefsOf(meta);
  if (!refs.length) {
    return unreadable.length
      ? { ok: false, verdict: { verdict: "notChecked", reason: "unreadable-prs", unreadable } }
      : { ok: false, verdict: { verdict: "notChecked", reason: "no-prs" } };
  }
  const statusDate = readStatusDate(meta.status_date);
  if (!statusDate) return { ok: false, verdict: { verdict: "notChecked", reason: "no-status-date" } };
  return { ok: true, statusDate, refs, unreadable };
}

/** Why one PR's state is unknown. */
export type UnknownReason = "not-asked" | "auth" | "no-gh";

const UNKNOWN_ORDER: readonly UnknownReason[] = ["no-gh", "auth", "not-asked"];

/**
 * The verdict. A PR GitHub answered NOT_FOUND for (`facts` holds null) is no PR
 * and is left out. A known merge on a later Oslo day than `statusDate` fires
 * even beside an unknown or `unreadable` entry; otherwise an `unreadable` entry
 * makes the page `unreadable-prs`, and else any unknown entry makes it not
 * checked, with the worst of their reasons.
 */
export function judgeStatusDate(
  statusDate: string,
  refs: readonly PrRef[],
  facts: ReadonlyMap<string, PrFact | null>,
  unknownReason: (ref: PrRef) => UnknownReason = () => "not-asked",
  unreadable: readonly string[] = [],
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
  if (newest && newest.mergedDay > statusDate) return { verdict: "late", statusDate, newest };
  if (unreadable.length) return { verdict: "notChecked", reason: "unreadable-prs", unreadable: [...unreadable] };
  if (!prs) return { verdict: "notChecked", reason: "no-prs" };
  if (unknown.length) {
    const reasons = unknown.map((ref) => ({ ref, reason: unknownReason(ref) }));
    const reason = UNKNOWN_ORDER.find((r) => reasons.some((x) => x.reason === r))!;
    const repos = [...new Set(reasons.filter((x) => x.reason === reason).map((x) => x.ref.repo))];
    return reason === "not-asked" ? { verdict: "notChecked", reason } : { verdict: "notChecked", reason, repos };
  }
  return newest ? { verdict: "clear", statusDate, newest } : { verdict: "clear", statusDate };
}

/** An unknown PR, by what the card's check recorded for its repo: `no-gh`, a
 *  login refusal (`auth`, and `sso` and `no-access`, which are refusals too), or
 *  nothing, which is `not-asked`. */
export function unknownReasonOf(failures: ReadonlyMap<string, Exclude<NotCheckedReason, "disabled">>): (ref: PrRef) => UnknownReason {
  return (ref) => {
    const failure = failures.get(ref.repo.toLowerCase());
    if (failure === "no-gh") return "no-gh";
    return failure ? "auth" : "not-asked";
  };
}

type CheckedMeta = Pick<WikiPageMeta, "relPath" | "prs" | "status_date" | "plan_status" | "followups" | "culled">;

/** The check for one page, from the page's index entry and the wiki's PR cache as it is at `at`. */
export function checkStatusDate(input: { wiki: string; meta: CheckedMeta }, at: number): StatusDateBody {
  const head = { wiki: input.wiki, relPath: input.meta.relPath, at };
  if (!isLiveCheckPage(input.meta)) return { ...head, verdict: "notChecked", reason: "not-live" };
  const read = readStatusDateInputs(input.meta);
  if (!read.ok) return { ...head, ...read.verdict };
  const cached = cachedPrFacts(input.wiki, read.refs, at);
  return { ...head, ...judgeStatusDate(read.statusDate, read.refs, cached.facts, unknownReasonOf(cached.failures), read.unreadable) };
}
