import { describe, expect, test } from "bun:test";
import {
  COMPONENT_ATTRS,
  COMPONENT_NAMES,
  COMPONENT_SPEC,
  FACT_VERDICT_GLYPHS,
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
  "Timeline", "DecisionLog", "RunChecklist", "Question", "More", "StatusRows", "Chart",
  "RuleTree", "Glossary", "Diagram", "Steps",
];
const FROZEN_SELF_CLOSING = ["FileRef", "Verdict", "Pill", "Fact", "Embed", "Query", "CaseBoard", "DeltaTable", "Diagram", "Steps"];
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
  CaseBoard: ["src", "labels", "view"],
  DeltaTable: ["src", "better", "decimal"],
  Tldr: ["label"],
  Timeline: [],
  DecisionLog: [],
  RunChecklist: [],
  Question: ["id", "choices", "to"],
  More: [],
  StatusRows: ["view", "tones"],
  Chart: ["kind", "caption", "value", "target", "gap", "mark", "x", "ref", "normalize", "bar", "pass", "hold"],
  RuleTree: ["title", "outcomes"],
  Glossary: [],
  Diagram: ["src"],
  Steps: ["src"],
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
  // Membership only, not order: the parser reads it with `.has` alone.
  test("SELF_CLOSING_ALLOWED, membership", () => {
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

  test("every attribute spec: an empty or whitespace value reads exactly as a missing one", () => {
    for (const name of COMPONENT_NAMES) {
      for (const [attr, spec] of Object.entries(
        COMPONENT_SPEC[name].attrs as Record<string, { parse: (r?: string) => { value: unknown; fellBack: boolean } }>,
      )) {
        const missing = spec.parse(undefined);
        // parseString keeps the raw text; every checked reader answers as if missing.
        if (spec.parse("x").fellBack === false && spec.parse("x").value === "x") continue;
        for (const blank of ["", " ", "\t", "  \n "]) {
          expect({ name, attr, blank, ...spec.parse(blank) }).toEqual({ name, attr, blank, ...missing });
        }
      }
    }
  });

  test("enum attributes accept every listed value and fall back to the default", () => {
    for (const name of COMPONENT_NAMES) {
      for (const [attr, spec] of Object.entries(
        COMPONENT_SPEC[name].attrs as Record<
          string,
          { parse: (r?: string) => { value: unknown; fellBack: boolean }; enum?: readonly string[]; default?: unknown; required?: true }
        >,
      )) {
        if (!spec.enum) continue;
        for (const v of spec.enum) expect({ attr, v, ...spec.parse(v) }).toEqual({ attr, v, value: v, fellBack: false });
        // A required enum has no default: an unknown value reads as none (null).
        expect(spec.parse("zzz")).toEqual({ value: spec.required ? null : spec.default, fellBack: true });
        expect(spec.parse(undefined)).toEqual({ value: spec.required ? null : spec.default, fellBack: false });
      }
    }
  });

  test("Verdict maybe renders yes and is a fallback", () => {
    expect(readVerdictValue("maybe")).toEqual({ value: "yes", fellBack: true });
  });

  test("Verdict: a value that folds to yes is no fallback; one that folds to no still is", () => {
    for (const raw of ["Yes", " yes ", "YES"]) expect({ raw, ...readVerdictValue(raw) }).toEqual({ raw, value: "yes", fellBack: false });
    for (const raw of ["NO", " No ", " no "]) expect({ raw, ...readVerdictValue(raw) }).toEqual({ raw, value: "yes", fellBack: true });
    expect(readVerdictValue("no")).toEqual({ value: "no", fellBack: false });
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

  test("Fact v: every listed glyph parses, with and without VS16, to the value it names", () => {
    expect(COMPONENT_SPEC.Fact.attrs.v.aliases).toBe(FACT_VERDICT_GLYPHS);
    for (const [glyph, value] of Object.entries(FACT_VERDICT_GLYPHS)) {
      for (const raw of [glyph, glyph.replace(/\uFE0F/g, ""), `${glyph.replace(/\uFE0F/g, "")}\uFE0F`]) {
        expect({ raw, ...readFactVerdict(raw) }).toEqual({ raw, value, fellBack: false });
      }
    }
  });

  test("Fact v: every code point the reader accepts is a word or a listed glyph", () => {
    const listed = new Set(Object.keys(FACT_VERDICT_GLYPHS).map((g) => g.replace(/\uFE0F/g, "")));
    const accepted: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (!readFactVerdict(ch).fellBack && ch.trim() !== "" && ch !== "\uFE0F") accepted.push(ch);
    }
    expect(accepted.sort()).toEqual([...listed].sort());
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
    expect(readMeterValue("")).toEqual({ value: null, fellBack: false });
    expect(readMeterValue(" ")).toEqual({ value: null, fellBack: false });
    expect(readMeterValue("abc")).toEqual({ value: null, fellBack: true });
    expect(readMeterValue("9")).toEqual({ value: 9, fellBack: false });
    expect(readMeterMax("0")).toEqual({ value: 5, fellBack: true });
    expect(readMeterMax("")).toEqual({ value: 5, fellBack: false });
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
      const v = value.replace(/\uFE0F/g, "").trim().toLowerCase();
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

  // The pre-move bodies of the three with a different shape, verbatim.
  const OLD_LANE_KINDS = ["you", "waiting", "draft", "blocked"] as const;
  type OldLaneKind = (typeof OLD_LANE_KINDS)[number];
  function oldNormalizeLaneKind(kind: string | undefined): { kind: OldLaneKind; known: boolean } {
    const k = kind?.trim().toLowerCase() ?? "";
    return (OLD_LANE_KINDS as readonly string[]).includes(k)
      ? { kind: k as OldLaneKind, known: true }
      : { kind: "waiting", known: false };
  }
  function oldParseLaneSince(value: string | undefined): string | null {
    const raw = value?.trim() ?? "";
    const nb = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
    const iso = nb ? `${nb[3]}-${nb[2]!.padStart(2, "0")}-${nb[1]!.padStart(2, "0")}` : raw;
    return isCalendarDay(iso) ? iso : null;
  }
  function oldParseMeterAttrs(
    attrs: Record<string, string>,
  ): { value: number; max: number; tone: "default" | "good" | "warn" | "bad" } | null {
    const raw = attrs.value;
    if (raw === undefined || raw.trim() === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;

    let max = Number(attrs.max);
    if (!Number.isFinite(max) || max <= 0) max = 5;

    const clamped = Math.min(Math.max(value, 0), max);
    return { value: clamped, max, tone: old.normalizeMeterTone(attrs.tone) };
  }

  test("normalizeLaneKind", () => {
    for (const r of [...raws, "draft", " BLOCKED ", "Waiting", "next"]) {
      expect({ r, v: ast.normalizeLaneKind(r) }).toEqual({ r, v: oldNormalizeLaneKind(r) });
    }
  });

  test("parseLaneSince", () => {
    const dates = [...raws, "1.2.2026", "29.02.2024", "29.02.2025", "2026-1-2", "02.01.26", " 18.10.2026 ", "2026-13-01"];
    for (const r of dates) expect({ r, v: ast.parseLaneSince(r) }).toEqual({ r, v: oldParseLaneSince(r) });
  });

  test("parseMeterAttrs, value × max × tone", () => {
    const nums = ["", " ", "abc", "-0", "1e400", "NaN", "0", "5", "7", "-3", " 4 ", undefined];
    const tones = [undefined, "good", "warn", "bad", "default", "rec", ""];
    const same = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Object.is(a, b) : a === b);
    let n = 0;
    for (const value of nums) {
      for (const max of nums) {
        for (const tone of tones) {
          const attrs: Record<string, string> = {};
          if (value !== undefined) attrs.value = value;
          if (max !== undefined) attrs.max = max;
          if (tone !== undefined) attrs.tone = tone;
          const now = ast.parseMeterAttrs(attrs);
          const was = oldParseMeterAttrs(attrs);
          const ok =
            now === null || was === null
              ? now === was
              : same(now.value, was.value) && same(now.max, was.max) && now.tone === was.tone;
          expect({ attrs, now, was, ok }).toEqual({ attrs, now, was, ok: true });
          n++;
        }
      }
    }
    expect(n).toBe(nums.length * nums.length * tones.length);
  });
});

test("a VS16 in a regex is written as the \\uFE0F escape, not the invisible character", async () => {
  for (const file of ["component-spec.ts", "component-spec.test.ts"]) {
    const src = await Bun.file(`${import.meta.dir}/${file}`).text();
    expect({ file, raw: /\.replace\(\/[^/\n]*\uFE0F/.test(src) }).toEqual({ file, raw: false });
    expect({ file, escaped: src.includes(".replace(/\\uFE0F/g") }).toEqual({ file, escaped: true });
  }
});
