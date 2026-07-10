/**
 * Named-wiki registry — maps a `?wiki=<name>` (or legacy `?bot=<name>`) param to
 * the wiki root the store should scan. Two sources feed it:
 *   - **bot wikis**: every discovered bot with a configured `wikiDir`.
 *   - **standalone wikis**: `name=path` pairs from the `WIKI_EXTRA` env var
 *     (e.g. the mimir code wiki or the melosys-kode-wiki), which belong to no bot.
 *
 * Kept pure (takes a bots array + the raw env string, no filesystem beyond
 * `path.resolve`) so the dashboard route logic stays unit-testable without
 * spinning up bot discovery.
 */

import os from "node:os";
import path from "node:path";
import type { BotConfig } from "../bots/config.ts";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "registry");

export type WikiSource = "bot" | "extra";

export interface WikiRegistryEntry {
  /** Canonical wiki name — matched case-insensitively, echoed back verbatim. */
  name: string;
  /** Absolute filesystem root the store scans for this wiki. */
  root: string;
  source: WikiSource;
  /** Huginn search collections backing this wiki's **Ask** tab (research-style
   *  Q&A scoped to the wiki). Bot wikis get it from `config.json`'s
   *  `wikiCollections`; standalone wikis from the optional third `WIKI_EXTRA`
   *  segment (`name=path=coll1+coll2`). Absent/empty ⇒ the Ask tab has no corpus
   *  and the ask route returns a clean "no collection connected" error. */
  collections?: string[];
  /** Explicit per-wiki synthesis-bot pin. Names the bot that answers this wiki's
   *  Ask / What's-new digest, BEATING the owner fast-gate and the research-bot
   *  fallback (see `resolveWikiSynthesisBot`). Bot wikis get it from the OWNING
   *  bot's `config.json` `wikiSynthesisBot`; standalone wikis from the optional
   *  fourth `WIKI_EXTRA` segment (`name=path=coll1+coll2=botname`, or
   *  `name=path==botname` for a pin with no collections). Unset ⇒ owner/fallback
   *  routing. A pin naming no discovered bot is warned + ignored at resolve time. */
  synthesisBot?: string;
}

/** Repo root: import.meta.dir = <root>/src/wiki → two levels up. Relative
 *  `WIKI_EXTRA` paths resolve against this, same base the store's default uses. */
const REPO_ROOT = path.resolve(import.meta.dir, "../../");

/** Expand a leading `~`/`~/` in a `WIKI_EXTRA` path to the user's home dir —
 *  otherwise `path.resolve(repoRoot, "~/x")` yields the literal `<repo>/~/x`. */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Build the wiki registry from discovered bots + the raw `WIKI_EXTRA` env string.
 * Bot wikis come first (names stay `jarvis`/`melosys`/…); then standalone wikis
 * from comma-separated `name=path` pairs. Malformed pairs and names colliding
 * with an already-registered wiki are warned about and skipped. Relative paths
 * resolve against the muninn repo root; absolute paths pass through unchanged.
 */
export function buildWikiRegistry(
  bots: BotConfig[],
  extraRaw: string | undefined,
  repoRoot: string = REPO_ROOT,
): WikiRegistryEntry[] {
  const entries: WikiRegistryEntry[] = [];
  const seen = new Set<string>();

  const add = (
    name: string,
    root: string,
    source: WikiSource,
    collections?: string[],
    synthesisBot?: string,
  ): boolean => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    const entry: WikiRegistryEntry = { name, root, source };
    if (collections && collections.length > 0) entry.collections = collections;
    if (synthesisBot) entry.synthesisBot = synthesisBot;
    entries.push(entry);
    return true;
  };

  for (const b of bots) {
    if (b.wikiDir) add(b.name, b.wikiDir, "bot", b.wikiCollections, b.wikiSynthesisBot);
  }

  for (const rawPair of (extraRaw ?? "").split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;
    // `name=path`, `name=path=coll1+coll2`, or `name=path=coll1+coll2=botpin`
    // (third + fourth segments optional). The name is everything before the FIRST
    // `=`. We then peel, right-to-left:
    //   1. an optional trailing `=botpin` synthesis-bot pin — a BARE bot name
    //      (charset `[A-Za-z0-9][A-Za-z0-9_-]*`, deliberately NO `+`, which marks
    //      a collection LIST) — but ONLY when removing it still leaves a
    //      collections segment behind (another `=` whose tail is a valid
    //      collection list or empty). That guard keeps `name=path=coll` parsing
    //      `coll` as collections (not a pin) and keeps a `=`-containing path with
    //      a trailing collection list (no pin) round-tripping unchanged.
    //   2. an optional trailing `=coll+coll` collection list (or empty `=`).
    // Anything left is the path, so a path that itself contains `=` round-trips —
    // with ONE known limitation: a `=`-containing path followed by a SINGLE
    // (`+`-less) collection (e.g. `w=/a=b=coll`) is inherently ambiguous with a
    // 4-segment pin form; the peel treats `coll` as a pin and steals `b` as the
    // collection. Paths with `=` are pathological (no real config uses them);
    // use a `+`-list (or rename the path) if you ever hit this. Pinned by test.
    const eq = pair.indexOf("=");
    const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
    let remainder = eq === -1 ? "" : pair.slice(eq + 1);

    const COLL_TAIL_RE = /^[A-Za-z0-9][A-Za-z0-9+_-]*$/;
    const BOT_PIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

    let rawPin: string | undefined;
    {
      const pinEq = remainder.lastIndexOf("=");
      if (pinEq !== -1) {
        const pinTail = remainder.slice(pinEq + 1).trim();
        const head = remainder.slice(0, pinEq); // path[=coll]
        const headEq = head.lastIndexOf("=");
        if (BOT_PIN_RE.test(pinTail) && headEq !== -1) {
          const collsTail = head.slice(headEq + 1).replace(/\s+/g, "");
          if (collsTail === "" || COLL_TAIL_RE.test(collsTail)) {
            rawPin = pinTail;
            remainder = head;
          }
        }
      }
    }

    let rawPath = remainder.trim();
    let rawColls: string | undefined;
    const lastEq = remainder.lastIndexOf("=");
    if (lastEq !== -1) {
      // Strip whitespace so a spaced-out `a + b` still reads as a collection list.
      const compact = remainder.slice(lastEq + 1).replace(/\s+/g, "");
      if (compact === "" || COLL_TAIL_RE.test(compact)) {
        rawPath = remainder.slice(0, lastEq).trim();
        rawColls = compact || undefined;
      }
    }
    if (!name || !rawPath) {
      log.warn("WIKI_EXTRA: skipping malformed entry {pair} (expected name=path[=coll+coll[=botpin]])", { pair });
      continue;
    }
    const collections = rawColls
      ? rawColls.split("+").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const absPath = expandTilde(rawPath);
    const root = path.isAbsolute(absPath) ? absPath : path.resolve(repoRoot, absPath);
    if (!add(name, root, "extra", collections, rawPin)) {
      log.warn("WIKI_EXTRA: skipping {name} — name collides with an existing wiki", { name });
    }
  }

  return entries;
}

/**
 * The single name-matching rule shared by every resolver + route: case-insensitive,
 * whitespace-trimmed lookup of a registry entry by name. Returns undefined for a
 * blank name or a name no entry carries.
 */
export function findWiki(
  registry: WikiRegistryEntry[],
  name: string | undefined,
): WikiRegistryEntry | undefined {
  const wanted = name?.trim();
  if (!wanted) return undefined;
  return registry.find((e) => e.name.toLowerCase() === wanted.toLowerCase());
}

/** Names of every registered wiki (bot + extra) — populates the reader's picker. */
export function listWikis(registry: WikiRegistryEntry[]): string[] {
  return registry.map((e) => e.name);
}

/**
 * The entry a bare `/wiki` renders: jarvis if registered, else the first registry
 * entry, else undefined (no wiki at all). Derived from the actual registry so the
 * picker's selection, the scanned root, and rendered content can't disagree.
 */
export function defaultWikiEntry(registry: WikiRegistryEntry[]): WikiRegistryEntry | undefined {
  return findWiki(registry, "jarvis") ?? registry[0];
}

/** Name of the default wiki (see `defaultWikiEntry`) — undefined for an empty registry. */
export function defaultWiki(registry: WikiRegistryEntry[]): string | undefined {
  return defaultWikiEntry(registry)?.name;
}

export interface WikiRequestResolution {
  /** Wiki the picker highlights AND the client uses as its `?wiki=` param. "" = none. */
  wiki: string;
  /** True when a bare `/wiki` is served from the legacy `WIKI_DIR` env override. */
  envOverride: boolean;
  /** The resolved registry entry (name/root/source) when the wiki is known —
   *  undefined for an unknown name or the `WIKI_DIR` env-override case. Lets routes
   *  read root + source without re-finding. */
  entry?: WikiRegistryEntry;
  /** True when a name was given (via `wiki` or `bot`) but no entry matched it. */
  unknownWiki: boolean;
}

/**
 * The one place the `?wiki=`/`?bot=` precedence and registry lookup live — every
 * reader/gardener route resolves through this and reads back `entry` (root +
 * source) instead of re-finding. `?wiki=` wins over the legacy `?bot=` alias:
 *   - a name (from `wiki`, else `bot`) → the matching entry (canonical name
 *     case-corrected so the picker's `selected` agrees with the lookup). An
 *     unknown name is echoed back with `unknownWiki: true` so the client
 *     re-queries it and lands on the empty state (not a silent default).
 *   - bare `/wiki` with `WIKI_DIR` set → `{ wiki: "", envOverride: true }`: the
 *     legacy env override stays explicit, no entry, and the picker claims no wiki.
 *   - bare `/wiki` otherwise → the `defaultWikiEntry` (or `{ wiki: "" }` when the
 *     registry is empty, so the store's own env/hardcoded fallback serves content).
 */
export function resolveWikiRequest(
  registry: WikiRegistryEntry[],
  rawWiki: string | undefined,
  rawBot: string | undefined,
  envWikiDir: string | undefined,
): WikiRequestResolution {
  const wanted = rawWiki?.trim() || rawBot?.trim();
  if (wanted) {
    const entry = findWiki(registry, wanted);
    return { wiki: entry ? entry.name : wanted, envOverride: false, entry, unknownWiki: !entry };
  }
  if (envWikiDir && envWikiDir.trim()) return { wiki: "", envOverride: true, unknownWiki: false };
  const entry = defaultWikiEntry(registry);
  return { wiki: entry?.name ?? "", envOverride: false, entry, unknownWiki: false };
}
