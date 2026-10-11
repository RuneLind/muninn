/**
 * `GET /api/wiki/plan-card` drives a STUB script on disk through `/bin/bash`
 * in place of Bun, so the argv, the child environment, the timeout and the
 * single flight are asserted without the real plan-card. The real one runs in
 * `e2e/wiki-agent-lens.spec.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { registerWikiPlanCardRoute, type PlanCardRouteDeps } from "./wiki-plan-card.ts";
import type { PlanCardConfig } from "../../wiki/plan-card.ts";

let dir = "";
let root = "";
let other = "";
let bin = "";
let out = "";

const CARD = { text: "# Plan A\nplan_status: in-flight", chars: 31, cuts: [{ section: "brief", pointer: "Brief continues, sed -n 9,20p /x", start: 9, end: 20, file: "/x" }] };

function appWith(deps: PlanCardRouteDeps = {}, role?: "user" | "admin"): Hono {
  const app = new Hono();
  if (role) app.use(async (c, next) => { c.set("role" as never, role as never); await next(); });
  const cfg: PlanCardConfig = { bin, roots: [root] };
  registerWikiPlanCardRoute(app, { profile: "default", dashboardPort: 4321 } as Config, {
    config: () => cfg,
    interpreter: ["/bin/bash"],
    ...deps,
  });
  return app;
}

/** A stub that records its argv and environment, then runs `body`. */
async function stub(body: string): Promise<void> {
  await writeFile(
    bin,
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${out}.argv"\nenv > "${out}.env"\n${body}\n`,
    "utf8",
  );
  await chmod(bin, 0o755);
}

const get = (app: Hono, q: string) => app.request(`/api/wiki/plan-card?${q}`);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "muninn-plan-card-"));
  root = path.join(dir, "wiki");
  other = path.join(dir, "other");
  bin = path.join(dir, "plan-card-stub.sh");
  out = path.join(dir, "out");
  await Bun.write(path.join(root, "plans", "a.mdx"), "---\ntitle: A\nplan_status: in-flight\n---\n\n# A\n");
  await Bun.write(path.join(root, "notes", "b.md"), "---\ntitle: B\n---\n\n# B\n");
  await Bun.write(path.join(other, "plans", "c.mdx"), "---\ntitle: C\nplan_status: in-flight\n---\n\n# C\n");
  __setWikiRegistryForTest([
    { name: "w", root, source: "extra" },
    { name: "o", root: other, source: "extra" },
  ]);
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(dir, { recursive: true, force: true });
});

describe("the spawn", () => {
  test("argv is the page's absolute path under plan-card's root, the flags, then --json; the card comes back", async () => {
    await stub(`echo '${JSON.stringify(CARD)}'`);
    const res = await get(appWith(), "wiki=w&relPath=plans/a.mdx&since=2026-10-07&id=Q-14");
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof CARD & { ms: number };
    expect(body.text).toBe(CARD.text);
    expect(body.chars).toBe(31);
    expect(body.cuts).toEqual(CARD.cuts);
    expect(typeof body.ms).toBe("number");
    const argv = (await readFile(`${out}.argv`, "utf8")).trim().split("\n");
    expect(argv).toEqual([path.join(root, "plans/a.mdx"), "--since", "2026-10-07", "--id", "Q-14", "--json"]);
  });

  test("the child environment is the allowlist plus PLAN_CARD_MUNINN_URL on the instance's port", async () => {
    await stub(`echo '${JSON.stringify(CARD)}'`);
    const saved = { ...process.env };
    process.env.DATABASE_URL = "postgres://secret";
    process.env.TELEGRAM_BOT_TOKEN_X = "secret";
    process.env.WIKI_STAMP_ROOTS = root;
    process.env.CLAUDE_USAGE_URL = "http://127.0.0.1:9";
    try {
      expect((await get(appWith(), "wiki=w&relPath=plans/a.mdx")).status).toBe(200);
    } finally {
      for (const k of ["DATABASE_URL", "TELEGRAM_BOT_TOKEN_X", "WIKI_STAMP_ROOTS", "CLAUDE_USAGE_URL"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    const env = Object.fromEntries(
      (await readFile(`${out}.env`, "utf8"))
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    // bash adds PWD, SHLVL and `_` itself.
    const names = Object.keys(env).filter((k) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(k)).sort();
    expect(names).toEqual(["CLAUDE_USAGE_URL", "HOME", "PATH", "PLAN_CARD_MUNINN_URL", "TMPDIR", "WIKI_STAMP_ROOTS"].filter((n) => n !== "TMPDIR" || process.env.TMPDIR));
    expect(env.PLAN_CARD_MUNINN_URL).toBe("http://127.0.0.1:4321");
    expect(env.WIKI_STAMP_ROOTS).toBe(root);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  test("the default interpreter is the running Bun with --no-env-file", async () => {
    let seen: string[] = [];
    const app = appWith({
      interpreter: undefined,
      runProc: async (argv) => {
        seen = argv;
        return { stdout: JSON.stringify(CARD), stderr: "", exitCode: 0 };
      },
    });
    expect((await get(app, "wiki=w&relPath=plans/a.mdx")).status).toBe(200);
    expect(seen.slice(0, 3)).toEqual([process.execPath, "--no-env-file", bin]);
  });

  test("a child past the timeout answers 504", async () => {
    await stub("sleep 5");
    const res = await get(appWith({ timeoutMs: 200 }), "wiki=w&relPath=plans/a.mdx");
    expect(res.status).toBe(504);
    expect(((await res.json()) as { reason: string }).reason).toBe("timeout");
  });

  test("a refusal from plan-card is 502 with its error", async () => {
    await stub(`echo '{"error":"plan-card: not a plan page"}'; exit 1`);
    const res = await get(appWith(), "wiki=w&relPath=plans/a.mdx");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("plan-card: not a plan page");
  });
});

describe("single flight", () => {
  test("two requests with the same page and arguments share one child", async () => {
    await stub(`echo x >> "${out}.runs"; sleep 0.4; echo '${JSON.stringify(CARD)}'`);
    await rm(`${out}.runs`, { force: true });
    const app = appWith();
    const [a, b] = await Promise.all([get(app, "wiki=w&relPath=plans/a.mdx"), get(app, "wiki=w&relPath=plans/a.mdx")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await readFile(`${out}.runs`, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("other arguments for the same page start their own child after the first", async () => {
    await stub(`echo "start $(date +%s%N)" >> "${out}.runs"; sleep 0.3; echo "end $(date +%s%N)" >> "${out}.runs"; echo '${JSON.stringify(CARD)}'`);
    await rm(`${out}.runs`, { force: true });
    const app = appWith();
    const [a, b] = await Promise.all([get(app, "wiki=w&relPath=plans/a.mdx"), get(app, "wiki=w&relPath=plans/a.mdx&id=D1")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = (await readFile(`${out}.runs`, "utf8")).trim().split("\n").map((l) => l.split(" ")[0]);
    expect(rows).toEqual(["start", "end", "start", "end"]);
  });
});

describe("refusals before any spawn", () => {
  test("501 names the variable when PLAN_CARD_BIN is unset", async () => {
    const res = await get(appWith({ config: () => ({ bin: null, roots: [root] }) }), "wiki=w&relPath=plans/a.mdx");
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toContain("PLAN_CARD_BIN");
  });

  test("404 for a page without plan_status and for a wiki outside plan-card's roots", async () => {
    await stub(`echo x > "${out}.spawned"`);
    await rm(`${out}.spawned`, { force: true });
    expect((await get(appWith(), "wiki=w&relPath=notes/b.md")).status).toBe(404);
    expect((await get(appWith(), "wiki=o&relPath=plans/c.mdx")).status).toBe(404);
    expect((await get(appWith(), "wiki=w&relPath=plans/none.mdx")).status).toBe(404);
    expect(await Bun.file(`${out}.spawned`).exists()).toBe(false);
  });

  test("400 for a malformed since or id; 403 for role user", async () => {
    for (const q of ["since=10.10.2026", "since=2026-02-30", "id=-rf", "id=D1%3Bx"]) {
      expect([q, (await get(appWith(), `wiki=w&relPath=plans/a.mdx&${q}`)).status]).toEqual([q, 400]);
    }
    expect((await get(appWith({}, "user"), "wiki=w&relPath=plans/a.mdx")).status).toBe(403);
  });
});
