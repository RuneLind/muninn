/**
 * The WORK SESSIONS memo — which recent agent sessions wrote what under a wiki
 * root, read out of claude-usage's sessions form, plus each page's newest write
 * before that window. `work-focus.ts` turns it into per-page events and threads
 * in the index post-pass.
 *
 * Shaped like `worked-ledger.ts`, whose docblock holds the reasons: refreshed in
 * the BACKGROUND (kicked by the index build and at boot), never awaited, a
 * failure backs off on the caller's TTL and warns once per (base URL, root,
 * reason), and nothing fetches on an instance pointed at no claude-usage or on
 * the nais profile (the caller's `wikiToolsRegistered` gate).
 *
 * Two requests make ONE memo entry, committed only when BOTH parse and the
 * summary answer echoes the `until` it was asked for:
 *  - `GET /api/files?root=&sessions=1&since=<now − 8 d>` — strict: the body
 *    must echo `form: "sessions"` and every row must parse. An older
 *    claude-usage ignores `sessions=1` and answers the raw row form, which ALSO
 *    carries a `sessions[]` array (of ids), so a shape test alone would pass it.
 *  - `GET /api/files?root=&summary=1&until=<since>` — the newest write per page
 *    before the window (`preMs`). An older claude-usage ignores `until` and
 *    answers the whole history, which would date every page's pre-touch
 *    position to its last write, window included — hence the echo check.
 * A failure of either keeps the last good pair; with none, the feature
 * degrades whole: no `work` on the listing (D11).
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { CLAUDE_USAGE_DEFAULT_URL } from "../dashboard/claude-usage-overview.ts";
import { getLog } from "../logging.ts";
import { BOUNDED_FETCH_MAX_BYTES, BOUNDED_FETCH_TIMEOUT_MS } from "../utils/bounded-fetch.ts";
import { claudeUsageHttpStatus, claudeUsageJson, claudeUsageWarnOnce } from "../utils/claude-usage-fetch.ts";
import { isReadonlyWikiRoot, sameWikiRoot } from "./readonly.ts";
import { parseWorkedPages, workedLedgerFor } from "./worked-ledger.ts";
import { WORK_WINDOW_MS, type WorkSession, type WorkSessionFile } from "./work-focus.ts";
import { ledgerInstant } from "../dashboard/views/components/wiki-filter.ts";

const log = getLog("wiki", "work-sessions");

type Logger = ReturnType<typeof getLog>;

export interface WorkSessionsMemo {
  /** Window start: `asOfMs − 8 d`. */
  sinceMs: number;
  /** The clock reading the answer was asked at — thread order's instant. */
  asOfMs: number;
  sessions: WorkSession[];
  /** Normalized path → newest write before the window. */
  pre: Map<string, number>;
  /** This wiki as the prompts name it: the registered root's spellings and the
   *  registry names — every entry on this root (absent when there is none). */
  identity: { roots: string[]; names?: string[] };
  /** Every other registered root that is not read-only. */
  otherRoots: string[];
  baseUrl: string;
  truncated: boolean;
}

export interface WorkSessionsDeps {
  /** The sessions form. MUST reject on transport/HTTP/parse failure, as
   *  `claudeUsageJson` does. */
  fetchSessions: (root: string, sinceMs: number, signal?: AbortSignal) => Promise<unknown>;
  /** The summary form with `until`. */
  fetchPreWindow: (root: string, untilMs: number, signal?: AbortSignal) => Promise<unknown>;
  urlConfigured: boolean;
  baseUrl: string;
  /** The registered wikis — this wiki's name and the other roots. Defaults to
   *  the process registry (imported lazily: the registry pulls bot discovery). */
  registry?: () => Promise<readonly { name: string; root: string }[]>;
  log?: Logger;
  now?: () => number;
}

export function defaultWorkSessionsDeps(
  baseUrl: string,
  urlConfigured: boolean,
  timeoutMs: number = BOUNDED_FETCH_TIMEOUT_MS,
  maxBytes: number = BOUNDED_FETCH_MAX_BYTES,
): WorkSessionsDeps {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    urlConfigured,
    baseUrl: root,
    fetchSessions: (wikiRoot, sinceMs, signal) =>
      claudeUsageJson(root, `/api/files?root=${encodeURIComponent(wikiRoot)}&sessions=1&since=${Math.floor(sinceMs)}`, {
        timeoutMs,
        maxBytes,
        signal,
        label: root,
      }),
    fetchPreWindow: (wikiRoot, untilMs, signal) =>
      claudeUsageJson(root, `/api/files?root=${encodeURIComponent(wikiRoot)}&summary=1&until=${Math.floor(untilMs)}`, {
        timeoutMs,
        maxBytes,
        signal,
        label: root,
      }),
  };
}

/** The deps for a caller with no `Config` (the index build), read once from
 *  `CLAUDE_USAGE_URL` — `workedLedgerDepsFromEnv`'s rule. */
export function workSessionsDepsFromEnv(): WorkSessionsDeps {
  const raw = (process.env.CLAUDE_USAGE_URL ?? "").trim();
  return defaultWorkSessionsDeps(raw || CLAUDE_USAGE_DEFAULT_URL, raw !== "");
}

export type WorkSessionsParse =
  | { ok: true; sessions: WorkSession[]; truncated: boolean }
  | { ok: false; reason: "not-sessions-form" | "malformed-rows"; detail: string };

function isInstant(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * A sessions answer as the live rail saw it at `at` (the replay, D17). With
 * `until = at` upstream already drops every (session, path, op) row whose last
 * write is after `at`, but a session's `first`/`last` span all of its rows, so
 * a session resumed after `at` reports a `last` the rail could not have seen.
 * Such a session is kept with `last` clamped to the newest `lastMs` at or
 * before `at` among the file rows in `files`, else `at`. `files` is upstream's
 * capped list, most edits first, so with more files than the cap the newest
 * kept write can be missing and the clamp lands early. `clipped` counts the
 * clamped sessions; others pass through as is.
 */
export function clipSessionsAt<S extends { last: number; files?: readonly { lastMs: number }[] }>(
  sessions: readonly S[],
  at: number,
): { sessions: S[]; clipped: number } {
  let clipped = 0;
  const out = sessions.map((s) => {
    if (s.last <= at) return s;
    clipped++;
    const newest = Math.max(0, ...(s.files ?? []).map((f) => f.lastMs).filter((ms) => ms <= at));
    return { ...s, last: newest > 0 ? newest : at };
  });
  return { sessions: out, clipped };
}

/**
 * Validate a sessions-form body. ONE malformed row rejects the whole answer,
 * the way `parseWorkedPages` does: a half-read would put a partial picture on
 * screen with nothing saying so.
 */
export function parseWorkSessions(body: unknown): WorkSessionsParse {
  if (!isObj(body) || body.form !== "sessions" || !Array.isArray(body.sessions)) {
    return {
      ok: false,
      reason: "not-sessions-form",
      detail: 'the answer does not echo form: "sessions" — upstream does not answer the sessions form yet',
    };
  }
  const bad = (detail: string): WorkSessionsParse => ({ ok: false, reason: "malformed-rows", detail });
  const sessions: WorkSession[] = [];
  for (let i = 0; i < body.sessions.length; i++) {
    const s = body.sessions[i];
    const at = `sessions[${i}]`;
    if (!isObj(s)) return bad(`${at} is not an object`);
    if (typeof s.id !== "string" || !s.id) return bad(`${at}.id is not a string`);
    if (typeof s.provider !== "string") return bad(`${at}.provider is not a string`);
    // claude-usage sends `title: null` for a session with no session_meta row.
    if (s.title != null && typeof s.title !== "string") return bad(`${at}.title is not a string`);
    if (!isInstant(s.first) || !isInstant(s.last)) return bad(`${at}.first/last is not an instant`);
    if (typeof s.bulk !== "boolean") return bad(`${at}.bulk is not a boolean`);
    const t = s.text;
    if (!isObj(t) || (t.from !== "prompt" && t.from !== "title")) return bad(`${at}.text is malformed`);
    if (!isStrArray(t.paths) || !isStrArray(t.files) || !Array.isArray(t.links)) return bad(`${at}.text lists are malformed`);
    const links: WorkSession["text"]["links"] = [];
    for (const l of t.links) {
      if (!isObj(l) || typeof l.relPath !== "string" || (l.wiki !== null && typeof l.wiki !== "string")) {
        return bad(`${at}.text.links is malformed`);
      }
      links.push({ wiki: l.wiki as string | null, relPath: l.relPath });
    }
    if (!Array.isArray(s.files)) return bad(`${at}.files is not an array`);
    const files: WorkSessionFile[] = [];
    for (let j = 0; j < s.files.length; j++) {
      const f = s.files[j];
      if (!isObj(f) || typeof f.p !== "string" || !f.p.trim()) return bad(`${at}.files[${j}].p is not a path`);
      if (typeof f.edits !== "number" || !Number.isFinite(f.edits) || f.edits < 0) return bad(`${at}.files[${j}].edits is not a count`);
      if (!isInstant(f.firstMs) || !isInstant(f.lastMs)) return bad(`${at}.files[${j}] times are not instants`);
      files.push({ p: f.p, edits: f.edits, firstMs: f.firstMs, lastMs: f.lastMs });
    }
    sessions.push({
      id: s.id,
      provider: s.provider,
      title: typeof s.title === "string" ? s.title : "",
      first: s.first,
      last: s.last,
      bulk: s.bulk,
      text: { from: t.from, paths: t.paths, links, files: t.files },
      files,
    });
  }
  return { ok: true, sessions, truncated: body.truncated === true };
}

/** The summary form at `until`: `parseWorkedPages` plus the echo check. */
export function parsePreWindow(
  body: unknown,
  untilMs: number,
): { ok: true; pages: Map<string, number> } | { ok: false; reason: string; detail: string } {
  const parsed = parseWorkedPages(body);
  if (!parsed.ok) return parsed;
  const echoed = (body as { until?: unknown }).until;
  if (echoed !== Math.floor(untilMs)) {
    return {
      ok: false,
      reason: "until-not-echoed",
      detail: "the summary answer does not echo `until` — upstream does not bound the summary form yet",
    };
  }
  return { ok: true, pages: parsed.pages };
}

/**
 * The age past which a memo reads as absent once a refresh has failed since its
 * answer (arch review 2026-10, finding 69). A failure keeps the last good memo,
 * so a claude-usage outage would otherwise show week-old Work threads as
 * current. The bound is the memo's AGE (`now − asOfMs`), not how long the
 * failures have run: a fresh memo outlives one transient failure (the next
 * refresh is a TTL away) for up to this long, and an old memo is gone at the
 * first failure. A memo with no failure since its answer stands at any age —
 * the idle reader's case, where the build that serves it has just kicked the
 * refresh that will either replace it or record that failure. An hour, the
 * worked ledger's own `WORKED_EMPTY_RELEASE_MS`.
 */
export const WORK_MEMO_HOLD_MS = 60 * 60_000;

const memos = new Map<string, WorkSessionsMemo>();
const inFlight = new Map<string, Promise<WorkSessionsMemo | null>>();
const lastFailureAt = new Map<string, number>();
/** The first failure since the memo's answer; cleared by a success. */
const failingSince = new Map<string, number>();
const fetchedAt = new Map<string, number>();

/** The warm memo for a root, or null — null too once a refresh has failed
 *  since its answer and the memo is {@link WORK_MEMO_HOLD_MS} old. The memo
 *  itself is kept: the next good answer replaces it. Its age reads the answer
 *  instant through `ledgerInstant`, the rule the worked chip's
 *  `ledgerReadDayFor` reads its ledger answer with. */
export function workSessionsFor(root: string, now: number = Date.now()): WorkSessionsMemo | null {
  const memo = memos.get(root);
  if (!memo) return null;
  // Any failure on record is since this memo's answer: a success clears it.
  // Comparing it with `asOfMs` instead let a wall clock stepped back between
  // the two hold the memo for the whole outage.
  if (!failingSince.has(root)) return memo;
  const asOf = ledgerInstant(memo.asOfMs, now);
  return asOf !== undefined && now - asOf < WORK_MEMO_HOLD_MS ? memo : null;
}

/** The identity of the last good memo for a root, whatever its age or failures
 *  since: the index build resolves `related:` absolute paths against these
 *  roots, which say where the wiki lives and do not go stale the way the work
 *  data does. Null when no refresh has ever succeeded. */
export function workSessionsIdentityFor(root: string): WorkSessionsMemo["identity"] | null {
  return memos.get(root)?.identity ?? null;
}

/**
 * Refresh one root's memo. Never throws; a failure keeps the last good memo.
 * `identityRoot` is the root the prompts and the ledger name — the root itself
 * except on a replay, which builds on a clone of the registered wiki.
 */
export async function refreshWorkSessions(
  root: string,
  deps: WorkSessionsDeps,
  opts: { identityRoot?: string } = {},
): Promise<WorkSessionsMemo | null> {
  if (!deps.urlConfigured) return memos.get(root) ?? null;
  const existing = inFlight.get(root);
  if (existing) return existing;
  const task = runRefresh(root, deps, opts.identityRoot ?? root).finally(() => inFlight.delete(root));
  inFlight.set(root, task);
  return task;
}

async function runRefresh(root: string, deps: WorkSessionsDeps, identityRoot: string): Promise<WorkSessionsMemo | null> {
  const prev = memos.get(root) ?? null;
  const now = (deps.now ?? Date.now)();
  const fail = (): WorkSessionsMemo | null => {
    lastFailureAt.set(root, now);
    if (!failingSince.has(root)) failingSince.set(root, now);
    return prev;
  };
  const canonical = path.resolve(identityRoot);
  // The spelling the worked ledger found answers, else the canonical root.
  // A replay (identity ≠ root) asks for the registered root as written.
  const asked = identityRoot === root ? (workedLedgerFor(root)?.rootAsked ?? canonical) : canonical;
  const sinceMs = now - WORK_WINDOW_MS;
  const [sessionsBody, preBody] = await Promise.all([
    ask(() => deps.fetchSessions(asked, sinceMs), deps, root),
    ask(() => deps.fetchPreWindow(asked, sinceMs), deps, root),
  ]);
  if (sessionsBody === FAILED || preBody === FAILED) return fail();
  const sessions = parseWorkSessions(sessionsBody);
  if (!sessions.ok) {
    warn(deps, root, sessions.reason, `${sessions.detail} (${deps.baseUrl})`);
    return fail();
  }
  const pre = parsePreWindow(preBody, sinceMs);
  if (!pre.ok) {
    warn(deps, root, pre.reason, `${pre.detail} (${deps.baseUrl})`);
    return fail();
  }
  let entries: readonly { name: string; root: string }[] = [];
  try {
    entries = await (deps.registry ?? defaultRegistry)();
  } catch {
    // No registry: no name (reader links name no page) and no other roots
    // (nothing is `elsewhere`). The work facts still stand.
  }
  const real = await realpath(canonical).catch(() => null);
  const roots = [...new Set([canonical, asked, ...(real ? [real] : [])])];
  // Every registry name of this root: an aliased root answers to each (finding 71).
  const names = entries.filter((e) => sameWikiRoot(e.root, identityRoot)).map((e) => e.name);
  const memo: WorkSessionsMemo = {
    sinceMs,
    asOfMs: now,
    sessions: sessions.sessions,
    pre: pre.pages,
    identity: { roots, ...(names.length ? { names } : {}) },
    otherRoots: entries
      .filter((e) => !sameWikiRoot(e.root, identityRoot) && !isReadonlyWikiRoot(e.root))
      .map((e) => path.resolve(e.root)),
    baseUrl: deps.baseUrl,
    truncated: sessions.truncated,
  };
  lastFailureAt.delete(root);
  failingSince.delete(root);
  memos.set(root, memo);
  fetchedAt.set(root, now);
  if (memo.truncated) {
    warn(deps, root, "truncated", `upstream clipped the sessions answer — the oldest sessions are missing (${deps.baseUrl})`);
  }
  log.debug("work sessions: {n} session(s) for {root}", { n: memo.sessions.length, root: asked });
  return memo;
}

async function defaultRegistry(): Promise<readonly { name: string; root: string }[]> {
  const { getWikiRegistry } = await import("./registry-memo.ts");
  return getWikiRegistry();
}

const FAILED = Symbol("failed");

async function ask(call: () => Promise<unknown>, deps: WorkSessionsDeps, root: string): Promise<unknown> {
  try {
    return await call();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = claudeUsageHttpStatus(err);
    warn(deps, root, status === null ? "transport" : `http-${status}`, msg);
    return FAILED;
  }
}

function warn(deps: WorkSessionsDeps, root: string, reason: string, error: string): void {
  claudeUsageWarnOnce({
    log: deps.log ?? log,
    baseUrl: deps.baseUrl,
    key: `${reason}\u0000${root}`,
    error,
    what: "work sessions",
  });
}

/** Kick a background refresh and return at once — the index build and boot.
 *  `maxAgeMs` gates both a fresh memo and a recent failure (0 forces: boot). */
export function kickWorkSessionsRefresh(root: string, opts: { maxAgeMs?: number; deps?: WorkSessionsDeps } = {}): void {
  const deps = opts.deps ?? workSessionsDepsFromEnv();
  if (!deps.urlConfigured) return;
  const maxAge = opts.maxAgeMs ?? 0;
  if (maxAge > 0) {
    const at = (deps.now ?? Date.now)();
    const fetched = fetchedAt.get(root);
    if (fetched !== undefined && at - fetched < maxAge) return;
    const failed = lastFailureAt.get(root);
    if (failed !== undefined && at - failed < maxAge) return;
  }
  void refreshWorkSessions(root, deps).catch(() => {});
}

/** claude-usage's per-session file cap in the sessions form
 *  (`FILES_SESSIONS_FILE_LIMIT`, most edits first): a session listing this
 *  many files may have written more. */
export const WORK_SESSION_FILE_CAP = 200;
/** A memo this young answers a session request without asking again. */
export const SESSION_MEMO_MAX_AGE_MS = 30_000;
/** The longest a session request waits on a refresh; the refresh itself
 *  keeps running and lands in the memo. */
export const SESSION_REFRESH_TIMEOUT_MS = 8_000;

/**
 * The memo for one session request — `GET /api/wiki/stale?session=`, which a
 * handoff runs right after the session wrote. The background memo is up to a
 * TTL old after an idle spell, so it is refreshed here, awaited for at most
 * {@link SESSION_REFRESH_TIMEOUT_MS}, unless the session is in a memo at most
 * {@link SESSION_MEMO_MAX_AGE_MS} old. A refresh that failed in that window
 * is not retried (the back-off).
 */
export async function workSessionsForSession(
  root: string,
  matches: (s: WorkSession) => boolean,
  opts: { deps?: WorkSessionsDeps; timeoutMs?: number } = {},
): Promise<{ memo: WorkSessionsMemo | null; timedOut: boolean }> {
  const deps = opts.deps ?? workSessionsDepsFromEnv();
  const now = (deps.now ?? Date.now)();
  const memo = workSessionsFor(root, now);
  const fresh = memo !== null && now - memo.asOfMs <= SESSION_MEMO_MAX_AGE_MS;
  if (fresh && memo.sessions.some(matches)) return { memo, timedOut: false };
  const failed = lastFailureAt.get(root);
  if (!deps.urlConfigured || (failed !== undefined && now - failed < SESSION_MEMO_MAX_AGE_MS)) return { memo, timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? SESSION_REFRESH_TIMEOUT_MS);
  });
  const done = await Promise.race([refreshWorkSessions(root, deps).catch(() => null), timeout]);
  clearTimeout(timer);
  return { memo: workSessionsFor(root, (deps.now ?? Date.now)()), timedOut: done === "timeout" };
}

/** Test-only: drop every memo, refresh and back-off. */
export function __resetWorkSessionsForTest(): void {
  memos.clear();
  inFlight.clear();
  lastFailureAt.clear();
  failingSince.clear();
  fetchedAt.clear();
}
