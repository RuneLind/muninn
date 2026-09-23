/**
 * The `worked` axis — when an AGENT SESSION last wrote a wiki page, read out of
 * claude-usage's `session_files` ledger.
 *
 * The fourth server-side proxy of that service, and it shares the ONE fetch
 * helper with the other three (`utils/claude-usage-fetch.ts`): the BROWSER never
 * reaches claude-usage, because the dashboard is viewed over the tailnet where a
 * client-side loopback fetch hits the viewer's own machine and a cross-host one
 * is mixed content under `tailscale serve`. So the listing carries `workedMs`
 * from muninn, and the reader's browser never learns the ledger's address.
 *
 * ── Why a memo, refreshed in the BACKGROUND and never awaited ────────────────
 * `buildWikiIndex` folds in whatever is warm. A page load must not inherit a
 * tailnet service's latency, so the index never waits on this — and because the
 * index is itself TTL-cached at 5 minutes, a refresh that lands mid-TTL does not
 * appear until the next rebuild. Two TTLs in phase is the price of not awaiting;
 * the kick at server boot (`src/index.ts`) is what keeps the cold window to the
 * first index build rather than to the first reader.
 *
 * ── What "absent" means, and why it is a first-class answer ──────────────────
 * Upstream discounts a session WHOLE when it wrote `bulk` (10) or more pages
 * under the root, so a page whose every write came from a bulk pass is simply
 * not in the answer. That is the same honest absence `gitTouchedMs` has for a
 * page whose every commit was a sweep — the axis says nothing rather than
 * reporting the sweep's date. The sort mode falls back per page; nothing is
 * invented.
 *
 * ── The un-upgraded upstream, which answers 200 with the WRONG body ──────────
 * A claude-usage before its `?summary=1` release ignores the parameter and
 * answers the raw `{root, sessions, total, rows, limit, offset}` row form —
 * ~800 KB, well inside this module's 10 s / 8 MiB bounds, so nothing times out
 * and nothing overflows. A body with no `pages` array is therefore REJECTED by
 * name ("does not answer the summary form yet") rather than read as a wiki
 * nobody has written, and every warn names the base URL so the operator's first
 * question — which host is this pointed at — is already answered.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { CLAUDE_USAGE_DEFAULT_URL } from "../dashboard/claude-usage-overview.ts";
import { getLog } from "../logging.ts";
import { BOUNDED_FETCH_MAX_BYTES, BOUNDED_FETCH_TIMEOUT_MS } from "../utils/bounded-fetch.ts";
import {
  claudeUsageHttpStatus,
  claudeUsageJson,
  claudeUsageWarnOnce,
} from "../utils/claude-usage-fetch.ts";
import { normalizeRelPath } from "./rel-path.ts";

const log = getLog("wiki", "worked-ledger");

type Logger = ReturnType<typeof getLog>;

/** What one refreshed root holds. `pages` is keyed on the NORMALIZED
 *  wiki-relative path (`normalizeWorkedPath`), so the store looks a page up with
 *  the same spelling it stores its own relPath in. */
export interface WorkedLedgerMemo {
  pages: Map<string, number>;
  /** When this answer arrived — the TTL the index's own kick compares against. */
  fetchedAt: number;
  /** How many rows upstream sent. The DENOMINATOR of the match rate: an absolute
   *  count of unmatched rows carries no signal, because a healthy refresh leaves
   *  rows for every page since renamed or deleted. */
  returned: number;
  /** The base URL this answer came from — what the store's rate warn names. */
  baseUrl: string;
  /** The `?root=` spelling that answered (see {@link refreshWorkedLedger}). Asked
   *  FIRST on every later refresh of this root, so a wiki registered through a
   *  symlink pays the second call and the `realpath` once rather than per poll. */
  rootAsked: string;
  /** Upstream clipped its own answer at `limit` rows. Upstream orders by `w`,
   *  so the clip drops the pages with the OLDEST write (a recent `b` does not
   *  save one), and the axis silently shortens — the match rate cannot see it,
   *  because every row that did arrive still matches. */
  truncated: boolean;
}

/** The one call this module makes, injectable so every test drives the real
 *  parse/match/warn path without a network or a `mock.module`. */
export interface WorkedLedgerDeps {
  /** `GET /api/files?root=<abs>&summary=1`. MUST reject on timeout / non-200 /
   *  over-cap / malformed JSON, exactly as `claudeUsageJson` does. */
  fetchPages: (root: string, signal?: AbortSignal) => Promise<unknown>;
  /** Did the operator NAME a claude-usage? Unset ⇒ no fetch at all — the
   *  `/models` card's "left unset and unreachable, hide it" rule one layer down.
   *  An instance nobody pointed at a ledger must not pay a connection refusal on
   *  every index build. */
  urlConfigured: boolean;
  baseUrl: string;
  /** Where the degrades go. Defaults to this module's own logger; injected by
   *  tests, because an UNCONFIGURED logger is a silent no-op under `bun test`
   *  and the warn-once level is the only observable a warn has. */
  log?: Logger;
  /** The clock every TTL, back-off and empty-release window is measured on.
   *  Defaults to `Date.now`; injected by tests, since the release window is an
   *  hour and no suite may wait one. */
  now?: () => number;
}

/** This module's own clock read, or the caller's injected one. */
function nowOf(deps: WorkedLedgerDeps): number {
  return (deps.now ?? Date.now)();
}

export function defaultWorkedLedgerDeps(
  baseUrl: string,
  urlConfigured: boolean,
  timeoutMs: number = BOUNDED_FETCH_TIMEOUT_MS,
  maxBytes: number = BOUNDED_FETCH_MAX_BYTES,
): WorkedLedgerDeps {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    urlConfigured,
    baseUrl: root,
    fetchPages: (wikiRoot, signal) =>
      claudeUsageJson(root, `/api/files?root=${encodeURIComponent(wikiRoot)}&summary=1`, {
        timeoutMs,
        maxBytes,
        signal,
        // The base URL, not the full one: the query carries a filesystem path
        // that would make every log line grow with the wiki it is about.
        label: root,
      }),
  };
}

/**
 * The deps for a caller that has no `Config` — `buildWikiIndex`, which is
 * reached from routes, watchers and CLI scripts alike. The pair rule
 * `resolveServingProfile` states: a `Config` field where a `Config` exists, the
 * env getter where none does. One trimmed read, so a whitespace-only value
 * cannot report "configured" while pointing nowhere.
 */
export function workedLedgerDepsFromEnv(): WorkedLedgerDeps {
  const raw = (process.env.CLAUDE_USAGE_URL ?? "").trim();
  return defaultWorkedLedgerDeps(raw || CLAUDE_USAGE_DEFAULT_URL, raw !== "");
}

/**
 * A wiki-relative path in the spelling both sides compare on.
 *
 * The index's own `normalizeRelPath` does the work — posix-normalize (which
 * collapses `..` and `//`, neither of which a hand-rolled prefix strip sees) and
 * lower-case — with a LEADING-SLASH strip layered on top, because this side's
 * rows come from a tool that may have spelled the path `/plans/a.md` while the
 * index stores `plans/a.md`. One normalizer, so a key the store looks up is the
 * key the ledger stored.
 *
 * Lower-cased unlike the git date walk's raw-relPath keying, and deliberately:
 * that walk and the index read one filesystem through one tool, so a case
 * difference there IS a bug worth missing on. This map comes from a SECOND
 * process reading a case-insensitive filesystem through whatever spelling an
 * agent typed, so a case-only difference is noise — and the match rate is the
 * guard that a real mismatch still fires.
 */
export function normalizeWorkedPath(p: string): string {
  return normalizeRelPath(p.replace(/\\/g, "/")).replace(/^\/+/, "");
}

/** A parsed `?summary=1` answer, or WHY it is not one. The reasons are separate
 *  because they are separate operator problems: a body with no `pages` key is an
 *  un-upgraded service, and malformed rows are a wrong service or a broken one. */
export type WorkedPagesParse =
  | {
      ok: true;
      pages: Map<string, number>;
      returned: number;
      /** Upstream's own `truncated` flag, defaulted FALSE when the field is
       *  absent — an older answer that does not report it is not evidence of a
       *  clip, and warning on its absence would fire on every healthy wiki. */
      truncated: boolean;
      /** The row cap upstream applied, when it said. Named in the clip warn, so
       *  the operator knows which number to raise. */
      limit?: number;
    }
  | { ok: false; reason: "no-pages-key" | "malformed-rows"; detail: string };

/**
 * Validate and fold one `?summary=1` body.
 *
 * `pages` must be an array of `{p: string, w: number, b?: number}`, and a page's
 * worked date is `max(w, b)`. `b` is the newest bash touch (a `sed -i`, a
 * `cat >`, a python-heredoc `open(…, "w")` target — claude-usage #215), under the
 * same fan-out discount as `w`: a session edits a page through Bash as often as
 * through Edit, and `w` alone dated such a page to the session before. `b` is
 * optional and skipped when malformed, never rejecting the row: it only ever
 * moves a valid `w` later. `s` (the writing-session count) is not read.
 *
 * ONE malformed row rejects the WHOLE answer rather than being skipped. A body
 * that is half the contract is a wrong or broken service, and a half-read of it
 * would put a partial axis on screen with nothing saying so — the failure this
 * module exists to refuse, one level in.
 */
export function parseWorkedPages(body: unknown): WorkedPagesParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "no-pages-key", detail: "body is not an object" };
  }
  const rows = (body as { pages?: unknown }).pages;
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      reason: "no-pages-key",
      detail: "no pages[] in the answer — upstream does not answer the summary form yet",
    };
  }
  const pages = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return { ok: false, reason: "malformed-rows", detail: `pages[${i}] is not an object` };
    }
    const { p, w, b } = row as { p?: unknown; w?: unknown; b?: unknown };
    if (typeof p !== "string" || p.trim() === "") {
      return { ok: false, reason: "malformed-rows", detail: `pages[${i}].p is not a path` };
    }
    if (!isInstant(w)) {
      return { ok: false, reason: "malformed-rows", detail: `pages[${i}].w is not an instant` };
    }
    const worked = isInstant(b) && b > w ? b : w;
    const key = normalizeWorkedPath(p);
    // Two spellings of one path fold to one key, and the NEWER write wins: the
    // field answers "when was this page last worked on", which a lower value
    // cannot make less true.
    const seen = pages.get(key);
    if (seen === undefined || worked > seen) pages.set(key, worked);
  }
  const { truncated, limit } = body as { truncated?: unknown; limit?: unknown };
  return {
    ok: true,
    pages,
    returned: rows.length,
    truncated: truncated === true,
    ...(typeof limit === "number" && Number.isFinite(limit) ? { limit } : {}),
  };
}

function isInstant(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Per-root memo. Roots are independent: one wiki's unreachable ledger never
 *  blanks another's axis. */
const memos = new Map<string, WorkedLedgerMemo>();
/** Refreshes in flight, per root — a second kick during a slow fetch joins the
 *  first rather than opening a second connection. */
const inFlight = new Map<string, Promise<WorkedLedgerMemo | null>>();
/**
 * When a root's last refresh FAILED, per root — the back-off for a degraded
 * upstream, cleared the moment one succeeds.
 *
 * Without it every index build re-asks a service that is down or un-upgraded:
 * measured against the laptop's own un-upgraded claude-usage, the raw row form
 * (~800 KB) was re-fetched and re-rejected once per build, forever. A failure is
 * worth re-testing on the same cadence a good answer goes stale on, which is the
 * caller's `maxAgeMs`. Nothing on the HTTP surface waives it: `?refresh=1` is
 * also the browser's own focus refetch, so a hatch keyed on it re-asked a dead
 * service every 30 s per open tab. Boot passes 0 (a process restart is the one
 * deliberate "ask again now"); every index build passes the index TTL.
 */
const lastFailureAt = new Map<string, number>();
/**
 * When a root last answered with ROWS — the start of the empty-release window
 * below. Set on every committed non-empty answer; read only while empties are
 * arriving over a memo that still holds pages.
 */
const lastNonEmptyAt = new Map<string, number>();

/**
 * How long a run of SUCCESSFUL zero-row answers is kept out of the memo before
 * it is believed.
 *
 * A 200 carrying no rows for a root the memo holds pages for is usually a
 * transient upstream state, so it is refused — that is the rule this module
 * shipped with. But "refused forever" has two costs a wiki that legitimately
 * went N → 0 pays for good: every session under the root later discounted, or
 * the root renamed upstream, and the reader keeps seeing dates for writes the
 * ledger no longer claims — while the memo's `fetchedAt` never advances, so the
 * TTL gate never holds and the root is re-asked on EVERY index build (the
 * back-off, defeated through the empty path).
 *
 * One hour: long enough that a restart, a reindex or a brief mis-configuration
 * upstream passes without blanking the axis, short enough that a real removal
 * shows up the same working session. Both halves are stated because the warn
 * says which one is running.
 */
export const WORKED_EMPTY_RELEASE_MS = 60 * 60 * 1000;

/** The warm memo for a root, or null when none has ever landed. */
export function workedLedgerFor(root: string): WorkedLedgerMemo | null {
  return memos.get(root) ?? null;
}

/**
 * Refresh one root's memo. NEVER throws and never blanks a good memo: a
 * transient failure warns once and leaves the last good answer in place, because
 * the alternative — every page losing its worked date for one failed poll — is a
 * visibly broken axis for a problem that has already passed.
 *
 * ── The root SPELLING, and the two cases it can get wrong ────────────────────
 * The ledger keys on absolute paths as the tool spelled them, and upstream
 * matches `?root=` as a plain string PREFIX — it runs no `realpath`, and it
 * REFUSES a root that is not already canonical. So the configured root is
 * normalized with `path.resolve` before the ask: an unnormalized `WIKI_DIR=../x`
 * sent verbatim answers 400 forever, and a 400 is not the zero-row answer the
 * retry below keys on, so nothing would ever recover it.
 *
 * The second case is a symlink: a wiki registered through one (`/tmp/w` for
 * `/private/tmp/w` on macOS) can answer zero rows while the ledger holds every
 * one of them under the other spelling. Measured on this machine's own corpus
 * the two spellings are identical, so neither is provably the right one to send:
 * the configured root is asked FIRST (it is what the operator named), and a
 * ZERO-row answer is retried once against the other spelling. The spelling that
 * ANSWERED is remembered on the memo (`rootAsked`) and asked first next time, so
 * a symlinked root pays the second fetch and the `realpath` once rather than on
 * every refresh.
 */
export async function refreshWorkedLedger(
  root: string,
  deps: WorkedLedgerDeps,
): Promise<WorkedLedgerMemo | null> {
  if (!deps.urlConfigured) return memos.get(root) ?? null;
  const existing = inFlight.get(root);
  if (existing) return existing;
  const task = runRefresh(root, deps).finally(() => inFlight.delete(root));
  inFlight.set(root, task);
  return task;
}

async function runRefresh(
  root: string,
  deps: WorkedLedgerDeps,
): Promise<WorkedLedgerMemo | null> {
  const prev = memos.get(root) ?? null;
  const fail = (): WorkedLedgerMemo | null => {
    lastFailureAt.set(root, nowOf(deps));
    return prev;
  };
  // The spelling that answered last time, else the canonical configured root.
  const canonical = path.resolve(root);
  const first = prev?.rootAsked ?? canonical;
  let parsed = await askOne(first, root, deps);
  if (!parsed) return fail();
  if (!parsed.ok) {
    warnDegraded(deps, root, parsed.reason, `${parsed.detail} (${deps.baseUrl})`);
    return fail();
  }
  let asked = first;
  if (parsed.pages.size === 0) {
    const alt = first === canonical ? await realpathOrNull(canonical) : canonical;
    if (alt && alt !== first) {
      const retry = await askOne(alt, root, deps);
      // A retry that THREW leaves the memo alone: falling through to the
      // zero-row commit below would blank a good axis on one failed second leg
      // (measured end to end on a symlinked root — one ETIMEDOUT emptied it).
      if (!retry) return fail();
      if (!retry.ok) {
        warnDegraded(deps, root, retry.reason, `${retry.detail} (${deps.baseUrl})`);
        return fail();
      }
      if (retry.pages.size > 0) {
        parsed = retry;
        asked = alt;
      }
    }
  }
  lastFailureAt.delete(root);
  const at = nowOf(deps);
  if (parsed.pages.size > 0) lastNonEmptyAt.set(root, at);
  // A SUCCESSFUL zero-row answer must not replace a memo that holds pages. It is
  // a 200, so nothing warned, and the axis would simply go blank — the option
  // hides and no line says why. Committed only when there is no non-empty memo
  // to keep, which is what still lets a genuinely un-worked wiki report
  // `matched: 0` on its first refresh.
  //
  // …but HELD, not held forever: once the empties have persisted for
  // `WORKED_EMPTY_RELEASE_MS` the answer is believed and the memo is cleared,
  // because a wiki that really went N → 0 would otherwise show stale dates for
  // the life of the process. `fetchedAt` advances on EVERY empty answer, kept or
  // released, or the caller's TTL gate never holds and the root is re-asked on
  // every index build — the back-off, defeated through this path.
  if (parsed.pages.size === 0 && prev && prev.pages.size > 0) {
    // `lastNonEmptyAt` is set at every non-empty commit and reset only with the
    // whole memo map, so with `prev.pages.size > 0` it is always present; the fallback is
    // "release now" rather than `prev.fetchedAt`, which a held empty answer
    // advances and would therefore never let the window elapse.
    const since = lastNonEmptyAt.get(root) ?? 0;
    if (at - since < WORKED_EMPTY_RELEASE_MS) {
      warnDegraded(
        deps,
        root,
        "empty-answer",
        `upstream answered 0 rows for a root it had ${prev.pages.size} for — keeping the ` +
          `last good answer for up to ${Math.round(WORKED_EMPTY_RELEASE_MS / 60_000)} min ` +
          `(${deps.baseUrl})`,
      );
      const held: WorkedLedgerMemo = { ...prev, fetchedAt: at };
      memos.set(root, held);
      return held;
    }
    warnDegraded(
      deps,
      root,
      "empty-released",
      `upstream has answered 0 rows for over ${Math.round(WORKED_EMPTY_RELEASE_MS / 60_000)} ` +
        `min for a root it had ${prev.pages.size} for — dropping the worked dates for it ` +
        `(${deps.baseUrl})`,
    );
  }
  const memo: WorkedLedgerMemo = {
    pages: parsed.pages,
    fetchedAt: at,
    returned: parsed.returned,
    baseUrl: deps.baseUrl,
    rootAsked: asked,
    truncated: parsed.truncated,
  };
  memos.set(root, memo);
  if (memo.truncated) {
    // The clip drops the pages with the OLDEST write, and every row that DID
    // arrive still matches — so the match-rate warn cannot see this one.
    warnDegraded(
      deps,
      root,
      "truncated",
      `upstream clipped its answer for ${asked} at ${parsed.limit ?? "its"} row(s) — the ` +
        `pages with the oldest write are missing from the axis (${deps.baseUrl})`,
    );
  }
  log.debug("worked ledger: {pages} page(s) for {root} from {baseUrl}", {
    pages: memo.pages.size,
    root: asked,
    baseUrl: deps.baseUrl,
  });
  return memo;
}

/** One call. `null` when the transport failed — already warned, with the two
 *  transport reasons kept apart so a 500 and an over-cap body are not one line. */
async function askOne(
  askRoot: string,
  keyRoot: string,
  deps: WorkedLedgerDeps,
): Promise<WorkedPagesParse | null> {
  try {
    return parseWorkedPages(await deps.fetchPages(askRoot));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // `claudeUsageHttpStatus`, not a bare `.status` read: a thrown non-object
    // (a string, null) makes that read throw INSIDE the catch, which rejects
    // `refreshWorkedLedger` and contradicts its "never throws" contract.
    const status = claudeUsageHttpStatus(err);
    warnDegraded(deps, keyRoot, status === null ? "transport" : `http-${status}`, msg);
    return null;
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/**
 * One warn per (base URL, ROOT, reason) — the six cases are six distinct keys,
 * so an un-upgraded service and an unreachable one never share a first sighting.
 *
 * The ROOT is in the key because one process reads several wikis off one
 * claude-usage: without it a second wiki failing the same way dropped straight
 * to `info`, so the axis could go dark on a whole root with nothing at `warn`
 * level saying which. The MESSAGE may still omit the path — it is a filesystem
 * path on a shared aggregator, and the store's own rate warn names it where it
 * matters.
 */
function warnDegraded(
  deps: WorkedLedgerDeps,
  root: string,
  reason: string,
  error: string,
): void {
  claudeUsageWarnOnce({
    log: deps.log ?? log,
    baseUrl: deps.baseUrl,
    key: `${reason}\u0000${root}`,
    error,
    what: "worked ledger",
  });
}

/**
 * Kick a background refresh and return immediately. The ONE entry point for
 * callers that must not wait — the index build and the boot warm-up.
 *
 * `maxAgeMs` is the staleness the caller tolerates: `buildWikiIndex` passes the
 * index's own TTL, so a rebuild inside one TTL re-uses the memo and a rebuild
 * after it asks again. Pass 0 to force — BOOT only (`src/index.ts`); no HTTP
 * caller may, see `lastFailureAt` above.
 *
 * It bounds a FAILED attempt on the same cadence (`lastFailureAt`), so a
 * degraded upstream is re-tested once per TTL rather than once per index build.
 */
export function kickWorkedLedgerRefresh(
  root: string,
  opts: { maxAgeMs?: number; deps?: WorkedLedgerDeps } = {},
): void {
  const deps = opts.deps ?? workedLedgerDepsFromEnv();
  if (!deps.urlConfigured) return;
  const memo = memos.get(root);
  const maxAge = opts.maxAgeMs ?? 0;
  if (maxAge > 0) {
    const at = nowOf(deps);
    if (memo && at - memo.fetchedAt < maxAge) return;
    const failedAt = lastFailureAt.get(root);
    if (failedAt !== undefined && at - failedAt < maxAge) return;
  }
  void refreshWorkedLedger(root, deps).catch(() => {
    // `refreshWorkedLedger` already swallows and warns; this is the belt that
    // keeps a future throw from becoming an unhandled rejection at boot.
  });
}

/** Test-only: drop every memo and every in-flight refresh. */
export function __resetWorkedLedgerForTest(): void {
  memos.clear();
  inFlight.clear();
  lastFailureAt.clear();
  lastNonEmptyAt.clear();
}
