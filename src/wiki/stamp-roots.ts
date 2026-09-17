/**
 * `WIKI_STAMP_BIN` / `WIKI_STAMP_ROOTS` / `WIKI_STAMP_BUN` — everything muninn
 * knows about the ONE writer of the provenance frontmatter lines.
 *
 * muninn never writes those lines (`provenance.ts`'s header, and the
 * single-writer rule in `CLAUDE.md`): the Stamp control shells out to
 * claude-usage's `wiki-stamp` CLI exactly as the Claude Code hook and the
 * opencode plugin do. This module holds the two things the muninn side has to
 * know about that CLI without importing it — where it is, and which roots it
 * will classify a page against.
 *
 * ── The roots parse is a RE-IMPLEMENTATION, deliberately ────────────────────
 * The two repos cannot import each other, so this mirrors
 * `claude-usage/src/wiki-stamp.ts`'s `parseRoots` semantics rather than sharing
 * them: `:`-separated like `PATH`, blank and relative entries dropped rather
 * than guessed at, `/` refused (as a root it makes every markdown file on the
 * machine a wiki page), each entry normalized, order kept, deduped. A drift
 * between the two shows up as a Stamp button that 409s `outside-roots`, which is
 * why `stampable` below is computed from THIS parse and not from a probe.
 *
 * ── `stampable` is EQUALITY, not containment ────────────────────────────────
 * The CLI locks the longest matching STAMP root; muninn's own writers lock the
 * WIKI root (`lockfile.ts`). A wiki registered at a strict subdirectory of a
 * stamp root therefore gets two different lock files and no mutual exclusion —
 * the lost-append the single-writer rule exists to prevent. So a wiki is
 * stampable only when its root IS one of the parsed roots. `…/mimir-old` is not
 * under `…/mimir` and `…/mimir/plans` is not `…/mimir`; both are false here and
 * both would be true under the prefix tests this rule replaces.
 */

import path from "node:path";
import { isReadonlyWikiRoot, isWikiReadonly, sameWikiRoot } from "./readonly.ts";

/** The env var names, so error copy, the payload and the docs agree. */
export const WIKI_STAMP_BIN_ENV = "WIKI_STAMP_BIN";
export const WIKI_STAMP_ROOTS_ENV = "WIKI_STAMP_ROOTS";
export const WIKI_STAMP_BUN_ENV = "WIKI_STAMP_BUN";

/**
 * muninn's own bound on one Stamp spawn.
 *
 * The CLI bounds ITSELF at 5 s (`MAX_RUN_MS`) and reports `lock-timeout` /
 * `deadline` from inside that budget, so this is not a second copy of its
 * deadline: it is the bound on a slow interpreter start or a wedged child, and
 * is deliberately well above the CLI's own so that a hit here means the CLI
 * never got to answer.
 */
export const WIKI_STAMP_TIMEOUT_MS = 15_000;

/** Trailing-separator-free, `.`/`..`-free form of an absolute path. */
function normalizeRoot(p: string): string {
  const n = path.normalize(p);
  return n.length > 1 && n.endsWith(path.sep) ? n.slice(0, -1) : n;
}

/**
 * Parse a raw `WIKI_STAMP_ROOTS` value. Pure; see the header for the rules and
 * for why they are a re-implementation rather than an import.
 */
export function parseStampRoots(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(":")) {
    const entry = part.trim();
    // Relative is dropped, not resolved: the CLI would classify it against its
    // own cwd, which is not this process's.
    if (!entry || !entry.startsWith("/")) continue;
    const norm = normalizeRoot(entry);
    if (norm === "/") continue;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/** What this instance knows about the stamper. */
export interface StampConfig {
  /** `WIKI_STAMP_BIN` — the CLI's `.ts` source. Null when unset. */
  bin: string | null;
  /** The interpreter, `WIKI_STAMP_BUN` or the name on `PATH`. */
  bun: string;
  /** `WIKI_STAMP_ROOTS` verbatim, which is what the child env carries — the CLI
   *  does its own parse and must see the operator's own value. Null when unset. */
  rootsRaw: string | null;
  /** The parsed roots, for `stampable`. */
  roots: string[];
}

/** One trimmed read per variable, so a whitespace-only value cannot report
 *  "configured" while naming nothing — the `src/sync/` idiom. */
export function stampConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): StampConfig {
  const bin = env[WIKI_STAMP_BIN_ENV]?.trim() || null;
  const rootsRaw = env[WIKI_STAMP_ROOTS_ENV]?.trim() || null;
  return {
    bin,
    bun: env[WIKI_STAMP_BUN_ENV]?.trim() || "bun",
    rootsRaw,
    roots: parseStampRoots(rootsRaw),
  };
}

/**
 * Is this wiki root ONE of the stamp roots? Equality (see the header), through
 * `sameWikiRoot` so a symlinked spelling on either side still names one root —
 * the same normalize-then-realpath comparison `isReadonlyWikiRoot` makes, and
 * the same one the CLI makes when it resolves its own roots.
 */
export function isStampRoot(wikiDir: string, roots: readonly string[]): boolean {
  return roots.some((root) => sameWikiRoot(wikiDir, root));
}

/**
 * May this instance offer a Stamp for a page in this wiki at all?
 *
 * False hides every Stamp button — including on a writable wiki the CLI does not
 * cover, where every click would be an `outside-roots` 409. The read-only half
 * is what the mini needs: a stamping host with `WIKI_STAMP_BIN` and
 * `WIKI_STAMP_ROOTS` set AND `MUNINN_WIKI_READONLY=1`.
 */
export function stampableFor(opts: {
  wikiDir: string;
  config: StampConfig;
  /** Test seams, defaulting to the process's own guards. */
  isReadonly?: () => boolean;
  isReadonlyRoot?: (root: string) => boolean;
}): boolean {
  const { wikiDir, config } = opts;
  if (!config.bin || config.roots.length === 0) return false;
  if (!isStampRoot(wikiDir, config.roots)) return false;
  if ((opts.isReadonly ?? isWikiReadonly)()) return false;
  if ((opts.isReadonlyRoot ?? isReadonlyWikiRoot)(wikiDir)) return false;
  return true;
}
