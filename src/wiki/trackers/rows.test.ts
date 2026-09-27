import { describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { buildIssueKeyIndex, countingPageCount, coveringPlans, isPlanPage, issueKeyId, statusCategory } from "./rows.ts";
import type { TrackerConfig } from "./types.ts";

const config = { id: "jira", statusMap: { Ferdig: "done" } } as unknown as TrackerConfig;

describe("statusCategory", () => {
  test("S8: an unmapped status is logged once per wiki, naming the wiki root", async () => {
    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
      reset: true,
    });
    try {
      // A status no other test uses: the once-set is module-level.
      const status = "Rows Test Unmapped";
      expect(statusCategory(status, config, "/wikis/a")).toBe("unknown");
      expect(statusCategory(status, config, "/wikis/a")).toBe("unknown");
      expect(statusCategory(status, config, "/wikis/b")).toBe("unknown");
      expect(statusCategory(status, config, "/wikis/b")).toBe("unknown");
      expect(statusCategory("Ferdig", config, "/wikis/a")).toBe("done");
      const logged = records.filter((r) => r.category.join("/") === "muninn/wiki/trackers");
      expect(logged.map((r) => [r.properties.wiki, r.properties.status])).toEqual([
        ["/wikis/a", status],
        ["/wikis/b", status],
      ]);
    } finally {
      await reset();
    }
  });
});

describe("isPlanPage and a culled page", () => {
  const planConfig = { id: "jira", statusMap: {}, planTitle: /plan/i } as unknown as TrackerConfig;

  test("a culled page is never a plan, whichever rule would have made it one", () => {
    for (const page of [
      { relPath: "notes/x.md", title: "X", type: "plan" },
      { relPath: "plans/x.md", title: "X", type: "note" },
      { relPath: "notes/x.md", title: "Arbeidsplan", type: "note" },
    ]) {
      expect(isPlanPage(page, planConfig)).toBe(true);
      expect(isPlanPage({ ...page, culled: true }, planConfig)).toBe(false);
    }
  });

  test("a culled plan leaves the key's COVERAGE but stays in its page list", () => {
    const issues = [{ tracker: "jira", key: "DEMO-1", relations: ["title" as const] }];
    const keys = buildIssueKeyIndex(
      [
        { relPath: "plans/live.md", title: "DEMO-1 live", type: "plan", issues },
        { relPath: "plans/retired.md", title: "DEMO-1 retired", type: "plan", culled: true, issues },
      ],
      [planConfig],
    );
    const entry = keys.get(issueKeyId("jira", "DEMO-1"));
    expect(coveringPlans(entry).map((p) => p.relPath)).toEqual(["plans/live.md"]);
    expect(entry!.pages.map((p) => p.relPath)).toEqual(["plans/live.md", "plans/retired.md"]);
    expect(countingPageCount(entry)).toBe(2);
  });
});
