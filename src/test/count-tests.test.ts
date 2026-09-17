import { test, expect, describe } from "bun:test";
import { classify, countDeclarations, repeatAdjustment } from "../../scripts/count-tests.ts";

/**
 * The pure parts of `bun run test:count`: the declaration counter, the grouping of
 * files by chain, and the arithmetic `--run` uses to take repeated files back out.
 *
 * The counter's rules are the ones that rot silently: `test.describe` and
 * `test.step` take a name yet declare no test, Playwright's `test.skip(cond,
 * "reason")` skips a file while `test.skip("name", fn)` is a skipped test, bun's
 * `test.skipIf(cond)("name", fn)` carries its name in a second call, and a
 * `test.each` table is one declaration that bun expands at run time.
 *
 * This file is listed by name in the `test` and `test:unit` chains, like
 * `mock-isolation.test.ts` beside it, because `src/test/` is not a directory
 * argument in any chain: a file dropped here without a chain entry runs nowhere.
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
      `test.if(label !== "a\\")b")("an escaped quote inside the condition's string", fn);`,
    ].join("\n");
    expect(countDeclarations(src).tests).toBe(6);
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

  test("a file two chains of one group run is a repeat, with each chain's link count", () => {
    expect(c.repeats).toEqual([
      { group: "unit", file: "src/watchers/shared.test.ts", runs: { "test:unit": 1, "test:handlers": 1 } },
    ]);
  });

  test("a file repeated in two groups keeps one entry per group", () => {
    const both = classify(
      {
        "test:unit": "bun test src/both.test.ts && bun test src/both.test.ts",
        "test:db": "bun test src/both.test.ts && bun test src/both.test.ts",
      },
      ["src/both.test.ts"],
      [],
    );
    expect(both.repeats).toEqual([
      { group: "unit", file: "src/both.test.ts", runs: { "test:unit": 2 } },
      { group: "integration", file: "src/both.test.ts", runs: { "test:db": 2 } },
    ]);
  });

  test("the drift lists: no chain, only the CI chain, and outside the CI chain", () => {
    expect(c.unrun).toEqual(["src/no-chain.test.ts"]);
    expect(c.ciOnly).toEqual(["src/only-ci.test.ts"]);
    expect(c.outsideCi).toEqual(["src/hivemind/router.test.ts"]);
  });

  test("a file only an unmapped chain runs is in no drift list, and the chain is warned about", () => {
    expect(c.unrun).not.toContain("src/unmapped.test.ts");
    expect(c.ciOnly).not.toContain("src/unmapped.test.ts");
    expect(c.warnings).toEqual(["test:foo: chain is in no group — add it to GROUP_OF_SCRIPT in scripts/count-tests.ts"]);
  });

  test("a chain naming a file that is not on disk is warned about, not counted", () => {
    const missing = classify({ "test:unit": "bun test src/gone.test.ts" }, testFiles, specFiles);
    expect(missing.members.unit).toEqual([]);
    expect(missing.warnings).toContain("test:unit: names src/gone.test.ts, which is not a test file on disk");
  });
});

describe("what --run takes back out for a repeated file", () => {
  const live = new Set(["test:integration"]);
  const none = new Set<string>();
  const repeat = (runs: Record<string, number>) => ({ group: "unit" as const, file: "src/x.test.ts", runs });

  test("two measured chains: keep one measured run", () => {
    expect(
      repeatAdjustment(repeat({ "test:unit": 1, "test:handlers": 1 }), { live, failed: none, staticTests: 8, measuredTests: 10 }),
    ).toEqual({ files: 1, tests: 10 });
  });

  test("a chain that runs the file failed: subtract nothing, and say why", () => {
    const adj = repeatAdjustment(repeat({ "test:unit": 1, "test:handlers": 1 }), {
      live,
      failed: new Set(["test:handlers"]),
      staticTests: 8,
      measuredTests: null,
    });
    expect(adj).toEqual({ skipped: "src/x.test.ts: not deduplicated, because test:handlers failed and may not have reached it" });
  });

  test("a live chain and a measured chain: take back the live chain's static rows, keep the measured run", () => {
    expect(
      repeatAdjustment(repeat({ "test:integration": 1, "test:db": 1 }), { live, failed: none, staticTests: 8, measuredTests: 10 }),
    ).toEqual({ files: 1, tests: 8 });
  });

  test("only live links: keep one static count, and no measurement is needed", () => {
    expect(
      repeatAdjustment(repeat({ "test:integration": 2 }), { live, failed: none, staticTests: 8, measuredTests: null }),
    ).toEqual({ files: 1, tests: 8 });
  });

  test("a measured chain whose file measurement is missing: subtract nothing, and say why", () => {
    expect(
      repeatAdjustment(repeat({ "test:unit": 1, "test:handlers": 1 }), { live, failed: none, staticTests: 8, measuredTests: null }),
    ).toEqual({ skipped: "src/x.test.ts: not deduplicated, because its own run failed" });
  });
});
