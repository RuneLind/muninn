/**
 * Lint check 15 — the author check (MDX component-contract plan, PR 2): a
 * component attribute the renderer silently falls back on, or drops.
 *
 *  - `component-value` — an attribute whose spec `parse` reports `fellBack`
 *    (`COMPONENT_SPEC`, `src/format/component-spec.ts`), or a missing
 *    `required` attribute (Meter `value`). An empty value reads as a missing
 *    one there, so it is reported only where missing is itself a fallback.
 *  - `component-attr` — an attribute `COMPONENT_ATTRS` does not list, which
 *    `parseAttrs` drops before any renderer sees it.
 *
 * Not reported: an unknown tag name (it renders as visible escaped text), the
 * `parseString` attributes, and the other attributes of a component whose
 * `required` attribute is unusable (they render nothing).
 *
 * **The renderer decides which tags count.** The page is rendered through the
 * reader's own `renderWikiHtml` under `observeComponentTags`, which reports
 * every tag the block parser accepts and every tag the inline scanner matches,
 * with its raw attributes. Frontmatter, fences, code spans, table cells and the
 * depth cap are therefore the renderer's own; this file masks nothing.
 *
 * **Where a tag is** comes from a second render of the same page with a marker
 * attribute (`muninnlintmark="N"`) inserted after every `<Name` of a component
 * name in the body. A marker is a valid, unlisted attribute: it changes no tag
 * shape the parser or the scanner tests, and `parseAttrs` drops it. The marked
 * render's reports carry the marker, so each finding names the exact source
 * offset. Its reports are used only when they equal the plain render's, tag for
 * tag; otherwise the plain render's findings are returned without a line.
 *
 * Imports nothing that reads the environment: `scripts/wiki-check.ts` runs it
 * with no `.env`.
 */

import { ATTR_RE, observeComponentTags, type ObservedComponentTag } from "../format/markdown-ast.ts";
import { COMPONENT_ATTRS, COMPONENT_NAMES, COMPONENT_SPEC, type AttrSpec, type ComponentName, type ComponentSpec } from "../format/component-spec.ts";
import { COMPONENT_DOCS, attrAliasFor, attrDoc, hintFor, suggestFor, type ComponentDoc } from "../format/component-docs.ts";
import { renderWikiHtml } from "./render.ts";
import { splitFrontmatter } from "./page-text.ts";
import type { LintFinding } from "./lint.ts";

export const COMPONENT_LINT_CHECKS = ["component-value", "component-attr"] as const;

const SPEC: Readonly<Record<ComponentName, ComponentSpec>> = COMPONENT_SPEC;

/** The marker attribute's name. Not a spec attribute of any component. */
export const LINT_MARK_ATTR = "muninnlintmark";
const MARK_RE = new RegExp(`^\\s+${LINT_MARK_ATTR}="(\\d+)"`);
const NAME_RE = new RegExp(`<(${COMPONENT_NAMES.join("|")})(?=[\\s/>])`, "g");

/** One observed tag, with the 1-based line and offset of its `<` when known. */
interface Tag {
  name: ComponentName;
  attrs: string;
  line?: number;
  offset?: number;
}

const isBlank = (raw: string | undefined) => raw === undefined || raw.trim() === "";

/** The accepted values an attribute's detail line names. */
function acceptedText(name: ComponentName, attr: string, spec: AttrSpec): string {
  const doc = attrDoc(name, attr);
  if (spec.enum) return doc?.alsoAccepts ? `${spec.enum.join("|")} or ${doc.alsoAccepts.join(" ")}` : spec.enum.join("|");
  return doc?.accepts ?? "see the component reference";
}

/** What a rejected value does, from `component-docs.ts`. */
function fallbackPhrase(name: ComponentName, attr: string, spec: AttrSpec, known: Readonly<Record<string, string>>): string {
  const doc = attrDoc(name, attr);
  const when = doc?.onFallbackWhen;
  if (when) {
    const other = SPEC[name].attrs[when.attr];
    const raw = known[when.attr];
    if (other && !isBlank(raw) && !other.parse(raw).fellBack) return when.message;
  }
  if (doc?.onFallback) return doc.onFallback.replace("{default}", String(spec.default));
  return `renders as ${spec.parse(undefined).value}`;
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
function checkTag(relPath: string, tag: Tag): LintFinding[] {
  const out: LintFinding[] = [];
  const at = tag.line === undefined ? { relPath } : { relPath, line: tag.line };
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
  const attrs = Object.entries(SPEC[tag.name].attrs);
  const doc = COMPONENT_DOCS[tag.name] as ComponentDoc;
  // A required attribute that is missing or rejected: the component renders
  // without the others, so that finding is the only true one.
  for (const [attr, spec] of attrs) {
    if (!spec.required) continue;
    const raw = known[attr];
    if (isBlank(raw)) {
      out.push({
        check: "component-value",
        ...at,
        message: `${tag.name} has no ${attr}; ${doc.onMissingRequired ?? fallbackPhrase(tag.name, attr, spec, known)}`,
        detail: `Accepted: ${acceptedText(tag.name, attr, spec)}.`,
      });
      return out;
    }
    if (spec.parse(raw).fellBack) {
      out.push({
        check: "component-value",
        ...at,
        message: `${tag.name} ${attr}=${JSON.stringify(raw)} ${fallbackPhrase(tag.name, attr, spec, known)}`,
        detail: valueDetail(tag.name, attr, raw!, spec),
      });
      return out;
    }
  }
  for (const [attr, spec] of attrs) {
    const raw = known[attr];
    if (raw === undefined || !spec.parse(raw).fellBack) continue;
    out.push({
      check: "component-value",
      ...at,
      message: `${tag.name} ${attr}=${JSON.stringify(raw)} ${fallbackPhrase(tag.name, attr, spec, known)}`,
      detail: valueDetail(tag.name, attr, raw, spec),
    });
  }
  return out;
}

/** Renders a page the way the reader does. A seam, so a test can make the two
 *  renders disagree. */
export type PageRender = (content: string) => unknown;
const readerRender: PageRender = (content) => renderWikiHtml(content, () => undefined);

function observe(render: PageRender, content: string): ObservedComponentTag[] {
  const seen: ObservedComponentTag[] = [];
  observeComponentTags((t) => seen.push(t), () => render(content));
  return seen;
}

/** `content` with a marker after every `<Name` in the body, and each marker's
 *  offset in `content`. Frontmatter is left byte for byte. */
function markBody(content: string): { marked: string; offsets: number[] } {
  const bodyAt = content.length - splitFrontmatter(content).body.length;
  const offsets: number[] = [];
  const body = content.slice(bodyAt).replace(NAME_RE, (whole: string, _name: string, offset: number) => {
    offsets.push(bodyAt + offset);
    return `${whole} ${LINT_MARK_ATTR}="${offsets.length - 1}"`;
  });
  return { marked: content.slice(0, bodyAt) + body, offsets };
}

const tagKey = (t: { name: string; inline: boolean; rawAttrs: string }) => `${t.name}\u0000${t.inline}\u0000${t.rawAttrs}`;

/** The marked render's tags with their source offsets, or null when they are
 *  not, tag for tag, the plain render's. */
function locate(render: PageRender, content: string, plain: readonly ObservedComponentTag[]): Tag[] | null {
  const { marked, offsets } = markBody(content);
  const tags: Tag[] = [];
  const keys: string[] = [];
  for (const t of observe(render, marked)) {
    const mark = MARK_RE.exec(t.rawAttrs);
    const offset = mark ? offsets[Number(mark[1])] : undefined;
    if (offset === undefined) return null;
    const attrs = t.rawAttrs.slice(mark![0].length);
    keys.push(tagKey({ ...t, rawAttrs: attrs }));
    tags.push({ name: t.name, attrs, offset, line: lineAt(content, offset) });
  }
  const want = plain.map(tagKey).sort();
  keys.sort();
  if (want.length !== keys.length || want.some((k, i) => k !== keys[i])) return null;
  return tags;
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < offset; i = content.indexOf("\n", i + 1)) line++;
  return line;
}

/**
 * Every component finding on one page, in source order. Pure apart from the
 * render; `lintWiki` calls it on `.mdx` pages and `scripts/wiki-check.ts` on
 * the files it walks. A tag the renderer reads twice (a fold body is rendered
 * twice) is one finding: findings are deduped on (line, name, attribute, value).
 */
export function checkComponents(relPath: string, content: string, render: PageRender = readerRender): LintFinding[] {
  if (!content.includes("<")) return [];
  const plain = observe(render, content);
  const unlocated = plain.flatMap((t) => checkTag(relPath, { name: t.name, attrs: t.rawAttrs }));
  if (unlocated.length === 0) return [];
  const tags = locate(render, content, plain);
  if (tags === null) return dedupe(unlocated);
  tags.sort((a, b) => a.offset! - b.offset!);
  return dedupe(tags.flatMap((t) => checkTag(relPath, t)));
}

function dedupe(findings: LintFinding[]): LintFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.line}\u0000${f.check}\u0000${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
