#!/usr/bin/env bun
/**
 * The Stale check from a terminal: what a page change may have made untrue
 * elsewhere. An HTTP client of the running muninn (`GET /api/wiki/stale`) —
 * never a DB or model caller of its own (D23).
 *
 *   bun --no-env-file scripts/wiki-stale.ts --wiki <name> [--pages <relPath>…] [--session <id>]
 *       [--as-of YYYY-MM-DD] [--check] [--base-url <url>] [--json]
 *
 * - `--pages` (one or several, space- or comma-separated): each page's stale
 *   status lines, and, when it changed in the 14 days to «now», its linking
 *   pages by bucket, the To-check ones with their passages, and *Moved with*.
 * - `--session <id>`: the pages that agent session wrote (reserved pages
 *   left out), from muninn's work memo of the last 8 days, refreshed for the
 *   request; the line says the memo's as-of and whether claude-usage's caps
 *   clipped it. Each page is reported as `--pages` would.
 * - Neither: the wiki's uncommitted and recently committed pages and every
 *   page with a stale status line, with their counts. Edits nothing.
 * - `--as-of` pins «now» (tests). `--check` runs Check (`POST
 *   /api/wiki/stale/check`) on each changed page among `--pages`/`--session`:
 *   one model call per linking page to check, at most 10 a page, each verdict
 *   printed as it streams in; cached verdicts come back without a call. Each
 *   hit line says whether the confirm loop confirmed it. `--json` prints the route's answers as JSON lines, and
 *   every notice (errors, the session line, the readonly line) as a
 *   `{"notice": …}` line, so each stdout line parses.
 * - Base URL: `--base-url`, else `WIKI_STALE_MUNINN_URL`, else
 *   http://127.0.0.1:3010.
 *
 * It reports and exits 0 always (D13), a usage error, an unreachable muninn
 * and an answer of the wrong shape included. The free reports share one
 * {@link RUN_DEADLINE_MS} budget, and each page's Check has its own
 * {@link CHECK_PAGE_DEADLINE_MS} (a Check of 10 calls takes longer than 25 s),
 * so a slow Check never starves the next page (A10): a handoff that runs it
 * never fails, and waits at most 25 s plus one Check bound per changed page.
 * Each line prints as it is made, a verdict as its event arrives. On a
 * readonly instance (D25) it prints the free checks plus one
 * «check unavailable: readonly instance» line; on a writable instance whose
 * wiki root is readonly (`WIKI_READONLY_ROOTS`), «… readonly wiki».
 */

export const DEFAULT_BASE_URL = "http://127.0.0.1:3010";
export const USAGE =
  "usage: bun --no-env-file scripts/wiki-stale.ts --wiki <name> [--pages <relPath>…] [--session <id>] [--as-of YYYY-MM-DD] [--check] [--base-url <url>] [--json]";

export interface StaleArgs {
  wiki?: string;
  pages: string[];
  session?: string;
  asOf?: string;
  check: boolean;
  json: boolean;
  baseUrl?: string;
}

/** Parse argv (after the script path). Unknown flags are reported, not fatal. */
export function parseStaleArgs(argv: readonly string[]): { args: StaleArgs; errors: string[] } {
  const args: StaleArgs = { pages: [], check: false, json: false };
  const errors: string[] = [];
  const value = (i: number, flag: string): string | undefined => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      errors.push(`${flag} needs a value`);
      return undefined;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const [flag, inline] = a.startsWith("--") && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      const v = value(i, flag);
      if (v !== undefined) i++;
      return v;
    };
    switch (flag) {
      case "--wiki":
        args.wiki = take();
        break;
      case "--pages":
      case "--page": {
        if (inline !== undefined) args.pages.push(...inline.split(","));
        else while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) args.pages.push(...argv[++i]!.split(","));
        break;
      }
      case "--session":
        args.session = take();
        break;
      case "--as-of":
        args.asOf = take();
        break;
      case "--base-url":
        args.baseUrl = take();
        break;
      case "--check":
        args.check = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        errors.push(`unknown argument ${a}`);
    }
  }
  args.pages = args.pages.map((p) => p.trim()).filter(Boolean);
  return { args, errors };
}

type Json = Record<string, any>;
export type FetchJson = (url: string, signal?: AbortSignal) => Promise<{ status: number; body: Json }>;
/** One server-sent event. */
export interface SseEvent {
  event: string;
  data: Json;
}
/** POST a JSON body and read the answer: a refusal is JSON (`status` ≥ 400,
 *  `body`), a stream is its events. */
export type PostSse = (url: string, body: Json, signal?: AbortSignal) => Promise<{ status: number; body?: Json; events?: AsyncIterable<SseEvent> }>;

/** The whole run's deadline (D13): a handoff waits on this script at most
 *  this long, however many calls a session report makes. The route's own
 *  bound on a session request (`SESSION_REFRESH_TIMEOUT_MS`, 8 s) fits in it. */
export const RUN_DEADLINE_MS = 25_000;
/** One page's Check deadline: the check route's own budget (4 min) plus a
 *  margin. Each page has its own (A10). */
export const CHECK_PAGE_DEADLINE_MS = 5 * 60_000;

const day = (ms: number | undefined) => (ms === undefined ? "never" : new Date(ms).toISOString().slice(0, 10));
const minute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
const cap = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown) => typeof v === "string";
/** A finite number: `day()` and `minute()` throw on NaN and ±Infinity's dates. */
const isNum = (v: unknown) => Number.isFinite(v) && Math.abs(v as number) <= 8.64e15;
const isBool = (v: unknown) => typeof v === "boolean";
const opt = (ok: (v: unknown) => boolean) => (v: unknown) => v === undefined || ok(v);
const each = (ok: (v: Json) => boolean) => (v: unknown) => Array.isArray(v) && v.every((x) => isObj(x) && ok(x));
/** The answer shapes the printers read, every field they read — anything
 *  else (a wrong `--base-url`, an older or newer muninn) is one line, never
 *  a throw. */
const isVerdict = (v: unknown) => isObj(v) && isStr(v.verdict) && opt(isStr)(v.reason);
const isHit = (h: Json) =>
  isNum(h.line) && Array.isArray(h.said) && h.said.every(isStr) && isStr(h.target) && isStr(h.now) && opt(isStr)(h.text) &&
  (h.confirmation === undefined || h.confirmation === "unconfirmed" || isVerdict(h.confirmation));
const isPassage = (p: Json) => isNum(p.line) && isStr(p.text) && opt(isStr)(p.claim);
const isLinking = (l: Json) => isStr(l.relPath) && isStr(l.title) && isStr(l.bucket) && opt(isNum)(l.lastChangeMs) && each(isPassage)(l.passages) && (l.verdict === undefined || isVerdict(l.verdict));
const isBuckets = (b: unknown) => b === null || (isObj(b) && isObj(b.counts) && Object.values(b.counts).every(isNum) && each(isLinking)(b.linking));
const isPageReport = (r: Json) =>
  isObj(r.page) && isStr(r.page.relPath) && isStr(r.page.title) && opt(isStr)(r.page.planStatus) && opt(isNum)(r.asOfMs) && opt(isNum)(r.lastChangeMs) &&
  each(isHit)(r.hits) && isBuckets(r.buckets) && opt(each((m) => isStr(m.relPath) && isNum(m.n)))(r.movedWith);
const isRow = (p: Json) => isStr(p.relPath) && isNum(p.staleLines) && isNum(p.toCheck) && isBool(p.changed) && isBool(p.dirty) && opt(isNum)(p.lastChangeMs);
const isSummary = (r: Json) => isObj(r.totals) && isNum(r.totals.staleLines) && isNum(r.totals.toCheck) && isNum(r.totals.changedPages) && opt(isNum)(r.asOfMs) && each(isRow)(r.pages);
const isSession = (r: Json) => isObj(r.session) && isBool(r.session.found) && Array.isArray(r.session.pages) && opt(isNum)(r.session.asOfMs) && opt(isStr)(r.session.error);
/** A body that is not JSON: an HTML page from a wrong `--base-url`, a proxy's error page. */
class NotJson extends Error {}
const BUCKET_LABEL: Record<string, string> = {
  toCheck: "to check",
  mentions: "mentions",
  pointers: "pointers",
  history: "history",
  changedSince: "changed since",
};

const VERDICT_LABEL: Record<string, string> = { stale: "stale", unsure: "unsure", true: "still true", "not-status": "not a status", fixed: "fixed" };
/** A verdict as one bracketed tag, with its reason. */
export function verdictTag(v: Json): string {
  return `[${VERDICT_LABEL[v.verdict] ?? v.verdict}${v.reason ? `: ${cap(String(v.reason), 140)}` : ""}]`;
}

function hitLines(hits: Json[]): string[] {
  return hits.map((h) => {
    const c = h.confirmation;
    const tag = c === undefined ? "" : c === "unconfirmed" ? " [unconfirmed]" : ` ${verdictTag(c)}`;
    return `    L${h.line}  ${(h.said ?? []).map((s: string) => `«${s}»`).join(", ")} after [[${h.target}]] — plan_status ${h.now}${tag}: ${cap(String(h.text ?? ""))}`;
  });
}

/** One page's report, as printed. */
export function formatPageReport(r: Json): string[] {
  const out: string[] = [];
  const p = r.page;
  out.push(`${p.relPath} — ${p.title}${p.planStatus ? ` (${p.planStatus})` : ""}`);
  out.push(`  last change ${day(r.lastChangeMs)}${r.dirty ? ", uncommitted edits" : ""}`);
  // PR 2a: a hit counts once the confirm loop confirmed it (D11).
  const confirmed = typeof r.staleLines === "number" ? r.staleLines : r.hits.length;
  const unconfirmed = r.hits.filter((h: Json) => h.confirmation === "unconfirmed").length;
  // A verdict read that failed leaves every hit unconfirmed: the count is unknown, not 0 (A10).
  if (r.verdicts === "unavailable") out.push(`  stale status lines: unknown — the verdict store is unavailable (${r.hits.length} hit${r.hits.length === 1 ? "" : "s"} unconfirmed)`);
  else out.push(`  stale status lines: ${confirmed}${unconfirmed ? ` (+ ${unconfirmed} unconfirmed hit${unconfirmed === 1 ? "" : "s"})` : ""}`);
  out.push(...hitLines(r.hits));
  if (!r.buckets) {
    out.push(`  not changed in the 14 days to ${day(r.asOfMs)} — no linking-page buckets`);
  } else {
    const b = r.buckets;
    const counts = Object.entries(b.counts).map(([k, n]) => `${BUCKET_LABEL[k] ?? k} ${n}`).join(" · ");
    out.push(`  linking pages: ${b.linking.length} — ${counts}`);
    const toCheck = b.linking.filter((l: Json) => l.bucket === "toCheck");
    if (toCheck.length) out.push("  to check:");
    for (const l of toCheck) {
      out.push(`    ${l.relPath} — ${l.title} (last change ${day(l.lastChangeMs)})${l.verdict ? ` ${verdictTag(l.verdict)}` : ""}`);
      for (const ps of l.passages) if (ps.claim) out.push(`      L${ps.line} [${ps.claim}] ${cap(ps.text)}`);
    }
  }
  if (r.movedWith?.length) out.push(`  moved with: ${r.movedWith.map((m: Json) => `${m.relPath} ×${m.n}`).join(", ")}`);
  return out;
}

/** The wiki-wide summary, as printed: uncommitted, recently committed, then
 *  every other page with a stale status line. In each group the rows with a
 *  stale line or a page to check come first, and the rest fold into one count
 *  line (`--json` keeps every row). */
export function formatSummary(r: Json): string[] {
  const out: string[] = [];
  const t = r.totals;
  const unconfirmed = typeof t.hits === "number" && t.hits > t.staleLines ? ` (+ ${t.hits - t.staleLines} unconfirmed hit(s))` : "";
  const lines = r.verdicts === "unavailable" ? `stale status lines unknown (the verdict store is unavailable${typeof t.hits === "number" ? `, ${t.hits} hit(s) unconfirmed` : ""})` : `${t.staleLines} stale status line(s)${unconfirmed}`;
  out.push(`${r.wiki}: ${lines}, ${t.toCheck} linking page(s) to check, ${t.changedPages} changed page(s) in the 14 days to ${day(r.asOfMs)}`);
  const row = (p: Json) => `  ${p.relPath} — ${p.staleLines} stale line(s), ${p.toCheck} to check (last change ${day(p.lastChangeMs)})`;
  const groups: [string, (p: Json) => boolean][] = [
    ["uncommitted", (p) => p.changed && p.dirty],
    ["recently committed", (p) => p.changed && !p.dirty],
    ["older pages with stale status lines", (p) => !p.changed],
  ];
  for (const [label, keep] of groups) {
    const rows = r.pages.filter(keep);
    if (!rows.length) continue;
    out.push(`${label} (${rows.length}):`);
    const live = rows.filter((p: Json) => p.staleLines > 0 || p.toCheck > 0);
    out.push(...live.map(row));
    const quiet = rows.length - live.length;
    if (quiet) out.push(`  + ${quiet} page${quiet === 1 ? "" : "s"} with nothing stale`);
  }
  return out;
}

/**
 * Run the script: returns the lines to print. Never throws — every failure
 * is a line — so the caller always exits 0, and the whole run ends within
 * `deadlineMs` ({@link RUN_DEADLINE_MS}). With `--json` every line is JSON:
 * the route's answers as they came, and each notice as `{"notice": …}`.
 */
export async function runWikiStale(
  argv: readonly string[],
  deps: {
    fetchJson?: FetchJson;
    postSse?: PostSse;
    env?: Record<string, string | undefined>;
    /** The free reports' shared budget ({@link RUN_DEADLINE_MS}). */
    deadlineMs?: number;
    /** Each page's Check bound ({@link CHECK_PAGE_DEADLINE_MS}). */
    checkDeadlineMs?: number;
    /** Called with each line as it is made (the script prints through it). */
    write?: (line: string) => void;
  } = {},
): Promise<string[]> {
  const { args, errors } = parseStaleArgs(argv);
  const notice = (text: string) => (args.json ? JSON.stringify({ notice: text }) : text);
  if (errors.length || !args.wiki) {
    const usage = [...errors.map((e) => `wiki-stale: ${e}`), ...(args.wiki ? [] : ["wiki-stale: --wiki is required"]), USAGE].map(notice);
    for (const l of usage) deps.write?.(l);
    return usage;
  }
  const env = deps.env ?? process.env;
  const base = (args.baseUrl ?? env.WIKI_STALE_MUNINN_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchJson: FetchJson =
    deps.fetchJson ??
    (async (url, signal) => {
      const res = await fetch(url, { signal });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) as Json };
      } catch {
        throw new NotJson(res.status === 200 ? "" : ` — HTTP ${res.status}`);
      }
    });
  const url = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ wiki: args.wiki!, ...(args.asOf ? { asOf: args.asOf } : {}), ...extra });
    return `${base}/api/wiki/stale?${q}`;
  };
  const postSse: PostSse = deps.postSse ?? defaultPostSse;
  const out: string[] = [];
  if (deps.write) {
    const write = deps.write;
    out.push = (...lines: string[]) => {
      for (const l of lines) write(l);
      return Array.prototype.push.apply(out, lines);
    };
  }
  const deadlineMs = deps.deadlineMs ?? RUN_DEADLINE_MS;
  const checkDeadlineMs = deps.checkDeadlineMs ?? CHECK_PAGE_DEADLINE_MS;
  /** A bound of its own for one request: its signal and a promise that settles on expiry. */
  const bounded = <T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T | "deadline"> => {
    const ac = new AbortController();
    let t: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"deadline">((resolve) => {
      t = setTimeout(() => {
        ac.abort();
        resolve("deadline");
      }, Math.max(0, ms));
    });
    return Promise.race([run(ac.signal), expired]).finally(() => clearTimeout(t));
  };
  /** What is left of the free reports' budget: only their own time counts. */
  let freeLeftMs = deadlineMs;
  /** Why the route refuses the model checks: the whole instance, or this wiki's root. */
  let readonly: "instance" | "wiki" | null = null;
  let late = false;
  const ask = async (extra: Record<string, string>, valid: (r: Json) => boolean, what: string): Promise<Json | null> => {
    if (late) return null;
    const t0 = Date.now();
    try {
      const got = await bounded(freeLeftMs, (signal) => fetchJson(url(extra), signal)).finally(() => (freeLeftMs -= Date.now() - t0));
      if (got === "deadline") {
        late = true;
        out.push(notice(`wiki-stale: muninn did not answer in ${deadlineMs / 1000} s — no stale report`));
        return null;
      }
      const { status, body } = got;
      if (body?.readonly) readonly = body.readonly === "root" ? "wiki" : "instance";
      if (args.json) out.push(JSON.stringify(body));
      if (status >= 400 || body?.error) {
        out.push(notice(`wiki-stale: ${body?.error ?? `HTTP ${status}`}${extra.page ? ` (${extra.page})` : ""}`));
        return null;
      }
      if (!isObj(body) || !valid(body)) {
        out.push(notice(`wiki-stale: unexpected answer from ${base} for ${what} — is --base-url a muninn of this version?`));
        return null;
      }
      return body;
    } catch (err) {
      if (err instanceof NotJson) {
        out.push(notice(`wiki-stale: unexpected answer (not JSON) from ${url(extra)}${err.message}`));
      } else {
        out.push(notice(`wiki-stale: cannot reach muninn at ${base}: ${err instanceof Error ? err.message : String(err)}`));
      }
      return null;
    }
  };

  try {
    let pages = args.pages;
    if (args.session) {
      const s = await ask({ session: args.session }, isSession, `session ${args.session}`);
      if (s) {
        const sess = s.session;
        const memo = [
          ...(typeof sess.asOfMs === "number" ? [`work memo as of ${minute(sess.asOfMs)}`] : []),
          ...(sess.refreshTimedOut ? ["claude-usage did not answer in time, so the memo may miss the newest writes"] : []),
          ...(sess.truncated ? ["the memo hit claude-usage's 200-session cap, so older sessions may be missing"] : []),
          ...(sess.filesCapped ? ["the session lists claude-usage's 200-file cap, so it may have written more"] : []),
        ];
        const tail = memo.length ? ` (${memo.join("; ")})` : "";
        if (!sess.found) out.push(notice(`wiki-stale: session ${args.session} wrote nothing in ${args.wiki} in the work memo's window${sess.error ? ` (${sess.error})` : ""}${tail}`));
        else out.push(notice(`session ${args.session}: ${sess.pages.length} page(s) in ${args.wiki}${tail}`));
        pages = [...new Set([...pages, ...sess.pages.filter((p: unknown): p is string => typeof p === "string")])];
      }
    }

    if (pages.length) {
      for (const page of pages) {
        // Per page: a throw the shape guards miss ends this page's report only.
        try {
          const r = await ask({ page }, isPageReport, `page ${page}`);
          if (r && !args.json) out.push(...formatPageReport(r), "");
          if (r && args.check && !readonly && r.buckets) await check(r.page.relPath);
        } catch (err) {
          out.push(notice(`wiki-stale: unexpected answer from ${base} for page ${page}: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    } else if (!args.session) {
      const r = await ask({}, isSummary, "the summary");
      if (r && !args.json) out.push(...formatSummary(r));
      if (args.check && !readonly) out.push(notice("check: name the pages to check with --pages or --session"));
    }
  } catch (err) {
    out.push(notice(`wiki-stale: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (readonly) out.push(notice(`check unavailable: readonly ${readonly}`));
  return out;

  /** Check one changed page and print each verdict as it arrives. */
  async function check(page: string): Promise<void> {
    const label = (rel: unknown) => (typeof rel === "string" ? rel : "?");
    const timedOut = () => out.push(notice(`wiki-stale: check ${page} did not finish in ${checkDeadlineMs / 1000} s`));
    // The whole Check, its stream included, runs under this page's own bound.
    const ran = await bounded(checkDeadlineMs, (signal) => checkStream(page, label, signal)).catch((err) => {
      out.push(notice(`wiki-stale: check ${page}: ${err instanceof Error ? err.message : String(err)}`));
    });
    if (ran === "deadline") timedOut();
  }

  async function checkStream(page: string, label: (rel: unknown) => string, signal: AbortSignal): Promise<void> {
    const got = await postSse(`${base}/api/wiki/stale/check`, { wiki: args.wiki, page, ...(args.asOf ? { asOf: args.asOf } : {}) }, signal);
    if (!got.events) {
      if (got.body?.readonly) readonly = got.body.readonly === "root" || /WIKI_READONLY_ROOTS/.test(String(got.body.error)) ? "wiki" : "instance";
      if (args.json && got.body) out.push(JSON.stringify(got.body));
      if (!readonly) out.push(notice(`wiki-stale: check ${page}: ${got.body?.error ?? `HTTP ${got.status}`}`));
      return;
    }
    if (!args.json) out.push(`  check ${page}:`);
    for await (const e of got.events) {
      // Past this page's bound its lines are no longer this run's.
      if (signal.aborted) return;
      if (args.json) {
        out.push(JSON.stringify({ event: e.event, ...e.data }));
        continue;
      }
      const d = e.data;
      if (e.event === "start") out.push(`    ${d.toCheck} to check: ${d.cached} cached, ${d.toCall} model call(s)${d.left ? `, ${d.left} left for another Check` : ""}`);
      else if (e.event === "verdict") out.push(`    ${label(d.relPath)} ${verdictTag(d)}${d.cached ? " (cached)" : ""}${isObj(d.edit) ? ` — edit: «${cap(String(d.edit.old), 80)}» → «${cap(String(d.edit.new), 80)}»` : ""}`);
      else if (e.event === "error") out.push(`    ${label(d.relPath)} [error: ${cap(String(d.message ?? ""), 140)}]`);
      else if (e.event === "done") out.push(`    done: ${d.calls} call(s)${d.joined ? ` + ${d.joined} joined from another Check` : ""}, ${d.verdicts} verdict(s), ${d.errors} error(s)`);
      else if (e.event === "app_error") out.push(notice(`wiki-stale: check ${page}: ${String(d.message ?? "failed")}`));
    }
    if (!args.json) out.push("");
  }
}

/** The real POST: JSON refusals as `body`, a `text/event-stream` as events. */
const defaultPostSse: PostSse = async (url, body, signal) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body), signal });
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as Json };
    } catch {
      return { status: res.status, body: { error: `unexpected answer (not JSON) — HTTP ${res.status}` } };
    }
  }
  return { status: res.status, events: readSse(res.body!) };
};

/** Parse a `text/event-stream` body into events (`event:` + one `data:` line each). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        yield { event, data: JSON.parse(data) as Json };
      } catch {
        // a malformed frame is skipped
      }
    }
  }
}

if (import.meta.main) {
  try {
    // Each line as it is made: a Check's verdicts print as they stream in (A10).
    await runWikiStale(process.argv.slice(2), { write: (line) => console.log(line) });
  } catch (err) {
    console.log(`wiki-stale: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}
