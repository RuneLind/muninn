/**
 * Knowledge-wiki read side — scans the huginn-jarvis Obsidian wiki on disk and
 * builds an in-memory index: page metadata (frontmatter), outgoing links
 * ([[wikilinks]] + relative markdown links), and inverted backlinks, keyed by
 * relPath. Powers the dashboard `/wiki` reader page.
 *
 * Like `src/summaries/author-scores.ts`, the wiki is a sibling-checkout file
 * dependency: default path `../huginn/huginn-jarvis/data/wiki` relative to the
 * muninn repo root, overridable with `WIKI_DIR`. A missing/unreadable directory
 * degrades to null (one warn, not one per request) — the page then shows an
 * empty state instead of taking the dashboard down.
 */

import path from "node:path";
import { stat } from "node:fs/promises";
import { getLog } from "../logging.ts";
import { sanitizeColorToken } from "../dashboard/views/components/wiki-filter.ts";
import { COMPONENT_TAG_SOURCE } from "../format/markdown-ast.ts";
import { buildWikiGitDates } from "./git-dates.ts";
import { detectBulkRestamps, RESTAMP_MIN_LEAD_DAYS } from "./restamp-detect.ts";

const log = getLog("wiki", "store");

/**
 * A wiki page's type. The reader ships a built-in five-type ontology
 * (source/concept/entity/analysis/note) plus `explainer` for standalone `.html`,
 * but a wiki can introduce its own type strings via an optional `.wiki-reader.json`
 * (`typeMap`/`typeLabels`) — mimir's folders (projects/plans/archive/…) ARE its
 * ontology. So the field is a plain `string`; the values above are just the
 * defaults `typeFromFrontmatter` falls back to and the labels the reader ships.
 */
export type WikiPageType = string;

/**
 * Optional per-wiki type ontology, read from `.wiki-reader.json` at the wiki root.
 * `typeMap` maps a first-path-segment (folder) to a page type; `typeLabels` gives
 * a human label for a (usually custom) type. Both default to `{}` — an absent or
 * malformed file degrades to the built-in five-type behavior (never offline).
 */
export interface WikiReaderConfig {
  typeMap: Record<string, string>;
  typeLabels: Record<string, string>;
}

/**
 * The plan-status lifecycle vocabulary — where a plan page stands.
 *
 * Read from the frontmatter key **`plan_status`**, deliberately NOT the bare
 * `status`: `melosys-kode-wiki` (a registered wiki, mounted via `WIKI_EXTRA`)
 * already carries `status:` on 75 pages with an entirely unrelated vocabulary
 * (`untracked`, `deleted-from-source`, `resolved`, free prose…). Taking `status`
 * would hijack that key and mislabel every one of those pages.
 */
export const PLAN_STATUS_VALUES = [
  "proposed",
  "ready",
  "in-flight",
  "blocked",
  "shipped",
  "superseded",
  "abandoned",
] as const;
export type PlanStatus = (typeof PLAN_STATUS_VALUES)[number];

/** Whether a plan has open follow-ups. Absent ⇒ treated as `none` by consumers. */
export const PLAN_FOLLOWUPS_VALUES = ["open", "none"] as const;
export type PlanFollowups = (typeof PLAN_FOLLOWUPS_VALUES)[number];

/** `status_date` SHAPE gate — an ISO calendar day, nothing looser. Shape only:
 *  it admits `2026-99-99` / `2026-02-31`, which `isCalendarDay` then rejects. */
const STATUS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `raw` is a REAL calendar day, not merely `YYYY-MM-DD`-shaped.
 *
 * The shape gate alone admits `2026-99-99`, `2026-02-31` and `0000-00-00`. That
 * matters downstream: a consumer comparing these for staleness gets
 * `new Date("2026-99-99")` ⇒ `Invalid Date` ⇒ a `NaN` comparator ⇒ a
 * non-deterministic sort, with the aggregated warn below reporting zero drops so
 * nothing points at the offending file. So an impossible day is dropped AND
 * counted here, exactly like any other invalid value.
 *
 * The check is a round-trip: JS rolls out-of-range date parts over (Feb 31 ⇒
 * Mar 3), so a day that comes back out of `Date` unchanged is a day that exists.
 * `setUTCFullYear` rather than the `Date.UTC(y, …)` constructor — the latter
 * remaps years 0–99 onto 1900+y and would reject a legitimate `0099-01-01`.
 */
function isCalendarDay(raw: string): boolean {
  if (!STATUS_DATE_RE.test(raw)) return false;
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * YAML block-scalar indicators. `parseFrontmatter` is line-oriented with no
 * block-scalar support: given `status_note: >` + indented continuation lines it
 * reads the value as the single character `">"` and never looks at the body. A
 * literal `>` / `|` then passes the `typeof === "string"` check and ships to both
 * `/api/wiki/pages` and `/api/wiki/page` as the page's status note. The body is
 * unrecoverable at this layer (the parser dropped those lines), so the honest
 * outcome is to treat the indicator as an absent note rather than to invent one.
 */
const YAML_BLOCK_SCALAR_INDICATORS = new Set([">", "|", ">-", "|-", ">+", "|+"]);

/**
 * Strip a trailing YAML comment (whitespace + `#` + the rest of the line) from a
 * hand-written scalar. Applied to the three VALIDATED plan fields only — they are
 * two enums and an ISO date, none of which can legitimately contain `#`, and the
 * plan authoring contract tells humans to type these keys by hand, so
 * `plan_status: shipped   # already merged` is a realistic authoring shape that
 * would otherwise fail the enum and be dropped.
 *
 * Deliberately NOT applied to `status_note`: a note legitimately says
 * "blocked on #399", and the documented contract for it is "quote the value".
 * That asymmetry is the whole reason this is a helper and not a parser change.
 */
function stripTrailingComment(raw: string): string {
  const i = raw.search(/\s#/);
  return i === -1 ? raw : raw.slice(0, i).trim();
}

/** How many offending relPaths the aggregated warn names before collapsing the
 *  rest into a "+N more" count (precedent: the gardener's `evictedTopics`). */
const PLAN_DROP_SAMPLE_CAP = 5;

/**
 * What fraction of a wiki's pages may be missing from git history — while ALSO not
 * being dirty, i.e. with no innocent explanation — before the index build warns that
 * the git date walk has probably stopped matching `relPath`.
 *
 * 10%. Measured across all four registered wikis at build time: mimir 0/387, jarvis
 * 0/952, capra 0/70, huginn-nav 0/540 — the healthy state is exactly zero, so the
 * headroom is entirely for gitignored-but-indexed pages, not for normal churn. The
 * bug this is sized against (a `core.quotePath` regression) dropped 32% of
 * huginn-nav.
 */
const GIT_DATE_MISS_WARN_RATE = 0.1;

/**
 * Per-index-build tally of frontmatter values REJECTED by the plan-status
 * validators. Aggregated into ONE warn at the end of the build rather than one
 * per page: a backfill writes these fields into ~145 files at once against a
 * 5-minute index TTL, and a per-page warn would flood the log. Counts alone are
 * not actionable on a 385-page wiki, so the tally also carries a capped sample of
 * the offending `relPath`s.
 */
interface PlanFieldDropTally {
  planStatus: number;
  statusDate: number;
  followups: number;
  /** Number of PAGES with at least one drop (≠ `planStatus + …`, which counts
   *  fields — one page can contribute three). Drives the "+N more" tail. */
  pages: number;
  /** First `PLAN_DROP_SAMPLE_CAP` offending relPaths, in read-completion order. */
  samples: string[];
}

/**
 * Parse the four plan-status frontmatter fields, dropping any value that fails
 * its validator so an invalid value NEVER reaches a consumer as-is.
 *
 * Validation is strict (exact enum member / real ISO calendar day) — a lenient
 * `Proposed`, a `2026-7-1`, or an impossible `2026-02-31` is dropped and counted,
 * not silently normalized. `status_note` is free prose with no vocabulary, so it
 * has no validator and can never be a drop; it is emptiness-trimmed, and a bare
 * YAML block-scalar indicator is treated as absent (see
 * `YAML_BLOCK_SCALAR_INDICATORS`).
 *
 * **What `drops` does and does not see.** It counts a field only when
 * `parseFrontmatter` handed us a value for that key. The frontmatter parser skips
 * any line whose value reads as empty (`if (!raw) continue`), so a key written as
 * bare `plan_status:` — or as `plan_status:` followed by a YAML block SEQUENCE,
 * whose `  - shipped` line the key regex doesn't match either — never reaches this
 * function and is indistinguishable from an absent key: **0 drops**. Whereas
 * `plan_status: ""` (an empty QUOTED string) and `plan_status: [shipped]` (an
 * inline array) DO arrive, fail their validator, and count as 1 drop each. So the
 * tally is partly a function of quoting style, not purely of how many fields are
 * broken. Fixing that means changing `parseFrontmatter`, which title/tags/accent
 * share — out of scope here; this docblock is the contract instead.
 */
function parsePlanFields(
  fm: Record<string, string | string[]>,
  relPath: string,
  drops: PlanFieldDropTally,
): Pick<WikiPageMeta, "plan_status" | "status_date" | "followups" | "status_note"> {
  let counted = false;
  const drop = (field: "planStatus" | "statusDate" | "followups") => {
    drops[field]++;
    if (counted) return;
    counted = true;
    drops.pages++;
    if (drops.samples.length < PLAN_DROP_SAMPLE_CAP) drops.samples.push(relPath);
  };
  /** The validated fields' shared read: string-or-nothing, comment-stripped, trimmed. */
  const scalar = (v: string | string[] | undefined) =>
    typeof v === "string" ? stripTrailingComment(v.trim()).trim() : "";

  let plan_status: PlanStatus | undefined;
  if (fm.plan_status !== undefined) {
    const raw = scalar(fm.plan_status);
    if ((PLAN_STATUS_VALUES as readonly string[]).includes(raw)) plan_status = raw as PlanStatus;
    else drop("planStatus");
  }

  let status_date: string | undefined;
  if (fm.status_date !== undefined) {
    const raw = scalar(fm.status_date);
    if (isCalendarDay(raw)) status_date = raw;
    else drop("statusDate");
  }

  let followups: PlanFollowups | undefined;
  if (fm.followups !== undefined) {
    const raw = scalar(fm.followups);
    if ((PLAN_FOLLOWUPS_VALUES as readonly string[]).includes(raw)) {
      followups = raw as PlanFollowups;
    } else drop("followups");
  }

  // NOT comment-stripped (see `stripTrailingComment`) — a note may say "#399".
  const rawNote = typeof fm.status_note === "string" ? fm.status_note.trim() : "";
  const note = YAML_BLOCK_SCALAR_INDICATORS.has(rawNote) ? "" : rawNote;

  return { plan_status, status_date, followups, status_note: note || undefined };
}

export interface WikiPageMeta {
  /** Canonical page name — the filename stem; what [[wikilinks]] resolve against. */
  name: string;
  title: string;
  type: WikiPageType;
  /** Which wiki subtree the page lives in: the root AI wiki or the life/ split. */
  domain: "ai" | "life";
  tags: string[];
  aliases: string[];
  created?: string;
  updated?: string;
  /** External URL for source pages (YouTube video, X article, …). */
  url?: string;
  /**
   * Short prose summary. Explainers sniff it from the head `<meta
   * name="description">`; native blog `.mdx` pages read it from frontmatter
   * `description`; other markdown pages leave it undefined. For explainers it
   * feeds the Similar endpoint's query (blog pages use their full body there);
   * renders as the article subtitle for `type: blog` pages.
   */
  description?: string;
  /**
   * Validated CSS color token from a page's frontmatter `accent` — the article's
   * brand color for `type: blog` pages (tints headings/links/callouts in the
   * reader). Sanitized at parse time via `sanitizeColorToken`: only a strict
   * `#hex` / `rgb()` / `hsl()` token survives; anything else is dropped, so a
   * malformed value never reaches the client's `<style>` sink. Undefined when
   * absent or rejected.
   */
  accent?: string;
  /** Dark-theme counterpart of `accent` (frontmatter `accentDark`), same
   *  sanitization. Undefined ⇒ the light `accent` is used in both themes. */
  accentDark?: string;
  /** Path relative to the wiki root — unique even when stems collide. */
  relPath: string;
  /**
   * File mtime (epoch ms). The only recency signal wikis that carry no
   * frontmatter (mimir, melosys-kode-wiki) have — without it every page there
   * sorts as undated. Undefined when the file couldn't be stat'd.
   */
  mtimeMs?: number;
  /**
   * File birthtime (epoch ms) — when the file was CREATED, as opposed to last
   * touched. The "Recently added" signal for frontmatter-less wikis: a sweep
   * that edits many pages bumps every mtime but leaves birthtimes alone, so
   * genuinely new pages stay distinguishable. Undefined when the file couldn't
   * be stat'd or the filesystem doesn't track birthtime (reported as ≤ 0).
   */
  birthtimeMs?: number;
  /**
   * Creation time from GIT (epoch ms) — the commit that first introduced this path,
   * rename-aware. The durable "Recently added" signal: unlike `birthtimeMs` it
   * survives a `git mv`, a re-clone, and a sweep that rewrites files via
   * temp-file+rename (all three reset birthtime for every file they touch — see
   * `src/wiki/git-dates.ts`). Undefined when the wiki isn't in a git repo, git is
   * unavailable, the walk timed out, or the page is untracked (a brand-new file has
   * no history yet — its birthtime is honest, so nothing is lost).
   *
   * Doubles as the **"git knows this page"** discriminator for the update signal:
   * its presence is what tells `pageTimeMs` that this page's mtime is a checkout
   * artifact rather than its only evidence. Safe because both maps come from one
   * walk and `created` is a superset of `touched` by construction.
   */
  gitCreatedMs?: number;
  /**
   * Last-update time from GIT (epoch ms) — the most recent NON-SWEEP commit to touch
   * this path, rename-aware. The durable "Recently updated" signal: unlike `mtimeMs`
   * it is not moved by a mass edit, which is why mimir's 2026-07-31 backfill made all
   * 148 plans read as edited today. Undefined on the same degrade paths as
   * `gitCreatedMs`, PLUS the real case of a page every one of whose commits was a
   * sweep (19 of mimir's 151 plans) — which `pageTimeMs` folds back onto the creation
   * date rather than treating as undated. See `src/wiki/git-dates.ts`.
   */
  gitTouchedMs?: number;
  /**
   * True when `git status` reports this page dirty (modified / untracked) — the ONLY
   * condition under which its mtime still means something. A clean file's mtime is a
   * checkout or sweep artifact; a dirty file's mtime is an edit git hasn't recorded
   * yet, and is the one signal a purely history-based ranking would lose. Absent
   * (never `false`) otherwise, including on every degrade path.
   */
  gitDirty?: boolean;
  /**
   * Publication date (`YYYY-MM-DD`) parsed from the body's `Source: …, YYYY-MM-DD`
   * line — the day the referenced source was published (distinct from the
   * frontmatter `created`/`updated`, which are when the wiki page was written).
   * Only source-style pages carry a `Source:` line (168/501 jarvis sources);
   * undefined otherwise. Extracted in `buildWikiIndex`'s existing read pass (the
   * body is already in hand) and consumed by the Atlas month-bucketing chain
   * (`pubDate → created → mtime`). See `extractPubDate`.
   */
  pubDate?: string;
  /**
   * First prose line of the body — the Atlas node blurb. The first non-empty line
   * after the frontmatter that is NOT a heading, list item, blockquote, horizontal
   * rule, HTML comment, or the `Source:` line, with `[[wikilinks]]`/`[md](links)`
   * flattened to their display text so no raw markup/YAML leaks into the UI.
   * Extracted in `buildWikiIndex`'s read pass; undefined when the page has no prose
   * line. Explainers carry no `desc` (they take the early return) — the Atlas
   * projection coalesces `desc ?? description` for them. See `extractDesc`.
   */
  desc?: string;
  /**
   * Plan lifecycle state, from the frontmatter key `plan_status` (NOT `status` —
   * see `PLAN_STATUS_VALUES`). Wiki-agnostic among FRONTMATTER pages: any `.md`
   * or `.mdx` page of any wiki may carry it, though in practice only mimir's
   * `plans/` pages do. Standalone `.html` explainers never carry it — they have no
   * frontmatter and take `buildExplainerMeta`'s early return, which never calls
   * `parsePlanFields`. An unrecognized value is dropped at parse time (⇒
   * undefined), never passed through.
   */
  plan_status?: PlanStatus;
  /** When `plan_status` was last affirmed (`YYYY-MM-DD`). A value that isn't that
   *  exact shape — or is that shape but not a real calendar day, e.g. `2026-02-31`
   *  — is dropped at parse time. See `isCalendarDay`. */
  status_date?: string;
  /** Whether the plan has open follow-ups. Absent ⇒ consumers treat it as `none`;
   *  an unrecognized value is dropped at parse time (also ⇒ absent). */
  followups?: PlanFollowups;
  /** One line of free prose qualifying the status. No vocabulary, so nothing to
   *  validate — only an empty value (or a bare YAML block-scalar indicator, whose
   *  body the frontmatter parser never read) is dropped. Deliberately NOT stripped
   *  from `toListing`: `/api/wiki/page` builds its `meta` from the same call, so a
   *  strip would put it out of reach of every client that renders it.
   *
   *  **Unescaped by design** — it reaches `/api/wiki/pages` and `/api/wiki/page`
   *  as the author typed it. No consumer renders it yet; the FIRST one that does
   *  owns the escaping, at its own sink (HTML text vs attribute vs `<style>` want
   *  different escapes, so escaping it here would be both wrong and lossy). */
  status_note?: string;
}

/** One authored step of a curated Atlas trail: a page reference (a wikilink
 *  target — name/alias/path, resolved against the index at projection time) plus
 *  an optional per-step note. The `resolved` flag is added by the Atlas projection,
 *  not stored here. */
export interface WikiTrailStep {
  page: string;
  note?: string;
}

/** A curated Atlas trail — an ordered walk through the wiki. Read from the wiki
 *  root's optional `trails.json` (an array of these) by the TTL-cached index build.
 *  A wiki with no `trails.json` simply has no trails. */
export interface WikiTrail {
  title: string;
  blurb?: string;
  steps: WikiTrailStep[];
}

export interface WikiIndex {
  pages: WikiPageMeta[];
  /**
   * Outgoing link targets per page, keyed by normalized lowercased relPath
   * (`normalizeRelPath`); values are target relPaths in the same form.
   * relPath-keyed (not name-keyed) so same-stem pages in different folders
   * (e.g. mimir's three projects/<x>/architecture.md) keep distinct link sets.
   */
  outgoing: Map<string, string[]>;
  /** Inverted index: relPaths of pages whose content links TO this relPath. */
  backlinks: Map<string, string[]>;
  /** Resolve a wikilink target (name or alias, case-insensitive) to a page. */
  resolve: (target: string) => WikiPageMeta | undefined;
  /** Resolve a relPath (as stored in the graph's keys/values) back to its page. */
  resolveRelPath: (relPath: string) => WikiPageMeta | undefined;
  scannedAt: number;
  root: string;
  /**
   * Parsed `.wiki-reader.json` (per-wiki type ontology) for this root, or null
   * when the wiki has no config file. Optional so hand-built test indexes and
   * older callers stay valid; `buildWikiIndex` always sets it.
   */
  readerConfig?: WikiReaderConfig | null;
  /**
   * Curated Atlas trails parsed from the wiki root's optional `trails.json`, read
   * once per index build (inherits the 5-min TTL). Empty array when the wiki has
   * no trails file or it's malformed. Optional so hand-built test indexes stay
   * valid; `buildWikiIndex` always sets it.
   */
  trails?: WikiTrail[];
}

/** Canonical graph key for a page path: posix-normalized, lowercased relPath. */
export function normalizeRelPath(relPath: string): string {
  return path.posix.normalize(relPath).toLowerCase();
}

/**
 * Stem-collision precedence rank for a page by file extension: `.md` (0) beats
 * `.mdx` (1) beats `.html`/explainer (2). Lower wins. Used to drop the losing
 * page when two DIFFERENT extensions share a stem (a `.md` and a same-stem `.mdx`
 * are one authoring mistake, not two pages).
 */
function extRank(relPath: string): number {
  const l = relPath.toLowerCase();
  if (l.endsWith(".mdx")) return 1;
  if (l.endsWith(".md")) return 0;
  return 2; // .html explainer
}

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REL_PATH = "../huginn/huginn-jarvis/data/wiki";

/**
 * Resolve the wiki root to scan. An explicit `root` (a bot's configured
 * `wikiDir`) wins; otherwise fall back to today's behavior — the `WIKI_DIR` env
 * override, then the jarvis default. So a bare `/wiki` (no `?bot=`) is unchanged.
 */
function resolveWikiRoot(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const override = process.env.WIKI_DIR;
  if (override && override.trim()) return override.trim();
  // import.meta.dir = <root>/src/wiki → repo root is two levels up.
  const repoRoot = path.resolve(import.meta.dir, "../../");
  return path.resolve(repoRoot, DEFAULT_REL_PATH);
}

/**
 * Parse the flat YAML-subset frontmatter used by the wiki (scalars, quoted
 * strings, and single-line inline arrays). Returns {} when the file has no
 * leading `---` fence. Not a general YAML parser — the wiki's generator only
 * ever emits this shape.
 */
export function parseFrontmatter(content: string): Record<string, string | string[]> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const body = content.slice(content.indexOf("\n") + 1, end);

  const out: Record<string, string | string[]> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const raw = m[2]!.trim();
    if (!raw) continue;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      out[key] = splitInlineArray(raw.slice(1, -1));
    } else {
      out[key] = unquote(raw);
    }
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split an inline-array body on top-level commas, honoring quoted strings. */
export function splitInlineArray(body: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      if (current.trim()) items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/**
 * Extract deduped [[wikilink]] targets from raw file content (frontmatter
 * included). Obsidian-style `#anchor` fragments are stripped — `[[Page#Section]]`
 * targets the page (mirroring extractMarkdownLinks' anchor handling), and a bare
 * `[[#anchor]]` is a same-page reference, not a link. Backslash escapes that
 * markdown processors leave in the raw text (e.g. `Page\` from an escaped `\]]`)
 * are dropped so the target matches the page name it refers to.
 */
export function extractWikilinks(content: string): string[] {
  const targets = new Set<string>();
  for (const m of content.matchAll(WIKILINK_RE)) {
    let target = m[1]!.replace(/\\/g, "").trim();
    const hash = target.indexOf("#");
    if (hash === 0) continue; // bare [[#anchor]] — same-page, not a link
    if (hash > 0) target = target.slice(0, hash).trim();
    if (target) targets.add(target);
  }
  return [...targets];
}

const MD_LINK_RE = /(!?)\[(?:[^\]]*)\]\(([^)]+)\)/g;

/**
 * Extract relative markdown link targets — `[text](target.md)`,
 * `[text](target.mdx)`, or `[text](target.html)` — from raw page content. Wikis
 * that use plain relative links instead of Obsidian [[wikilinks]] (e.g. mimir,
 * melosys-kode-wiki) join the same link graph through these, native `.mdx` pages
 * are first-class link targets, and relative `.html` links let markdown pages
 * backlink standalone explainers. Returns deduped, URL-decoded targets ending in
 * `.md`, `.mdx`, or `.html` (case-insensitive), with any `#anchor` fragment
 * stripped, still *relative to the linking page* (resolution happens in
 * `resolveMarkdownTargets`). Skips: images (`![...](...)`), absolute URLs / any
 * `scheme:` target (http:, https:, mailto:, …), absolute filesystem paths
 * (leading `/`), and targets that are neither `.md` nor `.html`. Like
 * `extractWikilinks`, this does not special-case fenced code blocks — matching
 * that function's behavior.
 */
export function extractMarkdownLinks(content: string): string[] {
  const targets = new Set<string>();
  for (const m of content.matchAll(MD_LINK_RE)) {
    if (m[1]) continue; // leading '!' → image, not a link
    let target = (m[2] ?? "").trim();
    if (!target) continue;
    // Drop a link title: [text](url "title") → url
    const sp = target.search(/\s/);
    if (sp !== -1) target = target.slice(0, sp);
    // Strip an #anchor fragment; a bare same-page anchor (#foo) isn't a page link.
    const hash = target.indexOf("#");
    if (hash === 0) continue;
    if (hash > 0) target = target.slice(0, hash);
    if (!target) continue;
    // Ignore absolute URLs / any scheme: prefix and absolute filesystem paths.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
    if (target.startsWith("/")) continue;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // Malformed %-escape — keep the raw form so a real .md link isn't lost.
    }
    const lower = decoded.toLowerCase();
    if (!lower.endsWith(".md") && !lower.endsWith(".mdx") && !lower.endsWith(".html")) continue;
    targets.add(decoded);
  }
  return [...targets];
}

/**
 * Resolve extracted relative `.md`/`.html` targets against the linking page's own
 * location within the wiki, returning normalized, lowercased target relPaths
 * that stay inside the wiki root. Targets that escape the root via `../` are
 * dropped. Lowercasing mirrors the case-insensitive `resolve()` used for the
 * wikilink graph so both link kinds match pages the same way.
 */
function resolveMarkdownTargets(fromRelPath: string, targets: string[]): string[] {
  const dir = path.posix.dirname(fromRelPath);
  const out: string[] = [];
  for (const t of targets) {
    const joined = path.posix.normalize(path.posix.join(dir, t));
    if (joined === ".." || joined.startsWith("../")) continue; // escaped the root
    out.push(normalizeRelPath(joined));
  }
  return out;
}

/**
 * The body content after the frontmatter fence. Mirrors `parseFrontmatter`'s
 * fence detection: a leading `---` with a closing `\n---`; the body starts on the
 * line after the closing fence. Returns the whole content when there is no fence.
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  // `end` points at the `\n` before the closing `---`; skip to the newline that
  // ends the closing fence line, and the body is everything after it.
  const afterFence = content.indexOf("\n", end + 1);
  return afterFence === -1 ? "" : content.slice(afterFence + 1);
}

/**
 * Flatten a prose line into genuinely plain text for the Atlas blurb:
 * `[[Target|Display]]`→`Display`, `[[Target]]`→`Target`, images `![alt](url)`→`alt`
 * (dropping the leading `!`), links `[text](url)`→`text`, and inline emphasis/code
 * markers (`**`, `__`, backticks, and boundary `*`/`_`) removed. A simple
 * markers-removal pass — not a markdown parser — so interior underscores in
 * `some_var_name` are left alone (they're never at a word boundary).
 */
function flattenLinks(s: string): string {
  return s
    .replace(/\[\[([^\]]+?)\]\]/g, (_m, inner: string) => inner.split("|").pop()!.trim())
    // Images `![alt](url)` → alt (drop the leading `!`); links `[text](url)` → text.
    .replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, (_m, text: string) => text.trim())
    // Strip bold/code markers, then leading/trailing (wrapping) `*`/`_` emphasis.
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)[*_]+/g, "$1")
    .replace(/[*_]+(\s|$)/g, "$1");
}

/** Whitelisted component tags (open/close/self-closing) on ONE line, derived from
 *  the shared markdown-AST source of truth — the same strip `src/wiki/similar.ts`
 *  applies to its search query. Compiled here rather than imported from
 *  `similar.ts` because that module imports this one (the read side), and the
 *  cycle would be a layering inversion for a two-line helper. */
const COMPONENT_TAG_RE = new RegExp(COMPONENT_TAG_SOURCE, "g");

/** Remove whitelisted component tags from a line, leaving their inner prose. */
function stripComponentTags(line: string): string {
  return line.replace(COMPONENT_TAG_RE, "");
}

const SOURCE_PUBDATE_RE = /^Source:.*?(\d{4}-\d{2}-\d{2})/m;

/**
 * Publication date (`YYYY-MM-DD`) from a source page's body `Source: …,
 * YYYY-MM-DD` line (e.g. `Source: YouTube, 2026-03-25 — https://…`). Undefined
 * when the page has no such line. Scans the raw content — the `Source:` line lives
 * in the body, never the frontmatter, and `^…/m` anchors it to a line start.
 */
export function extractPubDate(content: string): string | undefined {
  const m = content.match(SOURCE_PUBDATE_RE);
  return m ? m[1] : undefined;
}

/**
 * First prose line of a page — the Atlas node blurb. Skips the frontmatter, then
 * the first non-empty line that is not a heading (`#`), list item (`-`/`*`/`+`/
 * `1.`), blockquote/callout (`>`), horizontal rule (`---`/`***`/`___`), HTML
 * comment or JSX/HTML component tag (`<…`), markdown table row (`|…`), a
 * `Source:` line, or a `URL:`/`Date:`/`Updated:`/`Created:`/`Tags:` metadata line
 * (real source pages lead with a bare `URL: https://…` above the prose).
 * `[[wikilinks]]`/`[md](links)` are flattened to display text and inline emphasis
 * markers stripped so no raw markup or leaked YAML reaches the UI. Undefined when
 * the page has no qualifying prose line.
 */
export function extractDesc(content: string): string | undefined {
  const body = stripFrontmatter(content);
  for (const raw of body.split("\n")) {
    // Component tags go FIRST, before the line-shape checks: a paragraph opening
    // with `<Fact n="1" v="ok">…` is prose, not markup, and the `startsWith("<")`
    // skip below would otherwise drop it and blurb the NEXT paragraph — while a
    // mid-line `<Fact …>` would leak literal JSX into the Atlas node blurb.
    const line = stripComponentTags(raw.trim()).trim();
    if (!line) continue;
    if (line.startsWith("#")) continue; // heading
    if (line.startsWith(">")) continue; // blockquote / callout
    if (line.startsWith("<")) continue; // html comment OR a JSX/HTML component tag
    if (line.startsWith("|")) continue; // markdown table row
    if (/^Source:/.test(line)) continue; // the source-attribution line
    if (/^(URL|Date|Updated|Created|Tags):/.test(line)) continue; // metadata line, not prose
    if (/^[-*+]\s/.test(line)) continue; // bullet list
    if (/^\d+[.)]\s/.test(line)) continue; // ordered list
    if (/^([-*_])\1{2,}$/.test(line)) continue; // horizontal rule
    const flat = flattenLinks(line).trim();
    if (flat) return flat;
  }
  return undefined;
}

const VALID_TYPES: string[] = ["source", "concept", "entity", "analysis", "note"];

const WIKI_READER_CONFIG_FILE = ".wiki-reader.json";

/** True when `v` is a flat object whose every value is a string. */
function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

/**
 * Read the optional `<root>/.wiki-reader.json` per-wiki type ontology. Absent ⇒
 * null (the common case — the wiki uses the built-in five types). Malformed JSON,
 * or a `typeMap`/`typeLabels` that isn't a string map, degrades to a config with
 * only the valid halves kept (warned once per index build) — never takes the wiki
 * offline, the same philosophy as bot-config validation. Read once per index
 * build, so it inherits the index's 5-min TTL.
 */
async function readWikiReaderConfig(root: string): Promise<WikiReaderConfig | null> {
  const abs = path.join(root, WIKI_READER_CONFIG_FILE);
  let text: string;
  try {
    text = await Bun.file(abs).text();
  } catch {
    return null; // no config file — not an error, the standard case
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn("{file} at {root} is not valid JSON — ignoring: {error}", {
      file: WIKI_READER_CONFIG_FILE,
      root,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  if (obj.typeMap !== undefined && !isStringRecord(obj.typeMap)) {
    log.warn("{file} at {root}: typeMap is not a string→string map — ignoring it", {
      file: WIKI_READER_CONFIG_FILE,
      root,
    });
  }
  if (obj.typeLabels !== undefined && !isStringRecord(obj.typeLabels)) {
    log.warn("{file} at {root}: typeLabels is not a string→string map — ignoring it", {
      file: WIKI_READER_CONFIG_FILE,
      root,
    });
  }
  return {
    typeMap: isStringRecord(obj.typeMap) ? obj.typeMap : {},
    typeLabels: isStringRecord(obj.typeLabels) ? obj.typeLabels : {},
  };
}

const WIKI_TRAILS_FILE = "trails.json";

/**
 * Read the optional `<root>/trails.json` — an array of curated Atlas trails
 * (`{title, blurb?, steps: [{page, note?}]}`). A sibling read next to
 * `.wiki-reader.json`, so it inherits the index's 5-min TTL. Absent ⇒ `[]` (the
 * common case). Malformed JSON, a non-array root, or individual entries/steps that
 * don't match the shape degrade gracefully (warned once per build) — a bad trails
 * file never takes the wiki offline, the same philosophy as bot-config validation.
 * Entries missing a `title` or steps missing a `page` are dropped; unresolvable
 * page references are NOT dropped here (the projection flags them `resolved: false`).
 */
async function readWikiTrails(root: string): Promise<WikiTrail[]> {
  const abs = path.join(root, WIKI_TRAILS_FILE);
  let text: string;
  try {
    text = await Bun.file(abs).text();
  } catch {
    return []; // no trails file — not an error, the standard case
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn("{file} at {root} is not valid JSON — ignoring: {error}", {
      file: WIKI_TRAILS_FILE,
      root,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.warn("{file} at {root}: expected a JSON array of trails — ignoring", {
      file: WIKI_TRAILS_FILE,
      root,
    });
    return [];
  }
  const trails: WikiTrail[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    if (!title) continue; // a trail with no title is unusable
    const blurb = typeof obj.blurb === "string" ? obj.blurb : undefined;
    const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
    const steps: WikiTrailStep[] = [];
    for (const s of rawSteps) {
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const so = s as Record<string, unknown>;
      const page = typeof so.page === "string" ? so.page.trim() : "";
      if (!page) continue; // a step with no page reference is unusable
      const note = typeof so.note === "string" ? so.note : undefined;
      steps.push({ page, note });
    }
    trails.push({ title, blurb, steps });
  }
  return trails;
}

/**
 * Resolve a page's type. Order: an explicit frontmatter `type:` (valid if it's one
 * of the five standard types, the `analyses` alias, or a value the wiki declares in
 * its `.wiki-reader.json` typeMap/typeLabels) → a typeMap lookup on the first path
 * segment (after stripping `life/`) → the built-in standard-folder fallback → `note`.
 * `.html` explainers are hardcoded `explainer` in `buildExplainerMeta`, never here.
 */
function typeFromFrontmatter(
  fm: Record<string, string | string[]>,
  relPath: string,
  config: WikiReaderConfig | null,
): WikiPageType {
  const raw = typeof fm.type === "string" ? fm.type : "";
  if (VALID_TYPES.includes(raw)) return raw;
  if (raw === "analyses") return "analysis";
  // An explicit frontmatter type the wiki itself declares (a typeMap target or a
  // labeled custom type) is honored as authored.
  if (
    raw &&
    config &&
    (Object.values(config.typeMap).includes(raw) ||
      Object.prototype.hasOwnProperty.call(config.typeLabels, raw))
  ) {
    return raw;
  }
  // Fall back to the folder the page lives in — first the wiki's own typeMap…
  const folder = relPath.replace(/^life\//, "").split("/")[0] ?? "";
  // Own-key guard: a folder named e.g. `constructor` must not read the prototype.
  if (config && Object.prototype.hasOwnProperty.call(config.typeMap, folder) && config.typeMap[folder]) {
    return config.typeMap[folder]!;
  }
  // …then the built-in standard folder names.
  if (folder === "sources") return "source";
  if (folder === "concepts") return "concept";
  if (folder === "entities") return "entity";
  if (folder === "analyses") return "analysis";
  return "note";
}

function asStringArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v) return [v];
  return [];
}

/** Bounded prefix (bytes) read from an .html explainer to sniff its <title>. */
const HTML_TITLE_SNIFF_BYTES = 4096;
const HTML_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/**
 * Marker the MDX explainer pipeline stamps at the very top of every compiled
 * `.html` (see mimir `scripts/mdx-explainer/build.ts`: `<!-- generated from
 * blogs/src/<slug>.mdx … -->`). Used to positively identify a compiled sibling
 * when deciding whether a same-stem `.mdx` is a pipeline SOURCE (below).
 */
const GENERATED_HTML_MARKER = "<!-- generated from";
const GENERATED_MARKER_SNIFF_BYTES = 512;

/**
 * A `.mdx` is a compile-pipeline SOURCE (not a wiki page) when it sits at
 * `<dir>/src/<stem>.mdx` AND a compiled sibling explainer `<dir>/<stem>.html`
 * exists carrying the generated marker — mimir's documented pipeline: "Source
 * lives at blogs/src/<slug>.mdx" compiled to `blogs/<slug>.html`. Returns the
 * sibling html's relPath to verify, or null when the path isn't shaped like a
 * source (immediate parent segment must be `src`).
 *
 * Chosen over a bare path-segment rule (skip anything under a `src/` dir) because
 * it is surgical: it only fires when a compiled twin genuinely exists, so a stray
 * or hand-authored `.mdx` — even one placed under a `src/` folder — stays a
 * first-class native page rather than silently vanishing. The marker check rules
 * out a coincidental same-stem `.html` that wasn't produced by the pipeline.
 */
function pipelineSourceSiblingHtml(relPath: string): string | null {
  if (!relPath.toLowerCase().endsWith(".mdx")) return null;
  const segs = relPath.split("/");
  if (segs.length < 2) return null;
  const file = segs[segs.length - 1]!;
  const parent = segs[segs.length - 2]!;
  if (parent.toLowerCase() !== "src") return null;
  const stemHtml = file.replace(/\.mdx$/i, ".html");
  // Drop the `src` segment: <…>/src/<stem>.mdx → <…>/<stem>.html
  return [...segs.slice(0, segs.length - 2), stemHtml].join("/");
}

/** Every `<meta …>` tag in a prefix. Tolerates attribute order — attributes are
 *  read out of the matched tag by name, not by position. `[^>]*` naturally caps
 *  a tag with an unclosed quote at the next `>` so its attrs fail to parse (the
 *  tag is silently ignored) rather than swallowing the rest of the document. */
const META_TAG_RE = /<meta\b[^>]*>/gi;

/** Read one attribute's value out of a single tag string. Case-insensitive on
 *  the attribute name; accepts single or double quotes; requires a closing quote
 *  (an unclosed quote ⇒ undefined). */
function metaAttr(tag: string, attr: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2]) : undefined;
}

/**
 * Sniff the `content` of the first `<meta name="…">` matching `name` from a raw
 * HTML prefix. Order-tolerant (`content` may precede `name`), quote- and
 * case-insensitive, and does NOT require a `<head>` (headless fragments and meta
 * prepended above `<title>` both work). Returns the trimmed content, or
 * undefined when the tag is absent, malformed, or has empty content.
 */
function sniffMetaContent(prefix: string, name: string): string | undefined {
  const tags = prefix.match(META_TAG_RE);
  if (!tags) return undefined;
  for (const tag of tags) {
    if (metaAttr(tag, "name")?.toLowerCase() === name) {
      const content = metaAttr(tag, "content")?.trim();
      if (content) return content;
    }
  }
  return undefined;
}

/** Normalize a `<meta name="keywords">` list into wiki tags — split on comma,
 *  trim, lowercase, spaces→hyphens (the same shape the markdown tagger produces),
 *  dropping empties. */
function explainerKeywordTags(content: string): string[] {
  return content
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter((t) => t.length > 0);
}

/** File mtime + birthtime in epoch ms; both undefined when the file can't be
 *  stat'd. Birthtime alone is also undefined on filesystems that don't track it
 *  (stat reports it as 0 or negative there). */
async function fileStatTimes(
  abs: string,
): Promise<{ mtimeMs?: number; birthtimeMs?: number }> {
  try {
    const s = await stat(abs);
    return { mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs > 0 ? s.birthtimeMs : undefined };
  } catch {
    return {};
  }
}

/**
 * Build metadata for a standalone HTML explainer. Unlike markdown pages these
 * carry no frontmatter and don't join the wikilink graph — title comes from the
 * file's <title> (sniffed from a bounded prefix) or the filename stem, and the
 * created/updated dates are the file's mtime (yyyy-mm-dd). Returns null when the
 * file is unreadable so the rest of the wiki stays browsable.
 */
async function buildExplainerMeta(root: string, relPath: string): Promise<WikiPageMeta | null> {
  const abs = path.join(root, relPath);
  const stem = path.basename(relPath, ".html");
  let title = stem;
  let tags: string[] = [];
  let description: string | undefined;
  try {
    const prefix = await Bun.file(abs).slice(0, HTML_TITLE_SNIFF_BYTES).text();
    const m = prefix.match(HTML_TITLE_RE);
    if (m && m[1]!.trim()) title = m[1]!.trim();
    // Same bounded prefix also feeds the tags + description sniff (explainers
    // carry no frontmatter — the <head> meta is all we have).
    const keywords = sniffMetaContent(prefix, "keywords");
    if (keywords) tags = explainerKeywordTags(keywords);
    description = sniffMetaContent(prefix, "description");
  } catch {
    return null; // unreadable — skip, keep the rest of the wiki browsable
  }
  const { mtimeMs, birthtimeMs } = await fileStatTimes(abs);
  const date = mtimeMs === undefined ? undefined : new Date(mtimeMs).toISOString().slice(0, 10);
  return {
    name: stem,
    title,
    type: "explainer",
    domain: relPath.startsWith("life/") ? "life" : "ai",
    tags,
    aliases: [],
    created: date,
    updated: date,
    description,
    relPath,
    mtimeMs,
    birthtimeMs,
  };
}

/**
 * Build the index by scanning every .md, .mdx, and .html file under the wiki
 * root (dot-dirs like .obsidian excluded). ~700 small files — a full scan is
 * well under a second, and results are TTL-cached, so no incremental tracking is
 * needed. Markdown pages (.md and native .mdx) carry frontmatter + [[wikilinks]]
 * and join the link graph; standalone HTML explainers do not (title/mtime only,
 * no backlinks).
 */
export async function buildWikiIndex(root: string): Promise<WikiIndex> {
  const glob = new Bun.Glob("**/*.{md,mdx,html}");
  let relPaths: string[] = [];
  for await (const p of glob.scan({ cwd: root, dot: false })) {
    // Bun.Glob's dot:false skips dot FILES but still descends dot DIRS on some
    // versions — filter path segments explicitly. node_modules can appear inside
    // a wiki root (e.g. mimir's scripts/mdx-explainer/) and would flood the index
    // with dependency READMEs/CHANGELOGs.
    if (p.split("/").some((seg) => seg.startsWith(".") || seg === "node_modules")) continue;
    relPaths.push(p);
  }
  relPaths.sort();

  // Exclude MDX compile-pipeline SOURCES before discovery. A source at
  // `blogs/src/<slug>.mdx` shares its bare stem with the compiled explainer at
  // `blogs/<slug>.html`; because stem-collision precedence ranks `.mdx` (1) above
  // `.html` (2) globally across dirs, discovering the source as a native page
  // would SHADOW the compiled explainer the reader is meant to serve — dropping it
  // from pages/byKey/byRelPath and stripping all its backlinks. Skip the source so
  // the explainer survives. This is expected pipeline shape, not an authoring
  // mistake, so it's logged at debug (unlike the same-dir precedence warn below).
  const scannedSet = new Set(relPaths.map((p) => p.toLowerCase()));
  const isPipelineSource = await Promise.all(
    relPaths.map(async (relPath) => {
      const siblingHtml = pipelineSourceSiblingHtml(relPath);
      if (!siblingHtml || !scannedSet.has(siblingHtml.toLowerCase())) return false;
      try {
        const head = await Bun.file(path.join(root, siblingHtml))
          .slice(0, GENERATED_MARKER_SNIFF_BYTES)
          .text();
        if (!head.includes(GENERATED_HTML_MARKER)) return false;
      } catch {
        return false; // unreadable sibling — treat the .mdx as a normal page
      }
      log.debug("wiki compile-pipeline source {relPath} excluded (compiled sibling {sibling})", {
        relPath,
        sibling: siblingHtml,
      });
      return true;
    }),
  );
  relPaths = relPaths.filter((_, i) => !isPipelineSource[i]);

  // Per-wiki type ontology — read once per build (inherits the index TTL). Absent
  // or malformed ⇒ null (built-in five-type behavior). `.wiki-reader.json` is not
  // an .md/.html page, so it's already outside the page glob above.
  const readerConfig = await readWikiReaderConfig(root);
  // Curated Atlas trails — a sibling read next to `.wiki-reader.json`, same TTL.
  const trails = await readWikiTrails(root);

  const pages: WikiPageMeta[] = [];
  // Build-scoped tally for the ONE aggregated plan-status warn below. Mutated from
  // inside the concurrent read pass — safe, since JS runs it single-threaded.
  const planDrops: PlanFieldDropTally = {
    planStatus: 0,
    statusDate: 0,
    followups: 0,
    pages: 0,
    samples: [],
  };
  const byKey = new Map<string, WikiPageMeta>();
  const rawOutgoing = new Map<string, string[]>();
  /** Per-page resolved relative-markdown-link targets (normalized relPaths). */
  const rawMdTargets = new Map<string, string[]>();

  // Git date signals — ONE `git log` walk (plus a cheap concurrent `git status`) per
  // index build, inheriting the 5-min TTL, kicked off here so it overlaps the
  // ~700-file read pass below instead of adding its latency to it. Never rejects;
  // null ⇒ pages keep exactly the pre-existing frontmatter+mtime+birthtime behavior.
  const gitDatesPromise = buildWikiGitDates(root);

  const register = (key: string, meta: WikiPageMeta) => {
    const k = key.toLowerCase();
    if (!byKey.has(k)) byKey.set(k, meta);
  };

  await Promise.all(
    relPaths.map(async (relPath) => {
      if (relPath.endsWith(".html")) {
        const meta = await buildExplainerMeta(root, relPath);
        if (meta) {
          pages.push(meta);
          rawOutgoing.set(relPath, []); // explainers don't join the link graph
        }
        return;
      }
      const abs = path.join(root, relPath);
      let content: string;
      let times: { mtimeMs?: number; birthtimeMs?: number };
      try {
        // One round-trip per file: the stat never rejects (it degrades to
        // undefined), so a throw here is always the unreadable-file case.
        [content, times] = await Promise.all([Bun.file(abs).text(), fileStatTimes(abs)]);
      } catch {
        return; // unreadable file — skip, keep the rest of the wiki browsable
      }
      // NB (pre-existing, wider than the plan fields): `parseFrontmatter`'s
      // line regex ends in `(.*)$`, which does not match a trailing `\r`, so a
      // CRLF-line-ending page parses to `{}` and loses title/tags/type/accent
      // along with the plan fields. Not fixed here — it belongs with the parser.
      const fm = parseFrontmatter(content);
      // Native `.mdx` pages take the same branch as `.md` — same frontmatter,
      // same wikilink extraction, same graph membership. The only difference is
      // the extension stripped off the stem.
      const name = path.basename(relPath).replace(/\.mdx?$/i, "");
      const meta: WikiPageMeta = {
        name,
        title: typeof fm.title === "string" && fm.title ? fm.title : name,
        type: typeFromFrontmatter(fm, relPath, readerConfig),
        domain: relPath.startsWith("life/") ? "life" : "ai",
        tags: asStringArray(fm.tags),
        aliases: asStringArray(fm.aliases),
        created: typeof fm.created === "string" ? fm.created : undefined,
        updated: typeof fm.updated === "string" ? fm.updated : undefined,
        url: typeof fm.url === "string" ? fm.url : undefined,
        // Native blog `.mdx` pages carry these; `.md` pages that don't declare
        // them stay undefined (unchanged). `accent`/`accentDark` are user text
        // bound for a `<style>` sink — sanitized to a strict color token here so a
        // malformed value is dropped at the source, never at the DOM.
        description: typeof fm.description === "string" ? fm.description : undefined,
        accent: sanitizeColorToken(fm.accent),
        accentDark: sanitizeColorToken(fm.accentDark),
        relPath,
        mtimeMs: times.mtimeMs,
        birthtimeMs: times.birthtimeMs,
        // Atlas fields — computed here where the body is already in hand (paid once
        // per index build, inheriting the 5-min TTL) rather than re-reading ~800
        // files per uncached Atlas request. Both undefined for pages that lack them.
        pubDate: extractPubDate(content),
        desc: extractDesc(content),
        // Plan lifecycle fields. Wiki-agnostic (any page may declare them) and
        // strictly validated — an invalid value is dropped here and only ever
        // surfaces as a count in the aggregated warn below.
        ...parsePlanFields(fm, relPath, planDrops),
      };
      pages.push(meta);
      rawOutgoing.set(relPath, extractWikilinks(content).filter((t) => t !== name));
      rawMdTargets.set(relPath, resolveMarkdownTargets(relPath, extractMarkdownLinks(content)));
    }),
  );

  // Stamp git date signals. Done as a post-pass rather than inside the concurrent
  // read above so the walk overlaps ALL the file reads rather than blocking the
  // first one; keyed on the raw relPath, which is exactly what the walk emits
  // (posix, wiki-relative) — no normalization, so a case-only difference simply
  // misses and the page keeps its filesystem timestamps.
  const gitDates = await gitDatesPromise;
  if (gitDates) {
    let createdHits = 0;
    let touchedHits = 0;
    let unexplained = 0;
    for (const meta of pages) {
      const c = gitDates.created.get(meta.relPath);
      if (c !== undefined) {
        meta.gitCreatedMs = c;
        createdHits++;
      }
      const t = gitDates.touched.get(meta.relPath);
      if (t !== undefined) {
        meta.gitTouchedMs = t;
        touchedHits++;
      }
      if (gitDates.dirty.has(meta.relPath)) meta.gitDirty = true;
      // A page git has never heard of is either genuinely new — and then the DIRTY
      // probe knows it, since `git status` lists untracked files — or the walk's keys
      // stopped lining up with `relPath`. Only the second is a bug, and pairing the
      // two signals is what separates them.
      if (c === undefined && !meta.gitDirty) unexplained++;
    }
    // Warn on an unexpected RATE, never on "zero hits". PR A shipped a zero-gated
    // guard here and it was blind by construction to the bug it was written for: a
    // `core.quotePath` regression dropped 32% of huginn-nav's pages (every non-ASCII
    // name) while the ASCII majority kept the hit count comfortably above zero.
    // Partial loss is the LIKELIER shape whenever the cause is an encoding or
    // path-spelling rule, so the alarm has to be sized for partial.
    //
    // Gated on a non-empty map: a successful walk over a subtree with no tracked
    // pages (a gitignored wiki dir, or one added but never committed) returns an
    // empty map, not null, and would otherwise fire ~288×/day per wiki pointing at a
    // key-mismatch bug that doesn't exist. `git-dates.ts` owns the complementary warn
    // for "git had paths but none survived the subtree strip".
    if (
      gitDates.created.size > 0 &&
      pages.length > 0 &&
      unexplained / pages.length > GIT_DATE_MISS_WARN_RATE
    ) {
      log.warn(
        "wiki {root}: {unexplained} of {total} pages have no git history and are not " +
          "dirty — the walk's keys may have stopped matching relPath, silently " +
          "reinstating filesystem-timestamp ranking",
        { root, unexplained, total: pages.length },
      );
    } else if (createdHits > 0 && touchedHits === 0) {
      // The `touched` axis needs its OWN guard: the check above measures creation
      // coverage only, so a regression that emptied the touch map (a broken rename
      // rule, `SWEEP_THRESHOLD` slipping to 1) would leave every page silently
      // falling back to its creation date with the creation alarm perfectly quiet.
      //
      // Zero-gated ON PURPOSE, and the reasoning is the opposite of the rate rule
      // above rather than an exception to it: the healthy touch rate spans 23%
      // (jarvis, bulk-ingested) to 100%, so no threshold separates healthy from
      // broken. Zero is the only value that does — a wiki with a git history and not
      // one ordinary commit in it does not exist.
      log.warn(
        "wiki {root}: git dated {createdHits}/{total} pages but found 0 non-sweep " +
          'commits — every page is falling back to its creation date in "Recently updated"',
        { root, createdHits, total: pages.length },
      );
    } else {
      log.debug("wiki {root}: git dates — created {createdHits}/{total}, touched {touchedHits}", {
        root,
        createdHits,
        touchedHits,
        total: pages.length,
      });
    }

    // BULK-RESTAMP detection — the failure the two guards above cannot see, because it
    // isn't a coverage problem: git dated every page correctly and a sweep then wrote
    // one `updated:` day across hundreds of them, which is the ONE signal the sweep
    // discount can't discount. Log-only and deliberately so — the stamps are
    // page-by-page indistinguishable from real same-day edits, so there is nothing safe
    // to do automatically. One warn per offending DAY per build; needs the git maps, so
    // it lives inside this block. See `restamp-detect.ts` for why the obvious predicate
    // (shared day + no touch) fires forever on every benign bulk ingest.
    for (const cohort of detectBulkRestamps(pages)) {
      const hidden = cohort.count - cohort.samples.length;
      log.warn(
        "wiki {root}: {count} pages carry frontmatter updated/created {day} but were " +
          "first committed ≥{leadDays}d earlier with no non-sweep commit since — looks " +
          'like a bulk restamp, which collapses "Recently updated" onto one day; in {samples}',
        {
          root,
          count: cohort.count,
          day: cohort.day,
          leadDays: RESTAMP_MIN_LEAD_DAYS,
          samples: cohort.samples.join(", ") + (hidden > 0 ? ` (+${hidden} more)` : ""),
        },
      );
    }
  }

  // ONE warn per index build, never one per page — a backfill writing these fields
  // across ~145 files at once would otherwise flood the log on every TTL refresh.
  // The offending pages stay browsable with the field simply absent. Counts alone
  // gave an operator nothing to act on ("dropped 3" every 5 min across 385 pages),
  // so the warn names a capped sample of the pages and collapses the rest into
  // "+N more" — same shape as the gardener's `evictedTopics` tail.
  const planDropTotal = planDrops.planStatus + planDrops.statusDate + planDrops.followups;
  if (planDropTotal > 0) {
    const hidden = planDrops.pages - planDrops.samples.length;
    log.warn(
      "wiki {root}: dropped {count} invalid plan-status frontmatter value(s) across " +
        "{pages} page(s) — {planStatus} plan_status, {statusDate} status_date, " +
        "{followups} followups; in {samples}",
      {
        root,
        count: planDropTotal,
        planStatus: planDrops.planStatus,
        statusDate: planDrops.statusDate,
        followups: planDrops.followups,
        pages: planDrops.pages,
        samples: planDrops.samples.join(", ") + (hidden > 0 ? ` (+${hidden} more)` : ""),
      },
    );
  }

  // Same-stem pages of DIFFERENT file types make resolve() (and wikilinks/paths
  // to that stem) ambiguous. Precedence is `.md` > `.mdx` > `.html`: the highest-
  // precedence extension present for a stem wins, and every lower-precedence
  // same-stem page is DROPPED from the index entirely (it still exists on disk).
  // Same-EXTENSION same-stem pages in different folders are NOT a collision —
  // both stay, each with its own distinct link set (see the relPath-keyed graph
  // below). This is the read-side counterpart to mimir's authoring-side collision
  // guard in `scripts/mdx-explainer/checks.ts` (a case-insensitive stem-collision
  // check that refuses to compile two sources onto one output stem); here we can't
  // refuse — the files already exist — so we resolve the ambiguity by precedence.
  const bestRankByStem = new Map<string, number>();
  for (const p of pages) {
    const key = p.name.toLowerCase();
    const rank = extRank(p.relPath);
    const cur = bestRankByStem.get(key);
    if (cur === undefined || rank < cur) bestRankByStem.set(key, rank);
  }
  for (let i = pages.length - 1; i >= 0; i--) {
    const p = pages[i]!;
    const best = bestRankByStem.get(p.name.toLowerCase())!;
    if (extRank(p.relPath) > best) {
      log.warn("wiki page {relPath} shadowed by a higher-precedence same-stem page — dropped", {
        relPath: p.relPath,
      });
      pages.splice(i, 1);
    }
  }

  pages.sort((a, b) => a.relPath.localeCompare(b.relPath));
  // Registration order decides stem-collision winners: root AI pages sort before
  // life/ and register first, matching Obsidian's ambiguous-link behavior closely
  // enough for a read-only viewer.
  for (const meta of pages) register(meta.name, meta);
  for (const meta of pages) {
    register(meta.title, meta);
    for (const alias of meta.aliases) register(alias, meta);
  }

  // relPath lookup for the graph: both link kinds resolve to a target *page* and
  // are stored as that page's normalized relPath — unique even when stems collide,
  // so same-stem pages in different folders keep distinct link sets and counts.
  const byRelPath = new Map<string, WikiPageMeta>();
  for (const meta of pages) {
    const key = normalizeRelPath(meta.relPath);
    if (!byRelPath.has(key)) byRelPath.set(key, meta);
  }
  const resolveRelPath = (relPath: string) => byRelPath.get(normalizeRelPath(relPath));

  const resolve = (target: string) => {
    const t = target.trim().toLowerCase();
    const direct = byKey.get(t);
    if (direct) return direct;
    // Path-form wikilinks ([[concepts/trygdeavgift]], melosys-kode-wiki style)
    // resolve root-relative — stems only match byKey above. An explicit `.md`/
    // `.mdx` extension is used as-is; a bare path implies `.md` first, then a
    // native `.mdx` page (so [[blogs/src/foo]] finds foo.mdx).
    if (t.includes("/")) {
      if (t.endsWith(".md") || t.endsWith(".mdx")) return byRelPath.get(normalizeRelPath(t));
      return (
        byRelPath.get(normalizeRelPath(`${t}.md`)) ??
        byRelPath.get(normalizeRelPath(`${t}.mdx`))
      );
    }
    return undefined;
  };

  const outgoing = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  for (const meta of pages) {
    const key = normalizeRelPath(meta.relPath);
    const resolved = new Set<string>();
    // Wikilinks resolve by name/alias (ambiguous stems go to the first-registered
    // winner, as before) — then join the graph as the winner's relPath.
    for (const target of rawOutgoing.get(meta.relPath) ?? []) {
      const targetMeta = resolve(target);
      if (!targetMeta) continue;
      const targetKey = normalizeRelPath(targetMeta.relPath);
      if (targetKey !== key) resolved.add(targetKey);
    }
    // Relative markdown links resolve by path and feed the same set — a page
    // linked both by [[wikilink]] and [text](path.md) counts once. A relative
    // `.html` link resolves the same way (byRelPath holds explainers), so a
    // markdown page's `[text](../blogs/foo.html)` gives that explainer a
    // backlink — explainers still emit no outgoing links of their own (:497).
    for (const rel of rawMdTargets.get(meta.relPath) ?? []) {
      if (rel !== key && byRelPath.has(rel)) resolved.add(rel);
    }
    outgoing.set(key, [...resolved]);
    for (const targetKey of resolved) {
      let arr = backlinks.get(targetKey);
      if (!arr) {
        arr = [];
        backlinks.set(targetKey, arr);
      }
      arr.push(key);
    }
  }
  for (const arr of backlinks.values()) arr.sort();

  return { pages, outgoing, backlinks, resolve, resolveRelPath, scannedAt: Date.now(), root, readerConfig, trails };
}

/** Per-root TTL cache — bots point at different wikis, so caches can't be shared. */
const caches = new Map<string, WikiIndex>();
/** Roots we've already warned about being unreadable (one warn per root). */
const warnedRoots = new Set<string>();

/**
 * TTL-cached index over a wiki root. Pass `root` (a bot's `wikiDir`) to browse a
 * specific bot's wiki; omit it to keep today's behavior (`WIKI_DIR` env → jarvis
 * default). Each root is cached and degraded independently — a missing melosys
 * wiki never affects the jarvis cache. Returns null (and warns once per root)
 * when the directory is missing — the caller renders an empty state.
 */
export async function getWikiIndex(opts?: { root?: string; refresh?: boolean }): Promise<WikiIndex | null> {
  const root = resolveWikiRoot(opts?.root);
  const cached = caches.get(root);
  if (cached && !opts?.refresh && Date.now() - cached.scannedAt < CACHE_TTL_MS) {
    return cached;
  }
  try {
    const st = await stat(root);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    if (!warnedRoots.has(root)) {
      log.warn("Wiki directory not readable at {path} — /wiki disabled: {error}", {
        path: root,
        error: err instanceof Error ? err.message : String(err),
      });
      warnedRoots.add(root);
    }
    caches.delete(root);
    return null;
  }

  const started = Date.now();
  const index = await buildWikiIndex(root);
  caches.set(root, index);
  warnedRoots.delete(root);
  log.info("Wiki index built: {pages} pages in {ms}ms from {path}", {
    pages: index.pages.length,
    ms: Date.now() - started,
    path: root,
  });
  return index;
}

/** Raw markdown of one page (by resolved meta). Null when the file vanished. */
export async function readWikiPage(index: WikiIndex, meta: WikiPageMeta): Promise<string | null> {
  try {
    return await Bun.file(path.join(index.root, meta.relPath)).text();
  } catch {
    return null;
  }
}

/** Test-only: drop all per-root caches + re-arm the one-shot warnings between cases. */
export function __resetWikiCacheForTest(): void {
  caches.clear();
  warnedRoots.clear();
}
