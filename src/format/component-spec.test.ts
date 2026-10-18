import { describe, expect, test } from "bun:test";
import {
  COMPONENT_ATTRS,
  COMPONENT_NAMES,
  COMPONENT_SPEC,
  INLINE_COMPONENT_NAMES,
  LANE_KINDS,
  SELF_CLOSING_ALLOWED,
  normalizeLaneKind,
  parseMeterAttrs,
  readCalloutTone,
  readFactVerdict,
  readLaneSince,
  readMeterMax,
  readMeterTone,
  readMeterValue,
  readPillTone,
  readResolvedDate,
  readVerdictValue,
  type ComponentName,
} from "./component-spec.ts";
import * as ast from "./markdown-ast.ts";
import { isCalendarDay } from "./calendar-day.ts";

// The regression pin: a frozen copy of the hand-written literals these
// constants replaced (markdown-ast.ts, before component-spec.ts). Change it only
// together with a deliberate vocabulary change.
const FROZEN_NAMES = [
  "Callout", "Verdict", "Pill", "Figure", "FileRef", "ComparisonTable", "Meter", "Diff",
  "FileTree", "Checklist", "AnnotatedCode", "CodeTabs", "Tab", "Fact", "FactCheck", "Embed",
  "Fold", "Historic", "NextMoves", "Lane", "Query", "CaseBoard", "DeltaTable", "Tldr",
  "Timeline", "DecisionLog", "RunChecklist", "Question", "More", "StatusRows",
];
const FROZEN_SELF_CLOSING = ["FileRef", "Verdict", "Pill", "Fact", "Embed", "Query", "CaseBoard", "DeltaTable"];
const FROZEN_ATTRS: Record<string, string[]> = {
  Callout: ["tone", "title", "resolved"],
  Verdict: ["value"],
  Pill: ["tone"],
  Figure: ["caption"],
  FileRef: ["path"],
  ComparisonTable: [],
  Meter: ["value", "max", "tone"],
  Diff: [],
  FileTree: [],
  Checklist: [],
  AnnotatedCode: ["file", "lang"],
  CodeTabs: [],
  Tab: ["label"],
  Fact: ["n", "v"],
  FactCheck: ["date", "ok", "warn", "bad", "unknown"],
  Embed: ["src", "height", "title"],
  Fold: ["title", "open", "summary", "for"],
  Historic: ["since", "note"],
  NextMoves: [],
  Lane: ["kind", "who", "role", "since"],
  Query: ["id", "question", "answer", "csv", "sql", "run", "uses"],
  CaseBoard: ["src", "labels"],
  DeltaTable: ["src", "better", "decimal"],
  Tldr: ["label"],
  Timeline: [],
  DecisionLog: [],
  RunChecklist: [],
  Question: ["id", "choices", "to"],
  More: [],
  StatusRows: [],
};
const FROZEN_INLINE = ["Verdict", "Pill", "Fact"];
const FROZEN_LANE_KINDS = ["you", "waiting", "draft", "blocked"];

describe("derived vocabulary equals the frozen literals", () => {
  test("COMPONENT_NAMES, in order", () => {
    expect([...COMPONENT_NAMES] as string[]).toEqual(FROZEN_NAMES);
  });
  test("COMPONENT_ATTRS, per component and in order", () => {
    expect(COMPONENT_ATTRS as Record<string, readonly string[]>).toEqual(FROZEN_ATTRS);
    expect(Object.keys(COMPONENT_ATTRS)).toEqual(FROZEN_NAMES);
  });
  test("SELF_CLOSING_ALLOWED", () => {
    expect(([...SELF_CLOSING_ALLOWED] as string[]).sort()).toEqual([...FROZEN_SELF_CLOSING].sort());
  });
  test("INLINE_COMPONENT_NAMES, in order", () => {
    expect([...INLINE_COMPONENT_NAMES] as string[]).toEqual(FROZEN_INLINE);
  });
  test("LANE_KINDS, in order", () => {
    expect([...LANE_KINDS] as string[]).toEqual(FROZEN_LANE_KINDS);
  });
  test("markdown-ast.ts re-exports the same objects", () => {
    expect(ast.COMPONENT_NAMES).toBe(COMPONENT_NAMES);
    expect(ast.INLINE_COMPONENT_NAMES).toBe(INLINE_COMPONENT_NAMES);
    expect(ast.LANE_KINDS).toBe(LANE_KINDS);
  });
});

describe("readX: fellBack only for a present, unaccepted value", () => {
  const cases: [string, (raw: string | undefined) => { value: unknown; fellBack: boolean }][] = [
    ["readCalloutTone", readCalloutTone],
    ["readResolvedDate", readResolvedDate],
    ["readPillTone", readPillTone],
    ["readVerdictValue", readVerdictValue],
    ["readFactVerdict", readFactVerdict],
    ["readMeterTone", readMeterTone],
    ["readMeterValue", readMeterValue],
    ["readMeterMax", readMeterMax],
    ["readLaneSince", readLaneSince],
  ];
  for (const [name, read] of cases) {
    test(`${name}(undefined) never falls back`, () => {
      expect(read(undefined).fellBack).toBe(false);
    });
  }

  test("every attribute spec: a missing value never falls back", () => {
    for (const name of COMPONENT_NAMES) {
      for (const spec of Object.values(COMPONENT_SPEC[name].attrs as Record<string, { parse: (r?: string) => { fellBack: boolean } }>)) {
        expect(spec.parse(undefined).fellBack).toBe(false);
      }
    }
  });

  test("enum attributes accept every listed value and fall back to the default", () => {
    for (const name of COMPONENT_NAMES) {
      for (const [attr, spec] of Object.entries(
        COMPONENT_SPEC[name].attrs as Record<string, { parse: (r?: string) => { value: unknown; fellBack: boolean }; enum?: readonly string[]; default?: unknown }>,
      )) {
        if (!spec.enum) continue;
        for (const v of spec.enum) expect({ attr, v, ...spec.parse(v) }).toEqual({ attr, v, value: v, fellBack: false });
        expect(spec.parse("zzz")).toEqual({ value: spec.default, fellBack: true });
        expect(spec.parse(undefined)).toEqual({ value: spec.default, fellBack: false });
      }
    }
  });

  test("Verdict maybe renders yes and is a fallback", () => {
    expect(readVerdictValue("maybe")).toEqual({ value: "yes", fellBack: true });
  });

  test("Callout tone", () => {
    expect(readCalloutTone("success")).toEqual({ value: "info", fellBack: true });
    expect(readCalloutTone("warn")).toEqual({ value: "warn", fellBack: false });
  });

  test("Lane kind is trimmed and case-insensitive", () => {
    const kind = COMPONENT_SPEC.Lane.attrs.kind.parse;
    expect(kind("You")).toEqual({ value: "you", fellBack: false });
    expect(kind(" blocked ")).toEqual({ value: "blocked", fellBack: false });
    expect(kind("next")).toEqual({ value: "waiting", fellBack: true });
    expect(normalizeLaneKind("next")).toEqual({ kind: "waiting", known: false });
  });

  test("Fact v accepts the words and the four glyphs, with or without VS16", () => {
    for (const [raw, value] of [["✅", "ok"], ["⚠️", "warn"], ["⚠", "warn"], ["❌", "bad"], ["❓", "unknown"], [" OK ", "ok"], ["unknown", "unknown"]] as const) {
      expect(readFactVerdict(raw)).toEqual({ value, fellBack: false });
    }
    expect(readFactVerdict("yes")).toEqual({ value: "unknown", fellBack: true });
  });

  test("dates", () => {
    expect(readResolvedDate("2026-10-18")).toEqual({ value: "2026-10-18", fellBack: false });
    expect(readResolvedDate("2026-02-30")).toEqual({ value: null, fellBack: true });
    expect(readLaneSince("18.10.2026")).toEqual({ value: "2026-10-18", fellBack: false });
    expect(readLaneSince("1.2.2026")).toEqual({ value: "2026-02-01", fellBack: false });
    expect(readLaneSince("last week")).toEqual({ value: null, fellBack: true });
  });

  test("Meter value is required; clamping is not a fallback", () => {
    expect(COMPONENT_SPEC.Meter.attrs.value.required).toBe(true);
    expect(readMeterValue("")).toEqual({ value: null, fellBack: true });
    expect(readMeterValue("abc")).toEqual({ value: null, fellBack: true });
    expect(readMeterValue("9")).toEqual({ value: 9, fellBack: false });
    expect(readMeterMax("0")).toEqual({ value: 5, fellBack: true });
    expect(readMeterMax("10")).toEqual({ value: 10, fellBack: false });
    expect(parseMeterAttrs({ value: "9", max: "4" })).toEqual({ value: 4, max: 4, tone: "default" });
    expect(parseMeterAttrs({ value: "x" })).toBeNull();
    expect(parseMeterAttrs({})).toBeNull();
  });
});

describe("the wrappers keep their old answers", () => {
  const raws = [undefined, "", " ", "info", "warn", "good", "bad", "rec", "default", "no", "yes", "maybe", "ok", "✅", "⚠️", "❌", "❓", "WARN", " 2026-01-02 ", "2026-01-02", "02.01.2026", "2.1.2026", "31.02.2026", "you", "You"];
  // The pre-move bodies, verbatim.
  const old = {
    normalizeCalloutTone: (t?: string) => (t === "warn" || t === "good" || t === "bad" ? t : "info"),
    normalizePillTone: (t?: string) => (t === "rec" || t === "warn" ? t : "default"),
    normalizeVerdictValue: (v?: string) => (v === "no" ? "no" : "yes"),
    normalizeMeterTone: (t?: string) => (t === "good" || t === "warn" || t === "bad" ? t : "default"),
    normalizeFactVerdict: (value?: string) => {
      if (!value) return "unknown";
      const v = value.replace(/️/g, "").trim().toLowerCase();
      if (v === "ok" || v === "✅") return "ok";
      if (v === "warn" || v === "⚠") return "warn";
      if (v === "bad" || v === "❌") return "bad";
      return "unknown";
    },
    parseResolvedDate: (value?: string) => {
      const raw = value?.trim() ?? "";
      return isCalendarDay(raw) ? raw : null;
    },
  } as const;
  for (const [name, fn] of Object.entries(old)) {
    test(name, () => {
      const now = (ast as unknown as Record<string, (r?: string) => unknown>)[name]!;
      for (const r of raws) expect({ r, v: now(r) }).toEqual({ r, v: fn(r) });
    });
  }
  test("parseLaneSince", () => {
    expect(ast.parseLaneSince("02.01.2026")).toBe("2026-01-02");
    expect(ast.parseLaneSince("x")).toBeNull();
    expect(ast.parseLaneSince(undefined)).toBeNull();
  });
});

test("every ComponentName has a spec entry", () => {
  const n: ComponentName = "Callout";
  expect(COMPONENT_SPEC[n]).toBeDefined();
  expect(COMPONENT_NAMES.length).toBe(30);
});
