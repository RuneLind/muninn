/**
 * `MUNINN_WIKI_READONLY` — the wiki write-owner switch.
 *
 * A second muninn instance (the Mac mini) runs with no bot tokens and
 * `SCHEDULER_ENABLED=false`. That closes the SCHEDULER only: every dashboard
 * route is registered unconditionally in `createDashboardRoutes`, so the whole
 * HTTP write surface stays live and two instances would write the same wiki
 * working tree. `MUNINN_WIKI_READONLY=1` closes that surface instead.
 *
 * **Precise semantics: it forbids programmatic page CONTENT writes, not git.**
 * `commitWikiChange` is deliberately NOT guarded — the repo-sync loop on the
 * readonly instance commits and pushes through it, and the THREE content seams
 * below plus the route guards already cover every content-write funnel:
 *
 *   - `writeWikiPage` (fact-check append + integrate/apply)
 *   - `applyWikiProposal` (gardener approve)
 *   - `writePlanQueue` (`src/plans/write.ts` — `plans/queue.yaml`, which
 *     `writeWikiPage`'s `.md`/`.mdx` path confinement correctly cannot carry)
 *
 * The `wiki-committer` watcher also calls `commitWikiChange` (it commits stray
 * dirty files and writes no page content) and stays unguarded too.
 *
 * Offline scripts that write with a bare `Bun.write` are out of scope — this
 * guards the HTTP surface, and the readonly instance runs no such scripts.
 */

import { wikiReadonlyFromEnv } from "../config.ts";

/** The env var name, so error copy and the `/models` machine card agree. */
export const WIKI_READONLY_ENV = "MUNINN_WIKI_READONLY";

/** The one refusal sentence — reported as the seam outcome's `reason` and as
 *  the 403 body's `error` on every guarded route. */
export const WIKI_READONLY_REASON =
  `this muninn instance is wiki-readonly (${WIKI_READONLY_ENV}=1) — programmatic wiki page writes are disabled here`;

/** Test override. `undefined` ⇒ read the env (production behaviour). */
let testOverride: boolean | undefined;

/**
 * Is this instance forbidden from writing wiki page content? Read at CALL time,
 * never cached, so a test (or a future hot toggle) flipping the flag takes
 * effect immediately. Every seam takes it as an injectable `isReadonly` option
 * defaulting to this, so a test can drive one seam without touching the process.
 */
export function isWikiReadonly(): boolean {
  return testOverride ?? wikiReadonlyFromEnv();
}

/** Force the flag for a test; call with no argument to restore env resolution. */
export function __setWikiReadonlyForTest(value?: boolean): void {
  testOverride = value;
}

// ---------------------------------------------------------------------------
// Per-WIKI read-only roots (`WIKI_READONLY_ROOTS`)
// ---------------------------------------------------------------------------
//
// `MUNINN_WIKI_READONLY` above is an INSTANCE switch. This is the second
// mechanism: a comma-separated list of wiki ROOTS this instance must never write
// or spend a model call on, however many other wikis it owns. It exists for
// roots muninn only ever READS — the `~/.claude/projects` Claude Code memory
// corpus, whose files are loaded into a session's context at start, so an HTTP
// write there edits the developer's own instructions.
//
// Three decisions are load-bearing:
//
//   1. **It is keyed on the resolved ROOT, not the registry NAME.** Every seam
//      already holds the root at its refusal point (`writeWikiPage`'s `wikiDir`,
//      `applyWikiProposal`'s `deps.wikiDir`, `writePlanQueue`'s `opts.wikiDir`),
//      so the predicate is a string comparison against a value in hand — no
//      registry lookup, and therefore no `registry-memo.ts` → `bots/config.ts` →
//      `db/` import pull into the wiki store and the page writer. A name key
//      would also need a name→root translation whose typo path fails OPEN.
//   2. **It lives in the environment, not in `.wiki-reader.json`.**
//      `readWikiReaderConfig` degrades a missing/malformed file to `null`, which
//      for an ontology is right and for a write guard means "degrade to
//      writable" — silently. The file carries cosmetics (`include`); the
//      environment carries safety.
//   3. **An entry matching no registered wiki fails CLOSED for that entry** — it
//      simply names a root nothing writes, leaving every real entry enforced.
//      The mismatch is still worth a warn (someone edited one var and not the
//      other), but the warn is a diagnostic, never the guard.
//
// Paths go through `resolveConfiguredPath` — the SAME `~`-expansion +
// repo-root resolution `WIKI_EXTRA` and `SYNC_REPOS` use — because re-spelling
// that in a second module is precisely how two path dialects drift apart.

import path from "node:path";
import { realpathSync } from "node:fs";
import { wikiReadonlyRootsFromEnv } from "../config.ts";
import { resolveConfiguredPath } from "./registry.ts";

/** The env var name, so error copy, docs and the `/models` machine card agree. */
export const WIKI_READONLY_ROOTS_ENV = "WIKI_READONLY_ROOTS";

/** Trailing-separator-free, `.`/`..`-free form of an absolute path. The registry
 *  and this list are both written by hand, so `~/.claude/projects/` and
 *  `~/.claude/projects` must not be two different roots. */
function normalizeRoot(p: string): string {
  const n = path.normalize(p);
  return n.length > 1 && n.endsWith(path.sep) ? n.slice(0, -1) : n;
}

/**
 * The symlink-resolved form, or null when the path does not exist / is
 * unreadable. Carried ALONGSIDE the normalized form (never instead of it) for
 * two reasons: a root configured through a symlink must still match the registry
 * entry that named the real path (`wikiWriteQueueKey` takes the same precaution
 * for the same reason), and on a case-insensitive filesystem `realpathSync`
 * returns the canonical on-disk casing — which is what makes a case-only
 * difference match there and correctly NOT match on a case-sensitive one.
 */
function realRoot(p: string): string | null {
  try {
    return normalizeRoot(realpathSync(p));
  } catch {
    return null;
  }
}

/** Every spelling of one configured root we are willing to match on. */
function rootForms(resolved: string): string[] {
  const norm = normalizeRoot(resolved);
  const real = realRoot(norm);
  return real && real !== norm ? [norm, real] : [norm];
}

/**
 * Do these two paths name the same wiki root? Normalized on both sides (trailing
 * separator, `.`/`..`) and, only when that fails, realpath-resolved on both — so
 * `/tmp/w` and `/private/tmp/w` are one root, exactly as `isReadonlyWikiRoot`
 * already treats them.
 *
 * It exists because a SECOND, normalize-only comparison shipped in the registry
 * builder and produced a false "matches no registered wiki root" warn for every
 * symlinked root — i.e. the diagnostic contradicted the guard it describes on
 * macOS, where `/tmp` is a symlink. One implementation, used by both.
 */
export function sameWikiRoot(a: string, b: string): boolean {
  const na = normalizeRoot(a);
  const nb = normalizeRoot(b);
  if (na === nb) return true;
  return (realRoot(na) ?? na) === (realRoot(nb) ?? nb);
}

/**
 * Parse a raw `WIKI_READONLY_ROOTS` value into resolved absolute roots, in
 * order, deduped. Pure apart from `resolveConfiguredPath`'s `path.resolve`;
 * blank entries are skipped silently (a trailing comma is not a mistake worth a
 * warn).
 *
 * Exported so the parse can be driven from an explicit string — which is what
 * both non-production callers need: the tests, and any future surface that wants
 * to show what a value WOULD resolve to. Production always goes through
 * {@link readonlyWikiRoots}, which memoizes this over the env.
 */
export function parseReadonlyWikiRoots(raw: string | undefined, repoRoot?: string): string[] {
  const out: string[] = [];
  for (const rawEntry of (raw ?? "").split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const resolved = normalizeRoot(resolveConfiguredPath(entry, repoRoot));
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/** Test override for the whole set. `undefined` ⇒ read the env. */
let rootsTestOverride: string[] | undefined;
/** Memoized env parse — the value is process-static, and the realpath probes are
 *  filesystem calls we do not want on every write. Dropped by the test setter. */
let cachedRoots: { list: string[]; forms: Set<string> } | null = null;

function currentRoots(): { list: string[]; forms: Set<string> } {
  if (rootsTestOverride) {
    const list = rootsTestOverride.map(normalizeRoot);
    return { list, forms: new Set(list.flatMap(rootForms)) };
  }
  if (!cachedRoots) {
    const list = parseReadonlyWikiRoots(wikiReadonlyRootsFromEnv());
    cachedRoots = { list, forms: new Set(list.flatMap(rootForms)) };
  }
  return cachedRoots;
}

/** The configured read-only roots, resolved. Surfaced on the `/models` Machine
 *  card so the drift between this var and `WIKI_EXTRA` is readable without
 *  issuing a POST. */
export function readonlyWikiRoots(): string[] {
  return [...currentRoots().list];
}

/**
 * Is this wiki root registered read-only? The seam predicate — `(root) => bool`.
 * An UNKNOWN root is writable (the default), so adding the mechanism changes
 * nothing until a root is named.
 */
export function isReadonlyWikiRoot(root: string | undefined | null): boolean {
  if (!root) return false;
  const { forms } = currentRoots();
  if (forms.size === 0) return false;
  const norm = normalizeRoot(root);
  if (forms.has(norm)) return true;
  const real = realRoot(norm);
  return !!real && forms.has(real);
}

/**
 * The per-wiki refusal sentence. Deliberately NOT `WIKI_READONLY_REASON`, which
 * hard-codes `MUNINN_WIKI_READONLY=1` and would tell a reader on a write-owning
 * instance something false about the whole instance.
 *
 * **It names no filesystem path.** This string is returned as the seam outcome's
 * `reason` and lands verbatim in an HTTP 403 body, so interpolating the root
 * published `/Users/<user>/.claude/projects` on a reader-facing API — the same
 * mistake `models-overview.ts` documents for `wikis[].root` and `base_url`. The
 * `root` argument is kept because every seam has it in hand and a future
 * log-only variant will want it; the ROUTE knows the wiki's NAME and is free to
 * add it.
 */
export function wikiReadonlyRootReason(root: string): string {
  void root;
  return `this wiki is registered read-only (${WIKI_READONLY_ROOTS_ENV}) — muninn only reads it, it is never written from here`;
}

/**
 * The per-wiki refusal for a route that spends a MODEL CALL (or reaches the web,
 * or seeds a chat thread) on the wiki's content rather than writing it. Separate
 * copy because "read-only" reads as "you can still ask questions about it", and
 * on this root that is exactly what must not happen.
 *
 * A blank name is the `WIKI_DIR` env-override shape — a bare `/wiki` served from
 * a root that belongs to no registry entry — so the sentence drops the quoted
 * name rather than rendering `the "" wiki`.
 */
export function wikiNoEgressReason(wikiName: string): string {
  const subject = wikiName.trim() ? `the "${wikiName.trim()}" wiki is` : "this wiki is";
  return `${subject} registered read-only (${WIKI_READONLY_ROOTS_ENV}) — its pages are never sent to a model or to the web`;
}

/** Force the read-only root set for a test; no argument restores env resolution
 *  (and drops the memo, so a test that set the env var is honoured).
 *
 *  It deliberately does NOT drop `registry-memo.ts`'s cached registry: this
 *  module is imported BY that one (and by the store and the page writer), and the
 *  whole reason the guard is keyed on the root rather than the registry name is
 *  to keep `bots/config.ts` → `db/` out of those import graphs. A test that needs
 *  a re-derived registry calls `__resetWikiRegistryForTest()` beside this — which
 *  is what every such test already does, since `WIKI_EXTRA` has the same
 *  requirement. */
export function __setReadonlyWikiRootsForTest(roots?: string[]): void {
  rootsTestOverride = roots;
  cachedRoots = null;
}
