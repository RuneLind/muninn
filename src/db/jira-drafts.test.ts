import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { ensureDefaultThread } from "./threads.ts";
import {
  createJiraDraft,
  failJiraDraft,
  finishJiraDraft,
  getJiraDraft,
  saveJiraDraft,
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
