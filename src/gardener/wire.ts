/**
 * Wire stage — the pure edit builders that stop every gardener page from
 * shipping as an ORPHAN. Historically apply.ts wrote the page, appended log.md,
 * and reindexed, but NEVER linked the page into the wiki: zero inbound links,
 * absent from index.md. This module supplies three deterministic, individually
 * testable functions the apply step composes at approve time:
 *
 *  - `buildIndexEntry` — the `## Concepts` index line for a new concept page
 *    (entities skip: People vs Organizations vs Products isn't derivable).
 *  - `insertIndexLine` — splice that line into index.md, alphabetically within
 *    the matched `### ` block, idempotently.
 *  - `buildSeeAlsoEdit` — add an inbound `## See also` link on a related page.
 *
 * All three are string-in / string-out with no DB, no filesystem, no markdown
 * library — plain line-scanning like `insertLogEntry` (apply.ts). The apply step
 * wires the filesystem reads/writes around them and swallows per-file failures.
 *
 * A fourth pure helper, `selectWirablePages`, picks WHICH related pages the wire
 * stage backlinks — shared by apply and the review-gate preview so the two can't
 * drift on selection order.
 */

import type { WikiIndex, WikiPageMeta } from "../wiki/store.ts";
import { firstDanglingWikilinkOpen } from "../wiki/store.ts";
import { truncateUnits } from "../wiki/ask-chat.ts";
import type { WikiProposalKind, WikiProposalRelatedPage } from "../db/wiki-proposals.ts";

/** A related page the wire stage will attempt to backlink (title + resolved page). */
export interface WirablePage {
  /** The related page's title as it will be linked (`[[title]]`). */
  title: string;
  /** The resolved wiki page — its `relPath`/`domain` drive apply's confinement + edit. */
  page: WikiPageMeta;
}

/**
 * The related pages the wire stage will attempt to backlink, in apply's EXACT
 * selection order so the review-gate preview can't drift from what apply does:
 * take the first 3 related pages, resolve each (by title, then `relPath`
 * fallback), drop the unresolvable ones, and skip self-links (a page resolving
 * back to `targetPath`). PURE — no filesystem: apply's further already-linked and
 * path-confinement skips need file reads and stay in apply.ts.
 */
export function selectWirablePages(
  relatedPages: WikiProposalRelatedPage[] | null | undefined,
  index: WikiIndex | null,
  targetPath: string,
): WirablePage[] {
  const out: WirablePage[] = [];
  for (const rp of (relatedPages ?? []).slice(0, 3)) {
    const page = index?.resolve(rp.title) ?? (rp.relPath ? index?.resolveRelPath(rp.relPath) : undefined);
    if (!page) continue;
    if (page.relPath === targetPath) continue; // never link a page to itself
    out.push({ title: rp.title, page });
  }
  return out;
}

/** Concept index section per domain — heading strings must byte-match index.md. */
const CONCEPT_SECTION: Record<"ai" | "life", string> = {
  ai: "AI / Claude / Coding",
  life: "Health / Learning",
};

/** The `## Sources` section heading (level 2) individual source-page catalog
 *  lines slot under — matches the real huginn-jarvis index.md, where source
 *  pages live as `- [[Title]] — one-liner` bullets under `## Sources` (the human
 *  lint pass later regroups them into dated `### Focused source pages` batches). */
const SOURCES_SECTION = "Sources";

/** Default cataloging policy: only `concept` pages get an index.md line — the
 *  historical behavior, byte-identical for any wiki that doesn't opt in. A wiki
 *  opts additional kinds in via `wikiAutoCommit.catalogKinds` (e.g. jarvis adds
 *  `source`). Entities are NEVER cataloged regardless (see {@link catalogPage}). */
export const DEFAULT_CATALOG_KINDS: string[] = ["concept"];

/** Hard cap on the index one-liner (rationale / first body paragraph), in UTF-16
 *  code units. Exported so the tests assert against the SHIPPED number rather
 *  than a mirrored constant that can silently disagree with it. */
export const ONE_LINER_MAX = 120;

/** Below this many characters the truncated one-liner says nothing, so the bullet
 *  ships as a bare `- [[Title]]` instead of `- [[Title]] — Th…`. Only reachable
 *  when a `[[wikilink]]` starts at/near offset 0 (see {@link truncateOneLiner}). */
const ONE_LINER_MIN = 20;

/**
 * Cut `text` to at most `ONE_LINER_MAX` code units WITHOUT splitting a
 * `[[wikilink]]` and without splitting a surrogate pair, appending `…`. A bare
 * slice ships an unclosed `[[`, and every line-based `\[\[([^\]]+)\]\]` scan then
 * matches across the newline and swallows the NEXT index entry's link — the
 * numbers are in `src/watchers/CLAUDE.md` (`index-truncation`).
 *
 * We truncate rather than repair: appending `]]` would invent a link target the
 * summary never asserted, and `insertIndexLine`'s idempotence check reads
 * `[[Title]]` substrings, so a fabricated target is worse than a dropped one.
 *
 * Four properties, each one a defect that shipped:
 *  - the backup goes to the FIRST unclosed `[[`, via the shared
 *    {@link firstDanglingWikilinkOpen} — the detector (`checkIndexTruncation`)
 *    runs the same function, so writer and lint cannot disagree about what
 *    "dangling" means. They DO differ on input normalization: the detector
 *    strips inline code spans first, this writer decides on the raw text — so
 *    a rationale quoting `[[` inside backticks is over-cut here while the lint
 *    stays clean. Accepted: the strict side is the writer, so the asymmetry
 *    can lose one-liner content but never ship debris. Backing up to
 *    the LAST opener (a `lastIndexOf` here and there) left an EARLIER dangling
 *    one untouched and unreported: `…[[Unclosed junk …[[Real Page]] tail` cut
 *    inside the second link, saw that one close, and shipped the first verbatim.
 *  - the cut can land BETWEEN the two brackets, leaving a lone `[` that no
 *    `[[`-vs-`]]` reasoning sees; it is stripped after the backup.
 *  - the cut is by CODE POINT (`truncateUnits`), because a bare `slice` through
 *    an emoji stores a lone surrogate in `index.md` (the `ask-chat.ts` rule).
 *  - **the dangling-open cut runs regardless of length.** The invariant is "a
 *    one-liner never contains a partial link", NOT "truncation never creates
 *    one": the model writes the rationale, so a 40-char one can carry a bare
 *    `[[` or a nested `[[Foo [[Bar]]` of its own. An `if (length <= MAX) return
 *    text` ahead of the check shipped both verbatim into index.md — the first as
 *    the cross-line swallow this function exists to stop, the second as the
 *    phantom target `Foo [[Bar` that eats the real `[[Bar]]` link — and the
 *    linter's `index-truncation` check then reported the gardener's own write.
 *
 * The `…` marks removed content, so it is appended whenever anything was cut —
 * including a dangling-open cut on a short rationale, which drops the debris and
 * everything after it.
 */
function truncateOneLiner(text: string): string {
  const overLong = text.length > ONE_LINER_MAX;
  let cut = overLong ? truncateUnits(text, ONE_LINER_MAX - 1) : text;
  const open = firstDanglingWikilinkOpen(cut);
  if (open === -1 && !overLong) return text; // short and balanced — verbatim
  if (open !== -1) cut = cut.slice(0, open);
  cut = cut.trimEnd();
  while (cut.endsWith("[")) cut = cut.slice(0, -1).trimEnd();
  if (cut.length < ONE_LINER_MIN) return "";
  return `${cut}…`;
}

/**
 * Per-wiki cataloging policy decision: does a page of `kind` get an index.md
 * catalog line under this wiki's `catalogKinds` policy? Two kinds are ALWAYS
 * skipped regardless of policy:
 *   - `entity` — the Entities index is split People / Organizations / Products and
 *     which one an entity is isn't derivable from the proposal;
 *   - `synthesis` — consolidation blog pages get no index.md catalog line in v1
 *     (they'd have no natural home section — blogs/ isn't in the concept index),
 *     so a wiki listing "synthesis" in its policy never catalogs one here either.
 * Every other kind is cataloged iff it appears in `catalogKinds` (default
 * `["concept"]`).
 */
export function catalogPage(kind: WikiProposalKind, catalogKinds: string[] = DEFAULT_CATALOG_KINDS): boolean {
  if (kind === "entity" || kind === "synthesis") return false;
  return catalogKinds.includes(kind);
}

export interface IndexEntryInput {
  title: string;
  kind: WikiProposalKind;
  domain: "ai" | "life";
  /** The proposal's rationale — preferred one-liner source. */
  rationale?: string | null;
  /** The page body (frontmatter already stripped) — one-liner fallback. */
  body?: string | null;
}

/** The planned index insertion: the bullet line + the section it belongs under. */
export interface IndexEntry {
  line: string;
  /** The heading text WITHOUT its leading `#`s (e.g. "AI / Claude / Coding"). */
  section: string;
  /** Heading depth of `section` — `3` for the `### ` concept sections, `2` for
   *  the `## Sources` section. Defaults to `3` when absent (concept path). */
  headingLevel?: 2 | 3;
}

/**
 * Build the `- [[Title]] — <one-liner>` index bullet for a new page, plus the
 * section it belongs under — subject to the wiki's per-kind cataloging policy
 * (`catalogKinds`, default `["concept"]`). Returns null when the page's kind
 * isn't cataloged for this wiki (see {@link catalogPage}):
 *   - `entity` — ALWAYS null (the Entities index is split People / Organizations
 *     / Products & projects; which one isn't derivable from the proposal).
 *   - `source` — null under the default policy; a wiki that opts sources in
 *     (jarvis: `catalogKinds: ["concept", "source"]`) gets a `## Sources` line.
 *   - `concept` — the default; a `### <domain section>` line.
 * A skipped kind is surfaced in the gate's wiring preview as a "not cataloged".
 */
export function buildIndexEntry(
  input: IndexEntryInput,
  catalogKinds: string[] = DEFAULT_CATALOG_KINDS,
): IndexEntry | null {
  if (!catalogPage(input.kind, catalogKinds)) return null;
  const oneLiner = indexOneLiner(input.rationale, input.body);
  const line = oneLiner ? `- [[${input.title}]] — ${oneLiner}` : `- [[${input.title}]]`;
  if (input.kind === "source") {
    return { line, section: SOURCES_SECTION, headingLevel: 2 };
  }
  return { line, section: CONCEPT_SECTION[input.domain], headingLevel: 3 };
}

/**
 * Rationale (first non-empty line) → first body paragraph, whitespace-collapsed,
 * cut to ≤120 code units at a wikilink-safe boundary.
 *
 * The fallback is applied AFTER truncation, not before: a rationale opening on a
 * `[[wikilink]]` degenerates to "" under {@link truncateOneLiner}'s
 * `ONE_LINER_MIN` floor, and choosing the source first meant the page shipped as
 * a bare `- [[Title]]` while a perfectly good first body paragraph sat unused.
 */
function indexOneLiner(rationale: string | null | undefined, body: string | null | undefined): string {
  const fromRationale = (rationale ?? "")
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  const flatten = (s: string) => s.replace(/\s+/g, " ").trim();
  const fromRationaleCut = truncateOneLiner(flatten(fromRationale ?? ""));
  if (fromRationaleCut) return fromRationaleCut;
  return truncateOneLiner(flatten(firstBodyParagraph(body)));
}

/** First non-empty, non-heading, non-fence line of a page body. */
function firstBodyParagraph(body: string | null | undefined): string {
  for (const line of (body ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue; // markdown heading
    if (t.startsWith("---")) continue; // stray frontmatter fence / hr
    return t;
  }
  return "";
}

/** The `[[Title]]` target inside a bullet line, or null when the line isn't a `- [[…]]` bullet. */
function bulletTitle(line: string): string | null {
  const m = line.match(/^\s*-\s*\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/);
  return m ? m[1]!.trim() : null;
}

export interface InsertIndexResult {
  content: string;
  changed: boolean;
  /** Why nothing/what changed — lets the caller warn only on a genuinely missing section. */
  reason: "inserted" | "already-present" | "section-not-found";
}

/**
 * Splice `entry.line` into index.md under its `### ${entry.section}` block, in
 * case-sensitive ASCII order within that block (a deterministic placement — the
 * curated blocks are only loosely alphabetical, so callers/tests must NOT assert
 * against real-file order). Idempotent: if the entry's `[[Title]]` already appears
 * ANYWHERE in index.md, it's a no-op. If the target `### ` heading isn't present,
 * nothing is created — the caller warns and skips (never invents headings). Plain
 * line-scanning, no markdown library.
 */
export function insertIndexLine(indexContent: string, entry: IndexEntry): InsertIndexResult {
  const newTitle = bulletTitle(entry.line);
  if (newTitle && indexContent.includes(`[[${newTitle}]]`)) {
    return { content: indexContent, changed: false, reason: "already-present" };
  }

  const lines = indexContent.split("\n");
  const heading = `${"#".repeat(entry.headingLevel ?? 3)} ${entry.section}`;
  const headingIdx = lines.findIndex((l) => l.trimEnd() === heading);
  if (headingIdx === -1) {
    return { content: indexContent, changed: false, reason: "section-not-found" };
  }

  // The block runs from just after the heading to the next heading (any level) or EOF.
  let blockEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      blockEnd = i;
      break;
    }
  }

  // Insert before the first existing bullet whose title sorts ASCII-after the new
  // one; if none do, after the last bullet (or right after the heading when empty).
  let insertAt = -1;
  let lastBullet = -1;
  for (let i = headingIdx + 1; i < blockEnd; i++) {
    const t = bulletTitle(lines[i]!);
    if (t === null) continue;
    lastBullet = i;
    if (insertAt === -1 && newTitle !== null && t > newTitle) insertAt = i;
  }
  if (insertAt === -1) insertAt = lastBullet === -1 ? headingIdx + 1 : lastBullet + 1;

  lines.splice(insertAt, 0, entry.line);
  return { content: lines.join("\n"), changed: true, reason: "inserted" };
}

/**
 * Add a `- [[newTitle]]` inbound link under a page's `## See also` section,
 * returning the edited page content — or null when nothing should change:
 *  - the page already links `[[newTitle]]` anywhere (idempotent), or
 *  - `newTitle` is blank.
 * When the page has no `## See also` section, one is created at the end (207/207
 * concept+entity pages carry it today, so this is the rare path). Plain
 * line-scanning; frontmatter and body bytes outside the edit are preserved.
 */
export function buildSeeAlsoEdit(pageContent: string, newTitle: string): string | null {
  const title = newTitle.trim();
  if (!title) return null;
  if (pageContent.includes(`[[${title}]]`)) return null; // already linked

  const bullet = `- [[${title}]]`;
  const lines = pageContent.split("\n");
  const headingIdx = lines.findIndex((l) => /^##\s+See also\s*$/i.test(l.trimEnd()));

  if (headingIdx === -1) {
    const trimmed = pageContent.replace(/\s+$/, "");
    return `${trimmed}\n\n## See also\n${bullet}\n`;
  }

  // Insert after the last bullet in the See-also block (to the next heading / EOF).
  let blockEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      blockEnd = i;
      break;
    }
  }
  let lastBullet = -1;
  for (let i = headingIdx + 1; i < blockEnd; i++) {
    if (/^\s*-\s+/.test(lines[i]!)) lastBullet = i;
  }
  const insertAt = lastBullet === -1 ? headingIdx + 1 : lastBullet + 1;
  lines.splice(insertAt, 0, bullet);
  return lines.join("\n");
}
