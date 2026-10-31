/**
 * The `themes` kind's two shapes (plan `muninn-wiki-theme-map`, Design): what
 * the theme model returns (`ThemeMapAnswer`) and what `.work-map.json` holds
 * for a themes wiki (`ThemeMap`). A sibling of `schema.ts`, never a widening of
 * it: a work map keeps its own enums, so no work-map reader changes.
 *
 * The answer's tolerance rule is `schema.ts`'s (its header), applied to this
 * shape and enumerated by `schema-state.test.ts`:
 * - an OPTIONAL field of the wrong type reads as its default;
 * - a member failing a REQUIRED field is dropped alone. Required: a theme's
 *   id, name and `sources` array; a connection's two ends; a worth-a-look
 *   item's title and kind;
 * - an id given as a JSON number reads as its string form;
 * - the night rejects only when `themes` is not an array, or is non-empty with
 *   no valid member.
 */

import { z } from "zod";

import { effortId, effortRef, list, members, optionalString, prose, validMembers } from "./schema.ts";

export const THEME_STATES = ["new", "rising", "steady", "fading"] as const;
export const THEME_PAGE_ROLES = ["source"] as const;
export const THEME_NEEDS_KINDS = ["gap", "drift", "contradiction", "shift"] as const;
export const THEME_DOMAINS = ["ai", "life"] as const;

export type ThemeState = (typeof THEME_STATES)[number];
export type ThemeNeedsKind = (typeof THEME_NEEDS_KINDS)[number];
export type ThemeDomain = (typeof THEME_DOMAINS)[number];

/** A domain the model may omit or misspell: reads as absent. */
const optionalDomain = z.enum(THEME_DOMAINS).nullish().catch(undefined).transform((v) => v ?? undefined);

const answerTheme = z.object({
  id: effortRef,
  name: z.string(),
  domain: optionalDomain,
  oneLine: prose,
  hubs: list(z.string()),
  sources: members(z.string()),
  readFirst: list(z.string()),
  takeaway: prose,
  disagreement: prose,
  confidence: z.number().nullish().catch(0).transform((v) => v ?? 0),
});

const answerConnection = z.object({ a: effortRef, b: effortRef, why: prose });

const answerWorthALook = z.object({
  title: z.string(),
  kind: z.enum(THEME_NEEDS_KINDS),
  why: prose,
  action: prose,
  sources: list(z.string()),
  hubs: list(z.string()),
  theme: z.union([z.number().transform(String), optionalString]).catch(undefined),
});

/** The theme model's answer, after `extractJson`. Only `themes` is required. */
export const themeAnswerSchema = z.object({
  summary: prose,
  themes: z.array(z.unknown()).transform((arr, ctx) => {
    const valid = validMembers(answerTheme, arr);
    if (arr.length > 0 && valid.length === 0) {
      const first = answerTheme.safeParse(arr[0]);
      const issue = first.success ? undefined : first.error.issues[0];
      ctx.addIssue({ code: "custom", message: `no theme matched the schema${issue ? ` (${["themes", 0, ...issue.path].join(".")}: ${issue.message})` : ""}` });
      return z.NEVER;
    }
    return valid;
  }) as unknown as z.ZodType<z.output<typeof answerTheme>[], z.input<typeof answerTheme>[]>,
  connections: list(answerConnection),
  worthALook: list(answerWorthALook),
  loose: list(z.string()),
});

/** Each level's fields, for the state-space test. */
export const THEME_ANSWER_SHAPES = {
  top: themeAnswerSchema.shape,
  theme: answerTheme.shape,
  connection: answerConnection.shape,
  worthALook: answerWorthALook.shape,
};

export type ThemeMapAnswer = z.infer<typeof themeAnswerSchema>;
export type ThemeMapAnswerInput = z.input<typeof themeAnswerSchema>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Source counts for one ISO week (Monday `start`), for the strip. */
const weeklyCount = z.object({
  /** ISO week, `2026-W44`. */
  week: z.string(),
  /** The week's Monday, `YYYY-MM-DD`. */
  start: day,
  count: z.number().int().nonnegative(),
  /** The count may miss days: a first run's straddling week, or a week the
   *  previous run carried before it ended. */
  partial: z.boolean().optional(),
});

const storedTheme = z.object({
  id: effortId,
  name: z.string(),
  oneLine: z.string(),
  state: z.enum(THEME_STATES),
  domain: z.enum(THEME_DOMAINS),
  pages: z.array(z.object({ id: z.string(), role: z.enum(THEME_PAGE_ROLES) })),
  /** Anchor hub pages, relPaths. */
  hubs: z.array(z.string()),
  /** Sources to read first, relPaths inside `pages`. */
  readFirst: z.array(z.string()),
  takeaway: z.string(),
  disagreement: z.string(),
  confidence: z.number(),
  related: z.array(z.object({ id: effortId, why: z.string() })),
  weekly: z.array(weeklyCount),
  /** The trend windows the state came from: sources created in the last 14
   *  days and in days 15–28. */
  trend: z.object({ recent: z.number().int().nonnegative(), earlier: z.number().int().nonnegative() }),
});

const retiredTheme = z.object({
  id: effortId,
  name: z.string(),
  /** Newest `created` (ms, UTC midnight) among its last members. */
  lastActive: z.number(),
  weekly: z.array(weeklyCount),
});

const themeCoverage = z.object({
  /** Source pages created in the window. */
  activeSources: z.number(),
  /** Hub pages in the digest (linked by at least two active sources). */
  hubs: z.number(),
  /** Of those, the hubs that qualify as drift. */
  driftHubs: z.number(),
  /** Active sources some theme holds after normalize. */
  placed: z.number(),
  digestChars: z.number(),
  windowDays: z.number(),
  warnings: z.array(z.string()),
});

export const THEME_MAP_VERSION = 1;

/** `.work-map.json` for a `themes` wiki. */
export const themeMapSchema = z.object({
  version: z.literal(THEME_MAP_VERSION),
  kind: z.literal("themes"),
  wiki: z.string(),
  runAtMs: z.number(),
  model: z.string(),
  coverage: themeCoverage,
  summary: z.string(),
  needsYou: z.array(
    z.object({
      title: z.string(),
      kind: z.enum(THEME_NEEDS_KINDS),
      why: z.string(),
      action: z.string(),
      pages: z.array(z.string()),
      effort: effortId.optional(),
      hubs: z.array(z.string()),
      /** Runner-set: a drift item's `sinceUpdate`; else the sources it cites. */
      count: z.number().int().nonnegative(),
    }),
  ),
  /** Domain groups («AI & tech», «Life»), each naming its themes. */
  themes: z.array(z.object({ name: z.string(), efforts: z.array(effortId) })),
  efforts: z.array(storedTheme),
  retired: z.array(retiredTheme),
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

export type ThemeMap = z.infer<typeof themeMapSchema>;
export type ThemeMapTheme = ThemeMap["efforts"][number];
export type ThemeMapRetired = ThemeMap["retired"][number];
export type ThemeWeek = z.infer<typeof weeklyCount>;
export type ThemeNeedsYou = ThemeMap["needsYou"][number];

/** Parse stored JSON text; null on any mismatch. */
export function parseThemeMap(text: string): ThemeMap | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = themeMapSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
