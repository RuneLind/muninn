/**
 * The two Knowledge API fetchers, over a REAL socket.
 *
 * They share their whole request half now (`fetchKnowledgeApiRes`: the
 * AbortController timeout, the optional method/body/headers, the 502/503
 * mapping) and differ in one line — `.json()` against `.text()`. That line is
 * the contract the capture re-run rests on: huginn's `?raw=1` answers with the
 * bytes on disk, and parsing them would hand the re-run a cleaned copy that
 * shrinks the document on every pass.
 *
 * A `Bun.serve` fake rather than a stubbed `globalThis.fetch`, the
 * `openai-compat-request.test.ts` idiom: what is under test is a fetch wrapper,
 * so replacing fetch tests the mock.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { fetchKnowledgeApi, fetchKnowledgeApiText, KnowledgeApiError } from "./knowledge-api-client.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
let base = "";
/** Every request the fake saw, so the method/body/header pass-through is visible. */
const seen: Array<{ path: string; method: string; body: string; auth: string | null }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        method: req.method,
        body: await req.text(),
        auth: req.headers.get("x-probe"),
      });
      if (url.pathname === "/json") {
        return Response.json({ documents: [{ id: "a" }] });
      }
      if (url.pathname === "/raw") {
        return new Response("---\ndate: \"2026-09-01\"\n---\n\nBody.\n", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }
      if (url.pathname === "/notjson") {
        return new Response("this is not JSON", { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/slow") {
        await Bun.sleep(200);
        return new Response("late");
      }
      if (url.pathname === "/gone") return new Response("nope", { status: 404 });
      if (url.pathname === "/broken") return new Response("nope", { status: 500 });
      return new Response("unexpected", { status: 418 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

describe("fetchKnowledgeApiText", () => {
  test("answers the BYTES, unparsed — the whole reason it is not the JSON twin", async () => {
    const raw = await fetchKnowledgeApiText(base, "/raw");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain('date: "2026-09-01"');
  });

  test("a body that is not JSON is returned as it is, where the twin would throw", async () => {
    expect(await fetchKnowledgeApiText(base, "/notjson")).toBe("this is not JSON");
    await expect(fetchKnowledgeApi(base, "/notjson")).rejects.toThrow(KnowledgeApiError);
  });
});

describe("fetchKnowledgeApi", () => {
  test("answers parsed JSON", async () => {
    const data = (await fetchKnowledgeApi(base, "/json")) as { documents: Array<{ id: string }> };
    expect(data.documents[0]!.id).toBe("a");
  });
});

describe("the request half both share", () => {
  test("an upstream error is 502 and carries the upstream status; both fetchers agree", async () => {
    for (const call of [fetchKnowledgeApi, fetchKnowledgeApiText]) {
      const err = await call(base, "/gone").then(
        () => null,
        (e: unknown) => e as KnowledgeApiError,
      );
      expect(err).toBeInstanceOf(KnowledgeApiError);
      expect([err!.statusCode, err!.upstreamStatus]).toEqual([502, 404]);
    }
    const broken = await fetchKnowledgeApiText(base, "/broken").then(
      () => null,
      (e: unknown) => e as KnowledgeApiError,
    );
    expect([broken!.statusCode, broken!.upstreamStatus]).toEqual([502, 500]);
  });

  test("an unreachable host is 503 with no upstream status; both fetchers agree", async () => {
    for (const call of [fetchKnowledgeApi, fetchKnowledgeApiText]) {
      // Port 1 on loopback: nothing listens, so this is a transport failure and
      // not an HTTP answer.
      const err = await call("http://127.0.0.1:1", "/json").then(
        () => null,
        (e: unknown) => e as KnowledgeApiError,
      );
      expect(err!.statusCode).toBe(503);
      expect(err!.upstreamStatus).toBeUndefined();
    }
  });

  test("the timeout aborts and reports 503; both fetchers agree", async () => {
    for (const call of [fetchKnowledgeApi, fetchKnowledgeApiText]) {
      const err = await call(base, "/slow", { timeoutMs: 20 }).then(
        () => null,
        (e: unknown) => e as KnowledgeApiError,
      );
      expect(err!.statusCode).toBe(503);
    }
  });

  test("method, body and headers are passed through by both", async () => {
    seen.length = 0;
    await fetchKnowledgeApi(base, "/json", {
      method: "POST",
      body: '{"a":1}',
      headers: { "x-probe": "json" },
    });
    await fetchKnowledgeApiText(base, "/raw", {
      method: "POST",
      body: '{"a":2}',
      headers: { "x-probe": "text" },
    });
    expect(seen.map((r) => [r.path, r.method, r.body, r.auth])).toEqual([
      ["/json", "POST", '{"a":1}', "json"],
      ["/raw", "POST", '{"a":2}', "text"],
    ]);
  });
});
