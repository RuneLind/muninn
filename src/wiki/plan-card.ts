/**
 * The reader's **Agent lens** (reader-lenses D4, D7): the real plan-card output
 * for a plan page, word for word. muninn writes no card of its own; it runs
 * `plan-card.ts` from the claude-skills repo through `PLAN_CARD_BIN`, so there
 * is one source and the lens cannot drift from what a session loads.
 *
 *     <bun> --no-env-file <PLAN_CARD_BIN> <absolute path> [--since D] [--id X] --json
 *
 * D7's scope, computed here like Stamp's `stampable`: `PLAN_CARD_BIN` set (an
 * absolute path) on the `default` profile, the page carries `plan_status`, and
 * the page's wiki root IS one of plan-card's own resolved roots (equality, the
 * `isStampRoot` rule). plan-card refuses any other page itself. Admin only;
 * with auth off the viewer is admin.
 *
 * The roots parse MIRRORS plan-card's `resolveRoots`, which differs from
 * `parseStampRoots`: an entry is `~`-expanded and resolved (a relative one
 * against this process's cwd, which is the child's too), `/` is kept, and a
 * root that does not exist is dropped; unset ⇒ its two defaults under `~/source`.
 * A drift shows up as an Agent button whose route answers 404.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveServingProfile } from "../config.ts";
import { sameWikiRoot } from "./readonly.ts";
import { STAMP_CHILD_ENV_NAMES } from "../dashboard/routes/wiki-stamp.ts";
import { WIKI_STAMP_ROOTS_ENV } from "./stamp-roots.ts";

export const PLAN_CARD_BIN_ENV = "PLAN_CARD_BIN";

/** The route's bound on one child (D7). plan-card's own worst case is about
 *  12 s: two muninn calls at 3 s and up to three claude-usage hosts at 3 s. */
export const PLAN_CARD_TIMEOUT_MS = 20_000;

/** `--since`: a real `YYYY-MM-DD` day. Checked here so nothing else reaches argv. */
export function isPlanCardSince(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

/** `--id`: the ids the reader links (`D7`, `S12`, `Q-14`, a case id such as
 *  `MEL-545776`): a letter first, letter/digit runs joined by `-` or `.`, at
 *  most 40 chars. A leading letter keeps a value from reading as a flag. */
export const PLAN_CARD_ID_RE = /^[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*$/;
export function isPlanCardId(v: string): boolean {
  return v.length <= 40 && PLAN_CARD_ID_RE.test(v);
}

export interface PlanCardConfig {
  /** Absolute script path, or null when the lens is off. */
  bin: string | null;
  /** plan-card's resolved roots, in its own order. */
  roots: string[];
}

/** plan-card's `resolveRoots`, for this process's environment. */
export function planCardRoots(env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  const raw = env[WIKI_STAMP_ROOTS_ENV]?.trim();
  const list = raw ? raw.split(":").filter(Boolean) : [path.join(home, "source/private/mimir"), path.join(home, "source/nav/melosys-kode-wiki")];
  return list.map((r) => path.resolve(r.replace(/^~(?=$|\/)/, home))).filter((r) => existsSync(r));
}

/** Read at request time. Off unless the variable names an absolute path and
 *  this is the `default` profile (nais drops the route group anyway). */
export function planCardConfigFromEnv(env: Record<string, string | undefined> = process.env): PlanCardConfig {
  const raw = (env[PLAN_CARD_BIN_ENV] ?? "").trim();
  let profileOk = false;
  try {
    profileOk = resolveServingProfile(env) === "default";
  } catch {
    // An unknown profile refuses the boot elsewhere; here it means off.
  }
  return { bin: raw && path.isAbsolute(raw) && profileOk ? raw : null, roots: planCardRoots(env) };
}

/** The plan-card root this wiki root IS, as plan-card spells it; null when none. */
export function planCardRootFor(wikiDir: string, roots: readonly string[]): string | null {
  return roots.find((r) => sameWikiRoot(wikiDir, r)) ?? null;
}

/** D7: is the Agent lens offered for this page and viewer? */
export function agentLensFor(opts: {
  config: PlanCardConfig;
  wikiDir: string | undefined;
  hasPlanStatus: boolean;
  admin: boolean;
}): boolean {
  const { config } = opts;
  return !!config.bin && opts.admin && opts.hasPlanStatus && !!opts.wikiDir && planCardRootFor(opts.wikiDir, config.roots) !== null;
}

/** The child's argv after the interpreter. */
export function planCardArgs(bin: string, abs: string, opts: { since?: string; id?: string }): string[] {
  return [bin, abs, ...(opts.since ? ["--since", opts.since] : []), ...(opts.id ? ["--id", opts.id] : []), "--json"];
}

/**
 * D7's allowlisted environment: Stamp's `PATH`, `HOME`, `TMPDIR`, plus
 * `WIKI_STAMP_ROOTS` and `CLAUDE_USAGE_URL` when this process has them, and
 * `PLAN_CARD_MUNINN_URL` pointing back at this instance on loopback (which
 * assumes a loopback or `0.0.0.0` bind). Nothing else of muninn's reaches the
 * child; `--no-env-file` keeps Bun from reloading muninn's `.env`.
 */
export function planCardChildEnv(port: number, source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...STAMP_CHILD_ENV_NAMES, WIKI_STAMP_ROOTS_ENV, "CLAUDE_USAGE_URL"]) {
    const value = source[name];
    if (typeof value === "string" && value) env[name] = value;
  }
  env.PLAN_CARD_MUNINN_URL = `http://127.0.0.1:${port}`;
  return env;
}

/** A cut as plan-card's `--json` reports it. */
export interface PlanCardCut {
  section: string;
  pointer: string;
  start?: number;
  end?: number;
  file?: string;
}

/** plan-card's `--json` answer, or null when the output is not one. */
export function parsePlanCardJson(stdout: string): { text: string; chars: number; cuts: PlanCardCut[] } | null {
  let j: unknown;
  try {
    j = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (typeof o.text !== "string" || typeof o.chars !== "number" || !Array.isArray(o.cuts)) return null;
  const cuts = o.cuts.filter((c): c is PlanCardCut => !!c && typeof c === "object" && typeof (c as PlanCardCut).section === "string" && typeof (c as PlanCardCut).pointer === "string");
  return { text: o.text, chars: o.chars, cuts };
}
