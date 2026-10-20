/**
 * Split the Playwright suite across CI shards by measured time, and check the
 * merged result.
 *
 *   bun scripts/e2e-shards.ts plan <i> <n> <out>      write shard i of n as a --test-list file
 *   bun scripts/e2e-shards.ts check <list.json> <merged.json>
 *   bun scripts/e2e-shards.ts refresh <merged.json>   rewrite e2e/shard-timings.json
 *
 * Why not `playwright test --shard=i/n`: without `fullyParallel` it cuts the
 * file list, in name order, into runs of equal TEST COUNT. Against the serial
 * timings that gave shards of 268, 145, 81 and 90 s — the first one alone set
 * the CI wall clock. `plan` instead packs whole files, longest first, onto the
 * least-loaded shard, using `e2e/shard-timings.json`. A file the table does
 * not know yet costs the median, so a new spec lands somewhere rather than
 * nowhere; a stale table costs balance, never coverage.
 *
 * `check` is the fan-in's gate. Four shards can each be green while the suite
 * is not, so it compares the merged report with `playwright test --list`:
 * every listed test ran exactly once (a file in two lists or in none is a
 * failure), and the set of skipped tests, each with its reason, equals
 * `e2e/ci-expected-skips.txt`.
 * The skip half exists because this suite's worst failure is a spec that skips
 * itself green when its fixture is missing (e2e/CLAUDE.md).
 */
import { Glob } from "bun";
import path from "node:path";

const E2E_DIR = path.join(import.meta.dir, "..", "e2e");
const TIMINGS_PATH = path.join(E2E_DIR, "shard-timings.json");
const EXPECTED_SKIPS_PATH = path.join(E2E_DIR, "ci-expected-skips.txt");

export type Timings = Record<string, number>;

/** Longest-processing-time packing: deterministic for a given file set and table. */
export function partition(files: string[], timings: Timings, total: number): string[][] {
  if (!Number.isInteger(total) || total < 1) throw new Error(`shard total must be a positive integer, got ${total}`);
  const cost = specCost(files, timings);
  const sorted = [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
  const shards = Array.from({ length: total }, () => ({ files: [] as string[], load: 0 }));
  for (const f of sorted) {
    let best = shards[0]!;
    for (const s of shards) if (s.load < best.load) best = s;
    best.files.push(f);
    best.load += cost(f);
  }
  return shards.map((s) => s.files.sort());
}

/** What `partition` charges a spec: its table time, or the median of the known ones when it has none. */
export function specCost(files: string[], timings: Timings): (f: string) => number {
  const known = files.map((f) => timings[f]).filter((s): s is number => typeof s === "number");
  const fallback = median(known) ?? 1;
  return (f) => timings[f] ?? fallback;
}

/**
 * What shard `index` of `total` plans and prints. Every matrix shard runs
 * `plan`, so only shard 1 prints the warnings: GitHub shows each once. The
 * per-shard loads use the charge `partition` packed by.
 */
export function planShard(files: string[], timings: Timings, index: number, total: number): { mine: string[]; lines: string[] } {
  const shards = partition(files, timings, total);
  const mine = shards[index - 1];
  if (!mine) throw new Error(`shard ${index} is outside 1..${total}`);
  const cost = specCost(files, timings);
  const lines = index === 1 ? untimedSpecWarnings(files, timings) : [];
  shards.forEach((s, k) => {
    const load = s.reduce((a, f) => a + cost(f), 0);
    lines.push(`${k + 1 === index ? "→" : " "} shard ${k + 1}/${total}: ${s.length} files, ~${Math.round(load)} s by the table`);
  });
  lines.push(...mine.map((f) => `  ${f}`));
  return { mine, lines };
}

/**
 * One `::warning::` line per spec the table has no entry for. A missing entry
 * costs balance, never coverage, so this warns and never fails the plan: the
 * three work-thread specs ran at 54, 97 and 17 s while `partition` charged
 * each the median, and nothing said the table was stale.
 */
export function untimedSpecWarnings(files: string[], timings: Timings): string[] {
  return files
    .filter((f) => typeof timings[f] !== "number")
    .map((f) => `::warning::${f} has no entry in e2e/shard-timings.json, so the plan charges it the median; run \`bun scripts/e2e-shards.ts refresh e2e-results.json\` from a green run's e2e-report artifact`);
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2;
}

// --- Playwright JSON reporter shape (the fields read here) ---
type JsonResult = { status: string; duration: number; startTime?: string };
type JsonTest = {
  projectName: string;
  status: string;
  results: JsonResult[];
  annotations?: { type: string; description?: string }[];
};
type JsonSpec = { id: string; title: string; file: string; tests: JsonTest[] };
type JsonSuite = { title: string; file: string; specs?: JsonSpec[]; suites?: JsonSuite[] };
export type JsonReport = { suites: JsonSuite[]; errors?: unknown[] };

const SKIP_TYPES = new Set(["skip", "fixme"]);

export type FlatTest = {
  id: string;
  file: string;
  title: string;
  results: JsonResult[];
  outcome: string;
  /** The last `test.skip`/`test.fixme` reason, "" when it gave none. */
  skipReason: string;
  /**
   * Whether a `test.skip`/`test.fixme` fired for this test. A test Playwright
   * skipped because an earlier failure in its serial group or `beforeAll`
   * scope stopped it carries none: its body, and any skip in it, never ran.
   */
  skipAnnotated: boolean;
};

/** One row per (spec, project); `title` is the describe chain plus the spec title. */
export function flatten(report: JsonReport): FlatTest[] {
  const out: FlatTest[] = [];
  const walk = (suite: JsonSuite, chain: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const skips = (t.annotations ?? []).filter((a) => SKIP_TYPES.has(a.type));
        out.push({
          id: `${spec.id}:${t.projectName}`,
          file: spec.file,
          title: [spec.file, ...chain, spec.title].join(" › "),
          results: t.results,
          outcome: t.status,
          skipReason: skips.at(-1)?.description ?? "",
          skipAnnotated: skips.length > 0,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...chain, child.title]);
  };
  // A root suite is the file; its title is the file name, not a describe.
  for (const fileSuite of report.suites) walk(fileSuite, []);
  return out;
}

export type CheckResult = { problems: string[]; ran: number; skipped: string[] };

export function check(listed: JsonReport, merged: JsonReport, expectedSkips: string[]): CheckResult {
  const problems: string[] = [];
  const ranTests = flatten(merged);
  const ranById = new Map(ranTests.map((t) => [t.id, t]));
  // A skipped test in a file with a failure either had its skip fire
  // (annotated: pinned as usual) or was stopped by an earlier failure in its
  // serial group or beforeAll scope (unannotated). A stopped test's own skip
  // never ran, so it is neither a new skip nor a pin that "did not skip"; the
  // failure is the shard's red, reported by the job.
  const failedFiles = new Set(ranTests.filter((t) => t.outcome === "unexpected").map((t) => t.file));
  const stopped = new Set<string>();
  const skipped: string[] = [];
  const outcomeByTitle = new Map<string, FlatTest>();
  const titles: string[] = [];
  // Never ran or interrupted: already a problem of its own, so its pin adds nothing.
  const unreached = new Set<string>();
  let ran = 0;
  for (const t of flatten(listed)) {
    const r = ranById.get(t.id);
    ranById.delete(t.id);
    titles.push(t.title);
    if (r) outcomeByTitle.set(t.title, r);
    if (!r || r.results.length === 0) {
      problems.push(`never ran: ${t.title}`);
      unreached.add(t.title);
      continue;
    }
    // `retries: 0`, so a second result means two shards ran the same test.
    if (r.results.length > 1) problems.push(`ran ${r.results.length} times: ${t.title}`);
    ran++;
    // Interrupted is neither expected nor unexpected, so Playwright computes
    // the outcome "skipped", with no skip annotation.
    if (r.results.some((x) => x.status === "interrupted")) {
      problems.push(`interrupted: ${t.title}`);
      unreached.add(t.title);
      continue;
    }
    // A skip that fired and was then charged a failing afterAll/afterEach is
    // `unexpected`, but its skip and reason are still compared with the list.
    if (r.outcome !== "skipped" && !(r.outcome === "unexpected" && r.skipAnnotated)) continue;
    if (failedFiles.has(r.file) && !r.skipAnnotated) stopped.add(t.title);
    else skipped.push(skipKey(t.title, r.skipReason));
  }
  // merge-reports gives the second copy of a test two shards both ran a salted
  // id, so a duplicate lands here rather than in the count above.
  for (const r of ranById.values()) problems.push(`ran but not in --list (in two shards?): ${r.title}`);

  const expected = new Set(expectedSkips);
  const actual = new Set(skipped);
  for (const s of skipped) if (!expected.has(s)) problems.push(`skipped, not in e2e/ci-expected-skips.txt: ${s}`);
  for (const pin of expectedSkips) {
    if (actual.has(pin)) continue;
    const title = pinTitle(pin, titles);
    if (title === undefined) {
      problems.push(`expected to skip, no such test in --list: ${pin}`);
      continue;
    }
    const r = outcomeByTitle.get(title);
    if (!r || unreached.has(title) || stopped.has(title)) continue;
    if (r.outcome === "unexpected") {
      // Skipped for another reason, then a hook failed: that skip is already
      // reported as not in the list. Failed without skipping: say so.
      if (!r.skipAnnotated) problems.push(`expected to skip, failed instead: ${pin}`);
      continue;
    }
    problems.push(`expected to skip, did not: ${pin}`);
  }
  return { problems, ran, skipped: skipped.sort() };
}

/**
 * The test title a pin names. A pin is `title | reason`, and real titles
 * contain ` | ` too (`wiki-share.spec.ts`, `wiki-related-work.spec.ts`), so
 * the pin is matched against the titles `--list` knows, longest first, rather
 * than split on a bar.
 */
export function pinTitle(pin: string, titles: string[]): string | undefined {
  let best: string | undefined;
  for (const title of titles) {
    if (pin !== skipKey(title, "") && !pin.startsWith(`${title} | `)) continue;
    if (best === undefined || title.length > best.length) best = title;
  }
  return best;
}

/**
 * Seconds per spec file: from its first test's start to its last test's end.
 * Summing test durations instead misses the time between tests (contexts,
 * hooks): on run 38367891322 the sum covered 84 % of the shards' Playwright
 * steps and the span 96 %; the rest is each shard's own server and browser
 * start. A file whose results carry no start time falls back to the sum.
 */
export function timingsFromReport(merged: JsonReport): Timings {
  const byFile = new Map<string, JsonResult[]>();
  for (const t of flatten(merged)) byFile.set(t.file, [...(byFile.get(t.file) ?? []), ...t.results]);
  const secs: Timings = {};
  for (const [file, results] of byFile) {
    const starts = results.map((r) => (r.startTime ? Date.parse(r.startTime) : NaN));
    if (starts.length > 0 && starts.every(Number.isFinite)) {
      const first = Math.min(...starts);
      const last = Math.max(...results.map((r, k) => starts[k]! + r.duration));
      secs[file] = (last - first) / 1000;
    } else {
      secs[file] = results.reduce((a, r) => a + r.duration, 0) / 1000;
    }
  }
  return Object.fromEntries(
    Object.entries(secs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, s]) => [f, Math.round(s * 10) / 10]),
  );
}

/**
 * A skip is pinned by title AND reason: one test can skip for a deliberate
 * reason ("only one bot") and for the missing-fixture one ("no bots"), and a
 * title-only pin would accept both.
 */
export function skipKey(title: string, reason: string): string {
  return `${title} | ${reason}`.trim();
}

export function parseExpectedSkips(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export async function specFiles(dir = E2E_DIR): Promise<string[]> {
  const files: string[] = [];
  // Recursive, like `testMatch: "**/*.spec.ts"`; a spec in a subdirectory
  // that no shard plans would otherwise only surface as "never ran".
  for await (const f of new Glob("**/*.spec.ts").scan(dir)) files.push(f);
  return files.sort();
}

async function readTimings(): Promise<Timings> {
  return ((await Bun.file(TIMINGS_PATH).json()) as { seconds: Timings }).seconds;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "plan" && rest.length === 3) {
    const [i, n, out] = [Number(rest[0]), Number(rest[1]), rest[2]!];
    const timings = await readTimings();
    const files = await specFiles();
    const { mine, lines } = planShard(files, timings, i, n);
    await Bun.write(out, mine.join("\n") + "\n");
    console.log(lines.join("\n"));
    return 0;
  }
  if (cmd === "check" && rest.length === 2) {
    const listed = (await Bun.file(rest[0]!).json()) as JsonReport;
    const merged = (await Bun.file(rest[1]!).json()) as JsonReport;
    const expectedFile = Bun.file(EXPECTED_SKIPS_PATH);
    const expected = (await expectedFile.exists()) ? parseExpectedSkips(await expectedFile.text()) : [];
    const { problems, ran, skipped } = check(listed, merged, expected);
    console.log(`${ran} tests ran across the shards, ${skipped.length} skipped:`);
    for (const s of skipped) console.log(`  ${s}`);
    if (problems.length === 0) return 0;
    for (const p of problems) console.log(`::error::${p}`);
    return 1;
  }
  if (cmd === "refresh" && rest.length === 1) {
    const merged = (await Bun.file(rest[0]!).json()) as JsonReport;
    const seconds = timingsFromReport(merged);
    const source = `merged CI report, ${new Date().toISOString().slice(0, 10)}`;
    await Bun.write(TIMINGS_PATH, JSON.stringify({ source, seconds }, null, 2) + "\n");
    console.log(`wrote ${Object.keys(seconds).length} files to ${path.relative(process.cwd(), TIMINGS_PATH)}`);
    return 0;
  }
  console.error("usage: bun scripts/e2e-shards.ts plan <i> <n> <out> | check <list.json> <merged.json> | refresh <merged.json>");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
