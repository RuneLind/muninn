/**
 * `POST /api/wiki/felles-publish` drives a FAKE script on disk, mostly run
 * through `/bin/bash` in place of Bun, so the argv the route hands the real
 * `publiser-felles-wiki.ts` is asserted without gcloud. The `.env` case runs
 * the route's real Bun interpreter, since that leak only exists there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest } from "../../wiki/readonly.ts";
import { registerWikiFellesPublishRoute, type FellesPublishRouteDeps } from "./wiki-felles-publish.ts";
import { ProcTimeoutError } from "../../utils/run-proc.ts";
import type { FellesPublishConfig } from "../../wiki/felles-publish.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { fakeFjernRun, fakeGcloudRm, GCLOUD_LOGGED_OUT, GCLOUD_NETWORK } from "../../test/felles-fjern-fake.ts";

let root = "";
let bin = "";
let argvFile = "";

const config = (over: Partial<FellesPublishConfig> = {}): FellesPublishConfig => ({
  bin,
  wikis: new Set(["kode"]),
  bucket: null,
  ...over,
});

function appWith(deps: FellesPublishRouteDeps = {}): Hono {
  const app = new Hono();
  registerWikiFellesPublishRoute(app, { config: () => config(), interpreter: ["/bin/bash"], ...deps });
  return app;
}

const post = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/wiki/felles-publish", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const ok = { wiki: "kode", relPath: "plans/a.mdx", dryRun: true, allowIdent: true };

beforeAll(async () => {
  root = await testTempDir(path.join(tmpdir(), "muninn-felles-"));
  bin = path.join(root, "..", `fake-publiser-${process.pid}.sh`);
  argvFile = path.join(root, "..", `fake-publiser-argv-${process.pid}.txt`);
  await Bun.write(path.join(root, "plans", "a.mdx"), "---\ntitle: A\n---\n\n# A\n");
  await Bun.write(path.join(root, "-x.md"), "# X\n");
  await writeFile(
    bin,
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${argvFile}"\necho "DB=\${DATABASE_URL:-unset}" >> "${argvFile}"\n` +
      `echo "OK      plans/a.mdx"\necho "Feil: noe" >&2\nexit 1\n`,
    "utf8",
  );
  await chmod(bin, 0o755);
  __setWikiRegistryForTest([{ name: "kode", root, source: "extra" }, { name: "mimir", root, source: "extra" }]);
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(root, { recursive: true, force: true });
  await rm(bin, { force: true });
  await rm(argvFile, { force: true });
});

describe("the spawn", () => {
  test("is the operator's command line, flags then root relPath", async () => {
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://secret";
    let res: Response;
    try {
      res = await post(appWith(), ok);
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
    expect(res.status).toBe(200);
    const lines = (await readFile(argvFile, "utf8")).trim().split("\n");
    expect(lines).toEqual(["--dry-run", "--tillat-ident", root, "./plans/a.mdx", "DB=unset"]);
  });

  test("answers the script's exit code and both streams", async () => {
    const res = await post(appWith(), { ...ok, dryRun: false, allowIdent: false });
    expect(await res.json()).toEqual({ exitCode: 1, dryRun: false, output: "OK      plans/a.mdx\nFeil: noe" });
    expect((await readFile(argvFile, "utf8")).trim().split("\n").slice(0, 2)).toEqual([root, "./plans/a.mdx"]);
  });

  test("a dash-led page reaches the script as a path, never as a flag", async () => {
    for (const relPath of ["-x.md", "./-x.md", "plans/../-x.md"]) {
      const res = await post(appWith(), { ...ok, relPath });
      expect(res.status).toBe(200);
      const lines = (await readFile(argvFile, "utf8")).trim().split("\n");
      expect(lines.slice(2, 4)).toEqual([root, "./-x.md"]);
    }
  });

  test("remove spawns --fjern on the index spelling, with no root", async () => {
    for (const relPath of ["plans/a.mdx", "./plans/a.mdx"]) {
      const res = await post(appWith(), { wiki: "kode", relPath, dryRun: false, action: "remove" });
      expect(res.status).toBe(200);
      const lines = (await readFile(argvFile, "utf8")).trim().split("\n");
      expect(lines).toEqual(["--fjern", "--ja", "--", "plans/a.mdx", "DB=unset"]);
    }
    await post(appWith(), { ...ok, action: "remove" });
    expect((await readFile(argvFile, "utf8")).trim().split("\n").slice(0, 5)).toEqual([
      "--fjern",
      "--dry-run",
      "--ja",
      "--",
      "plans/a.mdx",
    ]);
  });

  test("a dash-led page is removed as an object name, never read as a flag", async () => {
    const res = await post(appWith(), { wiki: "kode", relPath: "-x.md", dryRun: true, action: "remove" });
    expect(res.status).toBe(200);
    expect((await readFile(argvFile, "utf8")).trim().split("\n").slice(0, 5)).toEqual([
      "--fjern",
      "--dry-run",
      "--ja",
      "--",
      "-x.md",
    ]);
  });

  test("a remove that does not return says the delete may have finished", async () => {
    const app = appWith({
      runProc: async () => {
        throw new ProcTimeoutError("felles-publish", 5);
      },
    });
    const res = await post(app, { ...ok, action: "remove" });
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: string }).error).toMatch(/was stopped\. The page may or may not be deleted, and its data files were left alone/);
  });

  test("a real Bun child does not load the .env in its working directory", async () => {
    // Bun reads `.env` from the cwd it starts in, which is muninn's own repo
    // root in production; an env allowlist means nothing if that file refills it.
    const cwd = await testTempDir(path.join(tmpdir(), "muninn-felles-cwd-"));
    const probe = path.join(cwd, "probe.ts");
    await writeFile(path.join(cwd, ".env"), "FELLES_LEAK_PROBE=leaked\n", "utf8");
    await writeFile(probe, 'console.log("LEAK=" + (process.env.FELLES_LEAK_PROBE ?? "none"));\n', "utf8");
    const prev = process.cwd();
    process.chdir(cwd);
    try {
      const res = await post(appWith({ interpreter: undefined, config: () => config({ bin: probe }) }), ok);
      expect(((await res.json()) as { output: string }).output).toBe("LEAK=none");
    } finally {
      process.chdir(prev);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a second publish while one runs is a 409, and the slot frees after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const app = appWith({
      runProc: async () => {
        calls++;
        await gate;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const first = post(app, ok);
    await Bun.sleep(20);
    const second = await post(app, { ...ok, relPath: "-x.md" });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect((await post(app, ok)).status).toBe(200);
    expect(calls).toBe(2);
  });

  test("a script that does not return is a 504, and frees the slot", async () => {
    let calls = 0;
    const app = appWith({
      runProc: async () => {
        if (++calls === 1) throw new ProcTimeoutError("felles-publish", 5);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const res = await post(app, ok);
    expect((await post(app, ok)).status).toBe(200);
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: string }).error).toMatch(/was stopped.*An upload may already have finished/);
  });
});

test("every spawn leads its own process group, so a timeout reaches gcloud too", async () => {
  const seen: { label: string; processGroup?: boolean }[] = [];
  const app = appWith({
    runProc: async (argv, _timeoutMs, label, opts) => {
      seen.push({ label: argv.includes("--status") ? "status" : label, processGroup: opts?.processGroup });
      return { stdout: argv.includes("--status") ? JSON.stringify({ "bøtte": "b", sider: [], "foreldreløse": [], "muligensForeldreløse": [] }) : "", stderr: "", exitCode: 0 };
    },
  });
  await post(app, { ...ok, dryRun: false });
  await post(app, { ...ok, action: "remove", dryRun: false });
  await post(app, { wiki: "kode", action: "sync", dryRun: false, allowIdent: true });
  await app.request("/api/wiki/felles-status?wiki=kode", { headers: { "x-muninn-felles": "status" } });
  expect(seen.map((s) => s.processGroup)).toEqual([true, true, true, true]);
  expect(seen.map((s) => s.label)).toEqual(["felles-publish", "felles-publish", "felles-publish", "status"]);
});

// Finding 31's sibling, finding 11: publish uploads the data files a page reads,
// so a remove must take them too, or they stay in the bucket and on every pod.
describe("remove takes the page's data files", () => {
  const NFD = "Måling.csv"; // "Måling.csv" as readdir hands it back on macOS
  beforeAll(async () => {
    await Bun.write(
      path.join(root, "plans", "case.mdx"),
      "---\ntitle: Case\n---\n\n# Case\n\n" +
        '<CaseBoard src="case.yaml" />\n\n<DeltaTable src="runs.csv" />\n\n' +
        `<DeltaTable src="${NFD}" />\n\n<DeltaTable src="gone.csv" />\n\n<DeltaTable src="../shared/both.csv" />\n\n` +
        '<DeltaTable src="../shared/\u00C5re.csv" />\n\n' +
        "```\n<CaseBoard src=\"fenced.yaml\" />\n```\n",
    );
    await Bun.write(path.join(root, "plans", "case.yaml"), "cases: []\n");
    await Bun.write(path.join(root, "plans", "runs.csv"), "a,b\n1,2\n");
    await Bun.write(path.join(root, "plans", NFD), "a\n1\n");
    await Bun.write(path.join(root, "plans", "fenced.yaml"), "x: 1\n");
    await Bun.write(path.join(root, "shared", "both.csv"), "a\n1\n");
    await Bun.write(path.join(root, "shared", "\u00C5re.csv"), "a\n1\n");
    // Another page reads the shared files: removing case.mdx must leave them,
    // also when it spells one of them in NFD and case.mdx in NFC.
    await Bun.write(
      path.join(root, "notes", "other.md"),
      '# Other\n\n<DeltaTable src="../shared/both.csv" />\n\n<DeltaTable src="../shared/A\u030Are.csv" />\n',
    );
    __resetWikiCacheForTest();
  });

  test("the argv carries the page, then each data file only this page reads, in NFC", async () => {
    const res = await post(appWith(), { wiki: "kode", relPath: "plans/case.mdx", dryRun: true, action: "remove" });
    expect(res.status).toBe(200);
    const lines = (await readFile(argvFile, "utf8")).trim().split("\n");
    expect(lines.slice(0, 4)).toEqual(["--fjern", "--dry-run", "--ja", "--"]);
    expect(lines.slice(4, -1)).toEqual(["plans/case.mdx", "plans/case.yaml", "plans/runs.csv", "plans/Måling.csv"]);
  });

  test("the answer names what goes and what stays, so the confirm row can show it", async () => {
    const res = await post(appWith(), { wiki: "kode", relPath: "plans/case.mdx", dryRun: true, action: "remove" });
    const body = (await res.json()) as { removes?: string[]; keptShared?: string[] };
    expect(body.removes).toEqual(["plans/case.mdx", "plans/case.yaml", "plans/runs.csv", "plans/Måling.csv"]);
    expect(body.keptShared).toEqual(["shared/both.csv", "shared/\u00C5re.csv"]);
  });

  test("a page with no data files still removes the page alone", async () => {
    await post(appWith(), { wiki: "kode", relPath: "plans/a.mdx", dryRun: true, action: "remove" });
    expect((await readFile(argvFile, "utf8")).trim().split("\n").slice(4, -1)).toEqual(["plans/a.mdx"]);
  });

});

// The decision table's OUTCOMES, route half (src/wiki/CLAUDE.md, felles
// remove): the stub prints the real script's `--fjern` lines over an in-memory
// bucket (`felles-fjern-fake.ts`, compared byte for byte with the script in
// the empirical pass), so the route reads the outcome as it would in use.
describe("remove outcomes: one row per cell", () => {
  const PAGE = "plans/case.mdx";
  const DATA = ["plans/case.yaml", "plans/runs.csv", "plans/Måling.csv"];
  type Fail = (o: string) => string | null;
  type Step = { bucket: string[]; fail?: Fail; throwAt?: number; exit?: { code: number; stdout?: string; stderr?: string } };

  /** An app whose script deletes from `state.bucket`; `state.step` may make a
   *  run throw a timeout or answer a fixed exit. */
  function harness(over: FellesPublishRouteDeps = {}) {
    const state = { bucket: new Set<string>(), fail: undefined as Fail | undefined, runs: [] as string[][], timeoutRun: 0, fixed: undefined as Step["exit"] | undefined, fixedRun: 0, clock: 1_000_000 };
    const app = appWith({
      now: () => state.clock,
      runProc: async (argv) => {
        const objects = argv.slice(argv.indexOf("--") + 1);
        state.runs.push(objects);
        const n = state.runs.length;
        if (n === state.timeoutRun) throw new ProcTimeoutError("felles-publish", 5);
        if (n === state.fixedRun && state.fixed) return { stdout: state.fixed.stdout ?? "", stderr: state.fixed.stderr ?? "", exitCode: state.fixed.code };
        if (argv.includes("--fjern")) return fakeFjernRun(objects, fakeGcloudRm(state.bucket, state.fail));
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      ...over,
    });
    return { app, state };
  }
  const remove = (app: Hono, extra: Record<string, unknown> = {}) =>
    post(app, { wiki: "kode", relPath: PAGE, dryRun: false, action: "remove", ...extra });
  type Answer = { exitCode?: number; pageRun?: string; dataRun?: string; dataFilesExitCode?: number | null; retryDataFiles?: boolean; dataFiles?: string[]; reason?: string; dataFilesOnly?: boolean; removes?: string[] };
  const loggedOut: Fail = () => GCLOUD_LOGGED_OUT;
  const dataLoggedOut: Fail = (o) => (o === PAGE ? null : GCLOUD_LOGGED_OUT);

  // [name, bucket before, gcloud failures, run that times out, run with a fixed exit, status, answer subset, runs, bucket after]
  const REMOVE: [string, string[], Fail | undefined, number, { run: number; code: number } | null, number, Answer, string[][], string[]][] = [
    ["R1 page and data deleted", [PAGE, ...DATA], undefined, 0, null, 200, { exitCode: 0, pageRun: "deleted", dataRun: "deleted", dataFilesExitCode: 0, retryDataFiles: false }, [[PAGE], DATA], []],
    ["R2 page deleted, a data file never uploaded", [PAGE, DATA[0]!], undefined, 0, null, 200, { exitCode: 0, pageRun: "deleted", dataRun: "missing", dataFilesExitCode: 3, retryDataFiles: false }, [[PAGE], DATA], []],
    ["R3 page deleted, data run logged out", [PAGE, ...DATA], dataLoggedOut, 0, null, 200, { exitCode: 0, pageRun: "deleted", dataRun: "failed", dataFilesExitCode: 3, retryDataFiles: true }, [[PAGE], DATA], DATA],
    ["R4 page deleted, data run exit 2", [PAGE, ...DATA], undefined, 0, { run: 2, code: 2 }, 200, { exitCode: 0, pageRun: "deleted", dataRun: "error", dataFilesExitCode: 2, retryDataFiles: false }, [[PAGE], DATA], DATA],
    ["R5 page deleted, data run timed out", [PAGE, ...DATA], undefined, 2, null, 200, { exitCode: 0, pageRun: "deleted", dataRun: "timeout", dataFilesExitCode: null, retryDataFiles: true }, [[PAGE], DATA], DATA],
    ["R6 page not in the bucket (already removed), data still there", [...DATA], undefined, 0, null, 200, { exitCode: 3, pageRun: "missing", dataRun: "deleted", dataFilesExitCode: 0, retryDataFiles: false }, [[PAGE], DATA], []],
    ["R7 page run logged out: no data run, page kept", [PAGE, ...DATA], loggedOut, 0, null, 200, { exitCode: 3, pageRun: "failed", retryDataFiles: false }, [[PAGE]], [PAGE, ...DATA]],
    ["R8 page run network error", [PAGE, ...DATA], () => GCLOUD_NETWORK, 0, null, 200, { exitCode: 3, pageRun: "failed", retryDataFiles: false }, [[PAGE]], [PAGE, ...DATA]],
    ["R9 page run exit 1", [PAGE, ...DATA], undefined, 0, { run: 1, code: 1 }, 200, { exitCode: 1, pageRun: "error", retryDataFiles: false }, [[PAGE]], [PAGE, ...DATA]],
    ["R10 page run exit 2", [PAGE, ...DATA], undefined, 0, { run: 1, code: 2 }, 200, { exitCode: 2, pageRun: "error", retryDataFiles: false }, [[PAGE]], [PAGE, ...DATA]],
    ["R11 page run timed out", [PAGE, ...DATA], undefined, 1, null, 504, { reason: "timeout", pageRun: "timeout", retryDataFiles: false }, [[PAGE]], [PAGE, ...DATA]],
    ["R12 page run exit 3 the route cannot read", [PAGE, ...DATA], undefined, 0, { run: 1, code: 3 }, 200, { exitCode: 3, pageRun: "failed", retryDataFiles: false }, [[PAGE]], [PAGE, ...DATA]],
  ];
  test.each(REMOVE)("%s", async (_n, before, fail, timeoutRun, fixed, status, want, runs, after) => {
    const { app, state } = harness();
    before.forEach((o) => state.bucket.add(o));
    state.fail = fail;
    state.timeoutRun = timeoutRun;
    if (fixed) [state.fixedRun, state.fixed] = [fixed.run, { code: fixed.code }];
    const res = await remove(app);
    expect(res.status).toBe(status);
    const body = (await res.json()) as Answer;
    expect(body).toMatchObject(want);
    if (!("dataRun" in want)) expect(body.dataRun).toBeUndefined();
    expect(body.dataFiles).toEqual(DATA);
    expect(state.runs).toEqual(runs);
    expect([...state.bucket].sort()).toEqual([...after].sort());
  });

  test("R13 a page with no data files that is not in the bucket counts as removed", async () => {
    const { app, state } = harness();
    const res = await post(app, { wiki: "kode", relPath: "plans/a.mdx", dryRun: false, action: "remove" });
    const body = (await res.json()) as Answer;
    expect(body).toMatchObject({ exitCode: 3, pageRun: "missing", retryDataFiles: false, dataFiles: [] });
    expect(body.dataRun).toBeUndefined();
    expect(state.runs).toEqual([["plans/a.mdx"]]);
  });

  // Retry data files: the route runs it only on its own evidence the page is gone.
  async function afterR3() {
    const h = harness();
    [PAGE, ...DATA].forEach((o) => h.state.bucket.add(o));
    h.state.fail = dataLoggedOut;
    expect(((await (await remove(h.app)).json()) as Answer).retryDataFiles).toBe(true);
    h.state.fail = undefined;
    h.state.runs.length = 0;
    return h;
  }

  test("T1 the retry deletes the data files alone, and a file already gone is success", async () => {
    const { app, state } = await afterR3();
    state.bucket.delete(DATA[1]!);
    const res = await remove(app, { dataFilesOnly: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ exitCode: 3, dataFilesOnly: true, dataRun: "missing", retryDataFiles: false, removes: DATA, dataFiles: DATA });
    expect(state.runs).toEqual([DATA]);
    expect(state.bucket.size).toBe(0);
  });

  test("T2 no evidence the page is gone: 409, no spawn", async () => {
    const { app, state } = harness();
    state.bucket.add(PAGE);
    const res = await remove(app, { dataFilesOnly: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Answer).reason).toBe("page-not-gone");
    expect(state.runs).toEqual([]);
  });

  test("T3 evidence older than the TTL: 409", async () => {
    const { app, state } = await afterR3();
    state.clock += 15 * 60_000 + 1;
    expect((await remove(app, { dataFilesOnly: true })).status).toBe(409);
    expect(state.runs).toEqual([]);
  });

  test("T3b evidence at the TTL still admits the retry", async () => {
    const { app, state } = await afterR3();
    state.clock += 15 * 60_000;
    expect((await remove(app, { dataFilesOnly: true })).status).toBe(200);
  });

  test("T4 a real publish drops the evidence; a dry run does not", async () => {
    const { app, state } = await afterR3();
    await post(app, { ...ok, relPath: "plans/a.mdx", dryRun: true });
    expect((await remove(app, { dataFilesOnly: true })).status).toBe(200);
    const h2 = await afterR3();
    await post(h2.app, { ...ok, relPath: "plans/a.mdx", dryRun: false });
    expect((await remove(h2.app, { dataFilesOnly: true })).status).toBe(409);
    expect(state.runs.length).toBe(2);
  });

  test("T5 a page run that fails after the evidence drops it", async () => {
    const { app, state } = await afterR3();
    state.bucket.add(PAGE);
    state.fail = loggedOut;
    expect(((await (await remove(app)).json()) as Answer).pageRun).toBe("failed");
    expect((await remove(app, { dataFilesOnly: true })).status).toBe(409);
  });

  test("T6 a page run that times out after the evidence drops it", async () => {
    const { app, state } = await afterR3();
    state.timeoutRun = 1;
    expect((await remove(app)).status).toBe(504);
    expect((await remove(app, { dataFilesOnly: true })).status).toBe(409);
  });

  test("T7 a retry that times out is a 504 that offers the retry again, and keeps the evidence", async () => {
    const { app, state } = await afterR3();
    state.timeoutRun = 1;
    const res = await remove(app, { dataFilesOnly: true });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ reason: "timeout", dataFilesOnly: true, dataRun: "timeout", retryDataFiles: true, dataFiles: DATA });
    expect((await remove(app, { dataFilesOnly: true })).status).toBe(200);
  });

  test("T8 a retry still logged out is failed and offered again", async () => {
    const { app, state } = await afterR3();
    state.fail = loggedOut;
    expect(await (await remove(app, { dataFilesOnly: true })).json()).toMatchObject({ exitCode: 3, dataRun: "failed", retryDataFiles: true });
  });

  test("T9 a retry that exits 2 is not offered again", async () => {
    const { app, state } = await afterR3();
    [state.fixedRun, state.fixed] = [1, { code: 2 }];
    expect(await (await remove(app, { dataFilesOnly: true })).json()).toMatchObject({ exitCode: 2, dataRun: "error", dataFilesExitCode: 2, retryDataFiles: false });
  });

  test("T10 a page proven gone by «not in the bucket» admits the retry too", async () => {
    const { app, state } = harness();
    DATA.forEach((o) => state.bucket.add(o));
    state.fail = dataLoggedOut;
    expect(await (await remove(app)).json()).toMatchObject({ pageRun: "missing", dataRun: "failed", retryDataFiles: true });
    state.fail = undefined;
    expect(await (await remove(app, { dataFilesOnly: true })).json()).toMatchObject({ dataRun: "deleted", retryDataFiles: false });
  });

  test("dataFilesOnly is refused before any spawn unless it is true on a real remove of a page with data files", async () => {
    let spawned = 0;
    const app = appWith({ runProc: async () => (spawned++, { stdout: "", stderr: "", exitCode: 0 }) });
    const base = { wiki: "kode", relPath: PAGE, action: "remove", dryRun: false };
    for (const body of [
      { ...base, dataFilesOnly: false },
      { ...base, dataFilesOnly: "yes" },
      { ...base, dryRun: true, dataFilesOnly: true },
      { ...base, action: "publish", allowIdent: true, dataFilesOnly: true },
      { ...base, relPath: "plans/a.mdx", dataFilesOnly: true },
    ]) {
      expect((await post(app, body)).status).toBe(400);
    }
    expect(spawned).toBe(0);
  });
});

// The script's `sjekkStiform` refuses a whole `--fjern` run when one argv path
// has `[ ] * ?`, ends in `#<digits>` or has a segment over 211 bytes, and
// deletes nothing. muninn's ref check lets such a name through, so a data file
// named that way must stay out of the argv, or the page could not be removed.
describe("remove skips a data file name the script refuses", () => {
  const long = "a".repeat(220) + ".csv";
  beforeAll(async () => {
    await Bun.write(
      path.join(root, "odd", "page.mdx"),
      "# Odd\n\n" +
        '<DeltaTable src="ok.csv" />\n\n<DeltaTable src="a[1].csv" />\n\n<DeltaTable src="b*.csv" />\n\n' +
        `<DeltaTable src="${long}" />\n`,
    );
    for (const f of ["ok.csv", "a[1].csv", "b*.csv", long]) await Bun.write(path.join(root, "odd", f), "a\n1\n");
    __resetWikiCacheForTest();
  });

  test("the argv carries the page and the names the script accepts; the answer lists the rest as kept", async () => {
    const res = await post(appWith(), { wiki: "kode", relPath: "odd/page.mdx", dryRun: true, action: "remove" });
    expect(res.status).toBe(200);
    expect((await readFile(argvFile, "utf8")).trim().split("\n").slice(4, -1)).toEqual(["odd/page.mdx", "odd/ok.csv"]);
    const body = (await res.json()) as { removes?: string[]; keptRefused?: string[] };
    expect(body.removes).toEqual(["odd/page.mdx", "odd/ok.csv"]);
    expect(body.keptRefused).toEqual(["odd/a[1].csv", "odd/b*.csv", `odd/${long}`]);
  });
});

describe("refusals before any spawn", () => {
  let spawned = false;
  const watch = (): FellesPublishRouteDeps => ({
    runProc: async () => {
      spawned = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  test.each([
    ["text/plain", { "content-type": "text/plain" }, ok, 415],
    ["cross-site", { "sec-fetch-site": "cross-site" }, ok, 403],
    ["missing relPath", {}, { ...ok, relPath: "" }, 400],
    ["non-boolean dryRun", {}, { ...ok, dryRun: "yes" }, 400],
    ["publish without allowIdent", {}, { wiki: "kode", relPath: "plans/a.mdx", dryRun: true }, 400],
    ["unknown action", {}, { ...ok, action: "delete" }, 400],
    ["null action", {}, { ...ok, action: null }, 400],
    ["remove of a page outside the index", {}, { ...ok, action: "remove", relPath: "plans/missing.mdx" }, 404],
    ["unknown wiki", {}, { ...ok, wiki: "nope" }, 404],
    ["wiki not allowlisted", {}, { ...ok, wiki: "mimir" }, 403],
    ["no such page", {}, { ...ok, relPath: "plans/missing.mdx" }, 404],
    ["a path outside the index", {}, { ...ok, relPath: "../etc/passwd" }, 404],
  ])("%s", async (_label, headers, body, status) => {
    spawned = false;
    const res = await post(appWith(watch()), body, headers as Record<string, string>);
    expect(res.status).toBe(status);
    expect(spawned).toBe(false);
  });

  test("a read-only root is refused like any other egress", async () => {
    spawned = false;
    __setReadonlyWikiRootsForTest([root]);
    try {
      const res = await post(appWith(watch()), ok);
      expect(res.status).toBe(403);
    } finally {
      __setReadonlyWikiRootsForTest();
    }
    expect(spawned).toBe(false);
  });

  test("an unconfigured instance is a 501", async () => {
    spawned = false;
    const res = await post(appWith({ ...watch(), config: () => config({ bin: null }) }), ok);
    expect(res.status).toBe(501);
    expect(spawned).toBe(false);
  });

  test("a script path that does not exist is a 501", async () => {
    spawned = false;
    const res = await post(appWith({ ...watch(), config: () => config({ bin: "/nope/p.ts" }) }), ok);
    expect(res.status).toBe(501);
    expect(spawned).toBe(false);
  });
});

describe("sync", () => {
  const sync = { wiki: "kode", action: "sync", dryRun: true, allowIdent: true };

  test("spawns --synk on the root, with the dialog's flags", async () => {
    const res = await post(appWith(), sync);
    expect(res.status).toBe(200);
    expect((await readFile(argvFile, "utf8")).trim().split("\n")).toEqual([
      "--synk",
      "--dry-run",
      "--tillat-ident",
      root,
      "DB=unset",
    ]);
    await post(appWith(), { ...sync, dryRun: false, allowIdent: false });
    expect((await readFile(argvFile, "utf8")).trim().split("\n")).toEqual(["--synk", root, "DB=unset"]);
  });

  test("runs under its own, longer timeout", async () => {
    const seen: number[] = [];
    const app = appWith({
      timeoutMs: 1_000,
      syncTimeoutMs: 9_000,
      runProc: async (_argv, timeoutMs) => {
        seen.push(timeoutMs);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await post(app, sync);
    await post(app, ok);
    expect(seen).toEqual([9_000, 1_000]);
  });

  test("shares the one run slot with publish and remove", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = appWith({
      runProc: async () => {
        await gate;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const first = post(app, sync);
    await Bun.sleep(20);
    expect((await post(app, ok)).status).toBe(409);
    expect((await post(app, sync)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  test("a sync that does not return is a 504 that says to check the status", async () => {
    const app = appWith({
      runProc: async () => {
        throw new ProcTimeoutError("felles-publish", 5);
      },
    });
    const res = await post(app, sync);
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: string }).error).toMatch(/was stopped.*refresh the status/);
  });

  test.each([
    ["a relPath", { ...sync, relPath: "plans/a.mdx" }],
    ["no allowIdent", { wiki: "kode", action: "sync", dryRun: true }],
    ["no wiki", { ...sync, wiki: "" }],
  ])("refuses %s before any spawn", async (_label, body) => {
    let spawned = false;
    const app = appWith({
      runProc: async () => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect((await post(app, body)).status).toBe(400);
    expect(spawned).toBe(false);
  });
});

describe("GET /api/wiki/felles-status", () => {
  const STATUS = {
    "bøtte": "b",
    sider: [
      { relPath: "plans/a.mdx", tilstand: "endret", endredeFiler: ["plans/a.mdx"], avslag: [], advarsler: [] },
      { relPath: "-x.md", tilstand: "uendret", endredeFiler: [], avslag: [], advarsler: [] },
    ],
    "foreldreløse": ["gone.md"],
    "muligensForeldreløse": [],
  };
  const get = (app: Hono, wiki = "kode", headers: Record<string, string> = { "x-muninn-felles": "status" }, query = "") =>
    app.request(`/api/wiki/felles-status?wiki=${wiki}${query}`, { headers });

  /** A runProc that counts spawns, records argv, and can be held open. */
  function fake(answer: () => { stdout: string; stderr?: string; exitCode: number } = () => ({ stdout: JSON.stringify(STATUS), exitCode: 0 })) {
    const state = { calls: 0, argv: [] as string[], hold: null as Promise<void> | null };
    const runProc = async (argv: string[]) => {
      state.calls++;
      state.argv = argv;
      if (state.hold) await state.hold;
      const a = answer();
      return { stdout: a.stdout, stderr: a.stderr ?? "", exitCode: a.exitCode };
    };
    return { state, runProc };
  }

  test("spawns --status --json --tillat-ident on the root and serves the validated shape", async () => {
    const f = fake();
    const res = await get(appWith({ runProc: f.runProc, now: () => 1_000 }));
    expect(res.status).toBe(200);
    expect(f.state.argv).toEqual(["/bin/bash", bin, "--status", "--json", "--tillat-ident", root]);
    expect(await res.json()).toEqual({
      bucket: "b",
      changed: 1,
      checkedAt: 1_000,
      pages: [
        { relPath: "plans/a.mdx", masked: false, state: "changed", changedFiles: ["plans/a.mdx"], refusals: [], warnings: [] },
        { relPath: "-x.md", masked: false, state: "unchanged", changedFiles: [], refusals: [], warnings: [] },
      ],
      orphans: [{ path: "gone.md", masked: false }],
      maybeOrphans: [],
    });
  });

  test("the real fake script's argv, through /bin/bash", async () => {
    await get(appWith());
    expect((await readFile(argvFile, "utf8")).trim().split("\n")).toEqual([
      "--status",
      "--json",
      "--tillat-ident",
      root,
      "DB=unset",
    ]);
  });

  test("anything but the status JSON is a 502, never the raw output", async () => {
    for (const out of [{ stdout: "OK plans/a.mdx", exitCode: 0 }, { stdout: JSON.stringify({ ...STATUS, sider: "x" }), exitCode: 0 }]) {
      const res = await get(appWith({ runProc: fake(() => out).runProc }));
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string; reason: string };
      expect(body.reason).toBe("bad-status");
      expect(body.error).not.toContain("OK plans/a.mdx");
    }
  });

  test("a failing script is a 502 with its stderr line; a timeout a 504", async () => {
    const failed = await get(appWith({ runProc: fake(() => ({ stdout: "", stderr: "Feil: gcloud mangler\n", exitCode: 2 })).runProc }));
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe("The status script failed (exit 2): Feil: gcloud mangler");
    const timedOut = await get(
      appWith({
        runProc: async () => {
          throw new ProcTimeoutError("felles-status", 5);
        },
      }),
    );
    expect(timedOut.status).toBe(504);
  });

  test("concurrent requests share one spawn", async () => {
    const f = fake();
    let release!: () => void;
    f.state.hold = new Promise<void>((r) => (release = r));
    const app = appWith({ runProc: f.runProc });
    const a = get(app);
    const b = get(app);
    await Bun.sleep(20);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await ra.json()).toEqual(await rb.json());
    expect(f.state.calls).toBe(1);
  });

  test("a success is cached for the TTL; a failure is not cached", async () => {
    let t = 0;
    const f = fake();
    const app = appWith({ runProc: f.runProc, now: () => t, statusTtlMs: 100 });
    await get(app);
    t = 99;
    await get(app);
    expect(f.state.calls).toBe(1);
    t = 100;
    await get(app);
    expect(f.state.calls).toBe(2);

    let code = 2;
    const g = fake(() => ({ stdout: code ? "" : JSON.stringify(STATUS), exitCode: code }));
    const app2 = appWith({ runProc: g.runProc, now: () => 0 });
    expect((await get(app2)).status).toBe(502);
    code = 0;
    expect((await get(app2)).status).toBe(200);
    expect(g.state.calls).toBe(2);
  });

  test("a run that could change the bucket drops the cache", async () => {
    const f = fake();
    const app = appWith({ runProc: f.runProc, now: () => 0 });
    await get(app);
    for (const body of [
      { ...ok, dryRun: false },
      { ...ok, action: "remove", dryRun: false },
      { wiki: "kode", action: "sync", dryRun: false, allowIdent: true },
    ]) {
      const before = f.state.calls;
      expect((await post(app, body)).status).toBe(200);
      await get(app);
      // One spawn for the POST, one fresh status.
      expect(f.state.calls).toBe(before + 2);
    }
  });

  test("a dry run, a refused request and a run that never spawned keep the cache", async () => {
    let spawnFails = false;
    let statusCalls = 0;
    const app = appWith({
      now: () => 0,
      runProc: async (argv) => {
        if (argv.includes("--status")) {
          statusCalls++;
          return { stdout: JSON.stringify(STATUS), stderr: "", exitCode: 0 };
        }
        if (spawnFails) throw new Error("spawn failed");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await get(app);
    expect(statusCalls).toBe(1);
    for (const body of [ok, { ...ok, action: "remove" }, { wiki: "kode", action: "sync", dryRun: true, allowIdent: true }]) {
      expect((await post(app, body)).status).toBe(200);
    }
    expect((await post(app, { ...ok, dryRun: "yes" })).status).toBe(400);
    spawnFails = true;
    expect((await post(app, { ...ok, dryRun: false })).status).toBe(502);
    await get(app);
    expect(statusCalls).toBe(1);
  });

  test("a run that timed out drops the cache: gcloud may have uploaded before it was stopped", async () => {
    let statusCalls = 0;
    const app = appWith({
      now: () => 0,
      runProc: async (argv) => {
        if (argv.includes("--status")) {
          statusCalls++;
          return { stdout: JSON.stringify(STATUS), stderr: "", exitCode: 0 };
        }
        throw new ProcTimeoutError("felles-publish", 5);
      },
    });
    await get(app);
    expect((await post(app, { ...ok, dryRun: false })).status).toBe(504);
    await get(app);
    expect(statusCalls).toBe(2);
  });

  test("allowIdent=0 spawns without --tillat-ident, and each flag has its own cache", async () => {
    const f = fake();
    const app = appWith({ runProc: f.runProc, now: () => 0 });
    expect((await get(app, "kode", undefined, "&allowIdent=0")).status).toBe(200);
    expect(f.state.argv).toEqual(["/bin/bash", bin, "--status", "--json", root]);
    expect((await get(app, "kode", undefined, "&allowIdent=1")).status).toBe(200);
    expect(f.state.argv).toEqual(["/bin/bash", bin, "--status", "--json", "--tillat-ident", root]);
    expect(f.state.calls).toBe(2);
    // Absent is the dialog's default, the flag on, and shares its cache.
    await get(app);
    await get(app, "kode", undefined, "&allowIdent=0");
    expect(f.state.calls).toBe(2);
  });

  test("concurrent requests with different flags do not share a spawn", async () => {
    const f = fake();
    let release!: () => void;
    f.state.hold = new Promise<void>((r) => (release = r));
    const app = appWith({ runProc: f.runProc, now: () => 0 });
    const a = get(app, "kode", undefined, "&allowIdent=0");
    const b = get(app, "kode", undefined, "&allowIdent=1");
    await Bun.sleep(20);
    release();
    await Promise.all([a, b]);
    expect(f.state.calls).toBe(2);
  });

  test("an allowIdent other than 0 or 1 is a 400 before any spawn", async () => {
    const f = fake();
    const res = await get(appWith({ runProc: f.runProc }), "kode", undefined, "&allowIdent=yes");
    expect(res.status).toBe(400);
    expect(f.state.calls).toBe(0);
  });

  test("a status that throws is a 502 and leaves no unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      // No stderr: reading it throws inside the status run.
      const app = appWith({ runProc: (async () => ({ stdout: "", exitCode: 2 })) as unknown as FellesPublishRouteDeps["runProc"] });
      const res = await get(app);
      expect(res.status).toBe(502);
      await Bun.sleep(20);
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("does not wait for the run slot, and a status taken mid-run is not cached", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let statusCalls = 0;
    const app = appWith({
      now: () => 0,
      runProc: async (argv) => {
        if (argv.includes("--status")) {
          statusCalls++;
          return { stdout: JSON.stringify(STATUS), stderr: "", exitCode: 0 };
        }
        await gate;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const run = post(app, { wiki: "kode", action: "sync", dryRun: false, allowIdent: true });
    await Bun.sleep(20);
    expect((await get(app)).status).toBe(200);
    release();
    await run;
    await get(app);
    expect(statusCalls).toBe(2);
  });

  test("a status spawned before a run ends is not joined after it", async () => {
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((r) => (releaseStatus = r));
    let statusCalls = 0;
    const app = appWith({
      now: () => 0,
      runProc: async (argv) => {
        if (!argv.includes("--status")) return { stdout: "", stderr: "", exitCode: 0 };
        // The first status sees the bucket before the run: the page still changed.
        const first = ++statusCalls === 1;
        if (first) await statusGate;
        const tilstand = first ? "endret" : "uendret";
        return { stdout: JSON.stringify({ ...STATUS, sider: [{ ...STATUS.sider[0], tilstand }] }), stderr: "", exitCode: 0 };
      },
    });
    const changedOf = async (res: Response | Promise<Response>) => ((await (await res).json()) as { changed: number }).changed;
    const stale = get(app);
    await Bun.sleep(20);
    expect((await post(app, { ...ok, dryRun: false })).status).toBe(200);
    expect(await changedOf(get(app))).toBe(0);
    expect(statusCalls).toBe(2);
    releaseStatus();
    expect(await changedOf(stale)).toBe(1);
    // The stale answer did not overwrite the fresh one in the cache.
    expect(await changedOf(get(app))).toBe(0);
    expect(statusCalls).toBe(2);
  });

  describe("refusals before any spawn", () => {
    test.each([
      ["no marker header", "kode", {}, 403],
      ["a wrong marker", "kode", { "x-muninn-felles": "1" }, 403],
      ["cross-site", "kode", { "x-muninn-felles": "status", "sec-fetch-site": "cross-site" }, 403],
      ["a foreign Origin", "kode", { "x-muninn-felles": "status", origin: "https://evil.test", host: "localhost" }, 403],
      ["no wiki", "", { "x-muninn-felles": "status" }, 400],
      ["unknown wiki", "nope", { "x-muninn-felles": "status" }, 404],
      ["wiki not allowlisted", "mimir", { "x-muninn-felles": "status" }, 403],
    ])("%s", async (_label, wiki, headers, status) => {
      const f = fake();
      const res = await get(appWith({ runProc: f.runProc }), wiki, headers as Record<string, string>);
      expect(res.status).toBe(status);
      expect(f.state.calls).toBe(0);
    });

    test("a same-origin request passes the gate", async () => {
      const f = fake();
      const res = await get(appWith({ runProc: f.runProc }), "kode", {
        "x-muninn-felles": "status",
        "sec-fetch-site": "same-origin",
        origin: "http://localhost:3010",
        host: "localhost:3010",
      });
      expect(res.status).toBe(200);
    });

    test("a read-only root and an unconfigured instance", async () => {
      const f = fake();
      __setReadonlyWikiRootsForTest([root]);
      try {
        expect((await get(appWith({ runProc: f.runProc }))).status).toBe(403);
      } finally {
        __setReadonlyWikiRootsForTest();
      }
      expect((await get(appWith({ runProc: f.runProc, config: () => config({ bin: null }) }))).status).toBe(501);
      expect((await get(appWith({ runProc: f.runProc, config: () => config({ bin: "/nope/p.ts" }) }))).status).toBe(501);
      expect(f.state.calls).toBe(0);
    });
  });
});
