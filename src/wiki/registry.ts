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
}

/** Repo root: import.meta.dir = <root>/src/wiki → two levels up. Relative
 *  `WIKI_EXTRA` paths resolve against this, same base the store's default uses. */
const REPO_ROOT = path.resolve(import.meta.dir, "../../");

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

  const add = (name: string, root: string, source: WikiSource): boolean => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    entries.push({ name, root, source });
    return true;
  };

  for (const b of bots) {
    if (b.wikiDir) add(b.name, b.wikiDir, "bot");
  }

  for (const rawPair of (extraRaw ?? "").split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) {
      log.warn("WIKI_EXTRA: skipping malformed entry {pair} (expected name=path)", { pair });
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const rawPath = pair.slice(eq + 1).trim();
    if (!name || !rawPath) {
      log.warn("WIKI_EXTRA: skipping malformed entry {pair} (empty name or path)", { pair });
      continue;
    }
    const root = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
    if (!add(name, root, "extra")) {
      log.warn("WIKI_EXTRA: skipping {name} — name collides with an existing wiki", { name });
    }
  }

  return entries;
}

export interface WikiRootResolution {
  /** Explicit root to scan. Undefined = store default (WIKI_DIR env → jarvis). */
  root?: string;
  /** True when a wiki name was given but isn't in the registry. */
  unknownWiki?: boolean;
}

/**
 * Resolve the wiki root for a requested name:
 *   - no/blank name → `{}` (store falls back to `WIKI_DIR` env → jarvis default).
 *   - known wiki → `{ root }`.
 *   - unknown wiki → `{ unknownWiki: true }`.
 */
export function resolveWikiRoot(
  registry: WikiRegistryEntry[],
  name: string | undefined,
): WikiRootResolution {
  const wanted = name?.trim();
  if (!wanted) return {};
  const entry = registry.find((e) => e.name.toLowerCase() === wanted.toLowerCase());
  if (!entry) return { unknownWiki: true };
  return { root: entry.root };
}

/** Names of every registered wiki (bot + extra) — populates the reader's picker. */
export function listWikis(registry: WikiRegistryEntry[]): string[] {
  return registry.map((e) => e.name);
}

/**
 * The wiki a bare `/wiki` renders: jarvis if registered, else the first
 * registry entry, else undefined (no wiki at all). Derived from the actual
 * registry so the picker's selection and rendered content can't disagree.
 */
export function defaultWiki(registry: WikiRegistryEntry[]): string | undefined {
  return registry.find((e) => e.name.toLowerCase() === "jarvis")?.name ?? registry[0]?.name;
}

export interface WikiRequestResolution {
  /** Wiki the picker highlights AND the client uses as its `?wiki=` param. "" = none. */
  wiki: string;
  /** True when a bare `/wiki` is served from the legacy `WIKI_DIR` env override. */
  envOverride: boolean;
}

/**
 * Resolve which wiki the `/wiki` reader page selects (picker + client `?wiki=`).
 * `?wiki=` wins over the legacy `?bot=` alias when both are present:
 *   - a name (from `wiki`, else `bot`) → canonical registry name (case-corrected)
 *     so the picker's `selected` matches the store's case-insensitive lookup. An
 *     unknown name is echoed back so the client re-queries it and lands on the
 *     empty state (not a silent default).
 *   - bare `/wiki` with `WIKI_DIR` set → `{ wiki: "", envOverride: true }`: the
 *     legacy env override stays explicit and the picker claims no wiki.
 *   - bare `/wiki` otherwise → the `defaultWiki` (or "" when the registry is
 *     empty, so the store's own env/hardcoded fallback still serves content).
 */
export function resolveWikiRequest(
  registry: WikiRegistryEntry[],
  rawWiki: string | undefined,
  rawBot: string | undefined,
  envWikiDir: string | undefined,
): WikiRequestResolution {
  const wanted = rawWiki?.trim() || rawBot?.trim();
  if (wanted) {
    const entry = registry.find((e) => e.name.toLowerCase() === wanted.toLowerCase());
    return { wiki: entry ? entry.name : wanted, envOverride: false };
  }
  if (envWikiDir && envWikiDir.trim()) return { wiki: "", envOverride: true };
  return { wiki: defaultWiki(registry) ?? "", envOverride: false };
}
