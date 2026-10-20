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
    expect(((await res.json()) as { error: string }).error).toMatch(/was stopped.*The delete may already have gone through/);
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

  // A data file added locally after the publish, or one the publish refused, is
  // not in the bucket. `--fjern` deletes in argv order and exits 3 on any miss,
  // so one run of page + data files deleted the page and still failed.
  test("a data file the bucket never held does not fail a remove whose page went", async () => {
    // The script's own rule: delete every named object it can, exit 3 if one is missing.
    const bucket = new Set(["plans/case.mdx", "plans/case.yaml", "plans/runs.csv"]);
    const runs: string[][] = [];
    const app = appWith({
      runProc: async (argv) => {
        const objects = argv.slice(argv.indexOf("--") + 1);
        runs.push(objects);
        let missed = 0;
        for (const o of objects) if (!bucket.delete(o)) missed++;
        return { stdout: "", stderr: missed ? "Feil: sletting feilet" : "", exitCode: missed ? 3 : 0 };
      },
    });
    const res = await post(app, { wiki: "kode", relPath: "plans/case.mdx", dryRun: false, action: "remove" });
    const body = (await res.json()) as { exitCode: number; dataFilesExitCode?: number | null };
    expect(body.exitCode).toBe(0);
    expect(body.dataFilesExitCode).toBe(3);
    expect(bucket.size).toBe(0);
    // The page goes in a run of its own, first.
    expect(runs[0]).toEqual(["plans/case.mdx"]);
    expect(runs[1]).toEqual(["plans/case.yaml", "plans/runs.csv", "plans/Måling.csv"]);
  });

  test("a page delete that fails is the answer, and no data file is touched", async () => {
    const runs: string[][] = [];
    const app = appWith({
      runProc: async (argv) => {
        runs.push(argv.slice(argv.indexOf("--") + 1));
        return { stdout: "", stderr: "", exitCode: 3 };
      },
    });
    const body = (await (await post(app, { wiki: "kode", relPath: "plans/case.mdx", dryRun: false, action: "remove" })).json()) as {
      exitCode: number;
      dataFilesExitCode?: number | null;
    };
    expect(body.exitCode).toBe(3);
    expect(body.dataFilesExitCode).toBeUndefined();
    expect(runs).toEqual([["plans/case.mdx"]]);
  });

  test("a data-file run that does not return still answers that the page went", async () => {
    let calls = 0;
    const app = appWith({
      runProc: async () => {
        if (++calls === 2) throw new ProcTimeoutError("felles-publish", 5);
        return { stdout: "slettet", stderr: "", exitCode: 0 };
      },
    });
    const res = await post(app, { wiki: "kode", relPath: "plans/case.mdx", dryRun: false, action: "remove" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exitCode: number; dataFilesExitCode?: number | null; output: string };
    expect(body.exitCode).toBe(0);
    expect(body.dataFilesExitCode).toBeNull();
    expect(body.output).toMatch(/did not return in time/);
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
