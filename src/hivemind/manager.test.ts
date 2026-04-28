import { test, expect, describe } from "bun:test";
import { clientKey } from "./manager.ts";

describe("clientKey", () => {
  test("composes a (bot, namespace) pair into a stable string", () => {
    expect(clientKey("melosys", "private")).toBe(clientKey("melosys", "private"));
    expect(clientKey("melosys", "nav")).not.toBe(clientKey("melosys", "private"));
    expect(clientKey("huginn", "private")).not.toBe(clientKey("melosys", "private"));
  });

  test("uses a separator that cannot appear in bot names or namespaces", () => {
    // Bot names and namespaces are filesystem-/identifier-safe; a NUL byte
    // makes the key unambiguous regardless of name/namespace contents.
    const key = clientKey("a", "b");
    expect(key.includes("\x00")).toBe(true);
  });
});
