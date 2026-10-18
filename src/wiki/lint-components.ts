/**
 * Lint check 15 — the author check (MDX component-contract plan, PR 2): a
 * component attribute the renderer silently falls back on, or drops.
 *
 *  - `component-value` — an attribute whose spec `parse` reports `fellBack`
 *    (`COMPONENT_SPEC`, `src/format/component-spec.ts`), or a missing
 *    `required` attribute (Meter `value`).
 *  - `component-attr` — an attribute `COMPONENT_ATTRS` does not list, which
 *    `parseAttrs` drops before any renderer sees it.
 *
 * An unknown tag name is not checked: it renders as visible escaped text, so it
 * is not a silent fallback.
 *
 * **Which tags count is the renderer's decision, not this file's.** A block tag
 * is one `parseBlocks` turned into a `ComponentBlock` (its `line`), re-read from
 * that line with `COMPONENT_OPEN_RE` and `ATTR_RE` so the dropped attributes are
 * still visible. An inline tag is one `scanInlineComponentTags` (the
 * `scanInlineComponents` match) finds on a body line. Tags starting in
 * frontmatter, a fence or an inline code span (`factProtectedRegions`) are
 * skipped. Imports nothing that reads the environment: `scripts/wiki-check.ts`
 * runs it with no `.env`.
 */

import {
  ATTR_RE,
  COMPONENT_OPEN_RE,
  factProtectedRegions,
  inProtectedRegion,
  parseBlocks,
  scanInlineComponentTags,
  type Block,
  type ComponentBlock,
} from "../format/markdown-ast.ts";
import { COMPONENT_ATTRS, COMPONENT_SPEC, type AttrSpec, type ComponentName, type ComponentSpec } from "../format/component-spec.ts";
import { attrAliasFor, hintFor, suggestFor } from "../format/component-docs.ts";
import { splitFrontmatter } from "./page-text.ts";

export const COMPONENT_LINT_CHECKS = ["component-value", "component-attr"] as const;
export type ComponentLintCheck = (typeof COMPONENT_LINT_CHECKS)[number];

export interface ComponentFinding {
  check: ComponentLintCheck;
  relPath: string;
  /** 1-based line of the tag's `<`. */
  line: number;
  message: string;
  detail: string;
}

const SPEC: Readonly<Record<ComponentName, ComponentSpec>> = COMPONENT_SPEC;

/** One tag as the source spells it. `col` is the offset of its `<` in the line. */
interface RawTag {
  name: ComponentName;
  attrs: string;
  line: number;
  col: number;
}

/** What a rejected value renders as, per component and attribute, in the
 *  renderer's own terms (`src/web/web-format.ts`). Only the attributes whose
 *  `parse` can fall back appear here; every other attribute is `parseString`. */
function fallbackMessage(name: ComponentName, attr: string, raw: string, attrs: Readonly<Record<string, string>>): string {
  const q = `${name} ${attr}=${JSON.stringify(raw)}`;
  const spec = SPEC[name].attrs[attr]!;
  if (name === "Callout" && attr === "tone" && readsResolved(attrs)) {
    return `${q} is not a tone; this resolved callout renders as a good row and ignores it`;
  }
  if (name === "Callout" && attr === "resolved") return `${q} is not an ISO date; the callout renders open, not resolved`;
  if (name === "Lane" && attr === "since") return `${q} has no age; shown as written`;
  if (name === "Meter" && attr === "value") return `${q} is not a number; its label renders as plain text`;
  if (name === "Meter" && attr === "max") return `${q} is not a positive number; the meter renders out of ${spec.default}`;
  return `${q} renders as ${spec.parse(undefined).value}`;
}

function readsResolved(attrs: Readonly<Record<string, string>>): boolean {
  return attrs.resolved !== undefined && SPEC.Callout.attrs.resolved!.parse(attrs.resolved).value !== null;
}

/** The accepted values an attribute's detail line names. */
function acceptedText(name: ComponentName, attr: string, spec: AttrSpec): string {
  if (name === "Fact" && attr === "v") return `${spec.enum!.join("|")} or ✅ ⚠️ ❌ ❓`;
  if (spec.enum) return spec.enum.join("|");
  if (name === "Callout" && attr === "resolved") return "an ISO date, YYYY-MM-DD";
  if (name === "Lane" && attr === "since") return "an ISO date, YYYY-MM-DD, or DD.MM.YYYY";
  if (name === "Meter" && attr === "max") return "a positive number";
  if (name === "Meter" && attr === "value") return "a number";
  return "see the component reference";
}

/** The accepted value `raw` most likely meant: the docs' suggestion, else the
 *  enum value `raw` spells in another case or with padding. */
function suggestion(name: ComponentName, attr: string, raw: string, spec: AttrSpec): string | undefined {
  const s = suggestFor(name, attr, raw);
  if (s !== undefined) return s;
  const folded = raw.trim().toLowerCase();
  return spec.enum?.find((v) => v === folded);
}

function valueDetail(name: ComponentName, attr: string, raw: string, spec: AttrSpec): string {
  const parts = [`Accepted: ${acceptedText(name, attr, spec)}.`];
  const s = suggestion(name, attr, raw, spec);
  if (s !== undefined) parts.push(`Did you mean ${s}?`);
  const h = hintFor(name, attr, raw);
  if (h !== undefined) parts.push(`${h}.`);
  return parts.join(" ");
}

function attrDetail(name: ComponentName, attr: string, raw: string): string {
  const listed = COMPONENT_ATTRS[name];
  const parts = [listed.length > 0 ? `${name} takes ${listed.join(", ")}.` : `${name} takes no attributes.`];
  const alias = attrAliasFor(name, attr);
  if (alias !== undefined) {
    const spec = SPEC[name].attrs[alias];
    const v = spec ? (spec.parse(raw).fellBack ? suggestion(name, alias, raw, spec) : raw) : undefined;
    parts.push(v !== undefined ? `Did you mean ${alias}=${JSON.stringify(v)}?` : `Did you mean ${alias}?`);
  }
  return parts.join(" ");
}

/** The findings for one tag. The last spelling of a repeated attribute is the
 *  one `parseAttrs` keeps, so it is the one judged. */
function checkTag(relPath: string, tag: RawTag): ComponentFinding[] {
  const out: ComponentFinding[] = [];
  const at = { relPath, line: tag.line + 1 };
  const listed = COMPONENT_ATTRS[tag.name];
  const known: Record<string, string> = {};
  const unknown = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tag.attrs)) !== null) {
    const [, key, value] = m as unknown as [string, string, string];
    if (listed.includes(key)) known[key] = value;
    else unknown.set(key, value);
  }
  for (const [key, value] of unknown) {
    out.push({
      check: "component-attr",
      ...at,
      message: `${tag.name} ${key}=${JSON.stringify(value)} is not a ${tag.name} attribute; the renderer drops it`,
      detail: attrDetail(tag.name, key, value),
    });
  }
  const attrs = SPEC[tag.name].attrs;
  // A Meter with no usable value renders its label only, so its tone and max
  // render nothing: the value finding is the one that is true.
  const meterless = tag.name === "Meter" && attrs.value!.parse(known.value).value === null;
  for (const [attr, spec] of Object.entries(attrs)) {
    const raw = known[attr];
    if (spec.required && (raw === undefined || raw.trim() === "")) {
      out.push({
        check: "component-value",
        ...at,
        message: `${tag.name} has no ${attr}; its label renders as plain text`,
        detail: `Accepted: ${acceptedText(tag.name, attr, spec)}.`,
      });
      continue;
    }
    // An empty value renders as a missing one: not a fallback a reader sees.
    if (raw === undefined || raw.trim() === "") continue;
    if (meterless && attr !== "value") continue;
    if (!spec.parse(raw).fellBack) continue;
    out.push({
      check: "component-value",
      ...at,
      message: fallbackMessage(tag.name, attr, raw, known),
      detail: valueDetail(tag.name, attr, raw, spec),
    });
  }
  return out;
}

/** The block components `parseBlocks` built, keyed by their 0-based body line,
 *  in pre-order — a single-line form's nested tag follows its parent. */
function blockLines(blocks: Block[], into: Map<number, ComponentBlock[]>): void {
  for (const b of blocks) {
    if (b.type !== "component") continue;
    if (b.line !== undefined) into.set(b.line, [...(into.get(b.line) ?? []), b]);
    blockLines(b.children, into);
  }
}

/** The raw tags of the blocks claimed on one line, re-read the way
 *  `tryParseComponent` read them: the open tag on the trimmed line, and a
 *  single-line form's content the same way again. */
function claimedTags(text: string, line: number, blocks: readonly ComponentBlock[]): RawTag[] {
  const out: RawTag[] = [];
  let rest = text;
  let col = 0;
  for (const b of blocks) {
    const lead = rest.length - rest.trimStart().length;
    col += lead;
    rest = rest.slice(lead).trimEnd();
    const m = rest.match(COMPONENT_OPEN_RE);
    if (!m || m[1] !== b.name) break; // the parser read this line some other way
    out.push({ name: b.name, attrs: m[2]!, line, col });
    const tail = m[4]!;
    col += rest.length - tail.length;
    const close = tail.indexOf(`</${b.name}>`);
    rest = close === -1 ? tail : tail.slice(0, close);
  }
  return out;
}

/**
 * Every component finding on one page. Pure; `lintWiki` calls it on `.mdx`
 * pages and `scripts/wiki-check.ts` on the files it walks.
 */
export function checkComponents(relPath: string, content: string): ComponentFinding[] {
  if (!content.includes("<")) return [];
  const lines = content.split("\n");
  const { body } = splitFrontmatter(content);
  // Lines the frontmatter split removed: a block's `line` counts from the body.
  const bodyAt = content.slice(0, content.length - body.length).split("\n").length - 1;
  const regions = factProtectedRegions(content);
  const lineStart: number[] = [];
  for (let i = 0, off = 0; i < lines.length; i++) {
    lineStart.push(off);
    off += lines[i]!.length + 1;
  }
  const masked = (line: number, col: number) => inProtectedRegion(lineStart[line]! + col, regions);

  const byLine = new Map<number, ComponentBlock[]>();
  blockLines(parseBlocks(body), byLine);
  const tags: RawTag[] = [];
  const claimedAt = new Set<string>();
  for (const [bodyLine, blocks] of byLine) {
    const line = bodyAt + bodyLine;
    for (const t of claimedTags(lines[line] ?? "", line, blocks)) {
      claimedAt.add(`${t.line}:${t.col}`);
      if (!masked(t.line, t.col)) tags.push(t);
    }
  }
  for (let line = bodyAt; line < lines.length; line++) {
    for (const t of scanInlineComponentTags(lines[line]!)) {
      if (claimedAt.has(`${line}:${t.index}`) || masked(line, t.index)) continue;
      tags.push({ name: t.name, attrs: t.attrs, line, col: t.index });
    }
  }
  tags.sort((a, b) => a.line - b.line || a.col - b.col);
  return tags.flatMap((t) => checkTag(relPath, t));
}
