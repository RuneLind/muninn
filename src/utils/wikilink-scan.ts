/**
 * The `[[target|label]]` matcher behind every copy of
 * `/\[\[([^\]|\n]+?)(?:\|([^\]\n]*?))?\]\]/` (architecture review 2026-11-16,
 * fix round 1 of A4): the same matches, in linear time.
 *
 * The regex rescans to the end of the line from every `[[` that does not close,
 * so one line of `[` cost 3.5 s at 64k chars in `renderWikiHtml`, on gardener
 * drafts made from third-party text. At a start the regex can only succeed at
 * the first `]`, `|` or `\n` after the `[[` (target) and, past a `|`, at the
 * first `]` or `\n` (label); every start before the point a failed start
 * reached fails at that same point, so the scan resumes there.
 *
 * `wikilinkRegExp` returns a RegExp whose `exec` is this scan, so `replace`,
 * `matchAll`, `test` and a sticky `exec` work unchanged at every call site.
 */

const LABEL_SOURCE = String.raw`\[\[([^\]|\n]+?)(?:\|([^\]\n]*?))?\]\]`;
const PLAIN_SOURCE = String.raw`\[\[([^\]|\n]+?)(?:\|[^\]\n]*?)?\]\]`;

export interface WikilinkMatch {
  index: number;
  end: number;
  target: string;
  /** `undefined` when there is no `|`. */
  label: string | undefined;
}

/** The first match at or after `from` (only AT `from` when `sticky`), as the regex finds it. */
export function scanWikilink(s: string, from: number, sticky = false): WikilinkMatch | null {
  let p = from;
  for (;;) {
    p = s.indexOf("[[", p);
    if (p < 0 || (sticky && p !== from)) return null;
    let j = p + 2;
    while (j < s.length && s[j] !== "]" && s[j] !== "|" && s[j] !== "\n") j++;
    let resume = j;
    if (j > p + 2 && j < s.length) {
      if (s[j] === "]") {
        if (s[j + 1] === "]") return { index: p, end: j + 2, target: s.slice(p + 2, j), label: undefined };
      } else if (s[j] === "|") {
        let k = j + 1;
        while (k < s.length && s[k] !== "]" && s[k] !== "\n") k++;
        if (s[k] === "]" && s[k + 1] === "]") return { index: p, end: k + 2, target: s.slice(p + 2, j), label: s.slice(j + 1, k) };
        resume = k;
      }
    }
    if (sticky) return null;
    p = resume;
  }
}

class WikilinkRegExp extends RegExp {
  constructor(pattern: string | RegExp, flags?: string) {
    super(pattern, flags);
    if (this.source !== LABEL_SOURCE && this.source !== PLAIN_SOURCE) throw new Error(`not a wikilink pattern: ${this.source}`);
  }

  override exec(input: string): RegExpExecArray | null {
    const s = String(input);
    const stateful = this.global || this.sticky;
    const from = stateful ? this.lastIndex : 0;
    const m = from > s.length ? null : scanWikilink(s, from, this.sticky);
    if (!m) {
      if (stateful) this.lastIndex = 0;
      return null;
    }
    if (stateful) this.lastIndex = m.end;
    const whole = s.slice(m.index, m.end);
    const out = (this.source === LABEL_SOURCE ? [whole, m.target, m.label] : [whole, m.target]) as unknown as RegExpExecArray;
    out.index = m.index;
    out.input = s;
    out.groups = undefined;
    return out;
  }
}

/**
 * A linear-time stand-in for the wikilink regex: `"label"` captures target and
 * label (`/\[\[([^\]|\n]+?)(?:\|([^\]\n]*?))?\]\]/`), `"plain"` the target only
 * (`/\[\[([^\]|\n]+?)(?:\|[^\]\n]*?)?\]\]/`). Its `source` is that pattern.
 */
export function wikilinkRegExp(kind: "label" | "plain", flags = "g"): RegExp {
  return new WikilinkRegExp(kind === "label" ? LABEL_SOURCE : PLAIN_SOURCE, flags);
}
