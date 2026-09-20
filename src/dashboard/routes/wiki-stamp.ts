/**
 * `POST /api/wiki/provenance/stamp` — record a session on a wiki page's
 * `sessions:` line.
 *
 * **This file exports one thing another route uses**: {@link decideStampRequest},
 * the same-origin write guard, which `POST /api/wiki/series` calls too. Its own
 * docblock carries the rules; what matters here is that editing them edits two
 * routes.
 *
 * **muninn writes no frontmatter line here.** There is exactly ONE line-upsert
 * implementation and it lives in claude-usage (`src/wiki-stamp.ts`, driven by
 * `scripts/wiki-stamp.ts`); the Claude Code `PostToolUse` hook and the opencode
 * plugin call it today, and this route is its third caller. Two writers of one
 * frontmatter line lose each other's appends, which is what the cross-process
 * lockfile (`src/wiki/lockfile.ts`, which the CLI takes too) exists to prevent —
 * and a second implementation here would be exactly that second writer.
 *
 * So the spawn is the HOOK'S OWN command line plus `--report`:
 *
 *     <WIKI_STAMP_BUN|bun> <WIKI_STAMP_BIN> --session <ref> --file <abs> --report
 *
 * with `WIKI_STAMP_ROOTS` handed down in the child environment. `--report` is
 * the CLI's answer channel: ONE JSON line on stdout, last. Without it the CLI
 * prints nothing and always exits 0 (its own banner invariant), so the exit code
 * is information HERE only when there is no report line at all.
 *
 * ── The checks, in order, each before any spawn ──────────────────────────────
 *  0. The request itself: `content-type: application/json` and the route-local
 *     origin check — see "Zones and CSRF" below.
 *  1. `ref` against `SESSION_REF_RE` ⇒ 400. SHAPE only; the CLI stays the
 *     authority on MEANING (which providers it stamps, which roots it covers).
 *     Copied from `claude-usage/src/wiki-stamp.ts` rather than shared, for
 *     `stamp-roots.ts`'s reason: the repos cannot import each other.
 *  2. `wiki`, when present, must be a STRING. A number or an object used to fall
 *     through the `typeof` read as `""` and silently target the DEFAULT wiki —
 *     a write to a page the caller never named.
 *  3. `relPath` through `isPathConfined` — the exact form `writeWikiPage` uses,
 *     `existingRelPath` included, because without it the helper refuses every
 *     page outside `expectedDir(domain, kind)`, which is nearly every page a
 *     reader has open. Outside the root ⇒ 400.
 *  4. REALPATH containment. `isPathConfined` is lexical, so a symlink inside the
 *     wiki pointing outside it passes: measured, `<root>/link.md -> /tmp/x.md`
 *     reached the CLI. Both sides are resolved the way the CLI resolves them
 *     (`realOf`: the directory always, the file itself when it is a link) and
 *     the RESOLVED path is what is handed down, so muninn's gate and the CLI's
 *     classification are asking about the same file. Escape ⇒ 400. A page whose
 *     DIRECTORY is not on disk is NOT an escape: it resolves as far as the
 *     filesystem allows and goes to the CLI, which answers `missing-file` ⇒ 409.
 *     See {@link realPageOf}.
 *  5. `isWikiReadonly()` / `isReadonlyWikiRoot()` ⇒ 403. AFTER the confinement,
 *     unlike `writeWikiPage` (which checks read-only first): deliberate, so a
 *     traversal never reaches the read-only test with an unresolved root.
 *  6. `WIKI_STAMP_BIN` / `WIKI_STAMP_ROOTS` unset ⇒ 501 naming the variable.
 *     Below the 403, because an instance that must not write is unwritable
 *     however it is configured.
 *  7. `isStampRoot` — the wiki root must BE a stamp root, not merely live under
 *     one. 409 `not-a-stamp-root`. This is the server side of the rule the
 *     payload's `stampable` reports: without it a wiki registered at
 *     `<stamproot>/sub` answered `200 written` while the same response said
 *     `stampable: false`, which is the two-writers/two-lockfiles lost-append
 *     `stamp-roots.ts` exists to prevent. A 409 rather than a 403: the request
 *     is well-formed and permitted, the instance's configuration is what refuses
 *     it, and the client already renders a `reason` verbatim.
 *
 * ── Zones and CSRF ──────────────────────────────────────────────────────────
 * The route is ADMIN-ZONE by muninn's default-deny — it has no `zones.ts` entry,
 * which is what "admin only" is spelled as — and it is a POST, so the global
 * side-effect check in `auth/origin.ts` covers it **in an authenticating mode**.
 *
 * With `MUNINN_AUTH=off` it covers NOTHING: `src/index.ts` mounts the auth,
 * origin and zone middlewares only when `isAuthenticatingMode(auth.mode)`, and
 * `off` is the one instance shape that can actually write. Measured against a
 * live `off` server: a page on another origin appended a ref with
 * `fetch(url, {mode: "no-cors", headers: {"content-type": "text/plain"}})`,
 * which needs no preflight. So this route carries its OWN check, independent of
 * the mode — see {@link decideStampRequest}. It does not replace the global one
 * (which stays the enforcement point in `local`/`entra`); it closes the hole
 * under `off`. **The other muninn write routes share this exposure and are out
 * of scope here** — the class is a follow-up, stated on the PR.
 *
 * **No `baseHash` crosses the wire.** The append is idempotent (`already-stamped`
 * is an `unchanged` report) and the CLI holds the same per-root lock muninn's own
 * writers take across its whole read-modify-write, so there is nothing for a hash
 * to protect. That is only true while `stampable` is EQUALITY on the wiki root —
 * see `stamp-roots.ts`.
 */

import type { Hono } from "hono";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { getWikiIndex, resolveWikiRoot } from "../../wiki/store.ts";
import { isPathConfined } from "../../gardener/draft.ts";
import {
  isReadonlyWikiRoot,
  isWikiReadonly,
  wikiReadonlyRootReason,
  WIKI_READONLY_REASON,
} from "../../wiki/readonly.ts";
import {
  isStampRoot,
  stampConfigFromEnv,
  WIKI_STAMP_BIN_ENV,
  WIKI_STAMP_ROOTS_ENV,
  WIKI_STAMP_TIMEOUT_MS,
  type StampConfig,
} from "../../wiki/stamp-roots.ts";
import { pageProvenance, type ProvenanceContext } from "../../wiki/provenance-service.ts";
import { ProcTimeoutError, runProc } from "../../utils/run-proc.ts";
import { getLog } from "../../logging.ts";

const log = getLog("wiki", "stamp");

/** The route's seams. Every one of them is read at REQUEST time — an operator
 *  can set the variables without a restart, and a test drives the CLI without
 *  the environment. */
export interface StampRouteDeps {
  stampConfig?: () => StampConfig;
  isReadonly?: () => boolean;
  isReadonlyRoot?: (root: string) => boolean;
  runProc?: typeof runProc;
  timeoutMs?: number;
}

/** What the CLI's `--report` line says. */
interface StampReport {
  outcome: "written" | "unchanged" | "skipped";
  reason?: string;
  /** The file the CLI acted on, in the CALLER's spelling (its `path`, not its
   *  `real`). Read back and compared — see the 502 in the handler. */
  path?: string;
}

/**
 * A session ref's SHAPE — `provider:id`, lowercase provider, and an id from a
 * character set that cannot break the inline YAML array the CLI writes.
 *
 * Copied verbatim from `claude-usage/src/wiki-stamp.ts`'s `SESSION_REF_RE`
 * (`PROVENANCE_KEYS.sessions.value`) — the same re-implementation, with the same
 * justification, as `parseStampRoots`: the two repos cannot import each other.
 * It is a PRE-CHECK, never an authority: the CLI validates the ref again and is
 * the only thing that decides whether a well-shaped ref may be written.
 *
 * What it buys: a `ref` the CLI would refuse never costs a spawn; a ref
 * containing a NUL no longer reaches `Bun.spawn`, which throws synchronously for
 * one and was reported as `stamp-timeout`; and a ref containing a newline can no
 * longer split this route's own success log line in two.
 */
const SESSION_REF_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,128}$/;

/** The child's WHOLE environment, by name. See {@link stampChildEnv}. */
export const STAMP_CHILD_ENV_NAMES: readonly string[] = ["PATH", "HOME", "TMPDIR"];

/**
 * The environment the stamp child is given: an ALLOWLIST, not `process.env`.
 *
 * `WIKI_STAMP_BIN` names a `.ts` file that this process runs through an
 * interpreter, and it is chosen by an environment variable — so the child is as
 * trusted as whoever set that variable, and no more. Spreading `process.env`
 * handed it everything muninn holds.
 *
 * **This docstring is the ONE place that measurement is written down**, and the
 * test and `src/wiki/CLAUDE.md` point here rather than counting again: the size
 * of `process.env` is a fact about one machine at one moment, and two
 * independent counts of it disagreed. Measured 2026-09-17 on the author's
 * laptop with the repo's own `.env` loaded: **119 names, seven of them
 * credential-shaped** — `DATABASE_URL`, two `TELEGRAM_BOT_TOKEN_*`, a
 * `SLACK_BOT_TOKEN_*`/`SLACK_APP_TOKEN_*` pair, `CLAUDE_CODE_OAUTH_TOKEN` and
 * `CLAUDE_CODE_MESSAGING_TOKEN`.
 *
 * The three inherited names are what the CLI needs to RUN: `PATH` so the
 * interpreter is findable (a child with none lands every Stamp in the 502 bucket
 * with an empty stderr), `HOME` because the CLI writes its skip record under the
 * user's own directory, and `TMPDIR` because `writeAtomic` needs somewhere to
 * put the sibling temp file on hosts that set it. `WIKI_STAMP_ROOTS` is added
 * verbatim — the operator's own value, since the CLI does its own parse.
 */
export function stampChildEnv(
  rootsRaw: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of STAMP_CHILD_ENV_NAMES) {
    const value = source[name];
    if (typeof value === "string" && value) env[name] = value;
  }
  env[WIKI_STAMP_ROOTS_ENV] = rootsRaw;
  return env;
}

/** What {@link decideStampRequest} answers. `null` means "let it through". */
export interface StampRequestRefusal {
  status: 403 | 415;
  error: string;
  reason: string;
}

/**
 * The route-local CSRF check — see the header for why the global one is not
 * enough under `MUNINN_AUTH=off`.
 *
 * Pure, so the table of header combinations is a unit test rather than a live
 * server. THREE rules, and each closes a different door:
 *
 *  1. `content-type` must be `application/json` (parameters allowed). A
 *     cross-origin `fetch` cannot set that header without a CORS preflight, and
 *     muninn answers no CORS headers under `off`, so the preflight fails and the
 *     POST is never sent. `text/plain` / `multipart/form-data` /
 *     `application/x-www-form-urlencoded` are the three a no-cors request MAY
 *     set, and a `<form>` POST is limited to the same set — all refused, 415.
 *     This is the same 415 `jira-routes.ts` mitigated its own measured
 *     cross-origin `text/plain` POST with.
 *  2. `Sec-Fetch-Site: cross-site` or `same-site` ⇒ 403. This is the header a
 *     browser attaches that a page cannot forge, and it catches the shapes rule
 *     1 does not (a navigation, a redirected POST).
 *  3. An `Origin` that is not this request's own authority ⇒ 403.
 *
 * **This function has TWO callers**: this route, and `POST /api/wiki/series`
 * (`wiki-series-routes.ts`, the series editor's write). Nothing here is
 * stamp-specific — it is the same-origin gate for any write route mounted where
 * the global middlewares are not — but the NAME is this route's, because this is
 * where it was first needed. A change to the three rules moves both.
 *
 * ⚠️ Rule 3 compares `Origin` against the request's own `Host`, which
 * `auth/origin.ts` explicitly REFUSES to do for the global middleware, and for a
 * good reason: it asks "does this request agree with itself" rather than "is
 * this my origin", so a DNS-rebound name the attacker owns satisfies it. That
 * argument holds here too and rule 3 is NOT the defence — rules 1 and 2 are.
 * Rule 3 is kept because it costs nothing and refuses the plain cross-origin
 * POST one step earlier, with a reason an operator can read. In an
 * authenticating mode the real origin allowlist has already run upstream of
 * this, against `MUNINN_ALLOWED_ORIGINS`; under `off` there is no allowlist
 * configured at all, which is exactly why this check cannot be one.
 *
 * **Rule 3 behind `tailscale serve`, MEASURED rather than reasoned about**
 * (2026-09-17, the author's laptop): the proxy passes `Host:` through
 * UNCHANGED as the tailnet name (`rune-macbook-pro-m4-max.tail7b311e.ts.net`),
 * adds `X-Forwarded-Host` carrying the same value and `X-Forwarded-Proto:
 * https`, and a browser on that page sends `Origin:
 * https://rune-macbook-pro-m4-max.tail7b311e.ts.net`. So `Origin` and `Host`
 * name the same authority and rule 3 passes as written — the scheme is the only
 * thing that differs, and {@link originMatchesHost} compares host+port only for
 * exactly this reason. Nothing here reads `X-Forwarded-*`: a forwarding header
 * is client-settable on a direct request, so trusting one would hand an attacker
 * the comparison. The proxied shape is a unit case in `wiki-stamp.test.ts`.
 */
export function decideStampRequest(req: {
  contentType?: string | null;
  secFetchSite?: string | null;
  origin?: string | null;
  host?: string | null;
}): StampRequestRefusal | null {
  const type = (req.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    return {
      status: 415,
      error: "this route accepts application/json only",
      reason: "unsupported-content-type",
    };
  }

  const site = (req.secFetchSite ?? "").trim().toLowerCase();
  if (site === "cross-site" || site === "same-site") {
    return { status: 403, error: "cross-origin request", reason: "cross-origin" };
  }

  const origin = (req.origin ?? "").trim();
  if (origin && !originMatchesHost(origin, req.host ?? "")) {
    return { status: 403, error: "cross-origin request", reason: "cross-origin" };
  }
  return null;
}

/** Does this `Origin` name the authority the request was addressed to? Compared
 *  on host+port only: a reverse proxy terminates TLS, so the browser's `https`
 *  scheme and muninn's own `http` say nothing about each other. */
function originMatchesHost(origin: string, host: string): boolean {
  let authority: string;
  try {
    // `Origin: null` (a sandboxed iframe, a redirected cross-origin POST) does
    // not parse as a URL and is refused here, which is the right answer.
    authority = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return authority !== "" && authority === host.trim().toLowerCase();
}

/**
 * A directory resolved as far as the filesystem allows: the deepest ancestor
 * that IS on disk, with the spelled tail re-appended.
 *
 * `realpathSync` is all-or-nothing — one missing segment and it throws — but a
 * page under a directory that does not exist is a TYPO, not a traversal, and
 * the two must not answer the same way. Walking up gives a path that is still
 * anchored in resolved bytes, so {@link within} keeps comparing like with like:
 * on macOS a wiki under `/var/folders/…` really lives at `/private/var/…`, and
 * classifying the spelled `/var/…` form (which is what the CLI's own `realOf`
 * falls back to) would refuse the page for being outside its own root.
 *
 * The loop terminates: `path.dirname` is strictly shorter until it reaches the
 * filesystem root, where `dirname(x) === x` returns the path as spelled.
 */
function realDirOf(dir: string): string {
  const missing: string[] = [];
  let here = dir;
  for (;;) {
    try {
      return path.join(realpathSync(here), ...missing);
    } catch {
      const parent = path.dirname(here);
      if (parent === here) return dir;
      missing.unshift(path.basename(here));
      here = parent;
    }
  }
}

/**
 * The page's path with symlinks resolved.
 *
 * MIRRORS `claude-usage/src/wiki-stamp.ts`'s `realOf` — the directory always,
 * plus the file itself when it is a symlink — because the two gates have to
 * classify the same bytes. Resolving only the directory left
 * `<root>/page.md -> /elsewhere/secret.md` inside the root by every lexical
 * test, and the CLI's own `writeAtomic` renames over the link, which REPLACES it
 * with a regular file: the link destroyed and an outside page copied in.
 *
 * **It never gives up on a path.** An earlier cut returned `null` when the
 * page's DIRECTORY was not on disk, which the caller turned into
 * `400 outside-root` — so a typo'd folder read as a traversal attempt. The CLI
 * keeps the spelled path and lets `existsSync` answer `missing-file`; this does
 * the same thing through {@link realDirOf}, so a typo lands on `409
 * missing-file` with the CLI as the authority on "no such page". Resolving MORE
 * than the CLI does is the safe direction: every segment that exists is
 * resolved before {@link within} judges it, and the missing tail carries no
 * `..` — `isPathConfined` has already refused those.
 */
function realPageOf(abs: string): string {
  const here = path.join(realDirOf(path.dirname(abs)), path.basename(abs));
  try {
    if (lstatSync(here).isSymbolicLink()) return realpathSync(here);
  } catch {
    // Absent, dangling or unreadable. The path as resolved so far is what gets
    // classified; the CLI answers `missing-file` for it.
  }
  return here;
}

/** Is `child` the root itself or under it? Both sides already resolved. */
function within(root: string, child: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The LAST stdout line, parsed as the report, or null.
 *
 * Last rather than first: `WIKI_STAMP_BIN` is a `.ts` source run through an
 * interpreter, and an interpreter is free to print a warning of its own before
 * the program does. Anything that is not a JSON object with a known `outcome` is
 * not a report — a 502 saying "the CLI answered nothing I can read" is the
 * honest outcome, and guessing from the exit code is how a silent failure
 * becomes a green Stamp.
 */
function parseReport(stdout: string): StampReport | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const outcome = (parsed as { outcome?: unknown }).outcome;
    if (outcome !== "written" && outcome !== "unchanged" && outcome !== "skipped") continue;
    const reason = (parsed as { reason?: unknown }).reason;
    const reported = (parsed as { path?: unknown }).path;
    return {
      outcome,
      ...(typeof reason === "string" && reason ? { reason } : {}),
      ...(typeof reported === "string" && reported ? { path: reported } : {}),
    };
  }
  return null;
}

/** The first line of stderr — enough to say WHICH failure, without shipping a
 *  stack trace onto a reader's page. */
function firstLine(stderr: string): string {
  return stderr.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/**
 * Refusal reasons that have already warned. See {@link logRefusal}.
 *
 * ⚠️ The keys come from a CLOSED set — the two `reason` strings
 * {@link decideStampRequest} returns — the `introspect.ts` rule: this Set never
 * sweeps, so a key carrying a caller-supplied value would be a memory-growth
 * path an unauthenticated caller drives.
 */
const warnedRefusals = new Set<string>();

/**
 * One `warn` per refusal REASON, then `info`.
 *
 * Every refusal used to mint a `warn`. The refusals are exactly the ones a
 * cross-origin page reaches (that is what the check is FOR), and nothing rate-
 * limits it. What this changes is the CONSOLE: a loop on another origin no
 * longer paints a warning per POST. It does NOT reduce the JSONL sink's volume
 * — the file sink writes `info` too (`src/logging.ts`, `lowestLevel: "info"`),
 * so it still gets one line per refused POST (measured 2026-09-17: 120 POSTs,
 * 114 lines). A request-rate cap for refused writes is a follow-up shared with
 * every muninn write route that is reachable under `MUNINN_AUTH=off`;
 * `ws-upgrade.ts` and `introspect.ts` return WITHOUT logging, which is a
 * different discipline from this one.
 */
function logRefusal(reason: string): void {
  if (warnedRefusals.has(reason)) {
    log.info("wiki-stamp refused a request: {reason}", { reason });
    return;
  }
  warnedRefusals.add(reason);
  log.warn("wiki-stamp refused a request: {reason}", { reason });
}

/** Test-only: forget which refusal reasons have already warned. */
export function __resetStampRefusalWarnsForTest(): void {
  warnedRefusals.clear();
}

export function registerWikiStampRoute(
  app: Hono,
  ctx: ProvenanceContext,
  deps: StampRouteDeps = {},
): void {
  app.post("/api/wiki/provenance/stamp", async (c) => {
    // 0. The request itself, before the body is even read. See the header:
    //    under `MUNINN_AUTH=off` nothing upstream of this handler runs.
    const refusal = decideStampRequest({
      contentType: c.req.header("content-type"),
      secFetchSite: c.req.header("sec-fetch-site"),
      origin: c.req.header("origin"),
      host: c.req.header("host"),
    });
    if (refusal) {
      logRefusal(refusal.reason);
      return c.json({ error: refusal.error, reason: refusal.reason }, refusal.status);
    }

    const body = (await c.req.json().catch(() => null)) as {
      wiki?: unknown;
      relPath?: unknown;
      ref?: unknown;
    } | null;
    // `wiki` PRESENT but not a string is a 400, never a silent fall-through to
    // `""`: `""` means "the default wiki", so a caller that sent `{"wiki": 3}`
    // was writing to a page in a wiki it never named. Absent is still the
    // default-wiki case, which is what a reader on a bare `/wiki` sends.
    if (body?.wiki !== undefined && typeof body.wiki !== "string") {
      return c.json({ error: "wiki must be a string" }, 400);
    }
    const wiki = typeof body?.wiki === "string" ? body.wiki.trim() : "";
    const relPath = typeof body?.relPath === "string" ? body.relPath.trim() : "";
    const ref = typeof body?.ref === "string" ? body.ref.trim() : "";
    if (!relPath || !ref) {
      return c.json({ error: "relPath and ref are required" }, 400);
    }
    // 1. Shape only. See `SESSION_REF_RE`.
    if (!SESSION_REF_RE.test(ref)) {
      return c.json({ error: "ref is not a session ref", reason: "bad-ref" }, 400);
    }

    // The SAME resolution every other `/api/wiki/*` route makes, so an omitted
    // `wiki` means the default wiki here too — which is what a reader browsing a
    // bare `/wiki` has to send, since the client holds no name for it.
    const { entry, envOverride, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      wiki || undefined,
      undefined,
      process.env.WIKI_DIR,
    );
    if (unknownWiki) return c.json({ error: "no wiki configured for that name" }, 404);
    // `resolveWikiRequest` returns NO entry for the `WIKI_DIR` env-override
    // shape — `{envOverride: true, entry: undefined, unknownWiki: false}` — so a
    // guard keyed on the entry answered "no wiki configured for that name" on an
    // instance where no name was sent and one wiki is perfectly well configured.
    // `resolveWikiRoot(undefined)` is what the READ routes resolve through
    // (`getWikiIndex` calls it), so the Stamp lands on the page the reader is
    // looking at rather than 404ing beside it.
    const root = entry?.root ?? (envOverride ? resolveWikiRoot(undefined) : null);
    if (!root) return c.json({ error: "no wiki configured for that name" }, 404);
    const wikiName = entry?.name ?? "";

    // 2. Confinement. The `existingRelPath` form: this route only ever stamps a
    //    page that already exists, so the "update" branch is the right one, and
    //    the create branch would refuse every page outside `ai/concepts/`.
    if (
      !isPathConfined({
        targetPath: relPath,
        wikiDir: root,
        domain: "ai",
        kind: "concept",
        existingRelPath: relPath,
      })
    ) {
      return c.json({ error: `path confinement failed for "${relPath}"` }, 400);
    }

    // 3. Realpath containment. `isPathConfined` is LEXICAL; this is the one that
    //    sees through a symlink. The resolved path is also what the CLI is
    //    handed, so nothing downstream re-derives it from `relPath`.
    const absPath = path.join(root, relPath);
    const realRoot = ((): string | null => {
      try {
        return realpathSync(root);
      } catch {
        return null;
      }
    })();
    const realPath = realPageOf(absPath);
    if (!realRoot || !within(realRoot, realPath)) {
      return c.json(
        { error: `path confinement failed for "${relPath}"`, reason: "outside-root" },
        400,
      );
    }

    // 4. Read-only, instance then root — the same two guards `writeWikiPage`
    //    takes, in the same order, refusing the same way.
    if ((deps.isReadonly ?? isWikiReadonly)()) {
      return c.json({ error: WIKI_READONLY_REASON }, 403);
    }
    if ((deps.isReadonlyRoot ?? isReadonlyWikiRoot)(root)) {
      return c.json({ error: wikiReadonlyRootReason(root) }, 403);
    }

    // 5. Is there a stamper at all?
    const config = (deps.stampConfig ?? stampConfigFromEnv)();
    if (!config.bin) {
      return c.json({ error: `${WIKI_STAMP_BIN_ENV} is not set on this instance` }, 501);
    }
    if (!config.rootsRaw) {
      return c.json({ error: `${WIKI_STAMP_ROOTS_ENV} is not set on this instance` }, 501);
    }

    // 6. The root-equality rule, SERVER-SIDE. `stampable` in the payload is the
    //    same predicate and is what hides the button; it is a hint to a client,
    //    never a guard. Without this, a wiki registered at a strict subdirectory
    //    of a stamp root answered `200 written` while the same instance's
    //    payload said `stampable: false` — two writers of one frontmatter line,
    //    holding two different lock files. See `stamp-roots.ts`.
    if (!isStampRoot(root, config.roots)) {
      return c.json(
        {
          error: "this wiki's root is not one of WIKI_STAMP_ROOTS",
          reason: "not-a-stamp-root",
        },
        409,
      );
    }

    let proc;
    try {
      proc = await (deps.runProc ?? runProc)(
        [config.bun, config.bin, "--session", ref, "--file", realPath, "--report"],
        deps.timeoutMs ?? WIKI_STAMP_TIMEOUT_MS,
        "wiki-stamp",
        // An ALLOWLIST, never `{...process.env}` — see `stampChildEnv`.
        { env: stampChildEnv(config.rootsRaw) },
      );
    } catch (err) {
      // TWO different failures, and collapsing them sent an operator looking for
      // a wedged child that never existed. The CLI bounds ITSELF at 5 s and
      // reports `lock-timeout`/`deadline` from inside that budget, so reaching
      // muninn's own bound means it never got to answer. Anything else thrown
      // here came out of `Bun.spawn` — an argv it could not build, an
      // interpreter it could not execute — and is a 502, the same bucket as a
      // CLI that answered something unreadable.
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ProcTimeoutError) {
        log.warn("wiki-stamp did not return: {error}", { error: message });
        return c.json({ error: "the stamp CLI did not return", reason: "stamp-timeout" }, 409);
      }
      log.warn("wiki-stamp could not be spawned: {error}", { error: message });
      return c.json({ error: message, exitCode: null }, 502);
    }

    const report = parseReport(proc.stdout);
    if (!report) {
      return c.json(
        {
          error: "the stamp CLI printed no report line",
          exitCode: proc.exitCode,
          stderr: firstLine(proc.stderr),
        },
        502,
      );
    }
    if (report.outcome === "skipped") {
      return c.json({ error: "the stamp was skipped", reason: report.reason ?? "skipped" }, 409);
    }
    // The CLI reports the file it acted on, in the spelling it was given. It was
    // given `realPath` and nothing else, so anything different means the two
    // sides do not agree about WHICH page was just written — which is the one
    // thing this route must never report as a success. Absent is tolerated: an
    // older CLI printed no `path`, and refusing it would be muninn deciding the
    // CLI's report format.
    if (report.path !== undefined && path.normalize(report.path) !== path.normalize(realPath)) {
      log.warn("wiki-stamp reported another path: {reported} for {asked}", {
        reported: report.path,
        asked: realPath,
      });
      return c.json(
        {
          error: "the stamp CLI reported a different path",
          exitCode: proc.exitCode,
          reason: "path-mismatch",
        },
        502,
      );
    }

    // A WRITTEN report changed the frontmatter, and `pageProvenance` reads
    // `sessions:` off the TTL-cached index — so the refresh runs BEFORE the
    // re-resolve, exactly as `defaultPageWriteIo` does for muninn's own writes.
    // Without it the cache answers the pre-stamp list and the row stays amber:
    // the inert-fix shape, green in every test that does not open the page.
    if (report.outcome === "written") await getWikiIndex({ root, refresh: true });
    const index = await getWikiIndex({ root });
    const meta = index?.resolveRelPath(relPath);
    const provenance = meta ? await pageProvenance(meta, ctx, root) : null;
    // `wikiName`, not the raw body's `wiki`: the body carries whatever the client
    // sent (an alias, a bot name, or nothing at all on the default wiki), and a
    // log line naming that cannot be joined to anything.
    log.info("wiki-stamp {outcome} {ref} on {wiki}/{relPath}", {
      outcome: report.outcome,
      ref,
      wiki: wikiName,
      relPath,
    });
    return c.json({ outcome: report.outcome, ...(provenance ? { provenance } : {}) });
  });
}
