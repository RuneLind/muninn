/**
 * The wiki agent's proposed edit, resolved against a page's current text
 * (mimir plan muninn-wiki-discuss, P4). Pure: the route
 * (`routes/wiki-discuss-apply.ts`) reads the page, calls this, and writes
 * {@link DiscussEditPlan.content}.
 *
 * The edit is the turn's stored `proposed_edit`, read again with
 * `parseEditList` and bounded to one edit. It resolves with `applyEdits` over
 * `matchMaskBody` (found exactly once, outside frontmatter, fences, fact-check
 * blocks and block component tags) on the page with fact wrappers stripped,
 * and the range is mapped back to the file through `stripFactWrappersWithMap`,
 * as P1's locator does. The new content is spliced into the FILE text, never
 * written from the stripped view, so no wrapper is lost. Refused, each with its
 * own code: a range in the file that touches a fact wrapper (inside it or
 * across its boundary), an old or new text that quotes a wrapper tag, and a
 * range that holds an inline component tag.
 */

import { COMPONENT_NAMES } from "../format/component-spec.ts";
import { markdownCodeRegions, inProtectedRegion, stripFactWrappersWithMap } from "../format/markdown-ast.ts";
import {
  INTEGRATE_MAX_EDIT_CHARS,
  applyEdits,
  findExclusionZones,
  pageHasComponentVocabulary,
  parseEditList,
  type IntegrateEdit,
  type ZoneKind,
} from "./integrate-edits.ts";

export type DiscussEditRefusalCode =
  | "no-edit"
  | "edit-count"
  | "too-long"
  | "fact-tag"
  | "frontmatter"
  | "fence"
  | "fact-check-block"
  | "component-tag"
  | "ambiguous"
  | "not-found"
  | "markup"
  | "fact-wrapper"
  | "inline-component";

export interface DiscussEditRefusal {
  ok: false;
  code: DiscussEditRefusalCode;
  reason: string;
}

export interface DiscussEditPlan {
  ok: true;
  edit: IntegrateEdit;
  /** The replaced range in the FILE text (offsets into what was read, a BOM included). */
  start: number;
  end: number;
  /** The file's text in that range, and what replaces it. */
  before: string;
  after: string;
  /** Up to 120 characters of the page around the range, as the reader reads it (fact wrappers left out). */
  beforeCtx: string;
  afterCtx: string;
  /** 1-based lines of the range in the file. */
  fromLine: number;
  toLine: number;
  /** `collapsed`: the old text matched only with its white space collapsed. */
  tier: "exact" | "collapsed";
  /** The page with the edit made. */
  content: string;
}

const refuse = (code: DiscussEditRefusalCode, reason: string): DiscussEditRefusal => ({ ok: false, code, reason });

const FACT_TAG_RE = /<\/?Fact\b/;
/** One `Fact` tag, the shape `stripFactWrappers` removes. */
const FACT_ONE_TAG_RE = /<\/?Fact\b[^>\n]*>/g;
/** Any known component's tag (opening, closing or self-closing), anywhere on a line. */
const INLINE_COMPONENT_TAG_RE = new RegExp(`</?(?:${COMPONENT_NAMES.filter((n) => n !== "Fact").join("|")})(?=[\\s/>])[^>\\n]*>`, "g");

const ZONE_REFUSAL: Record<ZoneKind, { code: DiscussEditRefusalCode; reason: string }> = {
  frontmatter: { code: "frontmatter", reason: "the old text sits in the page's frontmatter, which the agent may not edit" },
  fence: { code: "fence", reason: "the old text sits in a fenced code block, which the agent may not edit" },
  sentinel: { code: "fact-check-block", reason: "the old text sits in a fact-check block, which the agent may not edit" },
  component: { code: "component-tag", reason: "the old text sits on a block component's tag line, which the agent may not edit" },
};

/** Every start offset of `needle` in `hay`. */
function indexesOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * The fact wrappers in `body` as file ranges, from the tags the strip removed
 * (the gaps in `map`): an opening tag to its closing tag, and a tag that pairs
 * with none as its own range. Tags inside frontmatter or code are content, not
 * wrappers: the strip keeps them, so they are no gap.
 */
function wrapperSpans(body: string, map: number[]): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = [];
  let expect = 0;
  for (const at of map) {
    if (at > expect) gaps.push({ start: expect, end: at });
    expect = at + 1;
  }
  if (expect < body.length) gaps.push({ start: expect, end: body.length });
  const tags: { start: number; end: number; kind: "open" | "close" | "self" }[] = [];
  for (const g of gaps) {
    for (const m of body.slice(g.start, g.end).matchAll(FACT_ONE_TAG_RE)) {
      const start = g.start + m.index!;
      const kind = m[0].startsWith("</") ? "close" : m[0].endsWith("/>") ? "self" : "open";
      tags.push({ start, end: start + m[0].length, kind });
    }
  }
  const spans: { start: number; end: number }[] = [];
  const open: { start: number; end: number }[] = [];
  for (const t of tags) {
    if (t.kind === "open") open.push(t);
    else if (t.kind === "close") {
      const o = open.pop();
      spans.push(o ? { start: o.start, end: t.end } : { start: t.start, end: t.end });
    } else spans.push({ start: t.start, end: t.end });
  }
  for (const o of open) spans.push({ start: o.start, end: o.end });
  return spans;
}

function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** The edits a stored `proposed_edit` holds, read again as `parseEditList` reads an answer. */
function storedEdits(proposed: unknown): { edits: IntegrateEdit[]; dropped: string[] } | null {
  if (!proposed || typeof proposed !== "object" || !Array.isArray((proposed as { edits?: unknown }).edits)) return null;
  const parsed = parseEditList(JSON.stringify({ edits: (proposed as { edits: unknown[] }).edits }));
  if (!parsed) return null;
  return { edits: parsed.edits, dropped: parsed.dropped.map((d) => d.reason) };
}

/**
 * Resolve a turn's stored edit against `raw`, the page file's text as read
 * (a leading BOM kept). `relPath` decides whether block component tags are
 * zoned (`pageHasComponentVocabulary`).
 */
export function resolveDiscussEdit(raw: string, relPath: string, proposed: unknown): DiscussEditPlan | DiscussEditRefusal {
  const stored = storedEdits(proposed);
  if (!stored || stored.edits.length === 0) {
    const why = stored?.dropped.length ? `: ${stored.dropped.join("; ")}` : "";
    return refuse("no-edit", `the turn carries no edit that can be applied${why}`);
  }
  if (stored.edits.length > 1) return refuse("edit-count", `the turn proposes ${stored.edits.length} edits; the wiki agent may propose one`);
  const edit = stored.edits[0]!;
  if (edit.old.length > INTEGRATE_MAX_EDIT_CHARS || edit.new.length > INTEGRATE_MAX_EDIT_CHARS) {
    return refuse("too-long", `the edit's text is over ${INTEGRATE_MAX_EDIT_CHARS} characters`);
  }
  if (FACT_TAG_RE.test(edit.old) || FACT_TAG_RE.test(edit.new)) {
    return refuse("fact-tag", "the edit quotes a fact wrapper's tag (<Fact>); a wrapper's verdict is the fact check's to change");
  }

  // A BOM is not page text: the frontmatter must start at offset 0 for the zones.
  const bom = raw.startsWith("\uFEFF") ? 1 : 0;
  const body = raw.slice(bom);
  const { text, map } = stripFactWrappersWithMap(body);
  const isMdx = pageHasComponentVocabulary(relPath, raw);
  const outcome = applyEdits(text, [edit], isMdx, "splice").outcomes[0]!;
  if (!outcome.applied) {
    // Name the zone when the old text is on the page but only inside one.
    const zones = findExclusionZones(text, isMdx);
    for (const at of indexesOf(text, edit.old)) {
      const z = zones.find((zone) => at < zone.end && at + edit.old.length > zone.start);
      if (z) return refuse(ZONE_REFUSAL[z.kind].code, ZONE_REFUSAL[z.kind].reason);
    }
    const reason = outcome.reason ?? "the old text was not found";
    if (/ambiguous/.test(reason)) return refuse("ambiguous", `the old text ${reason}; it must match exactly one place`);
    if (/no longer found|no text to match/.test(reason)) return refuse("not-found", "the old text is not in the page as it is now");
    return refuse("markup", `the old text cannot be replaced safely: ${reason}`);
  }

  const s = outcome.start!;
  const e = outcome.end!;
  const fileStart = map[s]!;
  const fileEnd = map[e - 1]! + 1;
  // A removed tag inside the range makes it longer in the file than in the stripped view.
  if (fileEnd - fileStart !== e - s) return refuse("fact-wrapper", "the edit's range crosses a fact wrapper's tag; a wrapper's verdict is the fact check's to change");
  if (wrapperSpans(body, map).some((w) => fileStart < w.end && fileEnd > w.start)) {
    return refuse("fact-wrapper", "the edit's range is inside a fact wrapper; a wrapper's verdict is the fact check's to change");
  }
  const code = markdownCodeRegions(body);
  for (const m of body.slice(fileStart, fileEnd).matchAll(INLINE_COMPONENT_TAG_RE)) {
    if (!inProtectedRegion(fileStart + m.index!, code)) {
      return refuse("inline-component", `the edit's range holds a component tag (${m[0]}); the agent may not edit component markup`);
    }
  }

  const before = body.slice(fileStart, fileEnd);
  // A page written with CRLF keeps CRLF in the replaced text.
  const after = body.includes("\r\n") ? edit.new.replace(/\r?\n/g, "\r\n") : edit.new;
  const start = bom + fileStart;
  const end = bom + fileEnd;
  return {
    ok: true,
    edit,
    start,
    end,
    before,
    after,
    beforeCtx: outcome.beforeCtx ?? "",
    afterCtx: outcome.afterCtx ?? "",
    fromLine: lineAt(raw, start),
    toLine: lineAt(raw, Math.max(start, end - 1)),
    tier: outcome.tier ?? "exact",
    content: raw.slice(0, start) + after + raw.slice(end),
  };
}
