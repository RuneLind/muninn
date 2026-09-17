#!/usr/bin/env bun
/**
 * Count this repo's tests, grouped unit / integration / e2e.
 *
 *   bun run test:count            # static declaration count, no services needed
 *   bun run test:count -- --run   # measured: runs the chains, reads their totals
 *   bun run test:count -- --files # per-file static count
 *   bun run test:count -- --json  # machine-readable
 *
 * Grouping comes from the `test*` chains in package.json, parsed with the same
 * `bunTestLinks`/`expandLink` the mock-isolation guard uses — not from the
 * directory tree. The tree cannot answer it: `src/db/threads.test.ts` needs
 * Postgres and `src/db/migrate-db-url.test.ts` does not, and only the chain that
 * runs a file says which. A chain the mapping does not name is reported rather
 * than silently dropped, so adding one shows up here.
 *
 * The two modes disagree by design. The static count reads declarations, so a
 * table-driven `test.each([...])` counts once however many cases it expands to;
 * measured mode asks bun and Playwright what they ran. Measured is the number to
 * quote; static is the one that runs anywhere in under a second.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunTestLinks, expandLink } from "../src/test/mock-isolation.ts";

const ROOT = join(import.meta.dir, "..");

type Group = "unit" | "integration" | "e2e" | "ungrouped";
const GROUPS: Group[] = ["unit", "integration", "e2e", "ungrouped"];

/**
 * A test is *integration* when it needs something outside its own process — the
 * Postgres container, or a booted server. Everything else is *unit*, including the
 * handler chain, which mocks every dependency it touches. `test:e2e` is absent
 * because it runs Playwright, not bun: its files are the `e2e/*.spec.ts` glob.
 */
const GROUP_OF_SCRIPT: Record<string, Group> = {
  "test:unit": "unit",
  "test:handlers": "unit",
  "test:hivemind": "unit",
  "test:db": "integration",
  "test:integration": "integration",
};

/**
 * Chains that group nothing. `test:coverage` is bun's whole-repo single-process run,
 * and `test` is the chain CI runs — measured 2026-09-16, it is NOT the union of the
 * five grouped chains: 15 files only it runs and 14 only they run. So it grades
 * membership instead of defining it, and a test file no grouped chain runs lands in
 * `ungrouped` rather than going missing from the total.
 */
const AGGREGATE_SCRIPTS = new Set(["test", "test:coverage"]);
const CI_SCRIPT = "test";

/** Modifiers that declare no test: bun and Playwright hooks, and Playwright's structure calls. */
const HOOKS = new Set([
  "describe",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
  "use",
  "setTimeout",
  "step",
  "slow",
  "info",
  "extend",
]);

const DECL = /^[ \t]*(?:it|test)(?:\.(?<mod>[A-Za-z]+))?[ \t]*\(/gm;

interface FileCount {
  tests: number;
  /** `test.each([...])` tables, which the static count reads as one test each. */
  tables: number;
}

/**
 * Count test declarations in one source file.
 *
 * A modifier only counts when its first argument is a string literal, which is
 * what separates a declaration from a condition: `test.skip("name", fn)` is a
 * skipped test, `test.skip(cond, "reason")` skips the file, and a bare
 * `test.fail()` inside a body marks the test around it.
 */
export function countDeclarations(src: string): FileCount {
  let tests = 0;
  let tables = 0;
  for (const m of src.matchAll(DECL)) {
    const mod = m.groups?.mod;
    if (mod && HOOKS.has(mod)) continue;
    if (mod === "each") {
      tests++;
      tables++;
      continue;
    }
    if (!mod) {
      tests++;
      continue;
    }
    // The name can sit on the next line, so look past the newline, not just the match.
    const rest = src.slice(m.index + m[0].length).trimStart();
    if (rest.startsWith('"') || rest.startsWith("'") || rest.startsWith("`")) tests++;
  }
  return { tests, tables };
}

function glob(dir: string, pattern: string): string[] {
  const out: string[] = [];
  for (const rel of new Bun.Glob(pattern).scanSync({ cwd: join(ROOT, dir) })) out.push(`${dir}/${rel}`);
  return out.sort();
}

function bunTestFiles(): string[] {
  return ["src", "db", "e2e"].flatMap((d) => glob(d, "**/*.test.ts")).sort();
}

interface StaticReport {
  groups: Record<Group, { files: string[]; tests: number; tables: number }>;
  /** Test files no chain runs at all, so only `bun test --coverage` ever loads them. */
  unrun: string[];
  /** Test files only the CI chain runs, which is why they are ungrouped. */
  ciOnly: string[];
  /** Test files a grouped chain runs and the CI chain does not, so CI never runs them. */
  outsideCi: string[];
  warnings: string[];
}

function staticReport(): StaticReport {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const all = bunTestFiles();
  const warnings: string[] = [];
  const members = new Map<Group, Set<string>>(GROUPS.map((g) => [g, new Set<string>()]));
  const anyChain = new Set<string>();
  const ciChain = new Set<string>();

  for (const link of bunTestLinks(pkg.scripts)) {
    const files = expandLink(link.args, all);
    if (link.script === CI_SCRIPT) for (const f of files) ciChain.add(f);
    if (link.script !== "test:coverage") for (const f of files) anyChain.add(f);
    if (AGGREGATE_SCRIPTS.has(link.script)) continue;
    const group = GROUP_OF_SCRIPT[link.script];
    if (!group) {
      warnings.push(`${link.script}: chain is in no group — add it to GROUP_OF_SCRIPT or AGGREGATE_SCRIPTS`);
      continue;
    }
    for (const f of files) members.get(group)!.add(f);
  }
  for (const f of glob("e2e", "**/*.spec.ts")) members.get("e2e")!.add(f);

  const grouped = new Set([...members.values()].flatMap((s) => [...s]));
  for (const f of all) if (!grouped.has(f)) members.get("ungrouped")!.add(f);
  for (const f of grouped) {
    const inGroups = GROUPS.filter((g) => members.get(g)!.has(f));
    if (inGroups.length > 1) warnings.push(`${f}: counted in ${inGroups.join(" and ")}`);
  }

  const groups = {} as StaticReport["groups"];
  for (const g of GROUPS) {
    const files = [...members.get(g)!].sort();
    let tests = 0;
    let tables = 0;
    for (const f of files) {
      const c = countDeclarations(readFileSync(join(ROOT, f), "utf8"));
      tests += c.tests;
      tables += c.tables;
    }
    groups[g] = { files, tests, tables };
  }
  const ungrouped = groups.ungrouped.files;
  return {
    groups,
    unrun: ungrouped.filter((f) => !anyChain.has(f)),
    ciOnly: ungrouped.filter((f) => anyChain.has(f)),
    outsideCi: [...grouped].filter((f) => f.endsWith(".test.ts") && !ciChain.has(f)).sort(),
    warnings,
  };
}

interface RunRow {
  group: Group;
  label: string;
  tests: number;
  files: number;
  ok: boolean;
}

async function measure(cmd: string[], re: RegExp): Promise<{ tests: number; files: number; ok: boolean }> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let tests = 0;
  let files = 0;
  for (const m of `${out}\n${err}`.matchAll(re)) {
    tests += Number(m[1]);
    files += Number(m[2]);
  }
  return { tests, files, ok: code === 0 };
}

/** One summary line per `bun test` process, so a chain of N links prints N of them. */
const BUN_TOTAL = /Ran (\d+) tests? across (\d+) files?/g;
/** Playwright's `--list` footer. Listing is enough: it collects every test without running one. */
const PW_TOTAL = /Total: (\d+) tests? in (\d+) files?/g;

async function runReport(): Promise<RunRow[]> {
  const rows: RunRow[] = [];
  for (const [script, group] of Object.entries(GROUP_OF_SCRIPT)) {
    process.stderr.write(`running ${script}…\n`);
    const r = await measure(["bun", "run", script], BUN_TOTAL);
    rows.push({ group, label: script, ...r });
  }
  process.stderr.write("listing e2e specs…\n");
  const pw = await measure(["bunx", "playwright", "test", "--list"], PW_TOTAL);
  rows.push({ group: "e2e", label: "test:e2e (--list)", ...pw });
  return rows;
}

const n = (v: number) => v.toLocaleString("en-US");

function printTable(header: readonly string[], rows: readonly (readonly string[])[]) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");
  console.log(line(header));
  for (const r of rows) console.log(line(r));
}

/**
 * The CLI. Guarded so importing `countDeclarations` — from a test, or another
 * script — does not print a report as a side effect.
 */
async function main() {
  const args = Bun.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "Count the tests in this repo, grouped unit / integration / e2e.",
        "",
        "  bun run test:count                 static declaration count",
        "  bun run test:count -- --run        measured: runs the bun chains, lists the e2e specs",
        "  bun run test:count -- --files      per-file static count",
        "  bun run test:count -- --json       machine-readable",
        "",
        "--run needs the Postgres container for the integration chain: bun run db:up",
      ].join("\n"),
    );
    process.exit(0);
  }

  const json = args.includes("--json");
  const report = staticReport();

  if (args.includes("--run")) {
    const rows = await runReport();
    const byGroup = GROUPS.map((g) => {
      const mine = rows.filter((r) => r.group === g);
      return {
        group: g,
        tests: mine.reduce((s, r) => s + r.tests, 0),
        files: mine.reduce((s, r) => s + r.files, 0),
        failed: mine.filter((r) => !r.ok).map((r) => r.label),
      };
    });
    const total = byGroup.reduce((s, g) => s + g.tests, 0);
    if (json) {
      console.log(JSON.stringify({ mode: "run", chains: rows, groups: byGroup, total }, null, 2));
    } else {
      printTable(
        ["chain", "group", "files", "tests", "result"],
        rows.map((r) => [r.label, r.group, n(r.files), n(r.tests), r.ok ? "pass" : "FAIL"]),
      );
      console.log("");
      printTable(
        ["group", "files", "tests"],
        [
          // `ungrouped` has no chain to measure, so it is absent here rather than a zero.
          ...byGroup.filter((g) => g.group !== "ungrouped").map((g) => [g.group, n(g.files), n(g.tests)]),
          ["total", n(byGroup.reduce((s, g) => s + g.files, 0)), n(total)],
        ],
      );
      console.log("");
      console.log("Files count once per bun test process, so a file in two chains counts twice.");
      if (report.groups.ungrouped.files.length) {
        console.log(
          `No chain measures ${report.groups.ungrouped.files.length} test file(s) carrying ` +
            `~${n(report.groups.ungrouped.tests)} declarations. Run without --run to count them.`,
        );
      }
      const failed = byGroup.flatMap((g) => g.failed);
      if (failed.length) console.log(`Chains that failed: ${failed.join(", ")}. Counts above are still what ran.`);
    }
    process.exit(0);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: "static",
          groups: Object.fromEntries(
            GROUPS.map((g) => [
              g,
              { files: report.groups[g].files.length, tests: report.groups[g].tests, tables: report.groups[g].tables },
            ]),
          ),
          total: GROUPS.reduce((s, g) => s + report.groups[g].tests, 0),
          unrun: report.unrun,
          ciOnly: report.ciOnly,
          outsideCi: report.outsideCi,
          warnings: report.warnings,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (args.includes("--files")) {
    for (const g of GROUPS) {
      console.log(`\n${g}`);
      printTable(
        ["file", "tests"],
        report.groups[g].files.map((f) => [f, n(countDeclarations(readFileSync(join(ROOT, f), "utf8")).tests)]),
      );
    }
    for (const [label, files] of [
      ["no chain runs these", report.unrun],
      ["only the `test` chain runs these", report.ciOnly],
      ["the `test` chain skips these, so CI does too", report.outsideCi],
    ] as const) {
      if (!files.length) continue;
      console.log(`\n${label}`);
      for (const f of files) console.log(`  ${f}`);
    }
    console.log("");
  }

  printTable(
    ["group", "files", "tests"],
    [
      ...GROUPS.map((g) => [g, n(report.groups[g].files.length), n(report.groups[g].tests)]),
      [
        "total",
        n(GROUPS.reduce((s, g) => s + report.groups[g].files.length, 0)),
        n(GROUPS.reduce((s, g) => s + report.groups[g].tests, 0)),
      ],
    ],
  );

  const tables = GROUPS.reduce((s, g) => s + report.groups[g].tables, 0);
  console.log("");
  console.log(
    `Static declaration count. ${n(tables)} table-driven declarations count once each, so this reads a little low; ` +
      "`--run` reports what bun and Playwright actually ran.",
  );
  const drift = [
    report.unrun.length ? `${report.unrun.length} file(s) no chain runs — only \`bun test --coverage\` loads them` : "",
    report.ciOnly.length ? `${report.ciOnly.length} file(s) only the \`test\` chain runs, so no group claims them` : "",
    report.outsideCi.length
      ? `${report.outsideCi.length} file(s) a grouped chain runs and \`test\` does not, so CI never runs them`
      : "",
    ...report.warnings,
  ].filter(Boolean);
  if (drift.length) {
    console.log("");
    console.log("Drift between the chains:");
    for (const d of drift) console.log(`  ${d}`);
    console.log("  Run with --files for the file lists.");
  }
}

if (import.meta.main) await main();
