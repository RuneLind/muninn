/**
 * WebVTT → timestamped transcript. Pure, no I/O.
 *
 * ⚠️ THE INDEX-VS-TEXT RULE, and it is the whole reason this parser exists
 * instead of a five-line `split(/\n\n+/)`: a cue's optional identifier is the
 * line BEFORE the timing line. It is decided by POSITION, never by shape. The
 * obvious shortcut — drop any line matching `/^\d+$/` — is wrong on real
 * captions: the committed fixture's cue at 2204.238 s (36:44) has the TEXT `21`
 * (a speaker reading a number aloud), and a shape-based parser silently returns
 * 927 cues instead of 928 while every other assertion still passes. A dropped
 * line is a hole in a transcript a summarizer will never flag.
 *
 * Vimeo's auto-captions are 0.3–4 s cues (~900–1500 for a conference talk), so
 * feeding raw cues to a model spends most of the budget on timestamps.
 * {@link vttToSegments} collapses them into fixed windows at absolute boundaries
 * (0, 120, 240 …) — absolute, not relative to the first cue, so two captures of
 * the same talk window identically and a citation timestamp means one thing.
 */

/** One WebVTT cue. */
export interface VttCue {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

/** One fixed-width window of transcript text. */
export interface TranscriptSegment {
  readonly startSec: number;
  readonly text: string;
}

/** Default window width. 120 s ≈ 27 windows for a 53-minute talk. */
export const DEFAULT_WINDOW_SEC = 120;

/**
 * `HH:MM:SS.mmm` or `MM:SS.mmm` (both legal WebVTT). Returns null for anything
 * else, which is what makes a `-->` inside cue TEXT harmless.
 */
function parseTimestamp(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d[.,]\d{1,3})$/);
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]!.replace(",", "."));
  return hours * 3600 + minutes * 60 + seconds;
}

/** `<start> --> <end>[ settings]`, or null when the line is not a timing line. */
function parseTimingLine(line: string): { startSec: number; endSec: number } | null {
  const idx = line.indexOf("-->");
  if (idx < 0) return null;
  const startSec = parseTimestamp(line.slice(0, idx));
  if (startSec === null) return null;
  // Cue settings (`align:start position:50%`) follow the end timestamp on the
  // same line, separated by whitespace.
  const after = line.slice(idx + 3).trim();
  const endSec = parseTimestamp(after.split(/\s+/)[0] ?? "");
  if (endSec === null) return null;
  return { startSec, endSec };
}

/** Blocks that are not cues, identified by their first line. */
function isNonCueBlock(firstLine: string): boolean {
  return /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(firstLine) || firstLine === "NOTE";
}

/**
 * Parse every cue out of a WebVTT document, in file order.
 *
 * Handles CRLF, a BOM, the `WEBVTT` header (with or without trailing metadata),
 * `NOTE`/`STYLE`/`REGION` blocks, an optional cue identifier, cue settings after
 * the end timestamp, and multi-line cue text (joined with a single space —
 * caption line breaks are layout, not content, and everything downstream
 * concatenates cues anyway).
 */
export function parseVttCues(vtt: string): VttCue[] {
  const normalized = vtt.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n[ \t]*\n+/);
  const cues: VttCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (isNonCueBlock(lines[0]!.trim())) continue;

    // POSITION, not shape: the timing line splits the block. Everything before
    // it is the identifier; everything after it is cue text — including a line
    // that happens to be a bare number.
    const timingIdx = lines.findIndex((l) => parseTimingLine(l) !== null);
    if (timingIdx < 0) continue;
    const timing = parseTimingLine(lines[timingIdx]!)!;
    const text = lines
      .slice(timingIdx + 1)
      .map((l) => l.trim())
      .join(" ")
      .trim();
    if (!text) continue;
    cues.push({ startSec: timing.startSec, endSec: timing.endSec, text });
  }
  return cues;
}

/**
 * Collapse cues into fixed windows at absolute `windowSec` boundaries. Windows
 * with no cues are not emitted (a silent stretch is an absent header, not an
 * empty one).
 */
export function vttToSegments(vtt: string, windowSec: number = DEFAULT_WINDOW_SEC): TranscriptSegment[] {
  if (!(windowSec > 0)) throw new Error(`vttToSegments: windowSec must be > 0, got ${windowSec}`);
  const out: { startSec: number; parts: string[] }[] = [];
  for (const cue of parseVttCues(vtt)) {
    const bucket = Math.floor(cue.startSec / windowSec) * windowSec;
    const last = out[out.length - 1];
    if (last && last.startSec === bucket) last.parts.push(cue.text);
    else out.push({ startSec: bucket, parts: [cue.text] });
  }
  return out.map((w) => ({ startSec: w.startSec, text: w.parts.join(" ") }));
}

/** `3661` → `01:01:01`. */
export function formatTimestamp(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** `[HH:MM:SS]`-headed paragraphs, one per window, blank-line separated. */
export function segmentsToMarkdown(segments: readonly TranscriptSegment[]): string {
  return segments.map((s) => `[${formatTimestamp(s.startSec)}]\n${s.text}`).join("\n\n");
}

/**
 * Vimeo marks machine-generated tracks with an `-x-autogen` language suffix
 * (`no-x-autogen`). Auto-captions garble proper nouns ("JavaBeen" for JavaBin,
 * measured), so the summarizer prompt has to know which it is reading.
 */
export function detectCaptionKind(lang: string): "auto" | "manual" {
  return /-x-autogen$/i.test(lang.trim()) ? "auto" : "manual";
}
