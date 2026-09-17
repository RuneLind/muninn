#!/usr/bin/env bun
/**
 * Count this repo's tests, grouped unit / integration / e2e. `--help` lists the modes.
 *
 * Grouping follows the `test*` chains in package.json, parsed with the same
 * `bunTestLinks`/`expandLink` the mock-isolation guard uses, because a chain is
 * where the repo decides what a test needs in order to run. The directory tree
 * cannot say it: `db/postgres-connection.test.ts` runs in `test:unit` and opens no
 * connection, while `db/provision.test.ts` beside it runs in `test:db` and needs an
 * admin Postgres. A chain the mapping does not name is reported, not dropped.
 *
 * The static count reads declarations, so it reads low: a test declared inside a
 * loop, or a `.each` table, counts once. `--run` measures instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SINGLE_PROCESS_SCRIPTS,
  TEST_FILE_DIRS,
  TEST_FILE_GLOB,
  bunTestLinks,
  expandLink,
} from "../src/test/mock-isolation.ts";

const ROOT = join(import.meta.dir, "..");

type Group = "unit" | "integration" | "e2e" | "ungrouped";
const GROUPS: readonly Group[] = ["unit", "integration", "e2e", "ungrouped"];

/**
 * A chain is *integration* when running it needs something outside its own process —
 * the Postgres container or a live server — and *unit* otherwise. The chain is the
 * unit of grouping, so a chain that mixes both counts as the kind that needs the
 * service: `test:hivemind` is integration because most of its files open the test
 * database. `test:handlers` is unit because it mocks every dependency it touches.
 * `test:e2e` is absent because it runs Playwright, not bun; its files are the
 * `e2e/*.spec.ts` glob.
 */
const GROUP_OF_SCRIPT: Record<string, Group> = {
  "test:unit": "unit",
  "test:handlers": "unit",
  "test:hivemind": "integration",
  "test:db": "integration",
  "test:integration": "integration",
};

/** The chain CI runs. It is not the union of the grouped chains, so it grades membership rather than defining it. */
const CI_SCRIPT = "test";

/**
 * Chains `--run` leaves out and counts statically. `src/chat/integration.test.ts`
 * drives the developer's own `bun run dev` on port 3010 and makes real Claude calls,
 * which a counting command must not do as a side effect.
 */
const LIVE_SCRIPTS: ReadonlySet<string> = new Set(["test:integration"]);

/** A declaration call at the start of a line: `it(`, `test(`, or either with one modifier. */
const DECL = /^[ \t]*(?:it|test)(?:\.(?<mod>[A-Za-z]+))?[ \t]*\(/gm;

/**
 * Modifiers that take a name yet declare no test. Every other non-test call —
 * `beforeAll`, `use`, `setTimeout`, a bare `test.fail()` — takes no name, so the name
 * rule in `countDeclarations` already skips it.
 */
const NAMED_NON_TESTS: ReadonlySet<string> = new Set(["describe", "step"]);

interface FileCount {
  tests: number;
  /** `.each` tables, which the static count reads as one test each. */
  tables: number;
}

function nextNonSpace(src: string, at: number): number {
  let i = at;
  while (i < src.length && /\s/.test(src[i] ?? "")) i++;
  return i;
}

function isStringAt(src: string, at: number): boolean {
  const c = src[nextNonSpace(src, at)];
  return c === '"' || c === "'" || c === "`";
}

/** Index of the `)` that closes the call opened just before `open`, skipping string literals; -1 if none nearby. */
function closingParen(src: string, open: number): number {
  let depth = 1;
  const end = Math.min(src.length, open + 4000);
  for (let i = open; i < end; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < end && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Count test declarations in one source file.
 *
 * A modifier declares a test only when a name follows. The name is the first
 * argument (`test.skip("name", fn)`) or, in bun's conditional forms, the first
 * argument of a second call (`test.skipIf(cond)("name", fn)`). That rule separates
 * a declaration from Playwright's `test.skip(cond, "reason")`, which skips a file.
 */
export function countDeclarations(src: string): FileCount {
  let tests = 0;
  let tables = 0;
  for (const m of src.matchAll(DECL)) {
    const mod = m.groups?.mod;
    if (!mod) {
      tests++;
      continue;
    }
    if (NAMED_NON_TESTS.has(mod)) continue;
    if (mod === "each") {
      tests++;
      tables++;
      continue;
    }
    const open = m.index + m[0].length;
    if (isStringAt(src, open)) {
      tests++;
      continue;
    }
    const close = closingParen(src, open);
    if (close === -1) continue;
    const second = nextNonSpace(src, close + 1);
    if (src[second] === "(" && isStringAt(src, second + 1)) tests++;
  }
  return { tests, tables };
}

export interface Classification {
  /** The files in each group, sorted. A file counts in one group per chain group that runs it. */
  members: Record<Group, string[]>;
  /** The files each grouped chain runs, one entry per link, so a file two links run appears twice. */
  chains: Map<string, string[]>;
  /** Files the chains of one group run more than once, and how many times, so `--run` can subtract the repeats. */
  repeats: Map<string, number>;
  /** Test files no chain runs, so only `bun test --coverage` loads them. */
  unrun: string[];
  /** Test files only the CI chain runs, so no group claims them. */
  ciOnly: string[];
  /** Grouped test files the CI chain skips, so CI never runs them. */
  outsideCi: string[];
  warnings: string[];
}

/** Sort every test file into a group, from the chains alone. Pure, so it runs on fixtures. */
export function classify(
  scripts: Record<string, string>,
  testFiles: readonly string[],
  specFiles: readonly string[],
): Classification {
  const onDisk = new Set(testFiles);
  const warnings = new Set<string>();
  const members = new Map<Group, Set<string>>(GROUPS.map((g) => [g, new Set<string>()]));
  const chains = new Map<string, string[]>();
  const runs = new Map<Group, Map<string, number>>(GROUPS.map((g) => [g, new Map<string, number>()]));
  const anyChain = new Set<string>();
  const ciChain = new Set<string>();

  for (const { script, args } of bunTestLinks(scripts)) {
    if (SINGLE_PROCESS_SCRIPTS.has(script)) continue;
    const files: string[] = [];
    for (const f of expandLink(args, testFiles)) {
      if (onDisk.has(f)) files.push(f);
      else warnings.add(`${script}: names ${f}, which is not a test file on disk`);
    }
    for (const f of files) anyChain.add(f);
    if (script === CI_SCRIPT) {
      for (const f of files) ciChain.add(f);
      continue;
    }
    const group = GROUP_OF_SCRIPT[script];
    if (!group) {
      warnings.add(`${script}: chain is in no group — add it to GROUP_OF_SCRIPT in scripts/count-tests.ts`);
      continue;
    }
    chains.set(script, [...(chains.get(script) ?? []), ...files]);
    for (const f of files) {
      members.get(group)!.add(f);
      const inGroup = runs.get(group)!;
      inGroup.set(f, (inGroup.get(f) ?? 0) + 1);
    }
  }
  for (const f of specFiles) members.get("e2e")!.add(f);

  const grouped = new Set(GROUPS.flatMap((g) => [...members.get(g)!]));
  for (const f of testFiles) if (!grouped.has(f)) members.get("ungrouped")!.add(f);
  for (const f of grouped) {
    const inGroups = GROUPS.filter((g) => members.get(g)!.has(f));
    if (inGroups.length > 1) warnings.add(`${f}: counted in ${inGroups.join(" and ")}`);
  }

  const repeats = new Map<string, number>();
  for (const inGroup of runs.values()) {
    for (const [f, times] of inGroup) if (times > 1) repeats.set(f, times);
  }
  const sorted = Object.fromEntries(GROUPS.map((g) => [g, [...members.get(g)!].sort()])) as Record<Group, string[]>;
  const specs = new Set(specFiles);
  return {
    members: sorted,
    chains,
    repeats,
    unrun: sorted.ungrouped.filter((f) => !anyChain.has(f)),
    ciOnly: sorted.ungrouped.filter((f) => ciChain.has(f)),
    outsideCi: [...grouped].filter((f) => !specs.has(f) && !ciChain.has(f)).sort(),
    warnings: [...warnings],
  };
}

interface FileRow extends FileCount {
  path: string;
}

const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const n = (v: number) => v.toLocaleString("en-US");

function glob(dir: string, pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync({ cwd: join(ROOT, dir) })].map((rel) => `${dir}/${rel}`).sort();
}

function staticReport() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const testFiles = TEST_FILE_DIRS.flatMap((d) => glob(d, TEST_FILE_GLOB)).sort();
  const c = classify(pkg.scripts, testFiles, glob("e2e", "**/*.spec.ts"));
  const counts = new Map<string, FileCount>();
  const count = (path: string) => {
    let hit = counts.get(path);
    if (!hit) counts.set(path, (hit = countDeclarations(readFileSync(join(ROOT, path), "utf8"))));
    return hit;
  };
  const rows = Object.fromEntries(
    GROUPS.map((g) => [g, c.members[g].map((path): FileRow => ({ path, ...count(path) }))]),
  ) as Record<Group, FileRow[]>;
  return { c, rows, count };
}

async function measure(cmd: string[], re: RegExp) {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let tests = 0;
  let files = 0;
  let totals = 0;
  for (const m of `${out}\n${err}`.matchAll(re)) {
    tests += Number(m[1]);
    files += Number(m[2]);
    totals++;
  }
  return { tests, files, ok: code === 0, totals };
}

/** One summary line per `bun test` process, so a chain of N links prints N of them. */
const BUN_TOTAL = /Ran (\d+) tests? across (\d+) files?/g;
/** Playwright's `--list` footer. Listing collects every test without running one. */
const PW_TOTAL = /Total: (\d+) tests? in (\d+) files?/g;

type RunRow = { label: string; group: Group; files: number; tests: number; result: string; ok: boolean };

async function runReport({ c, count }: ReturnType<typeof staticReport>) {
  const rows: RunRow[] = [];
  const notes: string[] = [];
  for (const [script, group] of Object.entries(GROUP_OF_SCRIPT)) {
    const files = c.chains.get(script) ?? [];
    if (LIVE_SCRIPTS.has(script)) {
      rows.push({ label: script, group, files: files.length, tests: sum(files, (f) => count(f).tests), result: "static", ok: true });
      notes.push(`\`${script}\` was not run: it needs \`bun run dev\` on port 3010 and makes real Claude calls. Its row is the static count.`);
      continue;
    }
    process.stderr.write(`running ${script}…\n`);
    const r = await measure(["bun", "run", script], BUN_TOTAL);
    rows.push({ label: script, group, files: r.files, tests: r.tests, result: r.ok ? "pass" : "FAIL (partial)", ok: r.ok });
    if (r.ok && r.totals === 0) notes.push(`\`${script}\` passed but printed no test total; bun's summary line may have changed.`);
  }

  // A file two chains of one group run is counted by both; measure it once and take the extra runs back out.
  for (const [file, times] of c.repeats) {
    const group = GROUPS.find((g) => c.members[g].includes(file))!;
    const inLive = [...LIVE_SCRIPTS].some((s) => c.chains.get(s)?.includes(file));
    if (inLive) continue;
    process.stderr.write(`measuring repeat ${file}…\n`);
    const r = await measure(["bun", "test", file], BUN_TOTAL);
    const extra = times - 1;
    rows.push({ label: `repeat ${file}`, group, files: -extra, tests: -extra * r.tests, result: r.ok ? "subtracted" : "FAIL", ok: r.ok });
  }

  process.stderr.write("listing e2e specs…\n");
  const pw = await measure(["bunx", "playwright", "test", "--list"], PW_TOTAL);
  rows.push({ label: "test:e2e (--list)", group: "e2e", files: pw.files, tests: pw.tests, result: pw.ok ? "listed" : "FAIL", ok: pw.ok });
  return { rows, notes };
}

function printTable(header: readonly string[], rows: readonly (readonly string[])[]) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");
  console.log(line(header));
  for (const r of rows) console.log(line(r));
}

const HELP = `Count this repo's tests, grouped unit / integration / e2e.

  bun run test:count                   count declarations; needs no services
  bun run test:count -- --files        also list every file and the drift lists
  bun run test:count -- --json         machine-readable; add --files for per-file rows
  bun run test:count -- --run          measure: run the bun chains, list the e2e specs

--run needs the Postgres container (bun run db:up) and takes a few minutes. It does
not run test:integration, which needs a live dev server and makes real Claude calls;
that chain's row is its static count. --run cannot be combined with --files.`;

const FLAGS = new Set(["--run", "--files", "--json", "--help", "-h"]);

/**
 * The CLI. Guarded so importing `countDeclarations` or `classify` — from a test, or
 * another script — does not print a report as a side effect.
 */
async function main() {
  const args = Bun.argv.slice(2);
  const unknown = args.filter((a) => !FLAGS.has(a));
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (unknown.length || (args.includes("--run") && args.includes("--files"))) {
    console.error(unknown.length ? `Unknown option: ${unknown.join(" ")}\n` : "--run cannot be combined with --files.\n");
    console.error(HELP);
    return 2;
  }
  const json = args.includes("--json");
  const files = args.includes("--files");
  const report = staticReport();
  const { c, rows } = report;

  if (args.includes("--run")) {
    const run = await runReport(report);
    const groups = GROUPS.filter((g) => g !== "ungrouped").map((g) => {
      const mine = run.rows.filter((r) => r.group === g);
      return { group: g, files: sum(mine, (r) => r.files), tests: sum(mine, (r) => r.tests) };
    });
    const total = { files: sum(groups, (g) => g.files), tests: sum(groups, (g) => g.tests) };
    const failed = run.rows.filter((r) => !r.ok).map((r) => r.label);
    const ungrouped = { files: rows.ungrouped.length, tests: sum(rows.ungrouped, (r) => r.tests) };
    if (json) {
      console.log(JSON.stringify({ mode: "run", chains: run.rows, groups, total, ungrouped, notes: run.notes, warnings: c.warnings }, null, 2));
    } else {
      printTable(
        ["chain", "group", "files", "tests", "result"],
        run.rows.map((r) => [r.label, r.group, n(r.files), n(r.tests), r.result]),
      );
      console.log("");
      printTable(["group", "files", "tests"], [
        ...groups.map((g) => [g.group, n(g.files), n(g.tests)]),
        ["total", n(total.files), n(total.tests)],
      ]);
      const lines = [
        ...run.notes,
        ...(ungrouped.files
          ? [`No chain measures ${ungrouped.files} test file(s) carrying ~${n(ungrouped.tests)} declarations. Run without --run to count them.`]
          : []),
        ...c.warnings,
        ...(failed.length ? [`Failed: ${failed.join(", ")}. A failed chain stops at its failing link, so its count is partial.`] : []),
      ];
      if (lines.length) console.log(`\n${lines.join("\n")}`);
    }
    return failed.length ? 1 : 0;
  }

  const groupTotals = GROUPS.map((g) => ({ group: g, files: rows[g].length, tests: sum(rows[g], (r) => r.tests), tables: sum(rows[g], (r) => r.tables) }));
  const total = { files: sum(groupTotals, (g) => g.files), tests: sum(groupTotals, (g) => g.tests) };

  if (json) {
    const out = {
      mode: "static",
      groups: Object.fromEntries(groupTotals.map(({ group, ...rest }) => [group, files ? { ...rest, rows: rows[group] } : rest])),
      total,
      unrun: c.unrun,
      ciOnly: c.ciOnly,
      outsideCi: c.outsideCi,
      warnings: c.warnings,
    };
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  if (files) {
    for (const g of GROUPS) {
      console.log(`\n${g}`);
      printTable(["file", "tests"], rows[g].map((r) => [r.path, n(r.tests)]));
    }
    for (const [label, list] of [
      ["no chain runs these", c.unrun],
      ["only the `test` chain runs these", c.ciOnly],
      ["the `test` chain skips these, so CI does too", c.outsideCi],
    ] as const) {
      if (list.length) console.log(`\n${label}\n${list.map((f) => `  ${f}`).join("\n")}`);
    }
    console.log("");
  }

  printTable(["group", "files", "tests"], [
    ...groupTotals.map((g) => [g.group, n(g.files), n(g.tests)]),
    ["total", n(total.files), n(total.tests)],
  ]);
  console.log(
    "\nStatic count of declarations. A test declared inside a loop, or a `.each` table, counts once, so this reads low; `--run` measures.",
  );
  const drift = [
    c.unrun.length ? `${c.unrun.length} file(s) no chain runs — only \`bun test --coverage\` loads them` : "",
    c.ciOnly.length ? `${c.ciOnly.length} file(s) only the \`test\` chain runs, so no group claims them` : "",
    c.outsideCi.length ? `${c.outsideCi.length} file(s) a grouped chain runs and \`test\` does not, so CI never runs them` : "",
    ...c.warnings,
  ].filter(Boolean);
  if (drift.length) {
    console.log(`\nDrift between the chains:\n${drift.map((d) => `  ${d}`).join("\n")}`);
    if (!files) console.log("  Run with --files for the file lists.");
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
