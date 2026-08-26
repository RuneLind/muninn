import { describe, test, expect, beforeEach } from "bun:test";
import {
  AUDIT_DEDUP_WINDOW_MS,
  auditAdminCollectionRead,
  auditAdminPassthrough,
  __resetAuditDedupForTest,
} from "./audit.ts";
import { activityLog } from "../observability/activity-log.ts";
import type { ActivityEvent } from "../types.ts";

function capture(fn: () => void): ActivityEvent[] {
  const rows: ActivityEvent[] = [];
  const stop = activityLog.subscribe((e) => rows.push(e));
  try {
    fn();
  } finally {
    stop();
  }
  return rows;
}

beforeEach(__resetAuditDedupForTest);

describe("the entra gate", () => {
  test("nothing is audited in `off` or `local` mode", () => {
    const rows = capture(() => {
      expect(auditAdminPassthrough({ mode: "off", reader: "a", owner: "b", path: "/x", kind: "trace" })).toBe(false);
      expect(auditAdminPassthrough({ mode: "local", reader: "a", owner: "b", path: "/x", kind: "trace" })).toBe(false);
      expect(auditAdminCollectionRead({ mode: "local", reader: "a", path: "/api/traces" })).toBe(false);
    });
    expect(rows).toEqual([]);
  });
});

describe("the passthrough shape", () => {
  test("names the reader AND the owner, as type `system`", () => {
    // `activity_log.type` carries a DB CHECK and `push` persists with a
    // swallowed `.catch`, so a TS-only `"audit"` type would render on the live
    // feed and never reach the table. The shape is carried by the metadata.
    const rows = capture(() =>
      auditAdminPassthrough({ mode: "entra", reader: "A123456", owner: "B999999", path: "/api/traces/abc", kind: "trace" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("system");
    expect(rows[0]!.userId).toBe("A123456");
    expect(rows[0]!.text).toContain("A123456");
    expect(rows[0]!.text).toContain("B999999");
    expect(rows[0]!.metadata).toMatchObject({
      audit: "admin-passthrough", reader: "A123456", owner: "B999999", route: "/api/traces/abc", kind: "trace",
    });
  });

  test("is NOT deduped — every cross-user read of a row is its own fact", () => {
    const rows = capture(() => {
      for (let i = 0; i < 3; i++) {
        auditAdminPassthrough({ mode: "entra", reader: "A123456", owner: "B999999", path: "/api/traces/abc", kind: "trace" });
      }
    });
    expect(rows).toHaveLength(3);
  });
});

describe("the collection shape", () => {
  test("names the reader and the ROUTE, with no owner field", () => {
    const rows = capture(() => auditAdminCollectionRead({ mode: "entra", reader: "A123456", path: "/api/threads" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ audit: "admin-collection-read", reader: "A123456", route: "/api/threads" });
    expect(rows[0]!.metadata?.owner).toBeUndefined();
  });

  test("one row per (reader, route) per window, and the window really expires", () => {
    const t0 = 1_700_000_000_000;
    const rows = capture(() => {
      expect(auditAdminCollectionRead({ mode: "entra", reader: "A", path: "/api/traces", now: t0 })).toBe(true);
      expect(auditAdminCollectionRead({ mode: "entra", reader: "A", path: "/api/traces", now: t0 + 1_000 })).toBe(false);
      // A DIFFERENT reader, and a different route, are different keys.
      expect(auditAdminCollectionRead({ mode: "entra", reader: "B", path: "/api/traces", now: t0 + 1_000 })).toBe(true);
      expect(auditAdminCollectionRead({ mode: "entra", reader: "A", path: "/api/threads", now: t0 + 1_000 })).toBe(true);
      // …and the window is a window, not a latch.
      expect(auditAdminCollectionRead({ mode: "entra", reader: "A", path: "/api/traces", now: t0 + AUDIT_DEDUP_WINDOW_MS })).toBe(true);
    });
    expect(rows).toHaveLength(4);
  });
});
