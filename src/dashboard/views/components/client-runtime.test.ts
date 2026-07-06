import { test, expect, mock } from "bun:test";
import { sseClient, getJson, HttpError } from "./client-runtime.ts";

// --- Fake EventSource -------------------------------------------------------

class FakeEventSource {
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  listeners: Record<string, EventListener[]> = {};
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(name: string, fn: EventListener): void {
    (this.listeners[name] ??= []).push(fn);
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: dispatch a named event with a JSON string payload. */
  emit(name: string, data?: unknown): void {
    const ev = { data: data === undefined ? undefined : JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners[name] ?? []) fn(ev as unknown as Event);
  }
}

function withFakeEventSource<T>(run: () => T): { instances: FakeEventSource[]; result: T } {
  const instances: FakeEventSource[] = [];
  const orig = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = class extends FakeEventSource {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  };
  try {
    return { instances, result: run() };
  } finally {
    (globalThis as { EventSource?: unknown }).EventSource = orig;
  }
}

// --- sseClient --------------------------------------------------------------

test("sseClient opens the URL and wires named-event handlers", () => {
  const seen: unknown[] = [];
  const { instances } = withFakeEventSource(() => {
    sseClient("/api/stream/1", {
      status: (e: MessageEvent) => seen.push(["status", JSON.parse(e.data)]),
      delta: (e: MessageEvent) => seen.push(["delta", JSON.parse(e.data)]),
    });
  });
  expect(instances).toHaveLength(1);
  expect(instances[0]!.url).toBe("/api/stream/1");

  instances[0]!.emit("status", { status: "running" });
  instances[0]!.emit("delta", { text: "hi" });
  expect(seen).toEqual([
    ["status", { status: "running" }],
    ["delta", { text: "hi" }],
  ]);
});

test("sseClient maps onopen/onerror to the native callbacks, not addEventListener", () => {
  const onopen = mock(() => {});
  const onerror = mock(() => {});
  const { instances } = withFakeEventSource(() => {
    sseClient("/x", { onopen, onerror });
  });
  const es = instances[0]!;
  expect(es.onopen).toBe(onopen);
  expect(es.onerror).toBe(onerror);
  // Not registered as named listeners.
  expect(es.listeners.onopen).toBeUndefined();
  expect(es.listeners.onerror).toBeUndefined();
});

test("sseClient handle exposes the source and closes it", () => {
  const { instances, result } = withFakeEventSource(() =>
    sseClient("/x", { done: () => {} }),
  );
  expect(result.source).toBe(instances[0] as unknown as EventSource);
  expect(instances[0]!.closed).toBe(false);
  result.close();
  expect(instances[0]!.closed).toBe(true);
});

test("sseClient ignores non-function handler entries", () => {
  const { instances } = withFakeEventSource(() => {
    sseClient("/x", { skip: undefined, real: () => {} });
  });
  expect(instances[0]!.listeners.skip).toBeUndefined();
  expect(instances[0]!.listeners.real).toHaveLength(1);
});

// --- getJson ----------------------------------------------------------------

function withFakeFetch<T>(impl: (url: string, opts?: RequestInit) => Response, run: () => T): T {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, opts?: RequestInit) => impl(url, opts)) as typeof fetch;
  try {
    return run();
  } finally {
    globalThis.fetch = orig;
  }
}

test("getJson returns parsed JSON on a 200", async () => {
  const promise = withFakeFetch(
    () => new Response(JSON.stringify({ ok: true, n: 3 }), { status: 200 }),
    () => getJson<{ ok: boolean; n: number }>("/api/thing"),
  );
  expect(await promise).toEqual({ ok: true, n: 3 });
});

test("getJson throws HttpError carrying status + parsed body on non-2xx", async () => {
  const promise = withFakeFetch(
    () => new Response(JSON.stringify({ error: "nope" }), { status: 409 }),
    () => getJson("/api/thing"),
  );
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpError);
  const e = caught as HttpError;
  expect(e.status).toBe(409);
  expect(e.body).toEqual({ error: "nope" });
  expect(e.message).toBe("HTTP 409");
});

test("getJson leaves body undefined when the error response is not JSON", async () => {
  const promise = withFakeFetch(
    () => new Response("plain text boom", { status: 500 }),
    () => getJson("/api/thing"),
  );
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(500);
  expect((caught as HttpError).body).toBeUndefined();
});

test("getJson forwards fetch options", async () => {
  let seenOpts: RequestInit | undefined;
  const promise = withFakeFetch(
    (_url, opts) => {
      seenOpts = opts;
      return new Response(JSON.stringify({}), { status: 200 });
    },
    () => getJson("/api/thing", { method: "POST" }),
  );
  await promise;
  expect(seenOpts).toEqual({ method: "POST" });
});
