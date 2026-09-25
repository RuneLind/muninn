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

/** Strongest first. The rail shows the strongest; `stamped` alone renders solid. */
export const RELATION_STRENGTH: readonly IssueRelation[] = [
  "stamped",
  "declared",
  "created",
  "title",
  "stem",
  "link",
  "tag",
  "mention",
];

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
}
