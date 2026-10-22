/**
 * The component contract: every block component's name, attributes, whether it
 * may self-close or appear inline, and each attribute's parser, accepted values
 * and default. The vocabulary constants `markdown-ast.ts` reads
 * (`COMPONENT_NAMES`, `COMPONENT_ATTRS`, `SELF_CLOSING_ALLOWED`,
 * `INLINE_COMPONENT_NAMES`, `LANE_KINDS`) are derived from {@link COMPONENT_SPEC}.
 *
 * A LEAF, and in the browser bundle (`web-format-browser.ts` → `web-format.ts` →
 * `markdown-ast.ts` → here): it imports only `calendar-day.ts`, never
 * `markdown-ast.ts`. Descriptions, teach targets and hints live in
 * `component-docs.ts`, which only the linter and `scripts/component-reference.ts`
 * import.
 *
 * Each attribute's `parse` is the renderer's own function (for Lane `kind`, a
 * two-line adapter over it), never a copy. It returns `{ value, fellBack }`:
 * `fellBack` is true only for a PRESENT value the renderer does not accept; a
 * missing attribute takes its default and never falls back. An empty or
 * whitespace-only value renders exactly like a missing one, so every reader
 * treats it as missing (`tone=""` is the default, not a fallback). A rejected
 * enum value that trims and lower-cases to the default (`tone=" Info "`) renders
 * exactly like the default, so it is no fallback either (`readEnum`).
 */

import { isCalendarDay } from "./calendar-day.ts";

/** What an attribute parser returns. */
export interface AttrRead<T> {
  value: T;
  /** The attribute is present and the renderer does not accept its value. */
  fellBack: boolean;
}

export interface AttrSpec {
  parse: (raw: string | undefined) => AttrRead<unknown>;
  /** The accepted values, for an enumerated attribute. */
  enum?: readonly string[];
  /** What a missing (or rejected) value renders as, when present. */
  default?: string | number;
  /** Missing is itself a fallback (Meter `value`: the label renders as plain text). */
  required?: true;
  /** Values accepted beside the `enum`, each with the enum value it reads as. */
  aliases?: Readonly<Record<string, string>>;
  /** The value's shape, for a typed attribute with no `enum`; absent means a
   *  string. Read by `scripts/component-reference.ts`, never by a renderer. */
  type?: AttrType;
}

/** `iso-date`: YYYY-MM-DD; `date`: that or DD.MM.YYYY; `number`: any finite
 *  number; `positive-number`: one above 0. */
export type AttrType = "iso-date" | "date" | "number" | "positive-number";

export interface ComponentSpec {
  attrs: Readonly<Record<string, AttrSpec>>;
  selfClosing?: true;
  inline?: true;
}

/**
 * An attribute the spec does not check: free text, a value checked elsewhere or
 * one that fails visibly, or one the pipeline writes. Fold `open`/`for` stay
 * here on purpose, though the renderer reads both. Never falls back.
 */
export function parseString(raw: string | undefined): AttrRead<string | undefined> {
  return { value: raw, fellBack: false };
}

/** `raw`, or undefined when it is missing, empty or only white space. */
function present(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

function readEnum<const V extends readonly string[]>(
  values: V,
  fallback: V[number],
  input: string | undefined,
): AttrRead<V[number]> {
  const raw = present(input);
  const ok = raw !== undefined && (values as readonly string[]).includes(raw);
  const asDefault = raw !== undefined && raw.trim().toLowerCase() === fallback;
  return { value: ok ? (raw as V[number]) : fallback, fellBack: raw !== undefined && !ok && !asDefault };
}

// ── Callout ─────────────────────────────────────────────────────────────────

const CALLOUT_TONES = ["info", "warn", "good", "bad"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

export function readCalloutTone(raw: string | undefined): AttrRead<CalloutTone> {
  return readEnum(CALLOUT_TONES, "info", raw);
}

/** Normalize an untrusted `tone` attr for Callout to the four known tones. */
export function normalizeCalloutTone(tone: string | undefined): CalloutTone {
  return readCalloutTone(tone).value;
}

/**
 * A `Callout resolved=` date. Strict `YYYY-MM-DD` that names a real calendar
 * day: anything else is ignored, so a typo renders the callout as an ordinary
 * open one rather than as closed.
 */
export function readResolvedDate(input: string | undefined): AttrRead<string | null> {
  const raw = present(input);
  const v = raw?.trim() ?? "";
  const value = isCalendarDay(v) ? v : null;
  return { value, fellBack: raw !== undefined && value === null };
}

/** A `Callout resolved=` date, or null (see {@link readResolvedDate}). */
export function parseResolvedDate(value: string | undefined): string | null {
  return readResolvedDate(value).value;
}

// ── Pill / Verdict ──────────────────────────────────────────────────────────

const PILL_TONES = ["default", "rec", "warn"] as const;

export function readPillTone(raw: string | undefined): AttrRead<(typeof PILL_TONES)[number]> {
  return readEnum(PILL_TONES, "default", raw);
}

/** Normalize an untrusted `tone` attr for Pill. */
export function normalizePillTone(tone: string | undefined): "default" | "rec" | "warn" {
  return readPillTone(tone).value;
}

const VERDICT_VALUES = ["yes", "no"] as const;

/** A `Verdict value=`. Only an exact `no` renders no; anything else renders yes. */
export function readVerdictValue(raw: string | undefined): AttrRead<(typeof VERDICT_VALUES)[number]> {
  return readEnum(VERDICT_VALUES, "yes", raw);
}

/** Normalize an untrusted `value` attr for Verdict. */
export function normalizeVerdictValue(value: string | undefined): "yes" | "no" {
  return readVerdictValue(value).value;
}

// ── Fact ────────────────────────────────────────────────────────────────────

const FACT_VERDICTS = ["ok", "warn", "bad", "unknown"] as const;
export type FactVerdict = (typeof FACT_VERDICTS)[number];

/** The glyphs `Fact v=` accepts beside the words, as the verify prompt writes
 *  them; read with or without the VS16 (U+FE0F). */
export const FACT_VERDICT_GLYPHS: Readonly<Record<string, FactVerdict>> = { "✅": "ok", "⚠️": "warn", "❌": "bad", "❓": "unknown" };

const stripVs16 = (s: string) => s.replace(/\uFE0F/g, "");
const FACT_GLYPH_READ = new Map(Object.entries(FACT_VERDICT_GLYPHS).map(([g, v]) => [stripVs16(g), v]));

/**
 * Fact-check verdict vocabulary, normalized from an untrusted `v` attr.
 *
 * `unknown` is the fallback rather than `ok`: a malformed or absent verdict must
 * never render as a green "confirmed" chip on a passage nothing actually
 * confirmed. The emoji the verify prompt emits (✅/⚠️/❌/❓, with or without the
 * optional VS16) are accepted alongside the words, since the writer derives `v`
 * from those blocks and a stray emoji is more likely than a typo'd word.
 */
export function readFactVerdict(input: string | undefined): AttrRead<FactVerdict> {
  const raw = present(input);
  if (raw === undefined) return { value: "unknown", fellBack: false };
  const v = stripVs16(raw).trim().toLowerCase();
  const value = (FACT_VERDICTS as readonly string[]).includes(v) ? (v as FactVerdict) : FACT_GLYPH_READ.get(v);
  return value === undefined ? { value: "unknown", fellBack: true } : { value, fellBack: false };
}

export function normalizeFactVerdict(value: string | undefined): FactVerdict {
  return readFactVerdict(value).value;
}

// ── Meter ───────────────────────────────────────────────────────────────────

const METER_TONES = ["default", "good", "warn", "bad"] as const;
type MeterTone = (typeof METER_TONES)[number];
const METER_DEFAULT_MAX = 5;

export function readMeterTone(raw: string | undefined): AttrRead<MeterTone> {
  return readEnum(METER_TONES, "default", raw);
}

/** Normalize an untrusted `tone` attr for Meter (good/warn/bad → green/amber/red). */
export function normalizeMeterTone(tone: string | undefined): MeterTone {
  return readMeterTone(tone).value;
}

/** A Meter `value`: a finite number, unclamped. Null when missing, empty or
 *  non-numeric — then the Meter renders its label as plain text. */
export function readMeterValue(input: string | undefined): AttrRead<number | null> {
  const raw = present(input);
  if (raw === undefined) return { value: null, fellBack: false };
  const value = Number(raw);
  return Number.isFinite(value) ? { value, fellBack: false } : { value: null, fellBack: true };
}

/** A Meter `max`: a positive number, else the default of 5. */
export function readMeterMax(input: string | undefined): AttrRead<number> {
  const raw = present(input);
  const max = Number(raw);
  if (Number.isFinite(max) && max > 0) return { value: max, fellBack: false };
  return { value: METER_DEFAULT_MAX, fellBack: raw !== undefined };
}

/**
 * Parse + clamp + default the Meter component's attrs, shared by every platform
 * so the value/max/tone logic lives in exactly one place. Returns `null` when
 * `value` is missing or non-numeric — the identical-degrade contract: every
 * platform then renders the children (the label) as plain text. Out-of-range
 * `value` is clamped into `[0, max]`; a missing/non-positive/non-numeric `max`
 * falls back to the default of 5.
 */
export function parseMeterAttrs(
  attrs: Record<string, string>,
): { value: number; max: number; tone: MeterTone } | null {
  const value = readMeterValue(attrs.value).value;
  if (value === null) return null;
  const max = readMeterMax(attrs.max).value;
  return { value: Math.min(Math.max(value, 0), max), max, tone: readMeterTone(attrs.tone).value };
}

// ── Lane ────────────────────────────────────────────────────────────────────

const LANE_KIND_VALUES = ["you", "waiting", "draft", "blocked"] as const;
export type LaneKind = (typeof LANE_KIND_VALUES)[number];

/** A `Lane kind=` value. An unknown or missing kind reads as `waiting` (the move
 *  is someone else's until the page says it is yours); `known: false` lets the
 *  web renderer mark it. */
export function normalizeLaneKind(kind: string | undefined): { kind: LaneKind; known: boolean } {
  const k = kind?.trim().toLowerCase() ?? "";
  return (LANE_KIND_VALUES as readonly string[]).includes(k)
    ? { kind: k as LaneKind, known: true }
    : { kind: "waiting", known: false };
}

function readLaneKind(input: string | undefined): AttrRead<LaneKind> {
  const raw = present(input);
  const { kind, known } = normalizeLaneKind(raw);
  return { value: kind, fellBack: raw !== undefined && !known };
}

/**
 * A `Lane since=` value: an ISO `YYYY-MM-DD` or the kode-wiki's house
 * `DD.MM.YYYY` (one or two digits for day and month), as an ISO calendar day.
 * Null for anything else, a day the calendar does not have included. A rejected
 * value is shown as written and only loses its age.
 */
export function readLaneSince(input: string | undefined): AttrRead<string | null> {
  const raw = present(input);
  const v = raw?.trim() ?? "";
  const nb = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const iso = nb ? `${nb[3]}-${nb[2]!.padStart(2, "0")}-${nb[1]!.padStart(2, "0")}` : v;
  const value = isCalendarDay(iso) ? iso : null;
  return { value, fellBack: raw !== undefined && value === null };
}

/** A `Lane since=` value as an ISO calendar day, or null (see {@link readLaneSince}). */
export function parseLaneSince(value: string | undefined): string | null {
  return readLaneSince(value).value;
}

// ── StatusRows ──────────────────────────────────────────────────────────────

const STATUS_ROWS_VIEWS = ["rows", "tiles"] as const;
export type StatusRowsView = (typeof STATUS_ROWS_VIEWS)[number];

/** A `StatusRows view=` value: `tiles` draws one tile per row on the wiki
 *  reader's page render; anything else reads as `rows`. */
export function readStatusRowsView(raw: string | undefined): AttrRead<StatusRowsView> {
  return readEnum(STATUS_ROWS_VIEWS, "rows", raw);
}

// ── CaseBoard ───────────────────────────────────────────────────────────────

const CASE_BOARD_VIEWS = ["rows", "dots"] as const;
export type CaseBoardView = (typeof CASE_BOARD_VIEWS)[number];

/** A `CaseBoard view=` value: `dots` adds one square per case on the wiki
 *  reader's page render; anything else reads as `rows`. */
export function readCaseBoardView(raw: string | undefined): AttrRead<CaseBoardView> {
  return readEnum(CASE_BOARD_VIEWS, "rows", raw);
}

// ── Chart ───────────────────────────────────────────────────────────────────

export const CHART_KINDS = ["gap", "steps", "gate", "funnel"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** A `Chart kind=` value, read case-sensitively like every other enum. No
 *  default: a missing or unknown kind renders the chart as its table. */
export function readChartKind(input: string | undefined): AttrRead<ChartKind | null> {
  const raw = present(input);
  if (raw === undefined) return { value: null, fellBack: false };
  const ok = (CHART_KINDS as readonly string[]).includes(raw);
  return { value: ok ? (raw as ChartKind) : null, fellBack: !ok };
}

const CHART_NORMALIZE = ["none", "ref"] as const;
export type ChartNormalize = (typeof CHART_NORMALIZE)[number];

/** A `Chart normalize=` value: `ref` plots a steps chart as % of its `ref=` row. */
export function readChartNormalize(raw: string | undefined): AttrRead<ChartNormalize> {
  return readEnum(CHART_NORMALIZE, "none", raw);
}

// ── The table ───────────────────────────────────────────────────────────────

const text: AttrSpec = { parse: parseString };

/**
 * Every component, in the vocabulary's order. Tags outside it are not
 * components: they fall through to text and the platform renderer escapes them.
 * An attribute not listed under a component is dropped by `parseAttrs`.
 */
export const COMPONENT_SPEC = {
  Callout: {
    attrs: {
      tone: { parse: readCalloutTone, enum: CALLOUT_TONES, default: "info" },
      title: text,
      // `resolved="YYYY-MM-DD"` turns the callout into a closed-issue row; any
      // other value is ignored and it renders as usual.
      resolved: { parse: readResolvedDate, type: "iso-date" },
    },
  },
  Verdict: {
    attrs: { value: { parse: readVerdictValue, enum: VERDICT_VALUES, default: "yes" } },
    selfClosing: true,
    inline: true,
  },
  Pill: {
    attrs: { tone: { parse: readPillTone, enum: PILL_TONES, default: "default" } },
    selfClosing: true,
    inline: true,
  },
  Figure: { attrs: { caption: text } },
  FileRef: { attrs: { path: text }, selfClosing: true },
  ComparisonTable: { attrs: {} },
  Meter: {
    attrs: {
      value: { parse: readMeterValue, type: "number", required: true },
      max: { parse: readMeterMax, type: "positive-number", default: METER_DEFAULT_MAX },
      tone: { parse: readMeterTone, enum: METER_TONES, default: "default" },
    },
  },
  Diff: { attrs: {} },
  FileTree: { attrs: {} },
  Checklist: { attrs: {} },
  AnnotatedCode: { attrs: { file: text, lang: text } },
  CodeTabs: { attrs: {} },
  Tab: { attrs: { label: text } },
  // Fact-check annotation pair. `Fact` wraps the checked passage inline and
  // carries its claim number + verdict; the verdict is DENORMALIZED onto the tag
  // on purpose — a streaming block renderer cannot look ahead to the `FactCheck`
  // appendix to colour a chip, and one write emits both sides so they cannot
  // drift. `n` is written by the pipeline and not checked.
  Fact: {
    attrs: { n: text, v: { parse: readFactVerdict, enum: FACT_VERDICTS, default: "unknown", aliases: FACT_VERDICT_GLYPHS } },
    selfClosing: true,
    inline: true,
  },
  // `unknown` counts the ❓ claims — the ones nothing verified. It exists so a
  // deadline-truncated fact check cannot render as a clean ✓/⚠/✗ page: those
  // claims get NO `<Fact>` wrapper and NO appendix section, so without a count
  // they would vanish from the page entirely.
  FactCheck: { attrs: { date: text, ok: text, warn: text, bad: text, unknown: text } },
  // A markdown page embedding a standalone `.html` explainer in its body
  // (`src/format/embed.ts` owns the gate on these values; a bad one fails visibly).
  Embed: { attrs: { src: text, height: text, title: text }, selfClosing: true },
  // A collapsible section. `open="true"` (double-quoted, like every attribute
  // this grammar parses) renders it expanded; a bare `open` is not a component
  // tag at all and the section degrades to visible escaped text. `summary` is a
  // one-line teaser beside the title. `for` names who the fold is for (`dev`,
  // `agent`): the reader's Overview lens hides those two. The text renderers
  // print every fold in full.
  Fold: { attrs: { title: text, open: text, summary: text, for: text } },
  // Sections the page keeps as history: `since` names what superseded them
  // (free text, e.g. `melosys-console#270`), `note` says how.
  Historic: { attrs: { since: text, note: text } },
  // Who has the next move: a `NextMoves` block holding `Lane` blocks, each a
  // markdown list. `who` is the lane's label, `role` a `WIKI_ANSWER_GROUPS` key
  // the label is derived from (beats `who`; `normalizeRoleKey`, checked elsewhere).
  NextMoves: { attrs: {} },
  Lane: {
    attrs: {
      kind: { parse: readLaneKind, enum: LANE_KIND_VALUES, default: "waiting" },
      who: text,
      role: text,
      since: { parse: readLaneSince, type: "date" },
    },
  },
  // One prod query: `csv`/`sql` name files beside the page, `uses` is a
  // comma-separated list. See `src/format/query-block.ts`.
  Query: {
    attrs: { id: text, question: text, answer: text, csv: text, sql: text, run: text, uses: text },
    selfClosing: true,
  },
  // Tracked cases from a YAML list beside the page; `labels` names each status
  // in the wiki's words (`hold:holdt ute,wait:venter`). See `case-board.ts`.
  CaseBoard: { attrs: { src: text, labels: text, view: { parse: readCaseBoardView, enum: CASE_BOARD_VIEWS, default: "rows" } }, selfClosing: true },
  // Run-to-run numbers from a CSV beside the page or a pipe-table body, with a
  // computed delta column. See `src/format/delta-table.ts`; a bad value fails visibly.
  DeltaTable: { attrs: { src: text, better: text, decimal: text }, selfClosing: true },
  // Four wrappers over markdown lists, read by `src/format/genre-lists.ts`.
  // `label` is the lead box's heading (default `TL;DR`).
  Tldr: { attrs: { label: text } },
  Timeline: { attrs: {} },
  DecisionLog: { attrs: {} },
  RunChecklist: { attrs: {} },
  // An open question as an answer card: `id` names its DecisionLog item, `choices`
  // and `to` are `|`-separated. See `src/format/question.ts`, which checks them.
  Question: { attrs: { id: text, choices: text, to: text } },
  // The top of a report page (`src/format/report-top.ts`). `More` is the closed
  // «Mer om saken» part of a `Tldr`; `StatusRows` a list of `**Label:** value` rows.
  // `view="tiles"` draws a tile per row on the reader; `tones` colours tiles by
  // row label (`parseStatusTones`, `report-top.ts`; lint check 11 reports an
  // entry it cannot use, and `tones` outside tile view).
  More: { attrs: {} },
  StatusRows: {
    attrs: {
      view: { parse: readStatusRowsView, enum: STATUS_ROWS_VIEWS, default: "rows" },
      tones: text,
    },
  },
  // A chart over the pipe table it wraps (`chart-block.ts`); the other
  // attributes name the table's columns or rows by header text.
  Chart: {
    attrs: {
      kind: { parse: readChartKind, enum: CHART_KINDS, required: true },
      caption: text,
      value: text,
      target: text,
      gap: text,
      mark: text,
      x: text,
      ref: text,
      normalize: { parse: readChartNormalize, enum: CHART_NORMALIZE, default: "none" },
      bar: text,
      pass: text,
      hold: text,
    },
  },
  // A rule written as a nested list, read as a tree (`rule-tree.ts`).
  RuleTree: {
    attrs: {
      title: text,
      outcomes: text,
    },
  },
  // A «Words on the page» list (`glossary.ts`); the reader marks each term's
  // first use per section: the text before the first heading, then each `#`
  // and `##` heading (a `###` does not start one).
  Glossary: { attrs: {} },
  // An archify diagram: `src` names its JSON (`.architecture.json`,
  // `.workflow.json`, `.lifecycle.json`); the picture is the one `<svg>` of the
  // HTML sibling (`x.html`). See `src/format/diagram-block.ts`.
  Diagram: { attrs: { src: text }, selfClosing: true },
  // The same diagram stepped through: a numbered list whose items name their
  // focus ids in a trailing code span, or self-closed for the file's views.
  // See `src/format/steps-block.ts`.
  Steps: { attrs: { src: text }, selfClosing: true },
  // An edge table (From/Fra, To/Til, Protocol/Protokoll, Status, Evidence/Bevis)
  // drawn as a map of systems. `external` lists the names with no repos/ page
  // (`PDL;Sigrun`), `groups` a node's column (`web=frontend;api=core`). See
  // `src/format/system-map.ts`; lint checks `system-map` and `system-map-drift`.
  SystemMap: { attrs: { caption: text, external: text, groups: text } },
} as const satisfies Record<string, ComponentSpec>;

export type ComponentName = keyof typeof COMPONENT_SPEC;
export type InlineComponentName = {
  [K in ComponentName]: (typeof COMPONENT_SPEC)[K] extends { inline: true } ? K : never;
}[ComponentName];
/** The attribute names of one component. */
export type ComponentAttrName<K extends ComponentName> = keyof (typeof COMPONENT_SPEC)[K]["attrs"] & string;

const SPEC: Readonly<Record<ComponentName, ComponentSpec>> = COMPONENT_SPEC;

export const COMPONENT_NAMES: readonly ComponentName[] = Object.keys(COMPONENT_SPEC) as ComponentName[];

/** Attribute whitelist per component; any other attribute is dropped. */
export const COMPONENT_ATTRS = Object.fromEntries(
  COMPONENT_NAMES.map((n) => [n, Object.keys(SPEC[n].attrs)]),
) as unknown as Record<ComponentName, readonly string[]>;

/** Components allowed to appear self-closing (`<Name …/>`). */
export const SELF_CLOSING_ALLOWED: ReadonlySet<ComponentName> = new Set(
  COMPONENT_NAMES.filter((n) => SPEC[n].selfClosing),
);

/** The components that may also appear mid-text (`scanInlineComponents`). */
export const INLINE_COMPONENT_NAMES = COMPONENT_NAMES.filter(
  (n): n is InlineComponentName => SPEC[n].inline === true,
) as readonly InlineComponentName[];

export const LANE_KINDS = COMPONENT_SPEC.Lane.attrs.kind.enum;
