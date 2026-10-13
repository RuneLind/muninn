import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { check, flatten, parseExpectedSkips, partition, specFiles, timingsFromReport, type JsonReport } from "./e2e-shards.ts";

describe("partition", () => {
  test("every file lands in exactly one shard", () => {
    const files = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts", "e.spec.ts"];
    const shards = partition(files, { "a.spec.ts": 5, "b.spec.ts": 1 }, 3);
    expect(shards.flat().sort()).toEqual(files);
  });

  test("packs by time, not by count: one heavy file gets a shard to itself", () => {
    const timings = { "heavy.spec.ts": 90, "a.spec.ts": 10, "b.spec.ts": 10, "c.spec.ts": 10, "d.spec.ts": 10 };
    const shards = partition(Object.keys(timings), timings, 2);
    expect(shards).toContainEqual(["heavy.spec.ts"]);
    expect(shards).toContainEqual(["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"]);
  });

  test("a file the table does not know costs the median, not zero", () => {
    // At cost 0, x and y would both pile onto the empty shard: [a] and [x, y].
    const shards = partition(["a.spec.ts", "x.spec.ts", "y.spec.ts"], { "a.spec.ts": 10 }, 2);
    expect(shards).toEqual([["a.spec.ts", "y.spec.ts"], ["x.spec.ts"]]);
  });

  test("the same input gives the same split, whatever the input order", () => {
    const timings = { "a.spec.ts": 3, "b.spec.ts": 3, "c.spec.ts": 3, "d.spec.ts": 3 };
    expect(partition(["d.spec.ts", "c.spec.ts", "b.spec.ts", "a.spec.ts"], timings, 2)).toEqual(
      partition(["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"], timings, 2),
    );
  });

  test("refuses a shard total below one", () => {
    expect(() => partition(["a.spec.ts"], {}, 0)).toThrow(/positive integer/);
  });
});

const spec = (
  id: string,
  file: string,
  title: string,
  results: { status: string; duration: number }[],
  status = "expected",
  skipReason?: string,
) => ({
  id,
  file,
  title,
  tests: [
    {
      projectName: "chromium",
      status,
      results,
      annotations: skipReason === undefined ? [] : [{ type: "skip", description: skipReason }],
    },
  ],
});

function report(...specs: ReturnType<typeof spec>[]): JsonReport {
  const byFile = new Map<string, ReturnType<typeof spec>[]>();
  for (const s of specs) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  return { suites: [...byFile].map(([file, ss]) => ({ title: file, file, suites: [{ title: "group", file, specs: ss }] })) };
}

const pass = [{ status: "passed", duration: 1500 }];
const skip = [{ status: "skipped", duration: 0 }];

describe("flatten", () => {
  test("titles carry the file and the describe chain, not the file suite twice", () => {
    const [t] = flatten(report(spec("1", "x.spec.ts", "works", pass)));
    expect(t!.title).toBe("x.spec.ts › group › works");
  });
});

describe("flatten: skip reason", () => {
  const withAnnotations = (annotations: { type: string; description?: string }[]): JsonReport => ({
    suites: [
      {
        title: "x.spec.ts",
        file: "x.spec.ts",
        specs: [{ id: "1", title: "t", file: "x.spec.ts", tests: [{ projectName: "chromium", status: "skipped", results: skip, annotations }] }],
      },
    ],
  });

  test("reads the skip annotation, not another type", () => {
    const [t] = flatten(withAnnotations([{ type: "skip", description: "one bot" }, { type: "issue", description: "#12" }]));
    expect(t!.skipReason).toBe("one bot");
  });

  test("takes the last skip: the one that fired", () => {
    const [t] = flatten(withAnnotations([{ type: "skip", description: "first" }, { type: "skip", description: "second" }]));
    expect(t!.skipReason).toBe("second");
  });

  test("test.fixme counts as a skip, with its reason", () => {
    expect(flatten(withAnnotations([{ type: "fixme", description: "flaky on CI" }]))[0]).toMatchObject({
      skipReason: "flaky on CI",
      skipAnnotated: true,
    });
  });

  test("a bare test.skip() is annotated with no reason; an after-failure skip is not annotated", () => {
    expect(flatten(withAnnotations([{ type: "skip" }]))[0]).toMatchObject({ skipReason: "", skipAnnotated: true });
    expect(flatten(withAnnotations([]))[0]).toMatchObject({ skipReason: "", skipAnnotated: false });
  });
});

describe("check", () => {
  const listed = report(spec("1", "x.spec.ts", "one", []), spec("2", "y.spec.ts", "two", []));

  test("clean when every listed test ran once and the skips match", () => {
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", skip, "skipped", "one bot"));
    expect(check(listed, merged, ["y.spec.ts › group › two | one bot"])).toEqual({
      problems: [],
      ran: 2,
      skipped: ["y.spec.ts › group › two | one bot"],
    });
  });

  test("a file no shard ran is a problem", () => {
    const merged = report(spec("1", "x.spec.ts", "one", pass));
    expect(check(listed, merged, []).problems).toEqual(["never ran: y.spec.ts › group › two"]);
  });

  test("a test two shards both ran is a problem", () => {
    const merged = report(spec("1", "x.spec.ts", "one", [...pass, ...pass]), spec("2", "y.spec.ts", "two", pass));
    expect(check(listed, merged, []).problems).toEqual(["ran 2 times: x.spec.ts › group › one"]);
  });

  test("a new skip fails, naming the test", () => {
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", skip, "skipped", "one bot"));
    expect(check(listed, merged, []).problems).toEqual([
      "skipped, not in e2e/ci-expected-skips.txt: y.spec.ts › group › two | one bot",
    ]);
  });

  test("an expected skip that now runs fails too, so the list cannot rot", () => {
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", pass));
    expect(check(listed, merged, ["y.spec.ts › group › two | one bot"]).problems).toEqual([
      "expected to skip, did not: y.spec.ts › group › two | one bot",
    ]);
  });

  test("a listed skip with a different reason fails: the pin is the reason, not just the title", () => {
    // inspector's bot-switch case skips on "only one bot" (deliberate on CI)
    // and on "no bots" (the missing fixture the list exists to catch).
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", skip, "skipped", "no bots"));
    expect(check(listed, merged, ["y.spec.ts › group › two | one bot"]).problems).toEqual([
      "skipped, not in e2e/ci-expected-skips.txt: y.spec.ts › group › two | no bots",
      "expected to skip, did not: y.spec.ts › group › two | one bot",
    ]);
  });

  test("a skip with no reason pins as the title and a bare bar", () => {
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", skip, "skipped"));
    expect(check(listed, merged, ["y.spec.ts › group › two |"]).problems).toEqual([]);
  });

  test("a test planned but never run (results: []) is a problem", () => {
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", []));
    expect(check(listed, merged, []).problems).toEqual(["never ran: y.spec.ts › group › two"]);
  });

  test("tests skipped after a failure in the same file are not blamed as new skips", () => {
    // A failing serial test or a throwing beforeAll marks the rest of the file
    // skipped; the failure is the shard's red, not a skip-list problem.
    const three = report(spec("1", "x.spec.ts", "one", []), spec("2", "x.spec.ts", "two", []), spec("3", "y.spec.ts", "three", []));
    const merged = report(
      spec("1", "x.spec.ts", "one", [{ status: "failed", duration: 10 }], "unexpected"),
      spec("2", "x.spec.ts", "two", skip, "skipped"),
      spec("3", "y.spec.ts", "three", pass),
    );
    expect(check(three, merged, [])).toEqual({ problems: [], ran: 3, skipped: [] });
  });

  // A skipped test in a file with a failure is one of: (A) annotated
  // skip/fixme — its skip fired, so it is pinned as usual; (B) unannotated —
  // an earlier failure in its serial group or beforeAll scope stopped it
  // before its body ran, so whether it would have skipped is unknown; (C) only
  // non-skip annotations — the same as B.
  const failedFile = (...rest: ReturnType<typeof spec>[]) => ({
    listed: report(spec("1", "x.spec.ts", "one", []), ...rest.map((r) => ({ ...r, tests: r.tests.map((t) => ({ ...t, results: [] })) }))),
    merged: report(spec("1", "x.spec.ts", "one", [{ status: "failed", duration: 10 }], "unexpected"), ...rest),
  });

  test("(A) an annotated skip in a file that also failed still matches its pin", () => {
    const { listed: l, merged: m } = failedFile(spec("2", "x.spec.ts", "two", skip, "skipped", "one bot"));
    expect(check(l, m, ["x.spec.ts › group › two | one bot"])).toEqual({
      problems: [],
      ran: 2,
      skipped: ["x.spec.ts › group › two | one bot"],
    });
  });

  test("(B) a pinned test an earlier failure stopped is not reported as 'did not skip'", () => {
    // wiki-agent-lens and wiki-chat-dialog skip at runtime under a file-level
    // beforeAll; if that beforeAll throws, their test.skip never runs.
    const { listed: l, merged: m } = failedFile(spec("2", "x.spec.ts", "two", skip, "skipped"));
    expect(check(l, m, ["x.spec.ts › group › two | one bot"])).toEqual({ problems: [], ran: 2, skipped: [] });
  });

  test("(B) the same holds for a pin with no reason", () => {
    const { listed: l, merged: m } = failedFile(spec("2", "x.spec.ts", "two", skip, "skipped"));
    expect(check(l, m, ["x.spec.ts › group › two |"]).problems).toEqual([]);
  });

  test("(C) a stopped test that carries only a non-skip annotation is still stopped, not a new skip", () => {
    const stopped = spec("2", "x.spec.ts", "two", skip, "skipped");
    stopped.tests[0]!.annotations = [{ type: "issue", description: "#12" }];
    const { listed: l, merged: m } = failedFile(stopped);
    expect(check(l, m, [])).toEqual({ problems: [], ran: 2, skipped: [] });
  });

  test("a pinned test that RAN in a failed file still reads as 'did not skip'", () => {
    const { listed: l, merged: m } = failedFile(spec("2", "x.spec.ts", "two", pass));
    expect(check(l, m, ["x.spec.ts › group › two | one bot"]).problems).toEqual([
      "expected to skip, did not: x.spec.ts › group › two | one bot",
    ]);
  });

  test("a result for a test --list does not know is a problem", () => {
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", pass), spec("3", "z.spec.ts", "three", pass));
    expect(check(listed, merged, []).problems).toEqual(["ran but not in --list (in two shards?): z.spec.ts › group › three"]);
  });
});

test("timingsFromReport sums a file's test durations in seconds", () => {
  const merged = report(
    spec("1", "x.spec.ts", "one", [{ status: "passed", duration: 1500 }]),
    spec("2", "x.spec.ts", "two", [{ status: "passed", duration: 2049 }]),
    spec("3", "y.spec.ts", "three", skip, "skipped"),
  );
  expect(timingsFromReport(merged)).toEqual({ "x.spec.ts": 3.5, "y.spec.ts": 0 });
});

test("parseExpectedSkips drops blank lines and comments", () => {
  expect(parseExpectedSkips("# why\n\n  a › b  \n# more\nc › d\n")).toEqual(["a › b", "c › d"]);
});

test("specFiles finds specs in subdirectories too, as testMatch **/*.spec.ts does", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-shards-"));
  mkdirSync(path.join(dir, "sub"));
  for (const f of ["a.spec.ts", "sub/b.spec.ts", "c.test.ts"]) writeFileSync(path.join(dir, f), "");
  expect(await specFiles(dir)).toEqual(["a.spec.ts", "sub/b.spec.ts"]);
});
