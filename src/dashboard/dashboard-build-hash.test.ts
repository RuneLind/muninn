import { test, expect, describe } from "bun:test";
import { buildHashMetaTag, getDashboardBuildHash } from "./dashboard-build-hash.ts";

describe("dashboard build hash", () => {
  test("buildHashMetaTag renders a meta tag with the given content", () => {
    expect(buildHashMetaTag("abc123def456")).toBe(
      '<meta name="muninn-build-hash" content="abc123def456">',
    );
  });

  test("getDashboardBuildHash returns a stable 12-char hex string", async () => {
    const a = await getDashboardBuildHash();
    const b = await getDashboardBuildHash();
    expect(a).toBe(b); // memoized
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});
