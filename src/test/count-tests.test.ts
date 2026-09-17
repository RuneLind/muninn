import { test, expect, describe } from "bun:test";
import { countDeclarations } from "../../scripts/count-tests.ts";

/**
 * The declaration counter behind `bun run test:count`.
 *
 * The rules it encodes are the ones that rot silently: a Playwright hook and a
 * `test.describe` block declare no test, `test.skip(cond, "reason")` skips a file
 * while `test.skip("name", fn)` is a skipped test, and a `test.each` table is one
 * declaration that bun expands at run time. Measured 2026-09-16 on this repo:
 * `src/utils/timing.test.ts` counts 14 and runs 14, `src/web/web-format.test.ts`
 * counts 104 and runs 110 (one seven-case table), and Playwright lists 10 for
 * `e2e/inspector.spec.ts` against 10 counted.
 *
 * This file is listed by name in the `test` and `test:unit` chains, like
 * `mock-isolation.test.ts` beside it — `src/test/` is not a directory argument in
 * any chain, so a file dropped here runs nowhere. `test:count` reports that class
 * of drift, and found `src/test/highlighted-code.test.ts` sitting in it.
 */
describe("what counts as a test", () => {
  test("a plain it() or test() counts once", () => {
    expect(countDeclarations(`it("a", fn);\ntest("b", fn);`).tests).toBe(2);
  });

  test("a modifier with a name counts, a modifier with a condition does not", () => {
    const src = [
      `test.skip("named and skipped", fn);`,
      `it.only("named and only", fn);`,
      `test.todo("named and todo");`,
      `test.failing("named and failing", fn);`,
      `test.skip(process.platform === "win32", "conditional file skip");`,
      `test.fixme(!enabled, "conditional");`,
    ].join("\n");
    expect(countDeclarations(src).tests).toBe(4);
  });

  test("hooks and describe blocks declare nothing", () => {
    const src = [
      `test.describe("group", () => {`,
      `  test.beforeAll(async () => {});`,
      `  test.afterEach(async () => {});`,
      `  test.setTimeout(90_000);`,
      `  test.use({ storageState: undefined });`,
      `  test.step("a step", async () => {});`,
      `  test("the only real test", fn);`,
      `});`,
    ].join("\n");
    expect(countDeclarations(src).tests).toBe(1);
  });

  test("a table counts once and is reported as a table", () => {
    const c = countDeclarations(`test.each([1, 2, 3])("case %i", fn);`);
    expect(c).toEqual({ tests: 1, tables: 1 });
  });

  test("a name on the next line still counts", () => {
    expect(countDeclarations(`test.skip(\n  "wrapped name",\n  fn,\n);`).tests).toBe(1);
  });

  test("indentation counts, a call mid-line does not", () => {
    const src = [`  it("indented", fn);`, `const x = it("assigned mid-line", fn);`, `// it("commented", fn);`].join(
      "\n",
    );
    expect(countDeclarations(src).tests).toBe(1);
  });

  test("a bare modifier call inside a body declares nothing", () => {
    const src = [`test("real", async () => {`, `  test.fail();`, `  test.slow();`, `});`].join("\n");
    expect(countDeclarations(src).tests).toBe(1);
  });
});
