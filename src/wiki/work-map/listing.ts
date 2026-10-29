/**
 * The listing's `workMap: {runAt}` field: read per `/api/wiki/pages` request
 * from `.work-map.json`, cached on the file's stat, so a run that just
 * finished shows on the next listing and an unchanged file costs one `stat`.
 * The client uses it to pick the Your work card over What's new without a
 * second serial fetch.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseWorkMap } from "./schema.ts";
import { WORK_MAP_FILE } from "./write.ts";

interface StatKey {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}
const cache = new Map<string, StatKey & { runAt: number | null }>();

/** The map's `runAtMs`, or null when the root has no readable work map. */
export async function workMapRunAt(root: string): Promise<number | null> {
  const file = path.join(root, WORK_MAP_FILE);
  let st;
  try {
    st = await stat(file);
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  // ino + ctime catch a same-size rewrite that preserved the mtime (cp -p, rsync -t).
  if (hit && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs && hit.size === st.size && hit.ino === st.ino) return hit.runAt;
  let runAt: number | null = null;
  try {
    runAt = parseWorkMap(await readFile(file, "utf8"))?.runAtMs ?? null;
  } catch {
    runAt = null;
  }
  cache.set(file, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino, runAt });
  return runAt;
}

/** The listing field: present only when the wiki has a map. */
export async function workMapListingField(root: string | undefined): Promise<{ workMap?: { runAt: number } }> {
  if (!root) return {};
  const runAt = await workMapRunAt(root);
  return runAt === null ? {} : { workMap: { runAt } };
}

export function __resetWorkMapListingCacheForTest(): void {
  cache.clear();
}
