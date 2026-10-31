/**
 * The work map's two shapes: what the organize model returns (`WorkMapAnswer`)
 * and what `.work-map.json` holds (`WorkMap`), the second read by P2–P4.
 *
 * Effort ids are plain strings in the answer schema, so one odd id cannot
 * reject a night's run; `normalize.ts` slugifies them and drops what is still
 * invalid. The stored schema holds only ids that pass {@link EFFORT_ID_RE}.
 *
 * One tolerance rule for the whole answer (enumerated by `schema-state.test.ts`):
 * - an OPTIONAL field of the wrong type reads as its default: `""` for prose,
 *   `[]` for a list, `0` for confidence, absent for a reference;
 * - a member failing a REQUIRED field is dropped alone. Required: an effort's
 *   id, name, state and `pages` array; a page's id and role; a needs-you
 *   item's title and kind; a theme's name; a related entry's id;
 * - an effort id given as a JSON number (effort, related, theme member) reads
 *   as its string form;
 * - the night rejects only when `efforts` is not an array, or is non-empty
 *   with no valid member. `efforts: []` is accepted.
 * A page a dropped member named still reaches loose: `normalize.ts` puts every
 * active page in no effort into loose.
 */

import { z } from "zod";

import { EFFORT_ID_RE } from "./ids.ts";
export { EFFORT_ID_RE };

export const NEEDS_YOU_KINDS = ["decision", "blocked", "followup", "resume", "stale", "drift", "verify"] as const;
export const EFFORT_STATES = ["active", "cooling", "quiet", "shipped", "blocked", "proposed"] as const;
export const PAGE_ROLES = ["plan", "report", "explainer", "prototype", "reference", "followup", "log", "spin-off"] as const;

export type EffortState = (typeof EFFORT_STATES)[number];
export type PageRole = (typeof PAGE_ROLES)[number];

/** Optional on the wire: `null`, a blank or a non-string means "none". */
export const optionalString = z
  .string()
  .nullish()
  .catch(undefined)
  .transform((v) => (v == null || v.trim() === "" ? undefined : v));
/** Prose a model may omit, null or mistype: reads as "". */
export const prose = z.string().nullish().catch("").transform((v) => v ?? "");

/** The members of `arr` that pass `item`; the rest are dropped. */
export function validMembers<T extends z.ZodTypeAny>(item: T, arr: unknown[]): z.output<T>[] {
  return arr.flatMap((m) => {
    const r = item.safeParse(m);
    return r.success ? [r.data as z.output<T>] : [];
  });
}
/** A required string id that also takes a JSON number. */
export const effortRef = z.union([z.string(), z.number().transform(String)]);
/** A required array whose odd members are dropped. */
export const members = <T extends z.ZodTypeAny>(item: T) =>
  z.array(z.unknown()).transform((arr) => validMembers(item, arr)) as unknown as z.ZodType<z.output<T>[], z.input<T>[]>;
/** An optional list: absent or not an array reads as empty; odd members are dropped. */
export const list = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(z.unknown())
    .nullish()
    .catch(undefined)
    .transform((v) => validMembers(item, v ?? [])) as unknown as z.ZodType<z.output<T>[], z.input<T>[] | null | undefined>;

const answerPage = z.object({
  id: z.string(),
  role: z.enum(PAGE_ROLES),
  derivedFrom: optionalString,
});

const answerRelated = z.object({ id: effortRef, why: prose });

/** Required: what the map cannot work without (id, name, state, pages). */
const answerEffort = z.object({
  id: effortRef,
  name: z.string(),
  aliases: list(z.string()),
  oneLine: prose,
  state: z.enum(EFFORT_STATES),
  parent: optionalString,
  pages: members(answerPage),
  why: prose,
  confidence: z.number().nullish().catch(0).transform((v) => v ?? 0),
  next: prose,
  related: list(answerRelated),
});

const answerNeedsYou = z.object({
  title: z.string(),
  kind: z.enum(NEEDS_YOU_KINDS),
  why: prose,
  action: prose,
  pages: list(z.string()),
  effort: optionalString,
});

const answerTheme = z.object({ name: z.string(), efforts: list(effortRef) });

/** The organize model's answer, after `extractJson`. Unknown keys (the
 *  prototype's `corrections` and `views`) are stripped. Only `efforts` is
 *  required at the top level; a non-empty `efforts` with no valid member
 *  rejects, so the run keeps the previous map. */
export const workMapAnswerSchema = z.object({
  summary: prose,
  needsYou: list(answerNeedsYou),
  themes: list(answerTheme),
  efforts: z.array(z.unknown()).transform((arr, ctx) => {
    const valid = validMembers(answerEffort, arr);
    if (arr.length > 0 && valid.length === 0) {
      const first = answerEffort.safeParse(arr[0]);
      const issue = first.success ? undefined : first.error.issues[0];
      ctx.addIssue({ code: "custom", message: `no effort matched the schema${issue ? ` (${["efforts", 0, ...issue.path].join(".")}: ${issue.message})` : ""}` });
      return z.NEVER;
    }
    return valid;
  }) as unknown as z.ZodType<z.output<typeof answerEffort>[], z.input<typeof answerEffort>[]>,
  loose: list(z.string()),
});

/** Each level's fields, for the state-space test. */
export const ANSWER_SHAPES = {
  top: workMapAnswerSchema.shape,
  effort: answerEffort.shape,
  page: answerPage.shape,
  related: answerRelated.shape,
  needsYou: answerNeedsYou.shape,
  theme: answerTheme.shape,
};

export type WorkMapAnswer = z.infer<typeof workMapAnswerSchema>;
/** The answer as the model may write it (optional fields absent). */
export type WorkMapAnswerInput = z.input<typeof workMapAnswerSchema>;

export const effortId = z.string().regex(EFFORT_ID_RE);

const dailyActivity = z.object({
  /** `YYYY-MM-DD`, Europe/Oslo. */
  day: z.string(),
  /** Distinct commits that touched the effort's pages that day. */
  commits: z.number().int().nonnegative(),
  /** Distinct sessions on the effort's pages that day, by session id (an
   *  event with no session id counts alone; inside the sessions window only). */
  sessions: z.number().int().nonnegative(),
});

const storedEffort = z.object({
  id: effortId,
  name: z.string(),
  aliases: z.array(z.string()),
  oneLine: z.string(),
  state: z.enum(EFFORT_STATES),
  parent: effortId.optional(),
  pages: z.array(z.object({ id: z.string(), role: z.enum(PAGE_ROLES), derivedFrom: z.string().optional() })),
  why: z.string(),
  confidence: z.number(),
  next: z.string(),
  related: z.array(z.object({ id: effortId, why: z.string() })),
  daily: z.array(dailyActivity),
});

const retiredEffort = z.object({
  id: effortId,
  name: z.string(),
  /** Newest `gitTouchedMs` or `workedMs` among the pages declaring it; 0 when none has one. */
  lastActive: z.number(),
});

const metadataFilter = z.union([
  z.object({ degraded: z.literal(false) }),
  z.object({ degraded: z.literal(true), reason: z.literal("budget") }),
  z.object({ degraded: z.literal(true), reason: z.literal("steps"), pages: z.number() }),
]);

/** What the run covered, so the card can say it. */
const coverage = z.object({
  /** The sessions memo's window: threads and session events cover it. */
  sessionsSinceMs: z.number(),
  sessionsAsOfMs: z.number(),
  /** Touch times reach back this many days; worked times are all-time. */
  touchWindowDays: z.number(),
  activePages: z.number(),
  threads: z.number(),
  logEntries: z.number(),
  /** Entries inside the window before the cap; above `logEntries` when capped. */
  logEntriesInWindow: z.number().optional(),
  digestChars: z.number(),
  /** The git walk's metadata-only filter; absent without git. */
  metadataFilter: metadataFilter.optional(),
  /** Plain-language warnings the card shows (a degraded walk, a sharp drop in
   *  active pages against the previous run). */
  warnings: z.array(z.string()),
});

export const WORK_MAP_VERSION = 1;

/** `.work-map.json` at the wiki root. */
export const workMapSchema = z.object({
  version: z.literal(WORK_MAP_VERSION),
  wiki: z.string(),
  /** When the run started (its inputs are at least this new). */
  runAtMs: z.number(),
  model: z.string(),
  coverage,
  summary: z.string(),
  needsYou: z.array(
    z.object({
      title: z.string(),
      kind: z.enum(NEEDS_YOU_KINDS),
      why: z.string(),
      action: z.string(),
      pages: z.array(z.string()),
      effort: effortId.optional(),
    }),
  ),
  themes: z.array(z.object({ name: z.string(), efforts: z.array(effortId) })),
  efforts: z.array(storedEffort),
  /** Declared efforts (P6) with no pages tonight: (previous `efforts` ∪
   *  previous `retired`) ∩ declared slugs, minus tonight's `efforts`. Optional,
   *  so a map written before P6 still parses. */
  retired: z.array(retiredEffort).optional(),
  loose: z.array(z.string()),
  usage: z
    .object({
      costUsd: z.number().optional(),
      durationMs: z.number().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
});

export type WorkMap = z.infer<typeof workMapSchema>;
export type WorkMapEffort = WorkMap["efforts"][number];
export type WorkMapCoverage = WorkMap["coverage"];
export type WorkMapDaily = z.infer<typeof dailyActivity>;
export type WorkMapRetired = z.infer<typeof retiredEffort>;

/** Parse stored JSON text; null on any mismatch. */
export function parseWorkMap(text: string): WorkMap | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = workMapSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
