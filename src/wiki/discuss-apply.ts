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
 * across its boundary), an old text that quotes a `Fact`/`FactCheck` tag, and
 * an edit that touches or changes the page's markup (frontmatter, a fence line
 * the reader renders, a known component tag outside code and where it stands,
 * a fact-check sentinel; {@link pageMarkup} on the page before and after the
 * edit): the agent's new text is prose, and markup changes go to Claude Code.
 * An edit whose result is the page as it is (`no-change`) is refused too.
 */

import { lineCodeSpanRanges } from "../format/code-spans.ts";
import { markdownMarkup, stripFactWrappersWithMap, type MarkupToken } from "../format/markdown-ast.ts";
import { FACTCHECK_SENTINEL_END, FACTCHECK_SENTINEL_START } from "./factcheck-context.ts";
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
  | "new-fence"
  | "new-frontmatter"
  | "new-markup"
  | "no-change";

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

/** A `Fact` or `FactCheck` tag's start. */
const FACT_TAG_RE = /<\/?Fact(?:Check)?\b/g;
/** One `Fact` tag, the shape `stripFactWrappers` removes. */
const FACT_ONE_TAG_RE = /<\/?Fact\b[^>\n]*>/g;

/** Does the old text quote a `Fact`/`FactCheck` tag outside its own code spans?
 *  Such an old text can match only a documented tag, never a live wrapper (the
 *  match runs with the wrappers stripped); this names why it is refused. */
function quotesFactTag(old: string): boolean {
  for (const line of old.split("\n")) {
    const spans = lineCodeSpanRanges(line);
    for (const m of line.matchAll(FACT_TAG_RE)) {
      if (!spans.some((r) => m.index! >= r.start && m.index! < r.end)) return true;
    }
  }
  return false;
}

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

const isFactName = (t: MarkupToken) => t.name === "Fact" || t.name === "FactCheck";

const SENTINEL_RE = new RegExp(`${FACTCHECK_SENTINEL_START}|${FACTCHECK_SENTINEL_END}`, "g");

/**
 * The page's markup as the guard compares it: `markdownMarkup` (frontmatter,
 * the fence lines the reader renders, component tags outside code with where
 * each stands) and every fact-check sentinel, in code too: the reader drops a
 * sentinel line, but `findExclusionZones` reads a pair as a fact-check block,
 * which is the fact check's to write.
 */
export function pageMarkup(body: string): MarkupToken[] {
  const out = markdownMarkup(body);
  const fm = out[0]?.kind === "frontmatter" ? out[0].text.length : 0;
  SENTINEL_RE.lastIndex = fm;
  for (let m = SENTINEL_RE.exec(body); m !== null; m = SENTINEL_RE.exec(body)) out.push({ kind: "sentinel", start: m.index, text: m[0] });
  return out.sort((a, b) => a.start - b.start);
}

/** Same token: kind, text, where it stands, and offset (`b`'s, with `a` shifted). */
const sameToken = (a: MarkupToken, b: MarkupToken, at: number) =>
  a.kind === b.kind && a.text === b.text && a.lead === b.lead && a.rest === b.rest && a.gap === b.gap && at === b.start;

/** The refusal for an edit whose range overlaps a piece of the page's markup. */
function touched(t: MarkupToken): DiscussEditRefusal {
  if (t.kind === "frontmatter") return refuse(ZONE_REFUSAL.frontmatter.code, ZONE_REFUSAL.frontmatter.reason);
  if (t.kind === "fence") return refuse(ZONE_REFUSAL.fence.code, "the edit's range touches a fenced-code line, which the agent may not edit");
  if (t.kind === "sentinel") return refuse(ZONE_REFUSAL.sentinel.code, "the edit's range touches a fact-check sentinel, which the agent may not edit");
  if (isFactName(t)) return refuse("fact-tag", `the edit's range touches a fact tag (${t.text}); a wrapper's verdict is the fact check's to change`);
  return refuse("component-tag", `the edit's range touches a component tag (${t.text}); the agent may not edit component markup`);
}

/** The refusal for an edit that changes the page's markup outside its range;
 *  `moved`: the same tag at its place, standing differently (its line, a line break). */
function changed(t: MarkupToken, moved: boolean): DiscussEditRefusal {
  if (t.kind === "frontmatter") return refuse("new-frontmatter", "the edit would create or change the page's frontmatter; the agent may not edit it");
  if (t.kind === "fence") return refuse("new-fence", `the edit would add or change a fenced-code line (${t.text}); the agent's new text may not change markup`);
  if (t.kind === "sentinel") return refuse(ZONE_REFUSAL.sentinel.code, "the edit would add or remove a fact-check sentinel; the fact-check block is the fact check's to write");
  const what = moved ? `change where a ${isFactName(t) ? "fact" : "component"} tag stands (${t.text}: its line or a line break next to it)` : `add or change a ${isFactName(t) ? "fact" : "component"} tag (${t.text})`;
  if (isFactName(t)) return refuse("fact-tag", `the edit would ${what}; a wrapper's verdict is the fact check's to change`);
  return refuse("new-markup", `the edit would ${what}; markup changes go to Claude Code`);
}

/**
 * The refusal for an edit that touches or changes the page's markup, or null.
 * The markup ({@link pageMarkup}) is read on the page before and after the
 * edit: the range may overlap none of it, and the rest must come out the same,
 * where each tag stands included, each token shifted by the edit's change in
 * length when it lies after the range. So a fence line or tag the new text
 * builds with the page's own characters counts, as does a tag a removed
 * backtick takes out of a code span, a line the new text joins onto a block
 * tag, a list marker in front of one, and a line break inside an inline
 * component; a code span the new text adds around prose, or a `<Name>` that is
 * no component, is prose.
 */
function markupChange(body: string, start: number, end: number, after: string): DiscussEditRefusal | null {
  const was = pageMarkup(body);
  const hit = was.find((t) => t.start < end && t.start + t.text.length > start);
  if (hit) return touched(hit);
  const now = pageMarkup(body.slice(0, start) + after + body.slice(end));
  const delta = after.length - (end - start);
  for (let i = 0; i < Math.max(was.length, now.length); i++) {
    const a = was[i];
    const b = now[i];
    const at = a && (a.start >= end ? a.start + delta : a.start);
    if (a && b && sameToken(a, b, at!)) continue;
    if (a && b && a.kind === b.kind && a.text === b.text && at === b.start) return changed(b, true);
    // Named by the first token that differs in the edited page: a token the edit removed or a new one.
    return changed(b && (!a || b.start < at!) ? b : a!, false);
  }
  return null;
}

function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** Leading and trailing white space, with CRLF read as one line break. */
const lead = (t: string) => t.match(/^\s*/)![0].replace(/\r\n/g, "\n").length;
const trail = (t: string) => t.match(/\s*$/)![0].replace(/\r\n/g, "\n").length;

/**
 * The text that replaces `before` (the file's range). On the collapsed tier the
 * range holds none of the old text's edge white space, so as much of the new
 * text's edge white space is dropped: only the words change, and a break the
 * new text adds beyond the old one's stays. Line breaks take the ending of the
 * line the range sits on (the first one at or after it, else the last before).
 */
function newTextFor(body: string, fileStart: number, before: string, edit: IntegrateEdit): string {
  let neu = edit.new.replace(/\r\n/g, "\n");
  if (neu.trim()) {
    const cutLead = Math.min(Math.max(0, lead(edit.old) - lead(before)), lead(neu));
    const cutTrail = Math.min(Math.max(0, trail(edit.old) - trail(before)), trail(neu));
    neu = neu.slice(cutLead, neu.length - cutTrail);
  }
  const nl = body.indexOf("\n", fileStart) !== -1 ? body.indexOf("\n", fileStart) : body.lastIndexOf("\n", fileStart);
  return nl > 0 && body[nl - 1] === "\r" ? neu.replace(/\n/g, "\r\n") : neu;
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
  if (quotesFactTag(edit.old)) {
    return refuse("fact-tag", "the old text quotes a fact wrapper's tag (<Fact>); a wrapper's verdict is the fact check's to change");
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
  const before = body.slice(fileStart, fileEnd);
  const after = newTextFor(body, fileStart, before, edit);
  if (after === before) return refuse("no-change", "the edit's new text is what the page already says; there is nothing to apply");
  const markup = markupChange(body, fileStart, fileEnd, after);
  if (markup) return markup;
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
