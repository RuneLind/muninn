/**
 * Live chips (living facts PR 3b): the pure half the server and the reader's
 * bundle share — the facts file's entry shapes, the page payload's `facts`
 * field and the chip text. DOM-free and dependency-free.
 *
 * Chip text («Chip text» in mimir `plans/muninn-wiki-living-facts.mdx`, pinned
 * by the claude-skills fixture `wiki-facts-chips.json`):
 * - a PR: its state (`åpen`, `draft`, `merget`, `lukket` for one closed
 *   without a merge); when merged in a repo that deploys, `i prod <tag>`,
 *   `i prod` (no first release known), `ikke i prod` or `?` (`inProd` null);
 *   then the entry's age.
 * - a key: its Jira status with Jira's own `updated` date, when the deferred
 *   provenance answer has one; then a summary over its PRs in repos that
 *   deploy, closed unmerged ones left out (`i prod` when every one is,
 *   `N av M i prod`, `M åpne` when none is merged), with the oldest entry's age.
 */

/** The class and the attribute the server's chip span carries. `data-fact`
 *  is the fact-check marks'. */
export const FACT_CHIP_CLASS = "fact-chip";
export const LIVE_FACT_ATTR = "data-live-fact";
/** A key mark (Discuss v2 PR 6, `planKeyMarks` in `src/wiki/live-facts.ts`). */
export const KEY_MARK_CLASS = "wiki-key";
export const KEY_MARK_ATTR = "data-wiki-key";
/** A mark whose own chip shows right after it (the reader's chip paint):
 *  that key's hover target is its chip, so the mark draws no underline and
 *  opens no peek (fix round 1 J1). */
export const KEY_MARK_CHIPPED_CLASS = "wiki-key-chipped";
/** A key mark that is its key's hover target. */
export const KEY_PEEK_MARK_SELECTOR = `.${KEY_MARK_CLASS}[${KEY_MARK_ATTR}]:not(.${KEY_MARK_CHIPPED_CLASS})`;
/** A chip whose (oldest) entry is older than this dims. */
export const CHIP_DIM_DAYS = 7;

export interface FactsPrEntry {
  title: string;
  /** `OPEN`, `MERGED` or `CLOSED` (closed without a merge). */
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  inProd: boolean | null;
  firstProd: { tag: string; publishedAt: string } | null;
  draftTag: string | null;
  checkedAt: string;
}

export interface FactsKeyEntry {
  prs: string[];
  searchedAt?: string;
}

/** The payload's entry for a PR chip's id, ignoring case (GitHub owner and
 *  repo names do; the payload holds the facts file's spelling). */
export function prOf(facts: LiveFactsPayload, id: string): FactsPrEntry | undefined {
  if (Object.hasOwn(facts.prs, id)) return facts.prs[id];
  const lower = id.toLowerCase();
  for (const k of Object.keys(facts.prs)) if (k.toLowerCase() === lower) return facts.prs[k];
  return undefined;
}

/** `GET /api/wiki/page`'s `facts`: the entries for the refs and keys marked on
 *  the page, plus every PR in those keys' lists, one entry per PR under the
 *  facts file's id. A chip's `data-live-fact` keeps the page's spelling, so a
 *  PR chip is looked up ignoring case ({@link prOf}). */
export interface LiveFactsPayload {
  prs: Record<string, FactsPrEntry>;
  keys: Record<string, FactsKeyEntry>;
  /** The `prGrammar.noProd` repos among `prs`, lowercased `owner/repo`. */
  noProd: string[];
}

export type ChipLanguage = "en" | "no";

const WORDS = {
  no: { open: "åpen", draft: "draft", merged: "merget", closed: "lukket", inProd: "i prod", notInProd: "ikke i prod", of: "av", opens: "åpne", today: "i dag", checked: "sjekket" },
  en: { open: "open", draft: "draft", merged: "merged", closed: "closed", inProd: "in prod", notInProd: "not in prod", of: "of", opens: "open", today: "today", checked: "checked" },
} as const;

const words = (lang: string | undefined) => (lang === "no" ? WORDS.no : WORDS.en);

/** `owner/repo` of `owner/repo#n`. */
export const repoOfPr = (id: string): string => id.slice(0, id.indexOf("#"));

/** A PR chip's state word and prod part (null: the chip shows the state alone). */
export function prChipParts(e: FactsPrEntry, deploys: boolean, lang?: string): { state: string; prod: string | null } {
  const w = words(lang);
  const state = e.state === "MERGED" ? w.merged : e.state === "CLOSED" ? w.closed : e.isDraft ? w.draft : w.open;
  if (e.state !== "MERGED" || !deploys) return { state, prod: null };
  const prod = e.inProd === true ? (e.firstProd ? `${w.inProd} ${e.firstProd.tag}` : w.inProd) : e.inProd === false ? w.notInProd : "?";
  return { state, prod };
}

/** The PR entries a key chip counts: its listed PRs that have an entry, in a
 *  repo that deploys, not closed unmerged. */
export function countedKeyPrs(key: FactsKeyEntry, prs: Readonly<Record<string, FactsPrEntry>>, deploys: (id: string) => boolean): FactsPrEntry[] {
  return key.prs.flatMap((id) => {
    const e = prs[id];
    return e && deploys(id) && e.state !== "CLOSED" ? [e] : [];
  });
}

/** A key chip's summary over its counted PRs; null when none is counted. */
export function keySummary(counted: readonly FactsPrEntry[], lang?: string): string | null {
  if (counted.length === 0) return null;
  const w = words(lang);
  if (!counted.some((e) => e.state === "MERGED")) return `${counted.length} ${w.opens}`;
  const n = counted.filter((e) => e.inProd === true).length;
  return n === counted.length ? w.inProd : `${n} ${w.of} ${counted.length} ${w.inProd}`;
}

const DAY_MS = 86_400_000;

/** Whole days from `iso` to `nowMs`; null for an unreadable date. */
export function ageDays(iso: string, nowMs: number): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / DAY_MS)) : null;
}

/** An entry's age as chip text: `i dag`/`today`, else `N d`. */
export function ageText(days: number, lang?: string): string {
  return days < 1 ? words(lang).today : `${days} d`;
}

/** Jira's `updated` stamp as a short date: `12.11` (no), `2026-11-12` (en). */
export function shortDay(iso: string, lang?: string): string {
  const d = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  return lang === "no" ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : d;
}

export interface ChipView {
  text: string;
  /** The chip's tooltip: when the facts were read. */
  title: string;
  dim: boolean;
}

function oldest(entries: readonly FactsPrEntry[]): string | null {
  let best: string | null = null;
  for (const e of entries) if (best === null || Date.parse(e.checkedAt) < Date.parse(best)) best = e.checkedAt;
  return best;
}

function agePart(checkedAt: string | null, nowMs: number, lang?: string): { text: string; title: string; dim: boolean } | null {
  if (!checkedAt) return null;
  const days = ageDays(checkedAt, nowMs);
  if (days === null) return null;
  return { text: ageText(days, lang), title: `${words(lang).checked} ${checkedAt.slice(0, 10)}`, dim: days > CHIP_DIM_DAYS };
}

/**
 * The chip for one `data-live-fact` id, or null when it shows nothing (no
 * entry; a key with no counted PR and no Jira status). `jira`: the key's row
 * from the deferred provenance answer, once it has landed.
 */
export function chipView(
  id: string,
  facts: LiveFactsPayload,
  nowMs: number,
  lang?: string,
  jira?: { status?: string; updated?: string },
): ChipView | null {
  const noProd = new Set(facts.noProd);
  const deploys = (pr: string) => !noProd.has(repoOfPr(pr).toLowerCase());
  const pr = prOf(facts, id);
  if (id.includes("#")) {
    if (!pr) return null;
    const { state, prod } = prChipParts(pr, deploys(id), lang);
    const age = agePart(pr.checkedAt, nowMs, lang);
    return { text: [state, prod, age?.text].filter(Boolean).join(" · "), title: age?.title ?? "", dim: age?.dim ?? false };
  }
  const key = facts.keys[id];
  if (!key) return null;
  const counted = countedKeyPrs(key, facts.prs, deploys);
  const summary = keySummary(counted, lang);
  const status = jira?.status?.trim() ? [jira.status.trim(), jira.updated ? shortDay(jira.updated, lang) : ""].filter(Boolean).join(" ") : "";
  if (!summary && !status) return null;
  const age = summary ? agePart(oldest(counted), nowMs, lang) : null;
  return { text: [status, summary, age?.text].filter(Boolean).join(" · "), title: age?.title ?? "", dim: age?.dim ?? false };
}
