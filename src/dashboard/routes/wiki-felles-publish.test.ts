/**
 * `POST /api/wiki/felles-publish` drives a FAKE script on disk, mostly run
 * through `/bin/bash` in place of Bun, so the argv the route hands the real
 * `publiser-felles-wiki.ts` is asserted without gcloud. The `.env` case runs
 * the route's real Bun interpreter, since that leak only exists there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest } from "../../wiki/readonly.ts";
import { registerWikiFellesPublishRoute, type FellesPublishRouteDeps } from "./wiki-felles-publish.ts";
import { ProcTimeoutError } from "../../utils/run-proc.ts";
import type { FellesPublishConfig } from "../../wiki/felles-publish.ts";

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
  root = await mkdtemp(path.join(tmpdir(), "muninn-felles-"));
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

  test("a real Bun child does not load the .env in its working directory", async () => {
    // Bun reads `.env` from the cwd it starts in, which is muninn's own repo
    // root in production; an env allowlist means nothing if that file refills it.
    const cwd = await mkdtemp(path.join(tmpdir(), "muninn-felles-cwd-"));
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
    expect(((await res.json()) as { error: string }).error).toMatch(/may still have finished/);
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
