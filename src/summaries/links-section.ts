/**
 * The stored `## Links` section — its grammar, its one locator, and the model
 * envelope line that picks what goes in it.
 *
 * Body order is fixed (plan D12): summary · fact-check block ·
 * `## Visual reference` · `## Links` · `## Transcript`. Every reader of the
 * section — the fact-check ranges, the fact-check insert, the re-run split —
 * locates it through {@link findLinksSection}, and the grammar is fixed so
 * {@link parseLinksSection} can read back what {@link renderLinksSection} wrote:
 *
 *     ## Links
 *
 *     - 📄 [Title](url) — Attribution · from description
 *
 *     _7 creator and social links in the description are not listed._
 *
 * Titles and attributions are third-party text, so the renderer escapes them
 * (markdown punctuation backslash-escaped, a `!` before `[` dropped, the two
 * separators ` — ` and ` · ` replaced) and percent-encodes `(` `)` in the URL.
 * Plain markdown, no HTML: `/summaries` and the export escape raw HTML.
 */

import { mapProseLines, TRANSCRIPT_HEADING_RE, unclosedFenceMarker } from "./transcript-split.ts";

/** One line of the section. */
export interface LinkLine {
  /** `📄` page, `📦` repo, `🔎` found by search. */
  readonly icon: string;
  readonly title: string;
  readonly url: string;
  /** Attribution or detail after ` — `; "" for none. */
  readonly detail: string;
  /** Where the line came from, after the last ` · ` (`from description`). */
  readonly provenance: string;
}

export interface LinksSection {
  readonly lines: LinkLine[];
  /** Creator and social links the description held and the section leaves out. */
  readonly omitted: number;
}

export const LINKS_HEADING = "## Links";
/** The section's heading: exactly `## Links`, the one spelling the renderer writes (a CRLF body's `\r` allowed, as on `## Transcript`). */
export const LINKS_HEADING_RE = /^## Links\s*$/;

/** Any level-2 ATX heading: up to three spaces, `##`, then a space, a tab or the line's end (CommonMark). */
const LEVEL2_HEADING_RE = /^ {0,3}##(?:[ \t\r]|$)/;

const ESCAPE_RE = /[\\[\]*_`]/g;

/**
 * Third-party text made safe for a link line: one line, escaped, separators
 * replaced. Idempotent, so render → parse → render is byte-stable: every `!`
 * before `[` goes, every Unicode space run collapses to one space BEFORE the
 * separators are looked for, and the separators are replaced until none is left
 * (one pass leaves ` — ` in `a — — b`).
 */
function escapeText(text: string): string {
  let out = text.replace(/!+(?=\[)/g, "").replace(/\s+/g, " ").trim();
  while (out.includes(" — ") || out.includes(" · ")) out = out.replace(/ — /g, " – ").replace(/ · /g, ", ");
  return out.replace(ESCAPE_RE, (c) => `\\${c}`);
}

function unescapeText(text: string): string {
  return text.replace(/\\([\\[\]*_`])/g, "$1");
}

/** `(` and `)` percent-encoded, so the link's closing paren is the only one. */
function encodeUrl(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

export function renderLinkLine(line: LinkLine): string {
  const detail = escapeText(line.detail);
  return (
    `- ${line.icon} [${escapeText(line.title)}](${encodeUrl(line.url)})` +
    (detail === "" ? "" : ` — ${detail}`) +
    ` · ${escapeText(line.provenance)}`
  );
}

export function omittedLine(n: number): string {
  return n === 1
    ? "_1 creator or social link in the description is not listed._"
    : `_${n} creator and social links in the description are not listed._`;
}

/**
 * The section text, or `null` when no line qualifies — no qualifying line, no
 * section, the count line included.
 */
export function renderLinksSection(section: LinksSection): string | null {
  if (section.lines.length === 0) return null;
  const body = section.lines.map(renderLinkLine).join("\n");
  return `${LINKS_HEADING}\n\n${body}${section.omitted > 0 ? `\n\n${omittedLine(section.omitted)}` : ""}`;
}

const LINE_RE = /^- (\S+) \[((?:\\.|[^\]\\])*)\]\(([^()\s]*)\)(.*)$/u;
const OMITTED_RE = /^_(\d+) creator (?:and|or) social links? in the description (?:are|is) not listed\._$/;

/** One rendered line read back, or `null` when it is not one. */
export function parseLinkLine(text: string): LinkLine | null {
  const m = LINE_RE.exec(text);
  if (!m) return null;
  let rest = m[4]!;
  const at = rest.lastIndexOf(" · ");
  if (at < 0) return null;
  const provenance = rest.slice(at + 3);
  rest = rest.slice(0, at);
  let detail = "";
  if (rest !== "") {
    if (!rest.startsWith(" — ")) return null;
    detail = rest.slice(3);
  }
  return {
    icon: m[1]!,
    title: unescapeText(m[2]!),
    url: m[3]!,
    detail: unescapeText(detail),
    provenance: unescapeText(provenance),
  };
}

/** The section's text (heading included) read back into lines and the omitted count. */
export function parseLinksSection(sectionText: string): LinksSection {
  const lines: LinkLine[] = [];
  let omitted = 0;
  for (const raw of sectionText.split("\n")) {
    const text = raw.trim();
    const line = parseLinkLine(text);
    if (line) lines.push(line);
    const m = OMITTED_RE.exec(text);
    if (m) omitted = Number(m[1]);
  }
  return { lines, omitted };
}

/** `[start, end)` of the section in a body, heading included. */
export interface LinksRange {
  readonly start: number;
  readonly end: number;
}

/**
 * THE locator: the last level-2 `## Links` heading above `## Transcript`,
 * outside fenced code, up to the next level-2 heading (or the transcript, or
 * the end). `null` when there is none.
 */
export function findLinksSection(body: string): LinksRange | null {
  const offsets: number[] = [];
  let offset = 0;
  const lines = body.split("\n");
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const headingAt: number[] = [];
  const level2: number[] = [];
  let transcriptAt = -1;
  mapProseLines(body, (line, i) => {
    if (transcriptAt >= 0) return line;
    if (TRANSCRIPT_HEADING_RE.test(line)) {
      transcriptAt = i;
      return line;
    }
    if (LEVEL2_HEADING_RE.test(line)) level2.push(i);
    if (LINKS_HEADING_RE.test(line)) headingAt.push(i);
    return line;
  });
  const start = headingAt.at(-1);
  if (start === undefined) return null;
  const nextHeading = level2.find((i) => i > start);
  const endLine = nextHeading ?? (transcriptAt >= 0 ? transcriptAt : -1);
  return { start: offsets[start]!, end: endLine >= 0 ? offsets[endLine]! : body.length };
}

/**
 * A body with its `## Links` section taken out, and the section's own bytes
 * (trimmed of surrounding blank lines) — `section: null` when there is none.
 * The re-run puts `section` back unchanged after the new summary.
 */
export function splitLinksSection(body: string): { body: string; section: string | null } {
  const range = findLinksSection(body);
  if (!range) return { body, section: null };
  const section = body.slice(range.start, range.end).trim();
  const before = body.slice(0, range.start).trimEnd();
  const after = body.slice(range.end);
  return { body: after.trim() === "" ? before : `${before}\n\n${after.trimStart()}`, section };
}

/**
 * `summary` with `section` appended as its last block, or `summary` as it is.
 * A summary that ends inside an open code fence (a model that never closed one)
 * gets the closer first, or the section would sit inside the fence and no
 * reader — the locator, the fact-check, the re-run split — would find it.
 */
export function appendLinksSection(summary: string, section: string | null): string {
  if (section === null || section === "") return summary;
  const open = unclosedFenceMarker(summary);
  const closed = open === null ? summary.trimEnd() : `${summary.trimEnd()}\n${open}`;
  return `${closed}\n\n${section}`;
}

// --- the LINKS: envelope line ------------------------------------------------

export type LinksPick = number[] | "none" | null;

/**
 * The envelope line: `LINKS:` (any case, optional bold) and a value that is
 * `none` or a list of ids — digits separated by commas or spaces, optionally in
 * brackets. Anything else (`**Links:** this talk…`, `Links: https://…`) is
 * prose and stays in the body.
 */
const LINKS_LINE_RE = /^\s*\**LINKS\**\s*:\s*\**\s*(none|\[?\s*\d+(?:[\s,]+\d+)*\s*\]?)\s*\**\.?\s*$/i;

function parsePick(value: string): LinksPick {
  if (/^none$/i.test(value)) return "none";
  return [...new Set([...value.matchAll(/\d+/g)].map((m) => Number(m[0])))];
}

/**
 * The `LINKS:` envelope line, stripped wherever the model put it among the
 * first five lines or as the last line, so it can never reach the stored body —
 * even when the model dropped the `SUMMARY:` marker. `pick` is `null` when
 * there was no line at all.
 */
export function parseLinksLine(raw: string): { text: string; pick: LinksPick } {
  const lines = raw.split("\n");
  let at = -1;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (LINKS_LINE_RE.test(lines[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) {
    let last = lines.length - 1;
    while (last >= 0 && lines[last]!.trim() === "") last--;
    if (last >= 0 && LINKS_LINE_RE.test(lines[last]!)) at = last;
  }
  if (at < 0) return { text: raw, pick: null };
  const pick = parsePick(LINKS_LINE_RE.exec(lines[at]!)![1]!);
  lines.splice(at, 1);
  return { text: lines.join("\n"), pick };
}

const MODEL_LINKS_HEADING_RE = /^( {0,3})##([ \t]+(?:\*\*|__)?[ \t]*links\b)/i;

/**
 * A level-2 heading the model wrote that starts with *Links*, demoted to level
 * 3, outside fenced code — so the body never holds a second `## Links`. An
 * indented (1–3 spaces) heading keeps its indent. Every capture vertical runs
 * this on the model's answer (`runCaptureOneShot`), not only YouTube.
 */
export function demoteLinksHeadings(text: string): string {
  return mapProseLines(text, (line) => line.replace(MODEL_LINKS_HEADING_RE, "$1###$2"));
}

/**
 * The shared pre-parse step every capture tail runs on the raw answer: strip the
 * `LINKS:` line and demote a model-written `## Links…` heading.
 */
export function prepareLinksAnswer(raw: string): { text: string; pick: LinksPick } {
  const { text, pick } = parseLinksLine(raw);
  return { text: demoteLinksHeadings(text), pick };
}

const BODY_URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g;

/**
 * The `http(s)` URLs a summary's prose carries outside its `## Links` section —
 * `bodyUrls`, and how many of those the description never listed
 * (`bodyUrlsUnlisted`).
 */
export function bodyUrlCounts(summary: string, listed: ReadonlySet<string>): { bodyUrls: number; bodyUrlsUnlisted: number } {
  const range = findLinksSection(summary);
  const prose = range ? summary.slice(0, range.start) + summary.slice(range.end) : summary;
  const urls = [...prose.matchAll(BODY_URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
  return { bodyUrls: urls.length, bodyUrlsUnlisted: urls.filter((u) => !listed.has(u)).length };
}
