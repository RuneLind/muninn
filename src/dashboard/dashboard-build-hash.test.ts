import { test, expect, describe } from "bun:test";
import { buildHashMetaTag, getDashboardBuildHash, makeBuildHash } from "./dashboard-build-hash.ts";

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

  test("a failed build is not kept: the next call builds again and resolves", async () => {
    let calls = 0;
    const flaky = () => (++calls === 1 ? Promise.reject(new Error("bundle failed")) : Promise.resolve("ok"));
    const hash = makeBuildHash([flaky, () => Promise.resolve("b")]);
    await expect(hash()).rejects.toThrow("bundle failed");
    expect(await hash()).toMatch(/^[0-9a-f]{12}$/);
    expect(await hash()).toBe(await hash());
    expect(calls).toBe(2);
  });
});
