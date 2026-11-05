/**
 * The append-only log (D9): `~/.muninn/decision-triage/<wiki>.jsonl`, outside
 * the wiki, because the judge needs verdicts recorded before an answer. Each
 * append is one write. A process killed mid-append leaves a line with no end,
 * so the next append starts on a fresh line and the reader skips what does not
 * parse.
 */

import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileStateStore, type WorkMapStateStore } from "../work-map/state.ts";
import type { CardLine, LogLine, RunLine } from "./schema.ts";

export const DECISION_TRIAGE_DIR = path.join(homedir(), ".muninn", "decision-triage");

const safeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9._-]/g, "_");

export const nightlyLogPath = (wiki: string, dir = DECISION_TRIAGE_DIR) => path.join(dir, `${safeName(wiki)}.jsonl`);
export const replayLogPath = (promptVersion: string, dir = DECISION_TRIAGE_DIR) => path.join(dir, `replay-${safeName(promptVersion)}.jsonl`);

/** The night's own state and failure count, apart from the work map's. */
export const triageStateStore = (dir = DECISION_TRIAGE_DIR): WorkMapStateStore => fileStateStore(path.join(dir, "state"));

async function endsMidLine(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return false;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
    return buffer[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

export async function appendLogLines(file: string, lines: readonly LogLine[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await appendFile(file, (await endsMidLine(file)) ? `\n${text}` : text);
}

export interface ParsedLog {
  runs: RunLine[];
  cards: CardLine[];
  /** Lines that did not parse: a run killed mid-append. */
  broken: number;
}

export function parseLog(text: string): ParsedLog {
  const out: ParsedLog = { runs: [], cards: [], broken: 0 };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as LogLine;
      if (row?.type === "run") out.runs.push(row);
      else if (row?.type === "card") out.cards.push(row);
      else out.broken++;
    } catch {
      out.broken++;
    }
  }
  return out;
}

/** A log that does not exist yet reads as empty. */
export async function readLog(file: string): Promise<ParsedLog> {
  try {
    return parseLog(await readFile(file, "utf8"));
  } catch {
    return { runs: [], cards: [], broken: 0 };
  }
}
