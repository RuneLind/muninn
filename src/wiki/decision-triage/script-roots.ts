/** The two triage scripts' `--root <wiki>=<path>` flag and registry lookup. */

import { existsSync } from "node:fs";
import path from "node:path";
import { getWikiRegistry } from "../registry-memo.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { isInsideDir } from "../work-map/dry-run.ts";
import { DECISION_TRIAGE_DIR } from "./log.ts";

export function rootOverrides(flags: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq <= 0) throw new Error(`--root takes <wiki>=<path>, got ${flag}`);
    out.set(flag.slice(0, eq).trim().toLowerCase(), path.resolve(flag.slice(eq + 1).trim()));
  }
  return out;
}

/** Each named wiki's entry, by `--root` first, then the registry; unknown names drop out. */
export function triageEntries(overrides: ReadonlyMap<string, string>, names: readonly string[]): WikiRegistryEntry[] {
  return names.flatMap((name) => {
    const given = overrides.get(name.toLowerCase());
    if (given) return [{ name, root: given, source: "extra" as const }];
    const found = getWikiRegistry().find((e) => e.name.toLowerCase() === name.toLowerCase());
    return found ? [found] : [];
  });
}

/** Would `--out` land in the log folder? A folder not there yet holds nothing, but
 *  the append would create it, so a path under its name still counts. */
export function outInsideLog(out: string, dir: string = DECISION_TRIAGE_DIR): boolean {
  if (existsSync(dir)) return isInsideDir(dir, out);
  const rel = path.relative(dir, path.resolve(out));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
