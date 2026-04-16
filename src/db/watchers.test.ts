import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { makeWatcher } from "../test/fixtures.ts";
import {
  saveWatcher,
  getWatchersDueNow,
  updateWatcherLastRun,
  getAllWatchers,
  getWatchersForUser,
  deleteWatcher,
  toggleWatcher,
  updateWatcher,
} from "./watchers.ts";
import { getDb } from "./client.ts";

setupTestDb();

describe("watchers", () => {
  test("saveWatcher returns an id", async () => {
    const id = await saveWatcher(makeWatcher());
    expect(id).toBeTruthy();
  });

  test("saveWatcher uses default interval for email (5min)", async () => {
    const id = await saveWatcher(makeWatcher({ type: "email" }));
    const all = await getAllWatchers();
    const watcher = all.find((w) => w.id === id)!;
    expect(watcher.intervalMs).toBe(300000);
  });

  test("saveWatcher uses 1 hour interval for news", async () => {
    const id = await saveWatcher(makeWatcher({ type: "news" }));
    const all = await getAllWatchers();
    const watcher = all.find((w) => w.id === id)!;
    expect(watcher.intervalMs).toBe(3600000);
  });

  test("saveWatcher uses custom interval when specified", async () => {
    const id = await saveWatcher(makeWatcher({ intervalMs: 60000 }));
    const all = await getAllWatchers();
    const watcher = all.find((w) => w.id === id)!;
    expect(watcher.intervalMs).toBe(60000);
  });

  test("saveWatcher stores config", async () => {
    const id = await saveWatcher(makeWatcher({ config: { filter: "from:github.com" } }));
    const all = await getAllWatchers();
    const watcher = all.find((w) => w.id === id)!;
    expect(watcher.config).toEqual({ filter: "from:github.com" });
  });

  test("getAllWatchers filters by botName", async () => {
    await saveWatcher(makeWatcher({ botName: "bot1", name: "bot1 watcher" }));
    await saveWatcher(makeWatcher({ botName: "bot2", name: "bot2 watcher" }));

    const watchers = await getAllWatchers("bot1");
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.name).toBe("bot1 watcher");
  });

  test("getWatchersForUser filters by userId", async () => {
    await saveWatcher(makeWatcher({ userId: "u1", botName: "bot1", name: "u1 watcher" }));
    await saveWatcher(makeWatcher({ userId: "u2", botName: "bot1", name: "u2 watcher" }));

    const watchers = await getWatchersForUser("u1", "bot1");
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.name).toBe("u1 watcher");
  });

  test("deleteWatcher removes the watcher", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1" }));
    await deleteWatcher(id);

    const all = await getAllWatchers("bot1");
    expect(all.find((w) => w.id === id)).toBeUndefined();
  });

  test("toggleWatcher enables/disables", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1" }));

    await toggleWatcher(id, false);
    let all = await getAllWatchers("bot1");
    expect(all.find((w) => w.id === id)!.enabled).toBe(false);

    await toggleWatcher(id, true);
    all = await getAllWatchers("bot1");
    expect(all.find((w) => w.id === id)!.enabled).toBe(true);
  });

  test("getWatchersDueNow returns watchers that have never run", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1" }));

    const due = await getWatchersDueNow("bot1");
    expect(due.some((w) => w.id === id)).toBe(true);
  });

  test("getWatchersDueNow excludes recently run watchers", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1" }));
    await updateWatcherLastRun(id, ["email-1"]);

    const due = await getWatchersDueNow("bot1");
    // Should not be due since it just ran (interval is 5min)
    expect(due.find((w) => w.id === id)).toBeUndefined();
  });

  test("getWatchersDueNow returns watchers past their interval", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1" }));

    // Set last_run_at to 10 minutes ago (interval is 5 min)
    const sql = getDb();
    await sql`UPDATE watchers SET last_run_at = now() - interval '10 minutes' WHERE id = ${id}`;

    const due = await getWatchersDueNow("bot1");
    expect(due.some((w) => w.id === id)).toBe(true);
  });

  test("getWatchersDueNow excludes disabled watchers", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1" }));
    await toggleWatcher(id, false);

    const due = await getWatchersDueNow("bot1");
    expect(due.find((w) => w.id === id)).toBeUndefined();
  });

  test("updateWatcherLastRun stores notified IDs", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1" }));
    await updateWatcherLastRun(id, ["email-1", "email-2"]);

    const all = await getAllWatchers("bot1");
    const watcher = all.find((w) => w.id === id)!;
    expect(watcher.lastNotifiedIds).toEqual(["email-1", "email-2"]);
    expect(watcher.lastRunAt).not.toBeNull();
  });

  test("getAllWatchers sorts enabled first", async () => {
    const id1 = await saveWatcher(makeWatcher({ botName: "bot1", name: "disabled" }));
    await toggleWatcher(id1, false);
    await saveWatcher(makeWatcher({ botName: "bot1", name: "enabled" }));

    const all = await getAllWatchers("bot1");
    expect(all[0]!.enabled).toBe(true);
  });

  test("updateWatcher does not touch last_run_at when interval is unchanged", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1", intervalMs: 300000 }));
    const sql = getDb();
    const pinned = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    await sql`UPDATE watchers SET last_run_at = ${pinned} WHERE id = ${id}`;

    // Editing an unrelated field must not shift the next fire time
    await updateWatcher(id, { name: "renamed" });
    let [row] = await sql`SELECT last_run_at FROM watchers WHERE id = ${id}`;
    expect(new Date(row!.last_run_at).getTime()).toBe(pinned.getTime());

    // Passing the SAME intervalMs also must not shift it (no-op "update")
    await updateWatcher(id, { intervalMs: 300000 });
    [row] = await sql`SELECT last_run_at FROM watchers WHERE id = ${id}`;
    expect(new Date(row!.last_run_at).getTime()).toBe(pinned.getTime());
  });

  test("updateWatcher resets last_run_at when interval actually changes", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1", intervalMs: 300000 }));
    const sql = getDb();
    const pinned = new Date(Date.now() - 60 * 60 * 1000);
    await sql`UPDATE watchers SET last_run_at = ${pinned} WHERE id = ${id}`;

    await updateWatcher(id, { intervalMs: 600000 });
    const [row] = await sql`SELECT last_run_at FROM watchers WHERE id = ${id}`;
    expect(new Date(row!.last_run_at).getTime()).toBeGreaterThan(pinned.getTime());
  });

  test("updateWatcher stores config as a proper JSONB object (regression: double-encoding)", async () => {
    const id = await saveWatcher(makeWatcher({ botName: "bot1" }));

    const nestedConfig = {
      model: "claude-sonnet-4-6",
      slackChannels: ["#a", "#b"],
      nested: { k: "v", n: 1 },
      minScore: 0.85,
      quietMode: true,
    };
    const updated = await updateWatcher(id, { config: nestedConfig });
    expect(updated?.config).toEqual(nestedConfig);

    // Raw JSONB shape check — previously stored as a JSON string inside JSONB,
    // which broke jsonb path queries like config->'slackChannels'.
    const sql = getDb();
    const [row] = await sql`
      SELECT
        jsonb_typeof(config) AS t,
        config->'slackChannels' AS channels,
        config->>'model' AS model,
        config->'nested'->>'k' AS nested_k
      FROM watchers WHERE id = ${id}
    `;
    expect(row!.t).toBe("object");
    expect(row!.channels).toEqual(["#a", "#b"]);
    expect(row!.model).toBe("claude-sonnet-4-6");
    expect(row!.nested_k).toBe("v");
  });
});
