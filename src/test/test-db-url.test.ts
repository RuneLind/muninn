import { describe, expect, test } from "bun:test";
import { resolveTestDatabaseUrl, seedDatabaseUrl } from "./test-db-url.ts";

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

describe("seedDatabaseUrl (scripts/seed-e2e-db.ts)", () => {
  const configured = "postgresql://muninn:muninn@127.0.0.1:5435/muninn";
  test("MUNINN_TEST_DATABASE_URL, when set, is the database the seed writes", () => {
    const url = "postgresql://muninn:muninn@127.0.0.1:5435/other_test";
    expect(seedDatabaseUrl({ MUNINN_TEST_DATABASE_URL: url }, configured)).toBe(url);
  });

  test("unset or blank: DATABASE_URL as the config resolved it", () => {
    expect(seedDatabaseUrl({}, configured)).toBe(configured);
    expect(seedDatabaseUrl({ MUNINN_TEST_DATABASE_URL: " " }, configured)).toBe(configured);
  });

  test("an override not ending in _test is refused, not silently replaced by DATABASE_URL", () => {
    expect(() => seedDatabaseUrl({ MUNINN_TEST_DATABASE_URL: configured }, configured)).toThrow();
  });
});
