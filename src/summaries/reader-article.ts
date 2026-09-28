/**
 * The /summaries doc panel's article: the pure logic.
 *
 * The hero pills, the TL;DR lede, the Key takeaways card, the outline, the
 * Similar cards' why line, the YouTube timestamp links and the newer/older
 * neighbours. Same contract as `latest-rail.ts`: plain `export function`
 * declarations the page script receives with `.toString()`, so a function
 * here may call only other functions in this file, and every one of them is
 * in `READER_FUNCTIONS` below.
 *
 * Every builder degrades to absent: a value the document does not carry gives
 * no pill, no card and no line, never an empty one or a placeholder.
 */

export interface ReaderHeading {
  level: number;
  /** The heading as the reader sees it: inline markdown removed. */
  text: string;
}

export interface ReaderPill {
  key: "source" | "captured" | "kind" | "category" | "author" | "published" | "length" | "read";
  label: string;
  value: string;
  /** Set on a length read off the transcript's last window heading. */
  estimated?: boolean;
}

export interface ReaderPillInput {
  /** The source's badge (`YouTube`), or null for an unregistered source. */
  sourceLabel?: string | null;
  /** The capture date (`metadata.date`, else the listing's). */
  date?: unknown;
  /** Today's UTC day, `YYYY-MM-DD`. */
  today: string;
  kind?: unknown;
  category?: unknown;
  author?: unknown;
  uploadDate?: unknown;
  durationSec?: unknown;
  /** The markdown before `## Transcript`. */
  body: string;
  /** The markdown after `## Transcript`, or null. */
  transcript: string | null;
}

export interface ReaderSimilarWhy {
  heading: string;
  transcript: boolean;
}

/** `fn` over every line outside fenced code; fenced lines are kept as they
 *  are. A fence closes only on its own marker, at least as long as the
 *  opener: the rule of `mapProseLines` in `transcript-split.ts`. */
export function readerMapProse(markdown: string, fn: (line: string, i: number) => string): string {
  let fence: string | null = null;
  return String(markdown).split("\n").map((line, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) {
        fence = m[1]!;
        return line;
      }
      if (m[1]!.charAt(0) === fence.charAt(0) && m[1]!.length >= fence.length) {
        fence = null;
        return line;
      }
    }
    return fence === null ? fn(line, i) : line;
  }).join("\n");
}

/** A heading's text with inline markdown removed: links keep their text,
 *  emphasis and code marks go, a closing `#` run goes. */
export function readerPlainText(raw: string): string {
  return String(raw)
    .replace(/\s+#+\s*$/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1")
    .trim();
}

/** Every ATX heading outside fenced code, at the top level of the document:
 *  not indented four spaces, not inside a blockquote. */
export function readerHeadings(markdown: string): ReaderHeading[] {
  const out: ReaderHeading[] = [];
  readerMapProse(markdown, (line) => {
    const m = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (m) {
      const text = readerPlainText(m[2]!);
      if (text) out.push({ level: m[1]!.length, text });
    }
    return line;
  });
  return out;
}

/** The outline: the `##` headings, or the `###` ones when the body has no
 *  `##` (the older summaries). Empty when it has neither. */
export function readerOutline(body: string): ReaderHeading[] {
  const all = readerHeadings(body);
  const level = all.some((h) => h.level === 2) ? 2 : 3;
  return all.filter((h) => h.level === level);
}

/**
 * The lede: the body's first non-blank line outside fenced code, when that
 * whole line is italic (`*…*` or `_…_`, not bold). `text` is the line
 * without its marks; `rest` is the body without the line.
 */
export function readerLede(body: string): { text: string; rest: string } | null {
  const lines = String(body).split("\n");
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "") continue;
    at = i;
    break;
  }
  if (at === -1) return null;
  const line = lines[at]!.trim();
  const m = /^\*(?!\*)(\S(?:.*\S)?)\*$/.exec(line) || /^_(?!_)(\S(?:.*\S)?)_$/.exec(line);
  // Bold, or two italic runs on one line (`*a* and *b*`), is not a lede.
  if (!m || /^[*_]|[*_]$/.test(m[1]!) || /[*_]\s|\s[*_]/.test(m[1]!)) return null;
  const rest = lines.slice(0, at).concat(lines.slice(at + 1)).join("\n");
  return { text: m[1]!, rest };
}

/**
 * The Key takeaways section: a `## Key takeaways` or `## 💡 Key Takeaway`
 * heading (case aside, either number) outside fenced code, through the line
 * before the next `#` or `##` heading. `before` + `section` + `after` is the
 * body. Null when there is no such heading.
 */
export function readerTakeaways(body: string): { before: string; section: string; after: string } | null {
  const lines = String(body).split("\n");
  let start = -1;
  let end = lines.length;
  readerMapProse(body, (line, i) => {
    if (start === -1) {
      if (/^##[ \t]+(?:💡[ \t]*)?key[ \t]+takeaways?[ \t]*$/i.test(line)) start = i;
    } else if (end === lines.length && i > start && /^#{1,2}[ \t]/.test(line)) {
      end = i;
    }
    return line;
  });
  if (start === -1) return null;
  return {
    before: lines.slice(0, start).join("\n"),
    section: lines.slice(start, end).join("\n"),
    after: lines.slice(end).join("\n"),
  };
}

/** The words a reader reads in `markdown`: link and image targets, heading
 *  and list marks, and table rules are not words. */
export function readerWordCount(markdown: string): number {
  const text = String(markdown)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ");
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length;
}

/** Reading minutes at 230 words a minute; at least one when there is text. */
export function readerReadMinutes(words: number): number {
  if (!(words > 0)) return 0;
  return Math.max(1, Math.round(words / 230));
}

/** The seconds a `[H:MM:SS]` / `[MM:SS]` label names, or null. */
export function readerStampSeconds(label: string): number | null {
  const m = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?$/.exec(String(label).trim());
  if (!m) return null;
  return m[3] === undefined
    ? Number(m[1]) * 60 + Number(m[2])
    : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** The start of a windowed transcript's LAST `### [HH:MM:SS]` window, in
 *  seconds, or null for a flat transcript or none. */
export function readerTranscriptEnd(transcript: string | null): number | null {
  if (transcript === null || transcript === undefined) return null;
  let last: number | null = null;
  readerMapProse(transcript, (line) => {
    const m = /^### (\[\d{1,2}:\d{2}:\d{2}\])\s*$/.exec(line);
    if (m) last = readerStampSeconds(m[1]!);
    return line;
  });
  return last;
}

/** `54 min`, `1 h 12 min`, `2 h`; under a minute reads as `1 min`. */
export function readerFormatDuration(sec: number): string {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return min + " min";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + " h " + m + " min" : h + " h";
}

/** Whole days from `day` to `today`, both `YYYY-MM-DD`, or null when either
 *  is not a day. */
export function readerDaysBetween(day: unknown, today: string): number | null {
  if (typeof day !== "string") return null;
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!a || !b) return null;
  const ta = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const tb = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  if (isNaN(ta) || isNaN(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

/** `today`, `yesterday`, `5 days ago`, `3 months ago`, `2 years ago`; null
 *  for a day in the future or no day. */
export function readerAge(day: unknown, today: string): string | null {
  const n = readerDaysBetween(day, today);
  if (n === null || n < 0) return null;
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  // Days through 60, the Similar cards' amber line, so "2 months ago" is
  // always amber and "60 days ago" never is.
  if (n <= 60) return n + " days ago";
  if (n < 730) return Math.round(n / 30.44) + " months ago";
  return Math.floor(n / 365.25) + " years ago";
}

/** A non-blank string value, trimmed, or null. */
export function readerStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The hero pills, in display order, each only when its value exists:
 * source, captured (with age), kind, category, author, published (the first
 * 10 characters of `upload_date`, so Vimeo's `YYYY-MM-DD HH:MM:SS` and
 * YouTube's `YYYY-MM-DD` read alike), length (`duration_sec`, else the last
 * window heading of a windowed transcript, marked estimated) and read time
 * (the words before `## Transcript`).
 */
export function readerPills(input: ReaderPillInput): ReaderPill[] {
  const pills: ReaderPill[] = [];
  const src = readerStr(input.sourceLabel);
  if (src) pills.push({ key: "source", label: "Source", value: src });
  const date = readerStr(input.date);
  const day = date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null;
  if (day) {
    const age = readerAge(day, input.today);
    pills.push({ key: "captured", label: "Captured", value: age ? day + " · " + age : day });
  }
  const kind = readerStr(input.kind);
  if (kind) pills.push({ key: "kind", label: "Kind", value: kind });
  const category = readerStr(input.category);
  if (category) pills.push({ key: "category", label: "Category", value: category });
  const author = readerStr(input.author);
  if (author) pills.push({ key: "author", label: "By", value: author });
  const upload = readerStr(input.uploadDate);
  if (upload && /^\d{4}-\d{2}-\d{2}/.test(upload)) pills.push({ key: "published", label: "Published", value: upload.slice(0, 10) });
  const dur = typeof input.durationSec === "number" ? input.durationSec
    : typeof input.durationSec === "string" && /^\d+$/.test(input.durationSec.trim()) ? Number(input.durationSec) : NaN;
  if (dur > 0) {
    pills.push({ key: "length", label: "Length", value: readerFormatDuration(dur) });
  } else {
    const end = readerTranscriptEnd(input.transcript);
    if (end !== null && end > 0) pills.push({ key: "length", label: "Length", value: "~" + readerFormatDuration(end), estimated: true });
  }
  const minutes = readerReadMinutes(readerWordCount(input.body));
  if (minutes > 0) pills.push({ key: "read", label: "Read", value: minutes + " min read" });
  return pills;
}

/** Is a matched chunk's heading a transcript heading: a `[HH:MM:SS]` window,
 *  or the bare `Transcript` heading a flat transcript sits under? The rule
 *  PR 2's transcript-match metric reads too. */
export function readerIsTranscriptHeading(heading: unknown): boolean {
  if (typeof heading !== "string") return false;
  const h = heading.trim();
  return /^\[\d{1,2}:\d{2}(?::\d{2})?\]$/.test(h) || /^transcript$/i.test(h);
}

/** The why line of a Similar card: the first matched chunk that carries a
 *  heading (a lede chunk carries none), or null. */
export function readerSimilarWhy(chunks: unknown): ReaderSimilarWhy | null {
  if (!Array.isArray(chunks)) return null;
  for (const c of chunks) {
    const heading = c && typeof c === "object" ? readerStr((c as { heading?: unknown }).heading) : null;
    if (heading) return { heading, transcript: readerIsTranscriptHeading(heading) };
  }
  return null;
}

/** The 11-character id a YouTube url names, or null: `youtu.be/<id>` or a
 *  `v=` on youtube.com or a real subdomain of it (the rule of
 *  `extractYouTubeVideoId`), and only the id charset. */
export function readerYouTubeId(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1);
  else if (host === "youtube.com" || host.endsWith(".youtube.com")) id = u.searchParams.get("v");
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** A thumbnail for a document: YouTube from its video id, Vimeo from the
 *  stored `thumbnail_url` (http(s) only); none for any other source. */
export function readerThumbnail(source: string, url: unknown, thumbnailUrl: unknown): string | null {
  if (source === "youtube") {
    const id = readerYouTubeId(url);
    return id ? "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg" : null;
  }
  if (source === "vimeo") {
    const t = readerStr(thumbnailUrl);
    return t && /^https?:\/\//i.test(t) ? t : null;
  }
  return null;
}

/**
 * Every `[HH:MM:SS]` / `[MM:SS]` outside fenced code, and not already a link
 * label, → a link to that second of the YouTube video
 * (`https://www.youtube.com/watch?v=<id>&t=<sec>s`), label kept in its
 * brackets. The YouTube twin of `linkVimeoTimestamps`; no id ⇒ untouched.
 */
export function linkYouTubeTimestamps(markdown: string, videoUrl: unknown): string {
  const id = readerYouTubeId(videoUrl);
  if (!id) return markdown;
  const base = "https://www.youtube.com/watch?v=" + id + "&t=";
  return readerMapProse(markdown, (line) =>
    line.replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\](?!\()/g, (whole: string, a: string, b: string, c?: string) => {
      const sec = c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
      return "[\\[" + whole.slice(1, -1) + "\\]](" + base + sec + "s)";
    }),
  );
}

/** The header's source link label. `x-article` holds both X videos and
 *  pasted posts, so it is labelled per document: a transcript means a
 *  video. Every other source keeps its registry label. */
export function readerSourceLinkLabel(sourceId: string, registryLabel: string, hasTranscript: boolean): string {
  if (sourceId === "x-article") return hasTranscript ? "Watch on X ↗" : "Read on X ↗";
  return registryLabel;
}

/** The rows beside `key` in `keys` (newest first): `newer` is the one
 *  before, `older` the one after; -1 where there is none or `key` is absent. */
export function readerNeighbours(keys: string[], key: string): { newer: number; older: number } {
  const at = keys.indexOf(key);
  if (at === -1) return { newer: -1, older: -1 };
  return { newer: at > 0 ? at - 1 : -1, older: at < keys.length - 1 ? at + 1 : -1 };
}

/** Every function the page script needs, in dependency order. The injection
 *  and its guard test both read this list. */
export const READER_FUNCTIONS = [
  readerMapProse,
  readerPlainText,
  readerHeadings,
  readerOutline,
  readerLede,
  readerTakeaways,
  readerWordCount,
  readerReadMinutes,
  readerStampSeconds,
  readerTranscriptEnd,
  readerFormatDuration,
  readerDaysBetween,
  readerAge,
  readerStr,
  readerPills,
  readerIsTranscriptHeading,
  readerSimilarWhy,
  readerYouTubeId,
  readerThumbnail,
  linkYouTubeTimestamps,
  readerSourceLinkLabel,
  readerNeighbours,
] as const;
