import { describe, expect, test } from "bun:test";
import {
  defaultPlanLedgerDeps,
  fetchPlanLedger,
  ledgerWarnKey,
  type PlanLedgerDeps,
} from "./ledger.ts";

function deps(fetchPlans: PlanLedgerDeps["fetchPlans"]): PlanLedgerDeps {
  return { fetchPlans, urlConfigured: true, baseUrl: "http://127.0.0.1:8787" };
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
    expect(res.urlConfigured).toBe(true);
  });

  test("a non-object body reads as a wrong service on the port", async () => {
    const res = await fetchPlanLedger(deps(async () => [] as never));
    expect(res.reachable).toBe(false);
    expect(res.errors!.join()).toContain("not a JSON object");
    // Which host answered wrong is the operator's first question.
    expect(res.errors!.join()).toContain("http://127.0.0.1:8787");
  });

  test("a payload with no plans array is degraded, not an empty board", async () => {
    const res = await fetchPlanLedger(deps(async () => ({ generatedAt: "x" })));
    expect(res.reachable).toBe(false);
    expect(res.errors!.join()).toContain("no `plans` array");
    expect(res.errors!.join()).toContain("http://127.0.0.1:8787");
    // A rejected payload has no build instant either — carrying `generatedAt`
    // out of a body we refused to read would date the board off a lie.
    expect(res.generatedAt).toBeNull();
  });

  test("upstream's own refreshError is surfaced, not swallowed by a 200", async () => {
    // claude-usage answers 200 + `plans: []` + `refreshError` when its rollup
    // threw: without reading the field, a ledger failing every tick renders as
    // a healthy, empty board.
    const res = await fetchPlanLedger(
      deps(async () => ({
        generatedAt: "2026-08-17T10:00:00Z",
        refreshedAt: "2026-08-17T04:00:00Z",
        refreshError: "ENOENT reading plandir",
        configured: true,
        plans: [],
      })),
    );
    expect(res.reachable).toBe(true);
    expect(res.refreshedAt).toBe("2026-08-17T04:00:00Z");
    expect(res.errors!.join()).toContain("last rebuild failed");
    expect(res.errors!.join()).toContain("ENOENT reading plandir");
  });

  test("upstream's `configured` is a different question from muninn's URL", async () => {
    const off = await fetchPlanLedger(deps(async () => ({ configured: false, plans: [] })));
    expect(off.urlConfigured).toBe(true); // muninn HAS a URL…
    expect(off.ledgerConfigured).toBe(false); // …the service just has no planDir
    expect(off.errors!.join()).toContain("no plans directory");

    const on = await fetchPlanLedger(deps(async () => ({ configured: true, plans: [] })));
    expect(on.ledgerConfigured).toBe(true);
    expect(on.errors).toBeUndefined();

    const silent = await fetchPlanLedger(deps(async () => ({ plans: [] })));
    expect(silent.ledgerConfigured).toBeNull();
    expect(silent.errors).toBeUndefined();
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

describe("ledgerWarnKey", () => {
  test("collapses the per-call row count so warn-once actually fires once", () => {
    // The count varies with every poll; keying the warn on the whole message
    // makes "warn once" mean "warn on every new count".
    const a = ledgerWarnKey("claude-usage plans: 3 row(s) carried no slug — dropped");
    const b = ledgerWarnKey("claude-usage plans: 41 row(s) carried no slug — dropped");
    expect(a).toBe(b);
    expect(a).not.toContain("3");
    expect(ledgerWarnKey("claude-usage plans: HTTP 503 for x")).toContain("503");
  });

  test("collapses the refreshedAt tail and any counter inside a rebuild failure", () => {
    // Upstream's refreshError is its OWN message: it carries whatever varies per
    // tick (a retry counter, a pid, a duration), and the tail we append carries
    // the refresh timestamp. Neither is a new condition to warn about.
    const a = ledgerWarnKey(
      "claude-usage plans: the ledger's last rebuild failed: git pull timed out (attempt 41) (rows are from 2026-08-17T09:00:00.000Z)",
    );
    const b = ledgerWarnKey(
      "claude-usage plans: the ledger's last rebuild failed: git pull timed out (attempt 42) (rows are from 2026-08-17T09:05:00.000Z)",
    );
    expect(a).toBe(b);
    // …but a DIFFERENT root cause is still a different condition.
    expect(a).not.toBe(
      ledgerWarnKey(
        "claude-usage plans: the ledger's last rebuild failed: ENOENT reading plandir (rows are from 2026-08-17T09:00:00.000Z)",
      ),
    );
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
      // Naming the URL is not enough — the message has to say WHY, or a byte
      // cap is indistinguishable from a refused connection.
      expect(capped.errors!.join()).toContain("cap");
    } finally {
      server.stop(true);
    }
  });

  test("a hanging claude-usage aborts on the budget instead of hanging the board", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const d = defaultPlanLedgerDeps(`http://127.0.0.1:${server.port}`, true, 120);
      const started = Date.now();
      const res = await fetchPlanLedger(d);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(res.reachable).toBe(false);
      // Failing fast is not the claim; failing fast BECAUSE the budget fired is.
      expect(res.errors![0]!.toLowerCase()).toContain("timed out");
      expect(res.errors![0]).toContain("/api/plans");
    } finally {
      server.stop(true);
    }
  });

  test("a chunked body with NO content-length is bounded by the read itself", async () => {
    // The declared length is the cheap check, not the guarantee: the service
    // behind this endpoint is a 145 MB sqlite and chunks declare no length.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode("x".repeat(100)));
              c.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    try {
      const d = defaultPlanLedgerDeps(`http://127.0.0.1:${server.port}`, true, 5_000, 100);
      const res = await fetchPlanLedger(d);
      expect(res.reachable).toBe(false);
      expect(res.errors!.join()).toContain("cap");
      expect(res.errors!.join()).toContain("/api/plans");
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
