/**
 * The provenance join's DEGRADE states — the half a reader only sees when
 * something is down, and therefore the half nothing exercised.
 *
 * Every case here is a way the answer can be wrong while looking right: a
 * partial outage priced as a complete answer, a "reaped session" that was never
 * asked about, an unconfigured host paying a connection refusal on every page
 * open, a page open that costs the SUM of its legs, and one malformed
 * frontmatter entry taking a whole batch down with it.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { pageProvenance, resolveProvenance, type ProvenanceContext } from "./provenance-service.ts";
import type { WikiPageMeta } from "./store.ts";
import { LEDGER_NOT_ASKED } from "./provenance.ts";
import {
  fetchSessionsById,
  isSessionIdShape,
  SESSION_ID_MAX_CHARS,
  SESSION_IDS_PER_CALL,
  __resetSessionLedgerWarnsForTest,
  type SessionLedgerDeps,
} from "./session-ledger.ts";
import { AMBIENT_INSTANCE_ENV } from "../test/ambient-env.ts";
import { claudeUsageJson } from "../utils/claude-usage-fetch.ts";

const ID_A = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
const SESSION_A = `claude-code:${ID_A}`;

afterEach(() => __resetSessionLedgerWarnsForTest());

/** Facts for one priced session, in claude-usage's own shape. */
function facts(id: string, cost: number, over: Record<string, unknown> = {}) {
  return { sessionId: id, title: "T", provider: "claude-code", host: "mini", cost, messages: 4, ...over };
}

function deps(over: Partial<SessionLedgerDeps> = {}): SessionLedgerDeps {
  return {
    baseUrl: "http://127.0.0.1:8787",
    urlConfigured: true,
    fetchSessions: async (ids) => ({ sessions: ids.map((id) => facts(id, 1)) }),
    // Answers nothing by default: a case about the FACTS leg must not also be
    // asserting something about merges by accident.
    fetchMerges: async () => ({ merges: [] }),
    ...over,
  };
}

function ctx(over: Partial<ProvenanceContext> = {}): ProvenanceContext {
  return {
    sessionLedger: deps(),
    knowledgeApiUrl: "http://localhost:8321",
    publicUrl: null,
    loadJiraIndex: async () => ({ byKey: new Map([["MELOSYS-8045", undefined]]), fetchedAtMs: 0 }),
    budgetMs: 200,
    ...over,
  };
}

// ── A PARTIAL outage is not a complete answer ───────────────────────────────

describe("a batch that fails while another answers", () => {
  /** 250 ids ⇒ two batches; the SECOND one throws. */
  function twoBatchesOneDown(): { deps: SessionLedgerDeps; ids: string[] } {
    const ids = Array.from({ length: SESSION_IDS_PER_CALL + 50 }, (_, i) => `id-${String(i).padStart(4, "0")}`);
    let call = 0;
    return {
      ids,
      deps: deps({
        fetchSessions: async (batch) => {
          call += 1;
          if (call === 2) throw new Error("connect ECONNREFUSED");
          return { sessions: batch.map((id) => facts(id, 1)) };
        },
      }),
    };
  }

  test("its ids are UNRESOLVED, not missing — nobody asked about them", async () => {
    const { deps: d, ids } = twoBatchesOneDown();
    const res = await fetchSessionsById(d, ids);
    expect(res.unresolved.size).toBe(50);
    expect(res.unresolved.has("id-0249")).toBe(true);
    // The first batch's ids answered, so they are neither unresolved nor absent.
    expect(res.unresolved.has("id-0000")).toBe(false);
    expect(res.facts.has("id-0000")).toBe(true);
  });

  test("`partial` says the answer is over a SUBSET, which `reachable` alone cannot", async () => {
    const { deps: d, ids } = twoBatchesOneDown();
    const res = await fetchSessionsById(d, ids);
    // Both flags are needed: `reachable` is true (a batch answered) and would on
    // its own present a 200-of-250 answer as complete.
    expect(res.reachable).toBe(true);
    expect(res.partial).toBe(true);
    expect(res.errors?.length).toBe(1);
  });

  test("a failure in EVERY batch is not partial — it is simply unreachable", async () => {
    const res = await fetchSessionsById(
      deps({ fetchSessions: async () => { throw new Error("down"); } }),
      [ID_A],
    );
    expect(res.reachable).toBe(false);
    expect(res.partial).toBe(false);
    expect(res.unresolved.has(ID_A)).toBe(true);
  });

  test("the chips and the money line carry it through to the payload", async () => {
    const { deps: d, ids } = twoBatchesOneDown();
    const res = await resolveProvenance({ refs: ids, keys: [] }, ctx({ sessionLedger: d }));
    const unresolved = res.sessions.filter((s) => s.unresolved);
    expect(unresolved.length).toBe(50);
    expect(unresolved.every((s) => s.missing === false && s.cost === null)).toBe(true);
    expect(res.ledger.partial).toBe(true);
    // 200 of 250 priced — and `costedSessions` is what says so.
    expect(res.costedSessions).toBe(200);
  });

  test("upstream's own `truncated` reaches the wire state", async () => {
    const res = await resolveProvenance(
      { refs: [SESSION_A], keys: [] },
      ctx({
        sessionLedger: deps({
          fetchSessions: async (ids) => ({ sessions: ids.map((id) => facts(id, 1)), truncated: true }),
        }),
      }),
    );
    expect(res.ledger.truncated).toBe(true);
  });
});

// ── `asked` — the explicit third state ──────────────────────────────────────

describe("ledger.asked", () => {
  test("a page with Jira keys and NO sessions reports asked: false, not unreachable", async () => {
    const res = await resolveProvenance({ refs: [], keys: ["MELOSYS-8045"] }, ctx());
    expect(res.ledger.asked).toBe(false);
    expect(res.ledger.reachable).toBe(false);
    // Configured — this host WOULD have priced, there was simply nothing to ask.
    expect(res.ledger.configured).toBe(true);
  });

  test("an unconfigured host NEVER fetches, and names no endpoint", async () => {
    let calls = 0;
    const res = await resolveProvenance(
      { refs: [SESSION_A], keys: [] },
      ctx({
        sessionLedger: deps({
          urlConfigured: false,
          fetchSessions: async () => {
            calls += 1;
            return { sessions: [] };
          },
        }),
      }),
    );
    expect(calls).toBe(0);
    expect(res.ledger).toEqual({ asked: false, reachable: false, partial: false, configured: false });
    // The chip is bare but it is NOT "the ledger does not hold this session" —
    // this host is in no position to make that claim.
    expect(res.sessions[0]!.missing).toBe(false);
    expect(res.sessions[0]!.unresolved).toBe(true);
  });

  test("asked ⇒ the endpoint is named, so a degraded reader can say which host", async () => {
    const res = await resolveProvenance({ refs: [SESSION_A], keys: [] }, ctx());
    expect(res.ledger.asked).toBe(true);
    expect(res.ledger.baseUrl).toBe("http://127.0.0.1:8787");
  });

  /**
   * Fix round 2. `asked` was keyed on "the lookup returned a result", and
   * `fetchSessionsById` returns one even when every id was refused before
   * batching — so a page whose ONE session line is damaged reported
   * `asked: true, reachable: false`, which the reader renders as "claude-usage
   * unreachable". The service was never called and is, as far as this page
   * knows, perfectly healthy. `asked` is now "a request was SENT".
   */
  test("a page whose every session id is damaged reports asked: false, not unreachable", async () => {
    let calls = 0;
    const res = await resolveProvenance(
      { refs: ["claude-code:not a session id", "bare/slash"], keys: [] },
      ctx({
        sessionLedger: deps({
          fetchSessions: async () => {
            calls += 1;
            return { sessions: [] };
          },
        }),
      }),
    );
    expect(calls).toBe(0); // nothing was askable, so nothing was asked
    expect(res.ledger.asked).toBe(false);
    expect(res.ledger.reachable).toBe(false);
    // Configured, and the endpoint is still named — the host IS pointed at one.
    expect(res.ledger.configured).toBe(true);
    expect(res.ledger.baseUrl).toBe("http://127.0.0.1:8787");
    // The chips say what is actually wrong: the ids, not the service.
    expect(res.sessions.map((s) => s.invalid)).toEqual([true, true]);
  });

  test("one damaged id BESIDE a good one still asks — the state is about the batch sent", async () => {
    let calls = 0;
    const res = await resolveProvenance(
      { refs: [SESSION_A, "claude-code:not a session id"], keys: [] },
      ctx({
        sessionLedger: deps({
          fetchSessions: async (ids) => {
            calls += 1;
            return { sessions: ids.map((id) => facts(id, 1)) };
          },
        }),
      }),
    );
    expect(calls).toBe(1);
    expect(res.ledger.asked).toBe(true);
    expect(res.ledger.reachable).toBe(true);
  });
});

// ── One source of truth for "is a claude-usage configured here" ─────────────

describe("ledger.configured", () => {
  /**
   * Fix round 2. The context carried `ledgerConfigured` AND the ledger client
   * carried `urlConfigured`, both wired from `config.claudeUsageUrl != null` at
   * the route — two fields for one fact, free to disagree everywhere else, with
   * `ledgerState` hardcoding `configured: true` beside them. The join now reads
   * the client's field and only the client's field.
   */
  test("the ledger client's own flag decides BOTH whether we fetch and what we report", async () => {
    let calls = 0;
    const counting = (urlConfigured: boolean) =>
      ctx({
        sessionLedger: deps({
          urlConfigured,
          fetchSessions: async (ids) => {
            calls += 1;
            return { sessions: ids.map((id) => facts(id, 1)) };
          },
        }),
      });

    const off = await resolveProvenance({ refs: [SESSION_A], keys: [] }, counting(false));
    expect(calls).toBe(0);
    expect(off.ledger.configured).toBe(false);
    expect(off.ledger.asked).toBe(false);

    const on = await resolveProvenance({ refs: [SESSION_A], keys: [] }, counting(true));
    expect(calls).toBe(1);
    expect(on.ledger.configured).toBe(true);
    expect(on.ledger.asked).toBe(true);
  });

  test("the unconfigured answer is FROZEN — it is handed out by reference", async () => {
    const res = await resolveProvenance(
      { refs: [SESSION_A], keys: [] },
      ctx({ sessionLedger: deps({ urlConfigured: false }) }),
    );
    // Every unconfigured page open on this host gets the SAME object. One caller
    // writing a field onto "its" copy would write it onto every answer already
    // returned and every one still to come.
    expect(res.ledger).toBe(LEDGER_NOT_ASKED);
    expect(Object.isFrozen(LEDGER_NOT_ASKED)).toBe(true);
    expect(() => {
      (res.ledger as { asked: boolean }).asked = true;
    }).toThrow();
    expect(LEDGER_NOT_ASKED.asked).toBe(false);
  });
});

// ── ONE deadline over the whole enrichment ──────────────────────────────────

describe("the shared budget", () => {
  test("a hanging ledger AND a hanging huginn cost ONE budget, not two", async () => {
    const hang = new Promise<never>(() => {});
    const started = Date.now();
    const res = await resolveProvenance(
      { refs: [SESSION_A], keys: ["MELOSYS-8045"] },
      ctx({
        budgetMs: 120,
        sessionLedger: deps({
          fetchSessions: (_ids, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("TimeoutError")), { once: true });
            }),
        }),
        loadJiraIndex: () => hang,
      }),
    );
    const spent = Date.now() - started;
    // Sequential with a budget each this would be ≥ 240 ms; concurrent under one
    // deadline it is ~120. The slack absorbs a loaded CI runner without letting
    // the sequential shape through.
    expect(spent).toBeLessThan(220);
    expect(res.ledger.reachable).toBe(false);
    // huginn timed out ⇒ the row keeps its browse url and claims nothing.
    expect(res.jira[0]!.huginnKnown).toBeUndefined();
  });

  test("the SAME signal reaches every batch, so N batches share one deadline", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const ids = Array.from({ length: SESSION_IDS_PER_CALL + 1 }, (_, i) => `id-${i}`);
    await resolveProvenance(
      { refs: ids, keys: [] },
      ctx({
        sessionLedger: deps({
          fetchSessions: async (batch, signal) => {
            seen.push(signal);
            return { sessions: batch.map((id) => facts(id, 1)) };
          },
        }),
      }),
    );
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).toBe(seen[1]);
  });
});

// ── An id that cannot BE an id ──────────────────────────────────────────────

describe("ids refused before batching", () => {
  const LONG = "y".repeat(SESSION_ID_MAX_CHARS + 1);

  test("the shape gate is the stamper's own alphabet", () => {
    expect(isSessionIdShape(ID_A)).toBe(true);
    expect(isSessionIdShape("ses_7f3a9b2c1d")).toBe(true);
    expect(isSessionIdShape("has space")).toBe(false);
    expect(isSessionIdShape("has/slash")).toBe(false);
    expect(isSessionIdShape("")).toBe(false);
  });

  /**
   * The LENGTH bound, pinned to a LITERAL 128 rather than to the constant.
   *
   * Fix round 2. The previous spelling was `"y".repeat(SESSION_ID_MAX_CHARS + 1)`
   * on both sides, which is self-referential: raise the constant to 128000 and
   * the fixtures grow with it and every assertion still passes. The number is a
   * contract with claude-usage's `wiki-stamp` (`SESSION_REF_RE`,
   * `/^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,128}$/`, `src/wiki-stamp.ts:47`), so a
   * test that cannot see it move is not pinning it.
   */
  test("128 characters is askable and 129 is not — the bound itself, not the constant", () => {
    const at128 = "a".repeat(128);
    const at129 = "a".repeat(129);
    expect(at128.length).toBe(128); // the fixture, spelled out
    expect(at129.length).toBe(129);
    expect(isSessionIdShape(at128)).toBe(true);
    expect(isSessionIdShape(at129)).toBe(false);
    // And the exported constant IS that bound, so a caller reading it (the
    // route's 400 message) quotes the same number the gate enforces.
    expect(SESSION_ID_MAX_CHARS).toBe(128);
  });

  test("an over-long id never reaches the wire, and does not take its batch with it", async () => {
    const sent: string[][] = [];
    const res = await fetchSessionsById(
      deps({
        fetchSessions: async (batch) => {
          sent.push(batch);
          return { sessions: batch.map((id) => facts(id, 2)) };
        },
      }),
      [ID_A, LONG],
    );
    // The whole point: the good id was still priced. Sent whole, the request
    // line is over claude-usage's header-block bound and the 431 has no body
    // naming which id did it.
    expect(sent).toEqual([[ID_A]]);
    expect(res.facts.get(ID_A)?.cost).toBe(2);
    expect(res.invalid.has(LONG)).toBe(true);
    expect(res.reachable).toBe(true);
  });

  test("ONLY invalid ids ⇒ nothing is fetched at all", async () => {
    let calls = 0;
    const res = await fetchSessionsById(
      deps({ fetchSessions: async () => { calls += 1; return { sessions: [] }; } }),
      [LONG],
    );
    expect(calls).toBe(0);
    expect(res.reachable).toBe(false);
    expect(res.invalid.has(LONG)).toBe(true);
  });

  test("the chip says `invalid`, which is neither missing nor unresolved", async () => {
    const res = await resolveProvenance({ refs: [`claude-code:${LONG}`], keys: [] }, ctx());
    expect(res.sessions[0]!.invalid).toBe(true);
    expect(res.sessions[0]!.missing).toBe(false);
    expect(res.sessions[0]!.unresolved).toBe(false);
  });
});

// ── Costing the session that was ASKED about ────────────────────────────────

describe("costOver", () => {
  test("narrows the money line to the queried session, leaving the chips whole", async () => {
    const res = await resolveProvenance(
      {
        refs: [SESSION_A, "opencode:ses_other"],
        keys: [],
        costOver: (chip) => chip.id === ID_A,
      },
      ctx({
        sessionLedger: deps({
          fetchSessions: async (ids) => ({ sessions: ids.map((id) => facts(id, id === ID_A ? 4 : 99)) }),
        }),
      }),
    );
    expect(res.sessions.length).toBe(2);
    expect(res.totalCost).toBe(4);
    expect(res.costedSessions).toBe(1);
  });
});

// ── The money line's own arithmetic ─────────────────────────────────────────

describe("totalCost", () => {
  test("is rounded to cents at the seam, not left as a float sum", async () => {
    const res = await resolveProvenance(
      { refs: ["a", "b", "c"], keys: [] },
      ctx({
        sessionLedger: deps({
          fetchSessions: async (ids) => ({ sessions: ids.map((id) => facts(id, 0.1)) }),
        }),
      }),
    );
    // 0.1 × 3 is 0.30000000000000004 in IEEE 754 — wrong in the one way a money
    // figure can be read, on a payload more than one client renders.
    expect(res.totalCost).toBe(0.3);
  });
});

// ── The provider a bare ref does not carry ──────────────────────────────────

describe("the provider on a bare ref", () => {
  test("comes from the ledger when the page did not spell one", async () => {
    const res = await resolveProvenance({ refs: [ID_A], keys: [] }, ctx());
    expect(res.sessions[0]!.ref).toBe(ID_A);
    expect(res.sessions[0]!.provider).toBe("claude-code");
  });

  test("a ref that DOES name one keeps its own spelling", async () => {
    const res = await resolveProvenance(
      { refs: ["opencode:" + ID_A], keys: [] },
      ctx(),
    );
    // The ledger says `claude-code`; the page says `opencode`. The page's
    // spelling is what a `?session=` link round-trips, so it wins.
    expect(res.sessions[0]!.provider).toBe("opencode");
  });
});

// ── The shared claude-usage fetch helper ────────────────────────────────────

describe("claudeUsageJson", () => {
  test("a deadline that fires DURING the body read still names the label", async () => {
    // The divergence this helper was extracted to close: the third copy wrapped
    // its bounded read in a bare rethrow, so a timeout that fired AFTER the
    // headers — the slow-service case the URL is in the message for — produced
    // `The operation timed out.` and named no host at all.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('{"sessions":'));
              await Bun.sleep(2_000);
              controller.close();
            },
          }),
        ),
    });
    try {
      const root = `http://127.0.0.1:${server.port}`;
      await expect(
        claudeUsageJson(root, "/api/sessions-by-id?ids=a", { label: root, timeoutMs: 60 }),
      ).rejects.toThrow(root);
    } finally {
      server.stop(true);
    }
  });

  test("an over-cap body names the label too", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("x".repeat(4096)) });
    try {
      const root = `http://127.0.0.1:${server.port}`;
      await expect(
        claudeUsageJson(root, "/api/sessions-by-id?ids=a", { label: root, maxBytes: 16 }),
      ).rejects.toThrow(root);
    } finally {
      server.stop(true);
    }
  });

  test("a non-200 and a non-JSON body both name the label", async () => {
    const bad = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) });
    const html = Bun.serve({ port: 0, fetch: () => new Response("<html>not us</html>") });
    try {
      const badRoot = `http://127.0.0.1:${bad.port}`;
      const htmlRoot = `http://127.0.0.1:${html.port}`;
      await expect(claudeUsageJson(badRoot, "/x", { label: badRoot })).rejects.toThrow(badRoot);
      await expect(claudeUsageJson(htmlRoot, "/x", { label: htmlRoot })).rejects.toThrow(htmlRoot);
    } finally {
      bad.stop(true);
      html.stop(true);
    }
  });
});

// ── The merges leg degrades on its own ──────────────────────────────────────
//
// It is a SECOND service call on the page open, so the two things it must never
// do are move the cost sentence and cost a second deadline.

describe("merges", () => {
  function meta(sessions: string[]): WikiPageMeta {
    return {
      name: "p",
      title: "P",
      type: "plan",
      domain: "ai",
      tags: [],
      aliases: [],
      relPath: "p.md",
      sessions,
    } as WikiPageMeta;
  }

  test("an unreachable merges route leaves the cost line's inputs untouched", async () => {
    const res = await pageProvenance(
      meta([SESSION_A]),
      ctx({
        sessionLedger: deps({
          fetchMerges: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        }),
      }),
    );
    // The facts leg answered, so the money is exactly what it was without the
    // second leg at all.
    expect(res!.totalCost).toBe(1);
    expect(res!.costedSessions).toBe(1);
    expect(res!.ledger.reachable).toBe(true);
    expect(res!.ledger.errors).toBeUndefined();
    // …and the merges half says, separately, that it got nothing.
    expect(res!.merges).toEqual([]);
    // `partial` is FALSE here: nothing answered, so there is no half-answer to
    // qualify — and the reason rides along, the way the facts leg's does.
    expect(res!.mergesLedger).toEqual({
      asked: true,
      reachable: false,
      partial: false,
      truncated: false,
      errors: ["claude-usage merges: connect ECONNREFUSED"],
    });
  });

  test("a body that is not this service's shape is unreachable, not an empty merge list", async () => {
    const res = await pageProvenance(
      meta([SESSION_A]),
      ctx({ sessionLedger: deps({ fetchMerges: async () => ({ nope: true }) }) }),
    );
    expect(res!.mergesLedger.reachable).toBe(false);
    expect(res!.merges).toEqual([]);
  });

  test("upstream cutting the list is CARRIED, not assumed away", async () => {
    const res = await pageProvenance(
      meta([SESSION_A]),
      ctx({
        sessionLedger: deps({
          fetchMerges: async () => ({ merges: [], limit: 200, truncated: true }),
        }),
      }),
    );
    expect(res!.mergesLedger.truncated).toBe(true);
    expect(res!.mergesLedger.reachable).toBe(true);
  });

  test("a row missing its `sessionId` is dropped rather than rendered as a merge of nothing", async () => {
    const res = await pageProvenance(
      meta([SESSION_A]),
      ctx({
        sessionLedger: deps({
          fetchMerges: async () => ({
            merges: [
              { repo: "r", prNumber: 1, url: null, subject: null, mergedAt: "2026-09-16T10:00:00Z", mergeOk: true },
              { sessionId: ID_A, repo: "r", prNumber: 2, url: null, subject: null, mergedAt: "2026-09-16T11:00:00Z", mergeOk: true },
            ],
          }),
        }),
      }),
    );
    expect(res!.merges.map((m) => m.prNumber)).toEqual([2]);
  });

  test("`mergeOk` absent is NOT unconfirmed — only an explicit false is", async () => {
    const res = await pageProvenance(
      meta([SESSION_A]),
      ctx({
        sessionLedger: deps({
          fetchMerges: async () => ({
            merges: [
              { sessionId: ID_A, repo: "r", prNumber: 1, url: null, subject: null, mergedAt: "2026-09-16T10:00:00Z" },
              { sessionId: ID_A, repo: "r", prNumber: 2, url: null, subject: null, mergedAt: "2026-09-16T11:00:00Z", mergeOk: false },
            ],
          }),
        }),
      }),
    );
    expect(res!.merges.map((m) => m.mergeOk)).toEqual([true, false]);
  });

  test("a half-answered merges leg reaches the payload as PARTIAL, with its reason", async () => {
    // Two batches, the second one down — the shape a page naming 250 sessions
    // produces, and the only shape in which "some of the merges" exists.
    const ids = Array.from({ length: SESSION_IDS_PER_CALL + 50 }, (_, i) => `id-${String(i).padStart(4, "0")}`);
    let call = 0;
    const res = await pageProvenance(
      meta(ids),
      ctx({
        sessionLedger: deps({
          fetchMerges: async (batch) => {
            call += 1;
            if (call === 2) throw new Error("connect ECONNREFUSED");
            return { merges: [{ sessionId: batch[0], repo: "/r", prNumber: 7, url: null, subject: null, mergedAt: null, mergeOk: true }] };
          },
        }),
      }),
    );
    expect(call).toBe(2);
    // One merge on screen, out of an unknown number — which the state now says.
    expect(res!.merges.length).toBe(1);
    expect(res!.mergesLedger.reachable).toBe(true);
    expect(res!.mergesLedger.partial).toBe(true);
    expect(res!.mergesLedger.errors).toEqual(["claude-usage merges: connect ECONNREFUSED"]);
    // The FACTS leg answered in full and its own state does not move for this.
    expect(res!.ledger.partial).toBe(false);
    expect(res!.ledger.reachable).toBe(true);
  });

  test("upstream's `limit` rides the state, so the footer can name ITS cap", async () => {
    const res = await pageProvenance(
      meta([SESSION_A]),
      ctx({
        sessionLedger: deps({
          fetchMerges: async () => ({ merges: [], truncated: true, limit: 500 }),
        }),
      }),
    );
    expect(res!.mergesLedger.truncated).toBe(true);
    expect(res!.mergesLedger.limit).toBe(500);
  });

  test("ids are batched by the SAME bounds the facts leg uses", async () => {
    const ids = Array.from({ length: SESSION_IDS_PER_CALL + 1 }, (_, i) => `id-${i}`);
    const batches: number[] = [];
    await pageProvenance(
      meta(ids),
      ctx({
        sessionLedger: deps({
          fetchMerges: async (batch) => {
            batches.push(batch.length);
            return { merges: [] };
          },
        }),
      }),
    );
    expect(batches).toEqual([SESSION_IDS_PER_CALL, 1]);
  });

  test("a whitespace-only `sessions:` entry arms no timer — the gate reads the DEDUPED list", async () => {
    // `pageProvenance` hoisted `resolveProvenance`'s gate so both legs could
    // share one deadline, and hoisted it off the RAW list: `dedupeSessionRefs`
    // drops a blank entry, so this page asks nothing and — before this — armed a
    // 10 s timer to bound the nothing.
    //
    // The timer is the only observable, so it is what is counted. Patched and
    // restored in-process; no other case in this file creates one concurrently.
    const realTimeout = AbortSignal.timeout;
    let armed = 0;
    (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = ((ms: number) => {
      armed += 1;
      return realTimeout.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;
    const asked: string[][] = [];
    try {
      const res = await pageProvenance(
        // No `jira:` key: a huginn lookup is its own reason to arm one.
        meta(["   ", "\t"]),
        ctx({
          sessionLedger: deps({
            fetchSessions: async (batch) => {
              asked.push(batch);
              return { sessions: [] };
            },
            fetchMerges: async (batch) => {
              asked.push(batch);
              return { merges: [] };
            },
          }),
        }),
      );
      // The page still HAS provenance — two refs, neither of them askable.
      expect(res).not.toBeNull();
      expect(asked).toEqual([]);
      expect(armed).toBe(0);
      // And the merges half says "nobody asked", not "the service failed".
      expect(res!.mergesLedger.asked).toBe(false);
    } finally {
      (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = realTimeout;
    }
  });

  test("an id that cannot BE an id is not sent to this route either", async () => {
    const asked: string[][] = [];
    await pageProvenance(
      meta([SESSION_A, `claude-code:${"y".repeat(SESSION_ID_MAX_CHARS + 1)}`]),
      ctx({
        sessionLedger: deps({
          fetchMerges: async (batch) => {
            asked.push(batch);
            return { merges: [] };
          },
        }),
      }),
    );
    expect(asked).toEqual([[ID_A]]);
  });

  test("the two legs START together — the page open is not their sum", async () => {
    const order: string[] = [];
    let releaseSessions = () => {};
    const gate = new Promise<void>((r) => (releaseSessions = r));
    await pageProvenance(
      meta([SESSION_A]),
      ctx({
        sessionLedger: deps({
          fetchSessions: async (ids) => {
            order.push("sessions");
            // The merges leg must already be in flight while this one waits; a
            // sequential `await` would deadlock this test rather than slow it.
            await gate;
            return { sessions: ids.map((id) => facts(id, 1)) };
          },
          fetchMerges: async () => {
            order.push("merges");
            releaseSessions();
            return { merges: [] };
          },
        }),
      }),
    );
    expect(order).toEqual(["sessions", "merges"]);
  });

  test("ONE deadline covers both legs — a hanging merges route cannot add a second", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const res = await pageProvenance(
      meta([SESSION_A]),
      ctx({
        budgetMs: 120,
        sessionLedger: deps({
          fetchSessions: (_ids, signal) => {
            seen.push(signal);
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("TimeoutError")), { once: true });
            });
          },
          fetchMerges: (_ids, signal) => {
            seen.push(signal);
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("TimeoutError")), { once: true });
            });
          },
        }),
      }),
    );
    // "One timer" is proved by SIGNAL IDENTITY, not by a stopwatch: the elapsed
    // time of two 120 ms legs on a loaded CI runner is a fact about the runner,
    // and a wall-clock bound that passes on this laptop is exactly the assertion
    // that goes red for nobody's fault.
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).toBe(seen[1]);
    expect(res!.ledger.reachable).toBe(false);
    expect(res!.mergesLedger.reachable).toBe(false);
  });
});

// ── Test hermeticity ────────────────────────────────────────────────────────

describe("ambient env", () => {
  test("both claude-usage endpoints are blanked for suites and for spawned e2e servers", () => {
    // This laptop's `.env` sets `CLAUDE_USAGE_URL` and the mini's does not, so
    // an inherited value takes the fetching branch on one machine and the
    // unconfigured branch on the other — green here, red there, from a name no
    // assertion mentions.
    expect(AMBIENT_INSTANCE_ENV).toContain("CLAUDE_USAGE_URL");
    expect(AMBIENT_INSTANCE_ENV).toContain("CLAUDE_USAGE_PUBLIC_URL");
  });
});
