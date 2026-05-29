import { test, expect, describe } from "bun:test";
import { fillTemplate } from "./fill-template.ts";

describe("fillTemplate", () => {
  test("substitutes a single slot", () => {
    expect(fillTemplate("Hello {NAME}!", { NAME: "world" })).toBe("Hello world!");
  });

  test("substitutes multiple slots", () => {
    expect(
      fillTemplate("{A} then {B}", { A: "first", B: "second" }),
    ).toBe("first then second");
  });

  test("inserts $-patterns literally ($&, $1, $$, $`, $')", () => {
    // The whole point: these are String.replace replacement specials and would
    // be mangled by a plain string replacement.
    const tricky = "cost is $5 & $& $1 $$ $` $' done";
    expect(fillTemplate("msg: {X}", { X: tricky })).toBe(`msg: ${tricky}`);
  });

  test("a value containing the next slot is not re-substituted", () => {
    // If {A}'s value contains the literal "{B}", it must survive verbatim.
    expect(fillTemplate("{A}", { A: "look: {B}" })).toBe("look: {B}");
  });

  test("leaves unknown slots untouched", () => {
    expect(fillTemplate("Hello {NAME}", {})).toBe("Hello {NAME}");
  });

  test("only replaces the first occurrence of a slot", () => {
    expect(fillTemplate("{X} and {X}", { X: "one" })).toBe("one and {X}");
  });
});
