import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { ensureDefaultThread } from "./threads.ts";
import { createJiraDraft, getJiraDraft } from "./jira-drafts.ts";

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
