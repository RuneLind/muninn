/**
 * The find palette's query log: `~/.muninn/wiki-find/queries.jsonl`. A palette
 * session appends one line per row it opened, with the text it was ranked for,
 * or one line with `opened: null` when it was dismissed. It collects the real misses the search plan
 * asks for (mimir plan muninn-smart-wiki-search, O1). Local file only: the
 * route is in the `wiki` group, so a nais pod has none.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** `WIKI_FIND_LOG_DIR` moves it (`e2eEnv()` points it at a temp dir); read once at load. */
export const WIKI_FIND_LOG_DIR = process.env.WIKI_FIND_LOG_DIR?.trim() || path.join(homedir(), ".muninn", "wiki-find");
export const findLogPath = (dir = WIKI_FIND_LOG_DIR) => path.join(dir, "queries.jsonl");

export const FIND_LOG_Q_MAX = 200;
const NAME_MAX = 512;

export interface FindLogLine {
  at: string;
  /** The wiki the palette was open on. */
  wiki: string;
  q: string;
  opened: { wiki: string; relPath: string; rank: number; section: "local" | "everywhere" } | null;
  rows: { local: number; everywhere: number };
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" && v.length <= max ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : null);

/** The line a POST body becomes, or `null` when it is not one. */
export function findLogLine(body: unknown, nowMs: number): FindLogLine | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const q = text(b.q, FIND_LOG_Q_MAX);
  const wiki = text(b.wiki, NAME_MAX);
  const rows = (b.rows ?? {}) as Record<string, unknown>;
  const local = count(rows.local);
  const everywhere = count(rows.everywhere);
  if (q === null || wiki === null || local === null || everywhere === null) return null;
  let opened: FindLogLine["opened"] = null;
  if (b.opened !== null && b.opened !== undefined) {
    const o = b.opened as Record<string, unknown>;
    const oWiki = text(o.wiki, NAME_MAX);
    const relPath = text(o.relPath, NAME_MAX);
    const rank = count(o.rank);
    if (oWiki === null || relPath === null || rank === null) return null;
    if (o.section !== "local" && o.section !== "everywhere") return null;
    opened = { wiki: oWiki, relPath, rank, section: o.section };
  }
  return { at: new Date(nowMs).toISOString(), wiki, q, opened, rows: { local, everywhere } };
}

export async function appendFindLog(line: FindLogLine, file = findLogPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(line)}\n`);
}
