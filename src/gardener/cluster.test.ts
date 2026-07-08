import { test, expect, describe } from "bun:test";
import { parseClusters, filterClusters, excerptOf, buildClusterPrompt } from "./cluster.ts";
import type { Cluster, HarvestedDoc } from "./types.ts";

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
    minClusterSize: 3,
    maxProposalsPerRun: 3,
    liveTopicKeys: new Set<string>(),
    rejectedTopicKeys: new Set<string>(),
  };

  test("drops unknown docIds then applies minClusterSize", () => {
    const c = { ...base, docIds: ["c/1", "c/2", "hallucinated"] };
    expect(filterClusters([c], opts)).toHaveLength(0); // only 2 valid < 3
  });

  test("skips clusters with a rejected topicKey", () => {
    const out = filterClusters([base], { ...opts, rejectedTopicKeys: new Set(["t"]) });
    expect(out).toHaveLength(0);
  });

  test("skips clusters with a live (draft/approved) topicKey", () => {
    const out = filterClusters([base], { ...opts, liveTopicKeys: new Set(["t"]) });
    expect(out).toHaveLength(0);
  });

  test("caps at maxProposalsPerRun, largest first", () => {
    const clusters: Cluster[] = [
      { ...base, topicKey: "small", docIds: ["c/1", "c/2", "c/3"] },
      { ...base, topicKey: "big", docIds: ["c/1", "c/2", "c/3", "c/4"] },
      { ...base, topicKey: "mid", docIds: ["c/1", "c/2", "c/3"] },
    ];
    const out = filterClusters(clusters, { ...opts, maxProposalsPerRun: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.topicKey).toBe("big");
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
});
