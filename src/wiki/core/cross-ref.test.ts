import { test, expect, describe } from "bun:test";
import { findXrefRun, isTrackerKey, isXrefId, parseXrefIds, RUN_GAP_SRC, XREF_MAX_IDS } from "./cross-ref.ts";

const ids = (text: string, projects: string[] = []) => findXrefRun(text, projects)?.map((r) => r.id) ?? null;

describe("the cross-page id token", () => {
  test("letters, an optional hyphen, digits — any prefix", () => {
    for (const id of ["D9", "Q-16", "A003", "P2", "Å3", "MEL-601780"]) expect(isXrefId(id), id).toBe(true);
    for (const id of ["omtalt", "10", "D", "D-", "Q-A", "D 9", "-D9"]) expect(isXrefId(id), id).toBe(false);
  });

  test("at most one lower-case letter after the digits", () => {
    for (const id of ["Q-5c", "Q-13b", "T-6b", "D9a"]) expect(isXrefId(id), id).toBe(true);
    for (const id of ["Q-5cd", "Q-5C", "Q-5c1", "D9-a"]) expect(isXrefId(id), id).toBe(false);
  });

  test("a tracker key is one only for a configured project", () => {
    expect(isTrackerKey("MELOSYS-8308", ["MELOSYS"])).toBe(true);
    expect(isTrackerKey("MELOSYS-8308", [])).toBe(false);
    expect(isTrackerKey("D9", ["MELOSYS"])).toBe(false);
    expect(isTrackerKey("MELOSYS-8308b", ["MELOSYS"])).toBe(true);
  });
});

describe("findXrefRun — the run before `i`/`in`/`på`/`on` and a wikilink", () => {
  test("one id, each connector", () => {
    expect(ids("Se D9 i ")).toEqual(["D9"]);
    expect(ids("Se D9 in ")).toEqual(["D9"]);
    expect(ids("Se D9 på ")).toEqual(["D9"]);
    expect(ids("Se D9 on ")).toEqual(["D9"]);
  });

  test("a run of mixed prefixes joined by list separators", () => {
    expect(ids("Svarene D3, D4 og Q-16 i ")).toEqual(["D3", "D4", "Q-16"]);
    expect(ids("D1–D3 i ")).toEqual(["D1", "D3"]);
    expect(ids("S1/S2 & O4 eller P2 på ")).toEqual(["S1", "S2", "O4", "P2"]);
  });

  test("the offsets point at the ids in the given text", () => {
    const text = "x D3, Q-16 i ";
    for (const r of findXrefRun(text)!) expect(text.slice(r.start, r.end)).toBe(r.id);
  });

  test("a word, plain text after the connector or no connector is no candidate", () => {
    expect(ids("omtalt i ")).toBeNull();
    expect(ids("Q-1 i prod ")).toBeNull();
    expect(ids("D9 ")).toBeNull();
    expect(ids("D9 i")).toBeNull();
    expect(ids("D9 og ")).toBeNull();
    // A digit before the letters: no id starts inside a token.
    expect(ids("5D9 i ")).toBeNull();
    expect(ids("D9xy i ")).toBeNull();
    expect(ids("D9X i ")).toBeNull();
  });

  test("an id with a letter suffix is read whole, alone and in a run", () => {
    expect(ids("Kjør Q-5c på ")).toEqual(["Q-5c"]);
    expect(ids("Q-5b og Q-5c på ")).toEqual(["Q-5b", "Q-5c"]);
    expect(ids("Q-5, Q-10c i ")).toEqual(["Q-5", "Q-10c"]);
  });

  test("a tracker key is never an id; the run keeps only the ids after it", () => {
    expect(ids("MELOSYS-8308 på ", ["MELOSYS"])).toBeNull();
    expect(ids("MELOSYS-8308 og D4 på ", ["MELOSYS"])).toEqual(["D4"]);
    expect(ids("D4 og MELOSYS-8308 på ", ["MELOSYS"])).toBeNull();
    // Not configured: it is an id like any other.
    expect(ids("MELOSYS-8308 på ")).toEqual(["MELOSYS-8308"]);
  });

  test("a long row of ids with no connector answers at once", () => {
    const row = `${Array.from({ length: 200 }, (_, k) => `A${k}`).join(" ")} x `;
    const t = performance.now();
    expect(ids(row)).toBeNull();
    expect(performance.now() - t).toBeLessThan(500);
  });

  // F9 (architecture review 2026-11-16): the gap `\s*(?:sep)?\s*` backtracked
  // exponentially, 24 space-separated ids took 9.4 s. Fixed on main by #872;
  // this pins every gap shape the run grammar allows, at sizes past the
  // 240-character scan window, and the in-page linker's anchored use.
  test("every gap shape answers at once, at 24, 100 and 1000 ids, with or without a connector", () => {
    const gaps = [" ", "  ", " \t ", ", ", " , ", "  ,  ", " og ", "   og   ", " -", "- ", "\n"];
    const tails = [" i ", " x", ", ", " og", "", " i"];
    const t = performance.now();
    for (const n of [24, 100, 1000]) {
      const run = Array.from({ length: n }, (_, k) => `D${k + 1}`);
      for (const gap of gaps) for (const tail of tails) findXrefRun(run.join(gap) + tail);
    }
    expect(performance.now() - t).toBeLessThan(500);
  });

  test("the in-page linker's anchored gap is linear on long white-space and separator runs", () => {
    const gapRe = new RegExp(`^${RUN_GAP_SRC}$`, "u");
    const t = performance.now();
    for (const s of [" ".repeat(100_000), `${" ".repeat(100_000)}x`, ", ".repeat(50_000), `${" ".repeat(50_000)}og${" ".repeat(50_000)}x`]) gapRe.test(s);
    expect(performance.now() - t).toBeLessThan(500);
  });

  test("a non-breaking space counts as a space", () => {
    expect(ids("D9 i ")).toEqual(["D9"]);
  });
});

describe("parseXrefIds", () => {
  test("comma-separated ids, whole, first occurrence, capped", () => {
    expect(parseXrefIds(" D1, Q-3,D1,,omtalt,<x>,O2,Q-5c ")).toEqual(["D1", "Q-3", "O2", "Q-5c"]);
    expect(parseXrefIds(undefined)).toEqual([]);
    const many = Array.from({ length: XREF_MAX_IDS + 5 }, (_, k) => `D${k}`).join(",");
    expect(parseXrefIds(many)).toHaveLength(XREF_MAX_IDS);
  });
});
