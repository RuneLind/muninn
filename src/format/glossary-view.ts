/**
 * The reader's glossary marks: the first use of each `<Glossary>` term per
 * `##` section gets a reader-only hover definition. A pass over the page's
 * FINISHED reader HTML (`renderWikiHtml`, `views` only), so links, code-ref
 * chips and every other renderer have already decided what is code or a link.
 *
 * The matching rules, each pinned in `glossary-view.test.ts`:
 *
 * - whole words: no letter, digit, combining mark, `_` or `-` on either side,
 *   read across inline tags (`<strong>Hold</strong>s` is not «Hold»);
 * - case-insensitive, unless the term holds two or more capitals (`ATS`,
 *   `RRF fusion`), which match letter for letter; both sides NFC;
 * - no inflections: «Holds» is not «Hold»;
 * - the longest term wins where two start at one place; matches never overlap
 *   and never cross an element;
 * - sections: `<h2>`/`<h3>` (`#`/`##`) start one, `###` does not, and text
 *   before the first heading is one too;
 * - never inside: headings, links (resolved or not), code, `pre`, `kbd`,
 *   `samp`, buttons, `summary`, form controls, `svg`, a fact-check mark,
 *   reader-only text, the `<Glossary>` block itself, a callout or lead-box
 *   title, a chart's table (`section.vc`, visually hidden in chart mode) and a
 *   `<Query>` result (data); a word inside a bare URL is not marked either;
 * - attributes are never read or written, and the text a mark wraps is the
 *   source's own bytes.
 */

import { READER_ONLY_ATTR } from "./reader-lens.ts";
import { isMarkableTerm, type GlossaryEntry } from "./glossary.ts";

export const GLOSSARY_CHROME_CLASSES = ["glossary", "gl-mark", "gl-term", "gl-tip", "gl-tip-term"] as const;

const SKIP_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "a", "code", "pre", "kbd", "samp", "button", "summary", "script", "style", "svg", "textarea", "select", "option", "title"]);
const SKIP_CLASSES = new Set(["glossary", "fc-mark", "fc-mark-block", "wiki-link-missing", "callout-title", "tldr-label", "vc", "query-result", "gl-mark"]);
const INLINE_TAGS = new Set(["strong", "em", "b", "i", "s", "del", "ins", "u", "mark", "span", "sup", "sub", "small"]);
const VOID_TAGS = new Set(["br", "hr", "img", "input", "wbr", "meta", "link", "col", "source", "area", "base", "embed", "track", "param"]);
const SECTION_TAGS = new Set(["h2", "h3"]);
const TOKEN_RE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+|</g;
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}_-]/u;
const URL_TOKEN_RE = /^[a-z][a-z0-9+.-]*:\/\/|^www\./i;

interface Unit {
  /** Raw offset of this unit in the text token. */
  at: number;
  /** The decoded character(s): an entity decodes to one. */
  text: string;
}

const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/iy;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The token's characters, an entity decoded to the character it spells. */
function units(raw: string): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === "&") {
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(raw);
      const decoded = m
        ? m[1]
          ? String.fromCodePoint(Number(m[1]))
          : m[2]
            ? String.fromCodePoint(parseInt(m[2], 16))
            : NAMED[m[3]!.toLowerCase()]
        : undefined;
      if (m && decoded !== undefined) {
        out.push({ at: i, text: decoded });
        i += m[0].length;
        continue;
      }
    }
    const cp = String.fromCodePoint(raw.codePointAt(i)!);
    out.push({ at: i, text: cp });
    i += cp.length;
  }
  return out;
}

interface Folded {
  /** The decoded text in NFC, one chunk per base character and its marks. */
  text: string;
  /** `starts[k]` is chunk k's offset in `text`; `raw[k]` its raw offset. */
  starts: number[];
  raw: number[];
}

/** NFC per base character and the marks after it, with each chunk's raw
 *  offset, so a match on the folded text maps back to the source bytes. */
function fold(raw: string): Folded {
  const us = units(raw);
  const out: Folded = { text: "", starts: [], raw: [] };
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

interface OpenTag {
  name: string;
  skip: boolean;
}

function tagName(tag: string): string {
  return /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag)![1]!.toLowerCase();
}

function skips(tag: string, name: string): boolean {
  if (SKIP_TAGS.has(name)) return true;
  if (new RegExp(`\\s${READER_ONLY_ATTR}(?:[\\s=>/]|$)`).test(tag)) return true;
  if (/\srole="heading"/.test(tag)) return true;
  const cls = /\sclass="([^"]*)"/.exec(tag)?.[1];
  return cls !== undefined && cls.split(/\s+/).some((c) => SKIP_CLASSES.has(c));
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * `html` with the first use of each markable term per section wrapped in a
 * focusable term and its reader-only definition. `html` comes back unchanged
 * when no term is used.
 */
export function markGlossaryTerms(html: string, entries: readonly GlossaryEntry[]): string {
  const terms = entries.filter(isMarkableTerm).sort((a, b) => [...b.key].length - [...a.key].length);
  if (terms.length === 0) return html;
  const tokens = html.match(TOKEN_RE) ?? [];
  // The first visible character after each token, read across inline tags.
  const nextChar: string[] = new Array(tokens.length).fill(" ");
  let carry = " ";
  for (let i = tokens.length - 1; i >= 0; i--) {
    nextChar[i] = carry;
    const t = tokens[i]!;
    if (t.startsWith("<!--")) continue;
    if (t.startsWith("<") && t.length > 1) carry = INLINE_TAGS.has(tagName(t)) ? carry : " ";
    else carry = fold(t).text[0] ?? carry;
  }
  const stack: OpenTag[] = [];
  let skipDepth = 0;
  let used = new Set<string>();
  let prev = " ";
  let tip = 0;
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("<!--") || t === "<") {
      out += t;
      continue;
    }
    if (t.startsWith("<")) {
      out += t;
      const name = tagName(t);
      if (!INLINE_TAGS.has(name)) prev = " ";
      if (t.startsWith("</")) {
        const at = stack.map((o) => o.name).lastIndexOf(name);
        if (at >= 0) for (const o of stack.splice(at)) if (o.skip) skipDepth--;
      } else if (!VOID_TAGS.has(name) && !t.endsWith("/>")) {
        if (SECTION_TAGS.has(name)) used = new Set();
        const skip = skips(t, name);
        stack.push({ name, skip });
        if (skip) skipDepth++;
      }
      continue;
    }
    const f = fold(t);
    if (skipDepth > 0 || f.text === "") {
      out += t;
      prev = f.text.at(-1) ?? prev;
      continue;
    }
    let raw = 0;
    let piece = "";
    for (let k = 0; k < f.starts.length - 1; k++) {
      const at = f.starts[k]!;
      const before = at === 0 ? prev : f.text[at - 1]!;
      if (WORD_CHAR_RE.test(before)) continue;
      const hit = terms.find((e) => !used.has(e.key) && matchesAt(f, k, e, nextChar[i]!));
      if (!hit) continue;
      const endChunk = f.starts.indexOf(at + hit.key.length, k);
      if (urlToken(f.text, at)) continue;
      used.add(hit.key);
      tip++;
      const id = `gl-tip-${tip}`;
      piece +=
        t.slice(raw, f.raw[k]) +
        `<span class="gl-mark"><span class="gl-term" tabindex="0" aria-describedby="${id}" data-gl-key="${escapeAttr(hit.key)}">` +
        t.slice(f.raw[k], f.raw[endChunk]) +
        `</span><span class="gl-tip" id="${id}" role="tooltip" ${READER_ONLY_ATTR}><b class="gl-tip-term">${escapeText(hit.term)}</b> ${escapeText(hit.definition)}</span></span>`;
      raw = f.raw[endChunk]!;
      k = endChunk - 1;
    }
    out += raw === 0 ? t : piece + t.slice(raw);
    prev = f.text.at(-1) ?? prev;
  }
  return out;
}

/** Term `e` starts at chunk `k` of `f`, ends on a chunk boundary, and has no
 *  word character after it (the next token's first one, at the token's end). */
function matchesAt(f: Folded, k: number, e: GlossaryEntry, next: string): boolean {
  const at = f.starts[k]!;
  const slice = f.text.slice(at, at + e.key.length);
  if ((e.exactCase ? slice : slice.toLowerCase()) !== e.key) return false;
  const end = at + e.key.length;
  if (!f.starts.includes(end, k)) return false;
  return !WORD_CHAR_RE.test(f.text[end] ?? next);
}

/** The white-space-delimited run around `at` is a URL. */
function urlToken(text: string, at: number): boolean {
  const start = text.slice(0, at).search(/\S*$/);
  return URL_TOKEN_RE.test(text.slice(start));
}
