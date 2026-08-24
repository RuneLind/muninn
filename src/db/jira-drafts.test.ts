import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import { ensureDefaultThread } from "./threads.ts";
import {
  createJiraDraft,
  failJiraDraft,
  finishJiraDraft,
  getJiraDraft,
  listJiraDrafts,
  saveJiraDraft,
  saveJiraDraftRetrieval,
} from "./jira-drafts.ts";

/**
 * The `threads` LEFT JOIN, which is the only thing about this row the route
 * tests cannot see — they stub the whole module.
 *
 * Two fields ride it, both resolved at READ time rather than stored: the thread's
 * NAME (a thread can be renamed) and its OWNER, which is what puts `user=` on the
 * «Juster i samtalen» deep link. Without the owner the chat resolved whichever
 * user that browser last used on the bot and `selectThread(<id>)` looked for the
 * thread in the wrong list. `bot` comes off the row itself, so the deep link
 * survives a `GET /api/jira/templates` failure.
 */

setupTestDb();

describe("getJiraDraft — the thread join", () => {
  test("a thread-sourced draft carries its bot, thread name and thread OWNER", async () => {
    const threadId = await ensureDefaultThread("u-jira-1", "melosys");
    const id = await createJiraDraft({
      botName: "melosys",
      template: "bug",
      depth: "skisse",
      notes: "fra samtale: main",
      extra: "",
      source: "thread",
      threadId,
    });

    const view = await getJiraDraft(id);
    expect(view).not.toBeNull();
    expect(view!.bot).toBe("melosys");
    expect(view!.threadId).toBe(threadId);
    expect(view!.threadName).toBe("main");
    expect(view!.threadUserId).toBe("u-jira-1");
  });

  test("a notes-sourced draft names its bot and has no thread owner", async () => {
    const id = await createJiraDraft({
      botName: "melosys",
      template: "task",
      depth: "ingen",
      notes: "råmateriale",
      extra: "",
    });

    const view = await getJiraDraft(id);
    expect(view!.bot).toBe("melosys");
    expect(view!.source).toBe("notes");
    expect(view!.threadId).toBeNull();
    expect(view!.threadUserId).toBeNull();
  });
});

/**
 * «Lagre» is for a FINISHED draft.
 *
 * The card only ever renders the control on a `ready` row, but the route is
 * reachable directly — and stamping `saved_at` on a `generating` row would mark
 * a draft "kept" while the runner is still writing over it, and on a `failed`
 * one would keep a draft that has no text at all. The gate is in the UPDATE
 * itself rather than a read-then-write, so a run finishing mid-request cannot
 * slip between the check and the write.
 */
describe("saveJiraDraft — only a ready row can be kept", () => {
  test("a generating row is refused, and the same row saves once it is ready", async () => {
    const id = await createJiraDraft({
      botName: "melosys",
      template: "bug",
      depth: "skisse",
      notes: "råmateriale",
      extra: "",
    });

    // Fresh rows are `generating` — nothing to keep yet.
    expect(await saveJiraDraft(id)).toBeNull();
    expect((await getJiraDraft(id))!.savedAt).toBeNull();

    await finishJiraDraft(id, { markdown: "## Problem\nNoe er galt.", keyVerdicts: [], markdownFlags: [] });
    const saved = await saveJiraDraft(id);
    expect(saved).not.toBeNull();
    expect(typeof saved!.savedAt).toBe("number");
  });

  test("a failed row is refused — there is no text to keep", async () => {
    const id = await createJiraDraft({
      botName: "melosys",
      template: "task",
      depth: "ingen",
      notes: "råmateriale",
      extra: "",
    });
    await failJiraDraft(id, "Utkastet ble ikke skrevet ferdig.");
    expect(await saveJiraDraft(id)).toBeNull();
    expect((await getJiraDraft(id))!.savedAt).toBeNull();
  });

  test("an unknown id is null too — the route tells the two apart by re-reading", async () => {
    expect(await saveJiraDraft("99999999-8888-4777-8666-555555555555")).toBeNull();
  });
});

/**
 * The corpus-wide archive listing behind `/jira` and `GET /api/jira/archive`.
 *
 * Three things only a real database can answer, and all three are SQL rather
 * than TypeScript precisely so the wide payload never crosses the wire: the
 * title is scanned out of the HEAD of the markdown, and `coverage` is derived
 * from `jsonb` aggregates over the citation set and this run's exclusions —
 * the same `effectiveCoverage` pair `toView` derives, without reading either.
 *
 * The test database is shared, so every assertion is scoped to rows this file
 * created (`byId`) rather than to totals.
 */
describe("listJiraDrafts — the archive listing", () => {
  const CITES = [
    { n: 1, collection: "jira-issues", docId: "d-keep", title: "Beholdt", badge: "Jira", relevance: 0.9 },
    { n: 2, collection: "jira-issues", docId: "d-drop", title: "Utelatt", badge: "Jira", relevance: 0.8 },
  ];

  test("saved-only hides an unsaved row that all-attempts shows", async () => {
    const kept = await createJiraDraft({
      botName: "arkiv-a", template: "bug", depth: "skisse", notes: "n", extra: "",
    });
    const loose = await createJiraDraft({
      botName: "arkiv-a", template: "bug", depth: "skisse", notes: "n", extra: "",
    });
    await finishJiraDraft(kept, { markdown: "# Lagret sak\n\ntekst", keyVerdicts: [], markdownFlags: [] });
    await finishJiraDraft(loose, { markdown: "# Ulagret sak\n\ntekst", keyVerdicts: [], markdownFlags: [] });
    await saveJiraDraft(kept);

    const saved = (await listJiraDrafts({ savedOnly: true, limit: 200 })).drafts;
    expect(saved.map((r) => r.draftId)).toContain(kept);
    expect(saved.map((r) => r.draftId)).not.toContain(loose);

    const all = (await listJiraDrafts({ savedOnly: false, limit: 200 })).drafts;
    expect(all.map((r) => r.draftId)).toContain(kept);
    expect(all.map((r) => r.draftId)).toContain(loose);
  });

  test("a failed row appears under all attempts, marked failed and titleless", async () => {
    const id = await createJiraDraft({
      botName: "arkiv-b", template: "task", depth: "ingen", notes: "n", extra: "",
    });
    await failJiraDraft(id, "Utkastet ble ikke skrevet ferdig.");
    const row = ((await listJiraDrafts({ savedOnly: false, limit: 200 })).drafts).find((r) => r.draftId === id);
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed");
    expect(row!.title).toBeNull();
  });

  test("the title comes off the markdown's own heading", async () => {
    const id = await createJiraDraft({
      botName: "arkiv-c", template: "story", depth: "full", notes: "n", extra: "",
    });
    await finishJiraDraft(id, {
      markdown: "# Avgift beregnes feil\n\n## Bakgrunn\n\ntekst",
      keyVerdicts: [], markdownFlags: [],
    });
    await saveJiraDraft(id);
    const row = ((await listJiraDrafts({ savedOnly: true, limit: 200 })).drafts).find((r) => r.draftId === id);
    expect(row!.title).toBe("Avgift beregnes feil");
  });

  test("coverage is DERIVED per row: the stored verdict plus what this run retained", async () => {
    const grounded = await createJiraDraft({
      botName: "arkiv-d", template: "bug", depth: "skisse", notes: "n", extra: "",
    });
    await saveJiraDraftRetrieval(grounded, CITES as never, "answer", "spørsmål");
    await finishJiraDraft(grounded, { markdown: "# Med kilder", keyVerdicts: [], markdownFlags: [] });

    const excluded = await createJiraDraft({
      botName: "arkiv-d", template: "bug", depth: "skisse", notes: "n", extra: "",
    });
    await saveJiraDraftRetrieval(excluded, CITES as never, "answer", "spørsmål");
    // A HISTORICAL exclusion set, written straight into the column: the notes
    // path that used to toggle sources off is gone, and nothing in the code
    // writes `exclude_doc_ids` any more — but archived rows carry one and the
    // listing's derived `coverage` still has to read it.
    await getDb()`
      UPDATE jira_drafts SET exclude_doc_ids = ${getDb().json(["d-keep", "d-drop"] as never)}
       WHERE id = ${excluded}`;
    await finishJiraDraft(excluded, { markdown: "# Uten kilder", keyVerdicts: [], markdownFlags: [] });

    const unreachable = await createJiraDraft({
      botName: "arkiv-d", template: "bug", depth: "skisse", notes: "n", extra: "",
    });
    await saveJiraDraftRetrieval(unreachable, [], "unreachable", "spørsmål");
    await finishJiraDraft(unreachable, { markdown: "# Uten API", keyVerdicts: [], markdownFlags: [] });

    const rows = (await listJiraDrafts({ savedOnly: false, limit: 200 })).drafts;
    const byId = (id: string) => rows.find((r) => r.draftId === id)!;

    expect(byId(grounded).coverage).toBe("answer");
    // Every source off: the derived verdict says `no_hits`, the STORED one still
    // says the corpus had hits — which is the pair the page reads.
    expect(byId(excluded).coverage).toBe("no_hits");
    expect(byId(excluded).retrievalCoverage).toBe("answer");
    // `unreachable` passes through the zero-retained branch rather than
    // degrading into a claim about the corpus.
    expect(byId(unreachable).coverage).toBe("unreachable");
    // Retrieval that never landed reports null, not `no_hits`.
    const fresh = await createJiraDraft({
      botName: "arkiv-d", template: "bug", depth: "skisse", notes: "n", extra: "",
    });
    const freshRow = ((await listJiraDrafts({ savedOnly: false, limit: 200 })).drafts).find(
      (r) => r.draftId === fresh,
    )!;
    expect(freshRow.coverage).toBeNull();
    expect(freshRow.retrievalCoverage).toBeNull();
  });

  test("a thread row carries its thread name, joined at read time", async () => {
    const threadId = await ensureDefaultThread("u-jira-archive", "melosys");
    const id = await createJiraDraft({
      botName: "melosys", template: "bug", depth: "skisse",
      notes: "fra samtale: main", extra: "", source: "thread", threadId,
    });
    await finishJiraDraft(id, { markdown: "# Fra samtalen", keyVerdicts: [], markdownFlags: [] });
    const row = ((await listJiraDrafts({ savedOnly: false, limit: 200 })).drafts).find((r) => r.draftId === id)!;
    expect(row.source).toBe("thread");
    expect(row.threadId).toBe(threadId);
    expect(row.threadName).toBe("main");
  });

  test("`capped` is a row PAST the limit, never an exact fit", async () => {
    // `rows.length >= limit` claimed truncation on a page that fit exactly — the
    // one page where the reader can count the rows and see the claim is wrong.
    for (let i = 0; i < 3; i++) {
      const id = await createJiraDraft({
        botName: "arkiv-cap", template: "bug", depth: "skisse", notes: "n", extra: "",
      });
      await finishJiraDraft(id, { markdown: `# Cap ${i}`, keyVerdicts: [], markdownFlags: [] });
      await saveJiraDraft(id);
    }
    const cut = await listJiraDrafts({ savedOnly: false, limit: 2 });
    expect(cut.drafts).toHaveLength(2);
    expect(cut.capped).toBe(true);

    // Three rows under a limit of three: the page is full, and nothing was cut.
    const exact = await listJiraDrafts({ savedOnly: false, limit: 3 });
    expect(exact.drafts).toHaveLength(3);
    expect(exact.capped).toBe(false);
  });

  test("newest first, and the limit is clamped by the shared helper", async () => {
    const rows = (await listJiraDrafts({ savedOnly: false, limit: 5 })).drafts;
    expect(rows.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.createdAt).toBeGreaterThanOrEqual(rows[i]!.createdAt);
    }
    // A hand-written `?limit=100000` cannot turn a page render into a full-table
    // read: the clamp is applied inside the reader, not only at the route.
    expect(((await listJiraDrafts({ savedOnly: false, limit: 100_000 })).drafts).length)
      .toBeLessThanOrEqual(200);
  });
});
