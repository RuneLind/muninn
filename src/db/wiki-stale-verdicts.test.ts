/**
 * `wiki_stale_verdicts` (migration 085) against the real test database: the
 * upsert on (wiki, kind, key_hash), the keyed read, the CHECKs and the 90-day
 * cleanup.
 */
import { describe, expect, test } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  cleanupOldStaleVerdicts,
  getStaleVerdicts,
  getStaleVerdictPages,
  STALE_VERDICT_RETENTION_DAYS,
  upsertStaleVerdict,
  type StaleVerdictInput,
} from "./wiki-stale-verdicts.ts";

setupTestDb();

const row = (over: Partial<StaleVerdictInput> = {}): StaleVerdictInput => ({
  wiki: "w",
  kind: "status-line",
  page: "hub.md",
  keyHash: "k1",
  verdict: "stale",
  reason: "shipped",
  edit: { old: "in-flight", new: "shipped", home: "" },
  checkedBy: "model:bot",
  ...over,
});

describe("wiki_stale_verdicts", () => {
  test("PR 3: a `fixed` row writes, and the pages with one are listed per wiki and kind", async () => {
    await upsertStaleVerdict(row({ kind: "fixed", verdict: "fixed", page: "notes/a.md", keyHash: "f1", edit: null, checkedBy: "reader" }));
    await upsertStaleVerdict(row({ kind: "fixed", verdict: "fixed", page: "notes/b.md", keyHash: "f2", edit: null, checkedBy: "reader" }));
    await upsertStaleVerdict(row({ kind: "passage", page: "notes/c.md", keyHash: "p1" }));
    await upsertStaleVerdict(row({ wiki: "other", kind: "fixed", verdict: "fixed", page: "notes/d.md", keyHash: "f3", edit: null, checkedBy: "reader" }));
    expect([...(await getStaleVerdictPages("w", "fixed"))].sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect((await getStaleVerdicts("w", "fixed", ["f1"])).get("f1")).toMatchObject({ verdict: "fixed", checkedBy: "reader" });
  });

  test("an upsert on the same (wiki, kind, key_hash) replaces the row; another kind or wiki is its own row", async () => {
    const first = await upsertStaleVerdict(row());
    expect(first).toMatchObject({ verdict: "stale", edit: { old: "in-flight", new: "shipped", home: "" }, checkedBy: "model:bot" });
    expect(typeof first.checkedAt).toBe("number");
    await upsertStaleVerdict(row({ verdict: "true", reason: "Marked still true by a reader", edit: null, checkedBy: "reader" }));
    await upsertStaleVerdict(row({ kind: "passage" }));
    await upsertStaleVerdict(row({ wiki: "other" }));
    const [{ n }] = (await getDb()`SELECT count(*)::int AS n FROM wiki_stale_verdicts`) as unknown as [{ n: number }];
    expect(n).toBe(3);
    const got = await getStaleVerdicts("w", "status-line", ["k1", "missing"]);
    expect([...got.keys()]).toEqual(["k1"]);
    expect(got.get("k1")).toMatchObject({ verdict: "true", edit: null, checkedBy: "reader", kind: "status-line", page: "hub.md" });
    expect((await getStaleVerdicts("w", "status-line", [])).size).toBe(0);
  });

  // A5: a reader's Still true / Not a status holds until its key changes (D7).
  test("A5: a model write never replaces a reader verdict; a reader replaces a model one and their own", async () => {
    await upsertStaleVerdict(row({ keyHash: "r1", verdict: "true", reason: "Marked still true by a reader", edit: null, checkedBy: "reader" }));
    const kept = await upsertStaleVerdict(row({ keyHash: "r1" }));
    expect(kept).toMatchObject({ verdict: "true", checkedBy: "reader", edit: null });
    expect((await getStaleVerdicts("w", "status-line", ["r1"])).get("r1")).toMatchObject({ verdict: "true", checkedBy: "reader" });
    await upsertStaleVerdict(row({ keyHash: "m1" }));
    expect(await upsertStaleVerdict(row({ keyHash: "m1", verdict: "not-status", edit: null, checkedBy: "reader" }))).toMatchObject({ verdict: "not-status", checkedBy: "reader" });
    expect(await upsertStaleVerdict(row({ keyHash: "m1", verdict: "true", edit: null, checkedBy: "reader" }))).toMatchObject({ verdict: "true", checkedBy: "reader" });
    expect(await upsertStaleVerdict(row({ keyHash: "m2" }))).toMatchObject({ verdict: "stale", checkedBy: "model:bot" });
    expect(await upsertStaleVerdict(row({ keyHash: "m2", verdict: "unsure", edit: null, checkedBy: "model:other" }))).toMatchObject({ verdict: "unsure", checkedBy: "model:other" });
  });

  test("A5: the cleanup keeps a reader verdict however old, and deletes an old model one", async () => {
    await upsertStaleVerdict(row({ keyHash: "reader-old", verdict: "true", edit: null, checkedBy: "reader" }));
    await upsertStaleVerdict(row({ keyHash: "model-old" }));
    await getDb()`UPDATE wiki_stale_verdicts SET checked_at = now() - make_interval(days => ${STALE_VERDICT_RETENTION_DAYS * 3}) WHERE key_hash IN ('reader-old', 'model-old')`;
    expect(await cleanupOldStaleVerdicts()).toBe(1);
    expect([...(await getStaleVerdicts("w", "status-line", ["reader-old", "model-old"])).keys()]).toEqual(["reader-old"]);
  });

  test("the CHECKs refuse an unknown kind or verdict", async () => {
    await expect(upsertStaleVerdict(row({ kind: "drift" as never }))).rejects.toThrow();
    await expect(upsertStaleVerdict(row({ verdict: "outdated" as never }))).rejects.toThrow();
    await upsertStaleVerdict(row({ kind: "fixed", verdict: "fixed", keyHash: "f1" }));
  });

  test("the cleanup deletes rows checked more than 90 days ago, and refuses a window under a day", async () => {
    await upsertStaleVerdict(row({ keyHash: "old" }));
    await upsertStaleVerdict(row({ keyHash: "new" }));
    await getDb()`UPDATE wiki_stale_verdicts SET checked_at = now() - make_interval(days => ${STALE_VERDICT_RETENTION_DAYS + 1}) WHERE key_hash = 'old'`;
    expect(await cleanupOldStaleVerdicts()).toBe(1);
    expect([...(await getStaleVerdicts("w", "status-line", ["old", "new"])).keys()]).toEqual(["new"]);
    await expect(cleanupOldStaleVerdicts(0)).rejects.toThrow(/at least 1 day/);
  });
});
