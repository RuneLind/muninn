/**
 * `GET /api/wiki/step-checks` against temp wikis read through the real index,
 * with the probes' outside reads faked (no git, no database, no real `.env`).
 * The wiki is resolved and scoped by Done's own resolver, so checks are
 * answered exactly where Done is offered, except on a read-only instance.
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
import { __setWikiReadonlyForTest, isWikiReadonly } from "../../wiki/readonly.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { ProbeCache } from "../../wiki/step-checks/answer.ts";
import type { ProbeDeps } from "../../wiki/step-checks/probes.ts";
import { registerWikiStepChecksRoute, STEP_CHECKS_PATH } from "./wiki-step-checks.ts";
import { registerWikiStepDoneRoutes, type StepDoneDeps } from "./wiki-step-done.ts";

afterEach(() => __setWikiReadonlyForTest());

const lane = (...items: string[]) => ["---", "title: T", "---", "", "<NextMoves>", "", '<Lane kind="you">', "", ...items, "", "</Lane>", "", "</NextMoves>", ""].join("\n");

const PAGES: Record<string, string> = {
  "plans/checked.mdx": lane('1. Add the key <Check env="HAVE" />', '2. Migrate <Check migration="086" />', "3. Plain."),
  "plans/no-lane.mdx": '---\ntitle: N\n---\n\n1. Loose <Check env="HAVE" />\n',
  "plans/misplaced.mdx": lane('1. <Check env="HAVE" /> first', '2. Middle <Check env="HAVE" /> text', '- [ ] Task <Check env="HAVE" />'),
  "plans/checkout.mdx": lane('1. Pull <Check checkout="muninn" env="HAVE" />'),
};

function wikiDir(prefix: string): string {
  const root = testTempDirSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(root, "plans"), { recursive: true });
  for (const [rel, text] of Object.entries(PAGES)) writeFileSync(path.join(root, rel), text);
  return root;
}

/** In scope; a read-only root; outside the work map; outside the answer wikis. */
const ROOT = wikiDir("step-checks-route-");
const RO_ROOT = wikiDir("step-checks-ro-");
const OUT_ROOT = wikiDir("step-checks-out-");
const NOANS_ROOT = wikiDir("step-checks-noans-");
const REGISTRY = [
  { name: "W", root: ROOT, source: "extra" },
  { name: "RO", root: RO_ROOT, source: "extra" },
  { name: "OUT", root: OUT_ROOT, source: "extra" },
  { name: "NOANS", root: NOANS_ROOT, source: "extra" },
] as WikiRegistryEntry[];

const scopeDeps = () => ({
  registry: () => REGISTRY,
  workMapWikis: () => ["W", "RO", "NOANS"],
  answerConfig: () => ({ wikis: new Set(["w", "ro", "out"]), owner: null, groups: new Map() }),
  isReadonlyRoot: (r: string) => r === RO_ROOT,
});

/** Every outside read a probe can make, counted. */
interface Reads {
  n: number;
}

function app(over: Partial<ProbeDeps> = {}, opts: { cache?: ProbeCache; boundMs?: number; reads?: Reads } = {}) {
  const reads = opts.reads ?? { n: 0 };
  const probes = {
    git: async () => {
      reads.n++;
      throw new Error("git must not run");
    },
    roots: null,
    readEnvFile: async () => (reads.n++, { text: "HAVE=v4lue-n0t-t0-leak\n" }),
    processHasEnv: () => (reads.n++, true),
    appliedMigrations: async () => (reads.n++, new Set(["086"])),
    ...over,
  } as ProbeDeps;
  const deps = { scope: scopeDeps(), answer: { probes, machine: "laptop", cache: opts.cache ?? new ProbeCache(), boundMs: opts.boundMs } };
  const a = new Hono();
  registerWikiStepChecksRoute(a, {} as Config, () => deps);
  return a;
}

const get = (a: Hono, q: string) => a.request(`${STEP_CHECKS_PATH}?${q}`);

describe("GET /api/wiki/step-checks", () => {
  test("is on SIDE_EFFECTING_GETS", () => {
    expect(SIDE_EFFECTING_GETS).toContain(STEP_CHECKS_PATH);
  });

  test("validation: no relPath 400, unknown wiki 404, a traversal or unknown page 404", async () => {
    const a = app();
    expect((await get(a, "wiki=W")).status).toBe(400);
    expect((await get(a, "wiki=nope&relPath=plans/checked.mdx")).status).toBe(404);
    expect((await get(a, `wiki=W&relPath=${encodeURIComponent("../../etc/passwd")}`)).status).toBe(404);
    expect((await get(a, "wiki=W&relPath=plans/none.mdx")).status).toBe(404);
  });

  test("an empty wiki name (an unregistered WIKI_DIR) is 200 with no steps, as Done's list is", async () => {
    const reads = { n: 0 };
    const a = app({}, { reads });
    for (const q of ["relPath=plans/checked.mdx", "wiki=&relPath=plans/checked.mdx", "wiki=%20&relPath=plans/checked.mdx"]) {
      const res = await get(a, q);
      expect(res.status).toBe(200);
      expect((await res.json()).steps).toEqual([]);
    }
    expect(reads.n).toBe(0);
  });

  test("a read-only root (WIKI_READONLY_ROOTS) is 200 with no steps and no probe, git, db or .env read", async () => {
    const reads = { n: 0 };
    for (const rel of ["plans/checked.mdx", "plans/checkout.mdx"]) {
      const res = await get(app({}, { reads }), `wiki=RO&relPath=${rel}`);
      expect(res.status).toBe(200);
      expect((await res.json()).steps).toEqual([]);
    }
    expect(reads.n).toBe(0);
  });

  test("a wiki outside Done's triage scope is 200 with no steps and reads nothing", async () => {
    const reads = { n: 0 };
    for (const w of ["OUT", "NOANS"]) {
      const res = await get(app({}, { reads }), `wiki=${w}&relPath=plans/checkout.mdx`);
      expect(res.status).toBe(200);
      expect((await res.json()).steps).toEqual([]);
    }
    expect(reads.n).toBe(0);
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

  test("an in-scope wiki on a read-only instance (MUNINN_WIKI_READONLY) still answers: it only reads", async () => {
    __setWikiReadonlyForTest(true);
    const res = await get(app(), "wiki=W&relPath=plans/checked.mdx");
    expect(res.status).toBe(200);
    expect((await res.json()).steps).toHaveLength(2);
  });

  test("opening the page twice inside the TTL reads the migrations once", async () => {
    let runs = 0;
    const cache = new ProbeCache();
    const over: Partial<ProbeDeps> = { appliedMigrations: async () => (runs++, new Set(["086"])) };
    await get(app(over, { cache }), "wiki=W&relPath=plans/checked.mdx");
    await get(app(over, { cache }), "wiki=W&relPath=plans/checked.mdx");
    expect(runs).toBe(1);
  });

  test("the answer's bound: a hung probe answers unknown, timed out, inside it", async () => {
    const t0 = Date.now();
    const hung = () => new Promise<never>(() => {});
    const body = await (await get(app({ appliedMigrations: hung }, { boundMs: 50 }), "wiki=W&relPath=plans/checked.mdx")).json();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(body.steps[1].machines[0].probes[0]).toEqual({ kind: "migration", value: "086", state: "unknown", why: "timed out" });
  });
});

describe("checks are answered exactly where Done is offered, except on a read-only instance", () => {
  function doneApp() {
    const a = new Hono();
    const deps = (): StepDoneDeps => ({ ...scopeDeps(), now: () => 0, commit: async () => ({ committed: false, reason: "error" }) as never });
    const guards = {
      readonlyRefusal: (c: import("hono").Context) => (isWikiReadonly() ? c.json({ error: "read-only", readonly: true }, 403) : null),
      egressRefusal: () => null,
    };
    registerWikiStepDoneRoutes(a, { knowledgeApiUrl: "http://127.0.0.1:9" } as Config, guards, deps);
    return a;
  }

  /** Done is offered when its list names a step and its preview of that step is not refused. */
  async function doneOffered(wiki: string, rel: string): Promise<boolean> {
    const a = doneApp();
    const res = await a.request(`/api/wiki/step-done?wiki=${encodeURIComponent(wiki)}&relPath=${encodeURIComponent(rel)}`);
    if (res.status !== 200) return false;
    const l = (await res.json()) as { offered?: boolean; steps: { key: string }[]; baseHash: string };
    if (l.offered === false || l.steps.length === 0) return false;
    const p = await a.request("/api/wiki/step-done", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki, relPath: rel, step: l.steps[0]!.key, baseHash: l.baseHash, preview: true }),
    });
    return p.status === 200;
  }

  async function checksAnswered(wiki: string, rel: string): Promise<boolean> {
    const res = await get(app(), `wiki=${encodeURIComponent(wiki)}&relPath=${encodeURIComponent(rel)}`);
    if (res.status !== 200) return false;
    return ((await res.json()) as { steps: unknown[] }).steps.length > 0;
  }

  const CASES: { name: string; wiki: string; rel: string; instanceReadonly?: boolean; checksOnly?: boolean }[] = [
    { name: "in scope", wiki: "W", rel: "plans/checked.mdx" },
    { name: "in scope, other case", wiki: "w", rel: "plans/checkout.mdx" },
    { name: "read-only root", wiki: "RO", rel: "plans/checked.mdx" },
    { name: "not in WORK_MAP_WIKIS", wiki: "OUT", rel: "plans/checked.mdx" },
    { name: "not in WIKI_ANSWER_WIKIS", wiki: "NOANS", rel: "plans/checked.mdx" },
    { name: "empty wiki name", wiki: "", rel: "plans/checked.mdx" },
    { name: "unknown wiki", wiki: "nope", rel: "plans/checked.mdx" },
    { name: "unknown page", wiki: "W", rel: "plans/none.mdx" },
    { name: "traversal", wiki: "W", rel: "../../etc/passwd" },
    { name: "read-only instance", wiki: "W", rel: "plans/checked.mdx", instanceReadonly: true, checksOnly: true },
  ];

  for (const k of CASES) {
    test(k.name, async () => {
      __setWikiReadonlyForTest(k.instanceReadonly === true);
      const [done, checks] = [await doneOffered(k.wiki, k.rel), await checksAnswered(k.wiki, k.rel)];
      if (k.checksOnly) expect([done, checks]).toEqual([false, true]);
      else expect(checks).toBe(done);
    });
  }

  test("the table covers both answers", async () => {
    expect(await checksAnswered("W", "plans/checked.mdx")).toBe(true);
    expect(await checksAnswered("RO", "plans/checked.mdx")).toBe(false);
  });
});
