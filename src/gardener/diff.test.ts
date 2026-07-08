import { test, expect, describe } from "bun:test";
import { lineDiff } from "./diff.ts";

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
