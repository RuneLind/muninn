/**
 * The work map's two shapes: what the organize model returns (`WorkMapAnswer`)
 * and what `.work-map.json` holds (`WorkMap`), the second read by P2–P4.
 *
 * Effort ids are plain strings in the answer schema, so one odd id cannot
 * reject a night's run; `normalize.ts` slugifies them and drops what is still
 * invalid. The stored schema holds only ids that pass {@link EFFORT_ID_RE}.
 */

import { z } from "zod";

/** An effort id: what the `?effort=` URL and the wiki lint accept. Numeric
 *  slugs are valid. */
export const EFFORT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const NEEDS_YOU_KINDS = ["decision", "blocked", "followup", "resume", "stale", "drift", "verify"] as const;
export const EFFORT_STATES = ["active", "cooling", "quiet", "shipped", "blocked", "proposed"] as const;
export const PAGE_ROLES = ["plan", "report", "explainer", "prototype", "reference", "followup", "log", "spin-off"] as const;

export type EffortState = (typeof EFFORT_STATES)[number];
export type PageRole = (typeof PAGE_ROLES)[number];

/** Optional on the wire: a model that writes `null` means "none". */
const optionalString = z
  .string()
  .nullish()
  .transform((v) => (v == null || v.trim() === "" ? undefined : v));

const answerPage = z.object({
  id: z.string(),
  role: z.enum(PAGE_ROLES),
  derivedFrom: optionalString,
});

const answerEffort = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).nullish().transform((v) => v ?? []),
  oneLine: z.string(),
  state: z.enum(EFFORT_STATES),
  parent: optionalString,
  pages: z.array(answerPage),
  why: z.string(),
  confidence: z.number(),
  next: z.string(),
  related: z.array(z.object({ id: z.string(), why: z.string() })),
});

const answerNeedsYou = z.object({
  title: z.string(),
  kind: z.enum(NEEDS_YOU_KINDS),
  why: z.string(),
  action: z.string(),
  pages: z.array(z.string()),
  effort: z.string(),
});

/** The organize model's answer, after `extractJson`. Unknown keys (the
 *  prototype's `corrections` and `views`) are stripped. */
export const workMapAnswerSchema = z.object({
  summary: z.string(),
  needsYou: z.array(answerNeedsYou),
  themes: z.array(z.object({ name: z.string(), efforts: z.array(z.string()) })),
  efforts: z.array(answerEffort),
  loose: z.array(z.string()),
});

export type WorkMapAnswer = z.infer<typeof workMapAnswerSchema>;
/** The answer as the model may write it (optional fields absent). */
export type WorkMapAnswerInput = z.input<typeof workMapAnswerSchema>;

const effortId = z.string().regex(EFFORT_ID_RE);

const dailyActivity = z.object({
  /** `YYYY-MM-DD`, Europe/Oslo. */
  day: z.string(),
  /** Distinct commits that touched the effort's pages that day. */
  commits: z.number().int().nonnegative(),
  /** Distinct session events on the effort's pages that day (inside the
   *  sessions window only). */
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
