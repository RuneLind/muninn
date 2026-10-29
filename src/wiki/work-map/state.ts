/**
 * The organize run's attempt record, one JSON file per wiki under
 * `~/.muninn/work-map/` — NOT in the committed map, so a failing hour makes no
 * commit. The loop's retry gate and the GET's last-attempt line read it.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const WORK_MAP_STATE_DIR = path.join(homedir(), ".muninn", "work-map");

/**
 * `refused`: inputs were not warm (or the instance cannot run), before any
 * model call — it costs nothing and retries hourly. `failed`: the run failed
 * AFTER the model call (timeout, invalid JSON, zod mismatch, a write that did
 * not land) — it retries once, then waits for the next day's hour.
 */
export type AttemptOutcome = "ok" | "refused" | "failed";

const attempt = z.object({
  at: z.number(),
  outcome: z.enum(["ok", "refused", "failed"]),
  error: z.string().optional(),
});

const stateSchema = z.object({
  wiki: z.string(),
  lastSuccessAt: z.number().optional(),
  attempts: z.array(attempt),
});

export type WorkMapAttempt = z.infer<typeof attempt>;
export type WorkMapState = z.infer<typeof stateSchema>;

/** Attempts kept per wiki: enough for the retry gate and a glance. */
const ATTEMPTS_KEPT = 10;

export interface WorkMapStateStore {
  read(wiki: string): Promise<WorkMapState | null>;
  record(wiki: string, attempt: WorkMapAttempt): Promise<WorkMapState>;
}

/** A file name for a wiki: its lowercased name, path characters replaced. */
function fileFor(dir: string, wiki: string): string {
  return path.join(dir, `${wiki.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}.json`);
}

/**
 * The state store over `dir` (tests pass their own). Writes go through a temp
 * file and a rename. The store also keeps each wiki's last recorded state in
 * memory, ahead of the write: while the file cannot be read or the last write
 * failed (an unwritable `~/.muninn`), `read` answers from that copy, so the
 * loop's gates and the POST's cooldown hold for the process lifetime.
 */
export function fileStateStore(dir: string = WORK_MAP_STATE_DIR): WorkMapStateStore {
  const chains = new Map<string, Promise<unknown>>();
  const memory = new Map<string, { state: WorkMapState; dirty: boolean }>();
  const readFileState = async (wiki: string): Promise<WorkMapState | null> => {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await readFile(fileFor(dir, wiki), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  const read = async (wiki: string): Promise<WorkMapState | null> => {
    const mem = memory.get(wiki.toLowerCase());
    if (mem?.dirty) return mem.state;
    return (await readFileState(wiki)) ?? mem?.state ?? null;
  };
  return {
    read,
    record(wiki, a) {
      const key = wiki.toLowerCase();
      const run = (chains.get(key) ?? Promise.resolve()).then(async () => {
        const prev = (await read(wiki)) ?? { wiki, attempts: [] };
        const next: WorkMapState = {
          wiki,
          ...(a.outcome === "ok" ? { lastSuccessAt: a.at } : prev.lastSuccessAt !== undefined ? { lastSuccessAt: prev.lastSuccessAt } : {}),
          attempts: [a, ...prev.attempts].slice(0, ATTEMPTS_KEPT),
        };
        memory.set(key, { state: next, dirty: true });
        await mkdir(dir, { recursive: true });
        const file = fileFor(dir, wiki);
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(next, null, 1));
        await rename(tmp, file);
        memory.set(key, { state: next, dirty: false });
        return next;
      });
      chains.set(key, run.catch(() => undefined));
      return run;
    },
  };
}
