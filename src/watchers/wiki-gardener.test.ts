import { test, expect, describe } from "bun:test";
import { buildGardenerSeams, stampDraftClaudeSpan, buildWeeklyGardenerRun } from "./wiki-gardener.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import type { Tracer } from "../tracing/index.ts";
import type { ClusterDropEntry, ClusterDropTally } from "../gardener/cluster.ts";

const CONFIG = {} as Config;

function ctx(wikiCollections?: string[], tracer?: Tracer) {
  const botConfig = {
    name: "jarvis",
    connector: "claude-cli",
    wikiDir: "/tmp/wiki",
    wikiCollections,
  } as unknown as BotConfig;
  return { botConfig, config: CONFIG, apiUrl: "http://localhost:8321", wikiDir: "/tmp/wiki", tracer };
}

describe("buildGardenerSeams — searchRelated threading (silent no-op regression)", () => {
  test("provides searchRelated when wikiCollections is set", () => {
    const seams = buildGardenerSeams(ctx(["wiki", "wiki-life"]));
    expect(typeof seams.searchRelated).toBe("function");
  });

  test("omits searchRelated when wikiCollections is unset", () => {
    const seams = buildGardenerSeams(ctx(undefined));
    expect(seams.searchRelated).toBeUndefined();
  });

  test("omits searchRelated when wikiCollections is empty / all-blank", () => {
    expect(buildGardenerSeams(ctx([])).searchRelated).toBeUndefined();
    expect(buildGardenerSeams(ctx(["", "  "])).searchRelated).toBeUndefined();
  });

  test("still builds the core seams when a tracer is threaded in", () => {
    const tracer = { addChildSpan: () => "id", traceId: "t" } as unknown as Tracer;
    const seams = buildGardenerSeams(ctx(["wiki"], tracer));
    expect(typeof seams.callDraft).toBe("function");
    expect(typeof seams.callCluster).toBe("function");
  });
});

describe("stampDraftClaudeSpan — child-span-only draft telemetry", () => {
  test("adds a `claude` child under the draft stage span carrying model + tokens", () => {
    const calls: unknown[][] = [];
    const tracer = {
      addChildSpan: (...a: unknown[]) => {
        calls.push(a);
        return "span-id";
      },
    } as unknown as Tracer;

    stampDraftClaudeSpan(tracer, { model: "claude-sonnet-5", inputTokens: 1234, outputTokens: 567 }, 4200);

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("draft"); // parent stage label
    expect(calls[0]![1]).toBe("claude"); // child span name
    expect(calls[0]![2]).toBe(4200); // duration
    expect(calls[0]![3]).toEqual({ model: "claude-sonnet-5", inputTokens: 1234, outputTokens: 567 });
  });

  test("NEVER touches the root span — child-only invariant (no double-count)", () => {
    // A Proxy records every method the helper reaches for. The double-count guard
    // requires it to only ever call `addChildSpan` — never `finish`/`event`/`end`
    // (any of which could stamp tokens onto the watcher span's own attributes,
    // which `/agents` Recent would then surface a second time via the trace path).
    const touched: string[] = [];
    const tracer = new Proxy(
      {},
      {
        get: (_t, prop) => {
          touched.push(String(prop));
          return () => "span-id";
        },
      },
    ) as unknown as Tracer;

    stampDraftClaudeSpan(tracer, { model: "m", inputTokens: 1, outputTokens: 2 }, 5);

    expect(touched).toContain("addChildSpan");
    expect(touched).not.toContain("finish");
    expect(touched).not.toContain("error");
    expect(touched).not.toContain("event");
    expect(touched).not.toContain("start");
    expect(touched).not.toContain("end");
  });

  test("no-op when the tracer is undefined (drain path / tracing off)", () => {
    expect(() =>
      stampDraftClaudeSpan(undefined, { model: "m", inputTokens: 1, outputTokens: 2 }, 5),
    ).not.toThrow();
  });
});

describe("buildWeeklyGardenerRun — weekly-run snapshot shape (PR 2)", () => {
  const tally = (over: Partial<ClusterDropTally> = {}): ClusterDropTally => ({
    clusters_dropped: 0,
    clusters_dropped_size: 0,
    clusters_dropped_skip: 0,
    clusters_dropped_hallucinated: 0,
    clusters_dropped_duplicate: 0,
    clusters_dropped_cap: 0,
    clusters_dropped_topics: "",
    ...over,
  });

  test("clustersFound === kept + dropped, and dropped mirrors the tally count", () => {
    const dropped: ClusterDropEntry[] = [
      { topicKey: "a", kind: "concept", size: 4, reason: "cap" },
      { topicKey: "b", kind: "concept", size: 3, reason: "cap" },
    ];
    const snap = buildWeeklyGardenerRun(tally({ clusters_dropped: 23, clusters_dropped_cap: 23 }), 3, dropped, 999);
    expect(snap.finishedAt).toBe(999);
    expect(snap.kept).toBe(3);
    expect(snap.dropped).toBe(23);
    expect(snap.clustersFound).toBe(26); // 3 kept + 23 dropped
  });

  test("evictedTopics is the lossless structured tail (topicKey/reason/size), never the truncated string", () => {
    const dropped: ClusterDropEntry[] = [
      { topicKey: "rag-eval", kind: "concept", size: 4, reason: "cap", stripped: 1 },
      { topicKey: "agents", kind: "entity", size: 2, reason: "size" },
    ];
    const snap = buildWeeklyGardenerRun(tally({ clusters_dropped: 2 }), 0, dropped);
    expect(snap.evictedTopics).toEqual([
      { topicKey: "rag-eval", reason: "cap", size: 4 },
      { topicKey: "agents", reason: "size", size: 2 },
    ]);
  });

  test("empty drop list → clustersFound === kept, no evicted topics", () => {
    const snap = buildWeeklyGardenerRun(tally({ clusters_dropped: 0 }), 5, []);
    expect(snap.clustersFound).toBe(5);
    expect(snap.dropped).toBe(0);
    expect(snap.evictedTopics).toEqual([]);
  });
});
