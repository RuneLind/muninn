import { test, expect, describe, beforeAll } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import { activityLog } from "../observability/activity-log.ts";
import {
  auditAdminCollectionRead,
  auditAdminPassthrough,
  __resetAuditDedupForTest,
} from "../auth/audit.ts";
import { AUDITED_COLLECTION_PATHS } from "../auth/zones.ts";

setupTestDb();

/**
 * The audit rows, READ BACK FROM THE DATABASE.
 *
 * `ActivityLog.push` persists fire-and-forget with a swallowed `.catch`
 * (`src/observability/activity-log.ts`), so a feed-only assertion passes on a
 * row that never landed — and `activity_log.type` carries a DB CHECK, which is
 * exactly the kind of thing a swallowed catch hides. Hence a test that queries
 * the table rather than subscribing to the log.
 */
beforeAll(async () => {
  // `push` is a no-op until the log knows the DB is up.
  await activityLog.loadFromDb();
});

/**
 * The write is fire-and-forget, so poll rather than sleep a fixed amount.
 *
 * Selected on `user_id` rather than on `metadata->>'reader'` — which is now a
 * choice rather than a necessity. `saveActivity` used to pass
 * `JSON.stringify(metadata)` to a `jsonb` parameter, so the column held a JSON
 * *string* scalar and no `->>` could read it; that is fixed (`sql.json`), and
 * `metadata->>'audit'` works on rows written from here on. `meta()` below still
 * tolerates the string form, because rows written BEFORE the fix are still
 * scalars and nothing backfills them.
 */
async function waitForRows(marker: string, want: number): Promise<Array<Record<string, unknown>>> {
  const sql = getDb();
  for (let i = 0; i < 60; i++) {
    const rows = await sql`
      SELECT type, user_id, text, metadata FROM activity_log
      WHERE user_id = ${marker}
      ORDER BY created_at
    `;
    if (rows.length >= want) return rows as unknown as Array<Record<string, unknown>>;
    await Bun.sleep(50);
  }
  throw new Error(`only saw fewer than ${want} audit rows for ${marker} in the table`);
}

function meta(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.metadata;
  return typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
}

describe("the admin audit rows reach activity_log", () => {
  test("the passthrough shape lands, as type `system`, naming reader and owner", async () => {
    const reader = `audit-pass-${crypto.randomUUID()}`;
    auditAdminPassthrough({
      mode: "entra", reader, owner: "B999999", path: "/api/traces/abc", kind: "trace",
    });
    const rows = await waitForRows(reader, 1);
    expect(rows).toHaveLength(1);
    // The DB CHECK on `type` is the reason this test exists: a TS-only "audit"
    // value would compile, render on the feed, and be swallowed here.
    expect(rows[0]!.type).toBe("system");
    expect(rows[0]!.user_id).toBe(reader);
    expect(String(rows[0]!.text)).toContain("B999999");
    expect(meta(rows[0]!)).toMatchObject({ audit: "admin-passthrough", reader, owner: "B999999", kind: "trace" });
  });

  test("the collection shape lands for all seven collections / eight path entries", async () => {
    __resetAuditDedupForTest();
    const reader = `audit-coll-${crypto.randomUUID()}`;
    // Driven from the single path list the zone middleware reads, so a path
    // added there is covered here without a second hand-written enumeration.
    for (const path of AUDITED_COLLECTION_PATHS) auditAdminCollectionRead({ mode: "entra", reader, path });
    const rows = await waitForRows(reader, AUDITED_COLLECTION_PATHS.length);
    expect(rows).toHaveLength(AUDITED_COLLECTION_PATHS.length);
    // Compared as a SET: eight inserts land inside one `now()` tick, so
    // `created_at` cannot order them and an ordered assertion would be a flake.
    expect(rows.map((r) => String(meta(r).route)).sort()).toEqual([...AUDITED_COLLECTION_PATHS].sort());
    for (const row of rows) {
      expect(row.type).toBe("system");
      expect(meta(row)).toMatchObject({ audit: "admin-collection-read", reader });
      // No owner on this shape: a collection read has no single owner, and an
      // invented one would be the least trustworthy field in the table.
      expect(meta(row).owner).toBeUndefined();
    }
  });
});
