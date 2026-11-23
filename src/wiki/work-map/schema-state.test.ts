/**
 * The answer schema's state space, enumerated: every field × {null, missing,
 * number, string, object, array with one odd member}, run through parse →
 * normalize → the stored `workMapSchema`. The tolerance rule is the header of
 * `schema.ts`; this file is its test.
 */
import { describe, expect, test } from "bun:test";
import { normalizeWorkMapAnswer, type NormalizeContext } from "./normalize.ts";
import * as schema from "./schema.ts";
import { WORK_MAP_VERSION, workMapAnswerSchema, workMapSchema } from "./schema.ts";
import { normalizeThemeAnswer, type ThemeNormalizeContext } from "./theme-normalize.ts";
import { THEME_ANSWER_SHAPES, THEME_MAP_VERSION, themeAnswerSchema, themeMapSchema } from "./theme-schema.ts";

const rel = new Map([
  ["p1", "plans/alpha.mdx"],
  ["p2", "archive/alpha-report.mdx"],
  ["p3", "plans/beta.mdx"],
  ["p4", "blogs/loose.mdx"],
]);
const ctx: NormalizeContext = { rel, nowMs: 0, sessionsSinceMs: 0, gitTouches: new Map(), workEvents: () => undefined };

const fixture = () => ({
  summary: "s",
  needsYou: [{ title: "t", kind: "decision", why: "w", action: "a", pages: ["p1"], effort: "alpha" }],
  themes: [{ name: "T", efforts: ["alpha", "beta"] }],
  efforts: [
    {
      id: "alpha",
      name: "Alpha",
      aliases: ["A"],
      oneLine: "o",
      state: "active",
      parent: "beta",
      pages: [
        { id: "p1", role: "plan", derivedFrom: "p2" },
        { id: "p2", role: "report" },
      ],
      why: "w",
      confidence: 0.8,
      next: "n",
      related: [{ id: "beta", why: "w" }],
    },
    { id: "beta", name: "Beta", aliases: [], oneLine: "", state: "active", pages: [{ id: "p3", role: "plan" }], why: "", confidence: 0.5, next: "", related: [] },
  ],
  loose: ["p4"],
});

type Level = "top" | "effort" | "page" | "related" | "needsYou" | "theme";
/** Where each level's member sits in the fixture. */
const AT: Record<Level, (string | number)[]> = {
  top: [],
  effort: ["efforts", 0],
  page: ["efforts", 0, "pages", 0],
  related: ["efforts", 0, "related", 0],
  needsYou: ["needsYou", 0],
  theme: ["themes", 0],
};
/** The fields of each level, and the rule for each: `req` drops the member
 *  (rejects the night at top level) when invalid, `opt` reads as its default,
 *  `id` is required and also accepts a JSON number. */
type Rule = "req" | "opt" | "id";
const FIELDS: Record<Level, Record<string, Rule>> = {
  top: { summary: "opt", needsYou: "opt", themes: "opt", efforts: "req", loose: "opt" },
  effort: { id: "id", name: "req", aliases: "opt", oneLine: "opt", state: "req", parent: "opt", pages: "req", why: "opt", confidence: "opt", next: "opt", related: "opt" },
  page: { id: "req", role: "req", derivedFrom: "opt" },
  related: { id: "id", why: "opt" },
  needsYou: { title: "req", kind: "req", why: "opt", action: "opt", pages: "opt", effort: "opt" },
  theme: { name: "req", efforts: "opt" },
};
/** The list fields: their default is [], and an odd member is dropped. */
const LISTS = new Set(["top.needsYou", "top.themes", "top.efforts", "top.loose", "effort.aliases", "effort.pages", "effort.related", "needsYou.pages", "theme.efforts"]);

const ODD = Symbol("missing");
const VARIANTS: [string, (v: unknown) => unknown][] = [
  ["null", () => null],
  ["missing", () => ODD],
  ["number", () => 42],
  ["string", () => "zz"],
  ["object", () => ({ x: 1 })],
  ["array+odd", (v) => (Array.isArray(v) ? [...v, null] : [null])],
];

function mutate(level: Level, field: string, make: (v: unknown) => unknown) {
  const a = fixture() as Record<string, unknown>;
  let obj: Record<string, unknown> = a;
  for (const k of AT[level]) obj = (obj as never)[k];
  const v = make(obj[field]);
  if (v === ODD) delete obj[field];
  else obj[field] = v;
  return a;
}

/** Does a value satisfy the field's rule (for a required field)? */
function validRequired(level: Level, field: string, rule: Rule, variant: string): boolean {
  const key = `${level}.${field}`;
  if (LISTS.has(key)) return variant === "array+odd";
  if (rule === "id") return variant === "string" || variant === "number";
  if (field === "name" || field === "title" || (level === "page" && field === "id")) return variant === "string";
  return false; // state, role, kind: "zz" is no enum member
}

type Totals = Record<"efforts" | "pages" | "related" | "aliases" | "needsYou" | "nyPages" | "themes" | "themeEfforts" | "loose", number>;
function totals(a: ReturnType<typeof fixture>): Totals {
  const es = a.efforts;
  return {
    efforts: es.length,
    pages: es.reduce((n, e) => n + e.pages.length, 0),
    related: es.reduce((n, e) => n + e.related.length, 0),
    aliases: es.reduce((n, e) => n + e.aliases.length, 0),
    needsYou: a.needsYou.length,
    nyPages: a.needsYou.reduce((n, x) => n + x.pages.length, 0),
    themes: a.themes.length,
    themeEfforts: a.themes.reduce((n, t) => n + t.efforts.length, 0),
    loose: a.loose.length,
  };
}

/** What a case must keep: the fixture's totals minus exactly what the rule drops. */
function expectedTotals(level: Level, field: string, rule: Rule, variant: string): Totals {
  const f = fixture();
  const t = totals(f);
  const e0 = f.efforts[0]!;
  const dropMember = (rule === "req" || rule === "id") && !validRequired(level, field, rule, variant);
  const listDefaulted = rule === "opt" && LISTS.has(`${level}.${field}`) && variant !== "array+odd";
  if (dropMember) {
    if (level === "effort") {
      t.efforts--;
      t.pages -= e0.pages.length;
      t.related -= e0.related.length;
      t.aliases -= e0.aliases.length;
    } else if (level === "page") t.pages--;
    else if (level === "related") t.related--;
    else if (level === "needsYou") (t.needsYou--, (t.nyPages -= f.needsYou[0]!.pages.length));
    else if (level === "theme") (t.themes--, (t.themeEfforts -= f.themes[0]!.efforts.length));
  }
  if (listDefaulted) {
    const k = `${level}.${field}`;
    if (k === "top.needsYou") (t.needsYou = 0, (t.nyPages = 0));
    if (k === "top.themes") (t.themes = 0, (t.themeEfforts = 0));
    if (k === "top.loose") t.loose = 0;
    if (k === "effort.aliases") t.aliases -= e0.aliases.length;
    if (k === "effort.related") t.related -= e0.related.length;
    if (k === "needsYou.pages") t.nyPages -= f.needsYou[0]!.pages.length;
    if (k === "theme.efforts") t.themeEfforts -= f.themes[0]!.efforts.length;
  }
  return t;
}

const shouldReject = (level: Level, field: string, variant: string) => level === "top" && field === "efforts" && variant !== "array+odd";

function stored(answer: unknown) {
  const parsed = workMapAnswerSchema.safeParse(answer);
  if (!parsed.success) return { parsed };
  const normalized = normalizeWorkMapAnswer(parsed.data, ctx);
  const map = {
    version: WORK_MAP_VERSION,
    wiki: "w",
    runAtMs: 0,
    model: "m",
    coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 0, activePages: rel.size, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
    ...normalized,
  };
  return { parsed, normalized, map: workMapSchema.safeParse(map) };
}

/** Every case's verdict, as one line; "" when it holds. */
function verdict(level: Level, field: string, rule: Rule, variant: string, make: (v: unknown) => unknown): string {
  const { parsed, normalized, map } = stored(mutate(level, field, make));
  if (shouldReject(level, field, variant)) return parsed.success ? "accepted, must reject" : "";
  if (!parsed.success) return `rejected: ${parsed.error.issues[0]?.message}`;
  if (!map!.success) return `stored map invalid: ${map!.error.issues[0]?.path.join(".")}`;
  const placed = [...normalized!.efforts.flatMap((e) => e.pages.map((p) => p.id)), ...normalized!.loose];
  const lost = [...rel.values()].filter((r) => placed.filter((p) => p === r).length !== 1);
  if (lost.length) return `pages not in exactly one place: ${lost.join(",")}`;
  const got = totals(parsed.data as never);
  const want = expectedTotals(level, field, rule, variant);
  const diff = (Object.keys(want) as (keyof Totals)[]).filter((k) => got[k] !== want[k]);
  return diff.length ? `members: ${diff.map((k) => `${k} ${got[k]}≠${want[k]}`).join(" ")}` : "";
}

const CASES = (Object.keys(FIELDS) as Level[]).flatMap((level) =>
  Object.entries(FIELDS[level]).flatMap(([field, rule]) => VARIANTS.map(([variant, make]) => ({ level, field, rule, variant, make }))),
);

describe("work map answer schema, state space", () => {
  test("the fixture itself parses whole and places every page", () => {
    expect(CASES.length).toBe(Object.values(FIELDS).reduce((n, f) => n + Object.keys(f).length, 0) * VARIANTS.length);
    const { parsed, map } = stored(fixture());
    expect(parsed.success && map?.success).toBe(true);
  });

  test("every field × every wrong shape: rejects only a missing or non-array efforts, keeps every valid member, places every active page once", () => {
    const failures = CASES.map((c) => [`${c.level}.${c.field} ${c.variant}`, verdict(c.level, c.field, c.rule, c.variant, c.make)] as const).filter(([, v]) => v);
    expect(failures).toEqual([]);
  });

  test("the enumerated fields are the schema's fields", () => {
    const shapes = (schema as Record<string, unknown>).ANSWER_SHAPES as Record<Level, Record<string, unknown>> | undefined;
    expect(shapes).toBeDefined();
    for (const level of Object.keys(FIELDS) as Level[]) expect([level, Object.keys(shapes![level]).sort()]).toEqual([level, Object.keys(FIELDS[level]).sort()]);
  });

  test("efforts: [] is accepted; a non-empty efforts with no valid member rejects", () => {
    expect(workMapAnswerSchema.safeParse({ ...fixture(), efforts: [] }).success).toBe(true);
    const none = workMapAnswerSchema.safeParse({ ...fixture(), efforts: [null] });
    expect(none.success).toBe(false);
    expect(none.success ? "" : none.error.issues[0]!.message).toContain("(efforts.0:");
  });
});

// --- the themes kind's answer (`theme-schema.ts`) ---------------------------

const themeRel = new Map([
  ["p1", "sources/a.md"],
  ["p2", "sources/b.md"],
  ["p3", "sources/c.md"],
  ["p4", "sources/d.md"],
]);
const themeCtx: ThemeNormalizeContext = {
  rel: themeRel,
  sources: new Map([...themeRel.values()].map((r) => [r, { relPath: r, created: "2026-10-20", domain: "ai" as const }])),
  hubs: [],
  hubByName: new Map([["hub a", "concepts/Hub A.md"]]),
  resolveHub: () => undefined,
  createdDayOf: () => "2026-10-20",
  runDay: "2026-10-31",
  previous: null,
};
const themeFixture = () => ({
  summary: "s",
  themes: [
    { id: "alpha", name: "A", domain: "ai", oneLine: "o", hubs: ["Hub A"], sources: ["p1", "p2"], readFirst: ["p1"], takeaway: "t", disagreement: "d", confidence: 0.8 },
    { id: "beta", name: "B", domain: "ai", oneLine: "", hubs: [], sources: ["p3"], readFirst: [], takeaway: "", disagreement: "", confidence: 0.5 },
  ],
  connections: [{ a: "alpha", b: "beta", why: "w" }],
  worthALook: [{ title: "t", kind: "gap", why: "w", action: "a", sources: ["p1"], hubs: ["Hub A"], theme: "alpha" }],
  loose: ["p4"],
});
type TLevel = "top" | "theme" | "connection" | "worthALook";
const TAT: Record<TLevel, (string | number)[]> = { top: [], theme: ["themes", 0], connection: ["connections", 0], worthALook: ["worthALook", 0] };
const TFIELDS: Record<TLevel, Record<string, Rule>> = {
  top: { summary: "opt", themes: "req", connections: "opt", worthALook: "opt", loose: "opt" },
  theme: { id: "id", name: "req", domain: "opt", oneLine: "opt", hubs: "opt", sources: "req", readFirst: "opt", takeaway: "opt", disagreement: "opt", confidence: "opt" },
  connection: { a: "id", b: "id", why: "opt" },
  worthALook: { title: "req", kind: "req", why: "opt", action: "opt", sources: "opt", hubs: "opt", theme: "opt" },
};
const TLISTS = new Set(["top.themes", "top.connections", "top.worthALook", "top.loose", "theme.hubs", "theme.sources", "theme.readFirst", "worthALook.sources", "worthALook.hubs"]);
type TTotals = Record<"themes" | "sources" | "hubs" | "readFirst" | "connections" | "worth" | "worthSources" | "worthHubs" | "loose", number>;
function tTotals(a: ReturnType<typeof themeFixture>): TTotals {
  return {
    themes: a.themes.length,
    sources: a.themes.reduce((n, t) => n + t.sources.length, 0),
    hubs: a.themes.reduce((n, t) => n + t.hubs.length, 0),
    readFirst: a.themes.reduce((n, t) => n + t.readFirst.length, 0),
    connections: a.connections.length,
    worth: a.worthALook.length,
    worthSources: a.worthALook.reduce((n, w) => n + w.sources.length, 0),
    worthHubs: a.worthALook.reduce((n, w) => n + w.hubs.length, 0),
    loose: a.loose.length,
  };
}
function tExpected(level: TLevel, field: string, rule: Rule, variant: string): TTotals {
  const f = themeFixture();
  const t = tTotals(f);
  const key = `${level}.${field}`;
  const valid = TLISTS.has(key) ? variant === "array+odd" : rule === "id" ? variant === "string" || variant === "number" : field === "name" || field === "title" ? variant === "string" : false;
  if ((rule === "req" || rule === "id") && !valid) {
    const t0 = f.themes[0]!;
    const w0 = f.worthALook[0]!;
    if (level === "theme") (t.themes--, (t.sources -= t0.sources.length), (t.hubs -= t0.hubs.length), (t.readFirst -= t0.readFirst.length));
    if (level === "connection") t.connections--;
    if (level === "worthALook") (t.worth--, (t.worthSources -= w0.sources.length), (t.worthHubs -= w0.hubs.length));
  }
  if (rule === "opt" && TLISTS.has(key) && variant !== "array+odd") {
    if (key === "top.connections") t.connections = 0;
    if (key === "top.worthALook") (t.worth = 0, (t.worthSources = 0), (t.worthHubs = 0));
    if (key === "top.loose") t.loose = 0;
    if (key === "theme.hubs") t.hubs -= f.themes[0]!.hubs.length;
    if (key === "theme.readFirst") t.readFirst -= f.themes[0]!.readFirst.length;
    if (key === "worthALook.sources") t.worthSources -= f.worthALook[0]!.sources.length;
    if (key === "worthALook.hubs") t.worthHubs -= f.worthALook[0]!.hubs.length;
  }
  return t;
}
function tStored(answer: unknown) {
  const parsed = themeAnswerSchema.safeParse(answer);
  if (!parsed.success) return { parsed };
  const normalized = normalizeThemeAnswer(parsed.data, themeCtx);
  const map = {
    version: THEME_MAP_VERSION,
    kind: "themes",
    wiki: "w",
    runAtMs: 0,
    model: "m",
    coverage: { activeSources: themeRel.size, hubs: 0, driftHubs: 0, placed: 0, digestChars: 0, windowDays: 28, warnings: [] },
    ...normalized,
  };
  return { parsed, normalized, map: themeMapSchema.safeParse(map) };
}
function tVerdict(level: TLevel, field: string, rule: Rule, variant: string, make: (v: unknown) => unknown): string {
  const a = themeFixture() as Record<string, unknown>;
  let obj: Record<string, unknown> = a;
  for (const k of TAT[level]) obj = (obj as never)[k];
  const v = make(obj[field]);
  if (v === ODD) delete obj[field];
  else obj[field] = v;
  const { parsed, normalized, map } = tStored(a);
  if (level === "top" && field === "themes" && variant !== "array+odd") return parsed.success ? "accepted, must reject" : "";
  if (!parsed.success) return `rejected: ${parsed.error.issues[0]?.message}`;
  if (!map!.success) return `stored map invalid: ${map!.error.issues[0]?.path.join(".")}`;
  const placed = [...normalized!.efforts.flatMap((e) => e.pages.map((p) => p.id)), ...normalized!.loose];
  const lost = [...themeRel.values()].filter((r) => placed.filter((p) => p === r).length !== 1);
  if (lost.length) return `sources not in exactly one place: ${lost.join(",")}`;
  const got = tTotals(parsed.data as never);
  const want = tExpected(level, field, rule, variant);
  const diff = (Object.keys(want) as (keyof TTotals)[]).filter((k) => got[k] !== want[k]);
  return diff.length ? `members: ${diff.map((k) => `${k} ${got[k]}≠${want[k]}`).join(" ")}` : "";
}
const TCASES = (Object.keys(TFIELDS) as TLevel[]).flatMap((level) =>
  Object.entries(TFIELDS[level]).flatMap(([field, rule]) => VARIANTS.map(([variant, make]) => ({ level, field, rule, variant, make }))),
);

describe("theme answer schema, state space", () => {
  test("the fixture parses whole and places every source", () => {
    const { parsed, map } = tStored(themeFixture());
    expect(parsed.success && map?.success).toBe(true);
  });

  test("every field × every wrong shape: rejects only a missing or non-array themes, keeps every valid member, places every active source once", () => {
    const failures = TCASES.map((c) => [`${c.level}.${c.field} ${c.variant}`, tVerdict(c.level, c.field, c.rule, c.variant, c.make)] as const).filter(([, v]) => v);
    expect(failures).toEqual([]);
  });

  test("the enumerated fields are the schema's fields", () => {
    for (const level of Object.keys(TFIELDS) as TLevel[]) expect([level, Object.keys(THEME_ANSWER_SHAPES[level]).sort()]).toEqual([level, Object.keys(TFIELDS[level]).sort()]);
  });

  test("themes: [] is accepted; a non-empty themes with no valid member rejects; a work answer is no theme answer", () => {
    expect(themeAnswerSchema.safeParse({ ...themeFixture(), themes: [] }).success).toBe(true);
    const none = themeAnswerSchema.safeParse({ ...themeFixture(), themes: [null] });
    expect(none.success ? "" : none.error.issues[0]!.message).toContain("(themes.0:");
    expect(themeAnswerSchema.safeParse(fixture()).success).toBe(false);
  });

  test("a work map cannot hold theme enums", () => {
    const { map } = stored(fixture());
    const raw = { ...(map!.success ? map!.data : {}), efforts: [{ ...(map!.success ? map!.data.efforts[0] : {}), state: "rising" }] };
    expect(workMapSchema.safeParse(raw).success).toBe(false);
  });
});
