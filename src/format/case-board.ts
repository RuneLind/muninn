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
import { anchorSlug, formatCount } from "./query-block.ts";
import { maskSpans, SEGMENT_PROTECTED_RES, splitOutside } from "./report-top.ts";

/** The status vocabulary, in the board's group order. */
export const CASE_STATUSES = ["hold", "wait", "wrong", "none", "ok"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
/** Rows a board renders; the count strip still counts every case. */
export const CASEBOARD_MAX_CASES = 500;

export interface BoardCase {
  id: string;
  /** `case-` + `anchorSlug(id)`, the first free `-2`, `-3` for a repeat among
   *  this board's cases in FILE order, never another case's own anchor; empty
   *  when the id has no usable character. */
  anchor: string;
  /** `unknown` for a status outside {@link CASE_STATUSES} (or none at all). */
  status: CaseStatus | "unknown";
  /** The status as written, for the unknown pill's title. */
  rawStatus: string;
  owner: string;
  note: string;
  /** The optional one-line summary the reader shows (D42); empty when absent. */
  kort: string;
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
      /** Entries that are not a mapping, or a mapping with no `id` key. */
      skipped: number;
      /** Entries whose `id` is empty (`id:`, `~`, `null`), skipped. */
      emptyIds: number;
      /** Values YAML read as something other than text, rendered as that:
       *  `id 123` for `id: 0123`. */
      coerced: string[];
      /** note/owner/ref values that are a list or a mapping, dropped. */
      dropped: number;
    }
  | { ok: false; reason: string };

type YamlParse = (text: string) => unknown;

function bunYaml(): YamlParse | null {
  const y = (globalThis as { Bun?: { YAML?: { parse?: YamlParse } } }).Bun?.YAML;
  return typeof y?.parse === "function" ? y.parse : null;
}

/** A YAML scalar as text: a string trimmed; a number or boolean as YAML 1.2
 *  would write it back (`.inf`, `.nan`); null for null, a list or a mapping. */
function scalarText(v: unknown): string | null {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") {
    if (Number.isNaN(v)) return ".nan";
    if (!Number.isFinite(v)) return v > 0 ? ".inf" : "-.inf";
    return String(v);
  }
  if (typeof v === "boolean") return String(v);
  return null;
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** What reading one entry noted besides the case. */
interface Notes {
  coerced: string[];
  dropped: number;
}

/** One field as text: a non-text scalar is named in `notes.coerced`, a list
 *  or mapping counted in `notes.dropped` and read as empty. */
function field(name: string, v: unknown, notes: Notes): string {
  if (v === undefined || v === null) return "";
  const t = scalarText(v);
  if (t === null) {
    notes.dropped++;
    return "";
  }
  if (typeof v !== "string") notes.coerced.push(`${name} ${t}`);
  return t;
}

/** One list entry as a case; `"skip"` when it is not a mapping with an `id`
 *  key, `"empty"` when that id is empty. */
function toCase(entry: unknown, notes: Notes): Omit<BoardCase, "anchor"> | "skip" | "empty" {
  if (!isMapping(entry) || !("id" in entry)) return "skip";
  const idNotes: Notes = { coerced: [], dropped: 0 };
  const id = field("id", entry.id, idNotes);
  if (!id) return idNotes.dropped ? "skip" : "empty";
  notes.coerced.push(...idNotes.coerced);
  const rawStatus = scalarText(entry.status) ?? "";
  const s = rawStatus.toLowerCase();
  const status = (CASE_STATUSES as readonly string[]).includes(s) ? (s as CaseStatus) : "unknown";
  const refsRaw = Array.isArray(entry.refs) ? entry.refs : entry.refs === undefined ? [] : [entry.refs];
  return {
    id,
    status,
    rawStatus,
    owner: field("owner", entry.owner, notes),
    // A YAML block scalar keeps its line ends; a note is one inline run.
    note: field("note", entry.note, notes).replace(/\s*\n\s*/g, " "),
    kort: field("kort", entry.kort, notes).replace(/\s*\n\s*/g, " "),
    refs: refsRaw.map((r) => field("refs", r, notes)).filter(Boolean),
  };
}

/** True when the text holds a `---` after its first content line, or content
 *  after a `...` document end: Bun reads either as several documents. A
 *  leading `---` before any content, and a trailing `...` followed only by
 *  blank or comment lines, are one document. Read off the text, because the
 *  parse result cannot tell several documents from a list of lists. */
function hasSeveralDocuments(text: string): boolean {
  let seenContent = false;
  let ended = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (/^---(\s|$)/.test(line)) {
      if (seenContent) return true;
      continue;
    }
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\.\.\.(\s|$)/.test(line)) {
      ended = true;
      continue;
    }
    if (ended) return true;
    seenContent = true;
  }
  return false;
}

/**
 * The file's text as a board. The top level must be a list; an entry that is
 * not a mapping with an `id` is skipped and counted, an empty id separately.
 * A YAML error, several documents, or a top level that is not a list is
 * `ok: false` with a one-line reason.
 */
export function parseCaseBoard(text: string, parse: YamlParse | null = bunYaml()): CaseBoardData {
  if (!parse) return { ok: false, reason: "YAML cannot be read here" };
  if (hasSeveralDocuments(text)) return { ok: false, reason: "Multiple YAML documents (---); use one list" };
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
  const valid: Omit<BoardCase, "anchor">[] = [];
  const notes: Notes = { coerced: [], dropped: 0 };
  let skipped = 0;
  let emptyIds = 0;
  for (const entry of doc) {
    const c = toCase(entry, notes);
    if (c === "skip") skipped++;
    else if (c === "empty") emptyIds++;
    else {
      counts[c.status]++;
      valid.push(c);
    }
  }
  // Every case's own anchor is reserved first, so a repeat's suffix never
  // takes an id an author wrote (`A`, `A`, `A-2` → `case-a`, `case-a-3`, `case-a-2`).
  const reserved = new Set(valid.map((c) => caseAnchor(c.id)).filter(Boolean));
  const used = new Set<string>();
  const all: BoardCase[] = valid.map((c) => ({ ...c, anchor: uniqueCaseAnchor(c.id, used, reserved) }));
  return {
    ok: true,
    cases: all.slice(0, CASEBOARD_MAX_CASES),
    total: all.length,
    counts,
    skipped,
    emptyIds,
    coerced: notes.coerced,
    dropped: notes.dropped,
  };
}

/** `case-<slug>`, or `""` when the id has no usable character. */
function caseAnchor(id: string): string {
  const slug = anchorSlug(id);
  return slug ? `case-${slug}` : "";
}

/** The case's own anchor the first time; a repeat is suffixed `-2`, `-3`
 *  past the anchors in `used` and every case's own anchor (`reserved`). */
function uniqueCaseAnchor(id: string, used: Set<string>, reserved: Set<string>): string {
  const base = caseAnchor(id);
  if (!base) return "";
  let anchor = base;
  if (used.has(anchor)) {
    let k = 2;
    while (used.has(`${base}-${k}`) || reserved.has(`${base}-${k}`)) k++;
    anchor = `${base}-${k}`;
  }
  used.add(anchor);
  return anchor;
}

/** The strip's parts in group order, zero counts left out:
 *  `[[2, "hold"], [1, "wait"], [43, "none"]]`. */
export function caseCountParts(counts: CaseCounts): [number, CaseStatus | "unknown"][] {
  return ([...CASE_STATUSES, "unknown"] as const).filter((s) => counts[s] > 0).map((s) => [counts[s], s]);
}

/** The board's warning lines, in a fixed order, as plain text. */
export function caseBoardWarnings(b: Extract<CaseBoardData, { ok: true }>): string[] {
  const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;
  return [
    b.skipped > 0 ? `${plural(b.skipped, "entry", "entries")} without an id skipped` : "",
    b.emptyIds > 0 ? `${plural(b.emptyIds, "entry", "entries")} with an empty id skipped` : "",
    b.coerced.length > 0
      ? `Read as numbers or other non-text, quote them to keep them as written: ${b.coerced.join(", ")}`
      : "",
    b.dropped > 0 ? `${plural(b.dropped, "value", "values")} that ${b.dropped === 1 ? "is" : "are"} a list or mapping dropped (note, kort, owner or refs)` : "",
  ].filter(Boolean);
}

/** The shown cases grouped by status, in {@link CASE_STATUSES} order, then
 *  `unknown`; file order within a group. */
export function groupCases(cases: BoardCase[]): { status: CaseStatus | "unknown"; cases: BoardCase[] }[] {
  return ([...CASE_STATUSES, "unknown"] as const)
    .map((status) => ({ status, cases: cases.filter((c) => c.status === status) }))
    .filter((g) => g.cases.length > 0);
}

// ── The reader's compact line and the labels attribute (D42) ─────────────────

/** Emphasis a « · » inside is no head separator: `**…**`, `__…__`, `*…*`, `_…_`. */
const EMPHASIS_RES: readonly RegExp[] = [
  /\*\*(?!\s)[^*\n]+?\*\*/g,
  /__(?!\s)[^_\n]+?__/g,
  /(?<![*\p{L}\p{N}])\*(?![\s*])[^*\n]+?\*/gu,
  /(?<![_\p{L}\p{N}])_(?![\s_])[^_\n]+?_/gu,
];
/** Everything a head separator may not sit inside: StatusRows' set (code
 *  spans, wikilinks, links, tags) and emphasis. */
const HEAD_PROTECTED_RES: readonly RegExp[] = [...SEGMENT_PROTECTED_RES, ...EMPHASIS_RES];

/** The note's head: the text before its first « · » outside inline markup;
 *  empty when it has none. */
export function caseNoteHead(note: string): string {
  const segs = splitOutside(note, HEAD_PROTECTED_RES);
  return segs.length > 1 ? segs[0]!.trim() : "";
}

/** The compact line's summary: `kort:`, else the note's first `**bold**` span
 *  after the head and outside code spans, else empty. */
export function caseKort(c: Pick<BoardCase, "kort" | "note">): string {
  if (c.kort) return c.kort;
  const segs = splitOutside(c.note, HEAD_PROTECTED_RES);
  const from = segs.length > 1 ? segs[0]!.length : 0;
  // Code spans masked to the same length, so offsets read the note itself.
  const masked = maskSpans(c.note, SEGMENT_PROTECTED_RES.slice(0, 1));
  const bold = /\*\*(?!\s)([^*\n]+?)\*\*/g;
  for (let m = bold.exec(masked); m; m = bold.exec(masked)) {
    if (m.index >= from) return c.note.slice(m.index + 2, m.index + m[0].length - 2).trim();
  }
  return "";
}

export type CaseLabels = Partial<Record<CaseStatus, string>>;

/** `labels="hold:holdt ute,wait:venter"` read into status → label. A key that
 *  is not a case status, or an entry with no `:` or an empty side, is kept in
 *  `bad` (the linter names it) and ignored. Keys are case-folded; a key given
 *  twice keeps its last label and is listed in `duplicates`. */
export function parseCaseLabels(raw: string | undefined): {
  labels: CaseLabels;
  bad: string[];
  /** Keys given more than once, each with the label that applies (the last). */
  duplicates: { key: CaseStatus; label: string }[];
} {
  const labels: CaseLabels = {};
  const bad: string[] = [];
  const seen = new Set<CaseStatus>();
  const repeated = new Set<CaseStatus>();
  for (const entry of (raw ?? "").split(",")) {
    const e = entry.trim();
    if (!e) continue;
    const at = e.indexOf(":");
    const key = (at > 0 ? e.slice(0, at) : "").trim().toLowerCase();
    const label = at > 0 ? e.slice(at + 1).trim() : "";
    if (!label || !(CASE_STATUSES as readonly string[]).includes(key)) {
      bad.push(e);
      continue;
    }
    const status = key as CaseStatus;
    if (seen.has(status)) repeated.add(status);
    seen.add(status);
    labels[status] = label;
  }
  return { labels, bad, duplicates: [...repeated].map((key) => ({ key, label: labels[key]! })) };
}

/** A status as the board shows it: its label, else the status itself. */
export function caseStatusLabel(status: CaseStatus | "unknown", labels: CaseLabels): string {
  return status === "unknown" ? status : (labels[status] ?? status);
}
