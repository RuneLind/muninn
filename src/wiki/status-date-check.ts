/**
 * The status date check: for ONE page, is its frontmatter `status_date` older
 * than the newest merge among the PRs its `prs:` names? Then the status was
 * written before the last thing landed (`GET /api/wiki/claim-check`).
 *
 * It checks only the pages the work map card's check reads (`isLiveCheckPage`);
 * any other page is `not-live`, so a page view never spends the card's budget on
 * a page the card would not ask about.
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
import { isLiveCheckPage, parseRefString, prFactsFor, type GhCheckDeps, type PrFact, type PrFacts, type PrRef } from "./work-map/gh-check.ts";

export type StatusDateNotChecked =
  | "no-prs"
  | "unreadable-prs"
  | "no-status-date"
  | "no-state"
  | "budget"
  | "auth"
  | "no-gh"
  | "disabled"
  | "not-live";

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

export type StatusDateBody = StatusDateVerdict & { wiki: string; relPath: string; at: number; refreshing?: true };

/** Only these pages carry frontmatter the check reads. */
export function isStatusDatePage(relPath: string): boolean {
  return /\.mdx?$/i.test(relPath);
}

/**
 * The top-level `prs:` key in a page's raw frontmatter text: `absent`, `empty`
 * (no value, `[]`, `""` or a comment, with no indented line under it), or
 * `present`, with the key's own lines trimmed (comments and blanks left out).
 * It reads the text, not `parseFrontmatter`, which drops a block list and so
 * cannot tell a page that lists PRs in that shape from one that lists none.
 */
export function prsKeyOf(frontmatter: string): { state: "absent" | "empty" | "present"; lines: string[] } {
  // Every read below trims, so a CRLF line's `\r` needs no strip.
  const all = frontmatter.split("\n");
  const at = all.findIndex((l) => /^prs:/.test(l));
  if (at === -1) return { state: "absent", lines: [] };
  const lines = [all[at]!.trim()];
  for (const l of all.slice(at + 1)) {
    if (!l.trim() || l.trim().startsWith("#")) continue;
    if (!/^\s/.test(l)) break;
    lines.push(l.trim());
  }
  const value = all[at]!.slice(4).replace(/(^|\s)#.*$/, "").trim();
  const empty = lines.length === 1 && (value === "" || value === "[]" || value === '""' || value === "''");
  return { state: empty ? "empty" : "present", lines };
}

/**
 * The page's `status_date` and its `prs:` as PR refs, deduped. `prs` is the
 * index's read of the field (`parseFrontmatter` through `asStringArray`), each
 * entry normalised by `normalizePrRef`; an entry of no PR shape is kept in
 * `unreadable`. With no readable entry, the page is `no-prs` when its raw
 * `frontmatter` has an empty `prs:` key ({@link prsKeyOf}), `unreadable-prs`
 * when an entry was unreadable or the raw key is non-empty, else `no-prs`.
 */
export function readStatusDateInputs(
  meta: Pick<WikiPageMeta, "prs" | "status_date">,
  frontmatter: string | null = null,
): { ok: true; statusDate: string; refs: PrRef[]; unreadable: string[] } | { ok: false; verdict: StatusDateVerdict } {
  const refs = new Map<string, PrRef>();
  const unreadable = new Set<string>();
  for (const raw of meta.prs ?? []) {
    const norm = normalizePrRef(raw);
    const ref = norm ? parseRefString(norm) : null;
    if (!ref) {
      if (raw.trim()) unreadable.add(raw.trim());
    } else if (!refs.has(ref.id)) refs.set(ref.id, ref);
  }
  if (!refs.size) {
    const key = frontmatter === null ? null : prsKeyOf(frontmatter);
    // `prs: [] # none` reaches `meta.prs` as one string; the raw key says empty.
    if (key?.state === "empty") return { ok: false, verdict: { verdict: "notChecked", reason: "no-prs" } };
    if (unreadable.size) return { ok: false, verdict: { verdict: "notChecked", reason: "unreadable-prs", unreadable: [...unreadable] } };
    if (key?.state === "present") return { ok: false, verdict: { verdict: "notChecked", reason: "unreadable-prs", unreadable: key.lines } };
    return { ok: false, verdict: { verdict: "notChecked", reason: "no-prs" } };
  }
  const statusDate = readStatusDate(meta.status_date);
  if (!statusDate) return { ok: false, verdict: { verdict: "notChecked", reason: "no-status-date" } };
  return { ok: true, statusDate, refs: [...refs.values()], unreadable: [...unreadable] };
}

/** Why one PR's state is unknown. */
export type UnknownReason = "no-state" | "budget" | "auth" | "no-gh";

const UNKNOWN_ORDER: readonly UnknownReason[] = ["no-gh", "auth", "budget", "no-state"];

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
  unknownReason: (ref: PrRef) => UnknownReason = () => "no-state",
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

type CheckedMeta = Pick<WikiPageMeta, "relPath" | "prs" | "status_date" | "plan_status" | "followups" | "culled">;

/** A page the work map card's check does not read: answered with no fetch. */
export function notLiveStatusDateBody(wiki: string, meta: CheckedMeta, at: number): StatusDateBody | null {
  return isLiveCheckPage(meta) ? null : { wiki, relPath: meta.relPath, at, verdict: "notChecked", reason: "not-live" };
}

/** The check for one page of a wiki the `gh` gate let through. `frontmatter`
 *  is the page's raw frontmatter text, for {@link prsKeyOf}. */
export async function checkStatusDate(
  input: { wiki: string; meta: CheckedMeta; frontmatter?: string | null },
  gh: GhCheckDeps,
  now: () => number,
): Promise<StatusDateBody> {
  const notLive = notLiveStatusDateBody(input.wiki, input.meta, now());
  if (notLive) return notLive;
  const head = { wiki: input.wiki, relPath: input.meta.relPath };
  const read = readStatusDateInputs(input.meta, input.frontmatter ?? null);
  if (!read.ok) return { ...head, at: now(), ...read.verdict };
  const fetched = await prFactsFor(input.wiki, read.refs, gh, now);
  const verdict = judgeStatusDate(read.statusDate, read.refs, fetched.facts, unknownReasonOf(fetched), read.unreadable);
  return { ...head, at: now(), ...verdict, ...(fetched.refreshing ? { refreshing: true as const } : {}) };
}

export function disabledStatusDateBody(wiki: string, relPath: string, at: number): StatusDateBody {
  return { wiki, relPath, at, verdict: "notChecked", reason: "disabled" };
}
