/**
 * Two muninns in one process, each driven through its real route handler: alpha
 * answers `GET /api/wiki/step-checks`, and asks beta's `GET /api/checks/answer`
 * through an injected fetch that calls beta's Hono app (no network, no ports).
 * Their probe deps differ per probe, so every (step, machine, probe) cell says
 * which machine answered it. The campaign bar: no false «checked».
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { ProbeCache, type StepChecksAnswer } from "../../wiki/step-checks/answer.ts";
import { createPeerAnswerer } from "../../wiki/step-checks/peer.ts";
import type { ProbeDeps } from "../../wiki/step-checks/probes.ts";
import { registerChecksAnswerRoute } from "./checks-answer.ts";
import { registerWikiStepChecksRoute, STEP_CHECKS_PATH } from "./wiki-step-checks.ts";

const lane = (...items: string[]) => ["---", "title: T", "---", "", "<NextMoves>", "", '<Lane kind="you">', "", ...items, "", "</Lane>", "", "</NextMoves>", ""].join("\n");

const STEPS = [
  '1. No on <Check env="HAVE" migration="086" />',
  '2. Alpha <Check env="HAVE" migration="086" on="alpha" />',
  '3. Beta <Check env="HAVE" migration="086" on="beta" />',
  '4. Both, split <Check env="HAVE" migration="086" on="alpha,beta" />',
  '5. Gamma <Check env="HAVE" migration="086" on="gamma" />',
  '6. Both, all hold <Check env="BOTH" migration="001" on="alpha,beta" />',
  '7. Beta and gamma <Check env="BOTH" migration="001" on="beta,gamma" />',
];
const PAGES: Record<string, string> = {
  "plans/mixed.mdx": lane(...STEPS),
  "plans/ten.mdx": lane(...Array.from({ length: 10 }, (_, i) => `${i + 1}. Same <Check env="HAVE" migration="086" on="beta" />`)),
};

const ROOT = (() => {
  const root = testTempDirSync(path.join(tmpdir(), "step-checks-peer-"));
  mkdirSync(path.join(root, "plans"), { recursive: true });
  for (const [rel, text] of Object.entries(PAGES)) writeFileSync(path.join(root, rel), text);
  return root;
})();
const scope = {
  registry: () => [{ name: "W", root: ROOT, source: "extra" }] as WikiRegistryEntry[],
  workMapWikis: () => ["W"],
  answerConfig: () => ({ wikis: new Set(["w"]), owner: null, groups: new Map() }),
  isReadonlyRoot: () => false,
};

/** A machine's facts: what its `.env` names, what its process has, which migrations it applied. */
interface Facts {
  file: string[];
  proc: string[];
  applied: string[];
  hang?: boolean;
}
const probesOf = (f: Facts): ProbeDeps =>
  ({
    git: async () => {
      throw new Error("git must not run");
    },
    roots: null,
    readEnvFile: async () => ({ bytes: new TextEncoder().encode(f.file.map((k) => `${k}=1\n`).join("")) }),
    processHasEnv: (k: string) => f.proc.includes(k),
    appliedMigrations: () => (f.hang ? new Promise<never>(() => {}) : Promise.resolve(new Set(f.applied))),
  }) as ProbeDeps;

// alpha: env HAVE ok, migration 086 not-yet. beta: env HAVE not-yet (in .env, not loaded), migration 086 ok.
const ALPHA: Facts = { file: ["HAVE", "BOTH"], proc: ["HAVE", "BOTH"], applied: ["001"] };
const BETA: Facts = { file: ["HAVE", "BOTH"], proc: ["BOTH"], applied: ["001", "086"] };

function betaApp(machine: string, facts: Facts = BETA) {
  const b = new Hono();
  registerChecksAnswerRoute(b, {} as Config, () => ({ probes: probesOf(facts), machine, cache: new ProbeCache(), boundMs: 2_000 }));
  return b;
}

type Rewrite = (body: Record<string, unknown>) => Record<string, unknown>;
interface Scenario {
  /** beta's own `MUNINN_MACHINE`. */
  betaMachine?: string;
  down?: boolean;
  delayMs?: number;
  rewrite?: Rewrite;
  clientTimeoutMs?: number;
  alphaBoundMs?: number;
}

function alphaApp(s: Scenario = {}) {
  const b = betaApp(s.betaMachine ?? "beta");
  const calls = { n: 0 };
  const peer = createPeerAnswerer({
    peers: new Map([["beta", "https://beta.example.test"]]),
    timeoutMs: s.clientTimeoutMs ?? 2_000,
    fetch: async (input, init) => {
      calls.n++;
      if (s.down) throw new Error("ECONNREFUSED");
      if (s.delayMs) await Bun.sleep(s.delayMs);
      const res = await b.fetch(new Request(input, init));
      if (!s.rewrite) return res;
      return new Response(JSON.stringify(s.rewrite(await res.json())), { status: res.status, headers: res.headers });
    },
  });
  const a = new Hono();
  registerWikiStepChecksRoute(a, {} as Config, () => ({ scope, answer: { probes: probesOf(ALPHA), machine: "alpha", cache: new ProbeCache(), peer, boundMs: s.alphaBoundMs ?? 3_000 } }));
  return { a, calls };
}

const checks = async (a: Hono, rel: string) => (await (await a.request(`${STEP_CHECKS_PATH}?wiki=W&relPath=${rel}`)).json()) as StepChecksAnswer;

/** Every cell `step|machine|probe → state`, plus `step|machine` and `step` states. */
function cells(body: StepChecksAnswer): Record<string, string> {
  const out: Record<string, string> = {};
  body.steps.forEach((s, i) => {
    out[`${i + 1}`] = s.state;
    for (const m of s.machines) {
      out[`${i + 1}|${m.name}`] = m.state;
      for (const p of m.probes) out[`${i + 1}|${m.name}|${p.kind}=${p.value}`] = p.state;
    }
  });
  return out;
}

// Hand-written: per machine and probe, what each muninn answers when beta is healthy.
const HEALTHY: Record<string, string> = {
  "1": "not-yet", "1|alpha": "not-yet", "1|alpha|env=HAVE": "ok", "1|alpha|migration=086": "not-yet",
  "2": "not-yet", "2|alpha": "not-yet", "2|alpha|env=HAVE": "ok", "2|alpha|migration=086": "not-yet",
  "3": "not-yet", "3|beta": "not-yet", "3|beta|env=HAVE": "not-yet", "3|beta|migration=086": "ok",
  "4": "not-yet", "4|alpha": "not-yet", "4|alpha|env=HAVE": "ok", "4|alpha|migration=086": "not-yet",
  "4|beta": "not-yet", "4|beta|env=HAVE": "not-yet", "4|beta|migration=086": "ok",
  "5": "unknown", "5|gamma": "unknown", "5|gamma|env=HAVE": "unknown", "5|gamma|migration=086": "unknown",
  "6": "ok", "6|alpha": "ok", "6|alpha|env=BOTH": "ok", "6|alpha|migration=001": "ok",
  "6|beta": "ok", "6|beta|env=BOTH": "ok", "6|beta|migration=001": "ok",
  "7": "unknown", "7|beta": "ok", "7|beta|env=BOTH": "ok", "7|beta|migration=001": "ok",
  "7|gamma": "unknown", "7|gamma|env=BOTH": "unknown", "7|gamma|migration=001": "unknown",
};
// Hand-written: beta's answer cannot be trusted, so every beta cell is unknown and no step naming beta is ok.
const BETA_UNTRUSTED: Record<string, string> = {
  ...HEALTHY,
  "3": "unknown", "3|beta": "unknown", "3|beta|env=HAVE": "unknown", "3|beta|migration=086": "unknown",
  "4": "not-yet", "4|beta": "unknown", "4|beta|env=HAVE": "unknown", "4|beta|migration=086": "unknown",
  "6": "unknown", "6|beta": "unknown", "6|beta|env=BOTH": "unknown", "6|beta|migration=001": "unknown",
  "7": "unknown", "7|beta": "unknown", "7|beta|env=BOTH": "unknown", "7|beta|migration=001": "unknown",
};

const SCENARIOS: [string, Scenario, Record<string, string>][] = [
  ["beta healthy", {}, HEALTHY],
  ["beta down (throws)", { down: true }, BETA_UNTRUSTED],
  ["beta slower than the client timeout", { delayMs: 400, clientTimeoutMs: 100 }, BETA_UNTRUSTED],
  ["beta slower than alpha's whole bound", { delayMs: 600, clientTimeoutMs: 5_000, alphaBoundMs: 200 }, BETA_UNTRUSTED],
  ["the url reaches a muninn that is delta", { betaMachine: "delta" }, BETA_UNTRUSTED],
  ["beta lies about its name, claiming all ok", { rewrite: (b) => ({ ...b, machine: "gamma", results: (b.results as object[]).map((r) => ({ ...r, state: "ok" })) }) }, BETA_UNTRUSTED],
  ["beta on v:2, claiming all ok", { rewrite: (b) => ({ ...b, v: 2, results: (b.results as object[]).map((r) => ({ ...r, state: "ok" })) }) }, BETA_UNTRUSTED],
  ["beta swaps its results", { rewrite: (b) => ({ ...b, results: [...(b.results as object[])].reverse() }) }, BETA_UNTRUSTED],
  ["beta adds a result", { rewrite: (b) => ({ ...b, results: [...(b.results as object[]), { kind: "env", value: "X", state: "ok" }] }) }, BETA_UNTRUSTED],
];

describe("step checks across two muninns", () => {
  for (const [name, scenario, want] of SCENARIOS) {
    test(`every (step, machine, probe) cell: ${name}`, async () => {
      const t0 = Date.now();
      const got = cells(await checks(alphaApp(scenario).a, "plans/mixed.mdx"));
      expect(Date.now() - t0).toBeLessThan(2_500);
      expect(got).toEqual(want);
    });
  }

  test("the split step pins each machine's answer to its own probe, and the why names beta", async () => {
    const body = await checks(alphaApp().a, "plans/mixed.mdx");
    const split = body.steps[3]!;
    expect(split.machines.map((m) => [m.name, m.probes.map((p) => `${p.kind}=${p.value}:${p.state}`)])).toEqual([
      ["alpha", ["env=HAVE:ok", "migration=086:not-yet"]],
      ["beta", ["env=HAVE:not-yet", "migration=086:ok"]],
    ]);
    expect(split.machines[1]!.probes[0]!.why).toStartWith("beta: ");
  });

  test("ten steps with the same probes on beta make one peer call", async () => {
    const { a, calls } = alphaApp();
    const body = await checks(a, "plans/ten.mdx");
    expect(body.steps).toHaveLength(10);
    for (const s of body.steps) expect(s.machines[0]!.probes.map((p) => p.state)).toEqual(["not-yet", "ok"]);
    expect(calls.n).toBe(1);
  });

  test("the mixed page asks beta once for its four distinct probes", async () => {
    const { a, calls } = alphaApp();
    await checks(a, "plans/mixed.mdx");
    expect(calls.n).toBe(1);
  });
});
