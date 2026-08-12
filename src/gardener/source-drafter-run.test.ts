import { test, expect, describe } from "bun:test";
import {
  clampSourceBacklogLimit,
  categoryFromDocId,
  selectSourceBacklogDocs,
  runSourceDraftBacklog,
  runSourceDraftForNewest,
  draftOneBacklogDoc,
  triggerSourceDraftFromCapture,
  SOURCE_BACKLOG_DEFAULT_LIMIT,
  SOURCE_BACKLOG_MAX_LIMIT,
  type SourceBacklogDeps,
} from "./source-drafter-run.ts";
import { categoryToDomain } from "../summaries/domain.ts";
import type { ListedDoc as BacklogListedDoc, WikiRefs } from "../wiki/ingest-backlog.ts";
import type { RawFetchedDoc } from "./types.ts";
import type { SourceDraftInput, SourceDraftOutcome } from "./source-drafter.ts";
import type { BotConfig } from "../bots/config.ts";
import { __setWikiReadonlyForTest } from "../wiki/readonly.ts";

const emptyRefs: WikiRefs = { urls: new Set(), idTokens: new Set() };

/** A youtube-style listed doc (11-char id). */
function ytDoc(n: number): BacklogListedDoc {
  const id = `vid${String(n).padStart(8, "0")}`; // 11 chars
  return { collection: "youtube-summaries", id, url: `https://youtu.be/${id}` };
}

const fakeBot = { name: "jarvis" } as unknown as BotConfig;

describe("categoryFromDocId", () => {
  test("derives the category prefix (drops the filename) — mirrors the Summaries page", () => {
    expect(categoryFromDocId("ai/rag/Retrieval-Augmented Generation.md")).toBe("ai/rag");
    expect(categoryFromDocId("health/Some Health Note.md")).toBe("health");
  });

  test("an unprefixed id ⇒ '' ⇒ categoryToDomain defaults to ai (never worse than status quo)", () => {
    expect(categoryFromDocId("abc12345678")).toBe("");
    expect(categoryToDomain(categoryFromDocId("abc12345678"))).toBe("ai");
  });

  test("feeds the right domain for a life-category doc id", () => {
    expect(categoryToDomain(categoryFromDocId("health/x.md"))).toBe("life");
    expect(categoryToDomain(categoryFromDocId("ai/rag/y.md"))).toBe("ai");
  });
});

describe("clampSourceBacklogLimit", () => {
  test("missing / non-finite / sub-1 → default", () => {
    expect(clampSourceBacklogLimit(undefined)).toBe(SOURCE_BACKLOG_DEFAULT_LIMIT);
    expect(clampSourceBacklogLimit(NaN)).toBe(SOURCE_BACKLOG_DEFAULT_LIMIT);
    expect(clampSourceBacklogLimit(0)).toBe(SOURCE_BACKLOG_DEFAULT_LIMIT);
    expect(clampSourceBacklogLimit(-5)).toBe(SOURCE_BACKLOG_DEFAULT_LIMIT);
  });
  test("in-range honored, floored", () => {
    expect(clampSourceBacklogLimit(1)).toBe(1);
    expect(clampSourceBacklogLimit(5)).toBe(5);
    expect(clampSourceBacklogLimit(3.9)).toBe(3);
  });
  test("above max clamps to max", () => {
    expect(clampSourceBacklogLimit(20)).toBe(SOURCE_BACKLOG_MAX_LIMIT);
    expect(clampSourceBacklogLimit(SOURCE_BACKLOG_MAX_LIMIT + 1)).toBe(SOURCE_BACKLOG_MAX_LIMIT);
  });
});

describe("selectSourceBacklogDocs", () => {
  test("returns the full uncovered queue (no cap — the loop applies the limit); undated keep order", () => {
    // These ytDocs are undated (no date + no date-prefix id), so oldest-first is a
    // stable no-op — they come back in their original listing order.
    const docs = [ytDoc(1), ytDoc(2), ytDoc(3), ytDoc(4)];
    const { queued, totalQueued } = selectSourceBacklogDocs(
      { "youtube-summaries": docs },
      emptyRefs,
      new Set(),
      new Set(),
    );
    expect(totalQueued).toBe(4);
    expect(queued.map((d) => d.id)).toEqual(docs.map((d) => d.id));
  });

  test("sorts OLDEST-first (R2 backfill), undated docs LAST", () => {
    // A mix: two dated docs (out of chronological order) + one undated. Oldest dated
    // first, newest dated next, undated (no date, no date-prefix) trailing.
    const older: BacklogListedDoc = { collection: "youtube-summaries", id: "old11111111", url: "https://youtu.be/old", date: "2024-01-05" };
    const newer: BacklogListedDoc = { collection: "youtube-summaries", id: "new11111111", url: "https://youtu.be/new", date: "2026-03-01" };
    const undated: BacklogListedDoc = { collection: "youtube-summaries", id: "undated1111", url: "https://youtu.be/und" };
    // Feed them newest, undated, oldest to prove the sort (not input order) decides.
    const { queued } = selectSourceBacklogDocs(
      { "youtube-summaries": [newer, undated, older] },
      emptyRefs,
      new Set(),
      new Set(),
    );
    expect(queued.map((d) => d.id)).toEqual(["old11111111", "new11111111", "undated1111"]);
  });

  test("DISMISSED docs are excluded from the queue AND from totalQueued", () => {
    // The prune verb must stop model spend on THIS seam too — not just the drain.
    // Subtracted after the partition (never inside `computeIngestBacklog`, which is
    // TTL-cached and shared with three other callers).
    const docs = [ytDoc(1), ytDoc(2), ytDoc(3)];
    const dismissed = new Set([`youtube-summaries/${docs[1]!.id}`]);
    const { queued, totalQueued } = selectSourceBacklogDocs(
      { "youtube-summaries": docs },
      emptyRefs,
      new Set(),
      new Set(),
      dismissed,
    );
    expect(totalQueued).toBe(2);
    expect(queued.map((d) => d.id)).toEqual([docs[0]!.id, docs[2]!.id]);
    // Omitting the arg is byte-identical to the pre-PR-2 behaviour.
    expect(
      selectSourceBacklogDocs({ "youtube-summaries": docs }, emptyRefs, new Set(), new Set()).totalQueued,
    ).toBe(3);
  });

  test("consumed / pending / url-referenced docs are excluded from the queue", () => {
    const docs = [ytDoc(1), ytDoc(2), ytDoc(3)];
    const consumed = new Set([`youtube-summaries/${docs[0]!.id}`]);
    const pending = new Set([`youtube-summaries/${docs[1]!.id}`]);
    // docs[2] credited by URL reference in the wiki.
    const refs: WikiRefs = { urls: new Set([docs[2]!.url!]), idTokens: new Set() };
    const { queued, totalQueued } = selectSourceBacklogDocs(
      { "youtube-summaries": docs },
      refs,
      consumed,
      pending,
    );
    expect(totalQueued).toBe(0);
    expect(queued).toEqual([]);
  });
});

/** Build stub deps; records the order of draftInput calls. */
function stubDeps(
  over: Partial<SourceBacklogDeps> & {
    docs?: BacklogListedDoc[];
    draft?: (input: SourceDraftInput) => Promise<SourceDraftOutcome>;
    fetch?: (collection: string, id: string) => Promise<RawFetchedDoc | null>;
  } = {},
): { deps: SourceBacklogDeps; draftCalls: string[] } {
  const draftCalls: string[] = [];
  const docs = over.docs ?? [ytDoc(1), ytDoc(2), ytDoc(3), ytDoc(4), ytDoc(5)];
  const deps: SourceBacklogDeps = {
    listDocs: over.listDocs ?? (async () => docs),
    sweepWikiRefs: over.sweepWikiRefs ?? (async () => emptyRefs),
    getConsumed: over.getConsumed ?? (async () => new Set<string>()),
    getPending: over.getPending ?? (async () => new Set<string>()),
    ...(over.getDismissed ? { getDismissed: over.getDismissed } : {}),
    fetchDoc:
      over.fetch ??
      (async (_c, id) => ({ text: `body of ${id}`, metadata: { url: `https://youtu.be/${id}` } })),
    draftInput:
      over.draft ??
      (async (input) => {
        draftCalls.push(input.docId);
        return { outcome: "drafted", proposalId: `p-${input.docId}`, targetPath: "ai/sources/x.mdx", title: "X" };
      }),
  };
  return { deps, draftCalls };
}

describe("runSourceDraftBacklog", () => {
  // A degraded skip means the drafter ANSWERED and the answer was unusable — the
  // model calls were spent. Treating it as a free deterministic skip let a batch of
  // failing drafts walk the whole queue firing one-shots with `modelAttempts` at 0.
  test("a degraded skip consumes the model-attempt budget", async () => {
    const attempts: string[] = [];
    const { deps } = stubDeps({
      draft: async (input) => {
        attempts.push(input.docId);
        return { outcome: "skipped", reason: "draft has no frontmatter title", degraded: true };
      },
    });
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 2, "http://x", deps);
    expect(attempts.length).toBe(2);
    expect(res.totals.skipped).toBe(2);
    expect(res.results.every((r) => r.degraded === true)).toBe(true);
  });

  test("a non-degraded skip stays free and lets the batch reach deeper docs", async () => {
    const attempts: string[] = [];
    const { deps } = stubDeps({
      draft: async (input) => {
        attempts.push(input.docId);
        return attempts.length <= 3
          ? { outcome: "skipped", reason: "summary too thin" }
          : { outcome: "drafted", proposalId: "p", targetPath: "sources/x.mdx", title: "X" };
      },
    });
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 1, "http://x", deps);
    expect(attempts.length).toBe(4);
    expect(res.totals.drafted).toBe(1);
    expect(res.results.some((r) => r.degraded)).toBe(false);
  });

  test("drafts up to the limit sequentially and rolls up totals", async () => {
    const { deps, draftCalls } = stubDeps();
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 3, "http://x", deps);
    expect(res.limit).toBe(3);
    expect(res.totalQueued).toBe(5);
    expect(res.totals).toEqual({ selected: 3, drafted: 3, covered: 0, skipped: 0, error: 0 });
    // Sequential in listing order.
    expect(draftCalls).toEqual([res.results[0]!.docId, res.results[1]!.docId, res.results[2]!.docId]);
    expect(res.results[0]!.proposalId).toBe(`p-${res.results[0]!.docId}`);
  });

  test("scans past cheap skips: [skip, skip, draft, draft] with limit 1 drafts exactly the first draftable", async () => {
    // The two head docs have no url + fetch returns no body ⇒ cheap deterministic
    // skips (no model call). They must NOT consume the limit, so the loop reaches
    // the first draftable doc and drafts it; the limit is then spent (draft2 unreached).
    const skip1: BacklogListedDoc = { collection: "youtube-summaries", id: "skip00000001" };
    const skip2: BacklogListedDoc = { collection: "youtube-summaries", id: "skip00000002" };
    const draft1 = ytDoc(1);
    const draft2 = ytDoc(2);
    const { deps, draftCalls } = stubDeps({
      docs: [skip1, skip2, draft1, draft2],
      fetch: async (_c, id) =>
        id.startsWith("skip")
          ? { text: "", metadata: {} } // no body + no url ⇒ cheap skip
          : { text: `body of ${id}`, metadata: { url: `https://youtu.be/${id}` } },
    });
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 1, "http://x", deps);
    // Exactly ONE model attempt — the first draftable doc; draft2 is never reached.
    expect(draftCalls).toEqual([draft1.id]);
    expect(res.totals.drafted).toBe(1);
    expect(res.totals.skipped).toBe(2);
    // `selected` is the VISITED count (2 skips + 1 draft) — it exceeds the limit of 1.
    expect(res.totals.selected).toBe(3);
    expect(res.limit).toBe(1);
  });

  test("the batch honors the getDismissed seam — a dismissed doc is never drafted", async () => {
    const docs = [ytDoc(1), ytDoc(2), ytDoc(3)];
    const { deps, draftCalls } = stubDeps({
      docs,
      getDismissed: async () => new Set([`youtube-summaries/${docs[0]!.id}`]),
    });
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 3, "http://x", deps);
    expect(draftCalls).toEqual([docs[1]!.id, docs[2]!.id]);
    expect(res.totalQueued).toBe(2);
  });

  test("limit above max clamps to the hard cap", async () => {
    const docs = Array.from({ length: 20 }, (_, i) => ytDoc(i + 1));
    const { deps } = stubDeps({ docs });
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 99, "http://x", deps);
    expect(res.limit).toBe(SOURCE_BACKLOG_MAX_LIMIT);
    expect(res.totals.selected).toBe(SOURCE_BACKLOG_MAX_LIMIT);
  });

  test("a fetch throw is a per-doc error — the batch continues (skip-not-fail)", async () => {
    const docs = [ytDoc(1), ytDoc(2), ytDoc(3)];
    const { deps, draftCalls } = stubDeps({
      docs,
      fetch: async (_c, id) => {
        if (id === docs[1]!.id) throw new Error("boom");
        return { text: `body of ${id}`, metadata: { url: `https://youtu.be/${id}` } };
      },
    });
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 3, "http://x", deps);
    expect(res.totals).toEqual({ selected: 3, drafted: 2, covered: 0, skipped: 0, error: 1 });
    const errored = res.results.find((r) => r.outcome === "error")!;
    expect(errored.docId).toBe(docs[1]!.id);
    expect(errored.reason).toContain("boom");
    // The other two still drafted.
    expect(draftCalls).toEqual([docs[0]!.id, docs[2]!.id]);
  });

  test("no body / no url → skipped without a draft call", async () => {
    const docs = [ytDoc(1), ytDoc(2)];
    const { deps, draftCalls } = stubDeps({
      docs,
      fetch: async (_c, id) =>
        id === docs[0]!.id ? { text: "  ", metadata: {} } : { text: "real", metadata: {} },
    });
    // docs[1] carries a listing url (from ytDoc), so it drafts; docs[0] has blank body.
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 5, "http://x", deps);
    expect(res.totals.skipped).toBe(1);
    expect(res.totals.drafted).toBe(1);
    expect(draftCalls).toEqual([docs[1]!.id]);
  });

  test("covered outcome from the drafter is reported, not double-drafted", async () => {
    const { deps } = stubDeps({
      docs: [ytDoc(1)],
      draft: async () => ({ outcome: "covered", reason: "url already referenced in the wiki" }),
    });
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 3, "http://x", deps);
    expect(res.totals).toEqual({ selected: 1, drafted: 0, covered: 1, skipped: 0, error: 0 });
    expect(res.results[0]!.reason).toContain("already referenced");
  });

  test("a draftInput throw is contained as an error outcome", async () => {
    const { deps } = stubDeps({
      docs: [ytDoc(1)],
      draft: async () => {
        throw new Error("setup exploded");
      },
    });
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 3, "http://x", deps);
    expect(res.totals.error).toBe(1);
    expect(res.results[0]!.reason).toContain("setup exploded");
  });

  test("empty queue → nothing selected, clean zero totals", async () => {
    const { deps, draftCalls } = stubDeps({ docs: [] });
    const res = await runSourceDraftBacklog(fakeBot, "/wiki", "youtube-summaries", 3, "http://x", deps);
    expect(res.totalQueued).toBe(0);
    expect(res.totals.selected).toBe(0);
    expect(draftCalls).toEqual([]);
  });
});

/**
 * The FOURTH selection seam. "Draft newest" picks the newest doc in a collection, and
 * without the prune seam it spends a real model one-shot on a doc a human explicitly
 * dismissed — the drain, the source-drafter backlog and the weekly harvest all exclude
 * the same set. Both cases below stop BEFORE any model call.
 */
describe("runSourceDraftForNewest — the dismissed seam", () => {
  const listing = [
    { id: "newest", url: "https://youtu.be/newest", date: "2026-02-02" },
    { id: "older", url: "https://youtu.be/older", date: "2026-01-01" },
  ];

  /** Stub huginn: the collection listing, then a body-less document fetch. */
  function stubFetch(calls: string[]): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const body = url.includes("/documents")
        ? { documents: listing }
        : { text: "", metadata: {} }; // body-less ⇒ a "skipped" outcome, no model call
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  test("skips a dismissed newest doc and falls through to the next one", async () => {
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch(calls);
    try {
      const outcome = await runSourceDraftForNewest(
        fakeBot,
        "/tmp/does-not-matter",
        "youtube-summaries",
        "http://huginn.test",
        async () => new Set(["youtube-summaries/newest"]),
      );
      // It reached the SECOND doc — the dismissed newest was never fetched or drafted.
      expect(outcome.outcome).toBe("skipped");
      expect("reason" in outcome ? outcome.reason : "").toContain("older");
      expect(calls.some((u) => u.includes("newest"))).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("an entirely dismissed collection short-circuits before any doc fetch", async () => {
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch(calls);
    try {
      const outcome = await runSourceDraftForNewest(
        fakeBot,
        "/tmp/does-not-matter",
        "youtube-summaries",
        "http://huginn.test",
        async () => new Set(["youtube-summaries/newest", "youtube-summaries/older"]),
      );
      expect(outcome.outcome).toBe("skipped");
      expect("reason" in outcome ? outcome.reason : "").toContain("dismissed");
      // Only the listing was fetched — no per-doc fetch, no model call.
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("/documents");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("no seam (absent getDismissed) is byte-identical to the pre-prune behaviour", async () => {
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = stubFetch(calls);
    try {
      const outcome = await runSourceDraftForNewest(
        fakeBot,
        "/tmp/does-not-matter",
        "youtube-summaries",
        "http://huginn.test",
      );
      expect(outcome.outcome).toBe("skipped");
      expect("reason" in outcome ? outcome.reason : "").toContain("newest");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

// The pre-model guards are drafter entry points too. Without the `recordAttempt`
// seam they return before `draftInput` (which owns the ledger write), so a row whose
// doc can't be fetched shows nothing — the exact invisibility the ledger exists to
// end.
describe("draftOneBacklogDoc — pre-model outcomes reach the ledger", () => {
  const recorder = () => {
    const calls: { id: string; outcome: string; reason: string }[] = [];
    return {
      calls,
      recordAttempt: async (_c: string, id: string, o: { outcome: string; reason: string }) => {
        calls.push({ id, outcome: o.outcome, reason: o.reason });
      },
    };
  };

  test("a failed doc fetch records an `error` attempt", async () => {
    const rec = recorder();
    const { deps } = stubDeps({
      fetch: async () => {
        throw new Error("API returned 404");
      },
    });
    const out = await draftOneBacklogDoc({ collection: "x-articles", id: "gone.md", url: "" }, {
      ...deps,
      recordAttempt: rec.recordAttempt,
    });
    expect(out.outcome).toBe("error");
    expect(rec.calls).toEqual([
      { id: "gone.md", outcome: "error", reason: "fetch failed: API returned 404" },
    ]);
  });

  test("no body and no public URL each record a `skipped` attempt", async () => {
    const rec = recorder();
    const { deps } = stubDeps({ fetch: async () => ({ text: "   ", metadata: {} }) });
    await draftOneBacklogDoc({ collection: "c", id: "empty.md", url: "" }, { ...deps, recordAttempt: rec.recordAttempt });

    const rec2 = recorder();
    const { deps: deps2 } = stubDeps({ fetch: async () => ({ text: "a real body", metadata: {} }) });
    await draftOneBacklogDoc({ collection: "c", id: "nourl.md", url: "" }, { ...deps2, recordAttempt: rec2.recordAttempt });

    expect(rec.calls[0]).toMatchObject({ outcome: "skipped", reason: "doc has no body" });
    expect(rec2.calls[0]).toMatchObject({ outcome: "skipped", reason: "doc has no public URL" });
  });

  test("the model path does NOT double-record — draftInput owns that write", async () => {
    const rec = recorder();
    const { deps } = stubDeps();
    const out = await draftOneBacklogDoc({ collection: "c", id: "ok.md", url: "" }, {
      ...deps,
      recordAttempt: rec.recordAttempt,
    });
    expect(out.outcome).toBe("drafted");
    expect(rec.calls).toEqual([]);
  });

  test("an absent seam is a no-op (the pre-ledger unit wiring still works)", async () => {
    const { deps } = stubDeps({
      fetch: async () => {
        throw new Error("boom");
      },
    });
    const out = await draftOneBacklogDoc({ collection: "c", id: "x.md", url: "" }, deps);
    expect(out.outcome).toBe("error");
  });

  test("a title override reaches draftInput; a blank one is dropped", async () => {
    const seen: (string | undefined)[] = [];
    const { deps } = stubDeps({
      draft: async (input) => {
        seen.push(input.titleOverride);
        return { outcome: "drafted", proposalId: "p", targetPath: "sources/x.mdx", title: "X" };
      },
    });
    await draftOneBacklogDoc({ collection: "c", id: "a.md", url: "" }, deps, "  A Chosen Title  ");
    await draftOneBacklogDoc({ collection: "c", id: "b.md", url: "" }, deps, "   ");
    await draftOneBacklogDoc({ collection: "c", id: "c.md", url: "" }, deps);
    expect(seen).toEqual(["A Chosen Title", undefined, undefined]);
  });
});

/**
 * The AUTO trigger is the drafter's widest entry point — fire-and-forget from six
 * capture summarizers, every one of them reachable over the tokenless HTTP surface
 * a readonly instance still serves. Left unguarded it mints proposals and burns
 * model calls on the machine that owns no writes.
 */
describe("triggerSourceDraftFromCapture — the readonly guard", () => {
  const botWithWiki = { name: "jarvis", wikiDir: "/tmp/wiki" } as unknown as BotConfig;
  const input = {
    collection: "youtube-summaries",
    docId: "vid00000001",
    url: "https://youtu.be/vid00000001",
    body: "A summary.",
    category: "youtube",
  } as unknown as SourceDraftInput;

  const spyRun = () => {
    const calls: string[] = [];
    return {
      calls,
      run: async (_b: BotConfig, _d: string, i: SourceDraftInput) => {
        calls.push(i.docId);
        return { outcome: "covered" } as unknown as SourceDraftOutcome;
      },
    };
  };

  test("an injected readonly flag skips the draft — the same call drafts without it", () => {
    const spy = spyRun();
    triggerSourceDraftFromCapture(botWithWiki, input, { isReadonly: () => true, run: spy.run });
    expect(spy.calls).toEqual([]);
    // Same bot, same input, one flag apart: the guard is the only difference.
    triggerSourceDraftFromCapture(botWithWiki, input, { isReadonly: () => false, run: spy.run });
    expect(spy.calls).toEqual(["vid00000001"]);
  });

  test("it defaults to the shared flag — a caller that injects nothing is still guarded", () => {
    const spy = spyRun();
    __setWikiReadonlyForTest(true);
    try {
      triggerSourceDraftFromCapture(botWithWiki, input, { run: spy.run });
      expect(spy.calls).toEqual([]);
    } finally {
      __setWikiReadonlyForTest();
    }
    triggerSourceDraftFromCapture(botWithWiki, input, { run: spy.run });
    expect(spy.calls).toEqual(["vid00000001"]);
  });
});
