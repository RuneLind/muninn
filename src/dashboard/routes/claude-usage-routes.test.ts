/**
 * Route-shape test for `GET /api/claude-usage/overview`. The assembly itself is
 * covered in `claude-usage-overview.test.ts`; this pins the HTTP contract — the
 * `?days=` clamp reaching the fetch, and the never-5xx rule on a dead upstream.
 */

import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { registerClaudeUsageRoutes } from "./claude-usage-routes.ts";
import {
  CLAUDE_USAGE_DEFAULT_URL,
  type ClaudeUsageDeps,
  type PipelinePayload,
} from "../claude-usage-overview.ts";
import type { Config } from "../../config.ts";

const CONFIG = { claudeUsageUrl: "http://127.0.0.1:1" } as Config;

const PAYLOAD: PipelinePayload = {
  generatedAt: "2026-08-12T22:27:08.339Z",
  since: "2026-07-29T22:27:08.211Z",
  precisionBarMet: true,
  markersVersion: { current: 5 },
  compliance: { merges: 130, landed: 128, reviewed: 123, unreviewed: 0 },
  campaigns: [{}, {}],
  merges: new Array(130).fill({}),
};

function app(deps: ClaudeUsageDeps): Hono {
  const a = new Hono();
  registerClaudeUsageRoutes(a, CONFIG, deps);
  return a;
}

describe("claude-usage routes", () => {
  test("serves the assembled overview", async () => {
    const a = app({ configured: true, baseUrl: "http://127.0.0.1:1", fetchPipeline: async () => PAYLOAD });
    const res = await a.request("/api/claude-usage/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reachable).toBe(true);
    expect(body.days).toBe(14);
    expect(body.baseUrl).toBe("http://127.0.0.1:1");
    expect(body.rows.find((r: { label: string }) => r.label === "Merges").value).toBe("130");
    expect(body.errors).toBeUndefined();
  });

  test("an unset CLAUDE_USAGE_URL takes the feature default and reports NOT configured", async () => {
    // `configured` is derived here from the one nullable config read, so the two
    // can never disagree the way a defaulted-string + boolean pair could.
    const a = new Hono();
    registerClaudeUsageRoutes(a, { claudeUsageUrl: null } as Config);
    const res = await a.request("/api/claude-usage/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(false);
    expect(body.baseUrl).toBe(CLAUDE_USAGE_DEFAULT_URL);
  });

  test("a set CLAUDE_USAGE_URL is reported configured, trailing slash stripped once", async () => {
    const a = new Hono();
    // Port 1 refuses instantly — this test is about the derivation, and the real
    // fetch behind it must not spend the budget on an unroutable host.
    registerClaudeUsageRoutes(a, { claudeUsageUrl: "http://127.0.0.1:1/" } as Config);
    const body = await (await a.request("/api/claude-usage/overview")).json();
    expect(body.configured).toBe(true);
    expect(body.baseUrl).toBe("http://127.0.0.1:1");
  });

  test("?days= is clamped to claude-usage's own range before the fetch", async () => {
    const seen: number[] = [];
    const deps: ClaudeUsageDeps = {
      configured: true,
      baseUrl: "http://127.0.0.1:1",
      fetchPipeline: async (d) => { seen.push(d); return PAYLOAD; },
    };
    const a = app(deps);
    // The last three are the upstream-parity cases: `1e2` is 100 (⇒ 90), `7.9`
    // rounds to 8, `12abc` is not a number at all (⇒ the default).
    for (const q of ["7", "900", "0", "junk", "1e2", "7.9", "12abc"]) {
      const res = await a.request(`/api/claude-usage/overview?days=${q}`);
      expect(res.status).toBe(200);
    }
    expect(seen).toEqual([7, 90, 1, 14, 90, 8, 14]);
  });

  test("a dead claude-usage is 200 + errors[], never a 5xx", async () => {
    const a = app({
      configured: true,
      baseUrl: "http://127.0.0.1:1",
      fetchPipeline: async () => { throw new Error("Unable to connect"); },
    });
    const res = await a.request("/api/claude-usage/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reachable).toBe(false);
    expect(body.configured).toBe(true);
    expect(body.rows).toEqual([]);
    expect(body.errors[0]).toContain("Unable to connect");
  });
});
