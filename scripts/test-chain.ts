/**
 * The `test` chain in package.json, generated, and CI's three unit shards over it.
 *
 *   bun scripts/test-chain.ts write                  regenerate `test` (and add new links to the shard table)
 *   bun scripts/test-chain.ts run --shard <i>/<n>    run the `test` links the table puts on shard i, one junit file per link
 *   bun scripts/test-chain.ts check [--junit <dir>] [--result <r>]… [--shard <i>/<n>]
 *                                                    the fan-in: every file ran once, mock and own-process files alone, no crash
 *   bun scripts/test-chain.ts changed <base-ref>     time the test files this branch adds or changes, alone (10 s bar)
 *   bun scripts/test-chain.ts refresh                time every chain file alone, write scripts/unit-timings.json
 *   bun scripts/test-chain.ts rebalance              regroup link 1 onto the shards by scripts/unit-timings.json
 *
 * The chain is built from six inputs: the files bun discovers, the `mock.module` scan
 * (each such file is a link of its own, see CLAUDE.md, Testing) and the own-process
 * scan (`ownProcessFiles`: happy-dom globals or boot module state, a link each the
 * same way), `PINNED` (whole
 * links kept for other reasons), the groups in `scripts/unit-shards.json` and
 * `EXCLUDED`. A group keeps its directory arguments, so a new test file under one
 * joins it with no edit; a directory is written out file by file only when a file
 * under it belongs to another link. `test` stays the serial list of exactly the
 * processes CI runs, so `bun run test` runs CI's file sets one after another and
 * `mock-isolation.test.ts` guards the partition CI really runs. A group changes only
 * through `rebalance`, because bun's file order depends on the set of files in a
 * process (`mock-isolation.test.ts`).
 *
 * The junit flags are passed here, never written into package.json, so the
 * chain-shape guard's `--coverage`-only flag rule stands.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { BUN_TEST_FILE, MOCK_MODULE_CALL, bunTestLinks, discoverTestFiles, expandLink, isPlaywrightSpec, ownProcessFiles } from "../src/test/mock-isolation.ts";

const ROOT = path.join(import.meta.dir, "..");
const SHARDS_PATH = path.join(ROOT, "scripts", "unit-shards.json");
const TIMINGS_PATH = path.join(ROOT, "scripts", "unit-timings.json");
const ALLOWLIST_PATH = path.join(ROOT, "scripts", "unit-slow-allowlist.txt");
const DEFAULT_JUNIT_DIR = "junit";

export const SHARD_TOTAL = 3;
/** The changed-file step's bar, and the margin within which a file is timed a second time. */
export const SLOW_FILE_SECONDS = 10;
export const RETIME_MARGIN_SECONDS = 2;
/** The fan-in warns when files missing from the timing table took more than this, by summed testcase time. */
export const UNTIMED_WARN_SECONDS = 60;
/** `refresh` and `changed` kill a file that runs longer than this. */
const ALONE_TIMEOUT_MS = 300_000;

export interface PinnedLink {
  /** The link's key in `unit-shards.json`; defaults to its arguments joined by a space. */
  name?: string;
  args: string[];
  reason: string;
}

const DB_CHAIN = "a `test:db` file: it opens the test database through `setupTestDb`, own link as in `test:db`";
const HANDLERS_CHAIN = "own link in `test:handlers` and `test` before A2; no other reason recorded";

/** Links that are separate processes for reasons other than one `mock.module` file. Seeded from the hand-written chain. */
export const PINNED: readonly PinnedLink[] = [
  { args: ["src/ai/connectors/openai-compat-request.test.ts"], reason: "rewrites `process.env.OPENAI_API_KEY`; own link in `test:unit`" },
  { args: ["src/ai/connectors/copilot-sdk.test.ts"], reason: "own link in `test:unit` before A2; no other reason recorded" },
  { args: ["src/db/"], reason: "the DB suite: truncates the test database's tables; first link of `test:db`" },
  { args: ["db/provision.test.ts"], reason: "creates databases and roles as an admin (CLAUDE.md, Testing)" },
  { args: ["src/dashboard/routes/summaries-transcript-check-db.test.ts"], reason: DB_CHAIN },
  { args: ["src/dashboard/routes/summary-save-delete-race-db.test.ts"], reason: DB_CHAIN },
  { args: ["src/dashboard/routes/wiki-answers-db.test.ts"], reason: DB_CHAIN },
  { args: ["src/dashboard/routes/wiki-answers-export-db.test.ts"], reason: DB_CHAIN },
  { args: ["src/dashboard/routes/wiki-decision-inbox-db.test.ts"], reason: DB_CHAIN },
  { args: ["src/dashboard/routes/wiki-decision-close-db.test.ts"], reason: DB_CHAIN },
  { args: ["src/dashboard/routes/wiki-gardener-drift-db.test.ts"], reason: DB_CHAIN },
  { args: ["src/dashboard/routes/wiki-gardener-factcheck-db.test.ts"], reason: DB_CHAIN },
  { args: ["src/bot/handler.test.ts"], reason: HANDLERS_CHAIN },
  { args: ["src/bot/middleware.test.ts"], reason: HANDLERS_CHAIN },
  {
    name: "watchers",
    args: [
      "src/watchers/consolidation-gardener.test.ts",
      "src/watchers/run-health.test.ts",
      "src/watchers/runner.test.ts",
      "src/watchers/source-health.test.ts",
      "src/watchers/wiki-committer.test.ts",
      "src/watchers/wiki-drafting.test.ts",
      "src/watchers/wiki-gardener.test.ts",
      "src/watchers/wiki-linter.test.ts",
      "src/watchers/x-amplification.test.ts",
    ],
    reason: "`src/watchers/` without its mock files, de-globbed so the directory still runs whole (mock-isolation.test.ts)",
  },
  { args: ["src/goals/detector.test.ts"], reason: HANDLERS_CHAIN },
  { args: ["src/observability/agent-status.test.ts"], reason: "own link in `test` before A2; no other reason recorded" },
  { args: ["src/dashboard/views/components/"], reason: "the components directory, one process since before A2" },
  {
    name: "views-pages",
    args: [
      "src/dashboard/views/jira-page.test.ts",
      "src/dashboard/views/models-page.test.ts",
      "src/dashboard/views/summaries-page.test.ts",
      "src/dashboard/views/research-page.test.ts",
    ],
    reason: "the four page renderers, one process since before A2",
  },
  { args: ["src/tracing/agent-run-trace.test.ts"], reason: "own link in `test:unit` before A2; no other reason recorded" },
  { args: ["src/profile/inject.test.ts"], reason: "`src/profile/` de-globbed beside its mock file `generator.test.ts` (mock-isolation.test.ts)" },
  { args: ["src/chat/routes-owner-guard.test.ts"], reason: "bun panicked at teardown when it shared a process (file header)" },
  { args: ["src/ai/tool-surface-fence.test.ts"], reason: "rewrites `process.env` for the subprocesses it spawns (file header)" },
  { args: ["src/scheduler/haiku-fence.test.ts"], reason: "rewrites `process.env` for the subprocesses it spawns (file header)" },
  { args: ["src/hivemind/"], reason: "`test:hivemind`: most files open the test database" },
  {
    args: ["src/vimeo/captions.test.ts"],
    reason: "loaded before src/format/system-map.test.ts in one process, it makes that file's 240-map property test take 5 s instead of 1.1 s and time out (bisected 2026-11-07, A2)",
  },
];

/** Test files no chain link runs. */
export const EXCLUDED: readonly { file: string; reason: string }[] = [
  { file: "src/chat/integration.test.ts", reason: "sends real messages through a bot on 3010 (`test:integration`)" },
];

/**
 * Files the fan-in accepts with no `<testsuite>` in any junit file: a file that
 * registers no tests writes none. Empty: an entry needs the junit run that shows it.
 */
export const NO_TESTS_EXEMPT: readonly string[] = [];

export interface ShardTable {
  /** Link 1 of the old chain, split: each group is one `bun test` link. */
  groups: Record<string, string[]>;
  /** Which shard runs each link, by key: `shards[i - 1]` is shard i. */
  shards: string[][];
}

export interface ChainLink {
  key: string;
  args: string[];
  kind: "group" | "pinned" | "mock" | "own";
}

export interface Tree {
  allTestFiles: readonly string[];
  mockFiles: readonly string[];
  /** Files `ownProcessFiles` selects: alone like a mock file, for another reason. */
  ownProcessFiles?: readonly string[];
}

export interface GenerateOptions {
  pinned?: readonly PinnedLink[];
  excluded?: readonly string[];
}

export function linkKey(p: PinnedLink): string {
  return p.name ?? p.args.join(" ");
}

/**
 * The chain's links from the tree and the table: groups first in table order,
 * then pinned and mock links by key. `problems` is non-empty when the inputs
 * conflict or a test file belongs to no link.
 */
export function generate(tree: Tree, table: ShardTable, opts: GenerateOptions = {}): { links: ChainLink[]; problems: string[] } {
  const pinned = opts.pinned ?? PINNED;
  const excluded = excludedFiles(tree, opts.excluded);
  const all = tree.allTestFiles;
  const onDisk = new Set(all);
  const mock = new Set(tree.mockFiles.filter((f) => !excluded.has(f)));
  const own = new Set((tree.ownProcessFiles ?? []).filter((f) => !excluded.has(f) && !mock.has(f)));
  const alone = new Set([...mock, ...own]);
  const why = (f: string) => (mock.has(f) ? "calls mock.module" : "needs a process of its own (ownProcessFiles)");
  const problems: string[] = [];
  const owner = new Map<string, string>();
  const claim = (f: string, key: string) => {
    const prev = owner.get(f);
    if (prev !== undefined) problems.push(`${f} is in two links: ${prev} and ${key}`);
    else owner.set(f, key);
  };
  const others: ChainLink[] = [];

  for (const p of pinned) {
    const key = linkKey(p);
    const files = expandLink(p.args, all);
    if (files.length === 0) problems.push(`pinned link ${key} names no test file`);
    for (const f of files) {
      if (!onDisk.has(f)) problems.push(`pinned link ${key} names ${f}, which is not a test file on disk`);
      else if (excluded.has(f)) problems.push(`pinned link ${key} runs ${f}, which is excluded`);
      else if (alone.has(f)) problems.push(`pinned link ${key} runs ${f}, which ${why(f)} and runs alone`);
      else claim(f, key);
    }
    others.push({ key, args: [...p.args], kind: "pinned" });
  }
  for (const f of [...alone].sort()) {
    if (owner.has(f)) continue; // already a problem above
    claim(f, f);
    others.push({ key: f, args: [f], kind: mock.has(f) ? "mock" : "own" });
  }

  // A file outside the groups is decided before any group expands a directory.
  const elsewhere = new Set([...owner.keys(), ...excluded]);
  const groups: ChainLink[] = [];
  for (const [name, args] of Object.entries(table.groups)) {
    const out: string[] = [];
    for (const arg of args) {
      if (arg.endsWith("/")) {
        const under = expandLink([arg], all);
        if (under.length === 0) problems.push(`group ${name} names ${arg}, which holds no test file`);
        const kept = under.filter((f) => !elsewhere.has(f));
        if (kept.length === under.length) {
          out.push(arg);
        } else {
          out.push(...kept.sort());
        }
        for (const f of kept) claim(f, name);
      } else if (!onDisk.has(arg)) {
        problems.push(`group ${name} names ${arg}, which is not a test file on disk`);
      } else if (alone.has(arg)) {
        problems.push(`group ${name} names ${arg}, which ${why(arg)} and must run alone`);
      } else if (excluded.has(arg)) {
        problems.push(`group ${name} names ${arg}, which is excluded`);
      } else {
        claim(arg, name);
        out.push(arg);
      }
    }
    if (out.length > 0) groups.push({ key: name, args: out, kind: "group" });
  }

  const unowned = all.filter((f) => !excluded.has(f) && !owner.has(f));
  for (const f of unowned) problems.push(`${f} is in no link: add it to a group in scripts/unit-shards.json, or pin it`);

  // What bun really runs per link: a file argument can match more than its own file.
  for (const l of [...groups, ...others]) {
    for (const f of expandLink(l.args, all)) {
      if (onDisk.has(f) && owner.get(f) !== l.key && (owner.has(f) || excluded.has(f))) {
        problems.push(`link ${l.key} also runs ${f} (in ${owner.get(f) ?? "EXCLUDED"}): bun reads a path argument as a substring of the file path`);
      }
    }
  }

  others.sort((a, b) => a.key.localeCompare(b.key));
  return { links: [...groups, ...others], problems };
}

/** `EXCLUDED` (or a fixture's list) plus Playwright's specs, which bun would discover but must never run. */
function excludedFiles(tree: Tree, explicit?: readonly string[]): Set<string> {
  return new Set([...(explicit ?? EXCLUDED.map((e) => e.file)), ...tree.allTestFiles.filter(isPlaywrightSpec)]);
}

export function chainScript(links: readonly ChainLink[]): string {
  return links.map((l) => `bun test ${l.args.join(" ")}`).join(" && ");
}

/** The file a link's junit report is written to. */
export function junitName(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.xml`;
}

/** Every link on exactly one shard, and the table names only links of the chain. */
export function tableProblems(links: readonly ChainLink[], table: ShardTable, total = SHARD_TOTAL): string[] {
  const problems: string[] = [];
  if (table.shards.length !== total) problems.push(`the table has ${table.shards.length} shards, not ${total}`);
  const seen = new Map<string, number[]>();
  table.shards.forEach((keys, i) => {
    for (const k of keys) seen.set(k, [...(seen.get(k) ?? []), i + 1]);
  });
  const keys = new Set(links.map((l) => l.key));
  for (const l of links) {
    const on = seen.get(l.key) ?? [];
    if (on.length === 0) problems.push(`link ${l.key} is on no shard`);
    else if (on.length > 1) problems.push(`link ${l.key} is assigned ${on.length} times (shards ${on.join(", ")})`);
  }
  for (const k of seen.keys()) if (!keys.has(k)) problems.push(`the table names ${k}, which is not a link of the chain`);
  const names = new Map<string, string>();
  for (const l of links) {
    const n = junitName(l.key);
    if (names.has(n)) problems.push(`links ${names.get(n)} and ${l.key} share the junit file ${n}`);
    names.set(n, l.key);
  }
  return problems;
}

export function shardLinks(links: readonly ChainLink[], table: ShardTable, index: number): ChainLink[] {
  const mine = new Set(table.shards[index - 1] ?? []);
  return links.filter((l) => mine.has(l.key));
}

/**
 * The table after `write`: keys that are no longer links are dropped and each
 * new link goes to the shard with the least time by `timings`. Groups and the
 * placement of existing links are left alone.
 */
export function normalizeTable(links: readonly ChainLink[], table: ShardTable, tree: Tree, timings: Record<string, number>, total = SHARD_TOTAL): ShardTable {
  const keys = new Set(links.map((l) => l.key));
  const shards = Array.from({ length: total }, (_, i) => (table.shards[i] ?? []).filter((k) => keys.has(k)));
  const placed = new Set(shards.flat());
  const cost = linkCost(tree, timings);
  const load = shards.map((ks) => ks.reduce((a, k) => a + cost(links.find((l) => l.key === k)!), 0));
  for (const l of links) {
    if (placed.has(l.key)) continue;
    const i = load.indexOf(Math.min(...load));
    shards[i]!.push(l.key);
    load[i]! += cost(l);
  }
  return { groups: table.groups, shards };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 1;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A link's cost: the table seconds of its files, the median for a file the table lacks. */
export function linkCost(tree: Tree, timings: Record<string, number>): (l: { args: string[] }) => number {
  const fallback = median(Object.values(timings));
  return (l) => expandLink(l.args, tree.allTestFiles).reduce((a, f) => a + (timings[f] ?? fallback), 0);
}

/**
 * Regroup the group arguments onto `total` shards by measured time: every group
 * argument (a directory stays whole) and every other link is packed longest
 * first onto the least-loaded shard, and the arguments that land on shard k
 * become group `unit-k`.
 */
export function rebalance(tree: Tree, table: ShardTable, timings: Record<string, number>, opts: GenerateOptions = {}, total = SHARD_TOTAL): { table: ShardTable; loads: number[] } {
  const { links } = generate(tree, table, opts);
  const groupFiles = new Set(links.filter((l) => l.kind === "group").flatMap((l) => expandLink(l.args, tree.allTestFiles)));
  const fallback = median(Object.values(timings));
  const units = [...new Set(Object.values(table.groups).flat())];
  type Item = { key: string; cost: number; unit: boolean };
  const items: Item[] = [
    ...units.map((u) => ({
      key: u,
      unit: true,
      cost: expandLink([u], tree.allTestFiles)
        .filter((f) => groupFiles.has(f))
        .reduce((a, f) => a + (timings[f] ?? fallback), 0),
    })),
    ...links.filter((l) => l.kind !== "group").map((l) => ({ key: l.key, unit: false, cost: linkCost(tree, timings)(l) })),
  ];
  items.sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
  const loads = Array.from({ length: total }, () => 0);
  const unitsOn: string[][] = Array.from({ length: total }, () => []);
  const linksOn: string[][] = Array.from({ length: total }, () => []);
  for (const it of items) {
    const i = loads.indexOf(Math.min(...loads));
    loads[i]! += it.cost;
    (it.unit ? unitsOn : linksOn)[i]!.push(it.key);
  }
  const groups: Record<string, string[]> = {};
  const shards: string[][] = [];
  for (let i = 0; i < total; i++) {
    const mine = units.filter((u) => unitsOn[i]!.includes(u));
    const s: string[] = [];
    if (mine.length > 0) {
      groups[`unit-${i + 1}`] = mine;
      s.push(`unit-${i + 1}`);
    }
    shards.push([...s, ...linksOn[i]!.sort()]);
  }
  return { table: { groups, shards }, loads };
}

// --- junit ---

export interface JunitFile {
  file: string;
  /** Summed testcase seconds: test bodies and beforeEach, not module load or beforeAll. */
  testcaseSeconds: number;
}

function xmlAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  if (!m) return undefined;
  return m[1]!.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The file-level `<testsuite>`s of one bun junit report: the direct children of `<testsuites>`. */
export function parseJunit(xml: string): JunitFile[] {
  const out: JunitFile[] = [];
  let depth = 0;
  let cur: JunitFile | null = null;
  for (const m of xml.matchAll(/<(\/?)(testsuite|testcase)\b[^>]*?(\/?)>/g)) {
    const [tag, close, name, selfClose] = m;
    if (name === "testsuite") {
      if (close) {
        depth--;
        if (depth === 0) cur = null;
        continue;
      }
      if (depth === 0) {
        cur = { file: xmlAttr(tag, "name") ?? "", testcaseSeconds: 0 };
        out.push(cur);
      }
      if (!selfClose) depth++;
      else if (depth === 0) cur = null;
    } else if (!close && cur) {
      cur.testcaseSeconds += Number(xmlAttr(tag, "time") ?? 0) || 0;
    }
  }
  return out;
}

export interface CheckInput {
  links: readonly ChainLink[];
  table: ShardTable;
  tree: Tree;
  /** Junit file name → its contents; a name that is absent was never written. */
  junit: ReadonlyMap<string, string>;
  /** The shards whose links are checked: all of them in the fan-in, one for a local run. */
  shards: readonly number[];
  /** Each matrix result the fan-in was given (`needs.<job>.result`); anything but `success` fails. */
  results: readonly string[];
  timings: Record<string, number>;
  exempt?: readonly string[];
  excluded?: readonly string[];
  total?: number;
}

export interface CheckResult {
  problems: string[];
  warnings: string[];
  ran: number;
}

/** The fan-in's gate over the shards' junit files. */
export function check(input: CheckInput): CheckResult {
  const { links, table, tree, junit, timings } = input;
  const exempt = new Set(input.exempt ?? NO_TESTS_EXEMPT);
  const excluded = excludedFiles(tree, input.excluded);
  const mock = new Set(tree.mockFiles);
  const own = new Set(tree.ownProcessFiles ?? []);
  const problems: string[] = [...tableProblems(links, table, input.total ?? SHARD_TOTAL)];
  const warnings: string[] = [];
  for (const r of input.results) if (r !== "success") problems.push(`a unit shard finished ${r || "(no result)"}`);

  const expectedBy = new Map<string, string>();
  const crashed = new Set<string>();
  const ranIn = new Map<string, string[]>();
  const testcaseSeconds = new Map<string, number>();
  for (const shard of input.shards) {
    for (const l of shardLinks(links, table, shard)) {
      const files = expandLink(l.args, tree.allTestFiles).filter((f) => !excluded.has(f));
      for (const f of files) expectedBy.set(f, l.key);
      const xml = junit.get(junitName(l.key));
      if (xml === undefined) {
        problems.push(`crash: link ${l.key} on shard ${shard} exited without writing ${junitName(l.key)} (a process.exit or a crash), so its ${files.length} file(s) are unaccounted for`);
        for (const f of files) crashed.add(f);
        continue;
      }
      const suites = parseJunit(xml);
      for (const s of suites) {
        ranIn.set(s.file, [...(ranIn.get(s.file) ?? []), l.key]);
        testcaseSeconds.set(s.file, (testcaseSeconds.get(s.file) ?? 0) + s.testcaseSeconds);
        if ((mock.has(s.file) || own.has(s.file)) && suites.length > 1) {
          const why = mock.has(s.file) ? "calls mock.module" : "needs a process of its own (ownProcessFiles)";
          problems.push(`${s.file} ${why} and shared its process with ${suites.length - 1} other file(s) (link ${l.key})`);
        }
      }
    }
  }

  let ran = 0;
  for (const [f, key] of [...expectedBy].sort(([a], [b]) => a.localeCompare(b))) {
    const runs = ranIn.get(f) ?? [];
    if (runs.length === 1) ran++;
    if (exempt.has(f)) {
      if (runs.length > 0) problems.push(`${f} is in NO_TESTS_EXEMPT but ran: drop it from the list`);
      continue;
    }
    if (runs.length === 0 && !crashed.has(f)) problems.push(`never ran: ${f} (link ${key})`);
    if (runs.length > 1) problems.push(`ran ${runs.length} times: ${f} (links ${runs.join(", ")})`);
  }
  for (const f of ranIn.keys()) if (!expectedBy.has(f)) problems.push(`ran, but no checked link runs it: ${f}`);

  const untimed = [...testcaseSeconds].filter(([f]) => typeof timings[f] !== "number");
  const untimedTotal = untimed.reduce((a, [, s]) => a + s, 0);
  if (untimedTotal > UNTIMED_WARN_SECONDS) {
    const list = untimed.sort(([, a], [, b]) => b - a).map(([f, s]) => `${f} ${s.toFixed(1)} s`).join(", ");
    warnings.push(`files missing from scripts/unit-timings.json took ${untimedTotal.toFixed(0)} s by testcase time: ${list}. Refresh the table (the unit-timings job) and rebalance in a PR of its own.`);
  }
  return { problems, warnings, ran };
}

// --- the changed-file step ---

/** The test files a diff adds or changes that the chain runs. */
export function changedTestFiles(diffNames: string, chainFiles: ReadonlySet<string>): string[] {
  return diffNames
    .split("\n")
    .map((l) => l.trim())
    .filter((f) => BUN_TEST_FILE.test(f) && !isPlaywrightSpec(f) && chainFiles.has(f))
    .sort();
}

/** `path  # reason` lines; a line with no reason is an error. */
export function parseAllowlist(text: string): { files: Set<string>; problems: string[] } {
  const files = new Set<string>();
  const problems: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [file, ...reason] = line.split("#");
    if (reason.join("#").trim() === "") problems.push(`allowlist entry without a reason: ${line}`);
    files.add(file!.trim());
  }
  return { files, problems };
}

/** Over the bar fails, unless a second timing within the margin comes in under it. */
export function needsRetime(seconds: number): boolean {
  return seconds > SLOW_FILE_SECONDS && seconds <= SLOW_FILE_SECONDS + RETIME_MARGIN_SECONDS;
}

// --- I/O ---

function readTree(): Tree {
  const all = discoverTestFiles(ROOT);
  const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
  return { allTestFiles: all, mockFiles: all.filter((f) => MOCK_MODULE_CALL.test(read(f))), ownProcessFiles: ownProcessFiles(all, read) };
}

export function readTable(): ShardTable {
  return JSON.parse(readFileSync(SHARDS_PATH, "utf8")) as ShardTable;
}

function readTimings(): Record<string, number> {
  if (!existsSync(TIMINGS_PATH)) return {};
  return (JSON.parse(readFileSync(TIMINGS_PATH, "utf8")) as { seconds: Record<string, number> }).seconds;
}

function readPackage(): { pkg: { scripts: Record<string, string> }; text: string } {
  const text = readFileSync(path.join(ROOT, "package.json"), "utf8");
  return { pkg: JSON.parse(text), text };
}

/** The generated links, refusing when package.json's `test` is not them. */
function loadChain(): { tree: Tree; table: ShardTable; links: ChainLink[] } {
  const tree = readTree();
  const table = readTable();
  const { links, problems } = generate(tree, table);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  if (readPackage().pkg.scripts.test !== chainScript(links)) {
    throw new Error("package.json's `test` is not the generated chain: run `bun scripts/test-chain.ts write`");
  }
  return { tree, table, links };
}

function parseShard(arg: string | undefined): { index: number; total: number } {
  const m = arg?.match(/^(\d+)\/(\d+)$/);
  if (!m) throw new Error(`--shard takes <i>/<n>, got ${arg}`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total !== SHARD_TOTAL) throw new Error(`the table has ${SHARD_TOTAL} shards, --shard says ${total}`);
  if (index < 1 || index > total) throw new Error(`shard ${index} is outside 1..${total}`);
  return { index, total };
}

function flag(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
  });
  return out;
}

export interface AloneRun {
  seconds: number;
  code: number;
  output: string;
  /** Killed at the timeout: its seconds are not a timing. */
  timedOut: boolean;
}

/** How long the pipes may stay open after the run ends: a grandchild that inherited them can hold them for good. */
const PIPE_GRACE_MS = 1_000;

async function drain(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const dec = new TextDecoder();
  const reader = stream.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) sink.push(dec.decode(r.value, { stream: true }));
}

/** `./` makes the argument an exact path; a bare one is a substring filter that also hits `x.test.tsx` and `sub/x.test.ts`. */
export function aloneArgv(file: string): string[] {
  return ["bun", "test", `./${file}`];
}

/**
 * One file alone in its own `bun test` process, wall clock. The process gets its
 * own group and the whole group is killed when it ends, so neither a timeout nor a
 * leaked grandchild holding the pipes can keep this waiting. `argv` and
 * `timeoutMs` are for tests.
 */
export async function timeAlone(file: string, opts: { argv?: string[]; timeoutMs?: number } = {}): Promise<AloneRun> {
  const t0 = performance.now();
  const proc = Bun.spawn(opts.argv ?? aloneArgv(file), { cwd: ROOT, stdout: "pipe", stderr: "pipe", detached: true });
  const out: string[] = [];
  const err: string[] = [];
  const pipes = Promise.all([drain(proc.stdout, out), drain(proc.stderr, err)]).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    proc.exited.then(() => "exited" as const),
    new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? ALONE_TIMEOUT_MS))),
  ]);
  clearTimeout(timer);
  const seconds = (performance.now() - t0) / 1000;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // ESRCH: the group is already gone
  }
  const code = await proc.exited;
  await Promise.race([pipes, Bun.sleep(PIPE_GRACE_MS)]);
  return { seconds, code, output: `${out.join("")}${err.join("")}`, timedOut: ended === "timeout" };
}

function tail(text: string, n = 40): string {
  return text.trimEnd().split("\n").slice(-n).join("\n");
}

async function cmdWrite(): Promise<number> {
  const tree = readTree();
  const table = readTable();
  const { links, problems } = generate(tree, table);
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    return 1;
  }
  const { pkg, text } = readPackage();
  pkg.scripts.test = chainScript(links);
  const next = JSON.stringify(pkg, null, 2) + "\n";
  if (next !== text) writeFileSync(path.join(ROOT, "package.json"), next);
  const normalized = normalizeTable(links, table, tree, readTimings());
  const tableText = JSON.stringify(normalized, null, 2) + "\n";
  if (tableText !== readFileSync(SHARDS_PATH, "utf8")) writeFileSync(SHARDS_PATH, tableText);
  console.log(`test: ${links.length} links (${links.filter((l) => l.kind === "group").length} groups, ${links.filter((l) => l.kind === "pinned").length} pinned, ${links.filter((l) => l.kind === "mock").length} mock, ${links.filter((l) => l.kind === "own").length} own-process)`);
  return 0;
}

async function cmdRun(argv: string[]): Promise<number> {
  const { index, total } = parseShard(flag(argv, "--shard")[0]);
  const junitDir = path.resolve(ROOT, flag(argv, "--junit")[0] ?? DEFAULT_JUNIT_DIR);
  const { tree, table, links } = loadChain();
  const tp = tableProblems(links, table, total);
  if (tp.length > 0) throw new Error(tp.join("\n"));
  mkdirSync(junitDir, { recursive: true });
  const mine = shardLinks(links, table, index);
  const rows: { key: string; seconds: number; code: number; junit: boolean }[] = [];
  const files = new Set(mine.flatMap((l) => expandLink(l.args, tree.allTestFiles)));
  console.log(`shard ${index}/${total}: ${mine.length} links, ${files.size} files`);
  for (const l of mine) {
    const out = path.join(junitDir, junitName(l.key));
    rmSync(out, { force: true });
    console.log(`\n▶ ${l.key}`);
    const t0 = performance.now();
    const proc = Bun.spawn(["bun", "test", "--reporter=junit", `--reporter-outfile=${out}`, ...l.args], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    rows.push({ key: l.key, seconds: (performance.now() - t0) / 1000, code, junit: existsSync(out) });
  }
  console.log(`\nshard ${index}/${total}, by link:`);
  for (const r of rows) console.log(`  ${r.seconds.toFixed(1).padStart(6)} s  exit ${r.code}${r.junit ? "" : "  NO JUNIT"}  ${r.key}`);
  console.log(`  ${rows.reduce((a, r) => a + r.seconds, 0).toFixed(1).padStart(6)} s  total`);
  const bad = rows.filter((r) => r.code !== 0 || !r.junit);
  for (const r of bad) console.log(`::error::link ${r.key} exited ${r.code}${r.junit ? "" : " without a junit file"}`);
  return bad.length === 0 ? 0 : 1;
}

async function cmdCheck(argv: string[]): Promise<number> {
  const junitDir = path.resolve(ROOT, flag(argv, "--junit")[0] ?? DEFAULT_JUNIT_DIR);
  const shardArg = flag(argv, "--shard")[0];
  const shards = shardArg ? [parseShard(shardArg).index] : Array.from({ length: SHARD_TOTAL }, (_, i) => i + 1);
  const { tree, table, links } = loadChain();
  const junit = new Map<string, string>();
  if (existsSync(junitDir)) {
    for (const f of new Bun.Glob("*.xml").scanSync({ cwd: junitDir })) junit.set(f, readFileSync(path.join(junitDir, f), "utf8"));
  }
  const { problems, warnings, ran } = check({ links, table, tree, junit, shards, results: flag(argv, "--result"), timings: readTimings() });
  console.log(`${ran} files ran once across shard(s) ${shards.join(", ")} (${junit.size} junit files)`);
  for (const w of warnings) console.log(`::warning::${w}`);
  for (const p of problems) console.log(`::error::${p}`);
  return problems.length === 0 ? 0 : 1;
}

async function cmdChanged(argv: string[]): Promise<number> {
  const base = argv[0];
  if (!base) throw new Error("changed takes a base ref, e.g. origin/main");
  const { tree, links } = loadChain();
  const chainFiles = new Set(links.flatMap((l) => expandLink(l.args, tree.allTestFiles)));
  const diff = Bun.spawnSync(["git", "diff", "--name-only", "--diff-filter=d", `${base}...HEAD`], { cwd: ROOT });
  if (diff.exitCode !== 0) throw new Error(`git diff against ${base} failed: ${diff.stderr.toString()}`);
  const files = changedTestFiles(diff.stdout.toString(), chainFiles);
  const allow = parseAllowlist(existsSync(ALLOWLIST_PATH) ? readFileSync(ALLOWLIST_PATH, "utf8") : "");
  const problems = [...allow.problems];
  console.log(`${files.length} test file(s) added or changed against ${base}`);
  for (const f of files) {
    let r = await timeAlone(f);
    let line = `${r.seconds.toFixed(1).padStart(6)} s  ${f}`;
    if (!r.timedOut && r.code === 0 && needsRetime(r.seconds) && !allow.files.has(f)) {
      r = await timeAlone(f);
      line += `  (again: ${r.seconds.toFixed(1)} s)`;
    }
    console.log(line);
    if (r.timedOut) {
      problems.push(`${f} timed out: killed after ${ALONE_TIMEOUT_MS / 1000} s alone`);
      console.log(tail(r.output));
    } else if (r.code !== 0) {
      problems.push(`${f} fails when run alone (exit ${r.code})`);
      console.log(tail(r.output));
    } else if (r.seconds > SLOW_FILE_SECONDS && !allow.files.has(f)) {
      problems.push(`${f} took ${r.seconds.toFixed(1)} s alone, over the ${SLOW_FILE_SECONDS} s bar: speed it up, or add it with a reason to scripts/unit-slow-allowlist.txt`);
    }
  }
  for (const p of problems) console.log(`::error::${p}`);
  return problems.length === 0 ? 0 : 1;
}

/** The timing table `refresh` writes from its runs, and the files that failed. */
export function refreshTimings(runs: readonly { file: string; run: AloneRun }[]): { seconds: Record<string, number>; failed: string[]; timedOut: string[] } {
  const seconds: Record<string, number> = {};
  const failed: string[] = [];
  const timedOut: string[] = [];
  for (const { file, run } of runs) {
    if (run.timedOut) timedOut.push(file);
    else if (run.code !== 0) failed.push(file);
    else seconds[file] = Math.round(run.seconds * 10) / 10;
  }
  return { seconds, failed, timedOut };
}

async function cmdRefresh(): Promise<number> {
  const { tree, links } = loadChain();
  const files = [...new Set(links.flatMap((l) => expandLink(l.args, tree.allTestFiles)))].sort();
  const runs: { file: string; run: AloneRun }[] = [];
  for (const [i, f] of files.entries()) {
    const r = await timeAlone(f);
    runs.push({ file: f, run: r });
    console.log(`[${i + 1}/${files.length}] ${r.seconds.toFixed(1).padStart(6)} s${r.timedOut ? "  TIMED OUT" : r.code === 0 ? "" : `  exit ${r.code}`}  ${f}`);
    if (r.timedOut || r.code !== 0) console.log(tail(r.output));
  }
  const { seconds, failed, timedOut } = refreshTimings(runs);
  const sha = process.env.GITHUB_SHA ?? Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
  const source = `refresh: each file alone, wall clock, on ${process.env.GITHUB_ACTIONS ? "a CI runner" : hostname()} at ${sha.slice(0, 8)}, ${new Date().toISOString().slice(0, 10)}`;
  writeFileSync(TIMINGS_PATH, JSON.stringify({ source, seconds }, null, 2) + "\n");
  console.log(`wrote ${Object.keys(seconds).length} of ${files.length} files to scripts/unit-timings.json; a file that failed or timed out gets no entry`);
  for (const f of failed) console.log(`::error::${f} failed when run alone (no timing recorded)`);
  for (const f of timedOut) console.log(`::error::${f} timed out after ${ALONE_TIMEOUT_MS / 1000} s alone (no timing recorded)`);
  return failed.length + timedOut.length === 0 ? 0 : 1;
}

async function cmdRebalance(): Promise<number> {
  const tree = readTree();
  const { table, loads } = rebalance(tree, readTable(), readTimings());
  writeFileSync(SHARDS_PATH, JSON.stringify(table, null, 2) + "\n");
  loads.forEach((s, i) => console.log(`shard ${i + 1}: ~${s.toFixed(0)} s by the table`));
  return cmdWrite();
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "write") return await cmdWrite();
    if (cmd === "run") return await cmdRun(rest);
    if (cmd === "check") return await cmdCheck(rest);
    if (cmd === "changed") return await cmdChanged(rest);
    if (cmd === "refresh") return await cmdRefresh();
    if (cmd === "rebalance") return await cmdRebalance();
  } catch (e) {
    console.error(`::error::${(e as Error).message}`);
    return 1;
  }
  console.error("usage: bun scripts/test-chain.ts write | run --shard <i>/<n> [--junit <dir>] | check [--junit <dir>] [--result <r>]… [--shard <i>/<n>] | changed <base-ref> | refresh | rebalance");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
