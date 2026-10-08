/**
 * The wiki reader's lenses (Overview, All, Agent) and the full names of ids.
 * Pure and browser-safe: `src/config.ts` and the reader-config parse in
 * `src/wiki/store.ts` read the values through it, the renderer prints the id
 * nouns from it, and the reader's client resolves and stores the lens with it.
 *
 * Precedence (D2): `?lens=` in the URL, then the viewer's stored choice, then
 * the instance default (`WIKI_DEFAULT_LENS`), then the wiki's `defaultLens`,
 * then All. The server folds the last two into one `defaultLens` on the page
 * payload. Agent is never stored and is never a default: it exists only where
 * the server says so, and `?lens=agent` anywhere else is All.
 */

import type { QuestionLanguage } from "./question-labels.ts";

export const LENSES = ["overview", "all", "agent"] as const;
export type Lens = (typeof LENSES)[number];
/** A lens a viewer may store, and an instance or wiki may name as default. */
export type StoredLens = Exclude<Lens, "agent">;

/** The attribute on text the reader adds to a page (an id's noun, a fold's
 *  size line): on screen, but not in the page's source, so a selection sent
 *  to Explain or fact-check leaves it out. */
export const READER_ONLY_ATTR = "data-reader-only";

/** localStorage key for the viewer's choice (D1), beside «line refs». */
export const LENS_KEY = "muninn.wiki.lens.v1";

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

/** A lens that may be stored or be a default: Overview or All. */
export function parseStoredLens(raw: unknown): StoredLens | null {
  const l = parseLens(raw);
  return l === "agent" ? null : l;
}

export interface LensInputs {
  /** `?lens=` from the URL, raw; consumed once by the caller. */
  url?: string | null;
  /** The lens of the view an in-place reload replaces (the same page after a
   *  fact-check append or an integrate apply): it beats the stored choice and
   *  the default, and is not stored. */
  inPlace?: Lens | null;
  /** The viewer's stored choice, raw. */
  stored?: string | null;
  /** The page payload's default: `WIKI_DEFAULT_LENS` for this wiki, else the
   *  wiki's `defaultLens`. */
  pageDefault?: string | null;
  /** The server's flag: the Agent lens is offered for this page and viewer. */
  agentAvailable: boolean;
}

/** D2's precedence, with an in-place reload's own lens after the URL. A URL
 *  `agent` where the Agent lens is unavailable is All, not the next rung: the
 *  link asked for everything, and All is everything a reader can see here. */
export function resolveLens(i: LensInputs): Lens {
  const url = parseLens(i.url);
  if (url) return url === "agent" && !i.agentAvailable ? "all" : url;
  const kept = parseLens(i.inPlace);
  if (kept && (kept !== "agent" || i.agentAvailable)) return kept;
  return parseStoredLens(i.stored) ?? parseStoredLens(i.pageDefault) ?? "all";
}

/** The stored choice. Any storage failure (private window, blocked site data)
 *  reads as nothing stored. */
export function readStoredLens(storage: Pick<Storage, "getItem"> | undefined): StoredLens | null {
  try {
    return parseStoredLens(storage?.getItem(LENS_KEY));
  } catch {
    return null;
  }
}

/** Store a choice. Agent is never stored (D1): it applies to the current view
 *  only. Returns whether anything was written. */
export function writeStoredLens(storage: Pick<Storage, "setItem"> | undefined, lens: Lens): boolean {
  if (lens === "agent") return false;
  try {
    storage?.setItem(LENS_KEY, lens);
    return !!storage;
  } catch {
    return false;
  }
}

/** The switch's labels, in the wiki's `language`. */
export const LENS_LABELS: Record<QuestionLanguage, Record<Lens, string>> = {
  en: { overview: "Overview", all: "All", agent: "Agent" },
  no: { overview: "Oversikt", all: "Alt", agent: "Agent" },
};

// ── WIKI_DEFAULT_LENS (D24) ──────────────────────────────────────────────────

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

/** One page's default: the instance's for this wiki, else the wiki file's. */
export function pageDefaultLens(
  wiki: string | undefined,
  instance: WikiDefaultLens | undefined,
  fileDefault: StoredLens | null | undefined,
): StoredLens | null {
  const fromEnv = wiki ? instance?.byWiki.get(wiki.toLowerCase()) : undefined;
  return fromEnv ?? fileDefault ?? null;
}

// ── Id labels (D12) ──────────────────────────────────────────────────────────

/** A noun for an id prefix, singular and plural: `{one: "Beslutning", other: "beslutninger"}`. */
export interface IdLabel {
  one: string;
  other: string;
}
/** Prefix letters → noun. `{}` ⇒ ids show bare, as before. */
export type IdLabels = Record<string, IdLabel>;

const ID_PREFIX_RE = /^([A-Za-z]{1,4})-?\d/;
const LABEL_KEY_RE = /^[A-Za-z]{1,4}$/;
const LABEL_MAX = 40;

/** The letters before the digits: `Q-14` → `Q`, `S1` → `S`. Null when the id
 *  does not start with one to four letters and a digit. */
export function idPrefix(id: string): string | null {
  return ID_PREFIX_RE.exec(id)?.[1] ?? null;
}

/** The noun for one id, or null when the wiki names none. */
export function idNoun(labels: IdLabels | undefined, id: string, count = 1): string | null {
  const prefix = idPrefix(id);
  const label = prefix && labels ? labels[prefix] : undefined;
  if (!label) return null;
  return count === 1 ? label.one : label.other;
}

/** `.wiki-reader.json` `idLabels`: each key one to four letters, each value
 *  `{one, other}` non-empty strings of at most 40 chars. A bad entry is dropped
 *  with a reason; the rest stand. */
export function parseIdLabels(raw: unknown): { labels: IdLabels; warnings: string[] } {
  const labels: IdLabels = {};
  const warnings: string[] = [];
  if (raw === undefined) return { labels, warnings };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { labels, warnings: ["is not an object of {one, other} labels — ignoring it"] };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!LABEL_KEY_RE.test(key)) {
      warnings.push(`key "${key}" is not one to four letters — dropped`);
      continue;
    }
    if (key !== key.toUpperCase()) {
      warnings.push(`key "${key}" has a lower-case letter: id prefixes match by case, so it labels only ids spelled "${key}1"`);
    }
    const v = value as Record<string, unknown> | null;
    const ok = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.trim().length <= LABEL_MAX;
    if (!v || typeof v !== "object" || !ok(v.one) || !ok(v.other)) {
      warnings.push(`"${key}" needs one and other, each a non-empty string of at most ${LABEL_MAX} chars — dropped`);
      continue;
    }
    labels[key] = { one: v.one.trim(), other: v.other.trim() };
  }
  return { labels, warnings };
}
