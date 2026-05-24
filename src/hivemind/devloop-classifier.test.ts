import { test, expect, describe } from "bun:test";
import { classifyReengageRole, parseRole, type HaikuCaller } from "./devloop-classifier.ts";
import type { ReengageContext } from "./devloop-prompts.ts";

/** A HaikuCaller stub that returns a fixed verdict and records the prompt. */
function stubHaiku(result: string): { fn: HaikuCaller; prompts: string[] } {
  const prompts: string[] = [];
  const fn: HaikuCaller = async (prompt) => {
    prompts.push(prompt);
    return { result, inputTokens: 0, outputTokens: 0, model: "stub-haiku" };
  };
  return { fn, prompts };
}

const OPTS = { botName: "testbot", botDir: "/tmp/bots/testbot" };
const CTX: ReengageContext = {
  ciUrl: "https://github.com/navikt/melosys-e2e-tests/actions/runs/123",
  orchestrateMessage: "Selector .submit-knapp not found — the page renamed it last sprint.",
  buildPeer: "buildpeer",
  testPeer: "testpeer",
};

describe("parseRole", () => {
  test("a clean one-word 'test' verdict", () => {
    expect(parseRole("test")).toBe("test");
  });
  test("a clean one-word 'build' verdict", () => {
    expect(parseRole("build")).toBe("build");
  });
  test("is case-insensitive", () => {
    expect(parseRole("TEST")).toBe("test");
    expect(parseRole("Build")).toBe("build");
  });
  test("tolerates surrounding whitespace/punctuation/quotes", () => {
    expect(parseRole("test.\n")).toBe("test");
    expect(parseRole("  build  ")).toBe("build");
    expect(parseRole('"test"')).toBe("test");
  });
  test("prose defaults to build — only a clean one-word answer counts", () => {
    // A single 'test' mention wrapped in prose is NOT a clean verdict → build.
    expect(parseRole("This is a test problem.")).toBe("build");
  });
  test("a NEGATED test mention does not mis-route to the test agent", () => {
    // The dangerous direction (should be build, must never return test): a
    // negation has 'test' present and 'build' absent, which a tolerant
    // \btest\b parse would wrongly route to test.
    expect(parseRole("This is a feature bug, not a test issue")).toBe("build");
    expect(parseRole("Not a test problem; the implementation is wrong.")).toBe("build");
  });
  test("BOTH words present → defaults to build", () => {
    expect(parseRole("It's a test issue, not a build bug")).toBe("build");
  });
  test("neither word present → defaults to build", () => {
    expect(parseRole("I'm not sure")).toBe("build");
    expect(parseRole("")).toBe("build");
  });
  test("does not match substrings — word-bounded only, so substrings fall back to build", () => {
    // \bbuild\b does NOT match "rebuild"; \btest\b does NOT match "testing".
    // Neither word-bounded token present → safe default "build" (a stray
    // "testing" must NOT mis-route the fix to the test agent).
    expect(parseRole("rebuild everything")).toBe("build");
    expect(parseRole("testing the flow")).toBe("build");
  });
});

describe("classifyReengageRole", () => {
  test("returns the Haiku verdict when it says test", async () => {
    const haiku = stubHaiku("test");
    const role = await classifyReengageRole(CTX, OPTS, haiku.fn);
    expect(role).toBe("test");
    // the failure report + CI URL are fed into the prompt
    expect(haiku.prompts[0]).toContain("Selector .submit-knapp not found");
    expect(haiku.prompts[0]).toContain("actions/runs/123");
  });

  test("returns the Haiku verdict when it says build", async () => {
    const haiku = stubHaiku("build");
    expect(await classifyReengageRole(CTX, OPTS, haiku.fn)).toBe("build");
  });

  test("defaults to build with NO Haiku call when there is no failure report", async () => {
    const haiku = stubHaiku("test");
    const role = await classifyReengageRole({ ...CTX, orchestrateMessage: undefined }, OPTS, haiku.fn);
    expect(role).toBe("build");
    expect(haiku.prompts).toHaveLength(0); // didn't burn a call
  });

  test("defaults to build when the Haiku call throws", async () => {
    const throwing: HaikuCaller = async () => {
      throw new Error("backend down");
    };
    expect(await classifyReengageRole(CTX, OPTS, throwing)).toBe("build");
  });

  test("defaults to build on an ambiguous verdict", async () => {
    const haiku = stubHaiku("could be a test or a build problem");
    expect(await classifyReengageRole(CTX, OPTS, haiku.fn)).toBe("build");
  });

  test("feeds a report with $ sequences into the prompt verbatim (no replace-pattern mangling)", async () => {
    const haiku = stubHaiku("build");
    // $&, $`, $', $$, ${...} are all special in String.replace's replacement arg.
    const tricky = "Selector `${submitBtn}` missing; regex /foo$/ ; literals $& $` $' $$ failed";
    await classifyReengageRole({ ...CTX, orchestrateMessage: tricky }, OPTS, haiku.fn);
    expect(haiku.prompts[0]).toContain(tricky); // passed through unchanged
    expect(haiku.prompts[0]).not.toContain("{REPORT}"); // placeholder fully substituted
  });
});
