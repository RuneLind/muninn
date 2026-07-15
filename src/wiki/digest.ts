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
import type { ClaudeExecResult } from "../ai/executor.ts";
import { executeOneShot } from "../ai/one-shot.ts";
import { Tracer } from "../tracing/tracer.ts";
import { agentStatus, setConnectorInfo } from "../observability/agent-status.ts";
import { getLog } from "../logging.ts";
import type { WikiIndex, WikiPageMeta } from "./store.ts";

const log = getLog("wiki", "digest");

/** How many days back from the newest entry to include. */
export const DIGEST_WINDOW_DAYS = 14;
/** Hard cap on entries fed to the model (newest-first), independent of the day window. */
export const DIGEST_MAX_ENTRIES = 30;
/** Byte budget for the entries block handed to the model. */
export const DIGEST_MAX_BYTES = 15_000;
/** Timeout for the single digest connector call. Kept well under the global
 *  `CLAUDE_TIMEOUT_MS` (120s) so a cold connector can't hold the GET open — the
 *  route degrades to `{ digest: null, error }` on timeout. */
export const DIGEST_TIMEOUT_MS = 45_000;

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
 * kind is empty. Entries are returned in file order — which differs by wiki
 * (mimir appends oldest-first, bot wikis prepend newest-first), so downstream
 * {@link selectRecentEntries} sorts by date rather than trusting file order.
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

/** True when `s` is a real calendar date `YYYY-MM-DD` — round-trips through
 *  `Date`, so a syntactically-plausible-but-impossible header like `2026-13-45`
 *  (which the entry regex still matches, and which would make `shiftDate` throw)
 *  is rejected rather than allowed to anchor or crash the window selection. */
export function isValidCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Select the recent window to summarize. **Order-independent**: bot knowledge
 * wikis prepend to `log.md` (newest-first) while mimir appends (oldest-first),
 * so the entries are first validated + sorted ascending before any cap applies.
 *
 *  0. **validate** — entries whose date isn't a real calendar date are dropped
 *     (a `2026-13-45` typo must neither anchor the window nor crash `shiftDate`).
 *  1. **anchor** — the window is anchored to the newest *non-future* valid date
 *     (so a typo'd `2099-…` entry can't collapse it); if every date is future,
 *     fall back to the max present. Entries after the anchor are excluded, so a
 *     future outlier never leaks into `fromDate`/`toDate`.
 *  2. **days** — entries within {@link DIGEST_WINDOW_DAYS} of the anchor.
 *  3. **count** — at most {@link DIGEST_MAX_ENTRIES}; the oldest are dropped.
 *  4. **bytes** — oldest dropped until the block is ≤ {@link DIGEST_MAX_BYTES};
 *     a lone entry still over budget is truncated (noted inline) rather than
 *     shipped whole.
 * Returns entries oldest→newest (reading order for the prompt).
 */
export function selectRecentEntries(
  entries: LogEntry[],
  opts: { windowDays?: number; maxEntries?: number; maxBytes?: number; now?: () => number } = {},
): LogEntry[] {
  const windowDays = opts.windowDays ?? DIGEST_WINDOW_DAYS;
  const maxEntries = opts.maxEntries ?? DIGEST_MAX_ENTRIES;
  const maxBytes = opts.maxBytes ?? DIGEST_MAX_BYTES;
  const now = opts.now ?? Date.now;

  const valid = entries
    .filter((e) => isValidCalendarDate(e.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (valid.length === 0) return [];

  const today = new Date(now()).toISOString().slice(0, 10);
  const nonFuture = valid.filter((e) => e.date <= today);
  const anchorSet = nonFuture.length ? nonFuture : valid;
  const anchor = anchorSet[anchorSet.length - 1]!.date;
  const cutoff = shiftDate(anchor, -windowDays);

  // Window is [cutoff, anchor] — the upper bound excludes future outliers.
  let selected = valid.filter((e) => e.date >= cutoff && e.date <= anchor);
  // Count cap: keep the newest N (drop the oldest — the head of the sorted list).
  if (selected.length > maxEntries) selected = selected.slice(selected.length - maxEntries);

  // Byte cap: drop oldest until the rendered block fits.
  while (selected.length > 1 && Buffer.byteLength(renderEntriesBlock(selected), "utf8") > maxBytes) {
    selected = selected.slice(1);
  }
  // A single remaining entry that still blows the budget is truncated in place
  // (with an inline note) so an oversized entry never ships whole to the model.
  if (
    selected.length === 1 &&
    Buffer.byteLength(renderEntriesBlock(selected), "utf8") > maxBytes
  ) {
    selected = [truncateEntryToBudget(selected[0]!, maxBytes)];
  }
  return selected;
}

const TRUNCATION_NOTE = "\n\n…[entry truncated to fit the digest budget]";

/** Truncate a single entry's body so its rendered block fits `maxBytes`, leaving
 *  an inline note so the model knows the text was cut. */
function truncateEntryToBudget(entry: LogEntry, maxBytes: number): LogEntry {
  const headBytes = Buffer.byteLength(renderEntriesBlock([{ ...entry, body: "" }]), "utf8");
  // Room for the body = budget − header − the "\n" join − the note.
  const room = maxBytes - headBytes - 1 - Buffer.byteLength(TRUNCATION_NOTE, "utf8");
  if (room <= 0 || !entry.body) return { ...entry, body: TRUNCATION_NOTE.trimStart() };
  let body = entry.body.slice(0, room);
  while (body.length > 0 && Buffer.byteLength(body, "utf8") > room) {
    body = body.slice(0, Math.floor(body.length * 0.95));
  }
  return { ...entry, body: body + TRUNCATION_NOTE };
}

/** Shift a `YYYY-MM-DD` date by `days` (UTC), returning `YYYY-MM-DD`. */
function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The newest `## [YYYY-MM-DD]` header date in a wiki's `log.md`, or null when
 * there's no readable log / no parseable header. Used for the picker's freshness
 * label — it matches the dates the digest shows and, unlike the file's mtime,
 * can't drift a day near midnight. Bounded read: the whole file when small, else
 * the first + last 8 KB (covers both orderings — newest-first logs carry the max
 * at the top, oldest-first logs at the bottom).
 */
export async function newestLogEntryDate(root: string): Promise<string | null> {
  const file = Bun.file(path.join(root, "log.md"));
  let text: string;
  try {
    const size = file.size;
    if (size <= 16_384) {
      text = await file.text();
    } else {
      const head = await file.slice(0, 8_192).text();
      const tail = await file.slice(size - 8_192).text();
      text = head + "\n" + tail;
    }
  } catch {
    return null;
  }
  let max: string | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(ENTRY_HEADER_RE);
    if (!m) continue;
    const d = m[1]!;
    if (!isValidCalendarDate(d)) continue;
    if (max === null || d > max) max = d;
  }
  return max;
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
  // Never rewrite tokens inside a fenced ``` code block — a code sample must
  // ship verbatim. Split on fences (capturing group ⇒ odd indices are the fenced
  // blocks, kept as-is); only rewrite the outside segments. Inline single-
  // backtick spans stay eligible — they're the intended mention marker.
  return bullets
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : markMentionsInSegment(seg, resolve)))
    .join("");
}

/** Rewrite the three mention shapes in a fence-free segment (see {@link markPageMentions}). */
function markMentionsInSegment(
  segment: string,
  resolve: (target: string) => WikiPageMeta | undefined,
): string {
  let out = segment.replace(WIKILINK_RE, (m, target: string) => {
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
  /** Injectable tracer (tests pass a recording one to avoid DB span writes). */
  tracer?: Tracer;
  /** Clock override for `generatedAt` + the future-date guard in selection (tests). */
  now?: () => number;
  /** Connector timeout for the single digest call. Defaults to {@link DIGEST_TIMEOUT_MS}. */
  timeoutMs?: number;
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
  const timeoutMs = opts.timeoutMs ?? DIGEST_TIMEOUT_MS;

  const logMtimeMs = await readLogMtimeMs(root);
  if (logMtimeMs === null) return null;

  let logText: string;
  try {
    logText = await Bun.file(path.join(root, "log.md")).text();
  } catch {
    return null;
  }

  const entries = selectRecentEntries(parseLogEntries(logText), { now });
  if (entries.length === 0) return null;

  const fromDate = entries[0]!.date;
  const toDate = entries[entries.length - 1]!.date;
  const block = renderEntriesBlock(entries);

  const wikiName = root.split("/").pop() ?? "wiki";
  const userPrompt = `Wiki: ${wikiName}
Recent log entries (${fromDate} – ${toDate}), oldest first:

${block}

Write the "what's new" digest as 4–6 markdown bullets.`;

  // Observability. The digest fires on every /wiki open (cache miss) and used to
  // leave NOTHING behind — no trace, no /agents row — so a slow or failing digest
  // was invisible on both dashboards. Everything above this point is cheap local
  // I/O with early returns; the model call is the only part worth accounting for,
  // so the run + trace start here.
  const tracer = opts.tracer ?? new Tracer("wiki_digest", {
    botName: botConfig.name,
    platform: "wiki",
  });
  const reqId = agentStatus.startRequest(botConfig.name, "synthesizing", undefined, {
    kind: "digest",
    name: `Wiki digest: ${wikiName}`,
  });
  agentStatus.setSourcePage(reqId, "/wiki");
  setConnectorInfo(reqId, botConfig, config.claudeModel);
  tracer.start("claude", { wiki: wikiName, entries: entries.length, fromDate, toDate });

  let result: ClaudeExecResult;
  try {
    result = await oneShot(userPrompt, config, botConfig, {
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      timeoutMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracer.end("claude", { error: message });
    tracer.finish("error", { wiki: wikiName, error: message });
    agentStatus.completeRequest(reqId, {});
    throw err; // the route already degrades this to `{ digest: null }`
  }

  const usage = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    numTurns: result.numTurns,
    costUsd: result.costUsd,
  };
  tracer.end("claude", { ...usage, model: result.model });
  if (result.model) agentStatus.setModel(reqId, result.model);
  tracer.finish("ok", { wiki: wikiName, entries: entries.length, ...usage });
  agentStatus.completeRequest(reqId, {
    ...usage,
    ...(config.tracingEnabled ? { traceId: tracer.traceId } : {}),
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
