/**
 * Wiki linter — report-only hygiene checks over a knowledge wiki.
 *
 * Pure functions over a built `WikiIndex` (`store.ts`) plus per-file content
 * reads. Findings are TRANSIENT — recomputed on demand from the wiki tree; there
 * is no DB table and nothing is written back to the wiki. The `wiki-linter`
 * watcher (report-only) and the `/api/wiki/linter-findings` route both call
 * `lintWiki`.
 *
 * Five checks, each finding `{ check, relPath, message, detail? }`:
 *  1. broken-link    — [[wikilink]] / relative .md link that resolves to no page.
 *  2. orphan         — a page with no inbound links (reserved files discounted as
 *                      both subjects and sole-linkers).
 *  3. stale-updated  — a frontmatter page missing `updated:`, with an unparseable
 *                      `updated:` value, or with an `updated:`/`created:` stamped
 *                      implausibly far in the future (the stamp the reader's recency
 *                      sorts silently ignore — this is its only operator-visible signal).
 *  4. missing-sources — a synthesized `concept` page that cites no sources (no
 *                      `## Sources` heading AND no `sources:` frontmatter).
 *  5. index-truncation — a line carrying a `[[` that never closes on that line.
 *                      A wikilink cannot span lines, so the `[[` is the debris of
 *                      a truncated line (the gardener's index one-liner was cut
 *                      mid-link until 2026-08-29) — and any line-based
 *                      `\[\[([^\]]+)\]\]` scan run over such a file matches
 *                      across the break and consumes the NEXT line's link.
 *
 * The store's index builder silently drops unresolved link targets
 * (`store.ts:389-399`), so broken-link recomputes resolution here from the raw
 * page content rather than reading it off `index.outgoing`.
 */

import path from "node:path";
import type { WikiIndex, WikiPageMeta } from "./store.ts";
import {
  extractWikilinks,
  extractMarkdownLinks,
  parseFrontmatter,
  normalizeRelPath,
} from "./store.ts";
import {
  FUTURE_DATE_SKEW_MS,
  isImplausibleFutureDate,
} from "../dashboard/views/components/wiki-filter.ts";

export const LINT_CHECKS = [
  "broken-link",
  "orphan",
  "stale-updated",
  "missing-sources",
  "index-truncation",
] as const;
export type LintCheck = (typeof LINT_CHECKS)[number];

export interface LintFinding {
  check: LintCheck;
  /** Wiki-relative path of the page the finding is about. */
  relPath: string;
  message: string;
  /** Optional secondary context (e.g. link kind). */
  detail?: string;
}

export interface LintReport {
  findings: LintFinding[];
  /** Count of findings per check key (every check key present, 0 when clean). */
  counts: Record<LintCheck, number>;
  generatedAt: number;
}

/**
 * Reserved wiki-infrastructure basenames — never real content pages. Matches the
 * gardener's `FORBIDDEN_BASENAMES` (`src/gardener/draft.ts`). Skipped as orphan
 * subjects, discounted as orphan sole-linkers (an index-of-contents that links
 * everything must not mask a page that nothing else references), and skipped by
 * the stale-updated + missing-sources checks.
 */
const RESERVED_BASENAMES = new Set([
  "log.md",
  "index.md",
  "claude.md",
  // `.mdx` twins — the source-page drafter writes native `.mdx`, so the gardener's
  // `FORBIDDEN_BASENAMES` reserves both extensions; mirror that here.
  "log.mdx",
  "index.mdx",
  "claude.mdx",
]);

function reservedBasename(relPathOrKey: string): boolean {
  return RESERVED_BASENAMES.has(path.posix.basename(relPathOrKey).toLowerCase());
}

async function defaultReadFile(absPath: string): Promise<string | null> {
  try {
    return await Bun.file(absPath).text();
  } catch {
    return null;
  }
}

/** True when the content opens with a terminated `---` frontmatter fence. */
function hasFrontmatterFence(content: string): boolean {
  return content.startsWith("---") && content.indexOf("\n---", 3) !== -1;
}

/**
 * Strip fenced code blocks and inline code spans before link extraction —
 * LINTER PATH ONLY. A literal `[[wikilink]]` inside code is a meta-mention
 * (docs about wikilink syntax), not a link, so flagging it is pure noise. The
 * store's extractors deliberately don't do this (the graph tolerates the extra
 * edges); the linter must not report them as broken.
 */
function stripCodeSpans(content: string): string {
  return content.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`\n]*`/g, "");
}

/** Broken [[wikilinks]] + relative .md links on one page, resolved against the index. */
function checkBrokenLinks(page: WikiPageMeta, rawContent: string, index: WikiIndex): LintFinding[] {
  const out: LintFinding[] = [];
  const content = stripCodeSpans(rawContent);

  // Wikilinks resolve by name/alias/path-form (index.resolve) — a self-link
  // ([[Own Name]]) resolves to the page itself and is therefore not broken.
  for (const target of extractWikilinks(content)) {
    if (!index.resolve(target)) {
      out.push({
        check: "broken-link",
        relPath: page.relPath,
        message: `Unresolved wikilink [[${target}]]`,
        detail: "wikilink",
      });
    }
  }

  // Relative markdown links resolve by path, relative to the linking page's dir
  // (mirrors the store's `resolveMarkdownTargets`). Targets that escape the wiki
  // root via `../` are external references, not broken wiki links — skip them.
  const dir = path.posix.dirname(page.relPath);
  for (const raw of extractMarkdownLinks(content)) {
    // `.html` explainer links are NOT held to the broken-link check. Real
    // explainers resolve in the store graph (giving them backlinks), but an
    // unresolved `.html` target must never be reported broken: a link to a
    // SHADOWED explainer (same-stem `.md` wins ⇒ the `.html` is dropped from the
    // index yet still exists on disk) would be a false positive. We err toward
    // zero false positives — the valuable signal is the backlink, not `.html`
    // dead-link detection — so the linter watcher sees no spurious jump.
    if (/\.html$/i.test(raw)) continue;
    const joined = path.posix.normalize(path.posix.join(dir, raw));
    if (joined === ".." || joined.startsWith("../")) continue;
    if (!index.resolveRelPath(joined)) {
      out.push({
        check: "broken-link",
        relPath: page.relPath,
        message: `Unresolved link (${raw})`,
        detail: "markdown",
      });
    }
  }

  return out;
}

/** How much of the offending line the finding quotes. */
const TRUNCATION_EXCERPT_MAX = 60;

/**
 * Lines carrying a `[[` that never closes on that line.
 *
 * This is the recurrence detector for the truncated index one-liner
 * (`indexOneLiner`, `src/gardener/wire.ts`): the write side now cuts at a safe
 * boundary, and this reports any line that still ends up in the broken shape —
 * a hand edit, another writer, or a regression. It matters beyond cosmetics
 * because a `\[\[([^\]]+)\]\]` scan without a `\n` exclusion (which is what the
 * 2026-08-16 index lint was) matches across the break and reports the swallowed
 * page as uncatalogued.
 *
 * Fenced blocks are skipped and inline code spans stripped PER LINE (not via
 * `stripCodeSpans`, whose fence removal joins the lines around a block and could
 * balance a genuinely dangling `[[` against a later line's `]]`).
 */
function checkIndexTruncation(page: WikiPageMeta, rawContent: string): LintFinding[] {
  const out: LintFinding[] = [];
  let inFence = false;
  const lines = rawContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw.replace(/`[^`]*`/g, "");
    const open = line.lastIndexOf("[[");
    if (open === -1 || line.indexOf("]]", open + 2) !== -1) continue;
    const excerpt = line.slice(open).trim().slice(0, TRUNCATION_EXCERPT_MAX);
    out.push({
      check: "index-truncation",
      relPath: page.relPath,
      message: `Unclosed [[ on line ${i + 1} — a wikilink scan can run past the line end (${excerpt})`,
      detail: `line ${i + 1}`,
    });
  }
  return out;
}

/** Hours in `FUTURE_DATE_SKEW_MS`, for the finding message (48). */
const FUTURE_SKEW_HOURS = Math.round(FUTURE_DATE_SKEW_MS / (60 * 60 * 1000));

/**
 * A parseable frontmatter date sitting implausibly far in the future — the same
 * predicate the reader's recency sorts use to IGNORE such a stamp
 * (`isImplausibleFutureDate`, `wiki-filter.ts`).
 *
 * This check exists precisely BECAUSE the sort drops the stamp silently: dropping is
 * the right sort behavior (a `2027-01-01` would otherwise pin the page to the top of
 * "Recently updated" forever) but it leaves a single bad stamp with no operator-visible
 * signal anywhere. The lint surface + the weekly `wiki-linter` watcher is where it
 * becomes visible. Both date fields are checked: `created` feeds "Recently added" and a
 * future `created` is dropped there by the same predicate.
 */
function checkFutureDate(
  page: WikiPageMeta,
  field: "updated" | "created",
  value: unknown,
  now: number,
): LintFinding | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null; // unparseable is the stale-updated case's job
  if (!isImplausibleFutureDate(ms, now)) return null;
  return {
    check: "stale-updated",
    relPath: page.relPath,
    message: `${field}: "${value}" is in the future — ignored by the recency sort`,
    detail: `more than ${FUTURE_SKEW_HOURS}h ahead of now`,
  };
}

/**
 * Unusable date frontmatter on a structured (frontmatter) page: a missing or
 * unparseable `updated:`, plus an `updated:`/`created:` stamped implausibly far in the
 * future (see `checkFutureDate`). All report under the one `stale-updated` key — the
 * check answers "is this page's date frontmatter usable", and a future stamp is
 * unusable for exactly the same reason and with exactly the same consequence (the page
 * falls back to its git/mtime evidence).
 *
 * The two fields are checked INDEPENDENTLY, and that is the whole shape of this
 * function: `updated` and `created` are separate stamps feeding separate sorts
 * ("Recently updated" / "Recently added"), so an unusable `updated:` must not
 * short-circuit the `created:` check. Returning early on the missing/unparseable
 * branches did exactly that, and hid the worst combination — a page with a future
 * `created: 2027-01-01` and NO `updated:` reported only the (mild, ubiquitous) missing
 * -updated finding while the stamp actually corrupting a sort went unmentioned.
 */
function checkStaleUpdated(page: WikiPageMeta, content: string, now: number): LintFinding[] {
  // Only structured pages (those that carry a frontmatter fence) are held to the
  // `updated:` convention — a plain no-frontmatter markdown file isn't the
  // gardener's page shape, so flagging it would be reindex/hand-edit noise.
  if (!hasFrontmatterFence(content)) return [];

  const fm = parseFrontmatter(content);
  const out: LintFinding[] = [];

  const updated = fm.updated;
  if (updated === undefined) {
    out.push({
      check: "stale-updated",
      relPath: page.relPath,
      message: "Missing frontmatter: updated:",
    });
  } else if (Array.isArray(updated) || Number.isNaN(Date.parse(updated))) {
    // A single-line inline array (or any non-scalar) can't be a date.
    const shown = Array.isArray(updated) ? `[${updated.join(", ")}]` : updated;
    out.push({
      check: "stale-updated",
      relPath: page.relPath,
      message: `Unparseable updated: "${shown}"`,
    });
  } else {
    const finding = checkFutureDate(page, "updated", updated, now);
    if (finding) out.push(finding);
  }

  const createdFinding = checkFutureDate(page, "created", fm.created, now);
  if (createdFinding) out.push(createdFinding);

  return out;
}

const SOURCES_HEADING_RE = /^#{2,6}\s+sources\b/im;

/**
 * A synthesized `concept` page should cite where it came from. The gardener's
 * own draft convention (`src/gardener/draft.ts`) uses a `sources:` frontmatter
 * list plus a `## See also` section — it does NOT emit a `## Sources` heading —
 * so accepting EITHER a `## Sources` heading OR a non-empty `sources:`
 * frontmatter avoids flagging every gardener-written page (the conservative,
 * fewer-false-positives reading of the brief). `entity` stubs and non-concept
 * types are out of scope.
 */
function checkMissingSources(page: WikiPageMeta, content: string): LintFinding | null {
  if (page.type !== "concept") return null;
  const fm = parseFrontmatter(content);
  const src = fm.sources;
  const hasSourcesFm = Array.isArray(src) ? src.length > 0 : typeof src === "string" && src.trim().length > 0;
  if (hasSourcesFm) return null;
  if (SOURCES_HEADING_RE.test(content)) return null;
  return {
    check: "missing-sources",
    relPath: page.relPath,
    message: "Concept page cites no sources (no ## Sources section or sources: frontmatter)",
  };
}

/** Pages with no inbound links, discounting reserved-file linkers + subjects. */
function checkOrphans(index: WikiIndex): LintFinding[] {
  const out: LintFinding[] = [];
  for (const page of index.pages) {
    // Explainers (.html) never join the link graph, so they'd always read as
    // orphans — that's structural, not a hygiene issue. Exclude them as subjects.
    if (page.type === "explainer") continue;
    const key = normalizeRelPath(page.relPath);
    if (reservedBasename(key)) continue;

    const linkers = (index.backlinks.get(key) ?? []).filter((l) => !reservedBasename(l));
    if (linkers.length === 0) {
      out.push({ check: "orphan", relPath: page.relPath, message: "No inbound links (orphan page)" });
    }
  }
  return out;
}

/**
 * Run every hygiene check over a built wiki index. Returns findings + per-check
 * counts + a timestamp. Report-only: nothing is written. `deps.readFile` is
 * injectable for tests; it defaults to reading the file off disk.
 */
export async function lintWiki(
  index: WikiIndex,
  deps?: { readFile?: (absPath: string) => Promise<string | null>; now?: () => number },
): Promise<LintReport> {
  const readFile = deps?.readFile ?? defaultReadFile;
  const now = deps?.now ?? (() => Date.now());
  const nowMs = now();
  const findings: LintFinding[] = [];

  for (const page of index.pages) {
    if (page.type === "explainer") continue; // no frontmatter, no links
    const content = await readFile(path.join(index.root, page.relPath));
    if (content === null) continue; // unreadable — skip, keep linting the rest

    // Broken links apply to every markdown page (a dead link in index.md is
    // still a dead link); the frontmatter-shaped checks skip reserved infra.
    findings.push(...checkBrokenLinks(page, content, index));
    // Reserved infra is IN scope: index.md is exactly where the truncated
    // one-liners land, and a dangling `[[` there hides a real catalog entry.
    findings.push(...checkIndexTruncation(page, content));

    if (!reservedBasename(page.relPath)) {
      // One clock read per lint pass, so two pages at the 48h boundary are judged
      // against the same instant (and `deps.now` makes the case deterministic in tests).
      findings.push(...checkStaleUpdated(page, content, nowMs));
      const sources = checkMissingSources(page, content);
      if (sources) findings.push(sources);
    }
  }

  findings.push(...checkOrphans(index));

  const counts = Object.fromEntries(LINT_CHECKS.map((c) => [c, 0])) as Record<LintCheck, number>;
  for (const f of findings) counts[f.check] = (counts[f.check] ?? 0) + 1;

  return { findings, counts, generatedAt: nowMs };
}
