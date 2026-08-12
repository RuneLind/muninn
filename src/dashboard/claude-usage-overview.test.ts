/**
 * Assembler tests for the claude-usage ledger card. Four degrade paths matter as
 * much as the happy one — ok / timeout / non-200 / malformed JSON — because the
 * card's whole contract is "never 5xx, always honest about what it could not
 * read".
 *
 * The timeout, non-200 and over-cap cases are driven through the REAL
 * `defaultClaudeUsageDeps` against a live `Bun.serve`, not a fabricated
 * rejection: the thing under test is that the fetch is actually bounded, which a
 * hand-rolled `Promise.reject` would pass whether or not the `AbortSignal.timeout`
 * and the byte cap are wired.
 *
 * The compliance fixtures are the REAL 90-day numbers measured against the live
 * service on 2026-08-13 (`curl 127.0.0.1:8787/api/pipeline?days=90`), because the
 * two bugs this file now pins are arithmetic ones that only a self-consistent
 * payload can express: 418 reviewed of 654 LANDED (not of 732 merges — the
 * rendered "418 / 732" beside "232 unreviewed" was an impossible pair), and
 * 654 + 37 + 41 = 732 (the merges total accounted for by its own note).
 */

import { test, expect, describe } from "bun:test";
import {
  assembleClaudeUsageOverview,
  buildRows,
  clampDays,
  defaultClaudeUsageDeps,
  lenOf,
  CLAUDE_USAGE_DEFAULT_DAYS,
  type ClaudeUsageDeps,
  type ClaudeUsageRow,
  type PipelineCompliance,
  type PipelinePayload,
} from "./claude-usage-overview.ts";

const NOW = Date.parse("2026-08-12T23:00:00.000Z");
const BASE = "http://127.0.0.1:8787";

/** The live 90-day compliance block, verbatim. */
const LIVE_90: PipelineCompliance = {
  merges: 732,
  landed: 654,
  mergeUnconfirmed: 37,
  composedUnconfirmed: 41,
  reviewFloorStated: 47,
  reviewFloorSkipped: 6,
  reviewed: 418,
  unreviewed: 232,
  silentUnreviewed: 228,
  sessionsPast2ndPR: 149,
  sessionsWithSplitCheck: 30,
  campaignLanded: 297,
  campaignGateStated: 3,
};

/** A payload shaped like the real `/api/pipeline` response (fields the card reads). */
function payload(over: Partial<PipelinePayload> = {}): PipelinePayload {
  return {
    generatedAt: "2026-08-12T22:27:08.339Z",
    since: "2026-07-29T22:27:08.211Z",
    precisionBarMet: true,
    preStandardization: false,
    rulesStandardizedDate: "2026-07-30",
    markersVersion: { current: 5 },
    markersVersionCaveat: null,
    confirmCaveat: null,
    compliance: {
      merges: 130,
      landed: 126,
      mergeUnconfirmed: 1,
      // Non-zero on purpose: the third state is the one the Merges row used to
      // drop, and 126 + 1 + 3 = 130 is what makes the row's note an account.
      composedUnconfirmed: 3,
      reviewed: 123,
      unreviewed: 2,
      silentUnreviewed: 2,
      reviewFloorStated: 42,
      reviewFloorSkipped: 5,
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

function deps(
  fetchPipeline: ClaudeUsageDeps["fetchPipeline"],
  configured = true,
  baseUrl = BASE,
): ClaudeUsageDeps {
  return { fetchPipeline, configured, baseUrl };
}

function row(rows: ClaudeUsageRow[], label: string) {
  return rows.find((r) => r.label === label);
}

/** Run `fn` under an explicit timezone, restoring whatever was in effect. Bun
 *  re-reads `process.env.TZ` at runtime, so this really moves local midnight. */
function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

describe("clampDays", () => {
  test("defaults, clamps and rejects garbage", () => {
    expect(clampDays(undefined)).toBe(CLAUDE_USAGE_DEFAULT_DAYS);
    expect(clampDays("")).toBe(CLAUDE_USAGE_DEFAULT_DAYS);
    expect(clampDays("   ")).toBe(CLAUDE_USAGE_DEFAULT_DAYS);
    expect(clampDays("abc")).toBe(CLAUDE_USAGE_DEFAULT_DAYS);
    expect(clampDays("7")).toBe(7);
    expect(clampDays("0")).toBe(1);
    expect(clampDays("-5")).toBe(1);
    expect(clampDays("900")).toBe(90);
  });

  test("matches upstream `clampInt` EXACTLY — Number() + Math.round, not parseInt", () => {
    // claude-usage's own `clampInt` (src/http.ts) is `Number(raw)` then
    // `Math.round`. A `parseInt` clamp answers a DIFFERENT window than the
    // service would for the same query string, which is the one thing this
    // mirror exists to prevent.
    expect(clampDays("1e2")).toBe(90); // parseInt reads "1"
    expect(clampDays("7.9")).toBe(8); // parseInt truncates to 7
    expect(clampDays("12abc")).toBe(CLAUDE_USAGE_DEFAULT_DAYS); // parseInt reads 12
    expect(clampDays("1e9")).toBe(90);
    expect(clampDays("0x5a")).toBe(90); // Number("0x5a") === 90, upstream's own semantics
    expect(clampDays(" 5 ")).toBe(5);
    expect(clampDays("Infinity")).toBe(CLAUDE_USAGE_DEFAULT_DAYS);
  });
});

describe("lenOf", () => {
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
    expect(row(rows, "Window")!.note).toContain("ledger built 32m ago");
    expect(row(rows, "Merges")!.value).toBe("130");
    expect(row(rows, "Reviewed")!.value).toBe("123 / 126");
    expect(row(rows, "Reviewed")!.tone).toBe("warning"); // 2 unreviewed
    expect(row(rows, "Split checks")!.value).toBe("18 / 30");
    expect(row(rows, "Campaigns")!.value).toBe("31");
    expect(row(rows, "Campaigns")!.note).toContain("87 campaign merges");
    expect(row(rows, "Precision bar")!.value).toBe("met");
    expect(row(rows, "Precision bar")!.tone).toBe("success");
  });

  test("the Merges note ACCOUNTS for the total — landed + both unconfirmed states", () => {
    const rows = buildRows(payload({ compliance: LIVE_90 }), 90, NOW);
    const merges = row(rows, "Merges")!;
    expect(merges.value).toBe("732");
    // 654 + 37 + 41 = 732, the live arithmetic. Before this the note named only
    // landed + mergeUnconfirmed and 41 merges were simply missing from it.
    expect(merges.note).toContain("654 landed");
    expect(merges.note).toContain("37 merged (unconfirmed)");
    expect(merges.note).toContain("41 composed (unconfirmed)");
    expect(merges.note).not.toContain("unaccounted");
  });

  test("a remainder the three states do not cover is named, never hidden", () => {
    const rows = buildRows(
      payload({ compliance: { merges: 10, landed: 5, mergeUnconfirmed: 1, composedUnconfirmed: 1 } }),
      14,
      NOW,
    );
    expect(row(rows, "Merges")!.note).toContain("+3 unaccounted");
  });

  test("the merges ARRAY is never a total — one authoritative denominator", () => {
    // The payload's `merges` array is the per-merge detail list and can be
    // truncated, filtered or absent; `compliance.merges` is the count. Rendering
    // the array length as the total made the card disagree with itself.
    const rows = buildRows(
      payload({ merges: new Array(3).fill({}), compliance: LIVE_90 }),
      90,
      NOW,
    );
    expect(row(rows, "Merges")!.value).toBe("732");
    expect(row(rows, "Reviewed")!.value).toBe("418 / 654");
  });

  test("Reviewed divides by LANDED, and its note agrees with the fraction", () => {
    // The live 90-day render said "418 / 732" beside "232 unreviewed", and
    // 732 − 418 = 314 ≠ 232. Upstream counts `reviewed` over LANDED merges only
    // (pipeline-ledger.ts: "the DENOMINATOR for every review number below it"),
    // so the denominator is 654 and 654 − 418 = 236 ≥ 232 (the 4 remaining are
    // exempt merges, not missing ones).
    const rows = buildRows(payload({ compliance: LIVE_90 }), 90, NOW);
    const reviewed = row(rows, "Reviewed")!;
    expect(reviewed.value).toBe("418 / 654");
    expect(reviewed.note).toContain("of landed merges");
    expect(reviewed.note).toContain("232 unreviewed");
    expect(reviewed.note).toContain("228 silent");

    const parts = reviewed.value.split(" / ").map(Number);
    const num = parts[0]!;
    const den = parts[1]!;
    expect(den - num).toBeGreaterThanOrEqual(LIVE_90.unreviewed!);
    // ...and the bug is expressible as a failing invariant on the old denominator.
    expect(den).not.toBe(LIVE_90.merges);
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

  test("missing counters render —, never a fabricated 0 (absent KEY, not empty array)", () => {
    // `{}` is the case that matters: an empty array at least says "zero of
    // these", an absent key says nothing at all and must not become a number.
    const rows = buildRows({}, 30, NOW);
    expect(row(rows, "Merges")!.value).toBe("—");
    expect(row(rows, "Merges")!.note).toBe("— landed · — merged (unconfirmed) · — composed (unconfirmed)");
    expect(row(rows, "Reviewed")!.value).toBe("— / —");
    expect(row(rows, "Reviewed")!.tone).toBeUndefined();
    expect(row(rows, "Campaigns")!.value).toBe("—");
    expect(row(rows, "Precision bar")!.value).toBe("—");
    expect(row(rows, "Window")!.note).toContain("ledger build time unknown");
  });

  test("an EMPTY array is 0 while an absent counter stays —", () => {
    const rows = buildRows({ campaigns: [], merges: [] }, 30, NOW);
    expect(row(rows, "Campaigns")!.value).toBe("0");
    expect(row(rows, "Merges")!.value).toBe("—"); // no compliance block ⇒ unknown
  });
});

describe("buildRows — upstream caveats", () => {
  test("preStandardization warns ON the Reviewed row, where the numbers are", () => {
    // Upstream's stated purpose for the flag: `?days=365` reported 666 "silently
    // unreviewed" merges, essentially all of them from before the rules existed.
    // At days=90 the live service sets it TRUE, and the card said nothing.
    const rows = buildRows(
      payload({ preStandardization: true, rulesStandardizedDate: "2026-07-30", compliance: LIVE_90 }),
      90,
      NOW,
    );
    const reviewed = row(rows, "Reviewed")!;
    expect(reviewed.caveat).toContain("2026-07-30");
    expect(reviewed.caveat).toMatch(/did not exist/i);
    expect(reviewed.caveatTone).toBe("warning");
  });

  test("preStandardization false renders no caveat at all", () => {
    const rows = buildRows(payload({ preStandardization: false }), 14, NOW);
    expect(row(rows, "Reviewed")!.caveat).toBeUndefined();
  });

  test("markersVersionCaveat renders beside the markers version", () => {
    const caveat = "Some rows below were extracted by an OLDER marker version (pipeline_event at v4; this code is v5).";
    const rows = buildRows(
      payload({ markersVersion: { current: 5 }, markersVersionCaveat: caveat }),
      14,
      NOW,
    );
    const bar = row(rows, "Precision bar")!;
    expect(bar.note).toContain("markers v5");
    expect(bar.caveat).toBe(caveat);
    expect(bar.caveatTone).toBe("warning");
  });

  test("confirmCaveat rides the unconfirmed counts — quietly, since it is standing", () => {
    const caveat =
      "Confirmations are read from the LOCAL checkout without fetching; a PR merged in the GitHub UI stays unconfirmed here until someone runs `git fetch`.";
    const rows = buildRows(payload({ confirmCaveat: caveat }), 14, NOW);
    const merges = row(rows, "Merges")!;
    expect(merges.caveat).toBe(caveat);
    // Not a warning: it explains what "unconfirmed" means, it does not report
    // that anything is wrong.
    expect(merges.caveatTone).toBeUndefined();
  });

  test("a caveat-free payload carries no caveat fields", () => {
    const rows = buildRows(payload(), 14, NOW);
    for (const r of rows) expect(r.caveat).toBeUndefined();
  });
});

describe("buildRows — window start is a LOCAL day", () => {
  const since = "2026-07-29T22:27:08.211Z";

  test("east of UTC the local day is the NEXT one", () => {
    // Measured at 00:41 CEST: the card said the window started a day early,
    // because the instant was sliced off `toISOString()`.
    const rows = withTz("Pacific/Kiritimati", () => buildRows(payload({ since }), 90, NOW));
    expect(rows[0]!.note).toContain("since 2026-07-30");
  });

  test("...and under UTC it is the UTC day, so the test pins LOCAL, not an offset", () => {
    const rows = withTz("UTC", () => buildRows(payload({ since }), 90, NOW));
    expect(rows[0]!.note).toContain("since 2026-07-29");
  });
});

describe("assembleClaudeUsageOverview", () => {
  test("ok — rows built, no errors, endpoint echoed", async () => {
    const out = await assembleClaudeUsageOverview(deps(async () => payload()), 14, NOW);
    expect(out.reachable).toBe(true);
    expect(out.errors).toBeUndefined();
    expect(out.days).toBe(14);
    expect(out.configured).toBe(true);
    expect(out.rows).toHaveLength(6);
    // The card's sub-line names the endpoint it actually read, rather than a
    // hardcoded "port 8787" that a re-pointed CLAUDE_USAGE_URL makes a lie.
    expect(out.baseUrl).toBe(BASE);
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
    expect(out.errors?.[0]).toContain("timed out");
    // A degraded card must say WHICH endpoint failed — the operator's first
    // question is "was it even pointed at the right host?".
    expect(out.baseUrl).toBe(BASE);
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
      // The trailing slash is stripped once, at construction.
      expect(out.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
  });

  test("non-200 degrades with the status AND the URL in the message", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) });
    try {
      const d = defaultClaudeUsageDeps(`http://127.0.0.1:${server.port}`, true);
      const out = await assembleClaudeUsageOverview(d, 14, NOW);
      expect(out.reachable).toBe(false);
      expect(out.errors?.[0]).toContain("HTTP 503");
      expect(out.errors?.[0]).toContain(`http://127.0.0.1:${server.port}/api/pipeline`);
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
      // "It failed fast" is not the claim — the claim is that it failed fast
      // BECAUSE the budget fired, which only the message can distinguish from a
      // connection refused by a server that never started.
      expect(out.errors?.[0]?.toLowerCase()).toContain("timed out");
    } finally {
      server.stop(true);
    }
  });

  test("an over-cap declared body is refused before it is read", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json(payload()) });
    try {
      const d = defaultClaudeUsageDeps(`http://127.0.0.1:${server.port}`, true, 5_000, 100);
      const out = await assembleClaudeUsageOverview(d, 14, NOW);
      expect(out.reachable).toBe(false);
      expect(out.errors?.[0]).toContain("byte cap");
    } finally {
      server.stop(true);
    }
  });

  test("a chunked body with NO content-length is bounded by the read itself", async () => {
    // The header is the cheap check, not the guarantee: claude-usage's sqlite is
    // 145 MB and a chunked response declares no length at all.
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
      const d = defaultClaudeUsageDeps(`http://127.0.0.1:${server.port}`, true, 5_000, 100);
      const out = await assembleClaudeUsageOverview(d, 14, NOW);
      expect(out.reachable).toBe(false);
      expect(out.errors?.[0]).toContain("byte cap");
    } finally {
      server.stop(true);
    }
  });

  test("a body UNDER the cap still parses", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json(payload()) });
    try {
      const d = defaultClaudeUsageDeps(`http://127.0.0.1:${server.port}`, true, 5_000, 8_000_000);
      const out = await assembleClaudeUsageOverview(d, 14, NOW);
      expect(out.reachable).toBe(true);
      expect(row(out.rows, "Merges")!.value).toBe("130");
    } finally {
      server.stop(true);
    }
  });
});
