/**
 * Linear readers of third-party HTML for Find links' label (architecture
 * review 2026-11-16, F59). The regexes they replace — `<(style|…)\b[\s\S]*?<\/\1\s*>`,
 * `<!--[\s\S]*?-->`, `<[^>]*>`, `<meta\b[^>]*>`, `<title\b[^>]*>([\s\S]*?)<\/title>` —
 * rescanned to the end of the body from every unclosed opener: 252 KB of
 * `<style ` held the event loop for 14 s. Each reader answers exactly what the
 * regex in its doc comment answered (`html-scan.test.ts` compares them on
 * random markup): the first closer after an opener wins, and an opener with no
 * closer is text, the scan resuming one character on. Every delimiter is found
 * through a memoized next-occurrence (`src/format/linear-scan.ts`).
 */

import { nextIndexer, nextMatch, nextNeedle, replaceScan } from "../format/linear-scan.ts";

/** `html.replace(/<[^>]*>/g, " ")`. */
export function tagsToSpaces(html: string): string {
  const nextGt = nextIndexer(html, (c) => c === 0x3e);
  return replaceScan(
    html,
    "<",
    (i) => {
      const k = nextGt(i + 1);
      return k < 0 ? null : { end: k + 1, groups: [] };
    },
    () => " ",
  );
}

/** `html.replace(new RegExp(`<(${names})\\b[\\s\\S]*?<\\/\\1\\s*>`, "gi"), " ")`. */
export function withoutBlocks(html: string, names: readonly string[]): string {
  const open = new RegExp(`<(${names.join("|")})\\b`, "gi");
  const closers = new Map<string, ReturnType<typeof nextMatch>>();
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html)) !== null) {
    const name = m[1]!.toLowerCase();
    let next = closers.get(name);
    if (!next) closers.set(name, (next = nextMatch(html, new RegExp(`<\\/${name}\\s*>`, "i"))));
    const close = next(open.lastIndex);
    if (!close) {
      open.lastIndex = m.index + 1;
      continue;
    }
    out += `${html.slice(cursor, m.index)} `;
    cursor = close.index + close.length;
    open.lastIndex = cursor;
  }
  return cursor === 0 ? html : out + html.slice(cursor);
}

/** `html.replace(/<!--[\s\S]*?-->/g, " ")`. */
export function withoutComments(html: string): string {
  if (!html.includes("<!--")) return html;
  const nextEnd = nextNeedle(html, "-->");
  return replaceScan(
    html,
    "<",
    (i) => {
      if (!html.startsWith("<!--", i)) return null;
      const k = nextEnd(i + 4);
      return k < 0 ? null : { end: k + 3, groups: [] };
    },
    () => " ",
  );
}

/**
 * The open tags `<name\b[^>]*>` in document order (`opens` is `/<name\b/gi`):
 * each runs to the first `>` after it; an opener with no `>` after it is none.
 */
export function* openTags(html: string, opens: RegExp): Generator<{ index: number; end: number }> {
  const nextGt = nextIndexer(html, (c) => c === 0x3e);
  opens.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = opens.exec(html)) !== null) {
    const gt = nextGt(opens.lastIndex);
    if (gt < 0) return;
    yield { index: m.index, end: gt + 1 };
    opens.lastIndex = gt + 1;
  }
}

/** `new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(html)?.[1]`. */
export function firstElementText(html: string, name: string): string | undefined {
  const opens = new RegExp(`<${name}\\b`, "gi");
  const nextGt = nextIndexer(html, (c) => c === 0x3e);
  const nextClose = nextMatch(html, new RegExp(`<\\/${name}>`, "i"));
  // Only the first open tag needs trying: a later one's `>` and close come
  // after the first one's, so when the first has none, no later one has.
  if (!opens.exec(html)) return undefined;
  const gt = nextGt(opens.lastIndex);
  const close = gt < 0 ? null : nextClose(gt + 1);
  return close ? html.slice(gt + 1, close.index) : undefined;
}

const isJsSpace = (c: number) => /\s/.test(String.fromCharCode(c));

/** `text.replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1")`, linear (F59: one per `[` without a `]`). */
export function withoutLinkTargets(text: string): string {
  if (!text.includes("](")) return text;
  const nextBracket = nextIndexer(text, (c) => c === 0x5d);
  const nextEnd = nextIndexer(text, (c) => c === 0x29 || isJsSpace(c));
  return replaceScan(
    text,
    "[",
    (i) => {
      const j = nextBracket(i + 1);
      if (j < 0 || text.charCodeAt(j + 1) !== 0x28) return null;
      const k = nextEnd(j + 2);
      if (k < 0 || text.charCodeAt(k) !== 0x29) return null;
      return { end: k + 1, groups: [text.slice(i + 1, j)] };
    },
    (_w, label) => label!,
  );
}

const LD_JSON_TYPE_RE = /\btype\s*=\s*["']?application\/ld\+json/i;

/**
 * The bodies `/<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi`
 * captured: the type is read off the open tag (up to its first `>`), the
 * close is the first `</script>` after it, and an open tag that is not
 * JSON-LD or has no close resumes the scan after its `>`. The regex resumed
 * one character on, but an opener inside the same tag reads a suffix of the
 * same text up to the same `>` and the same close, so it fails too; testing
 * each one re-read the tag (fix round 1: 23 s on 2 MB of `<script ` openers
 * before one `>`).
 */
export function ldJsonBodies(markup: string): string[] {
  const out: string[] = [];
  const opens = /<script\b/gi;
  const nextGt = nextIndexer(markup, (c) => c === 0x3e);
  const nextClose = nextMatch(markup, /<\/script\s*>/i);
  let m: RegExpExecArray | null;
  while ((m = opens.exec(markup)) !== null) {
    const gt = nextGt(opens.lastIndex);
    if (gt < 0) break;
    const close = LD_JSON_TYPE_RE.test(markup.slice(opens.lastIndex, gt)) ? nextClose(gt + 1) : null;
    if (!close) {
      opens.lastIndex = gt + 1;
      continue;
    }
    out.push(markup.slice(gt + 1, close.index));
    opens.lastIndex = close.index + close.length;
  }
  return out;
}
