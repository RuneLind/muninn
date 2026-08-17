import { describe, expect, test } from "bun:test";
import { defaultPlanLedgerDeps, fetchPlanLedger, type PlanLedgerDeps } from "./ledger.ts";

function deps(fetchPlans: PlanLedgerDeps["fetchPlans"]): PlanLedgerDeps {
  return { fetchPlans, configured: true, baseUrl: "http://127.0.0.1:8787" };
}

describe("fetchPlanLedger", () => {
  test("shapes a healthy payload", async () => {
    const res = await fetchPlanLedger(
      deps(async () => ({
        generatedAt: "2026-08-17T10:00:00Z",
        plans: [{ slug: "a", costUSD: 1 }, { slug: "b" }],
      })),
      1000,
    );
    expect(res.reachable).toBe(true);
    expect(res.fetchedAt).toBe(1000);
    expect(res.generatedAt).toBe("2026-08-17T10:00:00Z");
    expect(res.plans.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(res.errors).toBeUndefined();
  });

  test("an unreachable service is a board state, never a throw", async () => {
    const res = await fetchPlanLedger(
      deps(async () => {
        throw new Error("connection refused (http://127.0.0.1:8787/api/plans)");
      }),
    );
    expect(res.reachable).toBe(false);
    expect(res.plans).toEqual([]);
    expect(res.errors![0]).toContain("connection refused");
    // The board must be able to NAME what it tried.
    expect(res.baseUrl).toBe("http://127.0.0.1:8787");
    expect(res.configured).toBe(true);
  });

  test("a non-object body reads as a wrong service on the port", async () => {
    const res = await fetchPlanLedger(deps(async () => [] as never));
    expect(res.reachable).toBe(false);
    expect(res.errors!.join()).toContain("not a JSON object");
  });

  test("a payload with no plans array is degraded, not an empty board", async () => {
    const res = await fetchPlanLedger(deps(async () => ({ generatedAt: "x" })));
    expect(res.reachable).toBe(false);
    expect(res.errors!.join()).toContain("no `plans` array");
  });

  test("rows without a slug are dropped and counted", async () => {
    const res = await fetchPlanLedger(
      deps(async () => ({ plans: [{ slug: "a" }, { title: "no slug" }, null, 7] })),
    );
    expect(res.reachable).toBe(true);
    expect(res.plans.map((p) => p.slug)).toEqual(["a"]);
    expect(res.errors!.join()).toContain("3 row(s) carried no slug");
  });
});

describe("defaultPlanLedgerDeps", () => {
  test("hits /api/plans on the trimmed base URL, bounded in bytes", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/api/plans"
          ? Response.json({ generatedAt: "t", plans: [{ slug: "s" }] })
          : new Response("nope", { status: 404 }),
    });
    try {
      const d = defaultPlanLedgerDeps(`http://127.0.0.1:${server.port}/`, true);
      expect(d.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
      const res = await fetchPlanLedger(d);
      expect(res.reachable).toBe(true);
      expect(res.plans.map((p) => p.slug)).toEqual(["s"]);

      // Same socket, byte cap of 1 — the bounded read must reject, and the
      // failure must still name the URL.
      const tiny = defaultPlanLedgerDeps(`http://127.0.0.1:${server.port}`, true, 5000, 1);
      const capped = await fetchPlanLedger(tiny);
      expect(capped.reachable).toBe(false);
      expect(capped.errors!.join()).toContain("/api/plans");
    } finally {
      server.stop(true);
    }
  });

  test("a non-200 names the status and the URL", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("gone", { status: 503 }) });
    try {
      const res = await fetchPlanLedger(defaultPlanLedgerDeps(`http://127.0.0.1:${server.port}`, true));
      expect(res.reachable).toBe(false);
      expect(res.errors!.join()).toContain("HTTP 503");
      expect(res.errors!.join()).toContain("/api/plans");
    } finally {
      server.stop(true);
    }
  });

  test("a non-JSON body is a degraded source, not an empty ledger", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("<html>hi</html>") });
    try {
      const res = await fetchPlanLedger(defaultPlanLedgerDeps(`http://127.0.0.1:${server.port}`, true));
      expect(res.reachable).toBe(false);
      expect(res.errors!.join()).toContain("/api/plans");
    } finally {
      server.stop(true);
    }
  });
});
