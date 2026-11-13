/**
 * The peer client against fake replies: every off-grammar reply makes every
 * probe of that request `unknown`, a timeout answers inside its bound, the
 * cache is per (machine, kind, value), and only ok/not-yet are kept.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import type { CheckProbe } from "../../format/check-tag.ts";
import { createPeerAnswerer, PEER_DOWN_WINDOW_MS, readPeerReply } from "./peer.ts";

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

function client(reply: (url: URL, init: RequestInit) => Response | Promise<Response>, opts: { timeoutMs?: number; now?: () => number; peers?: ReadonlyMap<string, string> } = {}) {
  const calls: URL[] = [];
  const answer = createPeerAnswerer({
    peers: opts.peers ?? PEERS,
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

  // Every C0/C1 control, U+2028/2029 and the bidi controls: none may survive into a why, which the chip title joins with \n.
  const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
  const WHYS: [string, string][] = [
    ["\\n forging another machine's line", "holds\nlaptop: env=X: holds"],
    ["\\r", "a\rb"],
    ["\\t", "a\tb"],
    ["NUL", "a\u0000b"],
    ["NEL (C1)", "a\u0085b"],
    ["line separator", "a\u2028b\u2029c"],
    ["RLO", "a\u202eb"],
    ["LRI", "a\u2066b\u2069"],
    ["DEL and a run of mixed whitespace", "a\u007f \n\t  b"],
    ["400 chars", "x".repeat(400)],
    ["400 chars of newlines then text", "\n".repeat(400) + "tail"],
  ];
  for (const [name, why] of WHYS) {
    test(`a peer's why is one line with no control or bidi character: ${name}`, () => {
      const got = readPeerReply({ v: 1, machine: "beta", results: [{ ...P[0], state: "not-yet", why }, { ...P[1], state: "ok" }] }, "beta", P) as { why: string }[];
      const w = got[0]!.why;
      expect(w).toStartWith("beta: ");
      expect(FORBIDDEN.test(w)).toBe(false);
      expect(/\s{2,}/.test(w)).toBe(false);
      expect(w.length).toBeLessThanOrEqual("beta: ".length + 300);
      expect(w.slice("beta: ".length).trim()).not.toBe("");
    });
  }

  test("a forged line and runs of whitespace collapse to single spaces, text kept", () => {
    const got = readPeerReply({ v: 1, machine: "beta", results: [{ ...P[0], state: "not-yet", why: " holds\n\nlaptop:\u202e env=X\t holds " }, { ...P[1], state: "ok" }] }, "beta", P) as { why: string }[];
    expect(got[0]!.why).toBe("beta: holds laptop: env=X holds");
  });

  test("the cut comes after the clean-up: 400 newlines then text keep the text", () => {
    const got = readPeerReply({ v: 1, machine: "beta", results: [{ ...P[0], state: "not-yet", why: "\n".repeat(400) + "tail" }, { ...P[1], state: "ok" }] }, "beta", P) as { why: string }[];
    expect(got[0]!.why).toBe("beta: tail");
  });

  test("a why of only control characters reads as no reason given", () => {
    const got = readPeerReply({ v: 1, machine: "beta", results: [{ ...P[0], state: "not-yet", why: "\n\u202e\u0000" }, { ...P[1], state: "ok" }] }, "beta", P) as { why: string }[];
    expect(got[0]!.why).toBe("beta: no reason given");
  });
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

  test("a 429 from a busy peer: every probe unknown, the why says the peer is busy", async () => {
    const { answer, calls } = client(() => json({ error: "busy" }, { status: 429 }));
    expect(await answer("beta", P)).toEqual(P.map(() => ({ state: "unknown", why: "the peer for beta is busy" })));
    expect(calls).toHaveLength(1);
  });

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

  test("an unknown is not cached: a failed first answer does not stick past the down window", async () => {
    let fail = true;
    let t = 0;
    const { answer, calls } = client(() => (fail ? Promise.reject(new Error("down")) : json(good())), { now: () => t });
    expect(states(await answer("beta", P))).toEqual(["unknown", "unknown"]);
    fail = false;
    t = PEER_DOWN_WINDOW_MS;
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

describe("the down window: a request that fails as a whole (thrown, timed out or refused) answers that machine unknown at once for a while", () => {
  const down = () => Promise.reject(Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }));

  test("the window is 15 s", () => expect(PEER_DOWN_WINDOW_MS).toBe(15_000));

  test("a throwing fetch: the next ask inside the window makes no request and says «a moment ago»; after it, the network again", async () => {
    let t = 1_000;
    const { answer, calls } = client(down, { now: () => t });
    expect(states(await answer("beta", P))).toEqual(["unknown", "unknown"]);
    expect(calls).toHaveLength(1);
    t += PEER_DOWN_WINDOW_MS - 1;
    const inside = await answer("beta", P);
    expect(calls).toHaveLength(1);
    expect(states(inside)).toEqual(["unknown", "unknown"]);
    for (const r of inside) {
      expect(r.why).toStartWith("the peer for beta ");
      expect(r.why).toContain("a moment ago");
      expect(r.why).not.toContain("\n");
    }
    t += 1;
    expect(states(await answer("beta", P))).toEqual(["unknown", "unknown"]);
    expect(calls).toHaveLength(2);
  });

  test("a peer that recovers is read normally once the window has passed", async () => {
    let t = 0;
    let up = false;
    const { answer, calls } = client(() => (up ? json(good()) : down()), { now: () => t });
    await answer("beta", P);
    up = true;
    t = 5_000;
    expect(states(await answer("beta", P))).toEqual(["unknown", "unknown"]);
    expect(calls).toHaveLength(1);
    t = PEER_DOWN_WINDOW_MS;
    expect(states(await answer("beta", P))).toEqual(["not-yet", "ok"]);
    expect(calls).toHaveLength(2);
  });

  test("machine beta's window does not silence delta", async () => {
    const { answer, calls } = client((u) => (u.hostname === "beta.test" ? down() : json(good("delta"))), { now: () => 0 });
    await answer("beta", P);
    expect(states(await answer("delta", P))).toEqual(["not-yet", "ok"]);
    expect(calls.map((c) => c.hostname)).toEqual(["beta.test", "delta.test"]);
    await answer("beta", P);
    expect(calls).toHaveLength(2);
  });

  const WHOLE: [string, () => Response | Promise<Response>][] = [
    ["answers as another machine", () => json(good("gamma"))],
    ["v=2", () => json({ ...good(), v: 2 })],
    ["429 busy", () => json({ error: "busy" }, { status: 429 })],
    ["HTML", () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["a different number of results", () => json({ ...good(), results: good().results.slice(1) })],
  ];
  for (const [name, reply] of WHOLE) {
    test(`a whole-reply refusal opens the window: ${name}`, async () => {
      const { answer, calls } = client(reply, { now: () => 0 });
      await answer("beta", P);
      const again = await answer("beta", P);
      expect(calls).toHaveLength(1);
      expect(states(again)).toEqual(["unknown", "unknown"]);
      for (const r of again) expect(r.why).toContain("a moment ago");
    });
  }

  test("a valid reply with a probe-level unknown opens no window and is still not cached", async () => {
    const { answer, calls } = client(() => json(good("beta", ["unknown", "unknown"])), { now: () => 0 });
    await answer("beta", P);
    const again = await answer("beta", P);
    expect(calls).toHaveLength(2);
    for (const r of again) expect(r.why).not.toContain("a moment ago");
  });

  test("an ok cached from a valid reply before the failure is still served in the window; the rest is unknown, never ok", async () => {
    let t = 0;
    let up = true;
    const { answer, calls } = client((u) => {
      if (!up) return down();
      const asked = u.searchParams.getAll("p").map((s) => ({ kind: s.split(":")[0], value: s.slice(s.indexOf(":") + 1) }));
      return json({ v: 1, machine: "beta", results: asked.map((p) => ({ ...p, state: "ok" })) });
    }, { now: () => t });
    expect(states(await answer("beta", [P[0]!]))).toEqual(["ok"]);
    up = false;
    t = 1_000;
    expect(states(await answer("beta", [P[1]!]))).toEqual(["unknown"]);
    expect(calls).toHaveLength(2);
    t = 2_000;
    const got = await answer("beta", P);
    expect(calls).toHaveLength(2);
    expect(got[0]).toEqual({ state: "ok", why: "beta: holds" });
    expect(got[1]!.state).toBe("unknown");
    expect(got[1]!.why).toContain("a moment ago");
    // Once the cached ok expires inside the window, it is unknown too: the window never yields ok.
    t = 30_000 - 1;
    expect(states(await answer("beta", P))).toEqual(["ok", "unknown"]);
    t = 30_000;
    expect(states(await answer("beta", P))).toEqual(["unknown", "unknown"]);
  });

  test("a valid reply that lands while the window is open closes it: the next ask goes to the network", async () => {
    let release!: (r: Response) => void;
    let n = 0;
    const { answer, calls } = client((u) => {
      n++;
      if (n === 1) return new Promise<Response>((r) => (release = r));
      if (n === 2) return down();
      const asked = u.searchParams.getAll("p").map((s) => ({ kind: s.split(":")[0], value: s.slice(s.indexOf(":") + 1) }));
      return json({ v: 1, machine: "beta", results: asked.map((p) => ({ ...p, state: "ok" })) });
    }, { now: () => 0 });
    const slow = answer("beta", [P[0]!]);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    // The window opens while the first request is still in flight.
    expect(states(await answer("beta", [P[1]!]))).toEqual(["unknown"]);
    expect(calls).toHaveLength(2);
    release(json({ v: 1, machine: "beta", results: [{ ...P[0], state: "ok" }] }));
    expect(states(await slow)).toEqual(["ok"]);
    const after = await answer("beta", [P[1]!]);
    expect(calls).toHaveLength(3);
    expect(after).toEqual([{ state: "ok", why: "beta: holds" }]);
  });

  test("delta's failure opens delta's window only: beta, reachable, is still asked", async () => {
    const { answer, calls } = client((u) => (u.hostname === "delta.test" ? down() : json(good("beta"))), { now: () => 0 });
    expect(states(await answer("delta", P))).toEqual(["unknown", "unknown"]);
    expect(states(await answer("beta", P))).toEqual(["not-yet", "ok"]);
    expect(calls.map((c) => c.hostname)).toEqual(["delta.test", "beta.test"]);
  });
});

describe("a clock that steps back expires a timer instead of stretching it", () => {
  const down = () => Promise.reject(Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" }));
  const T0 = 10_000_000;
  const HOUR = 3_600_000;

  test("window: inside it no request, at its end the network again (forward clock unchanged)", async () => {
    let t = T0;
    const { answer, calls } = client(down, { now: () => t });
    await answer("beta", P);
    await answer("beta", P);
    expect(calls).toHaveLength(1);
    t = T0 + PEER_DOWN_WINDOW_MS - 1;
    await answer("beta", P);
    expect(calls).toHaveLength(1);
    t = T0 + PEER_DOWN_WINDOW_MS;
    await answer("beta", P);
    expect(calls).toHaveLength(2);
  });

  test("window: the clock moved back 1 h, the next ask makes a request instead of «unreachable»", async () => {
    let t = T0;
    let up = false;
    const { answer, calls } = client(() => (up ? json(good()) : down()), { now: () => t });
    await answer("beta", P);
    up = true;
    t = T0 - HOUR;
    const got = await answer("beta", P);
    expect(calls).toHaveLength(2);
    expect(states(got)).toEqual(["not-yet", "ok"]);
  });

  test("window: a step back smaller than the window (5 s) expires it too: the opening lies in the future", async () => {
    let t = T0;
    const { answer, calls } = client(down, { now: () => t });
    await answer("beta", P);
    t = T0 - 5_000;
    const got = await answer("beta", P);
    expect(calls).toHaveLength(2);
    for (const r of got) expect(r.why).not.toContain("a moment ago");
  });

  test("cache: forward TTL unchanged — same instant and 29.999 s hit, 30 s misses", async () => {
    let t = T0;
    const { answer, calls } = client(() => json(good()), { now: () => t });
    await answer("beta", P);
    await answer("beta", P);
    expect(calls).toHaveLength(1);
    t = T0 + 29_999;
    await answer("beta", P);
    expect(calls).toHaveLength(1);
    t = T0 + 30_000;
    await answer("beta", P);
    expect(calls).toHaveLength(2);
  });

  test("cache: an ok cached, the clock moved back 1 h: the next ask is a miss and the peer's not-yet wins, never the stale ok", async () => {
    let t = T0;
    let s = ["ok", "ok"];
    const { answer, calls } = client(() => json(good("beta", s)), { now: () => t });
    expect(states(await answer("beta", P))).toEqual(["ok", "ok"]);
    s = ["not-yet", "not-yet"];
    t = T0 - HOUR;
    expect(states(await answer("beta", P))).toEqual(["not-yet", "not-yet"]);
    expect(calls).toHaveLength(2);
  });
});

describe("why and log for a fetch that throws", () => {
  // Shapes observed from Bun 1.3.10 against a local Bun.serve (see the real-Bun tests below).
  const redirectErr = () => Object.assign(new Error('UnexpectedRedirect fetching "https://beta.test/api/checks/answer?v=1". For more information, pass `verbose: true` in the second argument to fetch()'), { code: "UnexpectedRedirect" });
  const refusedErr = () => Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
  const timeoutErr = () => new DOMException("The operation timed out.", "TimeoutError");
  const abortErr = () => new DOMException("The operation was aborted.", "AbortError");

  const WHY: [string, () => unknown, string][] = [
    ["a redirect refused by redirect: error", redirectErr, "the peer for beta answered with a redirect"],
    ["a refused connection", refusedErr, "the peer for beta could not be reached"],
    ["a TimeoutError", timeoutErr, "the peer for beta timed out"],
    ["an AbortError", abortErr, "the peer for beta timed out"],
  ];
  for (const [name, err, why] of WHY) {
    test(`the why names it: ${name}`, async () => {
      const { answer } = client(() => Promise.reject(err()), { now: () => 0 });
      expect(await answer("beta", P)).toEqual(P.map(() => ({ state: "unknown", why })));
    });
  }

  describe("the log", () => {
    const records: LogRecord[] = [];
    const capture = async () => {
      records.length = 0;
      await configure({ sinks: { capture: (r: LogRecord) => void records.push(r) }, loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }, { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" }], reset: true });
    };
    afterEach(async () => {
      await reset();
    });
    const rendered = (r: LogRecord) => r.message.map(String).join("");

    test("one warn per window per machine, naming the machine and the error, never the url", async () => {
      await capture();
      let t = 0;
      const { answer } = client(() => Promise.reject(redirectErr()), { now: () => t });
      for (let i = 0; i < 5; i++) await answer("beta", P);
      const many: CheckProbe[] = Array.from({ length: 75 }, (_, i) => ({ kind: "env", value: `K${i}` }));
      await answer("beta", many);
      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.level).toBe("warning");
      expect(r.properties.machine).toBe("beta");
      expect(r.properties.errorName).toBe("Error");
      expect(r.properties.errorCode).toBe("UnexpectedRedirect");
      expect(rendered(r)).toContain("beta");
      const all = rendered(r) + JSON.stringify(r.properties);
      expect(all).not.toContain("beta.test");
      expect(all).not.toContain("https://");
      t = PEER_DOWN_WINDOW_MS;
      await answer("beta", P);
      expect(records).toHaveLength(2);
    });

    test("a page whose 75 probes fail in two requests logs once", async () => {
      await capture();
      const { answer, calls } = client(() => Promise.reject(refusedErr()), { now: () => 0 });
      await answer("beta", Array.from({ length: 75 }, (_, i) => ({ kind: "env", value: `K${i}` })));
      expect(calls).toHaveLength(2);
      expect(records).toHaveLength(1);
    });

    test("each machine gets its own line", async () => {
      await capture();
      const { answer } = client(() => Promise.reject(refusedErr()), { now: () => 0 });
      await answer("beta", P);
      await answer("delta", P);
      await answer("beta", P);
      expect(records.map((r) => r.properties.machine)).toEqual(["beta", "delta"]);
    });

    test("a refused whole reply logs its reason, with no error name", async () => {
      await capture();
      const { answer } = client(() => json({ error: "busy" }, { status: 429 }), { now: () => 0 });
      await answer("beta", P);
      expect(records).toHaveLength(1);
      expect(records[0]!.properties.machine).toBe("beta");
      expect(records[0]!.properties.reason).toBe("is busy");
    });
  });

  describe("against real Bun fetch and a local stub", () => {
    test("a redirect reads «answered with a redirect»; a closed port «could not be reached»", async () => {
      const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/x" } }) });
      const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
      const closedPort = closed.port;
      closed.stop(true);
      try {
        const answer = createPeerAnswerer({ peers: new Map([["beta", `http://127.0.0.1:${srv.port}`], ["delta", `http://127.0.0.1:${closedPort}`]]) });
        expect(await answer("beta", [P[0]!])).toEqual([{ state: "unknown", why: "the peer for beta answered with a redirect" }]);
        expect(await answer("delta", [P[0]!])).toEqual([{ state: "unknown", why: "the peer for delta could not be reached" }]);
      } finally {
        srv.stop(true);
      }
    });
  });
});
