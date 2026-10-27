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
 * - `--session <id>`: the pages that agent session wrote, from muninn's warm
 *   work memo (the last 8 days), reported as `--pages` would.
 * - Neither: the wiki's uncommitted and recently committed pages and every
 *   page with a stale status line, with their counts. Edits nothing.
 * - `--as-of` pins «now» (tests); `--check` is accepted, and the model checks
 *   arrive with PR 2a; `--json` prints the route's answers as JSON lines.
 * - Base URL: `--base-url`, else `WIKI_STALE_MUNINN_URL`, else
 *   http://127.0.0.1:3010.
 *
 * It reports and exits 0 always (D13), a usage error and an unreachable
 * muninn included: a handoff that runs it must never fail on it. On a
 * readonly instance (D25) it prints the free checks plus one
 * «check unavailable: readonly instance» line.
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
export type FetchJson = (url: string) => Promise<{ status: number; body: Json }>;

const day = (ms: number | undefined) => (ms === undefined ? "never" : new Date(ms).toISOString().slice(0, 10));
const cap = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const BUCKET_LABEL: Record<string, string> = {
  toCheck: "to check",
  mentions: "mentions",
  pointers: "pointers",
  history: "history",
  changedSince: "changed since",
};

function hitLines(hits: Json[]): string[] {
  return hits.map((h) => `    L${h.line}  ${h.said.map((s: string) => `«${s}»`).join(", ")} after [[${h.target}]] — plan_status ${h.now}: ${cap(h.text)}`);
}

/** One page's report, as printed. */
export function formatPageReport(r: Json): string[] {
  const out: string[] = [];
  const p = r.page;
  out.push(`${p.relPath} — ${p.title}${p.planStatus ? ` (${p.planStatus})` : ""}`);
  out.push(`  last change ${day(r.lastChangeMs)}${r.dirty ? ", uncommitted edits" : ""}`);
  out.push(`  stale status lines: ${r.hits.length}`);
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
      out.push(`    ${l.relPath} — ${l.title} (last change ${day(l.lastChangeMs)})`);
      for (const ps of l.passages) if (ps.claim) out.push(`      L${ps.line} [${ps.claim}] ${cap(ps.text)}`);
    }
  }
  if (r.movedWith?.length) out.push(`  moved with: ${r.movedWith.map((m: Json) => `${m.relPath} ×${m.n}`).join(", ")}`);
  return out;
}

/** The wiki-wide summary, as printed: uncommitted, recently committed, then
 *  every other page with a stale status line. */
export function formatSummary(r: Json): string[] {
  const out: string[] = [];
  const t = r.totals;
  out.push(`${r.wiki}: ${t.staleLines} stale status line(s), ${t.toCheck} linking page(s) to check, ${t.changedPages} changed page(s) in the 14 days to ${day(r.asOfMs)}`);
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
    out.push(...rows.map(row));
  }
  return out;
}

/**
 * Run the script: returns the lines to print. Never throws — every failure
 * is a line — so the caller always exits 0.
 */
export async function runWikiStale(
  argv: readonly string[],
  deps: { fetchJson?: FetchJson; env?: Record<string, string | undefined> } = {},
): Promise<string[]> {
  const { args, errors } = parseStaleArgs(argv);
  if (errors.length || !args.wiki) {
    return [...errors.map((e) => `wiki-stale: ${e}`), ...(args.wiki ? [] : ["wiki-stale: --wiki is required"]), USAGE];
  }
  const env = deps.env ?? process.env;
  const base = (args.baseUrl ?? env.WIKI_STALE_MUNINN_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchJson: FetchJson =
    deps.fetchJson ??
    (async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      return { status: res.status, body: (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as Json };
    });
  const url = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ wiki: args.wiki!, ...(args.asOf ? { asOf: args.asOf } : {}), ...extra });
    return `${base}/api/wiki/stale?${q}`;
  };
  const out: string[] = [];
  let readonly = false;
  const ask = async (extra: Record<string, string>): Promise<Json | null> => {
    try {
      const { status, body } = await fetchJson(url(extra));
      if (body?.readonly) readonly = true;
      if (args.json) out.push(JSON.stringify(body));
      if (status >= 400 || body?.error) {
        out.push(`wiki-stale: ${body?.error ?? `HTTP ${status}`}${extra.page ? ` (${extra.page})` : ""}`);
        return null;
      }
      return body;
    } catch (err) {
      out.push(`wiki-stale: cannot reach muninn at ${base}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  let pages = args.pages;
  if (args.session) {
    const s = await ask({ session: args.session });
    if (s) {
      const sess = s.session;
      if (!sess.found) out.push(`wiki-stale: session ${args.session} wrote nothing in ${args.wiki} in the work memo's window${sess.error ? ` (${sess.error})` : ""}`);
      else out.push(`session ${args.session}: ${sess.pages.length} page(s) in ${args.wiki}`);
      pages = [...new Set([...pages, ...sess.pages])];
    }
  }

  if (pages.length) {
    for (const page of pages) {
      const r = await ask({ page });
      if (r && !args.json) out.push(...formatPageReport(r), "");
    }
  } else if (!args.session) {
    const r = await ask({});
    if (r && !args.json) out.push(...formatSummary(r));
  }
  if (readonly) out.push("check unavailable: readonly instance");
  else if (args.check) out.push("check: the model checks arrive with PR 2a — these are the free checks only");
  return out;
}

if (import.meta.main) {
  const lines = await runWikiStale(process.argv.slice(2));
  console.log(lines.join("\n"));
  process.exit(0);
}
