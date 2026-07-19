import { test, expect, describe } from "bun:test";
import {
  clampSourceBacklogLimit,
  selectSourceBacklogDocs,
  runSourceDraftBacklog,
  SOURCE_BACKLOG_DEFAULT_LIMIT,
  SOURCE_BACKLOG_MAX_LIMIT,
  type SourceBacklogDeps,
} from "./source-drafter-run.ts";
import type { ListedDoc as BacklogListedDoc, WikiRefs } from "../wiki/ingest-backlog.ts";
import type { RawFetchedDoc } from "./types.ts";
import type { SourceDraftInput, SourceDraftOutcome } from "./source-drafter.ts";
import type { BotConfig } from "../bots/config.ts";

const emptyRefs: WikiRefs = { urls: new Set(), idTokens: new Set() };

/** A youtube-style listed doc (11-char id). */
function ytDoc(n: number): BacklogListedDoc {
  const id = `vid${String(n).padStart(8, "0")}`; // 11 chars
  return { collection: "youtube-summaries", id, url: `https://youtu.be/${id}` };
}

const fakeBot = { name: "jarvis" } as unknown as BotConfig;

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
  test("all uncovered when nothing credited; caps at limit; reports full queue", () => {
    const docs = [ytDoc(1), ytDoc(2), ytDoc(3), ytDoc(4)];
    const { selected, totalQueued } = selectSourceBacklogDocs(
      { "youtube-summaries": docs },
      emptyRefs,
      new Set(),
      new Set(),
      2,
    );
    expect(totalQueued).toBe(4);
    expect(selected.map((d) => d.id)).toEqual([docs[0]!.id, docs[1]!.id]);
  });

  test("consumed / pending / url-referenced docs are excluded from the queue", () => {
    const docs = [ytDoc(1), ytDoc(2), ytDoc(3)];
    const consumed = new Set([`youtube-summaries/${docs[0]!.id}`]);
    const pending = new Set([`youtube-summaries/${docs[1]!.id}`]);
    // docs[2] credited by URL reference in the wiki.
    const refs: WikiRefs = { urls: new Set([docs[2]!.url!]), idTokens: new Set() };
    const { selected, totalQueued } = selectSourceBacklogDocs(
      { "youtube-summaries": docs },
      refs,
      consumed,
      pending,
      10,
    );
    expect(totalQueued).toBe(0);
    expect(selected).toEqual([]);
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
