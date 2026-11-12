/**
 * `GET /api/wiki/step-checks` against a temp wiki read through the real index,
 * with the probes' outside reads faked (no git, no database, no real `.env`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { SIDE_EFFECTING_GETS } from "../../auth/origin.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { sha256 } from "../../utils/date-hash.ts";
import { __setWikiReadonlyForTest } from "../../wiki/readonly.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { ProbeCache } from "../../wiki/step-checks/answer.ts";
import type { ProbeDeps } from "../../wiki/step-checks/probes.ts";
import { registerWikiStepChecksRoute, STEP_CHECKS_PATH, type StepChecksRouteDeps } from "./wiki-step-checks.ts";

afterEach(() => __setWikiReadonlyForTest());

const lane = (...items: string[]) => ["---", "title: T", "---", "", "<NextMoves>", "", '<Lane kind="you">', "", ...items, "", "</Lane>", "", "</NextMoves>", ""].join("\n");

const PAGES: Record<string, string> = {
  "plans/checked.mdx": lane('1. Add the key <Check env="HAVE" />', '2. Migrate <Check migration="086" />', "3. Plain."),
  "plans/no-lane.mdx": '---\ntitle: N\n---\n\n1. Loose <Check env="HAVE" />\n',
  "plans/misplaced.mdx": lane('1. <Check env="HAVE" /> first', '2. Middle <Check env="HAVE" /> text', '- [ ] Task <Check env="HAVE" />'),
};

const ROOT = testTempDirSync(path.join(tmpdir(), "step-checks-route-"));
mkdirSync(path.join(ROOT, "plans"), { recursive: true });
for (const [rel, text] of Object.entries(PAGES)) writeFileSync(path.join(ROOT, rel), text);

function app(over: Partial<ProbeDeps> = {}, opts: { cache?: ProbeCache; boundMs?: number } = {}) {
  const probes: ProbeDeps = {
    git: async () => {
      throw new Error("git must not run");
    },
    roots: null,
    readEnvFile: async () => ({ text: "HAVE=v4lue-n0t-t0-leak\n" }),
    processHasEnv: () => true,
    hasMigration: async (v) => v === "086",
    ...over,
  };
  const deps: StepChecksRouteDeps = {
    registry: () => [{ name: "W", root: ROOT } as WikiRegistryEntry],
    answer: { probes, machine: "laptop", cache: opts.cache ?? new ProbeCache(), boundMs: opts.boundMs },
  };
  const a = new Hono();
  registerWikiStepChecksRoute(a, {} as Config, () => deps);
  return a;
}

const get = (a: Hono, q: string) => a.request(`${STEP_CHECKS_PATH}?${q}`);

describe("GET /api/wiki/step-checks", () => {
  test("is on SIDE_EFFECTING_GETS", () => {
    expect(SIDE_EFFECTING_GETS).toContain(STEP_CHECKS_PATH);
  });

  test("validation: missing params 400, unknown wiki 404, a traversal or unknown page 404", async () => {
    const a = app();
    expect((await get(a, "wiki=W")).status).toBe(400);
    expect((await get(a, "relPath=plans/checked.mdx")).status).toBe(400);
    expect((await get(a, "wiki=nope&relPath=plans/checked.mdx")).status).toBe(404);
    expect((await get(a, `wiki=W&relPath=${encodeURIComponent("../../etc/passwd")}`)).status).toBe(404);
    expect((await get(a, "wiki=W&relPath=plans/none.mdx")).status).toBe(404);
  });

  test("answers each checked step with the page hash, and never an env value", async () => {
    const res = await get(app(), "wiki=w&relPath=plans/checked.mdx");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("v4lue");
    const body = JSON.parse(raw);
    expect(body.hash).toBe(sha256(PAGES["plans/checked.mdx"]!));
    expect(body.machine).toBe("laptop");
    expect(body.laneRows).toEqual([3]);
    expect(body.steps.map((s: { row: number; state: string }) => [s.row, s.state])).toEqual([
      [0, "ok"],
      [1, "ok"],
    ]);
  });

  test("a page without a lane, or with only misplaced tags, answers no steps and runs no probe", async () => {
    let ran = 0;
    const a = app({ readEnvFile: async () => (ran++, { text: "" }) });
    for (const rel of ["plans/no-lane.mdx", "plans/misplaced.mdx"]) {
      const body = await (await get(a, `wiki=W&relPath=${rel}`)).json();
      expect(body.steps).toEqual([]);
    }
    expect(ran).toBe(0);
  });

  test("works on a read-only instance: it only reads", async () => {
    __setWikiReadonlyForTest(true);
    const res = await get(app(), "wiki=W&relPath=plans/checked.mdx");
    expect(res.status).toBe(200);
    expect((await res.json()).steps).toHaveLength(2);
  });

  test("opening the page twice inside the TTL runs each probe once", async () => {
    let runs = 0;
    const cache = new ProbeCache();
    const over = { hasMigration: async (v: string) => (runs++, v === "086") };
    await get(app(over, { cache }), "wiki=W&relPath=plans/checked.mdx");
    await get(app(over, { cache }), "wiki=W&relPath=plans/checked.mdx");
    expect(runs).toBe(1);
  });

  test("the answer's bound: a hung probe answers unknown, timed out, inside it", async () => {
    const t0 = Date.now();
    const body = await (await get(app({ hasMigration: () => new Promise(() => {}) }, { boundMs: 50 }), "wiki=W&relPath=plans/checked.mdx")).json();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(body.steps[1].machines[0].probes[0]).toEqual({ kind: "migration", value: "086", state: "unknown", why: "timed out" });
  });
});
