/**
 * `prGrammar` in `.wiki-reader.json` (living facts PR 3b): how the wiki's
 * short PR forms resolve. The plan-status-sweep reads the same block
 * (claude-skills `plan-status-sweep/scripts/sweep-lib.ts` `parseWikiGrammar`),
 * and the live chips (`live-facts.ts`) mark with it.
 *
 * ```json
 * "prGrammar": { "owner": "navikt", "aliases": { "api": "melosys-api" }, "noProd": ["melosys-e2e-tests"] }
 * ```
 *
 * - `owner`: the GitHub owner `repo #n`, an alias and a bare `#n` resolve under.
 * - `aliases`: a shorthand → a repo under `owner`, or `owner/repo`. An alias
 *   wins over the rule that a hyphenated name before `#n` is a repo.
 * - `noProd`: repos that publish no release, by name or `owner/repo`; matched
 *   ignoring case.
 */

export interface PrGrammar {
  /** Null when the block names none: then only forms that carry an owner (a
   *  pull URL, `owner/repo#n`, an alias to `owner/repo`) resolve. */
  owner: string | null;
  aliases: Record<string, string>;
  noProd: string[];
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Validate a `prGrammar` value. Absent ⇒ null with no warning; a bad field
 *  warns and is dropped, the rest stands; a value that is not an object ⇒ null. */
export function parsePrGrammar(raw: unknown): { grammar: PrGrammar | null; warnings: string[] } {
  if (raw === undefined || raw === null) return { grammar: null, warnings: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return { grammar: null, warnings: ["is not an object — ignoring it"] };
  const o = raw as Record<string, unknown>;
  const warnings: string[] = [];
  if (o.owner !== undefined && !isStr(o.owner)) warnings.push("owner is not a non-empty string — ignoring it");
  const aliases: Record<string, string> = {};
  if (o.aliases !== undefined) {
    if (!o.aliases || typeof o.aliases !== "object" || Array.isArray(o.aliases)) warnings.push("aliases is not a string→string map — ignoring it");
    else
      for (const [k, v] of Object.entries(o.aliases)) {
        if (isStr(v)) aliases[k] = v.trim();
        else warnings.push(`aliases.${k} is not a non-empty string — ignoring it`);
      }
  }
  let noProd: string[] = [];
  if (o.noProd !== undefined) {
    if (!Array.isArray(o.noProd)) warnings.push("noProd is not an array of repo names — ignoring it");
    else noProd = o.noProd.filter(isStr).map((s) => s.trim());
  }
  return { grammar: { owner: isStr(o.owner) ? o.owner.trim() : null, aliases, noProd }, warnings };
}

/** `name` as `owner/name`, or as written when it already names its owner.
 *  Null when it needs an owner and there is none. */
export function qualifyRepo(owner: string | null, name: string): string | null {
  if (name.includes("/")) return name;
  return owner ? `${owner}/${name}` : null;
}

/** The `noProd` repos as lowercased `owner/repo`. */
export function noProdSet(grammar: PrGrammar | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const n of grammar?.noProd ?? []) {
    const q = qualifyRepo(grammar!.owner, n);
    if (q) out.add(q.toLowerCase());
  }
  return out;
}
