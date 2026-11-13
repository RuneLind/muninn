/**
 * `GET /api/checks/answer`: this machine answers probes for itself only, with
 * the probes' outside reads faked (no git, no database, no real `.env`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { SIDE_EFFECTING_GETS } from "../../auth/origin.ts";
import { __setWikiReadonlyForTest } from "../../wiki/readonly.ts";
import { MAX_PROBES_PER_PAGE, ProbeCache } from "../../wiki/step-checks/answer.ts";
import { CHECKS_ANSWER_PATH } from "../../wiki/step-checks/peer.ts";
import type { ProbeDeps } from "../../wiki/step-checks/probes.ts";
import { registerChecksAnswerRoute, type ChecksAnswerDeps } from "./checks-answer.ts";

afterEach(() => __setWikiReadonlyForTest());

function app(machine: string | null, over: Partial<ProbeDeps> = {}, reads = { n: 0 }) {
  const probes = {
    git: async () => {
      reads.n++;
      throw new Error("git must not run: no repo roots");
    },
    roots: null,
    readEnvFile: async () => (reads.n++, { bytes: new TextEncoder().encode("HAVE=1\nONLYFILE=1\n") }),
    processHasEnv: (k: string) => (reads.n++, k === "HAVE"),
    appliedMigrations: async () => (reads.n++, new Set(["086"])),
    ...over,
  } as ProbeDeps;
  const deps: ChecksAnswerDeps = { probes, machine, cache: new ProbeCache(), boundMs: 2_000 };
  const a = new Hono();
  registerChecksAnswerRoute(a, {} as Config, () => deps);
  return a;
}

const get = (a: Hono, q: string) => a.request(`${CHECKS_ANSWER_PATH}?${q}`);

describe("GET /api/checks/answer", () => {
  test("is on SIDE_EFFECTING_GETS", () => {
    expect(SIDE_EFFECTING_GETS).toContain(CHECKS_ANSWER_PATH);
  });

  test("400: bad v, bad machine, no probes, too many, an unknown kind, a bad shape", async () => {
    const reads = { n: 0 };
    const a = app("beta", {}, reads);
    for (const q of [
      "machine=beta&p=env:HAVE",
      "v=2&machine=beta&p=env:HAVE",
      "v=1&p=env:HAVE",
      "v=1&machine=Beta&p=env:HAVE",
      "v=1&machine=my%20box&p=env:HAVE",
      "v=1&machine=beta",
      `v=1&machine=beta&${Array.from({ length: MAX_PROBES_PER_PAGE + 1 }, (_, i) => `p=env:K${i}`).join("&")}`,
      "v=1&machine=beta&p=nope:x",
      "v=1&machine=beta&p=env",
      "v=1&machine=beta&p=env:1BAD",
      "v=1&machine=beta&p=migration:86",
      "v=1&machine=beta&p=checkout:..%2Fx",
      "v=1&machine=beta&p=env:HAVE&p=restart:abc",
    ]) {
      expect([q, (await get(a, q)).status]).toEqual([q, 400]);
    }
    expect(reads.n).toBe(0);
  });

  test("exactly MAX_PROBES_PER_PAGE probes are accepted", async () => {
    const q = `v=1&machine=beta&${Array.from({ length: MAX_PROBES_PER_PAGE }, (_, i) => `p=env:K${i}`).join("&")}`;
    const res = await get(app("beta"), q);
    expect(res.status).toBe(200);
    expect((await res.json()).results).toHaveLength(MAX_PROBES_PER_PAGE);
  });

  test("asked as another machine: every probe unknown naming both, and nothing runs", async () => {
    const reads = { n: 0 };
    const body = await (await get(app("beta", {}, reads), "v=1&machine=alpha&p=env:HAVE&p=migration:086")).json();
    expect(body.v).toBe(1);
    expect(body.machine).toBe("beta");
    expect(body.results).toEqual([
      { kind: "env", value: "HAVE", state: "unknown", why: "asked as alpha, but this muninn is beta" },
      { kind: "migration", value: "086", state: "unknown", why: "asked as alpha, but this muninn is beta" },
    ]);
    expect(reads.n).toBe(0);
  });

  test("no MUNINN_MACHINE: every probe unknown, machine null", async () => {
    const reads = { n: 0 };
    const body = await (await get(app(null, {}, reads), "v=1&machine=beta&p=env:HAVE")).json();
    expect(body.machine).toBeNull();
    expect(body.results).toEqual([{ kind: "env", value: "HAVE", state: "unknown", why: "asked as beta, but this muninn has no MUNINN_MACHINE" }]);
    expect(reads.n).toBe(0);
  });

  test("each kind answered in request order, as the local probes answer it", async () => {
    const res = await get(app("beta"), "v=1&machine=beta&p=migration:087&p=env:HAVE&p=env:ONLYFILE&p=migration:086&p=checkout:muninn&p=pushed:muninn&p=restart:3010");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.machine).toBe("beta");
    expect(body.results.map((r: { kind: string; value: string; state: string }) => [r.kind, r.value, r.state])).toEqual([
      ["migration", "087", "not-yet"],
      ["env", "HAVE", "ok"],
      ["env", "ONLYFILE", "not-yet"],
      ["migration", "086", "ok"],
      ["checkout", "muninn", "unknown"],
      ["pushed", "muninn", "unknown"],
      ["restart", "3010", "unknown"],
    ]);
    for (const r of body.results) expect(typeof r.why).toBe("string");
  });

  test("works on a MUNINN_WIKI_READONLY instance: it writes nothing", async () => {
    __setWikiReadonlyForTest(true);
    const body = await (await get(app("beta"), "v=1&machine=beta&p=env:HAVE")).json();
    expect(body.results[0].state).toBe("ok");
  });

  test("never forwards: MUNINN_PEERS set on the answerer, the global fetch is never called", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    const prev = process.env.MUNINN_PEERS;
    process.env.MUNINN_PEERS = "alpha=http://127.0.0.1:9";
    try {
      // The real deps factory, under a config that carries peers: it has no peer field to forward through.
      const { realChecksAnswerDeps } = await import("./checks-answer.ts");
      const deps = realChecksAnswerDeps({ machine: "beta", peers: new Map([["alpha", "http://127.0.0.1:9"]]), decisionTriageRepoRoots: null } as unknown as Config);
      expect("peer" in deps).toBe(false);
      for (const m of ["alpha", "beta", "gamma"]) {
        const res = await get(app("beta"), `v=1&machine=${m}&p=env:HAVE&p=restart:3010`);
        expect(res.status).toBe(200);
      }
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = real;
      if (prev === undefined) delete process.env.MUNINN_PEERS;
      else process.env.MUNINN_PEERS = prev;
    }
  });
});
