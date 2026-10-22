/**
 * Lint checks for `<SystemMap>` (wiki visuals v2, PR 4). Two keys:
 *
 * - `system-map` — page text only (`checkPageText`, so `wiki-check` reports
 *   it), on any page that is not culled (the reader draws a map on `.md`
 *   pages too, so the gate is not check 15's `.mdx` one): what the block cannot read,
 *   from `readSystemMap` (`src/format/system-map.ts`), the reading the
 *   reader draws from. No table or no From/To column stops the map; the rest
 *   (an unknown Status, a `wrong` row with no evidence, an `external=` or
 *   `groups=` entry naming no row) are drawn around.
 * - `system-map-drift` — reads the whole wiki (`lintWiki` only, never
 *   `wiki-check`): a node name that resolves to neither a `repos/` page nor a
 *   declared external, and, for the pairs whose two ends both resolve to
 *   `repos/` pages (D10), drift between the table and the repos pages' link
 *   sections: a `wrong` row a page still links, an `ok` row neither end
 *   links, and a link between two table nodes with no row. The map is an
 *   authored table (D5): links carry no direction or protocol, so they only
 *   check it.
 *
 * A link section is a heading named in `.wiki-reader.json`
 * `systemMapLinkHeadings` (default {@link SYSTEM_MAP_LINK_HEADINGS_DEFAULT}),
 * matched exactly once a trailing parenthetical is dropped from both sides
 * ({@link linkHeadingMatches}), down to the next heading of any level. Its links are `[[wikilinks]]` and relative markdown links
 * outside code fences and code spans, resolved the way `broken-link` resolves
 * them.
 */

import path from "node:path";
import { chartBody, chartTable } from "../format/chart-block.ts";
import { parseBlocks, type Block } from "../format/markdown-ast.ts";
import { visibleText } from "../format/report-top.ts";
import { nodeKey, readSystemMap, resolveSystemNode, type SystemMapRead } from "../format/system-map.ts";
import { fencedLineMask } from "../dashboard/views/components/wiki-integrate.ts";
import { stripLineCodeSpansKeepingLinks } from "./park-links.ts";
import { extractMarkdownLinks, stripFrontmatter, type WikiIndex, type WikiPageMeta } from "./store.ts";
import { extractWikilinks } from "./wikilinks.ts";
import { findUnfencedLine } from "./lint-lines.ts";
import { WIKILINK_WITH_LABEL_RE, wikiLinkText } from "./decision-text.ts";
import type { LintFinding } from "./lint.ts";

export const SYSTEM_MAP_LINT_CHECKS = ["system-map"] as const;
export const SYSTEM_MAP_DRIFT_LINT_CHECKS = ["system-map-drift"] as const;

/** The link sections read when `.wiki-reader.json` names none. */
export const SYSTEM_MAP_LINK_HEADINGS_DEFAULT: readonly string[] = ["External integrations", "Related repos", "Related", "Integrasjoner"];

/** A heading's text with one trailing parenthetical dropped, trimmed:
 *  «External integrations (all mocked)» → «External integrations». */
export function linkHeadingName(text: string): string {
  return text.trim().replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/** A heading matches when its name ({@link linkHeadingName}) equals the name
 *  of one of `headings` exactly: «Related concepts» is not «Related». */
export function linkHeadingMatches(text: string, headings: readonly string[]): boolean {
  const name = linkHeadingName(text);
  return headings.some((h) => linkHeadingName(h) === name);
}

/** One `<SystemMap>` block as both checks read it. */
interface MapBlock {
  read: SystemMapRead;
  caption: string;
  /** 1-based line of the tag. */
  tagLine?: number;
  /** 1-based line of a data row. */
  rowLine: (row: number) => number | undefined;
}

function componentBlocks(blocks: readonly Block[], name: string): Extract<Block, { type: "component" }>[] {
  const out: Extract<Block, { type: "component" }>[] = [];
  const walk = (bs: readonly Block[]) => {
    for (const b of bs) {
      if (b.type !== "component") continue;
      if (b.name === name) out.push(b);
      else walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/** Every `<SystemMap>` on a page, read as the reader reads it: wikilinks
 *  parked first, so a `|` in `[[t|l]]` splits no cell, and handed back as
 *  their `[[…]]` source in cells and in `external=`/`groups=` (a node names a
 *  link's target), as their text in the caption. */
export function systemMapBlocks(rawContent: string): MapBlock[] {
  if (!rawContent.includes("<SystemMap")) return [];
  const body = stripFrontmatter(rawContent);
  const bodyAt = rawContent.slice(0, rawContent.length - body.length).split("\n").length - 1;
  const lines = rawContent.split("\n");
  const fenced = fencedLineMask(lines);
  const links: { source: string; text: string }[] = [];
  const parked = body.replace(WIKILINK_WITH_LABEL_RE, (w: string, t: string, l?: string) => `\x00L${links.push({ source: w, text: wikiLinkText(t, l) }) - 1}\x00`);
  const unpark = (raw: string, as: "source" | "text") => raw.replace(/\x00L(\d+)\x00/g, (_m, i: string) => links[Number(i)]?.[as] ?? "");
  // The sentinels pass through `visibleText` untouched, so a link comes back whole.
  const cellText = (raw: string) => unpark(visibleText(raw), "source");
  const attrsOf = (attrs: Record<string, string>) => {
    const out = { ...attrs };
    for (const k of ["external", "groups"] as const) if (out[k] !== undefined) out[k] = unpark(out[k], "source");
    return out;
  };
  return componentBlocks(parseBlocks(parked), "SystemMap").map((block) => {
    const { table } = chartBody(block.children);
    const tagLine = block.line === undefined ? undefined : bodyAt + block.line + 1;
    const headerLine = tagLine === undefined ? undefined : findUnfencedLine(lines, fenced, tagLine, (l) => l.trim().startsWith("|"));
    return {
      read: readSystemMap(attrsOf(block.attrs), table ? chartTable(table, cellText) : null),
      caption: block.attrs.caption === undefined ? "" : visibleText(unpark(block.attrs.caption, "text")).trim(),
      tagLine,
      rowLine: (row: number) => (headerLine === undefined ? tagLine : headerLine + 2 + row),
    };
  });
}

function tagOf(b: Pick<MapBlock, "caption">): string {
  return b.caption ? `<SystemMap caption="${b.caption}">` : "<SystemMap>";
}

/** `system-map`: what one page's maps cannot read. */
export function checkSystemMaps(page: Pick<WikiPageMeta, "relPath">, rawContent: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const b of systemMapBlocks(rawContent)) {
    for (const f of b.read.findings) {
      const line = f.row !== undefined ? b.rowLine(f.row) : b.tagLine;
      findings.push({
        check: "system-map",
        relPath: page.relPath,
        message: `${tagOf(b)} ${f.message}${f.fatal ? "; it renders as its table" : ""}`,
        ...(line === undefined ? {} : { line }),
      });
    }
  }
  return findings;
}

/** A link section: its heading as written and its links' resolved relPaths. */
export interface LinkSection {
  heading: string;
  targets: string[];
}

/**
 * The link sections of one page and the pages each links to. A section ends
 * at the next heading of any level, so a «Related concepts» under «Related»
 * is not read. Fenced lines are neither headings nor links; code spans hold
 * no link, and a link whose label holds a backtick is still one.
 */
export function linkSections(page: Pick<WikiPageMeta, "relPath">, rawContent: string, headings: readonly string[], index: Pick<WikiIndex, "resolve" | "resolveRelPath">): LinkSection[] {
  const body = stripFrontmatter(rawContent);
  const lines = body.split("\n");
  const fenced = fencedLineMask(lines);
  const out: LinkSection[] = [];
  const dir = path.posix.dirname(page.relPath);
  let open: { heading: string; lines: string[] } | null = null;
  const close = () => {
    if (!open) return;
    const text = open.lines.join("\n");
    const targets = new Set<string>();
    for (const t of extractWikilinks(text)) {
      const hit = index.resolve(t);
      if (hit) targets.add(hit.relPath);
    }
    for (const raw of extractMarkdownLinks(text)) {
      const joined = path.posix.normalize(path.posix.join(dir, raw));
      if (joined === ".." || joined.startsWith("../")) continue;
      const hit = index.resolveRelPath(joined);
      if (hit) targets.add(hit.relPath);
    }
    out.push({ heading: open.heading, targets: [...targets] });
    open = null;
  };
  lines.forEach((line, i) => {
    if (fenced[i]) return;
    const h = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      close();
      if (linkHeadingMatches(h[1]!, headings)) open = { heading: linkHeadingName(h[1]!), lines: [] };
      return;
    }
    open?.lines.push(stripLineCodeSpansKeepingLinks(line));
  });
  close();
  return out;
}

/** A hub page and its text: a page holding a `<SystemMap>`. */
export interface SystemMapPage {
  page: Pick<WikiPageMeta, "relPath" | "culled">;
  content: string;
}

/**
 * `system-map-drift` over the wiki's hub pages. `readContent` reads a page by
 * relPath (the repos pages' text); a page it cannot read links nothing.
 */
export async function checkSystemMapDrift(
  index: Pick<WikiIndex, "resolve" | "resolveRelPath" | "readerConfig">,
  hubs: readonly SystemMapPage[],
  readContent: (relPath: string) => Promise<string | null>,
): Promise<LintFinding[]> {
  const headings = index.readerConfig?.systemMapLinkHeadings ?? SYSTEM_MAP_LINK_HEADINGS_DEFAULT;
  const sectionsMemo = new Map<string, Promise<LinkSection[]>>();
  const sectionsOf = (relPath: string) => {
    let p = sectionsMemo.get(relPath);
    if (!p) {
      p = readContent(relPath).then((c) => (c === null ? [] : linkSections({ relPath }, c, headings, index)));
      sectionsMemo.set(relPath, p);
    }
    return p;
  };
  const findings: LintFinding[] = [];
  for (const hub of hubs) {
    for (const b of systemMapBlocks(hub.content)) {
      if (!b.read.drawable) continue;
      const push = (message: string, line: number | undefined, detail?: string) =>
        findings.push({ check: "system-map-drift", relPath: hub.page.relPath, message: `${tagOf(b)} ${message}`, ...(detail ? { detail } : {}), ...(line === undefined ? {} : { line }) });

      // Node → repos page (relPath), for the nodes drift compares.
      const repoOf = new Map<string, string>();
      for (const node of b.read.nodes) {
        const r = resolveSystemNode(node, index.resolve);
        if (r.kind === "repo") repoOf.set(node.key, r.page.relPath);
        else if (r.kind === "unresolved") push(`node "${node.name}" resolves to no repos/ page and is not listed in external=`, b.tagLine);
      }
      const nodeOfPage = new Map<string, string>();
      for (const [key, rel] of repoOf) nodeOfPage.set(rel.toLowerCase(), key);
      const nameOf = new Map(b.read.nodes.map((n) => [n.key, n.name]));

      // Each repos node's links to other repos nodes, with the section that holds them.
      const links = new Map<string, Map<string, string>>();
      for (const [key, rel] of repoOf) {
        const m = new Map<string, string>();
        for (const s of await sectionsOf(rel)) {
          for (const t of s.targets) {
            const other = nodeOfPage.get(t.toLowerCase());
            if (other && other !== key && !m.has(other)) m.set(other, s.heading);
          }
        }
        links.set(key, m);
      }
      const linkedBy = (a: string, b2: string): string[] => {
        const out: string[] = [];
        const ab = links.get(a)?.get(b2);
        if (ab) out.push(`${repoOf.get(a)} («${ab}»)`);
        const ba = links.get(b2)?.get(a);
        if (ba) out.push(`${repoOf.get(b2)} («${ba}»)`);
        return out;
      };

      // Links carry no direction or protocol: a wrong row's link is the one an
      // ok row for the same unordered pair needs, so that pair is not reported.
      const pairOf = (r: { from: string; to: string }) => [nodeKey(r.from), nodeKey(r.to)].sort().join("\u0000");
      const rowPairs = new Set(b.read.rows.map(pairOf));
      const okPairs = new Set(b.read.rows.filter((r) => r.status === "ok").map(pairOf));
      for (const r of b.read.rows) {
        const a = nodeKey(r.from);
        const c = nodeKey(r.to);
        if (a === c || !repoOf.has(a) || !repoOf.has(c) || r.status === null) continue;
        const by = linkedBy(a, c);
        if (r.status === "wrong" && by.length > 0 && !okPairs.has(pairOf(r))) {
          push(`row ${r.from} → ${r.to} is wrong, but ${by.join(" and ")} still links it`, b.rowLine(r.row), r.evidence ? `evidence: ${r.evidence}` : undefined);
        } else if (r.status === "ok" && by.length === 0) {
          push(`row ${r.from} → ${r.to} is ok, but neither ${repoOf.get(a)} nor ${repoOf.get(c)} links the other in a link section`, b.rowLine(r.row), `link sections: ${headings.join(", ")}`);
        }
      }
      const reported = new Set<string>();
      for (const [a, m] of links) {
        for (const [c] of m) {
          const pair = [a, c].sort().join("\u0000");
          if (rowPairs.has(pair) || reported.has(pair)) continue;
          reported.add(pair);
          push(`has no row between ${nameOf.get(a)} and ${nameOf.get(c)}, but ${linkedBy(a, c).join(" and ")} links them`, b.tagLine);
        }
      }
    }
  }
  return findings;
}
