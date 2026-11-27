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
import { DISCUSS_TAB, discussTurnForCard, initDiscussTab, openDiscussTab, setDiscussAgentEnabled, showTurnInDiscuss, startInlineTurn } from "../components/wiki-discuss-tab.ts";
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
  expect(document.querySelector(`[data-earlier-thread="${C1}"]`) !== null).toBe(false);
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
  expect(document.querySelector(`[data-earlier-thread="${C9}"]`) !== null).toBe(false);
  expect(document.querySelector(`[data-earlier-thread="${C1}"]`) !== null).toBe(false);
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
  expect(document.querySelector(`[data-earlier-thread="${C9}"]`) !== null).toBe(false);
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

test("«as <name> ▾» switches the page's discussion to another user's own thread: kept for the bot, read again, the other user's turns gone", async () => {
  wiki = "harbour";
  relPath = "plans/s.mdx";
  reads.length = 0;
  localStorage.clear();
  const users = [{ id: "popp", name: "Popp" }, { id: "rune", name: "Rune" }];
  const turnRow = (id: string, q: string) => ({ id, discussionId: `th-${id}`, seq: 1, selection: null, question: q, answer: "A.", endState: "done", error: null, toolCalls: [], proposedEdit: null, editAppliedAt: null, createdAt: 1 });
  route = (url) => {
    if (!url.startsWith("/api/wiki/discuss/thread?")) return json({}, 404);
    const userId = new URL(url, "http://x").searchParams.get("userId") ?? "popp";
    const name = users.find((u) => u.id === userId)!.name;
    const row = turnRow(userId, `${name}'s question`);
    return json({ userId, userName: name, userChoosable: true, users, bot: "harbour-bot", thread: { id: `th-${userId}`, name: "t", createdAt: 1 }, messages: [{ id: `m-${userId}`, role: "user", content: row.question, createdAt: 1, turn: row }], closed: [], closedTotal: 0, oneShot: [] });
  };
  await openTab();
  const as = document.querySelector<HTMLButtonElement>("[data-discuss-as]");
  expect(as?.textContent).toBe("as Popp ▾");
  expect(document.querySelector(".wiki-discuss-turns")!.textContent).toContain("Popp's question");
  as!.click();
  const sel = document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select")!;
  expect(sel.value).toBe("popp");
  sel.value = "rune";
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
  expect(new URL(reads.at(-1)!, "http://x").searchParams.get("userId")).toBe("rune");
  expect(localStorage.getItem("muninn-discuss-user-harbour-bot")).toBe("rune");
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Rune ▾");
  const turns = document.querySelector(".wiki-discuss-turns")!.textContent!;
  expect(turns).toContain("Rune's question");
  expect(turns).not.toContain("Popp's question");
  expect(document.querySelector(".wiki-discuss-user-select")).toBe(null);
  document.body.innerHTML = "";
});

test("not choosable (an authenticating instance): the name shows with no picker button", async () => {
  wiki = "harbour2";
  relPath = "plans/n.mdx";
  localStorage.clear();
  route = (url) => (url.startsWith("/api/wiki/discuss/thread?") ? json({ ...emptyThread("popp", "harbour-bot"), userName: "Popp", userChoosable: false, users: [] }) : json({}, 404));
  await openTab();
  expect(document.querySelector(".wiki-discuss-as")?.textContent).toBe("as Popp");
  expect(document.querySelector("[data-discuss-as]")).toBe(null);
  document.body.innerHTML = "";
});

// ── PR 913 fix round 1 batch 1 ───────────────────────────────────────────

/** A thread read per user: Popp holds a live thread with a turn on every page, Rune none. */
function perUserReads(users = [{ id: "popp", name: "Popp" }, { id: "rune", name: "Rune" }]) {
  return (url: string) => {
    const q = new URL(url, "http://x").searchParams;
    const userId = q.get("userId") ?? "popp";
    const page = q.get("relPath")!;
    const name = users.find((u) => u.id === userId)?.name ?? userId;
    const row = { id: `${userId}-${page}`, discussionId: `th-${userId}-${page}`, seq: 1, selection: null, question: `${name}'s question on ${page}`, answer: "A.", endState: "done", error: null, toolCalls: [], proposedEdit: null, editAppliedAt: null, createdAt: 1 };
    const held = userId === "popp";
    return json({
      userId, userName: name, userChoosable: true, users, bot: "f1-bot",
      thread: held ? { id: row.discussionId, name: "t", createdAt: 1 } : null,
      messages: held ? [{ id: `m-${row.id}`, role: "user", content: row.question, createdAt: 1, turn: row }] : [],
      closed: [], closedTotal: 0, oneShot: [],
    });
  };
}

test("F1: a user picked on another page of the wiki: back on a page read before, its discussion is that user's, and a turn never pairs one user's thread with another's id", async () => {
  wiki = "f1";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  const posts: Record<string, unknown>[] = [];
  const threadRead = perUserReads();
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return threadRead(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({ error: "stub" }, 404);
  };
  await openTab(); // page A: Popp's live thread
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Popp ▾");
  relPath = "plans/b.mdx";
  await openTab(); // page B, then «as Rune» there
  (document.querySelector("[data-discuss-as]") as HTMLButtonElement).click();
  document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select")!.value = "rune";
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Rune ▾");

  relPath = "plans/a.mdx";
  const before = reads.length;
  await openTab(); // back on page A
  expect(reads.slice(before).map((u) => new URL(u, "http://x").searchParams.get("userId"))).toEqual(["rune"]);
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Rune ▾");
  expect(document.querySelector(".wiki-discuss-turns")!.textContent).not.toContain("Popp's question");
  // Read once: showing the tab again reads nothing more.
  const after = reads.length;
  await openTab();
  expect(reads.length).toBe(after);
  // The next turn: Rune's id, and no thread of Popp's.
  (document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement).value = "Hello?";
  (document.getElementById(DISCUSS_ASK_BTN_ID) as HTMLButtonElement).click();
  await settle();
  expect(posts.length).toBe(1);
  expect(posts[0]!.userId).toBe("rune");
  expect(posts[0]!.discussionId).toBeUndefined();
  document.body.innerHTML = "";
});

test("F5: a refusal's picker while «as <name> ▾» was open: the menu closes, and the refusal's user is taken", async () => {
  wiki = "f5";
  relPath = "plans/r.mdx";
  reads.length = 0;
  localStorage.clear();
  const threadRead = perUserReads();
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return threadRead(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") return json({ error: "not a chat user", reason: "unknown-user", bot: "f1-bot", users: [{ id: "kari", name: "Kari" }] }, 422);
    return json({}, 404);
  };
  await openTab();
  (document.querySelector("[data-discuss-as]") as HTMLButtonElement).click();
  expect(document.querySelector("[data-discuss-as]")!.getAttribute("aria-expanded")).toBe("true");
  (document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement).value = "Hello?";
  (document.getElementById(DISCUSS_ASK_BTN_ID) as HTMLButtonElement).click();
  await settle();
  // The refusal's picker replaced the menu: the button says the menu is closed.
  expect(document.querySelector("[data-discuss-as]")!.getAttribute("aria-expanded")).toBe("false");
  const sel = document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select")!;
  expect(Array.from(sel.options).map((o) => o.value)).toEqual(["kari"]);
  sel.value = "kari";
  const before = reads.length;
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
  expect(reads.slice(before).map((u) => new URL(u, "http://x").searchParams.get("userId"))).toEqual(["kari"]);
  expect(localStorage.getItem("muninn-discuss-user-f1-bot")).toBe("kari");
  document.body.innerHTML = "";
});

test("F5: «as <name> ▾» opened over a refusal's picker replaces it: the menu's users, and a pick from it switches", async () => {
  wiki = "f5b";
  relPath = "plans/r.mdx";
  reads.length = 0;
  localStorage.clear();
  const threadRead = perUserReads();
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return threadRead(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") return json({ error: "not a chat user", reason: "unknown-user", bot: "f1-bot", users: [{ id: "kari", name: "Kari" }] }, 422);
    return json({}, 404);
  };
  await openTab();
  (document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement).value = "Hello?";
  (document.getElementById(DISCUSS_ASK_BTN_ID) as HTMLButtonElement).click();
  await settle();
  expect(Array.from(document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select")!.options).map((o) => o.value)).toEqual(["kari"]);
  (document.querySelector("[data-discuss-as]") as HTMLButtonElement).click();
  expect(document.querySelector("[data-discuss-as]")!.getAttribute("aria-expanded")).toBe("true");
  const sel = document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select")!;
  expect(Array.from(sel.options).map((o) => o.value)).toEqual(["popp", "rune"]);
  sel.value = "rune";
  const before = reads.length;
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
  expect(reads.slice(before).map((u) => new URL(u, "http://x").searchParams.get("userId"))).toEqual(["rune"]);
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Rune ▾");
  document.body.innerHTML = "";
});

// ── PR 913 fix round 2 batch 1 ───────────────────────────────────────────

/** A POST answered with an SSE stream the test feeds. */
function heldStream() {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const res = new Response(new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  return {
    res,
    push: (event: string, data: unknown) => ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => ctl.close(),
  };
}

/** Popp holds a live thread (with a closed one under «Earlier discussions») on every page, Rune none; `failFor` reads answer 500. */
function d1Reads(failFor: Set<string>) {
  const users = [{ id: "popp", name: "Popp" }, { id: "rune", name: "Rune" }];
  return (url: string) => {
    const q = new URL(url, "http://x").searchParams;
    const userId = q.get("userId") ?? "popp";
    const page = q.get("relPath")!;
    if (failFor.has(`${userId}:${page}`)) return json({ error: "boom" }, 500);
    const name = users.find((u) => u.id === userId)!.name;
    const row = { id: `${userId}-${page}`, discussionId: `th-${userId}-${page}`, seq: 1, selection: null, question: `${name}'s question on ${page}`, answer: "A.", endState: "done", error: null, toolCalls: [], proposedEdit: null, editAppliedAt: null, createdAt: 1 };
    const held = userId === "popp";
    return json({
      userId, userName: name, userChoosable: true, users, bot: "d-bot",
      thread: held ? { id: row.discussionId, name: "t", createdAt: 1 } : null,
      messages: held ? [{ id: `m-${row.id}`, role: "user", content: row.question, createdAt: 1, turn: row }] : [],
      closed: held ? [{ id: `closed-${page}`, name: "old", createdAt: 1, closedAt: 2, messages: [{ id: "c1", role: "user", content: "Popp's closed question", createdAt: 1 }], messageTotal: 1 }] : [],
      closedTotal: held ? 1 : 0,
      oneShot: [],
    });
  };
}

async function pickAs(userId: string): Promise<void> {
  (document.querySelector("[data-discuss-as]") as HTMLButtonElement).click();
  document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select")!.value = userId;
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
}

async function askBox(text: string): Promise<void> {
  (document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement).value = text;
  (document.getElementById(DISCUSS_ASK_BTN_ID) as HTMLButtonElement).click();
  await settle();
}

test("D1: a user kept by another window while a page's turn runs: the follow-up after it stays on that thread and user; the page moves when shown next with no turn running", async () => {
  wiki = "d1";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  const fail = new Set<string>();
  const threadRead = d1Reads(fail);
  const posts: Record<string, unknown>[] = [];
  let stream: ReturnType<typeof heldStream> | null = null;
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return threadRead(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (posts.length === 1) return (stream = heldStream()).res;
      return json({ error: "stub" }, 404);
    }
    return json({}, 404);
  };
  await openTab(); // page A, Popp's thread
  await askBox("First?");
  // First visit, nothing kept: the read's default user, paired with the thread
  // it read, and kept from then on (R1's adoption).
  expect(posts[0]).toMatchObject({ discussionId: "th-popp-plans/a.mdx", userId: "popp" });
  expect(localStorage.getItem("muninn-discuss-user-d-bot")).toBe("popp");
  stream!.push("turn", { turnId: "tA2", seq: 2, discussionId: "th-popp-plans/a.mdx", userId: "popp" });
  await settle();
  localStorage.setItem("muninn-discuss-user-d-bot", "rune"); // another window picked Rune
  const before = reads.length;
  await openTab(); // back on A while its turn runs: no switch
  expect(reads.length).toBe(before);
  stream!.push("done", { answer: "Done.", proposedEdit: null });
  stream!.end();
  await settle();
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Popp ▾");
  await askBox("Follow-up?");
  expect(posts[1]).toMatchObject({ discussionId: "th-popp-plans/a.mdx", userId: "popp" });
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Popp ▾");
  expect(document.querySelector(".wiki-discuss-turns")!.textContent).toContain("Popp's question");

  // Shown again with no turn running: Rune's discussion. Its read fails here,
  // so nothing of Popp's is left: no name, no earlier discussions.
  fail.add("rune:plans/a.mdx");
  await openTab();
  expect(new URL(reads.at(-1)!, "http://x").searchParams.get("userId")).toBe("rune");
  expect(document.querySelector(".wiki-discuss-as")).toBe(null);
  expect(document.querySelector(".wiki-discuss-earlier")).toBe(null);
  expect(document.querySelector(".wiki-discuss-turns")!.textContent).not.toContain("Popp's question");
  document.body.innerHTML = "";
});

test("D2a: a turn event for one user never writes the kept user back over one another window kept meanwhile", async () => {
  wiki = "d2";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  const threadRead = d1Reads(new Set());
  let stream: ReturnType<typeof heldStream> | null = null;
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return threadRead(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") return (stream = heldStream()).res;
    return json({}, 404);
  };
  await openTab(); // page A
  await askBox("First?"); // its stream is open, no turn event yet
  localStorage.setItem("muninn-discuss-user-d-bot", "rune"); // another window
  // A's turn event names Popp: Rune stays kept.
  stream!.push("turn", { turnId: "tA2", seq: 2, discussionId: "th-popp-plans/a.mdx", userId: "popp" });
  await settle();
  expect(localStorage.getItem("muninn-discuss-user-d-bot")).toBe("rune");
  stream!.push("done", { answer: "Done.", proposedEdit: null });
  stream!.end();
  await settle();
  document.body.innerHTML = "";
});

test("D2b: a read for one user never writes the kept user back over a pick made while it was in flight", async () => {
  wiki = "d2b";
  reads.length = 0;
  localStorage.clear();
  const threadRead = d1Reads(new Set());
  let gate: (() => void) | null = null;
  route = (url) => {
    if (!url.startsWith("/api/wiki/discuss/thread?")) return json({}, 404);
    if (url.includes("plans%2Fc.mdx")) return new Promise<Response>((r) => (gate = () => r(threadRead(url))));
    return threadRead(url);
  };
  localStorage.setItem("muninn-discuss-bot-d2b", "d-bot");
  // A read started for Popp (page C), a pick of Rune lands before it answers.
  localStorage.setItem("muninn-discuss-user-d-bot", "popp");
  relPath = "plans/c.mdx";
  await openTab();
  localStorage.setItem("muninn-discuss-user-d-bot", "rune"); // the pick, as pickUser writes it
  gate!();
  await settle();
  expect(localStorage.getItem("muninn-discuss-user-d-bot")).toBe("rune");
  document.body.innerHTML = "";
});

test("D1b: a page render with the tab shown follows a user another window kept (no turn running)", async () => {
  wiki = "d1b";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  route = (url) => (url.startsWith("/api/wiki/discuss/thread?") ? d1Reads(new Set())(url) : json({}, 404));
  await openTab(); // A, Popp's
  localStorage.setItem("muninn-discuss-user-d-bot", "rune"); // another window
  // The shell renders A again with the Discuss tab still shown.
  document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`)!.classList.add("active");
  setDiscussAgentEnabled(true);
  await settle();
  expect(userOf(reads.at(-1)!)).toBe("rune");
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Rune ▾");
  document.body.innerHTML = "";
});

// ── PR 913 class check: the user state (R1–R6) ───────────────────────────

/** Each user's own live thread on every page (Rune's only when `runeHolds`),
 *  Popp's with a closed one under «Earlier discussions»; the route's default
 *  user is `def.user`; a user in `refused` answers 422 unknown-user. */
function stateReads(opts: { runeHolds?: boolean; def?: { user: string }; refused?: Set<string> } = {}) {
  const users = [{ id: "popp", name: "Popp" }, { id: "rune", name: "Rune" }];
  return (url: string) => {
    const q = new URL(url, "http://x").searchParams;
    const userId = q.get("userId") ?? opts.def?.user ?? "popp";
    const page = q.get("relPath")!;
    if (opts.refused?.has(userId)) return json({ error: "not a chat user", reason: "unknown-user", bot: "s-bot", users }, 422);
    const name = users.find((u) => u.id === userId)!.name;
    const held = userId === "popp" || (userId === "rune" && !!opts.runeHolds);
    const row = { id: `${userId}-${page}`, discussionId: `th-${userId}-${page}`, seq: 1, selection: null, question: `${name}'s question on ${page}`, answer: "A.", endState: "done", error: null, toolCalls: [], proposedEdit: null, editAppliedAt: null, createdAt: 1 };
    return json({
      userId, userName: name, userChoosable: true, users, bot: "s-bot",
      thread: held ? { id: row.discussionId, name: "t", createdAt: 1 } : null,
      messages: held ? [{ id: `m-${row.id}`, role: "user", content: row.question, createdAt: 1, turn: row }] : [],
      closed: userId === "popp" ? [{ id: `closed-${page}`, name: "old", createdAt: 1, closedAt: 2, messages: [{ id: "c1", role: "user", content: "closed q", createdAt: 1 }], messageTotal: 1 }] : [],
      closedTotal: userId === "popp" ? 1 : 0,
      oneShot: [],
    });
  };
}
/** A send's thread is owned by the user it names (`th-<user>-<page>`), or it names none. */
const pairs = (b: Record<string, unknown>) => b.discussionId === undefined || String(b.discussionId).startsWith(`th-${String(b.userId)}-`);
const KEPT = "muninn-discuss-user-s-bot";
const userOf = (u: string) => new URL(u, "http://x").searchParams.get("userId");

test("V1: Delete under «Earlier discussions» on a view read for Popp while Rune is kept elsewhere: the next follow-up pairs its thread and user", async () => {
  wiki = "v1";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  const posts: Record<string, unknown>[] = [];
  const threadRead = stateReads({ runeHolds: true });
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return threadRead(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({}, 404);
  };
  await openTab();
  localStorage.setItem(KEPT, "rune"); // another window picked Rune
  (document.querySelector(".wiki-discuss-earlier > summary") as HTMLElement).click();
  (document.querySelector("[data-discuss-delete-thread]") as HTMLButtonElement).click();
  await settle();
  // R1: the view holds Popp's thread, so its re-read is as Popp.
  expect(userOf(reads.at(-1)!)).toBe("popp");
  await askBox("Follow-up?");
  expect(posts.length).toBe(1);
  expect(pairs(posts[0]!)).toBe(true);
  document.body.innerHTML = "";
});

test("V2: the thread's user refused unknown-user while another user is kept: the kept user stays", async () => {
  wiki = "v2";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return stateReads()(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") return json({ error: "not a chat user", reason: "unknown-user", bot: "s-bot", users: [{ id: "rune", name: "Rune" }] }, 422);
    return json({}, 404);
  };
  await openTab(); // Popp's thread
  localStorage.setItem(KEPT, "rune");
  await askBox("Follow-up?"); // sent as popp, refused
  expect(localStorage.getItem(KEPT)).toBe("rune");
  document.body.innerHTML = "";
});

test("V3: a thread stays with its user when /chat's default user changes: the first read's user is kept and the next page reads with it", async () => {
  wiki = "v3";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  const def = { user: "popp" };
  const threadRead = stateReads({ def });
  route = (url) => (url.startsWith("/api/wiki/discuss/thread?") ? threadRead(url) : json({}, 404));
  await openTab(); // nothing kept: the default user, Popp
  def.user = "rune"; // /chat's dropdown moved
  relPath = "plans/b.mdx";
  await openTab();
  expect(userOf(reads.at(-1)!)).toBe("popp");
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Popp ▾");
  document.body.innerHTML = "";
});

test("V4: «Open in Discuss →» on an inline turn of a view read for another user than the kept one keeps the turn", async () => {
  wiki = "v4";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  let stream: ReturnType<typeof heldStream> | null = null;
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return stateReads()(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") return (stream = heldStream()).res;
    return json({}, 404);
  };
  await openTab();
  localStorage.setItem(KEPT, "rune");
  const r = startInlineTurn("Explain?", { selection: "x", before: "", after: "", atStart: true, atEnd: true, heading: "" }, null, "explore");
  expect("key" in r).toBe(true);
  const key = (r as { key: string }).key;
  await settle();
  stream!.push("turn", { turnId: "tv4", seq: 2, discussionId: "th-popp-plans/a.mdx", userId: "popp" });
  stream!.push("done", { answer: "ok", proposedEdit: null });
  stream!.end();
  await settle();
  showTurnInDiscuss(key);
  await settle();
  expect(discussTurnForCard(key)).not.toBe(null);
  document.body.innerHTML = "";
});

test("V5: a threaded send refused unknown-user, another user picked in the refusal's picker: the next send pairs its thread and user", async () => {
  wiki = "v5";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  const posts: Record<string, unknown>[] = [];
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return stateReads()(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (posts.length === 1) return json({ error: "not a chat user", reason: "unknown-user", bot: "s-bot", users: [{ id: "rune", name: "Rune" }] }, 422);
    }
    return json({}, 404);
  };
  await openTab(); // Popp's thread
  await askBox("First?");
  const sel = document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select")!;
  sel.value = "rune";
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
  await askBox("Again?");
  expect(posts.length).toBe(2);
  expect(posts[1]!.userId).toBe("rune");
  expect(pairs(posts[1]!)).toBe(true);
  document.body.innerHTML = "";
});

test("R3: a pick is refused while a turn of the bot runs on another page: the «as» button is off and says why", async () => {
  wiki = "r3a";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  let stream: ReturnType<typeof heldStream> | null = null;
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return stateReads()(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") {
      // Page B's send is refused, so its refusal picker shows while A's turn runs.
      if (String(init.body).includes("plans/b.mdx")) return json({ error: "not a chat user", reason: "unknown-user", bot: "s-bot", users: [{ id: "rune", name: "Rune" }] }, 422);
      return (stream = heldStream()).res;
    }
    return json({}, 404);
  };
  await openTab();
  await askBox("Long?"); // A's turn runs
  relPath = "plans/b.mdx";
  await openTab();
  const as = document.querySelector<HTMLButtonElement>("[data-discuss-as]")!;
  expect(as.disabled).toBe(true);
  expect(as.title).toContain("still running");
  // The refusal's picker (B's send as Popp refused, so R5 cleared Popp): a
  // pick there is refused too, saying why, and keeps nothing.
  await askBox("On B?");
  expect(localStorage.getItem(KEPT)).toBe(null);
  const sel = document.querySelector<HTMLSelectElement>(".wiki-discuss-user-select")!;
  sel.value = "rune";
  (document.querySelector("[data-discuss-pick-user]") as HTMLButtonElement).click();
  await settle();
  expect(localStorage.getItem(KEPT)).toBe(null);
  expect(document.querySelector(".wiki-discuss-user")!.textContent).toContain("still running");
  stream!.push("done", { answer: "ok", proposedEdit: null });
  stream!.end();
  await settle();
  expect(document.querySelector<HTMLButtonElement>("[data-discuss-as]")!.disabled).toBe(false);
  document.body.innerHTML = "";
});

test("R3: a pick resets every view of the bot in the tab: a page read before sends as the picked user with no old thread, unshown", async () => {
  wiki = "r3b";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  const posts: Record<string, unknown>[] = [];
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return stateReads()(url);
    if (url === "/api/wiki/discuss" && init?.method === "POST") posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({}, 404);
  };
  await openTab(); // A, Popp's
  relPath = "plans/b.mdx";
  await openTab();
  await pickAs("rune");
  // Back on A by a send that does not show the tab (the selection menu's inline turn).
  relPath = "plans/a.mdx";
  startInlineTurn("Explain?", { selection: "x", before: "", after: "", atStart: true, atEnd: true, heading: "" }, null, "explore");
  await settle();
  expect(posts.length).toBe(1);
  expect(posts[0]!.userId).toBe("rune");
  expect(posts[0]!.discussionId).toBeUndefined();
  document.body.innerHTML = "";
});

test("R4: a user kept by another window is followed on a tab show (the tab's click, the breadcrumb's open) with no turn running", async () => {
  wiki = "r4";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  route = (url) => (url.startsWith("/api/wiki/discuss/thread?") ? stateReads()(url) : json({}, 404));
  await openTab(); // Popp's; Popp kept by adoption
  localStorage.setItem(KEPT, "rune");
  await openTab(); // the tab's click
  expect(userOf(reads.at(-1)!)).toBe("rune");
  expect(document.querySelector("[data-discuss-as]")!.textContent).toBe("as Rune ▾");
  // Another window back to Popp; the breadcrumb's 💬 Discuss (openDiscussTab with follow).
  localStorage.setItem(KEPT, "popp");
  openDiscussTab(true, true);
  await settle();
  expect(userOf(reads.at(-1)!)).toBe("popp");
  document.body.innerHTML = "";
});

test("R1/R2: a default user the route would refuse as a posted id (no thread, not listed) is neither kept nor sent", async () => {
  wiki = "r12";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  const posts: Record<string, unknown>[] = [];
  const users = [{ id: "popp", name: "Popp" }];
  let stream: ReturnType<typeof heldStream> | null = null;
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) return json({ userId: "ghost", userName: null, userChoosable: true, users, bot: "g-bot", thread: null, messages: [], closed: [], closedTotal: 0, oneShot: [] });
    if (url === "/api/wiki/discuss" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return (stream = heldStream()).res;
    }
    return json({}, 404);
  };
  await openTab();
  expect(localStorage.getItem("muninn-discuss-user-g-bot")).toBe(null);
  await askBox("Hello?");
  expect(posts.length).toBe(1);
  expect(posts[0]!.userId).toBeUndefined();
  // Its turn event: the user holds this thread now, so it is kept (R2).
  stream!.push("turn", { turnId: "tg1", seq: 1, discussionId: "th-ghost", userId: "ghost" });
  stream!.push("done", { answer: "ok", proposedEdit: null });
  stream!.end();
  await settle();
  expect(localStorage.getItem("muninn-discuss-user-g-bot")).toBe("ghost");
  document.body.innerHTML = "";
});

test("R4: Apply's own page render does not follow a user another window kept: the applied turn stays", async () => {
  wiki = "r4apply";
  relPath = "plans/a.mdx";
  reads.length = 0;
  localStorage.clear();
  const row = { id: "pe1", discussionId: "th-popp-plans/a.mdx", seq: 1, selection: null, question: "Fix it?", answer: "Done.", endState: "done", error: null, toolCalls: [], proposedEdit: { edits: [] }, editAppliedAt: null, createdAt: 1 };
  const users = [{ id: "popp", name: "Popp" }, { id: "rune", name: "Rune" }];
  route = (url, init) => {
    if (url.startsWith("/api/wiki/discuss/thread?")) {
      const userId = userOf(url) ?? "popp";
      const held = userId === "popp";
      return json({ userId, userName: userId === "popp" ? "Popp" : "Rune", userChoosable: true, users, bot: "a-bot", thread: held ? { id: row.discussionId, name: "t", createdAt: 1 } : null, messages: held ? [{ id: "m1", role: "user", content: row.question, createdAt: 1, turn: row }] : [], closed: [], closedTotal: 0, oneShot: [] });
    }
    if (url === "/api/wiki/discuss/apply") {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (b.preview === true) return json({ ok: true, before: "old", after: "new", beforeCtx: "", afterCtx: "", fromLine: 1, toLine: 1, baseHash: "b1", previewHash: "p1" });
      return json({ ok: true, committed: true });
    }
    return json({}, 404);
  };
  await openTab();
  document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`)!.classList.add("active");
  await settle();
  const apply = document.querySelector<HTMLButtonElement>("[data-discuss-apply]")!;
  localStorage.setItem("muninn-discuss-user-a-bot", "rune"); // another window
  apply.click();
  await settle();
  const before = reads.length;
  // The shell's render after the Apply: the agent off, then on again.
  setDiscussAgentEnabled(false);
  setDiscussAgentEnabled(true);
  await settle();
  expect(reads.length).toBe(before);
  expect(document.querySelector(".wiki-discuss-turns")!.textContent).toContain("Fix it?");
  document.body.innerHTML = "";
});
