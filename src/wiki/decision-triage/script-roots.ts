/** The two triage scripts' `--root <wiki>=<path>` flag and registry lookup. */

import { existsSync } from "node:fs";
import path from "node:path";
import { getWikiRegistry } from "../registry-memo.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { isInsideDir } from "../work-map/dry-run.ts";
import { todaysHourMs } from "../work-map/loop.ts";
import { DECISION_TRIAGE_DIR } from "./log.ts";

/** A flag value that can't mean anything: one line and exit 2, never a stack. */
export class UsageError extends Error {}

export function rootOverrides(flags: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq <= 0 || !flag.slice(0, eq).trim() || !flag.slice(eq + 1).trim()) throw new UsageError(`--root takes <wiki>=<path>, got "${flag}"`);
    out.set(flag.slice(0, eq).trim().toLowerCase(), path.resolve(flag.slice(eq + 1).trim()));
  }
  return out;
}

/** `--since`'s day: a date the calendar has, as the epoch ms of its start. */
export function parseSinceDay(value: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new UsageError(`--since takes a day (YYYY-MM-DD), got "${value}"`);
  return ms;
}

export function parseIsoMoment(flag: string, value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new UsageError(`${flag} takes an ISO time, got "${value}"`);
  return ms;
}

/** `--hand`'s file, or a usage error: a bad sample must not read as a verdict. */
export function parseHandSample(text: string): { read: number; wrong: number } {
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    // Falls through to the error below.
  }
  const { read, wrong } = (raw ?? {}) as { read?: unknown; wrong?: unknown };
  const count = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
  if (!count(read) || !count(wrong)) throw new UsageError('--hand takes a JSON file of {"read": n, "wrong": n}');
  return { read, wrong };
}

/** Each named wiki's entry, by `--root` first, then the registry; unknown names drop out. */
export function triageEntries(overrides: ReadonlyMap<string, string>, names: readonly string[]): WikiRegistryEntry[] {
  return names.flatMap((name) => {
    const given = overrides.get(name.toLowerCase());
    if (given) return [{ name, root: given, source: "extra" as const }];
    const found = getWikiRegistry().find((e) => e.name.toLowerCase() === name.toLowerCase());
    return found ? [found] : [];
  });
}

/** Has today's night had its chance? Its hour plus one, so a run still going is not absent. */
export function todayNightDue(nowMs: number, hour: number): boolean {
  const boundary = todaysHourMs(nowMs, hour);
  return boundary !== null && nowMs >= boundary + 3_600_000;
}

/** Would `--out` land in the log folder? A folder not there yet holds nothing, but
 *  the append would create it, so a path under its name still counts. */
export function outInsideLog(out: string, dir: string = DECISION_TRIAGE_DIR): boolean {
  if (existsSync(dir)) return isInsideDir(dir, out);
  const rel = path.relative(dir, path.resolve(out));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
