/**
 * Wiki linter — report-only hygiene checks over a knowledge wiki.
 *
 * Pure functions over a built `WikiIndex` (`store.ts`) plus per-file content
 * reads. Findings are TRANSIENT — recomputed on demand from the wiki tree; there
 * is no DB table and nothing is written back to the wiki. The `wiki-linter`
 * watcher (report-only) and the `/api/wiki/linter-findings` route both call
 * `lintWiki`.
 *
 * Four checks, each finding `{ check, relPath, message, detail? }`:
 *  1. broken-link    — [[wikilink]] / relative .md link that resolves to no page.
 *  2. orphan         — a page with no inbound links (reserved files discounted as
 *                      both subjects and sole-linkers).
 *  3. stale-updated  — a frontmatter page missing `updated:` or with an
 *                      unparseable `updated:` value.
 *  4. missing-sources — a synthesized `concept` page that cites no sources (no
 *                      `## Sources` heading AND no `sources:` frontmatter).
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

export const LINT_CHECKS = ["broken-link", "orphan", "stale-updated", "missing-sources"] as const;
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
  counts: Record<string, number>;
  generatedAt: number;
}

/**
 * Reserved wiki-infrastructure basenames — never real content pages. Matches the
 * gardener's `FORBIDDEN_BASENAMES` (`src/gardener/draft.ts`). Skipped as orphan
 * subjects, discounted as orphan sole-linkers (an index-of-contents that links
 * everything must not mask a page that nothing else references), and skipped by
 * the stale-updated + missing-sources checks.
 */
const RESERVED_BASENAMES = new Set(["log.md", "index.md", "claude.md"]);

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

/** Missing / unparseable `updated:` frontmatter on a structured (frontmatter) page. */
function checkStaleUpdated(page: WikiPageMeta, content: string): LintFinding | null {
  // Only structured pages (those that carry a frontmatter fence) are held to the
  // `updated:` convention — a plain no-frontmatter markdown file isn't the
  // gardener's page shape, so flagging it would be reindex/hand-edit noise.
  if (!hasFrontmatterFence(content)) return null;

  const fm = parseFrontmatter(content);
  const updated = fm.updated;
  if (updated === undefined) {
    return { check: "stale-updated", relPath: page.relPath, message: "Missing frontmatter: updated:" };
  }
  // A single-line inline array (or any non-scalar) can't be a date.
  if (Array.isArray(updated) || Number.isNaN(Date.parse(updated))) {
    const shown = Array.isArray(updated) ? `[${updated.join(", ")}]` : updated;
    return {
      check: "stale-updated",
      relPath: page.relPath,
      message: `Unparseable updated: "${shown}"`,
    };
  }
  return null;
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
  const findings: LintFinding[] = [];

  for (const page of index.pages) {
    if (page.type === "explainer") continue; // no frontmatter, no links
    const content = await readFile(path.join(index.root, page.relPath));
    if (content === null) continue; // unreadable — skip, keep linting the rest

    // Broken links apply to every markdown page (a dead link in index.md is
    // still a dead link); the frontmatter-shaped checks skip reserved infra.
    findings.push(...checkBrokenLinks(page, content, index));

    if (!reservedBasename(page.relPath)) {
      const stale = checkStaleUpdated(page, content);
      if (stale) findings.push(stale);
      const sources = checkMissingSources(page, content);
      if (sources) findings.push(sources);
    }
  }

  findings.push(...checkOrphans(index));

  const counts: Record<string, number> = {};
  for (const c of LINT_CHECKS) counts[c] = 0;
  for (const f of findings) counts[f.check] = (counts[f.check] ?? 0) + 1;

  return { findings, counts, generatedAt: now() };
}
