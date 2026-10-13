import { describe, test, expect } from "bun:test";
import { check, flatten, parseExpectedSkips, partition, timingsFromReport, type JsonReport } from "./e2e-shards.ts";

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

const spec = (id: string, file: string, title: string, results: { status: string; duration: number }[], status = "expected") => ({
  id,
  file,
  title,
  tests: [{ projectName: "chromium", status, results }],
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

describe("check", () => {
  const listed = report(spec("1", "x.spec.ts", "one", []), spec("2", "y.spec.ts", "two", []));

  test("clean when every listed test ran once and the skips match", () => {
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", skip, "skipped"));
    expect(check(listed, merged, ["y.spec.ts › group › two"])).toEqual({
      problems: [],
      ran: 2,
      skipped: ["y.spec.ts › group › two"],
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
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", skip, "skipped"));
    expect(check(listed, merged, []).problems).toEqual([
      "skipped, not in e2e/ci-expected-skips.txt: y.spec.ts › group › two",
    ]);
  });

  test("an expected skip that now runs fails too, so the list cannot rot", () => {
    const merged = report(spec("1", "x.spec.ts", "one", pass), spec("2", "y.spec.ts", "two", pass));
    expect(check(listed, merged, ["y.spec.ts › group › two"]).problems).toEqual([
      "expected to skip, did not: y.spec.ts › group › two",
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
