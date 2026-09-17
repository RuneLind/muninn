/**
 * The claude-usage `/api/sessions-by-id` client: batching against both bounds,
 * and the degrade shape a page with bare chips is built from.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  batchSessionIds,
  fetchHandoffs,
  fetchMergesForSessions,
  fetchSessionsById,
  SESSION_IDS_PER_CALL,
  SESSION_IDS_QUERY_MAX_BYTES,
  __resetSessionLedgerWarnsForTest,
  type SessionLedgerDeps,
} from "./session-ledger.ts";
import { ClaudeUsageHttpError, claudeUsageHttpStatus } from "../utils/claude-usage-fetch.ts";

beforeEach(() => __resetSessionLedgerWarnsForTest());

function deps(
  fetchSessions: SessionLedgerDeps["fetchSessions"],
  urlConfigured = true,
): SessionLedgerDeps {
  return {
    fetchSessions,
    // This file tests the FACTS leg; a merges stub that answered rows would be
    // asserting about a leg no case here calls.
    fetchMerges: async () => ({ merges: [] }),
    fetchHandoff: async () => ({ available: false }),
    fetchMergesForPrs: async () => ({ merges: [], unmapped: [] }),
    urlConfigured,
    baseUrl: "http://127.0.0.1:8787",
  };
}

const facts = (id: string, cost: number) => ({
  sessionId: id,
  title: `s-${id}`,
  provider: "claude-code",
  host: "mini",
  hosts: ["mini"],
  first: null,
  last: null,
  cost,
  messages: 3,
});

describe("batchSessionIds", () => {
  test("pages at the id cap", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const batches = batchSessionIds(ids);
    expect(batches.map((b) => b.length)).toEqual([SESSION_IDS_PER_CALL, SESSION_IDS_PER_CALL, 50]);
    expect(batches.flat()).toEqual(ids);
  });

  test("pages at the QUERY BYTE budget too, which the id cap alone does not bound", () => {
    // 200 ids of this length are ~20 kB of query — past the 16 KiB HEADER BLOCK
    // Bun answers with an empty-bodied 431 before any handler runs (measured:
    // see `SESSION_IDS_QUERY_MAX_BYTES`).
    const long = Array.from({ length: 200 }, (_, i) => `${"x".repeat(100)}-${i}`);
    const batches = batchSessionIds(long);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const bytes = batch.map((id) => encodeURIComponent(id)).join(",").length;
      expect(bytes).toBeLessThanOrEqual(SESSION_IDS_QUERY_MAX_BYTES);
    }
    expect(batches.flat()).toEqual(long);
  });

  test("an id larger than the whole budget still goes out alone rather than being dropped", () => {
    // The pure function's own property. `fetchSessionsById` is what guarantees
    // this input can never occur in production — an id over
    // `SESSION_ID_MAX_CHARS` is refused as `invalid` BEFORE batching, because a
    // batch carrying one fails whole and takes every legitimate id with it
    // (a 431 has no body naming the offender). Dropping it here instead would
    // lose an id silently, which is worse than either.
    const huge = "y".repeat(SESSION_IDS_QUERY_MAX_BYTES + 10);
    expect(batchSessionIds([huge, "small"])).toEqual([[huge], ["small"]]);
  });
});

describe("fetchSessionsById", () => {
  test("holds the facts it was given and reports reachable", async () => {
    const res = await fetchSessionsById(
      deps(async (ids) => ({ sessions: ids.map((id) => facts(id, 1)), limit: 200, truncated: false })),
      ["a", "b"],
    );
    expect(res.reachable).toBe(true);
    expect(res.facts.get("a")?.cost).toBe(1);
    expect(res.errors).toBeUndefined();
  });

  test("a `missing: true` row never enters the map — it is not a $0 session", async () => {
    const res = await fetchSessionsById(
      deps(async () => ({ sessions: [facts("a", 2), { sessionId: "b", missing: true }] })),
      ["a", "b"],
    );
    expect(res.reachable).toBe(true);
    expect(res.facts.has("a")).toBe(true);
    expect(res.facts.has("b")).toBe(false);
  });

  test("ids are deduped and trimmed before the call", async () => {
    const seen: string[][] = [];
    await fetchSessionsById(
      deps(async (ids) => {
        seen.push(ids);
        return { sessions: [] };
      }),
      [" a ", "a", "b", ""],
    );
    expect(seen).toEqual([["a", "b"]]);
  });

  test("an empty list asks nothing and reports unreachable with no error", async () => {
    let called = false;
    const res = await fetchSessionsById(
      deps(async () => {
        called = true;
        return { sessions: [] };
      }),
      [],
    );
    expect(called).toBe(false);
    expect(res.reachable).toBe(false);
    expect(res.errors).toBeUndefined();
  });

  test("a rejecting fetch degrades to unreachable + an error naming the base URL", async () => {
    const res = await fetchSessionsById(
      deps(async () => {
        throw new Error("connect ECONNREFUSED (http://127.0.0.1:8787)");
      }),
      ["a"],
    );
    expect(res.reachable).toBe(false);
    expect(res.facts.size).toBe(0);
    expect(res.errors?.[0]).toContain("http://127.0.0.1:8787");
  });

  test("a body that is not an object, or carries no sessions array, is a wrong service — not an empty ledger", async () => {
    const arr = await fetchSessionsById(deps(async () => [1, 2, 3]), ["a"]);
    expect(arr.reachable).toBe(false);
    expect(arr.errors?.[0]).toContain("not a JSON object");

    const noArray = await fetchSessionsById(deps(async () => ({ sessions: "nope" })), ["a"]);
    expect(noArray.reachable).toBe(false);
    expect(noArray.errors?.[0]).toContain("no `sessions` array");
  });

  test("one failing batch leaves the other batch's facts in hand", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const res = await fetchSessionsById(
      deps(async (batch) => {
        if (batch.length === SESSION_IDS_PER_CALL) throw new Error("boom");
        return { sessions: batch.map((id) => facts(id, 0.5)) };
      }),
      ids,
    );
    expect(res.reachable).toBe(true); // the second batch answered
    expect(res.facts.size).toBe(50);
    expect(res.errors?.length).toBe(1);
  });

  test("upstream's own truncation flag is reported rather than assumed away", async () => {
    const res = await fetchSessionsById(
      deps(async () => ({ sessions: [], truncated: true })),
      ["a"],
    );
    expect(res.truncated).toBe(true);
  });
});

// ── `asked` — whether a request was SENT (fix round 2) ──────────────────────

describe("fetchSessionsById — asked", () => {
  test("a page whose every id is unaskable sends NOTHING and says so", async () => {
    let calls = 0;
    const res = await fetchSessionsById(
      deps(async () => {
        calls += 1;
        return { sessions: [] };
      }),
      ["not a session id", "has/slash"],
    );
    expect(calls).toBe(0);
    expect(res.asked).toBe(false);
    // `reachable: false` is true here but means nothing on its own — the caller
    // reads it beside `asked`, and beside `asked: true` it means the service is
    // down. On its own it rendered "claude-usage unreachable" for a page whose
    // only problem was a mangled frontmatter line.
    expect(res.reachable).toBe(false);
    expect(res.invalid.size).toBe(2);
  });

  test("a batch that was sent and FAILED still counts as asked", async () => {
    const res = await fetchSessionsById(
      deps(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      ["a"],
    );
    expect(res.asked).toBe(true);
    expect(res.reachable).toBe(false);
  });

  test("one askable id beside two damaged ones is asked", async () => {
    let calls = 0;
    const res = await fetchSessionsById(
      deps(async (batch) => {
        calls += 1;
        return { sessions: batch.map((id) => facts(id, 1)) };
      }),
      ["not a session id", "a", "has/slash"],
    );
    expect(calls).toBe(1);
    expect(res.asked).toBe(true);
    expect(res.invalid.size).toBe(2);
  });
});

/**
 * The MERGES leg, at its own seam.
 *
 * It was reachable only through `pageProvenance` before, which is a one-batch
 * caller in every fixture — and one batch is exactly the shape in which "some
 * batches answered" cannot happen.
 */
describe("fetchMergesForSessions", () => {
  /** The same deps shape, with the merges half stubbed instead of the facts
   *  half. */
  function mergeDeps(
    fetchMerges: SessionLedgerDeps["fetchMerges"],
    urlConfigured = true,
  ): SessionLedgerDeps {
    return {
      fetchSessions: async () => ({ sessions: [] }),
      fetchMerges,
      fetchHandoff: async () => ({ available: false }),
      fetchMergesForPrs: async () => ({ merges: [], unmapped: [] }),
      urlConfigured,
      baseUrl: "http://127.0.0.1:8787",
    };
  }

  const row = (id: string, prNumber: number) => ({
    sessionId: id,
    repo: "/Users/synthetic/source/muninn",
    prNumber,
    url: `https://github.com/Synthetic/muninn/pull/${prNumber}`,
    subject: null,
    mergedAt: "2026-09-16T10:30:00.000Z",
    mergeOk: true,
  });

  /** 250 askable ids — two batches (200 + 50) against `SESSION_IDS_PER_CALL`. */
  const many = Array.from({ length: 250 }, (_, i) => `ses-${String(i).padStart(3, "0")}`);

  test("one batch answering and one failing is PARTIAL, not a clean answer", async () => {
    let call = 0;
    const res = await fetchMergesForSessions(
      mergeDeps(async (batch) => {
        call += 1;
        if (call === 2) throw new Error("connect ECONNREFUSED");
        return { merges: [row(batch[0]!, 553)] };
      }),
      many,
    );
    expect(call).toBe(2);
    // The half that answered is real and is rendered…
    expect(res.reachable).toBe(true);
    expect(res.merges.map((m) => m.prNumber)).toEqual([553]);
    // …and the half that did not is SAID, which is the whole point: with
    // `reachable` alone this page reports one merge as if it were all of them.
    expect(res.partial).toBe(true);
    expect(res.errors).toEqual(["claude-usage merges: connect ECONNREFUSED"]);
  });

  test("every batch answering is not partial", async () => {
    const res = await fetchMergesForSessions(
      mergeDeps(async (batch) => ({ merges: [row(batch[0]!, 1)] })),
      many,
    );
    expect(res.reachable).toBe(true);
    expect(res.partial).toBe(false);
    expect(res.errors).toBeUndefined();
  });

  test("every batch failing is unreachable, and not partial either", async () => {
    const res = await fetchMergesForSessions(
      mergeDeps(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      many,
    );
    expect(res.asked).toBe(true);
    expect(res.reachable).toBe(false);
    // Nothing answered, so there is no half to be missing FROM — the footer says
    // "did not answer", which is a different sentence.
    expect(res.partial).toBe(false);
  });

  test("upstream's own cap rides the result — never a number typed on this side", async () => {
    const res = await fetchMergesForSessions(
      mergeDeps(async () => ({ merges: [], truncated: true, limit: 500 })),
      ["ses-a"],
    );
    expect(res.truncated).toBe(true);
    expect(res.limit).toBe(500);
  });

  test("a `truncated` with no usable limit leaves the field absent", async () => {
    for (const limit of [undefined, 0, -1, "200", null]) {
      const res = await fetchMergesForSessions(
        mergeDeps(async () => ({ merges: [], truncated: true, limit })),
        ["ses-a"],
      );
      expect(res.truncated).toBe(true);
      expect(res.limit).toBeUndefined();
    }
  });
});

describe("fetchHandoffs — a 404 is an ANSWER, not an outage", () => {
  /** Deps whose handoff leg is the only one under test. */
  function handoffDeps(fetchHandoff: SessionLedgerDeps["fetchHandoff"]): SessionLedgerDeps {
    return {
      fetchSessions: async () => ({ sessions: [] }),
      fetchMerges: async () => ({ merges: [] }),
      fetchHandoff,
      fetchMergesForPrs: async () => ({ merges: [], unmapped: [] }),
      urlConfigured: true,
      baseUrl: "http://127.0.0.1:8787",
    };
  }

  const ID_A = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
  const ID_B = "617e67b3-13d7-4407-a2fe-37ce79df9634";

  test("upstream's documented 404 reads as `no handoff for this id`", async () => {
    // claude-usage's own contract for this route: "400 without an id, 404 for an
    // unknown session, and every other outcome a 200". A page whose ids the
    // ledger does not hold — the `missing` chip state — is the ORDINARY case,
    // and it used to render `handoffs not read` against a healthy service.
    const r = await fetchHandoffs(
      handoffDeps(async () => {
        throw new ClaudeUsageHttpError(404, "http://127.0.0.1:8787");
      }),
      [ID_A, ID_B],
    );
    expect(r.asked).toBe(true);
    expect(r.reachable).toBe(true);
    expect(r.errors).toBeUndefined();
    expect(r.ranBy.size).toBe(0);
  });

  test("any OTHER status is still a failed call", async () => {
    for (const status of [500, 502, 400]) {
      const r = await fetchHandoffs(
        handoffDeps(async () => {
          throw new ClaudeUsageHttpError(status, "http://127.0.0.1:8787");
        }),
        [ID_A],
      );
      expect(r.reachable).toBe(false);
      expect(r.errors?.length).toBe(1);
    }
  });

  test("a transport failure with no status is still a failed call", async () => {
    const r = await fetchHandoffs(
      handoffDeps(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      [ID_A],
    );
    expect(r.reachable).toBe(false);
    expect(r.errors?.[0]).toContain("ECONNREFUSED");
  });

  test("one id 404s and another answers: reachable, no error, the answer kept", async () => {
    const r = await fetchHandoffs(
      handoffDeps(async (id) => {
        if (id === ID_A) throw new ClaudeUsageHttpError(404, "http://127.0.0.1:8787");
        return {
          available: true,
          ranBy: [{ sessionId: ID_A, at: "2026-09-16T07:24:41.216Z", host: "macpro" }],
        };
      }),
      [ID_A, ID_B],
    );
    expect(r.reachable).toBe(true);
    expect(r.errors).toBeUndefined();
    expect(r.ranBy.get(ID_B)).toHaveLength(1);
  });

  test("claudeUsageHttpStatus is duck-typed, so a test seam can drive the branch", () => {
    expect(claudeUsageHttpStatus(Object.assign(new Error("x"), { status: 404 }))).toBe(404);
    expect(claudeUsageHttpStatus(new Error("claude-usage returned HTTP 404 for x"))).toBeNull();
    expect(claudeUsageHttpStatus(null)).toBeNull();
    expect(claudeUsageHttpStatus("404")).toBeNull();
  });
});
