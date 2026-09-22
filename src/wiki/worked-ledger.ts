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
import { CLAUDE_USAGE_DEFAULT_URL } from "../dashboard/claude-usage-overview.ts";
import { getLog } from "../logging.ts";
import { BOUNDED_FETCH_MAX_BYTES, BOUNDED_FETCH_TIMEOUT_MS } from "../utils/bounded-fetch.ts";
import { claudeUsageJson, claudeUsageWarnOnce } from "../utils/claude-usage-fetch.ts";

const log = getLog("wiki", "worked-ledger");

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
  /** The `?root=` spelling that answered (see {@link refreshWorkedLedger}). */
  rootAsked: string;
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
 * A wiki-relative path in the spelling both sides compare on: `/`-separated,
 * no leading `./` or `/`, lower-cased.
 *
 * Lower-cased unlike the git date walk's raw-relPath keying, and deliberately:
 * that walk and the index read one filesystem through one tool, so a case
 * difference there IS a bug worth missing on. This map comes from a SECOND
 * process reading a case-insensitive filesystem through whatever spelling an
 * agent typed, so a case-only difference is noise — and the match rate is the
 * guard that a real mismatch still fires.
 */
export function normalizeWorkedPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
}

/** A parsed `?summary=1` answer, or WHY it is not one. The reasons are separate
 *  because they are separate operator problems: a body with no `pages` key is an
 *  un-upgraded service, and malformed rows are a wrong service or a broken one. */
export type WorkedPagesParse =
  | { ok: true; pages: Map<string, number>; returned: number }
  | { ok: false; reason: "no-pages-key" | "malformed-rows"; detail: string };

/**
 * Validate and fold one `?summary=1` body.
 *
 * `pages` must be an array of `{p: string, w: number}`; `b` (the bash-derived
 * touch) and `s` (the writing-session count) ride the payload and are
 * deliberately NOT read — `bash` is the loosest input the ledger has (a `sed -i`
 * loop is exactly how a mechanical pass runs), so folding it in is a decision of
 * its own, not a field to pick up because it is there.
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
    const { p, w } = row as { p?: unknown; w?: unknown };
    if (typeof p !== "string" || p.trim() === "") {
      return { ok: false, reason: "malformed-rows", detail: `pages[${i}].p is not a path` };
    }
    if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) {
      return { ok: false, reason: "malformed-rows", detail: `pages[${i}].w is not an instant` };
    }
    const key = normalizeWorkedPath(p);
    // Two spellings of one path fold to one key, and the NEWER write wins: the
    // field answers "when was this page last worked on", which a lower value
    // cannot make less true.
    const seen = pages.get(key);
    if (seen === undefined || w > seen) pages.set(key, w);
  }
  return { ok: true, pages, returned: rows.length };
}

/** Per-root memo. Roots are independent: one wiki's unreachable ledger never
 *  blanks another's axis. */
const memos = new Map<string, WorkedLedgerMemo>();
/** Refreshes in flight, per root — a second kick during a slow fetch joins the
 *  first rather than opening a second connection. */
const inFlight = new Map<string, Promise<WorkedLedgerMemo | null>>();

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
 * ── The root SPELLING, and the one case it can get wrong ─────────────────────
 * The ledger keys on absolute paths as the tool spelled them, and upstream
 * matches `?root=` as a plain string PREFIX — it runs no `realpath`. So a wiki
 * registered through a symlinked path (`/tmp/w` for `/private/tmp/w` on macOS)
 * can answer zero rows while the ledger holds every one of them under the other
 * spelling. Measured on this machine's own corpus the two spellings are
 * identical, so neither is provably the right one to send: the configured root
 * is asked FIRST (it is what the operator named), and a zero-row answer is
 * retried once against the realpath. The second call happens only on the zero
 * answer, which is also the cheapest possible one to get wrong.
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
  let parsed = await askOne(root, deps);
  let asked = root;
  if (parsed && parsed.ok && parsed.pages.size === 0) {
    const real = await realpathOrNull(root);
    if (real && real !== root) {
      const retry = await askOne(real, deps);
      if (retry && retry.ok && retry.pages.size > 0) {
        parsed = retry;
        asked = real;
      }
    }
  }
  if (!parsed) return memos.get(root) ?? null;
  if (!parsed.ok) {
    warnDegraded(deps, parsed.reason, `${parsed.detail} (${deps.baseUrl})`);
    return memos.get(root) ?? null;
  }
  const memo: WorkedLedgerMemo = {
    pages: parsed.pages,
    fetchedAt: Date.now(),
    returned: parsed.returned,
    baseUrl: deps.baseUrl,
    rootAsked: asked,
  };
  memos.set(root, memo);
  log.debug("worked ledger: {pages} page(s) for {root} from {baseUrl}", {
    pages: memo.pages.size,
    root: asked,
    baseUrl: deps.baseUrl,
  });
  return memo;
}

/** One call. `null` when the transport failed — already warned, with the two
 *  transport reasons kept apart so a 500 and an over-cap body are not one line. */
async function askOne(root: string, deps: WorkedLedgerDeps): Promise<WorkedPagesParse | null> {
  try {
    return parseWorkedPages(await deps.fetchPages(root));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: unknown }).status;
    warnDegraded(deps, typeof status === "number" ? `http-${status}` : "transport", msg);
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

/** One warn per (base URL, reason) — the four cases are four distinct keys, so
 *  an un-upgraded service and an unreachable one never share a first sighting. */
function warnDegraded(deps: WorkedLedgerDeps, key: string, error: string): void {
  claudeUsageWarnOnce({ log, baseUrl: deps.baseUrl, key, error, what: "worked ledger" });
}

/**
 * Kick a background refresh and return immediately. The ONE entry point for
 * callers that must not wait — the index build and the boot warm-up.
 *
 * `maxAgeMs` is the staleness the caller tolerates: `buildWikiIndex` passes the
 * index's own TTL, so a rebuild inside one TTL re-uses the memo and a rebuild
 * after it asks again. Pass 0 to force.
 */
export function kickWorkedLedgerRefresh(
  root: string,
  opts: { maxAgeMs?: number; deps?: WorkedLedgerDeps } = {},
): void {
  const deps = opts.deps ?? workedLedgerDepsFromEnv();
  if (!deps.urlConfigured) return;
  const memo = memos.get(root);
  const maxAge = opts.maxAgeMs ?? 0;
  if (memo && maxAge > 0 && Date.now() - memo.fetchedAt < maxAge) return;
  void refreshWorkedLedger(root, deps).catch(() => {
    // `refreshWorkedLedger` already swallows and warns; this is the belt that
    // keeps a future throw from becoming an unhandled rejection at boot.
  });
}

/** Test-only: drop every memo and every in-flight refresh. */
export function __resetWorkedLedgerForTest(): void {
  memos.clear();
  inFlight.clear();
}
