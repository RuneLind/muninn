/**
 * Route-shape test for `GET /api/claude-usage/overview`. The assembly itself is
 * covered in `claude-usage-overview.test.ts`; this pins the HTTP contract — the
 * `?days=` clamp reaching the fetch, and the never-5xx rule on a dead upstream.
 */

import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { registerClaudeUsageRoutes } from "./claude-usage-routes.ts";
import type { ClaudeUsageDeps, PipelinePayload } from "../claude-usage-overview.ts";
import type { Config } from "../../config.ts";

const CONFIG = {
  claudeUsageUrl: "http://127.0.0.1:1",
  claudeUsageConfigured: true,
} as Config;

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
    const a = app({ configured: true, fetchPipeline: async () => PAYLOAD });
    const res = await a.request("/api/claude-usage/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reachable).toBe(true);
    expect(body.days).toBe(14);
    expect(body.rows.find((r: { label: string }) => r.label === "Merges").value).toBe("130");
    expect(body.errors).toBeUndefined();
  });

  test("?days= is clamped to claude-usage's own range before the fetch", async () => {
    const seen: number[] = [];
    const deps: ClaudeUsageDeps = {
      configured: true,
      fetchPipeline: async (d) => { seen.push(d); return PAYLOAD; },
    };
    const a = app(deps);
    for (const q of ["7", "900", "0", "junk"]) {
      const res = await a.request(`/api/claude-usage/overview?days=${q}`);
      expect(res.status).toBe(200);
    }
    expect(seen).toEqual([7, 90, 1, 14]);
  });

  test("a dead claude-usage is 200 + errors[], never a 5xx", async () => {
    const a = app({
      configured: true,
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
