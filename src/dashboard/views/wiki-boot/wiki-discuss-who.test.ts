/**
 * Discuss v3 P1 fix round 2 batch 1: who answers, enumerated. One table walks
 * the state space of the page view's user: the read (the light `?who=1` read
 * at page render, the full read when the tab shows, a pick's re-read) × its
 * outcome × whether the view holds the page's thread × `MUNINN_AUTH` on/off,
 * and asserts every output the reader or the engine sees: the `userId` a
 * send posts (`sendUserOf`, R2) and what the engine does with it, «Runs as»
 * (`discussRunsAsHere`), the users the who box offers and whether they are
 * choosable (`discussWhoUsersHere`), the kept user K, and whether the
 * reader's next look reads again (`retryDiscussWho`). Sequence rows pin the
 * transitions round 1's code left unpinned (resetView, the retry set, the
 * who box's retry, a re-render).
 *
 * The fake server is the engine's user rule (`resolveUser`): a posted id
 * must be one of the bot's chat users or it is refused 422 `unknown-user`;
 * with none posted the bot's default user answers, refused `no-user` when
 * there is none; a send naming a thread must be its owner's (409). The route
 * sends `users` only with `MUNINN_AUTH=off`.
 *
 * Own process: it installs happy-dom's globals and wires the tab's and the
 * menu's document listeners once, so it is alone in its `bun test` link.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { DISCUSS_TAB, discussRunsAsHere, discussWhoUsersHere, initDiscussTab, pickDiscussUser, retryDiscussWho, setDiscussAgentEnabled } from "../components/wiki-discuss-tab.ts";
import { discussTabBodyHtml } from "../components/wiki-discuss-tab-view.ts";
import { initSelectionMenu, setSelectionMenuPage } from "../components/wiki-selection-menu.ts";

const g = globalThis as unknown as Record<string, unknown>;
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();
const realFetch = globalThis.fetch;

const REL = "plans/ferry.mdx";
/** Each row's own bot (a K key no other row's late answer can write). */
let BOT = "bot";
const TEXT = "The night route is unchanged.";
const KARI = { id: "u1", name: "Kari" };
const OLA = { id: "u2", name: "Ola" };
const PER = { id: "u7", name: "Per" };
const noUserText = () => `pick the user this discussion belongs to: ${srv.bot} has no default chat user`;
const NOBOT = "no bot answers on this wiki here";
const NET = "the server did not answer";
const DOWN = "down";
const unknownText = (id: string) => `the user "${id}" is not one of ${srv.bot}'s chat users`;

// ── The fake server ─────────────────────────────────────────────────────

type Fail = "net0" | "5xx" | "noBot" | null;
interface Gate {
  light: boolean;
  release: () => void;
  p: Promise<void>;
  answer: () => Response;
}
const srv = {
  bot: BOT,
  users: [KARI, OLA] as { id: string; name: string }[],
  def: "u1" as string | null,
  auth: "off" as "off" | "on",
  /** Each user's live thread on the page. */
  threads: new Map<string, string>(),
  /** Thread reads fail so (a POST only on `noBot`, the engine's own refusal). */
  fail: null as Fail,
  /** Every thread read: no answer at all (the check phase holds them). */
  holdAll: false,
  gates: [] as Gate[],
  reads: [] as URL[],
  posts: [] as { body: Record<string, unknown>; status: number }[],
};
let wiki = "w";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The engine's `resolveUser`. */
function resolve(posted: string | null): { userId: string; username: string | null } | { status: number; body: Record<string, unknown> } {
  if (posted !== null) {
    const hit = srv.users.find((u) => u.id === posted);
    if (!hit) return { status: 422, body: { error: unknownText(posted), reason: "unknown-user", users: srv.users } };
    return { userId: hit.id, username: hit.name };
  }
  if (!srv.def) return { status: 422, body: { error: noUserText(), reason: "no-user", bot: srv.bot, users: srv.users } };
  return { userId: srv.def, username: srv.users.find((u) => u.id === srv.def)?.name ?? null };
}

/** A read's answer as the route gives it, for `posted` (the user it names, if any). */
function readAnswer(u: URL, posted: string | null): Response {
  if (srv.fail === "net0") throw new TypeError("Failed to fetch");
  if (srv.fail === "5xx") return json({ error: DOWN }, 503);
  if (srv.fail === "noBot") return json({ error: NOBOT, reason: "no-bot" }, 503);
  const who = resolve(posted);
  if ("status" in who) return json(who.body, who.status);
  const t = srv.threads.get(who.userId);
  const body: Record<string, unknown> = { userId: who.userId, userName: who.username, userChoosable: srv.auth === "off", users: srv.auth === "off" ? srv.users : [], bot: srv.bot, thread: t ? { id: t } : null };
  if (u.searchParams.get("who") !== "1") Object.assign(body, { messages: [], closed: [], closedTotal: 0, oneShot: [] });
  return json(body);
}

async function serveRead(u: URL): Promise<Response> {
  srv.reads.push(u);
  if (srv.holdAll) return new Promise<Response>(() => {});
  const light = u.searchParams.get("who") === "1";
  const i = srv.gates.findIndex((gt) => gt.light === light);
  if (i >= 0) {
    const gate = srv.gates.splice(i, 1)[0]!;
    await gate.p;
    return gate.answer();
  }
  return readAnswer(u, u.searchParams.get("userId"));
}

/** The engine's start: the user rule, then the thread's owner; a turn that
 *  starts streams its `turn` frame and ends at once. */
function servePost(body: Record<string, unknown>): Response {
  const done = (status: number, b: unknown) => {
    srv.posts.push({ body, status });
    return json(b, status);
  };
  if (srv.fail === "noBot") return done(503, { error: NOBOT, reason: "no-bot" });
  const who = resolve(typeof body.userId === "string" ? body.userId : null);
  if ("status" in who) return done(who.status, who.body);
  if (typeof body.discussionId === "string") {
    const owner = [...srv.threads].find(([, t]) => t === body.discussionId)?.[0];
    if (owner !== who.userId) return done(409, { error: "that discussion belongs to another user", reason: "other-user" });
  }
  const thread = srv.threads.get(who.userId) ?? `t-${who.userId}`;
  srv.threads.set(who.userId, thread);
  srv.posts.push({ body, status: 200 });
  const frames = `event: turn\ndata: ${JSON.stringify({ turnId: `turn-${srv.posts.length}`, seq: 1, discussionId: thread, userId: who.userId })}\n\nevent: done\ndata: ${JSON.stringify({ answer: "ok", proposedEdit: null })}\n\n`;
  return new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function gate(light: boolean, answer: () => Response): Gate {
  let release: () => void = () => {};
  const p = new Promise<void>((r) => (release = r));
  const gt = { light, release, p, answer };
  srv.gates.push(gt);
  return gt;
}
/** A read answered as `userId` (a dropped, stale answer must not land). */
const answerAs = (userId: string) => () => readAnswer(new URL(`http://x/?who=1&userId=${userId}`), userId);

// ── The document ────────────────────────────────────────────────────────

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
    if (url.startsWith("/api/wiki/discuss/thread?")) return serveRead(new URL(url, "http://x"));
    if (url === "/api/wiki/discuss" && init?.method === "POST") return servePost(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (url.startsWith("/chat/threads/") && init?.method === "DELETE") return json({ ok: true });
    return json({}, 404);
  }) as typeof fetch;
  document.body.innerHTML = `<div id="articleWrap"></div><button data-conntab="${DISCUSS_TAB}" hidden>Discuss</button>${discussTabBodyHtml()}`;
  initDiscussTab({ wiki: () => wiki, relPath: () => REL, switchTab: tabSwitch });
  initSelectionMenu({
    wiki: () => wiki,
    relPath: () => REL,
    currentName: () => "ferry",
    pageType: () => "plan",
    graphId: "wikiGraph",
    explainUrl: (sel) => `/api/wiki/explain?sel=${encodeURIComponent(sel)}`,
    factcheck: () => {},
    hrefFor: (r) => `/wiki?relPath=${r}`,
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [key, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete g[key];
  }
  saved.clear();
});

/** The shell's `switchConnTab`: the tab marked, its body shown. */
function tabSwitch(tab: string): void {
  document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`)!.classList.toggle("active", tab === DISCUSS_TAB);
  document.getElementById("discussBody")!.style.display = tab === DISCUSS_TAB ? "flex" : "none";
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await flush();
  await new Promise((r) => setTimeout(r, 12));
};

/** The page renders: the article, the agent on, the bar's who line. */
function render(): void {
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2><p>${TEXT}</p></div>`;
  setDiscussAgentEnabled(true);
  setSelectionMenuPage({ mentions: false, discussWho: { bot: BOT, origin: "owner", connector: "copilot-sdk", model: "m-1" } });
}
/** The Discuss tab's click (the full read). */
function showTab(): void {
  (document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`) as HTMLElement).click();
}
/** A Delete of an earlier thread (the full read again, keeping the live thread). */
function deleteEarlier(): void {
  const b = document.createElement("button");
  b.dataset.discussDeleteThread = "t-closed";
  document.body.appendChild(b);
  b.click();
  b.remove();
}
/** The tab's own box sends a turn. */
async function send(): Promise<void> {
  (document.getElementById("wikiDiscussInput") as HTMLTextAreaElement).value = "Why?";
  (document.getElementById("wikiDiscussAskBtn") as HTMLElement).click();
  await settle();
}
const lightReads = (w = wiki) => srv.reads.filter((u) => u.searchParams.get("who") === "1" && u.searchParams.get("wiki") === w).length;
const kept = () => localStorage.getItem(`muninn-discuss-user-${localStorage.getItem(`muninn-discuss-bot-${wiki}`) ?? BOT}`);

let rowSeq = 0;
/** A fresh page view (its own wiki), the server as the row sets it up. */
function fresh(o: { auth: "off" | "on"; def?: string | null; K?: string; botKnown?: boolean; users?: { id: string; name: string }[]; threads?: [string, string][] }): void {
  wiki = `w${++rowSeq}`;
  BOT = `b${rowSeq}`;
  // The tab off: a render with it shown reads the full thread, not the light read.
  tabSwitch("conn");
  localStorage.clear();
  for (const gt of srv.gates) gt.release();
  Object.assign(srv, { bot: BOT, users: o.users ?? [KARI, OLA], def: o.def === undefined ? "u1" : o.def, auth: o.auth, threads: new Map(o.threads ?? []), fail: null, holdAll: false, gates: [] });
  if (o.K || o.botKnown) localStorage.setItem(`muninn-discuss-bot-${wiki}`, BOT);
  if (o.K) localStorage.setItem(`muninn-discuss-user-${BOT}`, o.K);
}

// ── The table ───────────────────────────────────────────────────────────

type Kind = "light" | "full" | "pick";
type Outcome = "okListed" | "okKept" | "okUnlisted" | "okUnlistedHolds" | "noUser" | "unknownUser" | "noBot" | "net0" | "5xx" | "stale" | "botChange";
interface Want {
  /** The `userId` the next send posts (null: none), the thread it names, and the engine's status for it. */
  send: string | null;
  T: string | null;
  post: number;
  /** «Runs as»: `u1 Kari`, `! <refusal text>`, or `…`. */
  runs: string;
  who: string[];
  choosable: boolean | null;
  K: string | null;
  /** The reader's next look (Explain's tooltip, the who box) reads again. */
  retry: boolean;
}
interface Row {
  kind: Kind;
  outcome: Outcome;
  holds: boolean;
  auth: "off" | "on";
  want: Want;
  /** The defect a row pins (red on the unfixed code), else it pins behaviour already right. */
  pins?: string;
}

const W = (send: string | null, T: string | null, post: number, runs: string, who: string[], choosable: boolean | null, K: string | null, retry: boolean): Want => ({ send, T, post, runs, who, choosable, K, retry });
/** Refusal texts that name the row's bot, filled in when the row runs. */
const NOUSER = "\u0000no-user";
const UNKNOWN7 = "\u0000unknown-u7";
const lazyText = (t: string): string => (t === `! ${NOUSER}` ? `! ${noUserText()}` : t === `! ${UNKNOWN7}` ? `! ${unknownText("u7")}` : t);
const BOTH = ["u1", "u2"];

/* Light read, the view holds no thread. Rows by outcome; auth off, then on. */
const LIGHT: Row[] = [
  { kind: "light", outcome: "okListed", holds: false, auth: "off", want: W("u1", null, 200, "u1 Kari", BOTH, true, null, false) },
  { kind: "light", outcome: "okListed", holds: false, auth: "on", want: W(null, null, 200, "u1 Kari", [], false, null, false) },
  { kind: "light", outcome: "okKept", holds: false, auth: "off", want: W("u2", null, 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "light", outcome: "okKept", holds: false, auth: "on", want: W("u2", null, 200, "u2 Ola", [], false, "u2", false) },
  { kind: "light", outcome: "okUnlisted", holds: false, auth: "off", want: W(null, null, 200, "u9 u9", BOTH, true, null, false) },
  { kind: "light", outcome: "okUnlisted", holds: false, auth: "on", want: W(null, null, 200, "u9 u9", [], false, null, false) },
  { kind: "light", outcome: "okUnlistedHolds", holds: false, auth: "off", want: W(null, null, 200, "u9 u9", BOTH, true, null, false), pins: "1" },
  { kind: "light", outcome: "okUnlistedHolds", holds: false, auth: "on", want: W(null, null, 200, "u9 u9", [], false, null, false), pins: "1" },
  { kind: "light", outcome: "noUser", holds: false, auth: "off", want: W(null, null, 422, `! ${NOUSER}`, BOTH, true, null, false) },
  { kind: "light", outcome: "noUser", holds: false, auth: "on", want: W(null, null, 422, `! ${NOUSER}`, BOTH, true, null, false) },
  { kind: "light", outcome: "unknownUser", holds: false, auth: "off", want: W("u1", null, 200, "u1 Kari", BOTH, true, null, false) },
  { kind: "light", outcome: "unknownUser", holds: false, auth: "on", want: W(null, null, 200, "u1 Kari", [], false, null, false) },
  { kind: "light", outcome: "noBot", holds: false, auth: "off", want: W(null, null, 503, `! ${NOBOT}`, [], null, null, false) },
  { kind: "light", outcome: "noBot", holds: false, auth: "on", want: W(null, null, 503, `! ${NOBOT}`, [], null, null, false) },
  { kind: "light", outcome: "net0", holds: false, auth: "off", want: W(null, null, 200, `! ${NET}`, [], null, null, true) },
  { kind: "light", outcome: "net0", holds: false, auth: "on", want: W(null, null, 200, `! ${NET}`, [], null, null, true) },
  { kind: "light", outcome: "5xx", holds: false, auth: "off", want: W(null, null, 200, `! ${DOWN}`, [], null, null, true) },
  { kind: "light", outcome: "5xx", holds: false, auth: "on", want: W(null, null, 200, `! ${DOWN}`, [], null, null, true) },
  // Stale: the full read (the tab shown) starts while it is in flight; its answer (as u2) is dropped.
  { kind: "light", outcome: "stale", holds: false, auth: "off", want: W("u1", null, 200, "u1 Kari", BOTH, true, "u1", false) },
  { kind: "light", outcome: "stale", holds: false, auth: "on", want: W(null, null, 200, "u1 Kari", [], false, null, false) },
];

/* Light read, the view holds a thread: the reader's look after a failed
 * light read, a send (its `turn` frame gave T) and a failed full read. The
 * holder is u2 (posted, so listed), u9 (the default, not a chat user) for
 * okUnlisted and noUser, u7 (posted, then no longer a chat user) for
 * unknownUser. okKept and okUnlistedHolds are okListed and okUnlisted here. */
const LIGHT_HOLDS: Row[] = [
  { kind: "light", outcome: "okListed", holds: true, auth: "off", want: W("u2", "t-u2", 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "light", outcome: "okListed", holds: true, auth: "on", want: W("u2", "t-u2", 200, "u2 Ola", [], false, "u2", false) },
  { kind: "light", outcome: "okUnlisted", holds: true, auth: "off", want: W(null, "t-u9", 200, "u9 u9", BOTH, true, null, false), pins: "1" },
  { kind: "light", outcome: "okUnlisted", holds: true, auth: "on", want: W(null, "t-u9", 200, "u9 u9", [], false, null, false), pins: "1" },
  { kind: "light", outcome: "noUser", holds: true, auth: "off", want: W(null, "t-u9", 422, `! ${NOUSER}`, BOTH, true, null, false), pins: "1" },
  { kind: "light", outcome: "noUser", holds: true, auth: "on", want: W(null, "t-u9", 422, `! ${NOUSER}`, BOTH, true, null, false), pins: "1" },
  { kind: "light", outcome: "unknownUser", holds: true, auth: "off", want: W("u7", "t-u7", 422, `! ${UNKNOWN7}`, BOTH, true, null, false) },
  { kind: "light", outcome: "unknownUser", holds: true, auth: "on", want: W("u7", "t-u7", 422, `! ${UNKNOWN7}`, BOTH, true, null, false) },
  { kind: "light", outcome: "noBot", holds: true, auth: "off", want: W("u2", "t-u2", 503, `! ${NOBOT}`, [], null, "u2", false) },
  { kind: "light", outcome: "noBot", holds: true, auth: "on", want: W("u2", "t-u2", 503, `! ${NOBOT}`, [], null, "u2", false) },
  { kind: "light", outcome: "net0", holds: true, auth: "off", want: W("u2", "t-u2", 200, `! ${NET}`, [], null, "u2", true) },
  { kind: "light", outcome: "net0", holds: true, auth: "on", want: W("u2", "t-u2", 200, `! ${NET}`, [], null, "u2", true) },
  { kind: "light", outcome: "5xx", holds: true, auth: "off", want: W("u2", "t-u2", 200, `! ${DOWN}`, [], null, "u2", true) },
  { kind: "light", outcome: "5xx", holds: true, auth: "on", want: W("u2", "t-u2", 200, `! ${DOWN}`, [], null, "u2", true) },
  // Stale: a Delete's full read starts while it is in flight; its answer (as u1) is dropped.
  { kind: "light", outcome: "stale", holds: true, auth: "off", want: W("u2", "t-u2", 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "light", outcome: "stale", holds: true, auth: "on", want: W("u2", "t-u2", 200, "u2 Ola", [], false, "u2", false) },
  // The wiki now answers on another bot, whose kept user is u1: a view holding T reads no one else (no re-read as u1).
  { kind: "light", outcome: "botChange", holds: true, auth: "off", want: W("u2", "t-u2", 200, "u2 Ola", BOTH, true, "u1", false) },
];

/* Full read (the tab shown; the page's light read is dropped as stale), no thread held before it. */
const FULL: Row[] = [
  { kind: "full", outcome: "okListed", holds: false, auth: "off", want: W("u1", null, 200, "u1 Kari", BOTH, true, "u1", false) },
  { kind: "full", outcome: "okListed", holds: false, auth: "on", want: W(null, null, 200, "u1 Kari", [], false, null, false) },
  { kind: "full", outcome: "okKept", holds: false, auth: "off", want: W("u2", null, 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "full", outcome: "okKept", holds: false, auth: "on", want: W("u2", null, 200, "u2 Ola", [], false, "u2", false) },
  { kind: "full", outcome: "okUnlisted", holds: false, auth: "off", want: W(null, null, 200, "u9 u9", BOTH, true, null, false) },
  { kind: "full", outcome: "okUnlisted", holds: false, auth: "on", want: W(null, null, 200, "u9 u9", [], false, null, false) },
  { kind: "full", outcome: "okUnlistedHolds", holds: false, auth: "off", want: W(null, "t9", 200, "u9 u9", BOTH, true, null, false), pins: "1" },
  { kind: "full", outcome: "okUnlistedHolds", holds: false, auth: "on", want: W(null, "t9", 200, "u9 u9", [], false, null, false), pins: "1" },
  { kind: "full", outcome: "noUser", holds: false, auth: "off", want: W(null, null, 422, `! ${NOUSER}`, BOTH, true, null, false) },
  { kind: "full", outcome: "noUser", holds: false, auth: "on", want: W(null, null, 422, `! ${NOUSER}`, BOTH, true, null, false) },
  { kind: "full", outcome: "unknownUser", holds: false, auth: "off", want: W("u1", null, 200, "u1 Kari", BOTH, true, "u1", false) },
  { kind: "full", outcome: "unknownUser", holds: false, auth: "on", want: W(null, null, 200, "u1 Kari", [], false, null, false) },
  { kind: "full", outcome: "noBot", holds: false, auth: "off", want: W(null, null, 503, `! ${NOBOT}`, [], null, null, false) },
  { kind: "full", outcome: "noBot", holds: false, auth: "on", want: W(null, null, 503, `! ${NOBOT}`, [], null, null, false) },
  { kind: "full", outcome: "net0", holds: false, auth: "off", want: W(null, null, 200, `! ${NET}`, [], null, null, true), pins: "3" },
  { kind: "full", outcome: "net0", holds: false, auth: "on", want: W(null, null, 200, `! ${NET}`, [], null, null, true), pins: "3" },
  { kind: "full", outcome: "5xx", holds: false, auth: "off", want: W(null, null, 200, `! ${DOWN}`, [], null, null, true), pins: "3" },
  { kind: "full", outcome: "5xx", holds: false, auth: "on", want: W(null, null, 200, `! ${DOWN}`, [], null, null, true), pins: "3" },
  // Stale: a pick of u2 starts a newer read; this one's answer (as u1) is dropped.
  { kind: "full", outcome: "stale", holds: false, auth: "off", want: W("u2", null, 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "full", outcome: "stale", holds: false, auth: "on", want: W("u2", null, 200, "u2 Ola", [], false, "u2", false) },
  // The wiki now answers on another bot, whose kept user u2 holds the page's thread: the re-read as u2 is the
  // answer, and u2 is listed by that post (with no `users` to say so on an authenticating instance).
  { kind: "full", outcome: "botChange", holds: false, auth: "off", want: W("u2", "t-u2", 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "full", outcome: "botChange", holds: false, auth: "on", want: W("u2", "t-u2", 200, "u2 Ola", [], false, "u2", false) },
];

/* Full read with a thread held (a Delete of an earlier thread after a good
 * first read). A failed read keeps what the first one named (`whoKnown`). */
const FULL_HOLDS: Row[] = [
  { kind: "full", outcome: "okListed", holds: true, auth: "off", want: W("u2", "t-u2", 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "full", outcome: "okListed", holds: true, auth: "on", want: W("u2", "t-u2", 200, "u2 Ola", [], false, "u2", false) },
  { kind: "full", outcome: "okUnlisted", holds: true, auth: "off", want: W(null, "t9", 200, "u9 u9", BOTH, true, null, false), pins: "1" },
  { kind: "full", outcome: "okUnlisted", holds: true, auth: "on", want: W(null, "t9", 200, "u9 u9", [], false, null, false), pins: "1" },
  { kind: "full", outcome: "noUser", holds: true, auth: "off", want: W(null, "t9", 422, "u9 u9", BOTH, true, null, false), pins: "1" },
  { kind: "full", outcome: "noUser", holds: true, auth: "on", want: W(null, "t9", 422, "u9 u9", BOTH, true, null, false), pins: "1" },
  { kind: "full", outcome: "unknownUser", holds: true, auth: "off", want: W("u7", "t7", 422, "u7 Per", BOTH, true, null, false) },
  { kind: "full", outcome: "unknownUser", holds: true, auth: "on", want: W("u7", "t7", 422, "u7 Per", BOTH, true, null, false) },
  { kind: "full", outcome: "noBot", holds: true, auth: "off", want: W("u2", "t-u2", 503, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "full", outcome: "noBot", holds: true, auth: "on", want: W("u2", "t-u2", 503, "u2 Ola", [], false, "u2", false) },
  { kind: "full", outcome: "net0", holds: true, auth: "off", want: W("u2", "t-u2", 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "full", outcome: "net0", holds: true, auth: "on", want: W("u2", "t-u2", 200, "u2 Ola", [], false, "u2", false) },
  { kind: "full", outcome: "5xx", holds: true, auth: "off", want: W("u2", "t-u2", 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "full", outcome: "5xx", holds: true, auth: "on", want: W("u2", "t-u2", 200, "u2 Ola", [], false, "u2", false) },
  { kind: "full", outcome: "stale", holds: true, auth: "off", want: W("u2", "t-u2", 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "full", outcome: "stale", holds: true, auth: "on", want: W("u2", "t-u2", 200, "u2 Ola", [], false, "u2", false) },
];

/* A pick's re-read (R3: it drops T, so never holds). A pick posts a listed
 * id: okKept, okUnlisted, okUnlistedHolds and noUser cannot follow one. */
const PICK: Row[] = [
  { kind: "pick", outcome: "okListed", holds: false, auth: "off", want: W("u2", null, 200, "u2 Ola", BOTH, true, "u2", false) },
  { kind: "pick", outcome: "okListed", holds: false, auth: "on", want: W("u2", null, 200, "u2 Ola", [], false, "u2", false) },
  { kind: "pick", outcome: "unknownUser", holds: false, auth: "off", want: W("u1", null, 200, "u1 Kari", ["u1"], true, "u1", false) },
  { kind: "pick", outcome: "unknownUser", holds: false, auth: "on", want: W(null, null, 200, "u1 Kari", [], false, null, false) },
  { kind: "pick", outcome: "noBot", holds: false, auth: "off", want: W("u2", null, 503, `! ${NOBOT}`, BOTH, null, "u2", false) },
  { kind: "pick", outcome: "noBot", holds: false, auth: "on", want: W("u2", null, 503, `! ${NOBOT}`, [], null, "u2", false) },
  { kind: "pick", outcome: "net0", holds: false, auth: "off", want: W("u2", null, 200, `! ${NET}`, BOTH, null, "u2", true), pins: "3" },
  { kind: "pick", outcome: "net0", holds: false, auth: "on", want: W("u2", null, 200, `! ${NET}`, [], null, "u2", true), pins: "3" },
  { kind: "pick", outcome: "5xx", holds: false, auth: "off", want: W("u2", null, 200, `! ${DOWN}`, BOTH, null, "u2", true), pins: "3" },
  { kind: "pick", outcome: "5xx", holds: false, auth: "on", want: W("u2", null, 200, `! ${DOWN}`, [], null, "u2", true), pins: "3" },
  // Stale: a pick of u2, then of u1 before it answers; the first answer (as u2) is dropped.
  { kind: "pick", outcome: "stale", holds: false, auth: "off", want: W("u1", null, 200, "u1 Kari", BOTH, true, "u1", false) },
  { kind: "pick", outcome: "stale", holds: false, auth: "on", want: W("u1", null, 200, "u1 Kari", [], false, "u1", false) },
];

const FAILS: Partial<Record<Outcome, Fail>> = { noBot: "noBot", net0: "net0", "5xx": "5xx" };

/** Drive a row to the state it names. */
async function drive(row: Row): Promise<void> {
  const { kind, outcome: o, holds, auth } = row;
  const fail = FAILS[o] ?? null;
  if (kind === "light" && !holds) {
    fresh({ auth, def: o === "okUnlisted" || o === "okUnlistedHolds" ? "u9" : o === "noUser" ? null : "u1", K: o === "okKept" ? "u2" : o === "unknownUser" ? "u7" : undefined, threads: o === "okUnlistedHolds" ? [["u9", "t9"]] : [] });
    srv.fail = fail;
    const held = o === "stale" ? gate(true, answerAs("u2")) : null;
    render();
    await settle();
    if (held) {
      showTab();
      await settle();
      held.release();
      await settle();
    }
    return;
  }
  if (kind === "light") {
    // The holder: u9 unasked (the default, no chat user), u7 posted then dropped, else u2 posted.
    const unlisted = o === "okUnlisted" || o === "noUser";
    fresh({ auth, def: unlisted ? "u9" : "u1", K: unlisted ? undefined : o === "unknownUser" ? "u7" : "u2", users: o === "unknownUser" ? [KARI, OLA, PER] : undefined });
    srv.fail = "5xx";
    render();
    await settle();
    await send(); // its full read fails too; the `turn` frame gives T
    srv.fail = fail;
    if (o === "noUser") srv.def = null;
    if (o === "unknownUser") srv.users = [KARI, OLA];
    if (o === "botChange") {
      srv.bot = `${BOT}-2`;
      localStorage.setItem(`muninn-discuss-user-${BOT}-2`, "u1");
    }
    const held = o === "stale" ? gate(true, answerAs("u1")) : null;
    retryDiscussWho();
    await settle();
    if (held) {
      deleteEarlier();
      await settle();
      held.release();
      await settle();
    }
    return;
  }
  if (kind === "full" && !holds) {
    // Stale: the bot known from an earlier session, so the pick that makes it stale has a K to write.
    fresh({ auth, botKnown: o === "stale" || o === "botChange", def: o === "okUnlisted" || o === "okUnlistedHolds" ? "u9" : o === "noUser" ? null : "u1", K: o === "okKept" ? "u2" : o === "unknownUser" ? "u7" : undefined, threads: o === "okUnlistedHolds" ? [["u9", "t9"]] : o === "botChange" ? [["u2", "t-u2"]] : [] });
    if (o === "botChange") {
      srv.bot = `${BOT}-2`;
      localStorage.setItem(`muninn-discuss-user-${BOT}-2`, "u2");
    }
    const light = gate(true, answerAs("u2"));
    render();
    await settle();
    srv.fail = fail;
    const held = o === "stale" ? gate(false, answerAs("u1")) : null;
    showTab();
    await settle();
    light.release(); // stale: the full read started after it
    await settle();
    if (held) {
      pickDiscussUser("u2");
      await settle();
      held.release();
      await settle();
    }
    return;
  }
  if (kind === "full") {
    const unlisted = o === "okUnlisted" || o === "noUser";
    const u7 = o === "unknownUser";
    fresh({ auth, def: unlisted ? "u9" : "u1", K: unlisted ? undefined : u7 ? "u7" : "u2", users: u7 ? [KARI, OLA, PER] : undefined, threads: unlisted ? [["u9", "t9"]] : u7 ? [["u7", "t7"]] : [["u2", "t-u2"]] });
    render();
    await settle();
    showTab();
    await settle();
    srv.fail = fail;
    if (o === "noUser") srv.def = null;
    if (u7) srv.users = [KARI, OLA];
    const held = o === "stale" ? gate(false, answerAs("u1")) : null;
    deleteEarlier();
    await settle();
    if (held) {
      deleteEarlier();
      await settle();
      held.release();
      await settle();
    }
    return;
  }
  // pick
  fresh({ auth });
  render();
  await settle();
  srv.fail = fail;
  if (o === "unknownUser") srv.users = [KARI];
  const held = o === "stale" ? gate(false, answerAs("u2")) : null;
  pickDiscussUser("u2");
  await settle();
  if (held) {
    pickDiscussUser("u1");
    await settle();
    held.release();
    await settle();
  }
}

const runsText = (): string => {
  const r = discussRunsAsHere();
  return r.state === "user" ? `${r.userId} ${r.name}` : r.state === "refused" ? `! ${r.text}` : "…";
};

/** Every output of the state the row drove to: read first, then the
 *  reader's look (its read held, so nothing moves), then a send. */
async function observe(): Promise<Want> {
  const who = discussWhoUsersHere();
  const out = { runs: runsText(), who: who.users.map((u) => u.id), choosable: who.choosable, K: kept() };
  srv.fail = srv.fail === "noBot" ? "noBot" : null;
  srv.holdAll = true;
  const before = lightReads();
  retryDiscussWho();
  await settle();
  const retry = lightReads() > before;
  const n = srv.posts.length;
  await send();
  const p = srv.posts.length > n ? srv.posts.at(-1)! : null;
  return {
    send: p && typeof p.body.userId === "string" ? p.body.userId : null,
    T: p && typeof p.body.discussionId === "string" ? p.body.discussionId : null,
    post: p?.status ?? -1,
    ...out,
    retry,
  };
}

/** Sequence rows: transitions the outcome rows do not reach. Each returns the failures it found. */
const SEQUENCES: { name: string; pins?: string; run: () => Promise<string | null> }[] = [
  {
    // Defect 2: a refused light read's users stay the who box's after a later light read names the user.
    name: "light no-user refusal, then a render's light read answers (auth on, u9): the who box drops the refusal's users",
    pins: "2",
    run: async () => {
      fresh({ auth: "on", def: null });
      render();
      await settle();
      srv.def = "u9";
      render();
      await settle();
      const w = discussWhoUsersHere();
      const got = JSON.stringify({ runs: runsText(), who: w.users.map((u) => u.id), choosable: w.choosable });
      const want = JSON.stringify({ runs: "u9 u9", who: [], choosable: false });
      return got === want ? null : `got ${got}, want ${want}`;
    },
  },
  {
    // resetView clears whoRefusal: a page another page's pick reset shows «…» while its new light read runs.
    name: "a refused page, reset by another page's pick, shows «…» while its light read runs again",
    run: async () => {
      fresh({ auth: "off" });
      const a = wiki;
      localStorage.setItem(`muninn-discuss-bot-${a}`, BOT);
      srv.fail = "5xx";
      render();
      await settle();
      srv.fail = null;
      wiki = `${a}-b`;
      render();
      await settle();
      pickDiscussUser("u2");
      await settle();
      srv.holdAll = true;
      wiki = a;
      render();
      await settle();
      return runsText() === "…" && lightReads(a) === 2 ? null : `runs ${runsText()}, light reads ${lightReads(a)}`;
    },
  },
  {
    // resetView clears whoLoading: a page whose light read never answered reads again after a reset.
    name: "a page whose light read is in flight, reset by another page's pick, reads again on its next render",
    run: async () => {
      fresh({ auth: "off" });
      const a = wiki;
      localStorage.setItem(`muninn-discuss-bot-${a}`, BOT);
      gate(true, answerAs("u1")); // never released
      render();
      await settle();
      wiki = `${a}-b`;
      render();
      await settle();
      pickDiscussUser("u2");
      await settle();
      wiki = a;
      render();
      await settle();
      return lightReads(a) === 2 && runsText() === "u2 Ola" ? null : `light reads ${lightReads(a)}, runs ${runsText()}`;
    },
  },
  {
    // The who box retries on its own open: a look that failed again is read again when «Change…» opens the box.
    name: "a light read with no answer: Explain's tooltip reads again, and «Change…» opening the who box reads once more",
    run: async () => {
      fresh({ auth: "off" });
      srv.fail = "net0";
      render();
      await settle();
      const p = document.querySelector(".wiki-article p")!.firstChild!;
      const r = document.createRange();
      r.setStart(p, 0);
      r.setEnd(p, TEXT.length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r);
      document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      await settle();
      document.getElementById("wikiExplainBtn")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await settle();
      const afterTip = lightReads();
      (document.querySelector("#wikiSelTip [data-selwho-open]") as HTMLButtonElement).click();
      await settle();
      const afterBox = lightReads();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return afterTip === 2 && afterBox === 3 ? null : `after the tooltip ${afterTip}, after the box ${afterBox} (want 2, 3)`;
    },
  },
  {
    // whoRetry.delete: a retry the server then refuses (4xx) is not retried again.
    name: "a light read with no answer, retried and refused no-user: no further look reads again",
    run: async () => {
      fresh({ auth: "off", def: null });
      srv.fail = "net0";
      render();
      await settle();
      srv.fail = null;
      retryDiscussWho();
      await settle();
      retryDiscussWho();
      await settle();
      return lightReads() === 2 ? null : `light reads ${lightReads()} (want 2)`;
    },
  },
  {
    // The `whoKnown` guard: a page whose light read named the user does not read it again on a render.
    name: "a light read that named the user: a render of the same page sends no second light read",
    run: async () => {
      fresh({ auth: "off" });
      render();
      await settle();
      render();
      await settle();
      return lightReads() === 1 ? null : `light reads ${lightReads()} (want 1)`;
    },
  },
];

const ROWS = [...LIGHT, ...LIGHT_HOLDS, ...FULL, ...FULL_HOLDS, ...PICK];

test("who answers, enumerated: every read × outcome × thread held × auth row, and the sequence rows", async () => {
  const failures: string[] = [];
  for (const row of ROWS) {
    const name = `${row.kind} ${row.outcome} ${row.holds ? "holds" : "no-thread"} auth-${row.auth}${row.pins ? ` [defect ${row.pins}]` : ""}`;
    await drive(row);
    const got = await observe();
    const want = { ...row.want, runs: lazyText(row.want.runs) };
    for (const k of Object.keys(want) as (keyof Want)[]) {
      if (JSON.stringify(got[k]) !== JSON.stringify(want[k])) failures.push(`${name}: ${k} ${JSON.stringify(got[k])}, want ${JSON.stringify(want[k])}`);
    }
  }
  for (const s of SEQUENCES) {
    const f = await s.run();
    if (f) failures.push(`${s.name}${s.pins ? ` [defect ${s.pins}]` : ""}: ${f}`);
  }
  for (const gt of srv.gates) gt.release();
  srv.holdAll = false;
  expect(failures).toEqual([]);
}, 120_000);
