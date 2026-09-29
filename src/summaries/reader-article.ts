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
 *
 * Four functions from other modules are called here by name:
 * `extractYouTubeVideoId`, injected beside these (`READER_IMPORTS`), and
 * three the page's other scripts already declare — `mapProseLines` (the
 * summaries library's client copy of the transcript-split.ts function) and
 * `railDate`/`railValidDay` (the Latest rail's script). A second injected
 * declaration would replace the page's copy for every caller.
 * `READER_STALE_DAYS`, the three `SAME_STORY_*` constants and the two
 * `SIMILAR_QUERY_*` ones are injected as `var`s the same way.
 */

import { mapProseLines } from "./transcript-split.ts";
import { extractYouTubeVideoId } from "../youtube/url.ts";
import { railDate, railValidDay } from "./latest-rail.ts";

/** Past this many days an age reads in months, and a Similar card's age
 *  turns amber: "2 months ago" is always amber, "60 days ago" never is. */
export const READER_STALE_DAYS = 60;

/**
 * Same story this week keeps a hit at or above this relevance. Measured
 * 2026-09-29 on 7 real same-story anchors with the title query: 8 of the 9
 * siblings huginn returned scored 0.436–0.67, the ninth 0.229 (rank 20). These
 * answers were not reranked, so relevance is rank-based
 * (0.75 / (1 + 0.12·i)): 0.43 keeps the top 7 of the search.
 */
export const SAME_STORY_MIN_RELEVANCE = 0.43;

/** Same story this week: captured at most this many days before today. */
export const SAME_STORY_DAYS = 7;

/** Same story this week shows at most this many cards. */
export const SAME_STORY_MAX = 5;

/** Similar's query: the opening of the summary, as long as the ingest-time
 *  Similar's `summary[:2000]` (huginn `main/ingest/registry.py`). */
export const SIMILAR_QUERY_CHARS = 2000;

/** The query rides in a GET twice (browser → muninn → huginn), and huginn's
 *  request head is capped at 16 KiB: trim until the encoded `q` fits in 6 KB.
 *  Measured 2026-09-29 on 11 real summaries: 2,873–3,075 bytes. */
export const SIMILAR_QUERY_MAX_ENCODED = 6144;

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
  /** The capture date: `metadata.date`, else the listing row's. */
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
  mapProseLines(String(markdown), (line) => {
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
 * whole line is italic (`*…*` or `_…_`, not bold), `**bold**` runs inside it
 * allowed. `text` is the line without its outer marks; `rest` is the body
 * without the line.
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
  if (!m) return null;
  // Bold runs inside are fine; what is left must hold no other mark at an
  // edge, or the line is bold, or two italic runs (`*a* and *b*`).
  const inner = m[1]!.replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "$1");
  if (/^[*_]|[*_]$/.test(inner) || /[*_]\s|\s[*_]/.test(inner)) return null;
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
  mapProseLines(String(body), (line, i) => {
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

/**
 * A windowed transcript's estimated length in seconds: the start of its last
 * `### [HH:MM:SS]` window, plus that window's words at the rate of the
 * windows before it (their words over their span). Null for a flat
 * transcript, none, or a single window, which has no earlier window to
 * measure a rate on.
 */
export function readerTranscriptLength(transcript: string | null): number | null {
  if (transcript === null || transcript === undefined) return null;
  const windows: { start: number; text: string }[] = [];
  mapProseLines(String(transcript), (line) => {
    const m = /^### (\[\d{1,2}:\d{2}:\d{2}\])\s*$/.exec(line);
    if (m) windows.push({ start: readerStampSeconds(m[1]!) ?? 0, text: "" });
    else if (windows.length) windows[windows.length - 1]!.text += line + "\n";
    return line;
  });
  if (windows.length < 2) return null;
  const last = windows[windows.length - 1]!;
  const span = last.start - windows[0]!.start;
  let earlier = 0;
  for (let i = 0; i < windows.length - 1; i++) earlier += readerWordCount(windows[i]!.text);
  const lastWords = readerWordCount(last.text);
  return earlier > 0 ? last.start + lastWords * (span / earlier) : last.start;
}

/** `54 min`, `1 h 12 min`, `2 h`; under a minute reads as `1 min`. */
export function readerFormatDuration(sec: number): string {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return min + " min";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + " h " + m + " min" : h + " h";
}

/** The `YYYY-MM-DD` day that starts `v`, when the calendar has it; else null. */
export function readerDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const day = v.trim().slice(0, 10);
  return railValidDay(day) ? day : null;
}

/** Whole days from `day` to `today`, or null when either is not a real day. */
export function readerDaysBetween(day: unknown, today: string): number | null {
  const a = readerDay(day);
  const b = readerDay(today);
  if (!a || !b) return null;
  const at = (d: string) => railDate(Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))).getTime();
  return Math.round((at(b) - at(a)) / 86400000);
}

/** `today`, `yesterday`, `5 days ago`, `3 months ago`, `1 year ago`,
 *  `2 years ago`; null for a day in the future or no day. */
export function readerAge(day: unknown, today: string): string | null {
  const n = readerDaysBetween(day, today);
  if (n === null || n < 0) return null;
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  if (n <= READER_STALE_DAYS) return n + " days ago";
  const years = Math.floor(n / 365);
  if (years < 1) return Math.round(n / 30.44) + " months ago";
  return years === 1 ? "1 year ago" : years + " years ago";
}

/** A non-blank string value, trimmed, or null. */
export function readerStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The hero pills, in display order, each only when its value exists:
 * source, captured (with age), kind, category, author, published (the first
 * 10 characters of `upload_date`, so Vimeo's `YYYY-MM-DD HH:MM:SS` and
 * YouTube's `YYYY-MM-DD` read alike), length (`duration_sec`, else
 * `readerTranscriptLength`, marked estimated) and read time
 * (the words before `## Transcript`).
 */
export function readerPills(input: ReaderPillInput): ReaderPill[] {
  const pills: ReaderPill[] = [];
  const src = readerStr(input.sourceLabel);
  if (src) pills.push({ key: "source", label: "Source", value: src });
  const day = readerDay(input.date);
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
  const upload = readerDay(input.uploadDate);
  if (upload) pills.push({ key: "published", label: "Published", value: upload });
  const dur = typeof input.durationSec === "number" ? input.durationSec
    : typeof input.durationSec === "string" && /^\d+$/.test(input.durationSec.trim()) ? Number(input.durationSec) : NaN;
  if (dur > 0) {
    pills.push({ key: "length", label: "Length", value: readerFormatDuration(dur) });
  } else {
    const est = readerTranscriptLength(input.transcript);
    if (est !== null && est > 0) pills.push({ key: "length", label: "Length", value: "~" + readerFormatDuration(est), estimated: true });
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

export interface ReaderSameStoryHit {
  source?: unknown;
  id?: unknown;
  relevance?: unknown;
  modifiedTime?: unknown;
  metadata?: { date?: unknown } | null;
  [key: string]: unknown;
}

/** One key per document across sources: a doc id is collection-relative. */
export function readerDocKey(source: unknown, id: unknown): string {
  return String(source) + "|" + String(id);
}

/**
 * The Same story this week cards: the same-story search's hits captured in
 * the last `SAME_STORY_DAYS` days (`metadata.date`, else `modifiedTime`) at
 * or above `SAME_STORY_MIN_RELEVANCE`, without the open document and without
 * any document Similar already shows (`shownKeys`, from `readerDocKey`). In
 * the search's order, at most `SAME_STORY_MAX`.
 */
export function readerSameStory(
  hits: unknown,
  open: { source: string; docId: string },
  shownKeys: string[],
  today: string,
): ReaderSameStoryHit[] {
  if (!Array.isArray(hits)) return [];
  const skip: Record<string, boolean> = {};
  skip[readerDocKey(open.source, open.docId)] = true;
  for (const k of shownKeys) skip[k] = true;
  const out: ReaderSameStoryHit[] = [];
  for (const h of hits as ReaderSameStoryHit[]) {
    if (!h || typeof h.source !== "string" || typeof h.id !== "string") continue;
    const key = readerDocKey(h.source, h.id);
    if (skip[key]) continue;
    if (!(typeof h.relevance === "number" && h.relevance >= SAME_STORY_MIN_RELEVANCE)) continue;
    const day = readerDay(h.metadata && h.metadata.date) || readerDay(h.modifiedTime);
    const days = readerDaysBetween(day, today);
    if (days === null || days < 0 || days > SAME_STORY_DAYS) continue;
    skip[key] = true;
    out.push(h);
    if (out.length >= SAME_STORY_MAX) break;
  }
  return out;
}

export interface ReaderWikiItem {
  bot: string;
  status: "draft" | "approved" | "applied";
  label: string;
  targetPath: string;
  href: string;
}

/**
 * The In your wiki rows: each `source` proposal drafted from the open
 * summary, linked into its bot's wiki. An applied page opens in the wiki
 * reader; a draft or an approved one opens that wiki's review gate. A
 * rejected, stale or failed proposal is not in the wiki and gets no row.
 */
export function readerWikiContext(proposals: unknown): ReaderWikiItem[] {
  if (!Array.isArray(proposals)) return [];
  const labels: Record<string, string> = { applied: "In the wiki", draft: "Draft to review", approved: "Approved, not applied" };
  const out: ReaderWikiItem[] = [];
  for (const p of proposals) {
    if (!p || typeof p !== "object") continue;
    const { bot, status, targetPath } = p as { bot?: unknown; status?: unknown; targetPath?: unknown };
    if (typeof bot !== "string" || !bot || typeof targetPath !== "string") continue;
    if (status !== "applied" && status !== "draft" && status !== "approved") continue;
    const wiki = encodeURIComponent(bot);
    out.push({
      bot,
      status,
      label: labels[status]!,
      targetPath,
      href: status === "applied"
        ? "/wiki?wiki=" + wiki + "&path=" + encodeURIComponent(targetPath)
        : "/wiki/gardener?wiki=" + wiki,
    });
  }
  return out;
}

/** The first `n` UTF-16 units of `s`, one fewer when the cut would leave
 *  half a surrogate pair (an emoji), which `encodeURIComponent` throws on. */
export function readerCutQuery(s: string, n: number): string {
  let out = s.slice(0, Math.max(0, n));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * Similar's query for a stored summary: the text before its `## Transcript`
 * heading (outside fenced code), trimmed, cut to `SIMILAR_QUERY_CHARS`
 * UTF-16 units (huginn's cut counts code points; the difference is accepted),
 * then trimmed further until `encodeURIComponent(q)` is at most
 * `SIMILAR_QUERY_MAX_ENCODED` bytes. Empty when the summary has no text
 * before the transcript; the caller then searches the title.
 */
export function readerSimilarQuery(markdown: string): string {
  const text = String(markdown);
  let at = -1;
  mapProseLines(text, (line, i) => {
    if (at === -1 && /^## Transcript\s*$/.test(line)) at = i;
    return line;
  });
  const body = at === -1 ? text : text.split("\n").slice(0, at).join("\n");
  let q = readerCutQuery(body.trim(), SIMILAR_QUERY_CHARS);
  let size = encodeURIComponent(q).length;
  while (size > SIMILAR_QUERY_MAX_ENCODED) {
    // Shrink in proportion, and always by at least one unit.
    const keep = Math.min(q.length - 1, Math.floor(q.length * SIMILAR_QUERY_MAX_ENCODED / size));
    q = readerCutQuery(q, keep);
    size = encodeURIComponent(q).length;
  }
  return q.trim();
}

/** The 11-character id a YouTube url names (`extractYouTubeVideoId`'s host
 *  rule), or null; only the id charset, since it lands in a url and a src. */
export function readerYouTubeId(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const id = extractYouTubeVideoId(url.trim());
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** The address a YouTube timestamp link starts with; `<sec>s` follows. */
export function readerYouTubeStampBase(id: string): string {
  return "https://www.youtube.com/watch?v=" + id + "&t=";
}

/** A thumbnail for a document: YouTube from its video id, Vimeo from the
 *  stored `thumbnail_url`; none for any other source. https only, the
 *  Shelf's rule: an `<img src>` is a fetch the reader's browser makes. */
export function readerThumbnail(source: string, url: unknown, thumbnailUrl: unknown): string | null {
  let t: string | null = null;
  if (source === "youtube") {
    const id = readerYouTubeId(url);
    t = id ? "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg" : null;
  } else if (source === "vimeo") {
    t = readerStr(thumbnailUrl);
  }
  return t && /^https:\/\//i.test(t) ? t : null;
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
  const base = readerYouTubeStampBase(id);
  return mapProseLines(String(markdown), (line) =>
    line.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\](?!\()/g, (whole: string) =>
      "[\\[" + whole.slice(1, -1) + "\\]](" + base + readerStampSeconds(whole) + "s)"),
  );
}

/**
 * The header's source link label. A source with `docLinkLabels` (x-article:
 * X videos and pasted posts in one collection) is labelled per document, a
 * transcript meaning a video; `hasTranscript` null means the document has
 * not been read, and the answer is null, no label yet. Every other source
 * keeps its registry `linkLabel`.
 */
export function readerSourceLinkLabel(
  source: { linkLabel: string; docLinkLabels?: { transcript: string; text: string } | null } | null | undefined,
  hasTranscript: boolean | null,
): string | null {
  if (!source) return "Open ↗";
  const per = source.docLinkLabels;
  if (!per) return source.linkLabel;
  if (hasTranscript === null) return null;
  return hasTranscript ? per.transcript : per.text;
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
  readerPlainText,
  readerHeadings,
  readerOutline,
  readerLede,
  readerTakeaways,
  readerWordCount,
  readerReadMinutes,
  readerStampSeconds,
  readerTranscriptLength,
  readerFormatDuration,
  readerDay,
  readerDaysBetween,
  readerAge,
  readerStr,
  readerPills,
  readerIsTranscriptHeading,
  readerSimilarWhy,
  readerDocKey,
  readerSameStory,
  readerWikiContext,
  readerCutQuery,
  readerSimilarQuery,
  readerYouTubeId,
  readerYouTubeStampBase,
  readerThumbnail,
  linkYouTubeTimestamps,
  readerSourceLinkLabel,
  readerNeighbours,
] as const;

/** The functions from other modules the ones above call, injected beside
 *  them. (`mapProseLines`, `railDate` and `railValidDay` are not here: the
 *  page's other scripts declare them.) */
export const READER_IMPORTS = [extractYouTubeVideoId] as const;
