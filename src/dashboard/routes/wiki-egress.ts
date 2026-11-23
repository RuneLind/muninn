/**
 * The per-wiki egress prologue, shared by the wiki route files. Moved out of
 * `wiki-routes.ts` so a route in its own file (`wiki-discuss.ts`) carries the
 * same check without importing the routes factory.
 */
import type { Context } from "hono";
import { getLog } from "../../logging.ts";
import { isReadonlyWikiRoot, wikiNoEgressReason } from "../../wiki/readonly.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { resolveWikiRoot } from "../../wiki/store.ts";

const log = getLog("dashboard", "wiki");

/**
 * The root a request would actually be SERVED from, for the read-only question —
 * or `null` when the request names no servable wiki at all.
 *
 * The distinction is the whole point. `resolveWikiRequest` answers
 * `entry: undefined` for TWO unrelated requests: the `WIKI_DIR` env-override
 * shape (no `?wiki=`/`?bot=` given), which the routes really do serve from
 * `resolveWikiRoot(undefined)` and which therefore MUST be guarded — and an
 * unknown name, which they serve not at all. Folding them together made a typo
 * inherit the env root's policy: `?wiki=typo` answered 403 "this wiki is
 * read-only" about a wiki nobody asked for, and `/wiki?wiki=typo` rendered the
 * banner and the disabled inputs to match. An unknown name keeps its own
 * preflight error, which every one of these routes already has.
 */
export function readonlyCandidateRoot(
  entry: WikiRegistryEntry | undefined,
  unknownWiki: boolean,
): string | null {
  if (entry) return entry.root;
  return unknownWiki ? null : resolveWikiRoot(undefined);
}

/**
 * The PER-WIKI egress prologue: refuse, with a 403, every route that would spend
 * a model call (or reach the live web, or seed a chat thread) on a wiki whose
 * root is listed in `WIKI_READONLY_ROOTS`.
 *
 * **Why this is a separate guard from `readonlyRefusal`.** That one is
 * instance-wide and runs as a route's FIRST statement, before any wiki is
 * resolved — deliberately, so the refusal costs nothing. A per-wiki rule inverts
 * that ordering by construction: it cannot answer until the entry is known. So
 * it is a prologue placed immediately after `resolveWikiRequest` (or after the
 * shared target resolver, where one exists) and BEFORE bot resolution, the index
 * read, the DB thread, the `/agents` run registration and the one-shot.
 *
 * **Why registration alone is not safe.** Registering a root as a browsable wiki
 * buys three surfaces, not two: file writes (the three seams), local reads
 * (bounded by `DASHBOARD_HOST=127.0.0.1`) — and this set of `?wiki=`-steerable
 * routes, two of which reach the live web through the fact-check prompt's
 * WebFetch/search instructions. `DASHBOARD_HOST` does not bound that, and a
 * bot-less standalone wiki does NOT fail bot resolution: `resolveWikiSynthesisBot`
 * falls through to `resolveResearchBot` for any entry with no pin and
 * `source !== "bot"`, so every one of these routes resolves a bot and runs.
 *
 * Enforcement reads the ROOT, never `entry.readonly` — the registry flag is
 * presentation, and a stale memo must not be able to open the guard.
 *
 * **And it reads the root even when there is no ENTRY.** `resolveWikiRequest`
 * returns `entry: undefined` for the `WIKI_DIR` env-override shape (a bare
 * `/wiki` on an instance that sets the var), and those routes go on to serve
 * `resolveWikiRoot(undefined)` — so keying the refusal on the entry made the
 * guard fail OPEN on exactly the root an operator pointed the env var at. The
 * fallback resolves the same root the store would, through the same function.
 *
 * `optionalResponder` exists for `/api/wiki/digest`, whose refusal body is not
 * the shared `{error}` shape (the What's-new card reads `error` as "generation
 * FAILED — keep the old digest and offer a retry", and a policy refusal is not a
 * failure). It gets the resolved wiki label so its own body can name it, rather
 * than re-spelling the resolution and drifting from this one.
 */
export function egressRefusal(
  c: Context,
  entry: WikiRegistryEntry | undefined,
  unknownWiki: boolean,
  optionalResponder?: (wikiLabel: string, reason: string) => Response,
) {
  const root = readonlyCandidateRoot(entry, unknownWiki);
  if (root === null || !isReadonlyWikiRoot(root)) return null;
  const wiki = entry?.name ?? "";
  log.info("Read-only wiki {wiki} refused {method} {path} (no model calls)", {
    // Only the no-name shapes reach this label (a NAMED wiki either resolved to
    // an entry or was refused nothing at all), and there are two of them: the
    // env override, and an install with no registered wiki at all.
    wiki: wiki || (process.env.WIKI_DIR?.trim() ? "(WIKI_DIR override)" : "(default root)"),
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  });
  const reason = wikiNoEgressReason(wiki);
  if (optionalResponder) return optionalResponder(wiki, reason);
  return c.json({ error: reason, readonly: true }, 403);
}
