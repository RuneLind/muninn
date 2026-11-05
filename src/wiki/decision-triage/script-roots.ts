/** The two triage scripts' `--root <wiki>=<path>` flag and registry lookup. */

import path from "node:path";
import { getWikiRegistry } from "../registry-memo.ts";
import type { WikiRegistryEntry } from "../registry.ts";

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
