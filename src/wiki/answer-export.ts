/**
 * The answer cards' export block (answer cards PR 4): the markdown the reader's
 * "Copy new answers" puts on the clipboard, for an agent to paste into the page.
 *
 * ```markdown
 * <!-- answers · mimir · plans/x.mdx · exported 2026-10-08 09:14 -->
 * ### O3 — Rune Lind (asked), 07.10.2026 21:32, chose B, version 2
 * > The page's language.
 *
 * <!-- orphaned answers in mimir: 0 -->
 * ```
 *
 * The body is quoted word for word: every line gets `> ` (an empty line `>`),
 * nothing is re-rendered. Times are Europe/Oslo, whatever the server's own
 * zone, since a pod's TZ is UTC. The labels are English on every wiki: the
 * block is read by an agent, not shown on the page.
 */
import { QUESTION_NOT_SURE } from "../format/question.ts";

export const ANSWER_EXPORT_TIME_ZONE = "Europe/Oslo";

/** How a "not sure" choice reads in the block. */
const NOT_SURE_TEXT = "not sure yet";

export interface ExportAnswer {
  questionId: string;
  authorName: string;
  /** Null when the question names nobody or is gone from the page. */
  asked: boolean | null;
  /** Epoch ms of the exported version. */
  createdAt: number;
  choice: string | null;
  body: string;
  version: number;
  redacted: boolean;
}

const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: ANSWER_EXPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function clock(ms: number): { y: string; mo: string; d: string; h: string; mi: string } {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute! };
}

/** `2026-10-08 09:14` in Oslo time — the header's form. */
export function exportStamp(ms: number): string {
  const c = clock(ms);
  return `${c.y}-${c.mo}-${c.d} ${c.h}:${c.mi}`;
}

/** `08.10.2026 09:14` in Oslo time — an answer's form. */
export function answerStamp(ms: number): string {
  const c = clock(ms);
  return `${c.d}.${c.mo}.${c.y} ${c.h}:${c.mi}`;
}

/** One line: a name or choice must not break the heading. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** A `-->` would end the header comment early. */
const commentSafe = (s: string) => oneLine(s).replaceAll("-->", "-- >");

export function exportHeading(a: ExportAnswer): string {
  const asked = a.asked === null ? "" : a.asked ? " (asked)" : " (not asked)";
  const choice = a.redacted
    ? ", redacted"
    : a.choice !== null
      ? `, chose ${a.choice === QUESTION_NOT_SURE ? NOT_SURE_TEXT : oneLine(a.choice)}`
      : "";
  return `### ${a.questionId} — ${oneLine(a.authorName)}${asked}, ${answerStamp(a.createdAt)}${choice}, version ${a.version}`;
}

/** The body as a blockquote, every line prefixed; nothing for an empty or
 *  redacted body. CRLF and lone CR count as line breaks, so no `\r` is left
 *  inside a quoted line. */
export function quoteBody(body: string): string[] {
  if (body === "") return [];
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`));
}

const HEADER_STAMP = / · exported \d{4}-\d{2}-\d{2} \d{2}:\d{2} -->$/;

/**
 * The block with its header's time set to `ms`. The reader prefetches the
 * block minutes before the click, so the click stamps the copy with its own
 * time — the minute `again=1` later prints for the same batch, since the
 * confirm that follows the copy sets `exported_at`. A block without the header
 * comes back unchanged.
 */
export function restampAnswerExport(block: string, ms: number): string {
  const nl = block.indexOf("\n");
  const header = nl === -1 ? block : block.slice(0, nl);
  if (!header.startsWith("<!-- answers · ") || !HEADER_STAMP.test(header)) return block;
  return header.replace(HEADER_STAMP, ` · exported ${exportStamp(ms)} -->`) + (nl === -1 ? "" : block.slice(nl));
}

/** The whole block, or `""` when there is nothing to export. */
export function formatAnswerExport(opts: {
  wiki: string;
  relPath: string;
  exportedAt: number;
  answers: readonly ExportAnswer[];
  orphanCount: number;
}): string {
  if (opts.answers.length === 0) return "";
  const out = [`<!-- answers · ${commentSafe(opts.wiki)} · ${commentSafe(opts.relPath)} · exported ${exportStamp(opts.exportedAt)} -->`];
  opts.answers.forEach((a, i) => {
    if (i > 0) out.push("");
    out.push(exportHeading(a), ...(a.redacted ? [] : quoteBody(a.body)));
  });
  out.push("", `<!-- orphaned answers in ${commentSafe(opts.wiki)}: ${opts.orphanCount} -->`);
  return out.join("\n") + "\n";
}
