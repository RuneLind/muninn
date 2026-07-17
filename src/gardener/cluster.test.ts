import { test, expect, describe } from "bun:test";
import {
  parseClusters,
  filterClusters,
  gateResolvedClusters,
  excerptOf,
  buildClusterPrompt,
  summarizeClusterDrops,
  type ClusterDropEntry,
  type ResolvedCluster,
} from "./cluster.ts";
import type { Cluster, HarvestedDoc, ResolvedTarget } from "./types.ts";

function doc(key: string): HarvestedDoc {
  return { key, collection: "c", id: key, url: "", title: key, text: "body" };
}

describe("parseClusters", () => {
  test("parses valid clusters, dropping malformed", () => {
    const raw = JSON.stringify([
      { topicKey: "ctx-compaction", kind: "concept", domain: "ai", label: "Context Compaction", docIds: ["c/1", "c/2"], rationale: "why" },
      { topicKey: "", kind: "concept", domain: "ai", label: "no key", docIds: [] }, // dropped (no key)
      { topicKey: "bad-kind", kind: "widget", domain: "ai", label: "x", docIds: [] }, // dropped (kind)
      { topicKey: "bad-domain", kind: "concept", domain: "space", label: "x", docIds: [] }, // dropped (domain)
    ]);
    const clusters = parseClusters(raw);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.topicKey).toBe("ctx-compaction");
    expect(clusters[0]!.docIds).toEqual(["c/1", "c/2"]);
  });

  test("tolerates markdown fences", () => {
    const raw = "```json\n[{\"topicKey\":\"t\",\"kind\":\"entity\",\"domain\":\"life\",\"label\":\"L\",\"docIds\":[\"c/1\"]}]\n```";
    expect(parseClusters(raw)).toHaveLength(1);
  });

  test("returns [] on unparseable output", () => {
    expect(parseClusters("not json")).toEqual([]);
  });
});

describe("filterClusters", () => {
  const base: Cluster = {
    topicKey: "t", kind: "concept", domain: "ai", label: "T", docIds: ["c/1", "c/2", "c/3"],
  };
  const validDocKeys = new Set(["c/1", "c/2", "c/3", "c/4"]);
  const opts = {
    validDocKeys,
    skipTopicKeys: new Set<string>(),
  };

  test("strips unknown docIds; the cluster survives (size is judged post-resolve)", () => {
    const c = { ...base, docIds: ["c/1", "c/2", "hallucinated"] };
    const { kept } = filterClusters([c], opts);
    expect(kept).toHaveLength(1); // NOT size-dropped here — 2 valid docs remain
    expect(kept[0]!.docIds).toEqual(["c/1", "c/2"]); // hallucinated id stripped
  });

  test("skips clusters whose topicKey is in skipTopicKeys (rejected or live)", () => {
    const { kept } = filterClusters([base], { ...opts, skipTopicKeys: new Set(["t"]) });
    expect(kept).toHaveLength(0);
  });

  test("dedupes repeated topicKeys within the run (first wins)", () => {
    const dup = { ...base, docIds: ["c/1", "c/2", "c/3", "c/4"] }; // larger, but second
    const { kept } = filterClusters([base, dup], opts);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.docIds).toEqual(base.docIds); // the FIRST occurrence survived
  });
});

describe("filterClusters drop taxonomy (pre-resolve: hallucinated / skip / duplicate)", () => {
  const validDocKeys = new Set(["c/1", "c/2", "c/3", "c/4", "c/5", "c/6"]);
  const opts = {
    validDocKeys,
    skipTopicKeys: new Set<string>(),
  };
  const cluster = (topicKey: string, docIds: string[], kind: "concept" | "entity" = "concept"): Cluster => ({
    topicKey,
    kind,
    domain: "ai",
    label: topicKey,
    docIds,
  });
  const only = (dropped: ClusterDropEntry[], topicKey: string) =>
    dropped.find((d) => d.topicKey === topicKey)!;

  test("hallucinated: every docId invalid ⇒ post-strip count 0", () => {
    const { kept, dropped } = filterClusters([cluster("halluc", ["x/1", "x/2", "x/3"])], opts);
    expect(kept).toHaveLength(0);
    const entry = only(dropped, "halluc");
    expect(entry.reason).toBe("hallucinated");
    expect(entry.size).toBe(0);
    expect(entry.stripped).toBe(3);
  });

  test("partial strip below threshold survives filter (size deferred to the gate), strip applied", () => {
    const { kept, dropped } = filterClusters([cluster("partial", ["c/1", "c/2", "x/9"])], opts);
    expect(kept).toHaveLength(1); // 2 valid docs remain — no size drop here anymore
    expect(kept[0]!.docIds).toEqual(["c/1", "c/2"]); // invalid id stripped
    expect(dropped).toHaveLength(0);
  });

  test("skip: topicKey in the skip set ⇒ skip", () => {
    const { kept, dropped } = filterClusters([cluster("live", ["c/1", "c/2", "c/3"])], {
      ...opts,
      skipTopicKeys: new Set(["live"]),
    });
    expect(kept).toHaveLength(0);
    expect(only(dropped, "live").reason).toBe("skip");
  });

  test("duplicate: repeated topicKey within the run ⇒ duplicate (first kept)", () => {
    const { kept, dropped } = filterClusters(
      [cluster("dup", ["c/1", "c/2", "c/3"]), cluster("dup", ["c/1", "c/2", "c/3", "c/4"])],
      opts,
    );
    expect(kept).toHaveLength(1);
    expect(only(dropped, "dup").reason).toBe("duplicate");
  });
});

describe("gateResolvedClusters (post-resolve: CREATE-only size floor + shared cap)", () => {
  const cluster = (topicKey: string, docIds: string[], kind: "concept" | "entity" = "concept"): Cluster => ({
    topicKey,
    kind,
    domain: "ai",
    label: topicKey,
    docIds,
  });
  const rc = (
    topicKey: string,
    docIds: string[],
    mode: "create" | "update",
  ): ResolvedCluster => {
    const target: ResolvedTarget =
      mode === "update"
        ? { mode: "update", targetPath: `concepts/${topicKey}.md`, existingRelPath: `concepts/${topicKey}.md` }
        : { mode: "create", targetPath: `concepts/${topicKey}.md` };
    return { cluster: cluster(topicKey, docIds), target };
  };
  const only = (dropped: ClusterDropEntry[], topicKey: string) =>
    dropped.find((d) => d.topicKey === topicKey)!;
  const opts = { minClusterSize: 3, maxProposalsPerRun: 3 };

  test("size: a CREATE cluster below minClusterSize is dropped", () => {
    const { kept, dropped } = gateResolvedClusters([rc("small", ["c/1", "c/2"], "create")], opts);
    expect(kept).toHaveLength(0);
    const entry = only(dropped, "small");
    expect(entry.reason).toBe("size");
    expect(entry.size).toBe(2);
    expect(entry.stripped).toBeUndefined(); // strip happened at the filter, not here
  });

  test("a 1-doc UPDATE cluster survives the size floor", () => {
    const { kept, dropped } = gateResolvedClusters([rc("covered", ["c/1"], "update")], opts);
    expect(kept.map((r) => r.cluster.topicKey)).toEqual(["covered"]);
    expect(dropped).toHaveLength(0);
  });

  test("a CREATE cluster at/above minClusterSize survives", () => {
    const { kept } = gateResolvedClusters([rc("ok", ["c/1", "c/2", "c/3"], "create")], opts);
    expect(kept.map((r) => r.cluster.topicKey)).toEqual(["ok"]);
  });

  test("cap reservation: a 1-doc update survives a FULL cap that a larger create fills", () => {
    // max=1: largest-first alone would keep only the big create and evict the update.
    const { kept, dropped } = gateResolvedClusters(
      [rc("big", ["c/1", "c/2", "c/3", "c/4", "c/5"], "create"), rc("upd", ["c/1"], "update")],
      { ...opts, maxProposalsPerRun: 1 },
    );
    expect(kept.map((r) => r.cluster.topicKey)).toEqual(["upd"]); // reserved slot wins
    expect(only(dropped, "big").reason).toBe("cap");
  });

  test("cap reservation: only the TOP update is reserved when several updates exist", () => {
    // max=2: reserve the largest update (updBig, n:3); the create fills the other
    // slot largest-first; the small update (n:1) is capped.
    const { kept, dropped } = gateResolvedClusters(
      [
        rc("create5", ["c/1", "c/2", "c/3", "c/4", "c/5"], "create"),
        rc("updBig", ["c/1", "c/2", "c/3"], "update"),
        rc("updSmall", ["c/6"], "update"),
      ],
      { ...opts, maxProposalsPerRun: 2 },
    );
    expect(kept.map((r) => r.cluster.topicKey).sort()).toEqual(["create5", "updBig"]);
    expect(only(dropped, "updSmall").reason).toBe("cap");
  });

  test("cap: no update present ⇒ plain largest-first (smallest capped)", () => {
    const { kept, dropped } = gateResolvedClusters(
      [rc("big", ["c/1", "c/2", "c/3", "c/4"], "create"), rc("small", ["c/1", "c/2", "c/3"], "create")],
      { ...opts, maxProposalsPerRun: 1 },
    );
    expect(kept.map((r) => r.cluster.topicKey)).toEqual(["big"]);
    expect(only(dropped, "small").reason).toBe("cap");
  });
});

describe("summarizeClusterDrops", () => {
  test("tallies per-reason counts and a compact, capped topics string", () => {
    const dropped: ClusterDropEntry[] = [
      { topicKey: "a", kind: "concept", size: 0, reason: "hallucinated", stripped: 3 },
      { topicKey: "b", kind: "concept", size: 2, reason: "size", stripped: 1 },
      { topicKey: "c", kind: "entity", size: 2, reason: "size" },
      { topicKey: "d", kind: "concept", size: 4, reason: "skip" },
    ];
    const s = summarizeClusterDrops(dropped);
    expect(s.clusters_dropped).toBe(4);
    expect(s.clusters_dropped_size).toBe(2);
    expect(s.clusters_dropped_hallucinated).toBe(1);
    expect(s.clusters_dropped_skip).toBe(1);
    expect(s.clusters_dropped_duplicate).toBe(0);
    expect(s.clusters_dropped_cap).toBe(0);
    expect(s.clusters_dropped_topics).toContain("a(hallucinated,n:0,strip:3)");
    expect(s.clusters_dropped_topics).toContain("c(size,n:2)");
    expect(s.clusters_dropped_topics.length).toBeLessThanOrEqual(500);
  });

  test("overflowing topics list is truncated to the 500-char cap", () => {
    const dropped = Array.from({ length: 50 }, (_, i) => ({
      topicKey: `very-long-topic-key-for-truncation-test-${String(i).padStart(3, "0")}`,
      kind: "concept" as const,
      size: 1,
      reason: "size" as const,
    }));
    const s = summarizeClusterDrops(dropped);
    expect(s.clusters_dropped).toBe(50);
    expect(s.clusters_dropped_topics.length).toBe(500);
  });

  test("empty tally ⇒ all zero, empty topics string", () => {
    const s = summarizeClusterDrops([]);
    expect(s.clusters_dropped).toBe(0);
    expect(s.clusters_dropped_topics).toBe("");
  });
});

describe("excerptOf", () => {
  test("strips frontmatter and headings", () => {
    const text = "---\ntype: concept\n---\n# Heading\n\nThe actual body sentence.";
    expect(excerptOf(text)).toBe("The actual body sentence.");
  });
});

describe("buildClusterPrompt", () => {
  test("includes doc ids and untrusted delimiter, plus rejected hint", () => {
    const prompt = buildClusterPrompt([doc("c/1")], { rejectedLabels: ["old-topic"] });
    expect(prompt).toContain("ID: c/1");
    expect(prompt).toContain("UNTRUSTED source material");
    expect(prompt).toContain("old-topic");
  });

  test("lists existing pages with the exact-title reuse rule", () => {
    const prompt = buildClusterPrompt([doc("c/1")], {
      existingPages: ["Agent Loops (aliases: AI Agent Loops)", "Context Engineering"],
    });
    expect(prompt).toContain("The wiki ALREADY has pages");
    expect(prompt).toContain("Agent Loops (aliases: AI Agent Loops)");
    expect(prompt).toContain("exact title (WITHOUT any aliases annotation)");
  });

  test("omits the existing-pages block when the wiki index is empty", () => {
    const prompt = buildClusterPrompt([doc("c/1")], { existingPages: [] });
    expect(prompt).not.toContain("The wiki ALREADY has pages");
  });
});
