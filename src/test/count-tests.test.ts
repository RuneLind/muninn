import { test, expect, describe } from "bun:test";
import { classify, countDeclarations } from "../../scripts/count-tests.ts";

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

  test("a curried conditional declares a test: the name is in the second call", () => {
    const src = [
      `test.skipIf(process.getuid?.() === 0)("skipped as root", fn);`,
      `test.if(hasDocker)("needs docker", fn);`,
      `it.todoIf(isCi)("later", fn);`,
      `test.skipIf(`,
      `  !process.env.RUN_SLOW,`,
      `)("wrapped curried name", fn);`,
      `test.if(label !== "a)b")("a paren inside the condition's string", fn);`,
    ].join("\n");
    expect(countDeclarations(src).tests).toBe(5);
  });

  test("a curried call whose second call has no name declares nothing", () => {
    expect(countDeclarations(`test.skipIf(cond)(someFactory());`).tests).toBe(0);
  });

  test("a modifier's name counts in every quote style", () => {
    const src = [`test.skip('single', fn);`, "test.only(`backtick ${x}`, fn);", `test.todo("double");`].join("\n");
    expect(countDeclarations(src).tests).toBe(3);
  });

  test("a bare modifier call inside a body declares nothing", () => {
    const src = [`test("real", async () => {`, `  test.fail();`, `  test.slow();`, `});`].join("\n");
    expect(countDeclarations(src).tests).toBe(1);
  });
});

describe("how the chains group the files", () => {
  const testFiles = [
    "db/unit-only.test.ts",
    "src/db/needs-pg.test.ts",
    "src/watchers/shared.test.ts",
    "src/watchers/unit-only.test.ts",
    "src/hivemind/router.test.ts",
    "src/only-ci.test.ts",
    "src/no-chain.test.ts",
    "src/unmapped.test.ts",
  ];
  const specFiles = ["e2e/chat.spec.ts"];
  const scripts = {
    test: "bun test db/unit-only.test.ts src/watchers/ src/only-ci.test.ts && bun test src/db/",
    "test:unit": "bun test db/unit-only.test.ts src/watchers/",
    "test:handlers": "bun test src/watchers/shared.test.ts",
    "test:db": "bun test src/db/",
    "test:hivemind": "bun test src/hivemind/",
    "test:foo": "bun test src/unmapped.test.ts",
    "test:coverage": "bun test --coverage",
    "test:e2e": "bunx playwright test",
  };
  const c = classify(scripts, testFiles, specFiles);

  test("a chain's files join its group; specs are e2e; the rest are ungrouped", () => {
    expect(c.members.unit).toEqual(["db/unit-only.test.ts", "src/watchers/shared.test.ts", "src/watchers/unit-only.test.ts"]);
    expect(c.members.integration).toEqual(["src/db/needs-pg.test.ts", "src/hivemind/router.test.ts"]);
    expect(c.members.e2e).toEqual(["e2e/chat.spec.ts"]);
    expect(c.members.ungrouped).toEqual(["src/no-chain.test.ts", "src/only-ci.test.ts", "src/unmapped.test.ts"]);
  });

  test("a file two chains of one group run is a repeat, so --run can subtract it", () => {
    expect([...c.repeats.entries()]).toEqual([["src/watchers/shared.test.ts", 2]]);
  });

  test("the drift lists: no chain, only the CI chain, and outside the CI chain", () => {
    expect(c.unrun).toEqual(["src/no-chain.test.ts"]);
    expect(c.ciOnly).toEqual(["src/only-ci.test.ts"]);
    expect(c.outsideCi).toEqual(["src/hivemind/router.test.ts"]);
  });

  test("a file only an unmapped chain runs is in no drift list, and the chain is warned about", () => {
    expect(c.unrun).not.toContain("src/unmapped.test.ts");
    expect(c.ciOnly).not.toContain("src/unmapped.test.ts");
    expect(c.warnings.some((w) => w.startsWith("test:foo:"))).toBe(true);
  });

  test("a chain naming a file that is not on disk is warned about, not counted", () => {
    const missing = classify({ "test:unit": "bun test src/gone.test.ts" }, testFiles, specFiles);
    expect(missing.members.unit).toEqual([]);
    expect(missing.warnings).toContain("test:unit: names src/gone.test.ts, which is not a test file on disk");
  });
});
