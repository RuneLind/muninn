/**
 * The join: session refs + Jira keys → the payload the reader renders, with both
 * external reads optional and neither able to fail the answer.
 */

import { test, expect, describe } from "bun:test";
import {
  dedupeSessionRefs,
  pageProvenance,
  resolveProvenance,
  type ProvenanceContext,
} from "./provenance-service.ts";
import { __resetSessionLedgerWarnsForTest, type SessionLedgerDeps } from "./session-ledger.ts";
import type { WikiPageMeta } from "./store.ts";

const ID_A = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
const SESSION_A = `claude-code:${ID_A}`;

function ctx(over: Partial<ProvenanceContext> = {}): ProvenanceContext {
  __resetSessionLedgerWarnsForTest();
  const ledger: SessionLedgerDeps = {
    baseUrl: "http://127.0.0.1:8787",
    urlConfigured: true,
    fetchSessions: async (ids) => ({
      sessions: ids.map((id) =>
        id === ID_A
          ? { sessionId: id, title: "T", provider: "claude-code", host: "mini", hosts: ["mini"], first: null, last: null, cost: 3, messages: 9 }
          : { sessionId: id, missing: true },
      ),
    }),
  };
  return {
    sessionLedger: ledger,
    knowledgeApiUrl: "http://localhost:8321",
    publicUrl: null,
    loadJiraIndex: async () => ({ byKey: new Map([["MELOSYS-8045", "https://x/MELOSYS-8045"]]), fetchedAtMs: 0 }),
    ...over,
  };
}

function page(over: Partial<WikiPageMeta> = {}): WikiPageMeta {
  return { name: "p", title: "P", type: "plan", domain: "ai", tags: [], aliases: [], relPath: "p.md", ...over } as WikiPageMeta;
}

describe("dedupeSessionRefs", () => {
  test("first-wins on the BARE id, so a prefixed and a bare spelling are one session", () => {
    expect(dedupeSessionRefs([SESSION_A, ID_A, " ", "other"])).toEqual([SESSION_A, "other"]);
  });
});

describe("resolveProvenance", () => {
  test("prices the sessions the ledger holds and flags the rest", async () => {
    const res = await resolveProvenance({ refs: [SESSION_A, "opencode:gone"], keys: [] }, ctx());
    expect(res.sessions.map((s) => s.missing)).toEqual([false, true]);
    expect(res.totalCost).toBe(3);
    expect(res.costedSessions).toBe(1);
    expect(res.ledger.reachable).toBe(true);
    expect(res.ledger.configured).toBe(true);
    expect(res.ledger.baseUrl).toBe("http://127.0.0.1:8787");
  });

  test("the ledger is asked with BARE ids — a prefixed id would come back missing", async () => {
    const asked: string[][] = [];
    await resolveProvenance(
      { refs: [SESSION_A], keys: [] },
      ctx({
        sessionLedger: {
          baseUrl: "b",
          // TRUE, and it has to be: `urlConfigured` is the ONE flag deciding
          // whether the ledger is fetched. It read `false` here while a second
          // context field drove the fetch — the disagreement that fix round 2
          // removed, sitting in a test the whole time.
          urlConfigured: true,
          fetchSessions: async (ids) => {
            asked.push(ids);
            return { sessions: [] };
          },
        },
      }),
    );
    expect(asked).toEqual([[ID_A]]);
  });

  test("a duplicated session is priced ONCE", async () => {
    const res = await resolveProvenance({ refs: [SESSION_A, ID_A], keys: [] }, ctx());
    expect(res.sessions.length).toBe(1);
    expect(res.totalCost).toBe(3);
  });

  test("an unreachable ledger renders bare chips and says so — never a throw", async () => {
    const res = await resolveProvenance(
      { refs: [SESSION_A], keys: [] },
      ctx({
        sessionLedger: {
          baseUrl: "http://127.0.0.1:8787",
          urlConfigured: true,
          fetchSessions: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        },
      }),
    );
    // UNRESOLVED, not missing: the batch failed, so nobody ever asked. "This
    // session was reaped" is the opposite conclusion.
    expect(res.sessions[0]!.unresolved).toBe(true);
    expect(res.sessions[0]!.missing).toBe(false);
    expect(res.totalCost).toBe(0);
    expect(res.costedSessions).toBe(0);
    expect(res.ledger.asked).toBe(true);
    expect(res.ledger.reachable).toBe(false);
    // CONFIGURED and asked and unreachable — the three facts are separate, and
    // only together do they say "this host should be pricing and cannot".
    expect(res.ledger.configured).toBe(true);
    expect(res.ledger.errors?.length).toBe(1);
  });

  test("a page naming no session never calls the ledger, and claims nothing about it", async () => {
    let called = false;
    const res = await resolveProvenance(
      { refs: [], keys: ["MELOSYS-8045"] },
      ctx({
        sessionLedger: {
          baseUrl: "b",
          urlConfigured: true,
          fetchSessions: async () => {
            called = true;
            return { sessions: [] };
          },
        },
      }),
    );
    expect(called).toBe(false);
    expect(res.ledger.reachable).toBe(false);
    expect(res.ledger.errors).toBeUndefined();
  });

  test("the huginn corpus is asked only when a key is present, and a throw degrades to no url", async () => {
    let asked = 0;
    const counting = ctx({
      loadJiraIndex: async () => {
        asked += 1;
        throw new Error("huginn down");
      },
    });
    await resolveProvenance({ refs: [SESSION_A], keys: [] }, counting);
    expect(asked).toBe(0);

    const res = await resolveProvenance({ refs: [], keys: ["MELOSYS-8045"] }, counting);
    expect(asked).toBe(1);
    expect(res.jira).toEqual([
      { key: "MELOSYS-8045", url: "https://nav.atlassian.net/browse/MELOSYS-8045" },
    ]);
  });
});

describe("pageProvenance", () => {
  test("a page carrying none of the keys gets NO block at all", async () => {
    expect(await pageProvenance(page(), ctx())).toBeNull();
  });

  test("a page carrying only prs still gets a block, and the coordinates resolve", async () => {
    const res = await pageProvenance(page({ prs: ["RuneLind/muninn#543"] }), ctx());
    expect(res!.prs).toEqual([
      { ref: "RuneLind/muninn#543", url: "https://github.com/RuneLind/muninn/pull/543" },
    ]);
    expect(res!.sessions).toEqual([]);
  });

  test("the backfilled marker rides the block when the page carries it", async () => {
    const res = await pageProvenance(
      page({ sessions: [SESSION_A], sessionsBackfilled: "2026-10-14", jira: ["MELOSYS-8045"] }),
      ctx(),
    );
    expect(res!.backfilled).toBe("2026-10-14");
    expect(res!.jira[0]!.huginnKnown).toBe(true);
    expect(res!.totalCost).toBe(3);
    expect(res!.costedSessions).toBe(1);
  });

  test("no marker ⇒ no field (absent, not an empty string)", async () => {
    const res = await pageProvenance(page({ sessions: [SESSION_A] }), ctx());
    expect("backfilled" in res!).toBe(false);
  });
});
