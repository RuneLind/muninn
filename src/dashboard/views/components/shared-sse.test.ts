import { describe, expect, test } from "bun:test";
import { sharedSseClient, type SharedSseChannel, type SharedSseDeps, type SharedSseLocks } from "./shared-sse.ts";
import type { SseHandlers } from "./client-runtime.ts";

// ── Fakes: one "origin" = one lock manager + one channel bus ────────────

class FakeLocks implements SharedSseLocks {
  private held = new Set<string>();
  private queues = new Map<string, Array<{ cb: () => Promise<void>; resolve: (v: unknown) => void }>>();
  request(name: string, opts: { signal?: AbortSignal }, cb: () => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const q = this.queues.get(name) ?? [];
      this.queues.set(name, q);
      const entry = { cb, resolve };
      q.push(entry);
      opts.signal?.addEventListener("abort", () => {
        const i = q.indexOf(entry);
        if (i >= 0) {
          q.splice(i, 1);
          reject(new Error("AbortError"));
        }
      });
      queueMicrotask(() => this.pump(name));
    });
  }
  private pump(name: string): void {
    if (this.held.has(name)) return;
    const e = this.queues.get(name)?.shift();
    if (!e) return;
    this.held.add(name);
    void e.cb().then((v) => {
      this.held.delete(name);
      e.resolve(v);
      this.pump(name);
    });
  }
}

class Bus {
  chans = new Map<string, Set<FakeChannel>>();
}
class FakeChannel implements SharedSseChannel {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(
    private bus: Bus,
    private name: string,
  ) {
    const set = bus.chans.get(name) ?? new Set();
    set.add(this);
    bus.chans.set(name, set);
  }
  postMessage(m: unknown): void {
    if (this.closed) throw new Error("InvalidStateError");
    const copy = structuredClone(m);
    for (const c of this.bus.chans.get(this.name) ?? []) if (c !== this) setTimeout(() => !c.closed && c.onmessage?.({ data: copy }), 0);
  }
  close(): void {
    this.closed = true;
    this.bus.chans.get(this.name)?.delete(this);
  }
}

class FakeES {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  listeners = new Map<string, Array<(ev: Event) => void>>();
  constructor(public url: string) {}
  addEventListener(n: string, fn: (ev: Event) => void): void {
    this.listeners.set(n, [...(this.listeners.get(n) ?? []), fn]);
  }
  close(): void {
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  emit(n: string, data: string): void {
    for (const fn of this.listeners.get(n) ?? []) fn(new MessageEvent(n, { data }));
  }
  fail(state: 0 | 2): void {
    this.readyState = state;
    this.onerror?.(new Event("error"));
  }
}

function origin(opts: { locks?: boolean; channel?: boolean } = {}) {
  const bus = new Bus();
  const locks = new FakeLocks();
  const opened: FakeES[] = [];
  let n = 0;
  const deps: SharedSseDeps = {
    locks: opts.locks === false ? null : locks,
    channel: opts.channel === false ? null : (name) => new FakeChannel(bus, name),
    eventSource: (u) => {
      const es = new FakeES(u);
      opened.push(es);
      return es as unknown as EventSource;
    },
    id: () => `tab${++n}`,
  };
  return { deps, opened };
}

/** A tab's handlers that log what they see; `readyStateOnError` reads the handle inside onerror. */
function recorder(names: string[]) {
  const log: string[] = [];
  const h: { handle?: { readyState: number } } = {};
  const handlers: SseHandlers = {
    onopen: () => log.push("open"),
    onerror: () => log.push(`error:${h.handle?.readyState}`),
  };
  for (const n of names) handlers[n] = (ev: Event) => log.push(`${n}:${(ev as MessageEvent).data}`);
  return { log, handlers, h };
}

const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

const URL = "/api/events";
const OPTS = { events: ["activity", "stats"], history: { activity: 2 } };

describe("sharedSseClient", () => {
  test("the first tab leads and opens the one stream; a second tab opens none and gets the leader's frames", async () => {
    const o = origin();
    const a = recorder(["stats"]);
    const ha = sharedSseClient(URL, a.handlers, { ...OPTS, deps: o.deps });
    await flush();
    expect(ha.role).toBe("leader");
    expect(o.opened.length).toBe(1);
    o.opened[0]!.open();
    o.opened[0]!.emit("stats", "s1");
    const b = recorder(["stats"]);
    const hb = sharedSseClient(URL, b.handlers, { ...OPTS, deps: o.deps });
    await flush();
    expect(hb.role).toBe("follower");
    expect(o.opened.length).toBe(1);
    o.opened[0]!.emit("stats", "s2");
    await flush();
    expect(a.log).toEqual(["open", "stats:s1", "stats:s2"]);
    expect(b.log).toEqual(["open", "stats:s1", "stats:s2"]);
    expect(hb.readyState).toBe(1);
  });

  test("a joiner is replayed the latest frame per name and the capped history, in arrival order; others get no replay", async () => {
    const o = origin();
    const a = recorder(["activity", "stats"]);
    sharedSseClient(URL, a.handlers, { ...OPTS, deps: o.deps });
    await flush();
    const es = o.opened[0]!;
    es.open();
    const b = recorder(["activity", "stats"]);
    sharedSseClient(URL, b.handlers, { ...OPTS, deps: o.deps });
    await flush();
    es.emit("activity", "a1");
    es.emit("stats", "s1");
    es.emit("activity", "a2");
    es.emit("activity", "a3");
    es.emit("stats", "s2");
    await flush();
    const c = recorder(["activity", "stats"]);
    sharedSseClient(URL, c.handlers, { ...OPTS, deps: o.deps });
    await flush();
    // a1 fell out of the history of 2; s1 was replaced by s2.
    expect(c.log).toEqual(["open", "activity:a2", "activity:a3", "stats:s2"]);
    // B saw each frame once: C's replay went to C alone.
    expect(b.log).toEqual(["open", "activity:a1", "stats:s1", "activity:a2", "activity:a3", "stats:s2"]);
  });

  test("a leader relays a name only another tab reads (the events option)", async () => {
    const o = origin();
    sharedSseClient(URL, recorder([]).handlers, { ...OPTS, deps: o.deps });
    await flush();
    o.opened[0]!.open();
    o.opened[0]!.emit("activity", "x");
    const b = recorder(["activity"]);
    sharedSseClient(URL, b.handlers, { ...OPTS, deps: o.deps });
    await flush();
    expect(b.log).toEqual(["open", "activity:x"]);
  });

  test("a joiner before the leader's stream opens gets open and the burst live", async () => {
    const o = origin();
    sharedSseClient(URL, recorder([]).handlers, { ...OPTS, deps: o.deps });
    await flush();
    const b = recorder(["stats"]);
    const hb = sharedSseClient(URL, b.handlers, { ...OPTS, deps: o.deps });
    await flush();
    expect(hb.readyState).toBe(0);
    expect(b.log).toEqual([]);
    o.opened[0]!.open();
    o.opened[0]!.emit("stats", "s1");
    await flush();
    expect(b.log).toEqual(["open", "stats:s1"]);
  });

  test("when the leader closes, the next tab takes over with its own stream and stays live", async () => {
    const o = origin();
    const ha = sharedSseClient(URL, recorder([]).handlers, { ...OPTS, deps: o.deps });
    await flush();
    o.opened[0]!.open();
    const b = recorder(["stats"]);
    const hb = sharedSseClient(URL, b.handlers, { ...OPTS, deps: o.deps });
    const c = recorder(["stats"]);
    sharedSseClient(URL, c.handlers, { ...OPTS, deps: o.deps });
    await flush();
    ha.close();
    expect(ha.readyState).toBe(2);
    expect(o.opened[0]!.readyState).toBe(2);
    await flush();
    expect(hb.role).toBe("leader");
    expect(o.opened.length).toBe(2);
    o.opened[1]!.open();
    o.opened[1]!.emit("stats", "after");
    await flush();
    expect(b.log).toEqual(["open", "open", "stats:after"]);
    expect(c.log).toEqual(["open", "open", "stats:after"]);
  });

  test("close() on a queued follower withdraws it: it never leads", async () => {
    const o = origin();
    const ha = sharedSseClient(URL, recorder([]).handlers, { ...OPTS, deps: o.deps });
    await flush();
    const hb = sharedSseClient(URL, recorder([]).handlers, { ...OPTS, deps: o.deps });
    await flush();
    hb.close();
    ha.close();
    await flush();
    expect(o.opened.length).toBe(1);
    expect(hb.role).toBe("follower");
    expect(hb.readyState).toBe(2);
  });

  test("an error carries the leader's readyState to the follower's handle, read inside onerror", async () => {
    const o = origin();
    const a = recorder([]);
    a.h.handle = sharedSseClient(URL, a.handlers, { ...OPTS, deps: o.deps });
    await flush();
    const es = o.opened[0]!;
    es.open();
    const b = recorder([]);
    b.h.handle = sharedSseClient(URL, b.handlers, { ...OPTS, deps: o.deps });
    await flush();
    es.fail(0); // a drop: the leader's EventSource reconnects natively
    await flush();
    expect(a.log).toEqual(["open", "error:0"]);
    expect(b.log).toEqual(["open", "error:0"]);
    expect(b.h.handle.readyState).toBe(0);
    es.open();
    await flush();
    expect(b.log).toEqual(["open", "error:0", "open"]);
    expect(b.h.handle.readyState).toBe(1);
  });

  test("a leader whose stream dies for good (2) steps down; the follower never reads 2 from it and leads with its own stream", async () => {
    const o = origin();
    const a = recorder([]);
    const ha = (a.h.handle = sharedSseClient(URL, a.handlers, { ...OPTS, deps: o.deps }));
    await flush();
    o.opened[0]!.open();
    const b = recorder([]);
    const hb = (b.h.handle = sharedSseClient(URL, b.handlers, { ...OPTS, deps: o.deps }));
    await flush();
    o.opened[0]!.fail(2);
    await flush();
    expect(a.log).toEqual(["open", "error:2"]);
    // The follower may take the lock before the error arrives: either way it is
    // reconnecting, never dead on the leader's verdict.
    expect(b.log).not.toContain("error:2");
    expect(ha.role).toBe("done");
    expect(ha.readyState).toBe(2);
    expect(hb.role).toBe("leader");
    expect(o.opened.length).toBe(2);
    o.opened[1]!.open();
    await flush();
    expect(hb.readyState).toBe(1);
    expect(b.log[b.log.length - 1]).toBe("open");
    // Its own stream refused too: now it reads 2 itself.
    o.opened[1]!.fail(2);
    expect(b.log[b.log.length - 1]).toBe("error:2");
    expect(a.log).toEqual(["open", "error:2"]); // the dead tab stays dead, as its own stream would
  });

  test("different URLs (two chat viewers) never share", async () => {
    const o = origin();
    const h1 = sharedSseClient("/chat/events?viewer=a", recorder([]).handlers, { deps: o.deps });
    const h2 = sharedSseClient("/chat/events?viewer=b", recorder([]).handlers, { deps: o.deps });
    await flush();
    expect(h1.role).toBe("leader");
    expect(h2.role).toBe("leader");
    expect(o.opened.map((e) => e.url)).toEqual(["/chat/events?viewer=a", "/chat/events?viewer=b"]);
  });

  for (const missing of ["locks", "channel"] as const) {
    test(`without ${missing === "locks" ? "Web Locks" : "BroadcastChannel"} every tab opens its own stream, as sseClient`, async () => {
      const o = origin({ [missing]: false });
      const a = recorder(["stats"]);
      const ha = sharedSseClient(URL, a.handlers, { ...OPTS, deps: o.deps });
      const hb = sharedSseClient(URL, recorder([]).handlers, { ...OPTS, deps: o.deps });
      expect(o.opened.length).toBe(2);
      expect(ha.role).toBe("solo");
      expect(ha.source).toBe(o.opened[0] as unknown as EventSource);
      o.opened[0]!.open();
      o.opened[0]!.emit("stats", "s");
      expect(a.log).toEqual(["open", "stats:s"]);
      expect(ha.readyState).toBe(1);
      ha.close();
      expect(ha.readyState).toBe(2);
      expect(hb.readyState).toBe(0);
    });
  }
});
