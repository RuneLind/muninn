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
import { PEER_PROBE_VALUE_MAX, PEER_ROUTE_MAX_IN_FLIGHT, registerChecksAnswerRoute, type ChecksAnswerDeps } from "./checks-answer.ts";

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

  test("value and machine length: PEER_PROBE_VALUE_MAX accepted, one more is 400 and echoes nothing", async () => {
    expect(PEER_PROBE_VALUE_MAX).toBe(100);
    const reads = { n: 0 };
    const a = app("beta", {}, reads);
    const at = `K${"A".repeat(PEER_PROBE_VALUE_MAX - 1)}`;
    const ok = await get(a, `v=1&machine=beta&p=env:${at}`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).results[0].value).toBe(at);
    const n = reads.n;
    for (const q of [
      `v=1&machine=beta&p=env:${at}A`,
      `v=1&machine=beta&p=checkout:${"m".repeat(20_000)}`,
      `v=1&machine=beta&p=env:HAVE&p=pushed:${"m".repeat(PEER_PROBE_VALUE_MAX + 1)}`,
      `v=1&machine=${"b".repeat(PEER_PROBE_VALUE_MAX + 1)}&p=env:HAVE`,
    ]) {
      const res = await get(a, q);
      expect([q.slice(0, 40), res.status]).toEqual([q.slice(0, 40), 400]);
      expect((await res.text()).length).toBeLessThan(200);
    }
    expect(reads.n).toBe(n);
  });
});

describe("GET /api/checks/answer: requests in flight", () => {
  /** A Hono app of its own (own cache) whose migration read waits on `hold`; counts the reads. */
  function heldApp(hold: Promise<Set<string>>, reads: { n: number }, over: Partial<ChecksAnswerDeps> = {}, depsFor?: () => ChecksAnswerDeps) {
    const probes = {
      git: async () => {
        throw new Error("no git");
      },
      roots: null,
      readEnvFile: async () => ({ bytes: new Uint8Array() }),
      processHasEnv: () => true,
      appliedMigrations: () => (reads.n++, hold),
    } as unknown as ProbeDeps;
    const a = new Hono();
    registerChecksAnswerRoute(a, {} as Config, depsFor ?? (() => ({ probes, machine: "beta", cache: new ProbeCache(), boundMs: 2_000, ...over })));
    return a;
  }
  const Q = "v=1&machine=beta&p=migration:086";
  const served = async () => {
    const res = await get(app("beta"), "v=1&machine=beta&p=env:HAVE");
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].state).toBe("ok");
  };

  test(`cap+1 concurrent requests: exactly one 429 that runs nothing; the count comes back down`, async () => {
    expect(PEER_ROUTE_MAX_IN_FLIGHT).toBe(2);
    let release!: (s: Set<string>) => void;
    const hold = new Promise<Set<string>>((r) => (release = r));
    const reads = { n: 0 };
    const pending = Array.from({ length: PEER_ROUTE_MAX_IN_FLIGHT + 1 }, () => get(heldApp(hold, reads), Q));
    await Bun.sleep(20);
    release(new Set(["086"]));
    const res = await Promise.all(pending);
    const codes = res.map((r) => r.status).sort();
    expect(codes).toEqual([...Array(PEER_ROUTE_MAX_IN_FLIGHT).fill(200), 429]);
    expect(reads.n).toBe(PEER_ROUTE_MAX_IN_FLIGHT);
    const busy = res.find((r) => r.status === 429)!;
    expect(busy.headers.get("content-type")).toContain("application/json");
    expect(typeof (await busy.json()).error).toBe("string");
    for (const r of res.filter((r) => r.status === 200)) expect((await r.json()).results[0].state).toBe("ok");
    await served();
  });

  test("the count comes back down after a request that hit the route bound", async () => {
    const reads = { n: 0 };
    const never = new Promise<Set<string>>(() => {});
    const first = await Promise.all(Array.from({ length: PEER_ROUTE_MAX_IN_FLIGHT }, () => get(heldApp(never, reads, { boundMs: 30 }), Q)));
    for (const r of first) expect((await r.json()).results[0]).toMatchObject({ state: "unknown", why: "timed out" });
    await served();
    await served();
  });

  test("the count comes back down after a 400, a throwing probe and a throw in the handler", async () => {
    for (let i = 0; i < PEER_ROUTE_MAX_IN_FLIGHT + 1; i++) expect((await get(app("beta"), "v=1&machine=beta&p=nope:x")).status).toBe(400);
    await served();
    const throwing = app("beta", {
      processHasEnv: () => {
        throw new Error("probe threw");
      },
    });
    for (let i = 0; i < PEER_ROUTE_MAX_IN_FLIGHT + 1; i++) expect((await (await get(throwing, "v=1&machine=beta&p=env:HAVE")).json()).results[0].state).toBe("unknown");
    await served();
    const reads = { n: 0 };
    const boom = heldApp(Promise.resolve(new Set()), reads, {}, () => {
      throw new Error("deps threw");
    });
    for (let i = 0; i < PEER_ROUTE_MAX_IN_FLIGHT + 1; i++) expect((await get(boom, Q)).status).toBe(500);
    await served();
  });
});
