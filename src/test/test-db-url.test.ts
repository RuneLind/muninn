import { describe, expect, test } from "bun:test";
import { resolveTestDatabaseUrl } from "./test-db-url.ts";

describe("resolveTestDatabaseUrl", () => {
  test("unset or blank: the shared default", () => {
    expect(resolveTestDatabaseUrl({})).toBe("postgresql://muninn:muninn@127.0.0.1:5435/muninn_test");
    expect(resolveTestDatabaseUrl({ MUNINN_TEST_DATABASE_URL: "  " })).toBe(
      "postgresql://muninn:muninn@127.0.0.1:5435/muninn_test",
    );
  });

  test("a database name ending in _test is honoured", () => {
    const url = "postgresql://muninn:muninn@127.0.0.1:5435/muninn_b_test";
    expect(resolveTestDatabaseUrl({ MUNINN_TEST_DATABASE_URL: url })).toBe(url);
  });

  test("anything else is refused, never truncated", () => {
    for (const url of [
      "postgresql://muninn:muninn@127.0.0.1:5435/muninn",
      "postgresql://muninn:muninn@127.0.0.1:5435/muninn_test_old",
      "postgresql://muninn:muninn@127.0.0.1:5435/",
      "postgresql://muninn:muninn@127.0.0.1:5435/_test",
      "postgresql://muninn:muninn@127.0.0.1:5435/a-b_test",
      "not a url",
    ]) {
      expect(() => resolveTestDatabaseUrl({ MUNINN_TEST_DATABASE_URL: url }), url).toThrow();
    }
  });
});
