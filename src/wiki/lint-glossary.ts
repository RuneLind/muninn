/**
 * Lint check 19 — what a `<Glossary>` cannot do. One key, `glossary`, page
 * text only (`checkPageText`, so `wiki-check` reports it). It reads the page
 * through `pageGlossaries` (`render.ts`), the reading the reader marks from:
 *
 * - warning: the block holds no term; a term defined twice on the page (the
 *   first definition is the one shown);
 * - info: a list item with no emphasised term.
 *
 * Whether the page uses a term is not checked: measured on 88 glossaries, most
 * such findings were legend entries no matcher can match.
 */

import { fencedLineMask } from "../dashboard/views/components/wiki-integrate.ts";
import { stripFrontmatter, type WikiPageMeta } from "./store.ts";
import { WIKILINK_WITH_LABEL_RE, wikiLinkText } from "./decision-text.ts";
import { pageGlossaries } from "./render.ts";
import type { LintFinding } from "./lint.ts";

export const GLOSSARY_LINT_CHECKS = ["glossary"] as const;

/** The first unfenced place at or after (`line`, `col`), both 0-based, where
 *  `head` starts. A read has its line breaks as spaces, so whitespace runs match
 *  each other and the probe reads on across line breaks; only the page's end
 *  cuts it short (a paragraph that ends in the head's first word is no match). */
function findFrom(lines: readonly string[], fenced: readonly boolean[], line: number, col: number, head: string): { line: number; col: number } | undefined {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const want = flat(head);
  const lead = want.split(" ")[0]!;
  for (let i = line; i < lines.length; i++) {
    if (fenced[i]) continue;
    const text = lines[i]!;
    for (let at = text.indexOf(lead, i === line ? col : 0); at >= 0; at = text.indexOf(lead, at + 1)) {
      let rest = text.slice(at);
      for (let j = i + 1; flat(rest).length < want.length && j < lines.length; j++) rest += "\n" + lines[j];
      const got = flat(rest).trimEnd();
      if (got.startsWith(want) || want.startsWith(got)) return { line: i, col: at };
    }
  }
  return undefined;
}

export function checkGlossaries(page: Pick<WikiPageMeta, "relPath">, rawContent: string): LintFinding[] {
  if (!rawContent.includes("<Glossary")) return [];
  const body = stripFrontmatter(rawContent);
  const bodyAt = rawContent.slice(0, rawContent.length - body.length).split("\n").length - 1;
  const reads = pageGlossaries(body);
  if (reads.length === 0) return [];
  // The entries' source text has its wikilinks read as text; so do these lines
  // (a link never spans a line, so the line numbers hold).
  const lines = body.replace(WIKILINK_WITH_LABEL_RE, (_w: string, t: string, l?: string) => wikiLinkText(t, l)).split("\n");
  const fenced = fencedLineMask(lines);
  const findings: LintFinding[] = [];
  for (const read of reads) {
    const tagLine = read.line === undefined ? undefined : read.line + 1;
    // Each read's line, found in source order from the tag down (two sentences
    // can share a line, so the search resumes after the last match's column).
    const readLine: (number | undefined)[] = [];
    let line = tagLine;
    let col = -1;
    for (const text of read.reads) {
      const head = text.split("\n")[0]!.trim();
      const found = head !== "" && line !== undefined ? findFrom(lines, fenced, line, col + 1, head) : undefined;
      readLine.push(found ? found.line + 1 : undefined);
      if (found) ({ line, col } = found);
    }
    const push = (message: string, level: "warning" | "info", index?: number) => {
      const at = (index === undefined ? undefined : readLine[index]) ?? tagLine;
      findings.push({
        check: "glossary",
        relPath: page.relPath,
        message: `<Glossary> ${message}`,
        ...(at === undefined ? {} : { line: bodyAt + at }),
        ...(level === "info" ? { severity: "info" as const } : {}),
      });
    };
    for (const f of read.findings) push(f.message, f.level, f.at);
  }
  return findings;
}
