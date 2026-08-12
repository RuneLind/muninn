/**
 * Assembler tests for the claude-usage ledger card. Four degrade paths matter as
 * much as the happy one — ok / timeout / non-200 / malformed JSON — because the
 * card's whole contract is "never 5xx, always honest about what it could not
 * read".
 *
 * The timeout and non-200 cases are driven through the REAL `defaultClaudeUsageDeps`
 * against a live `Bun.serve`, not a fabricated rejection: the thing under test is
 * that the fetch is actually bounded, which a hand-rolled `Promise.reject` would
 * pass whether or not the `AbortSignal.timeout` is wired.
 */

import { test, expect, describe } from "bun:test";
import {
  assembleClaudeUsageOverview,
  buildRows,
  clampDays,
  defaultClaudeUsageDeps,
  formatAge,
  lenOf,
  CLAUDE_USAGE_DEFAULT_DAYS,
  type ClaudeUsageDeps,
  type ClaudeUsageRow,
  type PipelinePayload,
} from "./claude-usage-overview.ts";

const NOW = Date.parse("2026-08-12T23:00:00.000Z");

/** A payload shaped like the real `/api/pipeline` response (fields the card reads). */
function payload(over: Partial<PipelinePayload> = {}): PipelinePayload {
  return {
    generatedAt: "2026-08-12T22:27:08.339Z",
    since: "2026-07-29T22:27:08.211Z",
    precisionBarMet: true,
    markersVersion: { events: 5, runs: 5, current: 5 },
    compliance: {
      merges: 130,
      landed: 128,
      merged: 128,
      mergeUnconfirmed: 1,
      reviewed: 123,
      unreviewed: 2,
      silentUnreviewed: 2,
      reviewFloorStated: 42,
      reviewFloorSkipped: 5,
      splitCheckStated: 52,
      sessionsPast2ndPR: 30,
      sessionsWithSplitCheck: 18,
      campaignLanded: 87,
      campaignGateStated: 3,
    },
    campaigns: new Array(31).fill({}),
    merges: new Array(130).fill({}),
    ...over,
  };
}

function deps(fetchPipeline: ClaudeUsageDeps["fetchPipeline"], configured = true): ClaudeUsageDeps {
  return { fetchPipeline, configured };
}

function row(rows: ClaudeUsageRow[], label: string) {
  return rows.find((r) => r.label === label);
}

describe("clampDays", () => {
  test("defaults, clamps and rejects garbage", () => {
    expect(clampDays(undefined)).toBe(CLAUDE_USAGE_DEFAULT_DAYS);
    expect(clampDays("")).toBe(CLAUDE_USAGE_DEFAULT_DAYS);
    expect(clampDays("abc")).toBe(CLAUDE_USAGE_DEFAULT_DAYS);
    expect(clampDays("7")).toBe(7);
    expect(clampDays("0")).toBe(1);
    expect(clampDays("-5")).toBe(1);
    expect(clampDays("900")).toBe(90);
  });
});

describe("formatAge / lenOf", () => {
  test("age buckets", () => {
    expect(formatAge(null, NOW)).toBeNull();
    expect(formatAge(NOW - 30_000, NOW)).toBe("just now");
    expect(formatAge(NOW - 12 * 60_000, NOW)).toBe("12m ago");
    expect(formatAge(NOW - 3 * 3600_000, NOW)).toBe("3h ago");
    expect(formatAge(NOW - 50 * 3600_000, NOW)).toBe("2d ago");
  });

  test("an absent array is null, not 0 — absent is not empty", () => {
    expect(lenOf(undefined)).toBeNull();
    expect(lenOf(null)).toBeNull();
    expect(lenOf([])).toBe(0);
    expect(lenOf([1, 2])).toBe(2);
  });
});

describe("buildRows", () => {
  test("summarizes the live payload shape", () => {
    const rows = buildRows(payload(), 14, NOW);
    expect(rows.map((r) => r.label)).toEqual([
      "Window",
      "Merges",
      "Reviewed",
      "Split checks",
      "Campaigns",
      "Precision bar",
    ]);
    expect(row(rows, "Window")!.value).toBe("14d");
    expect(row(rows, "Window")!.note).toContain("since 2026-07-29");
    expect(row(rows, "Window")!.note).toContain("ledger built 32m ago");
    expect(row(rows, "Merges")!.value).toBe("130");
    expect(row(rows, "Merges")!.note).toBe("128 landed · 1 unconfirmed");
    expect(row(rows, "Reviewed")!.value).toBe("123 / 130");
    expect(row(rows, "Reviewed")!.tone).toBe("warning"); // 2 unreviewed
    expect(row(rows, "Split checks")!.value).toBe("18 / 30");
    expect(row(rows, "Campaigns")!.value).toBe("31");
    expect(row(rows, "Campaigns")!.note).toContain("87 campaign merges");
    expect(row(rows, "Precision bar")!.value).toBe("met");
    expect(row(rows, "Precision bar")!.tone).toBe("success");
  });

  test("a clean ledger carries no warning tone", () => {
    const rows = buildRows(
      payload({ compliance: { ...payload().compliance, unreviewed: 0, silentUnreviewed: 0 } }),
      14,
      NOW,
    );
    expect(row(rows, "Reviewed")!.tone).toBeUndefined();
  });

  test("a failed precision bar is an error row, not a footnote", () => {
    const rows = buildRows(payload({ precisionBarMet: false }), 14, NOW);
    expect(row(rows, "Precision bar")!.value).toBe("NOT met");
    expect(row(rows, "Precision bar")!.tone).toBe("error");
    expect(row(rows, "Precision bar")!.note).toContain("provisional");
  });

  test("missing counters render — , never a fabricated 0", () => {
    const rows = buildRows({ campaigns: [], merges: [] }, 30, NOW);
    expect(row(rows, "Merges")!.value).toBe("0");
    expect(row(rows, "Merges")!.note).toBe("— landed · — unconfirmed");
    expect(row(rows, "Reviewed")!.value).toBe("— / 0");
    expect(row(rows, "Reviewed")!.tone).toBeUndefined();
    expect(row(rows, "Precision bar")!.value).toBe("—");
    expect(row(rows, "Window")!.note).toContain("ledger build time unknown");
  });
});

describe("assembleClaudeUsageOverview", () => {
  test("ok — rows built, no errors", async () => {
    const out = await assembleClaudeUsageOverview(deps(async () => payload()), 14, NOW);
    expect(out.reachable).toBe(true);
    expect(out.errors).toBeUndefined();
    expect(out.days).toBe(14);
    expect(out.configured).toBe(true);
    expect(out.rows).toHaveLength(6);
    expect(out.ledgerGeneratedAt).toBe(Date.parse("2026-08-12T22:27:08.339Z"));
    expect(out.assembledAt).toBe(NOW);
  });

  test("the requested window reaches the fetch", async () => {
    let seen = 0;
    await assembleClaudeUsageOverview(deps(async (d) => { seen = d; return payload(); }), 90, NOW);
    expect(seen).toBe(90);
  });

  test("a rejecting fetch degrades — never throws, never 5xx", async () => {
    const out = await assembleClaudeUsageOverview(
      deps(async () => { throw new Error("The operation timed out."); }),
      14,
      NOW,
    );
    expect(out.reachable).toBe(false);
    expect(out.rows).toEqual([]);
    expect(out.ledgerGeneratedAt).toBeNull();
    expect(out.errors?.[0]).toContain("timed out");
  });

  test("a non-object JSON body is a wrong service on the port, not an empty ledger", async () => {
    for (const bad of [null, [1, 2, 3], "hello" as unknown]) {
      const out = await assembleClaudeUsageOverview(
        deps(async () => bad as PipelinePayload),
        14,
        NOW,
      );
      expect(out.reachable).toBe(false);
      expect(out.errors?.[0]).toContain("not a JSON object");
    }
  });

  test("configured=false rides through so the card can hide itself", async () => {
    const out = await assembleClaudeUsageOverview(
      deps(async () => { throw new Error("connection refused"); }, false),
      14,
      NOW,
    );
    expect(out.configured).toBe(false);
    expect(out.reachable).toBe(false);
  });
});

describe("defaultClaudeUsageDeps (real fetch)", () => {
  test("happy path parses the payload and hits /api/pipeline?days=", async () => {
    let path = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        path = new URL(req.url).pathname + new URL(req.url).search;
        return Response.json(payload());
      },
    });
    try {
      const d = defaultClaudeUsageDeps(`http://127.0.0.1:${server.port}/`, true);
      const out = await assembleClaudeUsageOverview(d, 14, NOW);
      expect(path).toBe("/api/pipeline?days=14");
      expect(out.reachable).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("non-200 degrades with the status in the message", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) });
    try {
      const d = defaultClaudeUsageDeps(`http://127.0.0.1:${server.port}`, true);
      const out = await assembleClaudeUsageOverview(d, 14, NOW);
      expect(out.reachable).toBe(false);
      expect(out.errors?.[0]).toContain("HTTP 503");
    } finally {
      server.stop(true);
    }
  });

  test("malformed JSON degrades rather than throwing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("<html>not json</html>", {
        headers: { "content-type": "application/json" },
      }),
    });
    try {
      const d = defaultClaudeUsageDeps(`http://127.0.0.1:${server.port}`, true);
      const out = await assembleClaudeUsageOverview(d, 14, NOW);
      expect(out.reachable).toBe(false);
      expect(out.errors?.length).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("a hanging claude-usage aborts on the budget instead of hanging the card", async () => {
    // Never responds — an unbounded fetch would hang this test to the runner's
    // own timeout, which is exactly the production failure being guarded.
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const d = defaultClaudeUsageDeps(`http://127.0.0.1:${server.port}`, true, 120);
      const started = Date.now();
      const out = await assembleClaudeUsageOverview(d, 14, NOW);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(out.reachable).toBe(false);
      expect(out.errors?.length).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
