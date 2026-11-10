/**
 * The claim check (plan muninn-wiki-first-screen-claims, PR 2): for ONE page,
 * whether the page's own status lines disagree with GitHub. Read-only: it
 * reads the page and asks GitHub through the work map's check
 * (`work-map/gh-check.ts`), whose per-wiki cache, flight and hourly budget it
 * shares, so a page view asks GitHub at most once an hour per PR.
 *
 * | rule | fires when                                                                 |
 * |------|----------------------------------------------------------------------------|
 * | R1   | a home line names a PR with an open word DIRECTLY after it (`#5 åpen`,      |
 * |      | `(api #5, utkast)`), or a ledger row's state cell opens with one for the    |
 * |      | row's own PR, and GitHub says MERGED or CLOSED. A not-merged word           |
 * |      | (`ikke merget`, `unmerged`) contradicts MERGED only                          |
 * | R2   | frontmatter `status_date` is an older day than the newest merge among the   |
 * |      | PRs in frontmatter `prs:`                                                    |
 *
 * The homes are lint check 14's (`stateLineRoles`): `status_note`, a
 * `<StatusRows>` line, a `**Status**` paragraph or item, a PR-ledger row. A
 * state word anywhere else on the line is not read: a dry run of that looser
 * form on 213 live plan pages raised 12 false flags of 16, the narrow form 4,
 * all true.
 *
 * A PR is a GitHub pull URL (a markdown link or bare), `owner/repo#n`,
 * `repo#n`, `PR #n` or a bare `#n`. A repo without an owner takes the owner the
 * page's `prs:` gives that repo, else the one the wiki's pages give it
 * ({@link repoOwners}); a bare `#n` is the page's `prs:` entry with that number
 * when exactly one has it, else that number in the one repo `repos:` names. A
 * PR that resolves to no single repo is skipped (`unresolved`).
 *
 * Pure reading ({@link readClaimFacts}) and judging ({@link judgeClaims}) are
 * apart from fetching ({@link checkPageClaims}), so the rules test without a
 * network.
 */

import { maskLineCodeSpans } from "../format/code-spans.ts";
import { parseLedgerTable } from "../format/pr-ledger.ts";
import { stateLineRoles, type HomeKind, type Unit } from "./lint-state.ts";
import { normalizePrRef, parseFrontmatter, readStatusDate, type WikiIndex } from "./store.ts";
import {
  parseRefString,
  prRef,
  prStatesFor,
  type GhCheckDeps,
  type GhState,
  type NotCheckedReason,
  type PrFact,
  type PrRef,
} from "./work-map/gh-check.ts";

/** The day a merge counts on, as the wikis write `status_date`. */
export const CLAIM_DAY_ZONE = "Europe/Oslo";
/** How much of a flagged line the body carries. */
const LINE_TEXT_MAX = 300;

/** Words that say a PR is still open. Matched case-insensitively with Unicode
 *  edges: `\b` finds no boundary before «å». */
const OPEN_WORDS = [
  "open", "draft", "in review", "under review", "awaiting review", "awaits review", "to review",
  "ready to merge", "waiting for merge", "pending merge",
  "åpen", "åpent", "åpne", "utkast", "til review", "i review", "venter på review", "klar til merge", "venter på merge",
];
/** Words that say a PR is not merged: true of a closed PR too. */
const NOT_MERGED_WORDS = ["not merged", "not yet merged", "unmerged", "ikke merget", "ikke merga", "ikke flettet"];

const wordAlt = (ws: readonly string[]) => [...ws].sort((a, b) => b.length - a.length).map((w) => w.replace(/ /g, "\\s+")).join("|");
const WORDS_ALT = wordAlt([...OPEN_WORDS, ...NOT_MERGED_WORDS]);
const NOT_MERGED_RE = new RegExp(`^(?:${wordAlt(NOT_MERGED_WORDS)})$`, "iu");
/** A state word right after a PR: at most four gap characters (space,
 *  emphasis, `,` `:` `(` and dashes), nothing else between. */
const WORD_AFTER_RE = new RegExp(`^[\\s*_,:(–—-]{0,4}(${WORDS_ALT})(?![\\p{L}\\p{N}_])`, "iu");
/** A state word opening a ledger row's state cell, emphasis or a link bracket before it. */
const WORD_OPENS_RE = new RegExp(`^[\\s*_[]*(${WORDS_ALT})(?![\\p{L}\\p{N}_])`, "iu");

type RefShape =
  | { form: "full"; repo: string; n: number }
  | { form: "repo"; name: string; n: number }
  | { form: "bare"; n: number; word: string | null };

interface FoundRef {
  shape: RefShape;
  start: number;
  end: number;
}

const NUM_END = "(?![\\p{L}\\p{N}_])";
const REF_RE = new RegExp(
  [
    // 1 2 3: a markdown link to a pull request; 4: any other markdown link.
    "\\[[^\\[\\]\\n]*\\]\\((?:https?://(?:www\\.)?github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d{1,7})[^()\\s]*|([^()\\s]*))(?:[ \\t]+\"[^\"\\n]*\")?\\)",
    // 5 6 7: a bare pull URL; then any other URL, which names no PR.
    "https?://(?:www\\.)?github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d{1,7})[^\\s)\\]]*",
    "[a-z][a-z0-9+.-]*://[^\\s)\\]]+",
    // 8 9 10: owner/repo#n.
    `(?<![\\p{L}\\p{N}_./-])([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._][A-Za-z0-9._-]*)#(\\d{1,7})${NUM_END}`,
    // 11 12: repo#n, glued.
    `(?<![\\p{L}\\p{N}_./#&-])([a-z0-9][a-z0-9._-]*)#(\\d{1,7})${NUM_END}`,
    // 13: PR #n.
    `(?<![\\p{L}\\p{N}])PR ?#(\\d{1,7})${NUM_END}`,
    // 14: a bare #n.
    `(?<![\\p{L}\\p{N}_&/#.\\]])#(\\d{1,7})${NUM_END}`,
  ].join("|"),
  "gu",
);

/** Every PR reference in a line's text, in order. Inline code and wikilinks are
 *  masked first; a link to anything but a pull request names nothing. */
export function scanRefs(text: string): FoundRef[] {
  const masked = maskLineCodeSpans(text).replace(/\[\[[^\]\n]*\]\]/g, (m) => " ".repeat(m.length));
  const out: FoundRef[] = [];
  for (const m of masked.matchAll(REF_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    let shape: RefShape | null = null;
    if (m[3]) shape = { form: "full", repo: `${m[1]}/${m[2]}`, n: Number(m[3]) };
    else if (m[7]) shape = { form: "full", repo: `${m[5]}/${m[6]}`, n: Number(m[7]) };
    else if (m[10]) shape = { form: "full", repo: `${m[8]}/${m[9]}`, n: Number(m[10]) };
    else if (m[12]) shape = /[a-z]/.test(m[11]!) ? { form: "repo", name: m[11]!, n: Number(m[12]) } : null;
    else if (m[13]) shape = { form: "bare", n: Number(m[13]), word: null };
    else if (m[14]) {
      const before = /([\p{L}\p{N}._-]+)[ \t]$/u.exec(masked.slice(0, start));
      shape = { form: "bare", n: Number(m[14]), word: before ? before[1]! : null };
    }
    if (shape) out.push({ shape, start, end });
  }
  return out;
}

/** Repo name (lower-cased) → its owner over `owner/repo#n` refs, `null` when
 *  two owners share a name. */
export function repoOwners(refs: Iterable<string>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const raw of refs) {
    const ref = parseRefString(raw);
    if (!ref) continue;
    const [owner, name] = ref.repo.split("/") as [string, string];
    const key = name.toLowerCase();
    const had = out.get(key);
    if (had === undefined) out.set(key, owner);
    else if (had !== null && had.toLowerCase() !== owner.toLowerCase()) out.set(key, null);
  }
  return out;
}

/** A frontmatter list as `parseFrontmatter` hands it: an array, or a `[a, b]` string. */
function listOf(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  const t = (v ?? "").trim();
  const inner = /^\[(.*)\]$/.exec(t)?.[1] ?? t;
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

interface PageRefs {
  prs: PrRef[];
  repos: string[];
  owners: ReadonlyMap<string, string | null>;
}

const nameOf = (repo: string) => repo.slice(repo.indexOf("/") + 1).toLowerCase();

/** The owner of a repo given by name: the page's `prs:` first, then the wiki. */
function ownerOf(name: string, page: PageRefs): string | null {
  const key = name.toLowerCase();
  const fromPage = new Set(page.prs.filter((r) => nameOf(r.repo) === key).map((r) => r.repo.slice(0, r.repo.indexOf("/"))));
  if (fromPage.size === 1) return [...fromPage][0]!;
  if (fromPage.size > 1) return null;
  return page.owners.get(key) ?? null;
}

function resolveRef(shape: RefShape, page: PageRefs): PrRef | null {
  if (shape.form === "full") return prRef(shape.repo, shape.n);
  if (shape.form === "repo") {
    const owner = ownerOf(shape.name, page);
    return owner ? prRef(`${owner}/${shape.name}`, shape.n) : null;
  }
  // `muninn #5`, `api #5`: a word naming one of the page's repos, by its name or
  // one `-`-separated token of it (the work map's `repoWordFits` rule), makes it
  // that repo's PR; a word fitting two names none.
  const word = shape.word?.toLowerCase();
  if (word) {
    const names = new Set([...page.repos.map((r) => r.toLowerCase()), ...page.prs.map((r) => nameOf(r.repo))]);
    const fits = [...names].filter((name) => name === word || name.split("-").includes(word));
    if (fits.length > 1) return null;
    if (fits.length === 1) {
      const owner = ownerOf(fits[0]!, page);
      return owner ? prRef(`${owner}/${fits[0]}`, shape.n) : null;
    }
  }
  const same = new Map(page.prs.filter((r) => r.n === shape.n).map((r) => [r.id, r]));
  if (same.size === 1) return [...same.values()][0]!;
  if (same.size > 1 || page.repos.length !== 1) return null;
  const owner = ownerOf(page.repos[0]!, page);
  return owner ? prRef(`${owner}/${page.repos[0]}`, shape.n) : null;
}

/** One home line's claim that a PR is open. */
export interface ClaimFact {
  /** 1-based. */
  line: number;
  home: HomeKind;
  text: string;
  pr: PrRef;
  /** The state word as written. */
  says: string;
  /** A not-merged word: a closed PR does not contradict it. */
  notMerged: boolean;
}

export interface ClaimFacts {
  r1: ClaimFact[];
  /** Lines whose PR, followed by a state word, names no single repo. */
  unresolved: number;
  statusDate: string | null;
  /** The page's frontmatter `prs:`, as PRs. */
  prs: PrRef[];
}

/** A table row's cells, its outer pipes dropped. */
const cellsOf = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** The ledger row at `i`: its own PRs (pull URLs in its first, PR or Landed
 *  cell, `parseLedgerTable`'s rule) and the word opening its state cell. */
function ledgerClaim(lines: readonly string[], i: number): { own: PrRef[]; word: string | null } {
  let top = i;
  while (top > 0 && lines[top - 1]!.trim().startsWith("|")) top--;
  const headers = cellsOf(lines[top]!);
  const ledger = parseLedgerTable(headers, [cellsOf(lines[i]!)], "ledger", { everyRow: true });
  const row = ledger.rows[0];
  const own = (row?.ownPrs ?? []).flatMap((p) => prRef(p.repo, p.n) ?? []);
  const cell = ledger.stateColumn >= 0 ? (row?.cells[ledger.stateColumn] ?? "").replace(/~~[^~]*~~/g, "") : "";
  return { own, word: WORD_OPENS_RE.exec(cell)?.[1] ?? null };
}

/** A unit's text (its lines joined by one space) and the line of an offset. */
function unitText(lines: readonly string[], unit: Unit): { text: string; lineAt: (pos: number) => number } {
  const parts = unit.lines.map((i) => lines[i]!);
  const starts: number[] = [];
  let off = 0;
  for (const p of parts) {
    starts.push(off);
    off += p.length + 1;
  }
  return {
    text: parts.join(" "),
    lineAt: (pos) => {
      let k = 0;
      while (k + 1 < starts.length && starts[k + 1]! <= pos) k++;
      return unit.lines[k]!;
    },
  };
}

const clip = (s: string) => {
  const t = s.trim();
  return t.length > LINE_TEXT_MAX ? `${t.slice(0, LINE_TEXT_MAX - 1)}…` : t;
};

/**
 * What a page's homes and frontmatter say that GitHub can confirm or refute.
 * `owners` maps a repo name to its owner across the wiki ({@link repoOwners}).
 */
export function readClaimFacts(content: string, owners: ReadonlyMap<string, string | null> = new Map()): ClaimFacts {
  const fm = parseFrontmatter(content);
  const prs = [...new Map(listOf(fm.prs).flatMap((raw) => parseRefString(normalizePrRef(raw) ?? "") ?? []).map((r) => [r.id, r])).values()];
  const page: PageRefs = { prs, repos: listOf(fm.repos), owners };
  const roles = stateLineRoles(content);
  const r1: ClaimFact[] = [];
  const seen = new Set<string>();
  let unresolved = 0;
  const add = (line: number, home: HomeKind, pr: PrRef, says: string) => {
    const key = `${line}\0${pr.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    r1.push({ line: line + 1, home, text: clip(roles.lines[line]!), pr, says, notMerged: NOT_MERGED_RE.test(says.replace(/\s+/g, " ")) });
  };
  for (const unit of roles.home) {
    const home = unit.home ?? "status";
    const { text, lineAt } = unitText(roles.lines, unit);
    for (const ref of scanRefs(text)) {
      const word = WORD_AFTER_RE.exec(text.slice(ref.end))?.[1];
      if (!word) continue;
      const pr = resolveRef(ref.shape, page);
      if (pr) add(lineAt(ref.start), home, pr, word);
      else unresolved++;
    }
    if (home === "ledger") {
      const { own, word } = ledgerClaim(roles.lines, unit.lines[0]!);
      if (word) for (const pr of own) add(unit.lines[0]!, home, pr, word);
    }
  }
  return { r1, unresolved, statusDate: readStatusDate(fm.status_date) ?? null, prs };
}

/** Every PR the facts need a state for. */
export function claimRefs(facts: ClaimFacts): PrRef[] {
  return [...new Map([...facts.r1.map((f) => f.pr), ...facts.prs].map((r) => [r.id, r])).values()];
}

export type ClaimNotCheckedReason = NotCheckedReason | "no-state" | "no-lines";

export interface R1Flag {
  line: number;
  home: HomeKind;
  text: string;
  pr: string;
  says: string;
  github: { state: Exclude<GhState, "OPEN">; at: string | null };
}

export type R2Result =
  | { state: "fires" | "clear"; statusDate: string; newest: { pr: string; mergedAt: string } | null }
  /** `disabled`: the whole check was off, so R2 was not read either. */
  | { state: "not-checked"; reason: "no-prs" | "no-status-date" | "no-state" | "disabled" };

/** `GET /api/wiki/claim-check`'s body. */
export interface ClaimCheckBody {
  wiki: string;
  page: string;
  at: number;
  /** Facts whose PR state is known: R1 claims, plus one when R2 could be judged. */
  compared: number;
  /** R1 flags plus one when R2 fires; null when nothing was compared. */
  contradicted: number | null;
  /** Facts whose PR state is not known. */
  unchecked: number;
  unresolved: number;
  r1: R1Flag[];
  r2: R2Result;
  notChecked?: { reason: ClaimNotCheckedReason; repos?: string[] };
  refreshing?: true;
}

/** The calendar day of an instant in `timeZone`. */
function dayIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date(iso));
}

/** The R1 and R2 verdicts over known PR states (`states` by `PrRef.id`). */
export function judgeClaims(
  facts: ClaimFacts,
  states: ReadonlyMap<string, PrFact>,
  timeZone = CLAIM_DAY_ZONE,
): Pick<ClaimCheckBody, "compared" | "contradicted" | "unchecked" | "unresolved" | "r1" | "r2"> & { readable: boolean } {
  let compared = 0;
  let unchecked = 0;
  const r1: R1Flag[] = [];
  for (const f of facts.r1) {
    const gh = states.get(f.pr.id);
    if (!gh) {
      unchecked++;
      continue;
    }
    compared++;
    if (gh.state === "OPEN" || (gh.state === "CLOSED" && f.notMerged)) continue;
    r1.push({
      line: f.line,
      home: f.home,
      text: f.text,
      pr: f.pr.key,
      says: f.says,
      github: { state: gh.state, at: gh.state === "MERGED" ? gh.mergedAt : gh.closedAt },
    });
  }

  let r2: R2Result;
  if (!facts.prs.length) r2 = { state: "not-checked", reason: "no-prs" };
  else if (!facts.statusDate) r2 = { state: "not-checked", reason: "no-status-date" };
  else {
    let newest: { pr: string; mergedAt: string } | null = null;
    let unknown = false;
    for (const ref of facts.prs) {
      const gh = states.get(ref.id);
      if (!gh) unknown = true;
      else if (gh.state === "MERGED" && gh.mergedAt && (!newest || gh.mergedAt > newest.mergedAt)) newest = { pr: ref.key, mergedAt: gh.mergedAt };
    }
    const fires = !!newest && dayIn(newest.mergedAt, timeZone) > facts.statusDate;
    // An unknown PR could be the later merge: only a firing R2 is sure.
    r2 = fires || !unknown ? { state: fires ? "fires" : "clear", statusDate: facts.statusDate, newest } : { state: "not-checked", reason: "no-state" };
  }
  if (r2.state === "not-checked") {
    if (r2.reason === "no-state") unchecked++;
  } else compared++;

  const readable = facts.r1.length > 0 || facts.unresolved > 0 || (r2.state !== "not-checked" || r2.reason === "no-state");
  return {
    compared,
    contradicted: compared > 0 ? r1.length + (r2.state === "fires" ? 1 : 0) : null,
    unchecked,
    unresolved: facts.unresolved,
    r1,
    r2,
    readable,
  };
}

/** The body when the check is off (`WORK_MAP_GH_CHECK=off`, a read-only root): nothing read, nothing asked. */
export function disabledClaimBody(wiki: string, page: string, at: number): ClaimCheckBody {
  return { wiki, page, at, compared: 0, contradicted: null, unchecked: 0, unresolved: 0, r1: [], r2: { state: "not-checked", reason: "disabled" }, notChecked: { reason: "disabled" } };
}

/**
 * The claim check for one page, or null when the wiki has no index or no such
 * page. PR states come from the work map's GitHub check cache
 * ({@link prStatesFor}); the caller has already refused a disabled check.
 */
export async function checkPageClaims(
  input: { wiki: string; root: string; relPath: string },
  deps: GhCheckDeps,
  now: () => number,
  timeZone = CLAIM_DAY_ZONE,
): Promise<ClaimCheckBody | null> {
  const index: WikiIndex | null = await deps.index(input.root);
  const meta = index?.resolveRelPath(input.relPath);
  if (!index || !meta) return null;
  const content = await deps.readBody(index, meta);
  if (content === null) return null;
  const facts = readClaimFacts(content, repoOwners(index.pages.flatMap((p) => p.prRefs ?? [])));
  const refs = claimRefs(facts);
  const fetched = refs.length ? await prStatesFor(input.wiki, refs, deps, now) : { states: new Map<string, PrFact>(), refreshing: false };
  const { readable, ...judged } = judgeClaims(facts, fetched.states, timeZone);
  const body: ClaimCheckBody = { wiki: input.wiki, page: meta.relPath, at: now(), ...judged };
  if (fetched.refreshing) body.refreshing = true;
  if (judged.compared === 0) {
    const failure = "notChecked" in fetched ? fetched.notChecked : undefined;
    body.notChecked = !readable ? { reason: "no-lines" } : failure ? failure : { reason: "no-state" };
  }
  return body;
}
