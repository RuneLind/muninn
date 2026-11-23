/**
 * The second-organizer warning (architecture review 2026-11-16, F40).
 *
 * `.work-map.json` is a whole-file model output that the organizer commits and
 * pushes (`write.ts`). The documented shape is one organizer per wiki. With two
 * instances organizing one wiki, the second one's push is rejected, and every
 * later repo-sync tick on its clone reports `blocked`.
 *
 * A run stamps the map `runAtMs: runStart` and records the same `at` as this
 * machine's `lastSuccessAt` (`run.ts` `writeMap`, `state.ts`). So a map git
 * tracks whose `runAtMs` is not this machine's `lastSuccessAt`, or with no state
 * here at all, was written by another instance. The loop asks once per covered
 * wiki at start, outside any write section, every wiki on its own.
 *
 * A wiki outside git, a missing root, an unreadable map, a state read that
 * throws or a failing git call warns nothing and never rejects.
 */

import path from "node:path";
import { getLog } from "../../logging.ts";
import { runGit } from "../commit.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { readMapFile } from "./map-file.ts";
import type { WorkMapState } from "./state.ts";
import { WORK_MAP_FILE } from "./write.ts";

const log = getLog("wiki", "work-map");

/** A local `ls-files` answers in milliseconds; this only bounds a hung git. */
export const FOREIGN_MAP_GIT_TIMEOUT_MS = 10_000;

export const FOREIGN_MAP_WARNING =
  "Work map: {wiki}'s .work-map.json was written by another instance, and this instance is configured to organize {wiki} too. " +
  "This organizer's push will be rejected, and repo sync on this clone will then report blocked. " +
  "Organize a wiki from one instance only: remove it from WORK_MAP_WIKIS on the others.";

/** The decision: true only when git tracks the map and its stamp is not this machine's last success. */
export function mapWrittenElsewhere(tracked: boolean, mapRunAtMs: number | null, lastSuccessAt: number | null): boolean {
  if (!tracked || mapRunAtMs === null) return false;
  return lastSuccessAt !== mapRunAtMs;
}

/** True when git tracks `.work-map.json` at `root`; false outside git or on any failure. */
export async function workMapIsTracked(root: string): Promise<boolean> {
  const r = await runGit(root, ["ls-files", "--error-unmatch", "--", WORK_MAP_FILE], { timeoutMs: FOREIGN_MAP_GIT_TIMEOUT_MS });
  return r.code === 0;
}

export interface ForeignMapDeps {
  isTracked: (root: string) => Promise<boolean>;
  /** The map's text; null when absent or unreadable. */
  readText: (abs: string) => Promise<string | null>;
  /** This machine's state for the wiki; null when it has none. */
  readState: (wiki: string) => Promise<WorkMapState | null>;
}

/** One wiki's verdict. Never rejects: any failure reads as "not elsewhere". */
export async function mapIsForeign(entry: Pick<WikiRegistryEntry, "name" | "root">, deps: ForeignMapDeps): Promise<boolean> {
  try {
    if (!(await deps.isTracked(entry.root))) return false;
    const text = await deps.readText(path.join(entry.root, WORK_MAP_FILE));
    const stored = text === null ? null : readMapFile(text);
    if (!stored) return false;
    const state = await deps.readState(entry.name);
    return mapWrittenElsewhere(true, stored.map.runAtMs, state?.lastSuccessAt ?? null);
  } catch {
    return false;
  }
}

export type ForeignMapWarn = (message: string, props: { wiki: string }) => void;

const defaultWarn: ForeignMapWarn = (message, props) => log.warn(message, props);

/**
 * Check every covered wiki independently and warn once for each whose map came
 * from another instance. Resolves to the wikis it warned for; never rejects.
 */
export async function warnForeignWorkMaps(
  wikis: readonly string[],
  registry: readonly Pick<WikiRegistryEntry, "name" | "root">[],
  deps: ForeignMapDeps,
  warn: ForeignMapWarn = defaultWarn,
): Promise<string[]> {
  const byName = new Map(registry.map((e) => [e.name.toLowerCase(), e]));
  const entries = wikis.flatMap((w) => {
    const e = byName.get(w.toLowerCase());
    return e ? [e] : [];
  });
  const warned: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!(await mapIsForeign(entry, deps))) return;
      try {
        warn(FOREIGN_MAP_WARNING, { wiki: entry.name });
      } catch {
        /* a sink that throws must not reject the check */
      }
      warned.push(entry.name);
    }),
  );
  return warned;
}
