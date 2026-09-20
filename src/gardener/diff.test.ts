import { test, expect, describe } from "bun:test";
import { lineDiff, trimDiffContext } from "./diff.ts";

describe("lineDiff", () => {
  test("all context when unchanged", () => {
    const d = lineDiff("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.type === "ctx")).toBe(true);
    expect(d.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  test("marks an added line", () => {
    const d = lineDiff("a\nc", "a\nb\nc");
    expect(d).toEqual([
      { type: "ctx", text: "a" },
      { type: "add", text: "b" },
      { type: "ctx", text: "c" },
    ]);
  });

  test("marks a deleted line", () => {
    const d = lineDiff("a\nb\nc", "a\nc");
    expect(d).toEqual([
      { type: "ctx", text: "a" },
      { type: "del", text: "b" },
      { type: "ctx", text: "c" },
    ]);
  });

  test("a changed line is a del + add pair", () => {
    const d = lineDiff("hello world", "hello there");
    expect(d).toContainEqual({ type: "del", text: "hello world" });
    expect(d).toContainEqual({ type: "add", text: "hello there" });
  });

  test("trailing-newline differences don't produce spurious blank lines", () => {
    const d = lineDiff("a\nb\n", "a\nb");
    expect(d.every((l) => l.type === "ctx")).toBe(true);
  });
});

describe("trimDiffContext", () => {
  const ctx = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "ctx" as const, text: `c${i}` }));

  test("keeps the change plus a radius of context and collapses the rest", () => {
    const lines = [...ctx(10), { type: "add" as const, text: "series: prov" }, ...ctx(10)];
    const out = trimDiffContext(lines, 2);
    // 1 elision + 2 ctx + the add + 2 ctx + 1 elision.
    expect(out.map((l) => l.text)).toEqual(["…", "c8", "c9", "series: prov", "c0", "c1", "…"]);
    // The elision is a ctx line, so the renderer needs no fourth type.
    expect(out.filter((l) => l.text === "…").every((l) => l.type === "ctx")).toBe(true);
  });

  test("two nearby changes share one window rather than eliding between them", () => {
    const lines = [
      ...ctx(5),
      { type: "add" as const, text: "a" },
      ...ctx(2),
      { type: "del" as const, text: "d" },
      ...ctx(5),
    ];
    expect(trimDiffContext(lines, 2).filter((l) => l.text === "…")).toHaveLength(2);
  });

  test("a diff with NO change is returned whole", () => {
    // The card renders its own "no diff" sentence for this; a lone `…` would
    // replace one honest empty state with a misleading one.
    expect(trimDiffContext(ctx(6), 2).map((l) => l.text)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
  });

  test("a change at either edge keeps its one-sided window", () => {
    const head = [{ type: "add" as const, text: "a" }, ...ctx(6)];
    expect(trimDiffContext(head, 2).map((l) => l.text)).toEqual(["a", "c0", "c1", "…"]);
    const tail = [...ctx(6), { type: "add" as const, text: "a" }];
    expect(trimDiffContext(tail, 2).map((l) => l.text)).toEqual(["…", "c4", "c5", "a"]);
  });
});
