/**
 * The tracker-agnostic model behind the wiki's issue refs.
 *
 * Vocabulary: a **tracker** is a system that holds issues (Jira is the first),
 * an **issue** is one item in it, and an **issue ref** is `{ tracker, key,
 * relations }`, written `tracker:key` the way a session ref is `provider:id`.
 * Code outside one adapter file never names a tracker; it asks the registry
 * (`index.ts`) for the adapter a wiki's `.wiki-reader.json` configured.
 *
 * PURE and dependency-free, so the client bundle may import the relation
 * vocabulary without dragging a server module in.
 */

/**
 * How a page relates to an issue, one value per inference rule. The identifier
 * `created` is rendered "created here".
 */
export type IssueRelation =
  | "stamped"
  | "declared"
  | "created"
  | "title"
  | "stem"
  | "link"
  | "tag"
  | "mention";

/** Strongest first. The rail shows the strongest; `stamped` alone renders solid.
 *  `tag` sits above `link` so a key's strongest relation is a counting one
 *  whenever it has one (see {@link DEMOTED_RELATIONS}). */
export const RELATION_STRENGTH: readonly IssueRelation[] = [
  "stamped",
  "declared",
  "created",
  "title",
  "stem",
  "tag",
  "link",
  "mention",
];

/**
 * The weak tier. A key whose only relations are these stays in the page's full
 * `issues`, but is not a pill, not a facet key and not in a key's page count.
 * `link` is here because a link is as often an epic, a "related" line or a
 * history row as the page's own issue: measured on a real 417-page wiki, `link`
 * was right on ~42 % of its refs and ~23 % of the ones where it stood alone.
 */
export const DEMOTED_RELATIONS: readonly IssueRelation[] = ["link", "mention"];

/** Does a ref with these relations count — carry a pill and a facet key? */
export function relationsCount(relations: readonly string[]): boolean {
  return relations.some((r) => !(DEMOTED_RELATIONS as readonly string[]).includes(r));
}

/**
 * A page's refs as the HOT listing ships them: only a ref that COUNTS
 * (`relationsCount` — something besides `link` and `mention`), with its
 * `mention` relation dropped. Undefined when nothing is left, so the field
 * stays absent rather than `[]`. The rail's pills and the Jira facet read this
 * copy; a link-only or mention-only key is neither.
 */
export function compactIssues(issues: readonly IssueRef[] | undefined): IssueRef[] | undefined {
  if (!issues) return undefined;
  const out: IssueRef[] = [];
  for (const r of issues) {
    if (!relationsCount(r.relations)) continue;
    out.push({ tracker: r.tracker, key: r.key, relations: r.relations.filter((rel) => rel !== "mention") });
  }
  return out.length ? out : undefined;
}

/**
 * The relations through which a page that is a PLAN covers a key. `tag` and
 * `link` are not among them: a plan tagged with a neighbouring key does not
 * plan that key. A `link` or `tag` key the reader Links by hand becomes
 * `stamped`, and so counts from then on.
 */
export const COVERAGE_RELATIONS: readonly IssueRelation[] = ["stamped", "declared", "created", "title", "stem"];

/** The relations **Link all** promotes to `stamped`: the coverage relations
 *  minus `stamped` itself, so Link all never changes a coverage verdict; every
 *  one of them is project-bounded by the inference rules. */
export const LINK_ALL_RELATIONS: readonly IssueRelation[] = COVERAGE_RELATIONS.filter((r) => r !== "stamped");

/** A status mapped to one of five words every tracker can be read in. */
export type StatusCategory = "todo" | "active" | "review" | "done" | "unknown";

export const STATUS_CATEGORIES: readonly StatusCategory[] = ["todo", "active", "review", "done", "unknown"];

/** One issue a page relates to. `relations` is non-empty, deduped and ordered
 *  strongest first, so `relations[0]` is what a one-word surface shows. */
export interface IssueRef {
  tracker: string;
  key: string;
  relations: IssueRelation[];
}

/** One page's tie to a key, as the wiki-wide key map holds it. */
export interface IssueKeyPage {
  relPath: string;
  title: string;
  relations: IssueRelation[];
  /** The page is a plan under this tracker's config — see `isPlanPage`. */
  plan: boolean;
}

/** Every page related to one key, in relPath order. Built once per index. */
export interface IssueKeyEntry {
  tracker: string;
  key: string;
  pages: IssueKeyPage[];
}

/** How a Connections row prices a key through the session ledger. */
export type IssueLedgerView =
  | { state: "priced"; sessions: number; totalCost: number; costedSessions: number; truncated: boolean }
  /** The ledger records mentions only for some projects, so a key outside them
   *  has no cost to report — never "$0". */
  | { state: "not-tracked" }
  /** Not priced this time, and why: past the per-page cap, past the shared
   *  deadline, the ledger did not answer, no ledger configured on this host, or
   *  a demoted key (not priced at all). */
  | { state: "unpriced"; reason: "cap" | "deadline" | "unreachable" | "not-configured" | "demoted" };

/** One key's row in a many-key ledger answer (`/api/jira/keys`). */
export interface KeyLedgerRow {
  /** False: the ledger records no mentions for the key's project. */
  tracked: boolean;
  sessions: number;
  totalCost: number;
  costedSessions: number;
  /** The ledger cut the key's session list at its own per-key cap. */
  truncated: boolean;
  lastSeen: string | null;
}

/** How the board prices a key. Never a total across keys: one session counts
 *  under every key it mentions. */
export type KeyLedgerView =
  | ({ state: "priced" } & Omit<KeyLedgerRow, "tracked">)
  | { state: "not-tracked" }
  /** Not priced, and why: past the shared deadline, the ledger did not answer
   *  (a 404 from a claude-usage without the route included), no ledger is
   *  configured on this host, or the ledger answered with no usable row for
   *  the key (`no-row`). */
  | { state: "unpriced"; reason: "deadline" | "unreachable" | "not-configured" | "no-row" };

/**
 * One Connections row. The index-local half (everything down to `planPages`)
 * rides `GET /api/wiki/page` inline; the deferred provenance payload carries
 * the whole row, the network-joined fields included.
 */
export interface IssueRow {
  tracker: string;
  key: string;
  /** Where a human reads the issue; `""` when the tracker config names no host. */
  url: string;
  /** The frontmatter key a Link writes (`jira`), for the row's refusal copy. */
  field: string;
  /** THIS page's relations to the key, strongest first. */
  relations: IssueRelation[];
  /** Pages whose relations to the key count (`relationsCount`), this one included. */
  pageCount: number;
  /** Plans that cover the key, over every page's relations; empty ⇒ uncovered. */
  planPages: { relPath: string; title: string }[];
  /** The issue's own title, from huginn. Deferred. */
  title?: string;
  /** The tracker's raw status text. Deferred. */
  status?: string;
  /** `status` through the wiki's merged `statusMap`; `unknown` when unmapped or
   *  absent. Deferred — absent on the inline half. */
  category?: StatusCategory;
  /** The issue's epic, when it has one. Deferred. */
  epic?: { key: string; summary?: string };
  /** The tracker's own last-updated stamp, as huginn captured it. Deferred. */
  updated?: string;
  /** huginn holds the issue. Absent when the lookup was not made or degraded. */
  known?: boolean;
  /** The session ledger's figure. Deferred. */
  ledger?: IssueLedgerView;
}

/**
 * One `trackers` entry of `.wiki-reader.json`, validated. Every field is
 * present; a bad field was warned about and replaced by its empty default.
 */
export interface TrackerConfig {
  /** The adapter id (`jira`). */
  id: string;
  /** Project prefixes, uppercase. Bounds EVERY inferred key; never empty (an
   *  entry without a usable project is dropped whole). */
  projects: string[];
  /** Hosts whose `browse/KEY` links count, lowercase. Empty ⇒ the link rule
   *  and the created-here rule never fire. */
  hosts: string[];
  /** Further frontmatter fields that declare keys on this wiki. */
  frontmatterKeys: string[];
  /** Matched against a page title (`iu`) to decide it is a plan. Unused until
   *  plan coverage lands; parsed now so a bad pattern warns at discovery. */
  planTitle: RegExp | null;
  /** A title matching this is never a plan. */
  planTitleExclude: RegExp | null;
  /** Words that, before a link in the same clause, mean the page created the
   *  issue. Compared case-insensitively. */
  createdMarkers: string[];
  /** Raw status → category: the adapter's default with the wiki's entries
   *  merged over it. */
  statusMap: Record<string, StatusCategory>;
  /** Projects the session ledger records mentions for; a key outside them is
   *  "not tracked". The adapter's default unless the wiki names its own. */
  ledgerProjects: string[];
}

/**
 * What an adapter's `inferFrom` reads. The store builds it in its existing read
 * pass, so no file is read twice.
 */
export interface TrackerPage {
  relPath: string;
  /** The filename stem. */
  stem: string;
  /** `html` pages carry only their bounded `<head>` prefix: title, keywords. */
  kind: "markdown" | "html";
  /** Parsed frontmatter, `{}` for html. */
  frontmatter: Record<string, string | string[]>;
  /** The AUTHORED title — the frontmatter `title:` line, or the html
   *  `<title>` element — never a stem fallback. Undefined when absent. */
  authoredTitle: string | undefined;
  tags: string[];
  /** The markdown body after the frontmatter; `""` for html. */
  body: string;
}

export interface TrackerAdapter {
  id: string;
  /** What the UI calls it. */
  label: string;
  /** Anchored shape of one key, after `normalize`. */
  keyPattern: RegExp;
  normalize(raw: string): string;
  /** Every issue the page relates to, relations strongest first. `[]` when
   *  none. */
  inferFrom(page: TrackerPage, config: TrackerConfig): IssueRef[];
  /** Where a human reads the issue. */
  urlFor(key: string, config: TrackerConfig): string;
  /** The frontmatter key a stamp writes. */
  frontmatterKey: string;
  /** The `wiki-stamp` CLI flag that writes it. */
  stampFlag: string;
  defaultStatusMap: Readonly<Record<string, StatusCategory>>;
  /** Projects claude-usage records session mentions for, by default. */
  defaultLedgerProjects: readonly string[];
  /**
   * huginn's facts for every issue it holds, keyed by key, or null when the
   * lookup degraded. Absent ⇒ the tracker has no lookup and rows stay bare.
   */
  lookup?: (knowledgeApiUrl: string) => Promise<Map<string, IssueFacts> | null>;
  /** The claude-usage path that lists the sessions mentioning a key. Absent ⇒
   *  the tracker has no ledger and no row is priced. */
  ledgerPath?: (key: string) => string;
  /** That path's answer as a priced view, or null when it is not one. */
  parseLedger?: (raw: unknown) => Extract<IssueLedgerView, { state: "priced" }> | null;
  /** The claude-usage path that prices up to {@link ledgerKeysMax} keys in one
   *  call. Absent ⇒ the board prices no key of this tracker. */
  ledgerKeysPath?: (keys: readonly string[]) => string;
  /** The most keys one `ledgerKeysPath` call may carry. */
  ledgerKeysMax?: number;
  /** That path's answer, key → row, or null when it is not that shape. */
  parseLedgerKeys?: (raw: unknown) => Map<string, KeyLedgerRow> | null;
  /** A key's project, or null when the string is not a key. */
  projectOf: (key: string) => string | null;
  /** A key exactly as a client sent it (trimmed), normalized, or null when it is
   *  not one — ASCII-shaped before any case fold, and bounded like the
   *  inference rules. The Stamp route's one shape check. */
  parseKey: (raw: string) => string | null;
}

/** What a tracker lookup knows about one issue. */
export interface IssueFacts {
  title?: string;
  status?: string;
  epicLink?: string;
  epicSummary?: string;
  /** The tracker's last-updated stamp, as served (a stray `\:` unescaped). */
  updated?: string;
}
