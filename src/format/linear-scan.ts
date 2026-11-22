/**
 * Linear replacements for the opener…closer regexes the inline formatters ran
 * (architecture review 2026-11-16, F30). A pattern such as
 * `\[([^\]]+)\]\(([^)]+)\)` rescans the same run from every opener when the
 * closer is missing, so one long line of `[` or `<http://` cost quadratic time
 * (16k tokens: 3.6 s in `formatWebHtml`). Each matcher here answers exactly what
 * its regex answered — same matches, same groups, same left-to-right resumption
 * after a match and one character after a miss (`linear-scan.test.ts` compares
 * them on random strings) — but finds every delimiter through a memoized
 * "next occurrence", so each character is scanned a bounded number of times.
 * Pure and import-free: the web formatter's browser bundle carries it.
 */

/**
 * `from → the first index ≥ from where `test` holds, or -1`, memoized for
 * non-decreasing queries: an answer covers every `from` up to it, so a run is
 * scanned once however many openers ask about it.
 */
export function nextIndexer(text: string, test: (code: number) => boolean): (from: number) => number {
  let coveredFrom = Number.POSITIVE_INFINITY;
  let at = -1;
  return (from) => {
    if (from >= coveredFrom && (at === -1 || from <= at)) return at;
    let i = from;
    while (i < text.length && !test(text.charCodeAt(i))) i++;
    coveredFrom = from;
    at = i < text.length ? i : -1;
    return at;
  };
}

/** {@link nextIndexer} for a literal needle (`</b>`), through `indexOf`. */
export function nextNeedle(text: string, needle: string): (from: number) => number {
  let coveredFrom = Number.POSITIVE_INFINITY;
  let at = -1;
  return (from) => {
    if (from >= coveredFrom && (at === -1 || from <= at)) return at;
    coveredFrom = from;
    at = text.indexOf(needle, from);
    return at;
  };
}

/** {@link nextIndexer} for a regex (its `g` copy's next match start). */
export function nextMatch(text: string, re: RegExp): (from: number) => { index: number; length: number } | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let coveredFrom = Number.POSITIVE_INFINITY;
  let hit: { index: number; length: number } | null = null;
  return (from) => {
    if (from >= coveredFrom && (hit === null || from <= hit.index)) return hit;
    coveredFrom = from;
    g.lastIndex = from;
    const m = g.exec(text);
    hit = m ? { index: m.index, length: m[0].length } : null;
    return hit;
  };
}

/** One match: `[start, end)` and its capture groups. */
export interface ScanMatch {
  readonly end: number;
  readonly groups: readonly string[];
}

/**
 * `text.replace(re, fn)` for a matcher: at every index `i` where `text[i]` is
 * `opener` (scanning left to right, resuming at a match's end, or at `i + 1`
 * after a miss), `match(i)` answers the match starting there or `null`.
 */
export function replaceScan(
  text: string,
  opener: string,
  match: (i: number) => ScanMatch | null,
  replace: (whole: string, ...groups: string[]) => string,
): string {
  let out = "";
  let cursor = 0;
  let i = text.indexOf(opener);
  while (i !== -1) {
    const m = match(i);
    if (m) {
      out += text.slice(cursor, i) + replace(text.slice(i, m.end), ...m.groups);
      cursor = m.end;
      i = text.indexOf(opener, m.end);
    } else {
      i = text.indexOf(opener, i + 1);
    }
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

const BRACKET_CLOSE = 0x5d; // ]
const PAREN_CLOSE = 0x29; // )
const GT = 0x3e; // >
const PIPE = 0x7c; // |

/** `/\[([^\]]+)\]\(([^)]+)\)/g` — a markdown link, label and target each non-empty. */
export function replaceMarkdownLinks(text: string, replace: (whole: string, label: string, url: string) => string): string {
  if (!text.includes("](")) return text;
  const nextBracket = nextIndexer(text, (c) => c === BRACKET_CLOSE);
  const nextParen = nextIndexer(text, (c) => c === PAREN_CLOSE);
  return replaceScan(
    text,
    "[",
    (i) => {
      const j = nextBracket(i + 1);
      if (j < i + 2 || text.charCodeAt(j + 1) !== 0x28) return null;
      const k = nextParen(j + 2);
      if (k < j + 3) return null;
      return { end: k + 1, groups: [text.slice(i + 1, j), text.slice(j + 2, k)] };
    },
    replace as (whole: string, ...groups: string[]) => string,
  );
}

/** Where the URL body of `<http://…` / `<https://…` at `i` starts, else -1. */
function angleUrlBody(text: string, i: number): number {
  if (text.startsWith("http://", i + 1)) return i + 8;
  if (text.startsWith("https://", i + 1)) return i + 9;
  return -1;
}

/** `/<(https?:\/\/[^|>]+)\|([^>]+)>/g` — a Slack-style `<url|label>` link. */
export function replaceAnglePipeLinks(text: string, replace: (whole: string, url: string, label: string) => string): string {
  if (!text.includes("<http")) return text;
  const nextPipeOrGt = nextIndexer(text, (c) => c === PIPE || c === GT);
  const nextGt = nextIndexer(text, (c) => c === GT);
  return replaceScan(
    text,
    "<",
    (i) => {
      const p = angleUrlBody(text, i);
      if (p < 0) return null;
      const j = nextPipeOrGt(p);
      if (j <= p || text.charCodeAt(j) !== PIPE) return null;
      const k = nextGt(j + 1);
      if (k <= j + 1) return null;
      return { end: k + 1, groups: [text.slice(i + 1, j), text.slice(j + 1, k)] };
    },
    replace as (whole: string, ...groups: string[]) => string,
  );
}

/** `/<(https?:\/\/[^>]+)>/g` — an autolink `<url>`. */
export function replaceAngleLinks(text: string, replace: (whole: string, url: string) => string): string {
  if (!text.includes("<http")) return text;
  const nextGt = nextIndexer(text, (c) => c === GT);
  return replaceScan(
    text,
    "<",
    (i) => {
      const p = angleUrlBody(text, i);
      if (p < 0) return null;
      const j = nextGt(p);
      if (j <= p) return null;
      return { end: j + 1, groups: [text.slice(i + 1, j)] };
    },
    replace as (whole: string, ...groups: string[]) => string,
  );
}

/** `/<([^>]+)>/g` — anything tag-shaped, its inner text non-empty. */
export function replaceTagShapes(text: string, replace: (whole: string, inner: string) => string): string {
  const nextGt = nextIndexer(text, (c) => c === GT);
  return replaceScan(
    text,
    "<",
    (i) => {
      const k = nextGt(i + 1);
      if (k <= i + 1) return null;
      return { end: k + 1, groups: [text.slice(i + 1, k)] };
    },
    replace as (whole: string, ...groups: string[]) => string,
  );
}

/** `text.replace(/<\/?[^>\x00]+>/g, "")` — a tag body never runs through a NUL sentinel. */
export function stripTagShapesNoNul(text: string): string {
  const next = nextIndexer(text, (c) => c === GT || c === 0);
  return replaceScan(
    text,
    "<",
    (i) => {
      // `/` is inside `[^>\x00]`, so the optional slash never changes where the body ends.
      const k = next(i + 1);
      if (k <= i + 1 || text.charCodeAt(k) !== GT) return null;
      return { end: k + 1, groups: [] };
    },
    () => "",
  );
}

/** JS `.`'s complement: `\n`, `\r`, U+2028, U+2029. */
const isLineTerminator = (c: number) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;

/**
 * `new RegExp(`${open}(.*?)${close}`, "g")` for literal `open`/`close` (`<b>`,
 * `</b>`): the first `close` after the opener on the same line.
 */
export function replaceDelimitedOnLine(
  text: string,
  open: string,
  close: string,
  replace: (whole: string, inner: string) => string,
): string {
  if (!text.includes(open)) return text;
  const nextClose = nextNeedle(text, close);
  const nextEol = nextIndexer(text, isLineTerminator);
  return replaceScan(
    text,
    open[0]!,
    (i) => {
      if (!text.startsWith(open, i)) return null;
      const from = i + open.length;
      const c = nextClose(from);
      if (c < 0) return null;
      const eol = nextEol(from);
      if (eol !== -1 && eol < c) return null;
      return { end: c + close.length, groups: [text.slice(from, c)] };
    },
    replace as (whole: string, ...groups: string[]) => string,
  );
}

/** `/<a href="([^"]+)">(.*?)<\/a>/g` — a raw HTML anchor, its text on one line. */
export function replaceHtmlAnchors(text: string, replace: (whole: string, href: string, label: string) => string): string {
  const open = '<a href="';
  if (!text.includes(open)) return text;
  const nextQuote = nextIndexer(text, (c) => c === 0x22);
  const nextClose = nextNeedle(text, "</a>");
  const nextEol = nextIndexer(text, isLineTerminator);
  return replaceScan(
    text,
    "<",
    (i) => {
      if (!text.startsWith(open, i)) return null;
      const p = i + open.length;
      const q = nextQuote(p);
      if (q <= p || text.charCodeAt(q + 1) !== GT) return null;
      const from = q + 2;
      const c = nextClose(from);
      if (c < 0) return null;
      const eol = nextEol(from);
      if (eol !== -1 && eol < c) return null;
      return { end: c + 4, groups: [text.slice(p, q), text.slice(from, c)] };
    },
    replace as (whole: string, ...groups: string[]) => string,
  );
}
