import { describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { statusCategory } from "./rows.ts";
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
