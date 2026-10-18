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
 * name in the body, except inside the quoted value of a well-formed opener. A
 * marker is a valid, unlisted attribute: it changes no tag shape the parser or
 * the scanner tests, and `parseAttrs` drops it. The marked render's reports
 * carry the marker, so each finding names the exact source offset. Its reports
 * are used only when they equal the plain render's, tag for tag; otherwise the
 * plain render's findings are returned without a line.
 *
 * A page with no tag the check could judge is not rendered, and results are
 * memoized on relPath + content (`checkComponents`). A finding judges the value
 * the renderer read and prints the source text (`shownValues`).
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

/** One observed tag, with the 1-based line and offset of its `<` when known.
 *  `sourceAttrs` is the attribute run as written at that offset. */
interface Tag {
  name: ComponentName;
  attrs: string;
  sourceAttrs?: string;
  line?: number;
  offset?: number;
}

/** A parked wikilink or code span (`\u0000WIKIPAGELINK0\u0000`, `\u0000INLINE0\u0000`). */
const SENTINEL_RE = /\u0000[A-Z]+\d+\u0000/g;

const attrList = (attrs: string): [string, string][] => {
  const out: [string, string][] = [];
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrs)) !== null) out.push([m[1]!, m[2]!]);
  return out;
};

/**
 * What a finding prints for each attribute value. The renderer reads a value
 * after parking its wikilinks and code spans, so the judged value can hold a
 * sentinel. A located tag prints the value as written in the source, when its
 * source attributes line up with the renderer's key for key; otherwise each
 * sentinel prints as `…`.
 */
function shownValues(tag: Tag): Map<string, string> {
  const read = attrList(tag.attrs);
  const written = tag.sourceAttrs === undefined ? [] : attrList(tag.sourceAttrs);
  const aligned = written.length === read.length && written.every(([k], i) => k === read[i]![0]);
  const shown = new Map<string, string>();
  read.forEach(([key, value], i) => {
    if (!value.includes("\u0000")) shown.set(key, value);
    else shown.set(key, aligned ? written[i]![1] : value.replace(SENTINEL_RE, "…").replaceAll("\u0000", ""));
  });
  return shown;
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

/** `raw` is the value the renderer read; `shown` the one the finding prints. */
function attrDetail(name: ComponentName, attr: string, raw: string, shown: string): string {
  const listed = COMPONENT_ATTRS[name];
  const parts = [listed.length > 0 ? `${name} takes ${listed.join(", ")}.` : `${name} takes no attributes.`];
  const alias = attrAliasFor(name, attr);
  if (alias !== undefined) {
    const spec = SPEC[name].attrs[alias];
    const v = spec ? (spec.parse(raw).fellBack ? suggestion(name, alias, shown, spec) : shown) : undefined;
    parts.push(v !== undefined ? `Did you mean ${alias}=${JSON.stringify(v)}?` : `Did you mean ${alias}?`);
  }
  return parts.join(" ");
}

/** The findings for one tag. The last spelling of a repeated attribute is the
 *  one `parseAttrs` keeps, so it is the one judged. Judging reads the value the
 *  renderer read; the message prints {@link shownValues}. */
function checkTag(relPath: string, tag: Tag): LintFinding[] {
  const out: LintFinding[] = [];
  const at = tag.line === undefined ? { relPath } : { relPath, line: tag.line };
  const listed = COMPONENT_ATTRS[tag.name];
  const known: Record<string, string> = {};
  const unknown = new Map<string, string>();
  for (const [key, value] of attrList(tag.attrs)) {
    if (listed.includes(key)) known[key] = value;
    else unknown.set(key, value);
  }
  const shownMap = shownValues(tag);
  const shown = (key: string) => shownMap.get(key)!;
  for (const [key, value] of unknown) {
    out.push({
      check: "component-attr",
      ...at,
      message: `${tag.name} ${key}=${JSON.stringify(shown(key))} is not a ${tag.name} attribute; the renderer drops it`,
      detail: attrDetail(tag.name, key, value, shown(key)),
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
        message: `${tag.name} ${attr}=${JSON.stringify(shown(attr))} ${fallbackPhrase(tag.name, attr, spec, known)}`,
        detail: valueDetail(tag.name, attr, shown(attr), spec),
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
      message: `${tag.name} ${attr}=${JSON.stringify(shown(attr))} ${fallbackPhrase(tag.name, attr, spec, known)}`,
      detail: valueDetail(tag.name, attr, shown(attr), spec),
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

/** The attribute run the parser and the inline scanner read after a tag name,
 *  and whether a `>` or `/>` closes it (`COMPONENT_OPEN_RE`, `INLINE_COMPONENT_RE`). */
const OPENER_RUN_RE = /(?:\s+[A-Za-z][\w-]*="[^"]*")*(?=\s*\/?>)/y;
/** The attribute run after a tag name in the source, closed or not. */
const SOURCE_RUN_RE = /(?:\s+[A-Za-z][\w-]*="[^"]*")*/y;

/**
 * `content` with a marker after every `<Name` in the body, and each marker's
 * offset in `content`. Frontmatter is left byte for byte. A `<Name` inside the
 * quoted attribute value of a well-formed opener gets no marker: the marker's
 * quotes would close that value early and change the opener's shape. A tag
 * there carries no attribute (the value holds no `"`), so it has no finding; a
 * render that still reads it reports it with no marker.
 */
function markBody(content: string): { marked: string; offsets: number[] } {
  const bodyAt = content.length - splitFrontmatter(content).body.length;
  const body = content.slice(bodyAt);
  const offsets: number[] = [];
  let out = "";
  let last = 0;
  NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(body)) !== null) {
    const end = m.index + m[0].length;
    offsets.push(bodyAt + m.index);
    out += `${body.slice(last, end)} ${LINT_MARK_ATTR}="${offsets.length - 1}"`;
    last = end;
    OPENER_RUN_RE.lastIndex = end;
    const run = OPENER_RUN_RE.exec(body);
    if (run !== null && run[0].length > 0) NAME_RE.lastIndex = end + run[0].length;
  }
  return { marked: content.slice(0, bodyAt) + out + body.slice(last), offsets };
}

const tagKey = (t: { name: string; inline: boolean; rawAttrs: string }) => `${t.name}\u0000${t.inline}\u0000${t.rawAttrs}`;

/** The marked render's tags with their source offsets, or null when they are
 *  not, tag for tag, the plain render's. A tag read with no marker has none. */
function locate(render: PageRender, content: string, plain: readonly ObservedComponentTag[]): Tag[] | null {
  const { marked, offsets } = markBody(content);
  const tags: Tag[] = [];
  const keys: string[] = [];
  for (const t of observe(render, marked)) {
    const mark = MARK_RE.exec(t.rawAttrs);
    if (mark === null) {
      keys.push(tagKey(t));
      tags.push({ name: t.name, attrs: t.rawAttrs });
      continue;
    }
    const offset = offsets[Number(mark[1])];
    if (offset === undefined) return null;
    const attrs = t.rawAttrs.slice(mark[0].length);
    keys.push(tagKey({ ...t, rawAttrs: attrs }));
    SOURCE_RUN_RE.lastIndex = offset + 1 + t.name.length;
    const sourceAttrs = SOURCE_RUN_RE.exec(content)?.[0] ?? "";
    tags.push({ name: t.name, attrs, sourceAttrs, offset, line: lineAt(content, offset) });
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

/** Components with a `required` attribute: a bare `<Meter>` is a finding. */
const REQUIRED_NAMES = COMPONENT_NAMES.filter((n) => Object.values(SPEC[n].attrs).some((a) => a.required));
/**
 * A tag this check could judge: a component name followed by an attribute, or
 * a component with a required attribute in any form. A page with neither has
 * no finding, so it is not rendered.
 */
const JUDGEABLE_RE = new RegExp(
  `<(?:${COMPONENT_NAMES.join("|")})\\s+[^\\s/>]` + (REQUIRED_NAMES.length > 0 ? `|<(?:${REQUIRED_NAMES.join("|")})(?=[\\s/>])` : ""),
);

/** Results per render seam, keyed on relPath and a content hash. A lint run
 *  repeats on every `/wiki/gardener` load over pages that rarely change. */
export const COMPONENT_MEMO_MAX = 2000;
const memos = new WeakMap<PageRender, Map<string, LintFinding[]>>();

/**
 * Every component finding on one page, located ones in source order, then the
 * unlocated. Pure apart from the render; `lintWiki` calls it on `.mdx` pages
 * and `scripts/wiki-check.ts` on the files it walks. The observer reports each
 * tag the emitted render reads once (`component-observer.ts`); a located tag is
 * also keyed on its source offset, so one tag is never two findings. Results
 * are memoized per render seam (`COMPONENT_MEMO_MAX` entries, oldest evicted).
 */
export function checkComponents(relPath: string, content: string, render: PageRender = readerRender): LintFinding[] {
  if (!JUDGEABLE_RE.test(content)) return [];
  let memo = memos.get(render);
  if (memo === undefined) memos.set(render, (memo = new Map()));
  const key = `${relPath}\u0000${content.length}\u0000${Bun.hash(content)}`;
  let found = memo.get(key);
  if (found !== undefined) memo.delete(key);
  else found = findComponents(relPath, content, render);
  memo.set(key, found);
  if (memo.size > COMPONENT_MEMO_MAX) memo.delete(memo.keys().next().value!);
  return found.map((f) => ({ ...f }));
}

function findComponents(relPath: string, content: string, render: PageRender): LintFinding[] {
  const plain = observe(render, content);
  const unlocated = plain.flatMap((t) => checkTag(relPath, { name: t.name, attrs: t.rawAttrs }));
  if (unlocated.length === 0) return [];
  const tags = locate(render, content, plain);
  if (tags === null) return unlocated;
  const located = tags.filter((t) => t.offset !== undefined).sort((a, b) => a.offset! - b.offset!);
  const once = located.filter((t, i) => i === 0 || t.offset !== located[i - 1]!.offset);
  return [...once, ...tags.filter((t) => t.offset === undefined)].flatMap((t) => checkTag(relPath, t));
}
