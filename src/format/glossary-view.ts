/**
 * The reader's glossary marks: the first use of each `<Glossary>` term per
 * section (the text before the first heading, then each `#` and `##` heading)
 * gets a reader-only hover definition. A pass over the page's
 * FINISHED reader HTML (`renderWikiHtml`, `views` only), so links, code-ref
 * chips and every other renderer have already decided what is code or a link.
 *
 * The matching rules, each pinned in `glossary-view.test.ts`:
 *
 * - whole words: no letter, digit, combining mark, `_` or `-` on either side,
 *   read across inline tags (`<strong>Hold</strong>s` is not «Hold»);
 * - case-insensitive, unless the term holds a capital past its first letter
 *   (`ATS`, `Soft AND`), which matches letter for letter after a first letter
 *   of either case; both sides NFC;
 * - a space in a term matches any white space run (a no-break space, a soft
 *   line break, two spaces);
 * - no inflections: «Holds» is not «Hold»;
 * - the longest term wins where two start at one place, at every occurrence: a
 *   shorter term never marks inside a longer one, marked or not; matches
 *   never overlap and never cross an element;
 * - sections: `<h2>`/`<h3>` (`#`/`##`) start one, `###` does not, and text
 *   before the first heading is one too;
 * - never inside: headings, links (resolved or not), code, `pre`, `kbd`,
 *   `samp`, buttons, `summary`, form controls, `svg`, a fact-check mark,
 *   reader-only text, the `<Glossary>` block itself, a callout or lead-box
 *   title, a chart's table (`section.vc`, visually hidden in chart mode), a
 *   `<Query>` result (data) and the labels and notes the renderer writes around
 *   a component's body (`Query without id`, `run …`, `lower is better`, a
 *   step count, a Historic stamp); a word inside a bare URL is not marked either;
 * - attributes are never read or written, and the text a mark wraps is the
 *   source's own bytes.
 */

import { READER_ONLY_ATTR } from "./reader-lens.ts";
import { escapeHtml } from "./markdown-core.ts";
import { isMarkableTerm, type GlossaryEntry } from "./glossary.ts";

export const GLOSSARY_CHROME_CLASSES = ["glossary", "gl-mark", "gl-term", "gl-tip", "gl-tip-term"] as const;

const SKIP_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "a", "code", "pre", "kbd", "samp", "button", "summary", "script", "style", "svg", "textarea", "select", "option", "title"]);
const SKIP_CLASSES = new Set([
  "glossary", "fc-mark", "fc-mark-block", "wiki-link-missing", "callout-title", "tldr-label", "vc", "query-result", "gl-mark", "cb-strip", "cb-pill",
  // Labels and notes the renderer writes around a component's body.
  "query-warning", "query-meta", "query-unavailable", "q-label", "q-state", "q-for", "q-duplicate",
  "dt-delta", "dt-note", "dt-warning", "dt-unavailable", "rc-count", "rc-label", "embed-fallback", "historic-stamp",
  "cb-warning", "cb-truncated", "cb-unavailable",
]);
const INLINE_TAGS = new Set(["strong", "em", "b", "i", "s", "del", "ins", "u", "mark", "span", "sup", "sub", "small"]);
const VOID_TAGS = new Set(["br", "hr", "img", "input", "wbr", "meta", "link", "col", "source", "area", "base", "embed", "track", "param"]);
const SECTION_TAGS = new Set(["h2", "h3"]);
const TOKEN_RE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+|</g;
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}_-]/u;
const URL_TOKEN_RE = /^[a-z][a-z0-9+.-]*:\/\/|^www\./i;

const READER_ONLY_RE = new RegExp(`\\s${READER_ONLY_ATTR}(?:[\\s=>/]|$)`);
/** A text token the fast path cannot take as its own folded text. */
const SLOW_TEXT_RE = /[&\uD800-\uDFFF]/;
const MARK_RE = /\p{M}/u;
const WS_RE = /\s/;

interface Unit {
  /** Raw offset of this unit in the text token. */
  at: number;
  /** The decoded character(s): an entity decodes to one. */
  text: string;
}

const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/iy;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A numeric entity's character; one no scalar value holds (0, a surrogate,
 *  past U+10FFFF) is U+FFFD, as the HTML parser reads it. */
function codePointText(n: number): string {
  return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "\uFFFD";
}

/** The entity at `raw[i]` (an `&`): its decoded text and raw length, or null. */
function entityAt(raw: string, i: number): { text: string; len: number } | null {
  ENTITY_RE.lastIndex = i;
  const m = ENTITY_RE.exec(raw);
  if (!m) return null;
  const text = m[1] ? codePointText(Number(m[1])) : m[2] ? codePointText(parseInt(m[2], 16)) : NAMED[m[3]!.toLowerCase()];
  return text === undefined ? null : { text, len: m[0].length };
}

/** The token's characters, an entity decoded to the character it spells. */
function units(raw: string): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === "&") {
      const e = entityAt(raw, i);
      if (e) {
        out.push({ at: i, text: e.text });
        i += e.len;
        continue;
      }
    }
    const cp = String.fromCodePoint(raw.codePointAt(i)!);
    out.push({ at: i, text: cp });
    i += cp.length;
  }
  return out;
}

/** A text token's first and last decoded code unit: all a word-boundary test
 *  reads of a token it does not otherwise scan. NFC never changes whether
 *  either is a word character. */
function firstUnit(raw: string): string {
  return raw[0] === "&" ? (entityAt(raw, 0)?.text[0] ?? "&") : raw[0]!;
}
function lastUnit(raw: string): string {
  const amp = raw.lastIndexOf("&");
  const e = amp >= 0 ? entityAt(raw, amp) : null;
  return e && amp + e.len === raw.length ? e.text.at(-1)! : raw.at(-1)!;
}

interface Folded {
  /** The decoded text in NFC, one chunk per base character and its marks. */
  text: string;
  /** `starts[k]` is chunk k's offset in `text`; `raw[k]` its raw offset.
   *  Both null when every chunk is one code unit the token holds as is. */
  starts: number[] | null;
  raw: number[] | null;
}

/** NFC per base character and the marks after it, with each chunk's raw
 *  offset, so a match on the folded text maps back to the source bytes. */
function fold(raw: string): Folded {
  if (!SLOW_TEXT_RE.test(raw) && !MARK_RE.test(raw) && raw.normalize("NFC") === raw) return { text: raw, starts: null, raw: null };
  const us = units(raw);
  const out = { text: "", starts: [] as number[], raw: [] as number[] };
  for (let k = 0; k < us.length; ) {
    let j = k + 1;
    while (j < us.length && /^\p{M}/u.test(us[j]!.text)) j++;
    out.starts.push(out.text.length);
    out.raw.push(us[k]!.at);
    out.text += us
      .slice(k, j)
      .map((u) => u.text)
      .join("")
      .normalize("NFC");
    k = j;
  }
  out.starts.push(out.text.length);
  out.raw.push(raw.length);
  return out;
}

const startOf = (f: Folded, k: number) => (f.starts ? f.starts[k]! : k);
const rawOf = (f: Folded, k: number) => (f.raw ? f.raw[k]! : k);

/** The chunk that starts at `off` in `f.text`, or -1. */
function chunkAt(f: Folded, off: number): number {
  const s = f.starts;
  if (!s) return off;
  let lo = 0;
  let hi = s.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid] === off) return mid;
    if (s[mid]! < off) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

interface OpenTag {
  name: string;
  skip: boolean;
}

/** The lower-cased name of a tag token (`TOKEN_RE` guarantees a letter after `<` or `</`). */
function tagName(tag: string): string {
  const from = tag.charCodeAt(1) === 47 ? 2 : 1;
  let to = from;
  for (let c = tag.charCodeAt(to); (c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 122) || c === 45; c = tag.charCodeAt(++to));
  return tag.slice(from, to).toLowerCase();
}

/** True for a tag words run through (`**Hold**s` is one word). A span with a
 *  class is renderer chrome that sets its text apart (a Timeline item's date
 *  cell, then its text), so it starts a new word. */
function joinsWords(tag: string, name: string): boolean {
  return INLINE_TAGS.has(name) && !(name === "span" && /^<span\s[^>]*\bclass="/.test(tag));
}

function skips(tag: string, name: string): boolean {
  if (SKIP_TAGS.has(name)) return true;
  if (tag.length === name.length + 2) return false;
  if (READER_ONLY_RE.test(tag)) return true;
  if (/\srole="heading"/.test(tag)) return true;
  const cls = /\sclass="([^"]*)"/.exec(tag)?.[1];
  return cls !== undefined && cls.split(/\s+/).some((c) => SKIP_CLASSES.has(c));
}


/**
 * `html` with the first use of each markable term per section wrapped in a
 * focusable term and its reader-only definition. `html` comes back unchanged
 * when no term is used.
 */
export function markGlossaryTerms(html: string, entries: readonly GlossaryEntry[]): string {
  const terms = entries
    .filter(isMarkableTerm)
    .sort((a, b) => [...b.key].length - [...a.key].length)
    .map((e) => ({ e, re: termPattern(e) }));
  if (terms.length === 0) return html;
  // Where any term may start, case aside; at such a place, group g of `whichTerm`
  // is the first term, longest first, that does (groups cost the scan ~40 %).
  const anyTerm = new RegExp(terms.map((t) => `(?:${t.re.source})`).join("|"), "giu");
  const whichTerm = new RegExp(terms.map((t) => `(${t.re.source})`).join("|"), "iuy");
  const tokens = html.match(TOKEN_RE) ?? [];
  // Per tag token its name and whether words run through it (null: not a tag);
  // per token the first visible character after it, read across inline tags.
  const names: (string | null)[] = new Array(tokens.length).fill(null);
  const joins = new Uint8Array(tokens.length);
  const nextChar: string[] = new Array(tokens.length).fill(" ");
  let carry = " ";
  for (let i = tokens.length - 1; i >= 0; i--) {
    nextChar[i] = carry;
    const t = tokens[i]!;
    if (t.charCodeAt(0) !== 60 || t.length === 1) carry = firstUnit(t);
    else if (t.length > 1 && t.charCodeAt(1) !== 33) {
      const name = (names[i] = tagName(t));
      if (joinsWords(t, name)) joins[i] = 1;
      else carry = " ";
    }
  }
  const stack: OpenTag[] = [];
  let skipDepth = 0;
  let used = new Set<string>();
  let prev = " ";
  let tip = 0;
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const name = names[i] ?? null;
    if (name === null && t.charCodeAt(0) === 60) {
      out += t; // a comment or a lone `<`
      continue;
    }
    if (name !== null) {
      out += t;
      if (!joins[i]) prev = " ";
      if (t.charCodeAt(1) === 47) {
        let at = stack.length - 1;
        while (at >= 0 && stack[at]!.name !== name) at--;
        if (at >= 0) while (stack.length > at) if (stack.pop()!.skip) skipDepth--;
      } else if (!VOID_TAGS.has(name) && !t.endsWith("/>")) {
        if (SECTION_TAGS.has(name)) used = new Set();
        const skip = skips(t, name);
        stack.push({ name, skip });
        if (skip) skipDepth++;
      }
      continue;
    }
    if (skipDepth > 0) {
      out += t;
      prev = lastUnit(t);
      continue;
    }
    const f = fold(t);
    const text = f.text;
    let raw = 0;
    let piece = "";
    for (let pos = 0; pos < text.length; ) {
      anyTerm.lastIndex = pos;
      const m = anyTerm.exec(text);
      if (!m) break;
      const at = m.index;
      const k = chunkAt(f, at);
      if (k < 0) {
        pos = at + 1;
        continue;
      }
      pos = startOf(f, k + 1);
      const before = at === 0 ? prev : text[at - 1]!;
      if (WORD_CHAR_RE.test(before)) continue;
      whichTerm.lastIndex = at;
      const w = whichTerm.exec(text)!;
      let g = 1;
      while (w[g] === undefined) g++;
      let end = -1;
      let found: (typeof terms)[number] | undefined;
      for (let j = g - 1; j < terms.length && !found; j++) if ((end = matchEnd(f, k, terms[j]!.re, nextChar[i]!)) >= 0) found = terms[j];
      if (!found) continue;
      const endChunk = chunkAt(f, end);
      if (urlToken(text, at)) continue;
      const hit = found.e;
      // A used longer term still covers its words: «hold» in a second «hold queue» stays unmarked.
      pos = end;
      if (used.has(hit.key)) continue;
      used.add(hit.key);
      tip++;
      const id = `gl-tip-${tip}`;
      piece +=
        t.slice(raw, rawOf(f, k)) +
        `<span class="gl-mark"><span class="gl-term" tabindex="0" aria-describedby="${id}" data-gl-key="${escapeHtml(hit.key)}">` +
        t.slice(rawOf(f, k), rawOf(f, endChunk)) +
        `</span><span class="gl-tip" id="${id}" role="tooltip" ${READER_ONLY_ATTR}><b class="gl-tip-term">${escapeHtml(hit.term)}</b> ${escapeHtml(hit.definition)}</span></span>`;
      raw = rawOf(f, endChunk);
    }
    out += raw === 0 ? t : piece + t.slice(raw);
    prev = text.at(-1) ?? prev;
  }
  return out;
}

/** A sticky pattern for `e`: a space matches any white space run (a no-break
 *  space, a soft line break); the first letter's case is free, and the rest
 *  matches exactly when `e.exactCase`. */
function termPattern(e: GlossaryEntry): RegExp {
  const esc = (c: string) => (c === " " ? "\\s+" : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const [first = "", ...rest] = e.key;
  if (!e.exactCase) return new RegExp([...e.key].map(esc).join(""), "iuy");
  const head = first === first.toUpperCase() ? esc(first) : `(?:${esc(first)}|${esc(first.toUpperCase())})`;
  return new RegExp(head + rest.map(esc).join(""), "uy");
}

/** The end offset in `f.text` of a match of `re` at chunk `k` that ends on a
 *  chunk boundary with no word character after it (the next token's first
 *  one, at the token's end); -1 when there is none. */
function matchEnd(f: Folded, k: number, re: RegExp, next: string): number {
  re.lastIndex = startOf(f, k);
  const m = re.exec(f.text);
  if (!m) return -1;
  const end = re.lastIndex;
  if (chunkAt(f, end) < 0) return -1;
  return WORD_CHAR_RE.test(f.text[end] ?? next) ? -1 : end;
}

/** The white-space-delimited run around `at` is a URL. */
function urlToken(text: string, at: number): boolean {
  let start = at;
  while (start > 0 && !WS_RE.test(text[start - 1]!)) start--;
  return URL_TOKEN_RE.test(text.slice(start));
}
