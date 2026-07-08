/**
 * "What's new" digest for a knowledge wiki — an AI summary of the most recent
 * `log.md` entries, rendered on the `/wiki` reader's start view.
 *
 * Every wiki keeps an append-only `log.md` at its root with entries shaped
 * `## [YYYY-MM-DD] kind | title` followed by free markdown. This module parses
 * that log, selects a bounded recent window (last ~14 days / ≤30 entries /
 * ≤15 KB), and asks one connector call to distil 4–6 concise bullets of what
 * changed. Page names the model mentions are resolved against the wiki index and
 * rewritten as `[[wikilinks]]` so the reader can open them in-place.
 *
 * The pieces are kept pure and side-effect-free (parsing, window selection,
 * page-mention marking) so a scheduler could later precompute digests off the
 * same seam. Only {@link generateWikiDigest} touches the filesystem + connector.
 */

import path from "node:path";
import { stat } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import { executeOneShot } from "../ai/one-shot.ts";
import { getLog } from "../logging.ts";
import type { WikiIndex, WikiPageMeta } from "./store.ts";

const log = getLog("wiki", "digest");

/** How many days back from the newest entry to include. */
export const DIGEST_WINDOW_DAYS = 14;
/** Hard cap on entries fed to the model (newest-first), independent of the day window. */
export const DIGEST_MAX_ENTRIES = 30;
/** Byte budget for the entries block handed to the model. */
export const DIGEST_MAX_BYTES = 15_000;

/** One parsed `## [date] kind | title` log entry with its body. */
export interface LogEntry {
  /** ISO date from the header, `YYYY-MM-DD`. */
  date: string;
  /** The `kind` token (e.g. `note`, `ingest`) — empty when the header omits it. */
  kind: string;
  title: string;
  /** Free-markdown body under the header, trimmed (may be empty). */
  body: string;
}

/** The digest returned to the route + persisted by a future scheduler. `bullets`
 *  is markdown (page mentions already marked as `[[wikilinks]]`); the route
 *  renders it to HTML at response time so the stored form stays plain markdown. */
export interface WikiDigest {
  bullets: string;
  /** Epoch ms the digest was generated. */
  generatedAt: number;
  /** `log.md` mtime (epoch ms) the digest was built from — the cache key. */
  logMtimeMs: number;
  /** Number of log entries summarized. */
  entryCount: number;
  /** Earliest / latest entry date in the summarized window (`YYYY-MM-DD`). */
  fromDate: string;
  toDate: string;
}

const ENTRY_HEADER_RE = /^##\s+\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/;

/**
 * Split raw `log.md` text into entries. Everything before the first
 * `## [date]` header (the file's intro) is ignored. A header's remainder is
 * `kind | title`; when the `|` is absent the whole remainder is the title and
 * kind is empty. Entries are returned in file order (oldest-first, as logs append).
 */
export function parseLogEntries(logText: string): LogEntry[] {
  const lines = logText.split("\n");
  const entries: LogEntry[] = [];
  let current: { date: string; kind: string; title: string; body: string[] } | null = null;

  const flush = () => {
    if (current) {
      entries.push({
        date: current.date,
        kind: current.kind,
        title: current.title,
        body: current.body.join("\n").trim(),
      });
    }
  };

  for (const line of lines) {
    const m = line.match(ENTRY_HEADER_RE);
    if (m) {
      flush();
      const remainder = m[2]!.trim();
      const pipe = remainder.indexOf("|");
      const kind = pipe === -1 ? "" : remainder.slice(0, pipe).trim();
      const title = (pipe === -1 ? remainder : remainder.slice(pipe + 1)).trim();
      current = { date: m[1]!, kind, title, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * Select the recent window to summarize, applying three bounds in order:
 *  1. **days** — entries dated within {@link DIGEST_WINDOW_DAYS} of the newest
 *     entry (anchored to the log's own newest date, not wall-clock now, so a
 *     quiet wiki still yields its last active fortnight deterministically).
 *  2. **count** — at most {@link DIGEST_MAX_ENTRIES}, newest kept.
 *  3. **bytes** — trimmed oldest-first until the rendered block is ≤
 *     {@link DIGEST_MAX_BYTES}.
 * Returns entries oldest→newest (reading order for the prompt).
 */
export function selectRecentEntries(
  entries: LogEntry[],
  opts: { windowDays?: number; maxEntries?: number; maxBytes?: number } = {},
): LogEntry[] {
  if (entries.length === 0) return [];
  const windowDays = opts.windowDays ?? DIGEST_WINDOW_DAYS;
  const maxEntries = opts.maxEntries ?? DIGEST_MAX_ENTRIES;
  const maxBytes = opts.maxBytes ?? DIGEST_MAX_BYTES;

  // Anchor the window to the newest entry date present (logs append oldest-first,
  // but a stray out-of-order date shouldn't shrink the window, so scan for max).
  const newest = entries.reduce((acc, e) => (e.date > acc ? e.date : acc), entries[0]!.date);
  const cutoff = shiftDate(newest, -windowDays);

  let selected = entries.filter((e) => e.date >= cutoff);
  // Count cap: keep the newest N (tail of the oldest-first list).
  if (selected.length > maxEntries) selected = selected.slice(selected.length - maxEntries);

  // Byte cap: drop oldest until the rendered block fits.
  while (selected.length > 1 && Buffer.byteLength(renderEntriesBlock(selected), "utf8") > maxBytes) {
    selected = selected.slice(1);
  }
  return selected;
}

/** Shift a `YYYY-MM-DD` date by `days` (UTC), returning `YYYY-MM-DD`. */
function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Render selected entries as the plain-text block fed to the model. */
export function renderEntriesBlock(entries: LogEntry[]): string {
  return entries
    .map((e) => {
      const head = `## [${e.date}]${e.kind ? " " + e.kind : ""}${e.title ? " | " + e.title : ""}`;
      return e.body ? `${head}\n${e.body}` : head;
    })
    .join("\n\n");
}

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
const BACKTICK_RE = /`([^`\n]+)`/g;
const QUOTED_RE = /[“"]([^“”"\n]+)[”"]/g;

/**
 * Mark page mentions in the model's bullets so the reader renders in-place links.
 * Resolvable mentions are normalized to canonical `[[Page Name]]` wikilinks (the
 * reader's markdown renderer turns those into `data-wiki-page` anchors). Three
 * mention shapes are honored, in precedence order so an already-linked mention is
 * never double-processed: existing `[[wikilinks]]`, then `` `backticked` ``, then
 * "quoted" names. Unresolvable mentions are left exactly as written.
 */
export function markPageMentions(
  bullets: string,
  resolve: (target: string) => WikiPageMeta | undefined,
): string {
  let out = bullets.replace(WIKILINK_RE, (m, target: string) => {
    const meta = resolve(target.trim());
    return meta ? `[[${meta.name}]]` : m;
  });
  out = out.replace(BACKTICK_RE, (m, inner: string) => {
    const meta = resolve(inner.trim());
    return meta ? `[[${meta.name}]]` : m;
  });
  out = out.replace(QUOTED_RE, (m, inner: string) => {
    const meta = resolve(inner.trim());
    return meta ? `[[${meta.name}]]` : m;
  });
  return out;
}

export const DIGEST_SYSTEM_PROMPT = `You write a short "what's new" digest for a personal knowledge wiki, summarizing the most recent log entries so the reader can catch up at a glance.

Rules:
- Output ONLY a markdown bullet list: 4 to 6 bullets, one line each, most important first.
- Summarize what actually changed or was added — concrete topics, pages, decisions — not meta commentary about the log itself.
- When you name a specific wiki page, wrap it in [[double brackets]] so it becomes a link (e.g. [[knowledge-graph]]). Only do this for names that look like real page titles from the entries.
- Be terse and specific. No preamble, no heading, no closing remark — just the bullets.`;

/** Read `log.md`'s mtime (epoch ms) for a wiki root, or null when it's absent. */
export async function readLogMtimeMs(root: string): Promise<number | null> {
  try {
    const st = await stat(path.join(root, "log.md"));
    return st.mtimeMs;
  } catch {
    return null;
  }
}

export interface GenerateDigestOptions {
  /** Injectable one-shot seam (tests pass a fake to avoid a real connector run). */
  oneShot?: typeof executeOneShot;
  /** Clock override for `generatedAt` (tests). */
  now?: () => number;
}

/**
 * Build a "what's new" digest for a wiki root, or null when there's no `log.md`
 * or it has no entries. Reads the log, selects the recent window, runs one
 * connector call to distil bullets, then marks resolvable page mentions as
 * wikilinks. Never throws for an empty/absent log; a connector failure propagates
 * to the caller (the route degrades to `{ digest: null }`).
 */
export async function generateWikiDigest(
  root: string,
  index: WikiIndex,
  config: Config,
  botConfig: BotConfig,
  opts: GenerateDigestOptions = {},
): Promise<WikiDigest | null> {
  const oneShot = opts.oneShot ?? executeOneShot;
  const now = opts.now ?? Date.now;

  const logMtimeMs = await readLogMtimeMs(root);
  if (logMtimeMs === null) return null;

  let logText: string;
  try {
    logText = await Bun.file(path.join(root, "log.md")).text();
  } catch {
    return null;
  }

  const entries = selectRecentEntries(parseLogEntries(logText));
  if (entries.length === 0) return null;

  const fromDate = entries[0]!.date;
  const toDate = entries[entries.length - 1]!.date;
  const block = renderEntriesBlock(entries);

  const userPrompt = `Wiki: ${root.split("/").pop() ?? "wiki"}
Recent log entries (${fromDate} – ${toDate}), oldest first:

${block}

Write the "what's new" digest as 4–6 markdown bullets.`;

  const result = await oneShot(userPrompt, config, botConfig, {
    systemPrompt: DIGEST_SYSTEM_PROMPT,
  });
  const raw = (result.result ?? "").trim();
  if (!raw) return null;

  const bullets = markPageMentions(raw, index.resolve);
  log.info("Wiki digest generated: {entries} entries {from}..{to} from {root}", {
    entries: entries.length,
    from: fromDate,
    to: toDate,
    root,
  });

  return {
    bullets,
    generatedAt: now(),
    logMtimeMs,
    entryCount: entries.length,
    fromDate,
    toDate,
  };
}
