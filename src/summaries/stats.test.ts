import { test, expect, describe } from "bun:test";
import {
  lastMonths,
  monthKey,
  aggregateMonthly,
  partitionCoverage,
  docsInWindow,
  buildStats,
  type StatsDoc,
} from "./stats.ts";

const DAY = 86_400_000;
// A fixed reference instant: 2026-07-09T12:00:00Z.
const NOW = Date.parse("2026-07-09T12:00:00Z");

function doc(overrides: Partial<StatsDoc>): StatsDoc {
  return { collection: "youtube-summaries", id: "x", source: "youtube", ...overrides };
}

describe("lastMonths / monthKey", () => {
  test("returns the last N month keys oldest-first, crossing the year boundary", () => {
    expect(lastMonths(NOW, 8)).toEqual([
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
  });

  test("monthKey is UTC (a bare YYYY-MM-DD parses to UTC midnight)", () => {
    expect(monthKey(Date.parse("2026-07-01"))).toBe("2026-07");
    expect(monthKey(Date.parse("2026-01-31"))).toBe("2026-01");
  });
});

describe("aggregateMonthly", () => {
  test("groups per-source counts into the charted months", () => {
    const docs: StatsDoc[] = [
      doc({ id: "a", source: "youtube", dateMs: Date.parse("2026-07-02") }),
      doc({ id: "b", source: "youtube", dateMs: Date.parse("2026-07-08") }),
      doc({ id: "c", source: "x-article", dateMs: Date.parse("2026-07-05") }),
      doc({ id: "d", source: "x-article", dateMs: Date.parse("2026-06-15") }),
    ];
    const { months, bySource } = aggregateMonthly(docs, NOW, 8);
    expect(months).toHaveLength(8);

    const july = months.find((m) => m.month === "2026-07")!;
    expect(july.counts).toEqual({ youtube: 2, "x-article": 1 });
    expect(july.total).toBe(3);

    const june = months.find((m) => m.month === "2026-06")!;
    expect(june.counts).toEqual({ "x-article": 1 });
    expect(june.total).toBe(1);

    expect(bySource.youtube).toEqual({ inWindow: 2, undated: 0 });
    expect(bySource["x-article"]).toEqual({ inWindow: 2, undated: 0 });
  });

  test("undated docs go in the source's undated bucket, not any month", () => {
    const docs: StatsDoc[] = [
      doc({ id: "a", source: "tiktok" }), // no dateMs
      doc({ id: "b", source: "tiktok", dateMs: Date.parse("2026-07-01") }),
    ];
    const { months, bySource } = aggregateMonthly(docs, NOW, 8);
    expect(bySource.tiktok).toEqual({ inWindow: 1, undated: 1 });
    const totalCharted = months.reduce((n, m) => n + m.total, 0);
    expect(totalCharted).toBe(1); // only the dated one is charted
  });

  test("dated docs outside the charted window are ignored", () => {
    const docs: StatsDoc[] = [
      doc({ id: "old", source: "youtube", dateMs: Date.parse("2024-01-01") }),
      doc({ id: "new", source: "youtube", dateMs: Date.parse("2026-07-01") }),
    ];
    const { months, bySource } = aggregateMonthly(docs, NOW, 8);
    const totalCharted = months.reduce((n, m) => n + m.total, 0);
    expect(totalCharted).toBe(1);
    expect(bySource.youtube).toEqual({ inWindow: 1, undated: 0 });
  });
});

describe("partitionCoverage", () => {
  const windowDocs: StatsDoc[] = [
    doc({ collection: "youtube-summaries", id: "yt1" }),
    doc({ collection: "youtube-summaries", id: "yt2" }),
    doc({ collection: "x-articles", id: "xa1", source: "x-article", title: "Xarticle", url: "https://x/1" }),
    doc({ collection: "tiktok-summaries", id: "tt1", source: "tiktok" }),
  ];

  test("partitions into consumed / pending / never and reconciles the total", () => {
    const consumed = new Set(["youtube-summaries/yt1"]);
    const pending = new Set(["x-articles/xa1"]);
    const cov = partitionCoverage(windowDocs, consumed, pending, 30);

    expect(cov.total).toBe(4);
    expect(cov.consumed).toBe(1);
    expect(cov.pending).toBe(1);
    expect(cov.neverClustered).toHaveLength(2);
    // total = consumed + pending + neverClustered.length
    expect(cov.total).toBe(cov.consumed + cov.pending + cov.neverClustered.length);
    expect(cov.windowDays).toBe(30);
  });

  test("never-clustered rows carry title (fallback id) + url when present", () => {
    const cov = partitionCoverage(windowDocs, new Set(), new Set(), 30);
    const xa = cov.neverClustered.find((d) => d.id === "xa1")!;
    expect(xa.title).toBe("Xarticle");
    expect(xa.url).toBe("https://x/1");
    const tt = cov.neverClustered.find((d) => d.id === "tt1")!;
    expect(tt.title).toBe("tt1"); // no title ⇒ id fallback
    expect(tt.url).toBeUndefined();
  });

  test("consumed wins when a doc is in both sets", () => {
    const both = new Set(["youtube-summaries/yt1"]);
    const cov = partitionCoverage(windowDocs, both, both, 30);
    expect(cov.consumed).toBe(1);
    expect(cov.pending).toBe(0);
  });
});

describe("docsInWindow", () => {
  test("keeps dated docs at/after the cutoff and all undated docs", () => {
    const docs: StatsDoc[] = [
      doc({ id: "recent", dateMs: NOW - 5 * DAY }),
      doc({ id: "old", dateMs: NOW - 40 * DAY }),
      doc({ id: "undated" }),
    ];
    const kept = docsInWindow(docs, 30, NOW).map((d) => d.id).sort();
    expect(kept).toEqual(["recent", "undated"]);
  });
});

describe("buildStats", () => {
  test("assembles months + coverage + passes errors through", () => {
    const docs: StatsDoc[] = [
      doc({ collection: "youtube-summaries", id: "yt1", dateMs: NOW - 2 * DAY }),
      doc({ collection: "youtube-summaries", id: "yt2", dateMs: NOW - 3 * DAY }),
      doc({ collection: "anthropic-summaries", id: "an-old", source: "anthropic", dateMs: NOW - 200 * DAY }),
    ];
    const stats = buildStats({
      docs,
      consumed: new Set(["youtube-summaries/yt1"]),
      pending: new Set(),
      now: NOW,
      monthsBack: 8,
      windowDays: 30,
      errors: [{ source: "tiktok", collection: "tiktok-summaries", error: "unreachable" }],
    });

    expect(stats.months).toHaveLength(8);
    expect(stats.coverage.total).toBe(2); // an-old is out of the 30d window
    expect(stats.coverage.consumed).toBe(1);
    expect(stats.coverage.neverClustered).toHaveLength(1);
    expect(stats.errors).toEqual([
      { source: "tiktok", collection: "tiktok-summaries", error: "unreachable" },
    ]);
  });

  test("omits the errors key when there are none", () => {
    const stats = buildStats({ docs: [], consumed: new Set(), pending: new Set(), now: NOW });
    expect(stats.errors).toBeUndefined();
  });
});
