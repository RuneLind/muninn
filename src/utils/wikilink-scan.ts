/**
 * The `[[target|label]]` matcher behind every copy of
 * `/\[\[([^\]|\n]+?)(?:\|([^\]\n]*?))?\]\]/` (architecture review 2026-11-16,
 * A4): the same matches, in linear time, global and sticky alike.
 *
 * The regex rescans to the end of the line from every `[[` that does not close,
 * so one line of `[` cost 3.5 s at 64k chars in `renderWikiHtml`, on gardener
 * drafts made from third-party text. At a start the regex can only succeed at
 * the first `]`, `|` or `\n` after the `[[` (target) and, past a `|`, at the
 * first `]` or `\n` (label); every start before the point a failed start
 * reached fails at that same point, so a global scan resumes there.
 *
 * A sticky caller asks at one start per call (`collapseForLocate` at every `[`,
 * `String.prototype.split` at every position), so each call keeps where its
 * last two runs stopped ({@link ScanMemo}): a start inside a run already read
 * reuses its stop in O(1), and a run of increasing starts reads each character
 * once per kind (fix round 2: the round-1 sticky call read to the end of the
 * line on every miss, 1,053 ms for 32k `[` in `collapseForLocate`).
 *
 * `wikilinkRegExp` returns a RegExp whose `exec` is this scan, so `replace`,
 * `matchAll`, `split`, `test` and a sticky `exec` work unchanged at every call site.
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

/**
 * Where the last run of each kind over `input` stopped: `input[tFrom, tStop)`
 * holds no `]`, `|` or `\n` and `tStop` is one of them or the end (target
 * run); `input[lFrom, lStop)` likewise for `]` and `\n` (label run). Valid for
 * that one string only.
 */
export interface ScanMemo {
  input: string | null;
  tFrom: number;
  tStop: number;
  lFrom: number;
  lStop: number;
}

export const newScanMemo = (): ScanMemo => ({ input: null, tFrom: 0, tStop: -1, lFrom: 0, lStop: -1 });

/** The first `]`, `|` (target only) or `\n` at or after `from`, else `s.length`. */
function runEnd(s: string, from: number, label: boolean, memo: ScanMemo | undefined): number {
  if (memo) {
    if (memo.input !== s) {
      memo.input = s;
      memo.tStop = memo.lStop = -1;
    }
    if (label ? from >= memo.lFrom && from <= memo.lStop : from >= memo.tFrom && from <= memo.tStop) return label ? memo.lStop : memo.tStop;
  }
  let j = from;
  if (label) while (j < s.length && s[j] !== "]" && s[j] !== "\n") j++;
  else while (j < s.length && s[j] !== "]" && s[j] !== "|" && s[j] !== "\n") j++;
  if (memo) {
    if (label) [memo.lFrom, memo.lStop] = [from, j];
    else [memo.tFrom, memo.tStop] = [from, j];
  }
  return j;
}

/**
 * The first match at or after `from` (only AT `from` when `sticky`), as the
 * regex finds it. Pass one `memo` across calls on the same string to make a
 * series of sticky calls linear.
 */
export function scanWikilink(s: string, from: number, sticky = false, memo?: ScanMemo): WikilinkMatch | null {
  let p = from;
  for (;;) {
    if (sticky) {
      if (!s.startsWith("[[", p)) return null;
    } else {
      p = s.indexOf("[[", p);
      if (p < 0) return null;
    }
    const j = runEnd(s, p + 2, false, memo);
    let resume = j;
    if (j > p + 2 && j < s.length) {
      if (s[j] === "]") {
        if (s[j + 1] === "]") return { index: p, end: j + 2, target: s.slice(p + 2, j), label: undefined };
      } else if (s[j] === "|") {
        const k = runEnd(s, j + 1, true, memo);
        if (s[k] === "]" && s[k + 1] === "]") return { index: p, end: k + 2, target: s.slice(p + 2, j), label: s.slice(j + 1, k) };
        resume = k;
      }
    }
    if (sticky) return null;
    p = resume;
  }
}

class WikilinkRegExp extends RegExp {
  /** Sticky only: a global scan resumes past every miss without it, and the memo keeps its last input alive. */
  private readonly memo = newScanMemo();

  constructor(pattern: string | RegExp, flags?: string) {
    super(pattern, flags);
    if (this.source !== LABEL_SOURCE && this.source !== PLAIN_SOURCE) throw new Error(`not a wikilink pattern: ${this.source}`);
  }

  override exec(input: string): RegExpExecArray | null {
    const s = String(input);
    const stateful = this.global || this.sticky;
    const from = stateful ? this.lastIndex : 0;
    const m = from > s.length ? null : scanWikilink(s, from, this.sticky, this.sticky ? this.memo : undefined);
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
