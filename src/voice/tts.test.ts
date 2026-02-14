import { test, expect, describe } from "bun:test";
import { isTtsAvailable } from "./tts.ts";

describe("isTtsAvailable", () => {
  test("returns a boolean", async () => {
    const result = await isTtsAvailable();
    expect(typeof result).toBe("boolean");
  });

  test("caches result across calls", async () => {
    const first = await isTtsAvailable();
    const second = await isTtsAvailable();
    expect(first).toBe(second);
  });
});
