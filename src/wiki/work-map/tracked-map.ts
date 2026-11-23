/**
 * The tracked-map warning (architecture review 2026-11-16, F40).
 *
 * `.work-map.json` is a whole-file model output, committed and pushed by the
 * organizer (`write.ts`). With two clones both organizing one wiki, the second
 * push is rejected, and every later repo-sync tick on that clone reports
 * `blocked`. The documented shape is one organizer per wiki, and reaching two
 * takes an operator's `WORK_MAP_WIKIS` change, so the loop says it once per wiki
 * at start: this instance organizes a map git tracks.
 *
 * The map records no writer instance (`workMapSchema` has `model` and `runAtMs`,
 * no host), so the one organizer that should be running sees the line too.
 *
 * Runs at loop start, outside any write section. A wiki outside git, a missing
 * root or a failing git call warns nothing and never throws.
 */

import { getLog } from "../../logging.ts";
import { runGit } from "../commit.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { WORK_MAP_FILE } from "./write.ts";

const log = getLog("wiki", "work-map");

/** True when git tracks `.work-map.json` at `root`; false outside git or on any failure. */
export async function workMapIsTracked(root: string): Promise<boolean> {
  return (await runGit(root, ["ls-files", "--error-unmatch", "--", WORK_MAP_FILE])).code === 0;
}

export type TrackedMapWarn = (message: string, props: { wiki: string }) => void;

const defaultWarn: TrackedMapWarn = (message, props) => log.warn(message, props);

export const TRACKED_MAP_WARNING =
  "Work map: {wiki}'s .work-map.json is tracked in git and this instance organizes it; a second instance organizing the same wiki makes repo sync's push fail and block every later sync tick";

/**
 * One warning per covered wiki whose map git tracks. Returns the wikis it warned for.
 * Never throws: a check that fails counts as untracked.
 */
export async function warnTrackedWorkMaps(
  wikis: readonly string[],
  registry: readonly Pick<WikiRegistryEntry, "name" | "root">[],
  isTracked: (root: string) => Promise<boolean>,
  warn: TrackedMapWarn = defaultWarn,
): Promise<string[]> {
  const byName = new Map(registry.map((e) => [e.name.toLowerCase(), e]));
  const warned: string[] = [];
  for (const wiki of wikis) {
    const entry = byName.get(wiki.toLowerCase());
    if (!entry) continue;
    let tracked = false;
    try {
      tracked = await isTracked(entry.root);
    } catch {
      tracked = false;
    }
    if (!tracked) continue;
    warn(TRACKED_MAP_WARNING, { wiki: entry.name });
    warned.push(entry.name);
  }
  return warned;
}
