/**
 * `<CaseBoard src="cases.yaml" />`: a report page's tracked cases from a YAML
 * list beside the page. Wiki-only, like `Query`: not in
 * `COMPONENT_VOCABULARY_RULES`.
 *
 * Pure: the file arrives as text through the page's `PageFiles` lookup. The
 * YAML parser is Bun's (`Bun.YAML.parse`), read off `globalThis` because the
 * chat bundle carries `web-format.ts` into a browser, where no file is ever
 * loaded and so no parse runs.
 */
import { anchorSlug } from "./query-block.ts";

/** The status vocabulary, in the board's group order. */
export const CASE_STATUSES = ["hold", "wait", "wrong", "none", "ok"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
/** Rows a board renders; the count strip still counts every case. */
export const CASEBOARD_MAX_CASES = 500;

export interface BoardCase {
  id: string;
  /** `anchorSlug(id)`; empty when the id has no usable character. */
  anchor: string;
  /** `unknown` for a status outside {@link CASE_STATUSES} (or none at all). */
  status: CaseStatus | "unknown";
  /** The status as written, for the unknown pill's title. */
  rawStatus: string;
  owner: string;
  note: string;
  refs: string[];
}

export type CaseCounts = Record<CaseStatus | "unknown", number>;

export type CaseBoardData =
  | {
      ok: true;
      /** At most {@link CASEBOARD_MAX_CASES}, in file order. */
      cases: BoardCase[];
      /** Every valid case, shown or not. */
      total: number;
      counts: CaseCounts;
      /** Entries that are not a mapping with an `id`. */
      skipped: number;
    }
  | { ok: false; reason: string };

type YamlParse = (text: string) => unknown;

function bunYaml(): YamlParse | null {
  const y = (globalThis as { Bun?: { YAML?: { parse?: YamlParse } } }).Bun?.YAML;
  return typeof y?.parse === "function" ? y.parse : null;
}

/** A YAML scalar as text; null for a mapping, a list or null. */
function scalar(v: unknown): string | null {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return null;
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One list entry as a case, or null when it is not a mapping with an id. */
function toCase(entry: unknown): BoardCase | null {
  if (!isMapping(entry)) return null;
  const id = scalar(entry.id);
  if (!id) return null;
  const rawStatus = scalar(entry.status) ?? "";
  const s = rawStatus.toLowerCase();
  const status = (CASE_STATUSES as readonly string[]).includes(s) ? (s as CaseStatus) : "unknown";
  const refsRaw = Array.isArray(entry.refs) ? entry.refs : entry.refs === undefined ? [] : [entry.refs];
  return {
    id,
    anchor: anchorSlug(id),
    status,
    rawStatus,
    owner: scalar(entry.owner) ?? "",
    // A YAML block scalar keeps its line ends; a note is one inline run.
    note: (scalar(entry.note) ?? "").replace(/\s*\n\s*/g, " "),
    refs: refsRaw.map(scalar).filter((r): r is string => !!r),
  };
}

/**
 * The file's text as a board. The top level must be a list; an entry that is
 * not a mapping with a scalar `id` is skipped and counted. A YAML error, or a
 * top level that is not a list, is `ok: false` with a one-line reason.
 */
export function parseCaseBoard(text: string, parse: YamlParse | null = bunYaml()): CaseBoardData {
  if (!parse) return { ok: false, reason: "YAML cannot be read here" };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/^YAML Parse error:\s*/, "");
    return { ok: false, reason: `YAML error: ${msg.split("\n")[0]}` };
  }
  if (doc === null || doc === undefined) doc = [];
  if (!Array.isArray(doc)) return { ok: false, reason: "Expected a list of cases" };
  const counts: CaseCounts = { hold: 0, wait: 0, wrong: 0, none: 0, ok: 0, unknown: 0 };
  const all: BoardCase[] = [];
  let skipped = 0;
  for (const entry of doc) {
    const c = toCase(entry);
    if (!c) {
      skipped++;
      continue;
    }
    counts[c.status]++;
    all.push(c);
  }
  return { ok: true, cases: all.slice(0, CASEBOARD_MAX_CASES), total: all.length, counts, skipped };
}

/** The strip's parts in group order, zero counts left out:
 *  `[[2, "hold"], [1, "wait"], [43, "none"]]`. */
export function caseCountParts(counts: CaseCounts): [number, CaseStatus | "unknown"][] {
  return ([...CASE_STATUSES, "unknown"] as const).filter((s) => counts[s] > 0).map((s) => [counts[s], s]);
}

/** The count strip as plain text: `2 hold · 1 wait · 43 none`, or `0 cases`. */
export function caseCountText(counts: CaseCounts): string {
  const parts = caseCountParts(counts);
  return parts.length ? parts.map(([n, s]) => `${n} ${s}`).join(" · ") : "0 cases";
}

/** The shown cases grouped by status, in {@link CASE_STATUSES} order, then
 *  `unknown`; file order within a group. */
export function groupCases(cases: BoardCase[]): { status: CaseStatus | "unknown"; cases: BoardCase[] }[] {
  return ([...CASE_STATUSES, "unknown"] as const)
    .map((status) => ({ status, cases: cases.filter((c) => c.status === status) }))
    .filter((g) => g.cases.length > 0);
}
