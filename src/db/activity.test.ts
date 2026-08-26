import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeActivity } from "../test/fixtures.ts";
import { saveActivity, getRecentActivity, getActivityForJob } from "./activity.ts";
import { getDb } from "./client.ts";

setupTestDb();

describe("activity", () => {
  test("saveActivity stores an event", async () => {
    await saveActivity(makeActivity({ text: "test event" }));
    const events = await getRecentActivity(10);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.text === "test event")).toBe(true);
  });

  test("saveActivity with all fields", async () => {
    await saveActivity(makeActivity({
      type: "message_out",
      userId: "u1",
      username: "alice",
      botName: "bot1",
      text: "full event",
      durationMs: 1500,
      costUsd: 0.01,
    }));

    const events = await getRecentActivity(10);
    const event = events.find((e) => e.text === "full event")!;
    expect(event.type).toBe("message_out");
    expect(event.userId).toBe("u1");
    expect(event.username).toBe("alice");
    expect(event.botName).toBe("bot1");
    expect(event.durationMs).toBe(1500);
    expect(event.costUsd).toBe(0.01);
  });

  test("metadata is stored as a jsonb OBJECT, so `->>` can read it", async () => {
    // It was `JSON.stringify`d into a jsonb parameter, so postgres.js encoded
    // the already-serialised string a second time and every row held a JSON
    // *string* scalar. Three consequences, all live: `metadata->>'audit'` is
    // NULL for every admin-audit row (the PR that added them documents that key
    // as how you find one), `getActivityForJob`'s `metadata->>'watcherId'`
    // matches nothing at all, and `mapActivityRow` hands callers a string it
    // has cast to `Record<string, unknown>`.
    const marker = `jsonb-${crypto.randomUUID()}`;
    await saveActivity({
      type: "system",
      text: marker,
      metadata: { audit: "admin-passthrough", watcherId: "w-1" } as never,
    });
    const [row] = await getDb()`
      SELECT metadata->>'audit' AS audit, jsonb_typeof(metadata) AS kind
        FROM activity_log WHERE text = ${marker}
    `;
    expect(row!.kind).toBe("object");
    expect(row!.audit).toBe("admin-passthrough");

    // …and the read side hands back an object, not a string.
    const event = (await getRecentActivity(50)).find((e) => e.text === marker)!;
    expect(event.metadata).toMatchObject({ watcherId: "w-1" });
  });

  test("migration 074 repairs the historical double-encoded rows", async () => {
    // The write side is fixed, but every row written BEFORE it is still a JSON
    // *string* scalar, so `metadata->>'watcherId'` and `metadata->>'audit'` are
    // NULL for the whole of history — including every admin-audit row the PR
    // that added them documents that key as the way to find.
    //
    // `to_jsonb(<text>)` reproduces the pre-fix column value exactly: a jsonb
    // string, not the object. The test then applies the REAL migration file (a
    // fresh test database is baselined, so it has never run here) and asserts
    // the read works afterwards.
    const sql = getDb();
    const watcherId = `w-${crypto.randomUUID()}`;
    const good = `mangled-${crypto.randomUUID()}`;
    const junk = `junk-${crypto.randomUUID()}`;

    await sql`
      INSERT INTO activity_log (type, text, metadata)
      VALUES (${"system"}, ${good}, to_jsonb(${JSON.stringify({ watcherId, audit: "admin-passthrough" })}::text))
    `;
    // ⚠️ The guard case. `metadata` is written from arbitrary call-site objects,
    // and a single row whose inner text does not re-parse would abort a bulk
    // `UPDATE … WHERE jsonb_typeof(metadata) = 'string'` — and with it the whole
    // migration, permanently, on every instance carrying such a row.
    await sql`
      INSERT INTO activity_log (type, text, metadata)
      VALUES (${"system"}, ${junk}, to_jsonb(${"not json at all {"}::text))
    `;

    const before = await sql`SELECT jsonb_typeof(metadata) AS kind FROM activity_log WHERE text = ${good}`;
    expect(before[0]!.kind).toBe("string");

    const migration = await Bun.file(
      new URL("../../db/migrations/074-activity-metadata-unmangle.sql", import.meta.url).pathname,
    ).text();
    await sql.unsafe(migration);

    const [repaired] = await sql`
      SELECT jsonb_typeof(metadata) AS kind,
             metadata->>'watcherId' AS watcher_id,
             metadata->>'audit'     AS audit
        FROM activity_log WHERE text = ${good}
    `;
    expect(repaired!.kind).toBe("object");
    expect(repaired!.watcher_id).toBe(watcherId);
    expect(repaired!.audit).toBe("admin-passthrough");

    // The unparseable row survived the migration untouched, rather than taking
    // the migration down with it.
    const [left] = await sql`SELECT jsonb_typeof(metadata) AS kind, metadata #>> '{}' AS raw FROM activity_log WHERE text = ${junk}`;
    expect(left!.kind).toBe("string");
    expect(left!.raw).toBe("not json at all {");

    // …and the repaired row is now reachable through the query that was
    // silently matching nothing.
    const rows = await getActivityForJob(watcherId, "no-such-job-name");
    expect(rows.some((r) => r.text === good)).toBe(true);
  });

  test("getActivityForJob finds a row by its metadata watcherId", async () => {
    // The query that was silently matching nothing.
    const watcherId = `w-${crypto.randomUUID()}`;
    await saveActivity({ type: "system", text: "watcher ran", metadata: { watcherId } as never });
    const rows = await getActivityForJob(watcherId, "no-such-job-name");
    expect(rows.some((r) => r.text === "watcher ran")).toBe(true);
  });

  test("getRecentActivity returns in chronological order", async () => {
    await saveActivity(makeActivity({ text: "first" }));
    await saveActivity(makeActivity({ text: "second" }));
    await saveActivity(makeActivity({ text: "third" }));

    const events = await getRecentActivity(10);
    expect(events[0]!.text).toBe("first");
    expect(events[2]!.text).toBe("third");
  });

  test("getRecentActivity respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await saveActivity(makeActivity({ text: `event-${i}` }));
    }

    const events = await getRecentActivity(2);
    expect(events).toHaveLength(2);
  });

  test("getRecentActivity filters by botName", async () => {
    await saveActivity(makeActivity({ botName: "bot1", text: "bot1 event" }));
    await saveActivity(makeActivity({ botName: "bot2", text: "bot2 event" }));

    const events = await getRecentActivity(10, "bot1");
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe("bot1 event");
  });

  test("getRecentActivity returns all bots when botName not specified", async () => {
    await saveActivity(makeActivity({ botName: "bot1", text: "bot1" }));
    await saveActivity(makeActivity({ botName: "bot2", text: "bot2" }));

    const events = await getRecentActivity(10);
    expect(events).toHaveLength(2);
  });

  test("saveActivity with metadata", async () => {
    await saveActivity({
      type: "message_out",
      text: "with metadata",
      metadata: { totalMs: 1500, model: "sonnet", inputTokens: 100, outputTokens: 50 },
    });

    const events = await getRecentActivity(10);
    const event = events.find((e) => e.text === "with metadata")!;
    expect(event.metadata).toBeTruthy();
    // metadata is stored as JSON.stringify then JSONB — may be returned as string or object
    const meta = typeof event.metadata === "string" ? JSON.parse(event.metadata) : event.metadata;
    expect(meta.model).toBe("sonnet");
    expect(meta.totalMs).toBe(1500);
  });
});
