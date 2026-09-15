/**
 * The claude-usage `/api/sessions-by-id` client: batching against both bounds,
 * and the degrade shape a page with bare chips is built from.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  batchSessionIds,
  fetchSessionsById,
  SESSION_IDS_PER_CALL,
  SESSION_IDS_QUERY_MAX_BYTES,
  __resetSessionLedgerWarnsForTest,
  type SessionLedgerDeps,
} from "./session-ledger.ts";

beforeEach(() => __resetSessionLedgerWarnsForTest());

function deps(
  fetchSessions: SessionLedgerDeps["fetchSessions"],
  urlConfigured = true,
): SessionLedgerDeps {
  return { fetchSessions, urlConfigured, baseUrl: "http://127.0.0.1:8787" };
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
