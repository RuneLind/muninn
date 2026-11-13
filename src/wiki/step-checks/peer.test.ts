/**
 * The peer client against fake replies: every off-grammar reply makes every
 * probe of that request `unknown`, a timeout answers inside its bound, the
 * cache is per (machine, kind, value), and only ok/not-yet are kept.
 */
import { describe, expect, test } from "bun:test";
import type { CheckProbe } from "../../format/check-tag.ts";
import { createPeerAnswerer, readPeerReply } from "./peer.ts";

const P: CheckProbe[] = [
  { kind: "env", value: "HAVE" },
  { kind: "migration", value: "086" },
];
const PEERS = new Map([
  ["beta", "https://beta.test"],
  ["delta", "https://delta.test"],
]);

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const good = (machine = "beta", states = ["not-yet", "ok"]) => ({ v: 1, machine, results: P.map((p, i) => ({ ...p, state: states[i], why: `w${i}` })) });

function client(reply: (url: URL, init: RequestInit) => Response | Promise<Response>, opts: { timeoutMs?: number; now?: () => number } = {}) {
  const calls: URL[] = [];
  const answer = createPeerAnswerer({
    peers: PEERS,
    timeoutMs: opts.timeoutMs,
    now: opts.now,
    fetch: async (input, init) => {
      const u = new URL(input);
      calls.push(u);
      return reply(u, init);
    },
  });
  return { answer, calls };
}

const states = (rs: { state: string }[]) => rs.map((r) => r.state);

describe("readPeerReply", () => {
  test("accepts the exact grammar and prefixes the machine on each why", () => {
    expect(readPeerReply(good(), "beta", P)).toEqual([
      { state: "not-yet", why: "beta: w0" },
      { state: "ok", why: "beta: w1" },
    ]);
  });

  const BAD: [string, unknown][] = [
    ["not an object", "x"],
    ["null", null],
    ["v=2", { ...good(), v: 2 }],
    ["v as a string", { ...good(), v: "1" }],
    ["another machine", good("gamma")],
    ["no machine", { ...good(), machine: undefined }],
    ["swapped order", { ...good(), results: [...good().results].reverse() }],
    ["one missing", { ...good(), results: good().results.slice(0, 1) }],
    ["one extra", { ...good(), results: [...good().results, { kind: "env", value: "X", state: "ok" }] }],
    ["value not echoed", { ...good(), results: [{ ...good().results[0], value: "OTHER" }, good().results[1]] }],
    ["a state outside the three", { ...good(), results: [{ ...good().results[0], state: "checked" }, good().results[1]] }],
    ["a why that is not text", { ...good(), results: [{ ...good().results[0], why: 3 }, good().results[1]] }],
    ["results not an array", { ...good(), results: {} }],
  ];
  for (const [name, body] of BAD) test(`refuses: ${name}`, () => expect("refused" in (readPeerReply(body, "beta", P) as object)).toBe(true));
});

describe("createPeerAnswerer", () => {
  test("no MUNINN_PEERS entry: today's «no peer configured», no request", async () => {
    const { answer, calls } = client(() => json(good()));
    expect(await answer("gamma", P)).toEqual(P.map(() => ({ state: "unknown", why: "no peer configured for gamma" })));
    expect(calls).toHaveLength(0);
  });

  test("the request: v=1, the machine asked, the probes as repeated p, redirect error, an abort signal", async () => {
    let seen: RequestInit | null = null;
    const { answer, calls } = client((_u, init) => ((seen = init), json(good())));
    expect(states(await answer("beta", P))).toEqual(["not-yet", "ok"]);
    expect(calls[0]!.origin + calls[0]!.pathname).toBe("https://beta.test/api/checks/answer");
    expect(calls[0]!.searchParams.get("v")).toBe("1");
    expect(calls[0]!.searchParams.get("machine")).toBe("beta");
    expect(calls[0]!.searchParams.getAll("p")).toEqual(["env:HAVE", "migration:086"]);
    expect(seen!.redirect).toBe("error");
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
  });

  const FAULTS: [string, () => Response | Promise<Response>][] = [
    ["non-200", () => json(good(), { status: 500 })],
    ["a 302 handed back", () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } })],
    ["redirect: error throws", () => Promise.reject(new TypeError("unexpected redirect"))],
    ["down (throws)", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["text/html", () => new Response(JSON.stringify(good()), { status: 200, headers: { "content-type": "text/html" } })],
    ["not JSON", () => new Response("{nope", { status: 200, headers: { "content-type": "application/json" } })],
    ["v=2", () => json({ ...good(), v: 2 })],
    ["answers as another machine", () => json(good("gamma"))],
    ["swapped order", () => json({ ...good(), results: [...good().results].reverse() })],
    ["one extra result", () => json({ ...good(), results: [...good().results, good().results[0]] })],
    ["one missing result", () => json({ ...good(), results: good().results.slice(1) })],
    ["oversized body", () => json({ ...good(), pad: "x".repeat(70 * 1024) })],
    ["oversized body, no length", () => new Response(new Blob([JSON.stringify({ ...good(), pad: "x".repeat(70 * 1024) })]).stream(), { status: 200, headers: { "content-type": "application/json" } })],
  ];
  for (const [name, reply] of FAULTS) {
    test(`every probe unknown: ${name}`, async () => {
      const { answer } = client(reply);
      const got = await answer("beta", P);
      expect(states(got)).toEqual(["unknown", "unknown"]);
      for (const r of got) expect(r.why).toStartWith("the peer for beta ");
    });
  }

  test("timeout: a peer that never answers is unknown inside the bound, and the signal is aborted", async () => {
    let signal: AbortSignal | undefined;
    const { answer } = client((_u, init) => ((signal = init.signal ?? undefined), new Promise<Response>(() => {})), { timeoutMs: 60 });
    const t0 = Date.now();
    const got = await answer("beta", P);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(got).toEqual(P.map(() => ({ state: "unknown", why: "the peer for beta timed out" })));
    expect(signal!.aborted).toBe(true);
  });

  test("a body that stalls past the bound is unknown too", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"v":1,')); } });
    const { answer } = client(() => new Response(stalled, { status: 200, headers: { "content-type": "application/json" } }), { timeoutMs: 60 });
    expect(states(await answer("beta", P))).toEqual(["unknown", "unknown"]);
  });

  test("calls in one pass coalesce into one request; ok/not-yet are cached for the TTL", async () => {
    let t = 0;
    const { answer, calls } = client(() => json(good()), { now: () => t });
    const all = await Promise.all(Array.from({ length: 10 }, () => answer("beta", P)));
    expect(calls).toHaveLength(1);
    for (const r of all) expect(states(r)).toEqual(["not-yet", "ok"]);
    t = 29_999;
    await answer("beta", P);
    expect(calls).toHaveLength(1);
    t = 30_000;
    await answer("beta", P);
    expect(calls).toHaveLength(2);
  });

  test("different probe sets in one pass go out as one request of their union", async () => {
    const { answer, calls } = client((u) => {
      const asked = u.searchParams.getAll("p").map((s) => ({ kind: s.split(":")[0], value: s.slice(s.indexOf(":") + 1) }));
      return json({ v: 1, machine: "beta", results: asked.map((p) => ({ ...p, state: "ok" })) });
    });
    const [a, b] = await Promise.all([answer("beta", [P[0]!]), answer("beta", P)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchParams.getAll("p")).toEqual(["env:HAVE", "migration:086"]);
    expect(states(a)).toEqual(["ok"]);
    expect(states(b)).toEqual(["ok", "ok"]);
  });

  test("an unknown is not cached: a failed first answer does not stick", async () => {
    let fail = true;
    const { answer, calls } = client(() => (fail ? Promise.reject(new Error("down")) : json(good())));
    expect(states(await answer("beta", P))).toEqual(["unknown", "unknown"]);
    fail = false;
    expect(states(await answer("beta", P))).toEqual(["not-yet", "ok"]);
    expect(calls).toHaveLength(2);
  });

  test("two machines' caches never cross: the same kind+value yields each peer's own answer", async () => {
    const { answer, calls } = client((u) => (u.hostname === "beta.test" ? json(good("beta", ["ok", "ok"])) : json(good("delta", ["not-yet", "not-yet"]))));
    expect(states(await answer("beta", P))).toEqual(["ok", "ok"]);
    expect(states(await answer("delta", P))).toEqual(["not-yet", "not-yet"]);
    expect(states(await answer("beta", P))).toEqual(["ok", "ok"]);
    expect(calls.map((c) => c.hostname)).toEqual(["beta.test", "delta.test"]);
  });

  test("a page over MAX_PROBES_PER_PAGE distinct probes goes out in chunks the answerer accepts", async () => {
    const many: CheckProbe[] = Array.from({ length: 75 }, (_, i) => ({ kind: "env", value: `K${i}` }));
    const { answer, calls } = client((u) => {
      const ps = u.searchParams.getAll("p");
      return json({ v: 1, machine: "beta", results: ps.map((s) => ({ kind: "env", value: s.slice(4), state: "ok" })) });
    });
    expect(states(await answer("beta", many)).every((s) => s === "ok")).toBe(true);
    expect(calls.map((c) => c.searchParams.getAll("p").length)).toEqual([60, 15]);
  });
});
