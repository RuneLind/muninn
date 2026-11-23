/**
 * The listing's `workMap: {runAt, kind?}` field (`kind: "themes"` only on a
 * themes map, so a work map's field is unchanged): read per `/api/wiki/pages` request
 * from `.work-map.json`, cached on the file's stat, so a run that just
 * finished shows on the next listing and an unchanged file costs one `stat`.
 * The client uses it to pick the Your work card over What's new without a
 * second serial fetch.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readMapFile } from "./map-file.ts";
import { WORK_MAP_FILE } from "./write.ts";

interface StatKey {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}
type Entry = { runAt: number | null; themes: boolean };
const cache = new Map<string, StatKey & Entry>();

/** The map's `runAtMs` and whether it is a themes map; null runAt when the
 *  root has no readable work map. */
async function readEntry(root: string): Promise<Entry> {
  const file = path.join(root, WORK_MAP_FILE);
  let st;
  try {
    st = await stat(file);
  } catch {
    cache.delete(file);
    return { runAt: null, themes: false };
  }
  const hit = cache.get(file);
  // ino + ctime catch a same-size rewrite that preserved the mtime (cp -p, rsync -t).
  if (hit && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs && hit.size === st.size && hit.ino === st.ino) return hit;
  let entry: Entry = { runAt: null, themes: false };
  try {
    const stored = readMapFile(await readFile(file, "utf8"));
    if (stored) entry = { runAt: stored.map.runAtMs, themes: stored.kind === "themes" };
  } catch {
    entry = { runAt: null, themes: false };
  }
  cache.set(file, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino, ...entry });
  return entry;
}

/** The map's `runAtMs`, or null when the root has no readable work map. */
export async function workMapRunAt(root: string): Promise<number | null> {
  return (await readEntry(root)).runAt;
}

/** The listing field: present only when the wiki has a map. */
export async function workMapListingField(root: string | undefined): Promise<{ workMap?: { runAt: number; kind?: "themes" } }> {
  if (!root) return {};
  const { runAt, themes } = await readEntry(root);
  return runAt === null ? {} : { workMap: { runAt, ...(themes ? { kind: "themes" as const } : {}) } };
}

export function __resetWorkMapListingCacheForTest(): void {
  cache.clear();
}
