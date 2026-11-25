/**
 * Discuss v2 PR 4, fix round 1 batch 2: what the pane keeps across a reload.
 *
 * - A user picked after a `no-user` refusal is remembered with the wiki's bot,
 *   so the next page (a fresh discussion, as a new session has) reads and
 *   sends with that user instead of meeting the picker again.
 * - A failed Delete under «Earlier discussions» stays shown after the thread
 *   read that follows it, until the reader's next action.
 *
 * Own process: it installs happy-dom's globals and wires the tab's document
 * listeners once, so it is alone in its `bun test` link.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { DISCUSS_TAB, initDiscussTab, setDiscussAgentEnabled } from "../components/wiki-discuss-tab.ts";
import { DISCUSS_ASK_BTN_ID, DISCUSS_INPUT_ID, DISCUSS_START_OVER_ID, discussTabBodyHtml } from "../components/wiki-discuss-tab-view.ts";

const g = globalThis as unknown as Record<string, unknown>;
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();
const realFetch = globalThis.fetch;

let wiki = "jarvis";
let relPath = "plans/a.mdx";
let route: (url: string, init?: RequestInit) => Response | Promise<Response> = () => json({}, 404);
const reads: string[] = [];

beforeAll(() => {
  const win = new GlobalWindow({ url: "http://localhost:3011/wiki" });
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(win))) {
    if (IGNORE.has(key)) continue;
    const cur = Object.getOwnPropertyDescriptor(globalThis, key);
    if (cur && "value" in desc && cur.value === desc.value) continue;
    saved.set(key, cur);
    const next = "value" in desc && desc.value === win ? { ...desc, value: globalThis } : desc;
    Object.defineProperty(globalThis, key, { ...next, configurable: true });
  }
  g.confirm = () => true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/wiki/discuss/thread?")) reads.push(url);
    return route(url, init);
  }) as typeof fetch;
  initDiscussTab({ wiki: () => wiki, relPath: () => relPath, switchTab: () => {} });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [key, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete g[key];
  }
  saved.clear();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
  await new Promise((r) => setTimeout(r, 20));
};

/** The page renders with the tab, and the reader opens it (the first thread read). */
async function openTab(): Promise<void> {
  document.body.innerHTML = `<button data-conntab="${DISCUSS_TAB}" hidden>Discuss</button>${discussTabBodyHtml()}`;
  setDiscussAgentEnabled(true);
  (document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`) as HTMLButtonElement).click();
  await settle();
}

const emptyThread = (userId: string, bot: string, closed: unknown[] = []) => ({ userId, bot, thread: null, messages: [], closed, closedTotal: closed.length, oneShot: [] });

test("a user picked after a no-user refusal is kept with the wiki's bot: the next page's thread read carries that user", async () => {
  wiki = "jarvis";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  route = (url) => {
    if (!url.startsWith("/api/wiki/discuss/thread?")) return json({}, 404);
    const userId = new URL(url, "http://x").searchParams.get("userId");
    if (userId === "u1") return json(emptyThread("u1", "jarvis-bot"));
    return json({ error: "Pick a user", reason: "no-user", bot: "jarvis-bot", users: [{ id: "u1", name: "Kari" }] }, 422);
  };

  await openTab();
  const sel = document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select");
  expect(sel !== null).toBe(true);
  sel!.value = "u1";
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
  expect(new URL(reads.at(-1)!, "http://x").searchParams.get("userId")).toBe("u1");
  expect(localStorage.getItem("muninn-discuss-bot-jarvis")).toBe("jarvis-bot");

  // Another page of the same wiki: a fresh discussion, as a new session starts with.
  relPath = "plans/b.mdx";
  const before = reads.length;
  await openTab();
  expect(reads.length).toBe(before + 1);
  expect(new URL(reads.at(-1)!, "http://x").searchParams.get("userId")).toBe("u1");
  expect(document.querySelector(".wiki-discuss-user-select")).toBe(null);
  document.body.innerHTML = "";
});

test("the bot a no-user refusal names is kept at once: a pick whose read then fails still reaches the next page", async () => {
  wiki = "mimir";
  relPath = "plans/d.mdx";
  reads.length = 0;
  localStorage.clear();
  route = (url) => {
    const userId = new URL(url, "http://x").searchParams.get("userId");
    if (userId === "u1") return json({ error: "boom" }, 500);
    return json({ error: "Pick a user", reason: "no-user", bot: "mimir-bot", users: [{ id: "u1", name: "Kari" }] }, 422);
  };
  await openTab();
  expect(localStorage.getItem("muninn-discuss-bot-mimir")).toBe("mimir-bot");
  const sel = document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select")!;
  sel.value = "u1";
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
  relPath = "plans/e.mdx";
  await openTab();
  expect(new URL(reads.at(-1)!, "http://x").searchParams.get("userId")).toBe("u1");
  document.body.innerHTML = "";
});

test("a stale kept user is still dropped on unknown-user, and the picker returns", async () => {
  wiki = "jarvis";
  relPath = "plans/c.mdx";
  reads.length = 0;
  localStorage.clear();
  localStorage.setItem("muninn-discuss-bot-jarvis", "jarvis-bot");
  localStorage.setItem("muninn-discuss-user-jarvis-bot", "gone");
  route = (url) => {
    const userId = new URL(url, "http://x").searchParams.get("userId");
    // As the engine answers it: an unknown-user refusal names no bot (only no-user does).
    if (userId === "gone") return json({ error: "Unknown user", reason: "unknown-user", users: [{ id: "u1", name: "Kari" }] }, 422);
    return json({ error: "Pick a user", reason: "no-user", bot: "jarvis-bot", users: [{ id: "u1", name: "Kari" }] }, 422);
  };
  await openTab();
  expect(localStorage.getItem("muninn-discuss-user-jarvis-bot")).toBe(null);
  expect(document.querySelector(".wiki-discuss-user-select") !== null).toBe(true);
  document.body.innerHTML = "";
});

test("a failed Delete under «Earlier discussions» is still shown after the read that follows it, and the next action clears it", async () => {
  wiki = "w2";
  relPath = "plans/del.mdx";
  localStorage.clear();
  const C1 = crypto.randomUUID();
  const closed = [{ id: C1, name: "wiki: del", createdAt: 1, closedAt: 2, messages: [{ id: "m1", role: "user", content: "Old?", createdAt: 1 }], messageTotal: 1 }];
  let deleteStatus = 403;
  let deletes = 0;
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return json(emptyThread("kari", "ivar", deleteStatus === 204 && deletes > 1 ? [] : closed));
    if (url === `/chat/threads/${C1}` && init?.method === "DELETE") {
      deletes++;
      return deleteStatus === 204 ? new Response(null, { status: 204 }) : json({ error: "Not your thread" }, deleteStatus);
    }
    return json({}, 404);
  };

  await openTab();
  (document.querySelector(`[data-discuss-delete-thread="${C1}"]`) as HTMLButtonElement).click();
  await settle();
  expect(deletes).toBe(1);
  const note = document.querySelector<HTMLElement>(".wiki-discuss-user")!;
  expect(note.hidden).toBe(false);
  expect(note.textContent).toContain("could not be deleted (403)");
  // The thread is still listed: the delete did not happen.
  expect(document.querySelector(`[data-earlier-thread="${C1}"]`) !== null).toBe(true);

  // The reader tries again and it goes through: the old failure is gone with it.
  deleteStatus = 204;
  (document.querySelector(`[data-discuss-delete-thread="${C1}"]`) as HTMLButtonElement).click();
  await settle();
  expect(deletes).toBe(2);
  expect(note.textContent ?? "").not.toContain("could not be deleted");
  expect(note.hidden).toBe(true);
  document.body.innerHTML = "";
});

test("a Delete answered 404 (the thread is already gone, say from another tab) is no failure: no note, and the read after it drops the row", async () => {
  wiki = "w3";
  relPath = "plans/gone.mdx";
  localStorage.clear();
  const C1 = crypto.randomUUID();
  const closed = [{ id: C1, name: "wiki: gone", createdAt: 1, closedAt: 2, messages: [{ id: "m1", role: "user", content: "Old?", createdAt: 1 }], messageTotal: 1 }];
  let deleted = false;
  let deletes = 0;
  reads.length = 0;
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return json(emptyThread("kari", "ivar", deleted ? [] : closed));
    if (url === `/chat/threads/${C1}` && init?.method === "DELETE") {
      deletes++;
      // Deleted elsewhere just before this click: the route no longer finds it.
      deleted = true;
      return json({ error: "Thread not found or is the main thread" }, 404);
    }
    return json({}, 404);
  };

  await openTab();
  const readsBefore = reads.length;
  (document.querySelector(`[data-discuss-delete-thread="${C1}"]`) as HTMLButtonElement).click();
  await settle();
  expect(deletes).toBe(1);
  expect(reads.length).toBe(readsBefore + 1);
  const note = document.querySelector<HTMLElement>(".wiki-discuss-user")!;
  expect(note.textContent ?? "").not.toContain("could not be deleted");
  expect(note.hidden).toBe(true);
  expect(document.querySelector(`[data-earlier-thread="${C1}"]`)).toBe(null);
  document.body.innerHTML = "";
});

// ── Fix round 2: test-only pins ──────────────────────────────────────────

const C9 = "c9999999-0000-4000-8000-000000000009";
const closedRow = (id: string) => ({ id, name: "wiki: x", createdAt: 1, closedAt: 2, messages: [{ id: `m-${id}`, role: "user", content: "Old?", createdAt: 1 }], messageTotal: 1 });
const readUser = (url: string) => new URL(url, "http://x").searchParams.get("userId");
const del = (id: string) => (document.querySelector(`[data-discuss-delete-thread="${id}"]`) as HTMLButtonElement).click();
const noteText = () => document.querySelector<HTMLElement>(".wiki-discuss-user")?.textContent ?? "";

/** Thread reads answered in order by `handlers` (the last repeats); deletes answer 204. */
function readsInOrder(handlers: ((url: string) => Response | Promise<Response>)[]): void {
  let n = 0;
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return handlers[Math.min(n++, handlers.length - 1)]!(url);
    if (url.startsWith("/chat/threads/") && init?.method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 404);
  };
}

test("the read retried after an unknown-user refusal is dropped when a newer read started meanwhile", async () => {
  wiki = "s1";
  relPath = "plans/s1.mdx";
  localStorage.clear();
  localStorage.setItem("muninn-discuss-bot-s1", "ivar");
  localStorage.setItem("muninn-discuss-user-ivar", "gone");
  const C1 = crypto.randomUUID();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  readsInOrder([
    () => json(emptyThread("gone", "ivar", [closedRow(C1)])),
    (url) => (readUser(url) === "gone" ? json({ error: "Unknown user", reason: "unknown-user", users: [] }, 422) : json({}, 500)),
    async () => {
      await held;
      return json(emptyThread("kari", "ivar", [closedRow(C9)]));
    },
    () => json(emptyThread("kari", "ivar", [])),
  ]);
  await openTab();
  del(C1); // read 2 refused, read 3 (the retry) held
  await settle();
  del(C1); // read 4: the newest
  await settle();
  release();
  await settle();
  expect(document.querySelector(`[data-earlier-thread="${C9}"]`)).toBe(null);
  expect(document.querySelector(`[data-earlier-thread="${C1}"]`)).toBe(null);
  document.body.innerHTML = "";
});

test("the read again for the bot's kept user (the wiki moved to another bot) is dropped when a newer read started meanwhile", async () => {
  wiki = "s2";
  relPath = "plans/s2.mdx";
  localStorage.clear();
  localStorage.setItem("muninn-discuss-bot-s2", "old");
  localStorage.setItem("muninn-discuss-user-new", "u-new");
  const C1 = crypto.randomUUID();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  readsInOrder([
    () => json(emptyThread("d", "old", [closedRow(C1)])),
    () => json(emptyThread("d", "new", [closedRow(C1)])),
    async () => {
      await held;
      return json(emptyThread("u-new", "new", [closedRow(C9)]));
    },
    () => json(emptyThread("u-new", "new", [])),
  ]);
  await openTab();
  del(C1); // read 2 names the new bot; read 3 (for its kept user) held
  await settle();
  del(C1); // read 4: the newest
  await settle();
  release();
  await settle();
  expect(document.querySelector(`[data-earlier-thread="${C9}"]`)).toBe(null);
  document.body.innerHTML = "";
});

/** A page whose read shows a live thread and closed C1; a Delete of C1 fails (403). */
async function withFailedDelete(w: string, threadRead: (url: string) => Response | Promise<Response> = () => json({ ...emptyThread("kari", "ivar", []), thread: { id: crypto.randomUUID(), name: "wiki: live", createdAt: 1 } })) {
  wiki = w;
  relPath = `plans/${w}.mdx`;
  localStorage.clear();
  const C1 = crypto.randomUUID();
  const T = crypto.randomUUID();
  const posts: string[] = [];
  let first = true;
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) {
      if (first) {
        first = false;
        return json({ ...emptyThread("kari", "ivar", [closedRow(C1)]), thread: { id: T, name: "wiki: live", createdAt: 1 } });
      }
      return threadRead(url);
    }
    if (url === `/chat/threads/${C1}` && init?.method === "DELETE") return json({ error: "Not your thread" }, 403);
    if (url === "/api/wiki/discuss/thread/close") return json({ closed: true });
    if (url === "/api/wiki/discuss") {
      posts.push(String(init?.body));
      return json({ error: "stop here", reason: "busy" }, 429);
    }
    return json({}, 404);
  };
  await openTab();
  del(C1);
  await settle();
  expect(noteText()).toContain("could not be deleted (403)");
  return { posts };
}

test("a turn clears a failed Delete's note", async () => {
  const { posts } = await withFailedDelete("n1");
  (document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement).value = "Next?";
  (document.getElementById(DISCUSS_ASK_BTN_ID) as HTMLButtonElement).click();
  await settle();
  expect(posts).toHaveLength(1);
  expect(noteText()).not.toContain("could not be deleted");
  document.body.innerHTML = "";
});

test("«Start over» clears a failed Delete's note", async () => {
  await withFailedDelete("n2");
  document.getElementById(DISCUSS_START_OVER_ID)!.click();
  await settle();
  expect(noteText()).not.toContain("could not be deleted");
  document.body.innerHTML = "";
});

test("a user pick clears a failed Delete's note", async () => {
  await withFailedDelete("n3", (url) =>
    readUser(url) === "u1" ? json(emptyThread("u1", "ivar")) : json({ error: "Pick a user", reason: "no-user", bot: "ivar", users: [{ id: "u1", name: "Kari" }] }, 422),
  );
  const sel = document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select");
  expect(sel !== null).toBe(true);
  expect(noteText()).toContain("could not be deleted (403)");
  sel!.value = "u1";
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
  expect(noteText()).not.toContain("could not be deleted");
  document.body.innerHTML = "";
});

test("a failed «Start over» is an action error: a read that lands after it leaves the note standing", async () => {
  wiki = "so";
  relPath = "plans/so.mdx";
  localStorage.clear();
  const C1 = crypto.randomUUID();
  const T = crypto.randomUUID();
  const live = (closed: unknown[]) => json({ ...emptyThread("kari", "ivar", closed), thread: { id: T, name: "wiki: live", createdAt: 1 } });
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let n = 0;
  route = async (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) {
      if (++n === 1) return live([closedRow(C1)]);
      await held;
      return live([]);
    }
    if (url === `/chat/threads/${C1}` && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url === "/api/wiki/discuss/thread/close") return json({ error: "boom" }, 500);
    return json({}, 404);
  };
  await openTab();
  del(C1); // its read is held
  await settle();
  document.getElementById(DISCUSS_START_OVER_ID)!.click();
  await settle();
  expect(noteText()).toContain("Start over failed: boom.");
  release();
  await settle();
  expect(noteText()).toContain("Start over failed: boom.");
  document.body.innerHTML = "";
});

test("a thread read naming the wiki's bot keeps it for the wiki", async () => {
  wiki = "lb";
  relPath = "plans/lb.mdx";
  localStorage.clear();
  readsInOrder([() => json(emptyThread("kari", "lb-bot"))]);
  await openTab();
  expect(localStorage.getItem("muninn-discuss-bot-lb")).toBe("lb-bot");
  document.body.innerHTML = "";
});
