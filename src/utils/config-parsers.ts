/**
 * The parsers and grammars `src/config.ts` reads, moved down from
 * `src/format/{question,lane-roles,reader-lens}.ts` (architecture review
 * 2026-11, B2) so the config module imports nothing above the platform layer.
 * Each old home re-exports what it held, so their importers are unchanged.
 */

// ── From question.ts ────────────────────────────────────────────────────────

/** One entry of `questions_to:` or `to=`: `Name` or `Name (IDENT)`. */
export interface QuestionTarget {
  name: string;
  ident: string | null;
}

/** `Name` or `Name (IDENT)`; a blank entry is null. */
export function parseQuestionTarget(entry: string): QuestionTarget | null {
  const s = entry.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  if (!s) return null;
  const m = /^(.*\S)\s*\(\s*([^()\s][^()]*?)\s*\)$/.exec(s);
  if (m) return { name: m[1]!.trim(), ident: m[2]! };
  return { name: s, ident: null };
}

/** Format characters (zero-width space, soft hyphen, BOM …) dropped, then
 *  NFC — in that order, or a format character between a letter and its
 *  combining mark blocks the composition — white space collapsed, lower-cased:
 *  a name pasted from a document still matches. */
export const foldName = (s: string) =>
  s.replace(/\p{Cf}/gu, "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/** `WIKI_ANSWER_GROUPS`: group name (lower-case) → member NAV idents (upper-case). */
export type AnswerGroups = ReadonlyMap<string, ReadonlySet<string>>;

/** The configured group a target names, if any: an entry with no `(IDENT)`
 *  whose folded name is a group name. With no groups, every name is a person. */
export function targetGroup(t: QuestionTarget, groups: AnswerGroups): ReadonlySet<string> | undefined {
  return t.ident ? undefined : groups.get(foldName(t.name));
}

/** The group `WIKI_ANSWER_OWNER` names when given as a bare name (no
 *  `(IDENT)`) equal to a group name: the owner fallback then asks that group. */
export function ownerGroupName(owner: string | null | undefined, groups: AnswerGroups): string | null {
  const t = owner ? parseQuestionTarget(owner) : null;
  return t && targetGroup(t, groups) ? foldName(t.name) : null;
}

// ── From lane-roles.ts ──────────────────────────────────────────────────────

/** A role key as `roleKeys` and `<Lane role=>` take it, after lower-casing —
 *  the `WIKI_ANSWER_GROUPS` group-name grammar (`parseAnswerGroups` in
 *  `src/config.ts` reads this one copy). */
export const ROLE_KEY_RE = /^[a-z0-9æøå_-]+$/;
/** Six or more digits in a row, anywhere in the name. A NAV ident is a letter
 *  and six digits, so a name holding one (`fag-z990001`, garbled `z9900011`)
 *  would put an ident on every chip and export heading. The rule ignores the
 *  letter on purpose: it refuses a week-coded `uke202541` too, which an
 *  operator writes `uke2025-41`, and leaves no letter class to get wrong. */
export const DIGIT_RUN_RE = /\d{6}/;

// ── From reader-lens.ts ─────────────────────────────────────────────────────

export const LENSES = ["overview", "all", "agent"] as const;
export type Lens = (typeof LENSES)[number];
/** A lens a viewer may store, and an instance or wiki may name as default. */
export type StoredLens = Exclude<Lens, "agent">;

const LENS_ALIASES: Readonly<Record<string, Lens>> = {
  overview: "overview",
  oversikt: "overview",
  all: "all",
  alt: "all",
  agent: "agent",
};

/** A lens value as a URL, a store or a config spells it: canonical names and
 *  the Norwegian aliases, any case, trimmed. Null for anything else. */
export function parseLens(raw: unknown): Lens | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  // Own keys only: `constructor` or `__proto__` from a URL, a store or a
  // config must not resolve to an inherited member.
  return Object.hasOwn(LENS_ALIASES, key) ? LENS_ALIASES[key]! : null;
}

/** A default lens as `WIKI_DEFAULT_LENS` or `.wiki-reader.json` `defaultLens`
 *  spells it: Overview or All. Anything else is null with the one warning
 *  text both sources log. */
export function parseDefaultLens(raw: unknown): { lens: StoredLens | null; warning?: string } {
  const lens = parseLens(raw);
  if (lens === "agent") return { lens: null, warning: "agent cannot be a default lens" };
  if (lens) return { lens };
  const shown = typeof raw === "string" ? `"${raw.trim()}"` : JSON.stringify(raw);
  return { lens: null, warning: `${shown} is not overview, all, oversikt or alt` };
}

export interface WikiDefaultLens {
  /** Wiki name, lower-cased → its default. */
  byWiki: ReadonlyMap<string, StoredLens>;
  /** Entries dropped, by position — carried, logged at boot. */
  warnings: string[];
}

/** `WIKI_DEFAULT_LENS`: `wiki=lens` pairs, comma-separated, names matched
 *  without case. A malformed entry, an unknown lens or `agent` is dropped with
 *  a warning naming its position. */
export function parseWikiDefaultLens(raw: string | undefined): WikiDefaultLens {
  const byWiki = new Map<string, StoredLens>();
  const warnings: string[] = [];
  (raw ?? "").split(",").forEach((segment, i) => {
    const entry = segment.trim();
    if (!entry) return;
    const at = `WIKI_DEFAULT_LENS entry ${i + 1}`;
    const eq = entry.indexOf("=");
    const name = eq === -1 ? "" : entry.slice(0, eq).trim().toLowerCase();
    if (!name) return void warnings.push(`${at} dropped: expected wiki=lens`);
    const { lens, warning } = parseDefaultLens(entry.slice(eq + 1));
    if (!lens) return void warnings.push(`${at} dropped: ${warning}`);
    if (byWiki.has(name)) warnings.push(`${at}: "${name}" is named again — this entry wins`);
    byWiki.set(name, lens);
  });
  return { byWiki, warnings };
}
