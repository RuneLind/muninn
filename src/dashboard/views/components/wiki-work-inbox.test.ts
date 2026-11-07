import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DecisionInboxBody, InboxCard } from "../../routes/wiki-decision-inbox.ts";
import type { TriageStatusBody } from "../../routes/wiki-decision-triage-status.ts";
import { TRIAGE_CHECKED_3_CARDS } from "../../../../e2e/triage-patterns.ts";
import { handleInboxClick, inboxHtml, initInbox, loadInbox } from "./wiki-work-inbox.ts";

// The module's state is shared with the start-cards suites in one `bun test` process:
// drop the repaint they wired, and give a late paint of theirs no card to write into.
const saved = { fetch: globalThis.fetch, document: (globalThis as { document?: unknown }).document };
beforeAll(() => {
  (globalThis as { document?: unknown }).document = { getElementById: () => null };
  initInbox(() => {});
});
afterAll(() => {
  globalThis.fetch = saved.fetch;
  (globalThis as { document?: unknown }).document = saved.document;
});

const XSS = `<img src=x onerror="alert(1)">`;
const card = (over: Partial<InboxCard>): InboxCard => ({
  relPath: "plans/a.mdx", id: "O1", title: "A", body: "Which?", question: "Which?", bodyHtml: "", structured: null, choices: [], recommendation: null, targets: [], added: null, laneSince: null, answers: [], hint: null, viewerAnswered: false, lane: "ask", ...over,
});

async function load(body: DecisionInboxBody | null, status = 200): Promise<void> {
  globalThis.fetch = (async () => ({ ok: status === 200, status, json: async () => body })) as unknown as typeof fetch;
  loadInbox(`/api/wiki/decision-inbox?wiki=w${Math.random()}`);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("lanes holding cards print, «close?» and «ask you» open, «default» folded, with their counts", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "close", answers: [{ author: "R", choice: "A", body: "", at: "2026-11-01T10:00:00Z", questionChanged: false }] }), card({ id: "O2" }), card({ id: "O3", lane: "default" }), card({ id: "O4", lane: "default" })] });
  const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
  const lane = (l: string) => new RegExp(`<details class="wiki-wi-lane" data-wi-lane="${l}"( open)?>.*?wiki-wm-count">(\\d+)<`).exec(html);
  expect([lane("close")![1], lane("close")![2]]).toEqual([" open", "1"]);
  expect([lane("ask")![1], lane("ask")![2]]).toEqual([" open", "1"]);
  expect(lane("pass")).toBeNull();
  expect([lane("default")![1], lane("default")![2]]).toEqual([undefined, "2"]);
  expect(html).toContain("Decisions · 4 open");
  expect(html).toContain('wiki-wi-empty">Nothing to pass on.</div>');
});

test("empty lanes fold into one line, in lane order, with no «None.»", async () => {
  await load({ wiki: "w", cards: [card({ id: "O3", lane: "default" })] });
  const html = inboxHtml(() => "", Date.now());
  expect(html).not.toContain("None.");
  expect(html.match(/<details/g)!.length).toBe(1);
  expect(html).toContain("Nothing to close · for you · to pass on.");
});

test("the first lane holding cards opens even when it is «default»; the reader's toggle still wins", async () => {
  await load({ wiki: "w", cards: [card({ id: "O3", lane: "default" })] });
  expect(inboxHtml(() => "", Date.now())).toContain('data-wi-lane="default" open');
  const summary = { parentElement: { open: true, getAttribute: () => "default" } };
  handleInboxClick({ closest: (s: string) => (s === "#wikiWorkInbox" ? {} : s === "[data-wi-lane] > summary" ? summary : null) } as unknown as Element, () => "");
  expect(inboxHtml(() => "", Date.now())).toContain('data-wi-lane="default">');
});

test("no empty line when every lane holds a card", async () => {
  await load({ wiki: "w", cards: (["close", "ask", "pass", "default"] as const).map((lane, i) => card({ id: `O${i}`, lane })) });
  expect(inboxHtml(() => "", Date.now())).not.toContain("wiki-wi-empty");
});

test("a row is titled by the card's question", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", body: "**Which layout?**\n\nmore", question: "Which layout?" })] });
  expect(inboxHtml(() => "", Date.now())).toContain("O1 · Which layout?<span");
});

test("every page string is escaped", async () => {
  await load({ wiki: "w", cards: [card({ id: XSS, title: XSS, body: XSS, question: XSS, lane: "pass", targets: [XSS] })] });
  const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("a wiki out of scope (404) paints no section", async () => {
  await load(null, 404);
  expect(inboxHtml(() => "", Date.now())).toBe("");
});

// A click on a row's control, as the card's handler passes it.
function click(act: string, key: string, extra: Record<string, string> = {}): boolean {
  const el = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => attrs[n] ?? null });
  const target = {
    closest: (s: string) =>
      s === "#wikiWorkInbox" ? {} : s === "[data-wi-act]" ? el({ "data-wi-act": act, ...extra }) : s === "[data-wi-key]" ? el({ "data-wi-key": key }) : null,
  } as unknown as Element;
  return handleInboxClick(target, (rel) => `/wiki?relPath=${rel}`);
}
const g = globalThis as { CSS?: unknown };
g.CSS ??= { escape: (s: string) => s };

test("an open row escapes its body, answers, authors, choices and hint", async () => {
  const c = card({
    id: "O9", lane: "close", body: XSS, choices: [XSS], recommendation: XSS,
    answers: [{ author: XSS, choice: XSS, body: XSS, at: "2026-11-01T10:00:00Z", questionChanged: false }],
    hint: { decision: XSS, decisionText: XSS, namedBy: null, word: null, ownItem: null },
  });
  await load({ wiki: "w", cards: [c, card({ id: "O8", lane: "default", body: XSS, choices: [XSS], recommendation: XSS })] });
  click("row", "plans/a.mdx#O9");
  expect(inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now())).not.toContain("<img");
  click("row", "plans/a.mdx#O8");
  const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
  expect(html).toContain('class="wiki-wi-detail"');
  expect(html).not.toContain("<img");
});

test("a reply to one card's answer leaves another card's answer in flight", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "default", recommendation: "A", choices: ["A"] }), card({ id: "O2", lane: "default", recommendation: "A", choices: ["A"] })] });
  const replies: ((r: unknown) => void)[] = [];
  globalThis.fetch = ((url: string) =>
    url === "/api/wiki/answers" ? new Promise((res) => replies.push(res)) : new Promise(() => {})) as unknown as typeof fetch;
  click("take", "plans/a.mdx#O1");
  click("row", "plans/a.mdx#O2");
  click("take", "plans/a.mdx#O2");
  expect(replies.length).toBe(2);
  replies[0]!({ ok: true, status: 200, json: async () => ({}) });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  // O2's POST is still out: a second Take must not send again.
  click("take", "plans/a.mdx#O2");
  expect(replies.length).toBe(2);
  expect(inboxHtml(() => "", Date.now())).toMatch(/data-wi-act="take" disabled/);
});

test("a failed load says so, and keeps the cards it had", async () => {
  await load(null, 500);
  expect(inboxHtml(() => "", Date.now())).toContain("couldn’t load");
  const url = "/api/wiki/decision-inbox?wiki=keep";
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ wiki: "w", cards: [card({ id: "O1" })] }) })) as unknown as typeof fetch;
  loadInbox(url);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  loadInbox(url);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const html = inboxHtml(() => "", Date.now());
  expect(html).toContain("Decisions · 1 open");
  expect(html).toContain("couldn’t load");
});

test("a card the owner already answered offers the page, not a form that would 409", async () => {
  await load({ wiki: "w", cards: [card({ id: "O4", lane: "ask", choices: ["A", "B"], viewerAnswered: true, answers: [{ author: "R", choice: "not-sure", body: "", at: "2026-11-01T10:00:00Z", questionChanged: false }] })] });
  click("row", "plans/a.mdx#O4");
  const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
  expect(html).toContain("change it on the page");
  expect(html).not.toContain('data-wi-act="answer"');
});

test("an answer to older wording tags the row «wording changed», not «answered»", async () => {
  await load({ wiki: "w", cards: [card({ id: "O5", lane: "close", answers: [{ author: "R", choice: "A", body: "", at: "2026-11-01T10:00:00Z", questionChanged: true }] })] });
  const html = inboxHtml(() => "", Date.now());
  expect(html).toMatch(/wiki-wi-tag warn">wording changed</);
  expect(html).not.toContain(">answered<");
});

test("a 409 already_answered from a race says so, links the page and sends nothing more", async () => {
  await load({ wiki: "w", cards: [card({ id: "O3", lane: "default", recommendation: "A", choices: ["A"] })] });
  let posts = 0;
  globalThis.fetch = ((url: string) => {
    if (url !== "/api/wiki/answers") return new Promise(() => {});
    posts++;
    return Promise.resolve({ ok: false, status: 409, json: async () => ({ code: "already_answered", answerId: "a1", version: 1 }) });
  }) as unknown as typeof fetch;
  click("row", "plans/a.mdx#O3");
  click("take", "plans/a.mdx#O3");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
  expect(html).toContain("already has your answer");
  expect(html).toMatch(/wiki-wi-msg warn[^]*?data-relpath="plans\/a.mdx"/);
  expect(posts).toBe(1);
});

test("a good load after a failed one clears the failure line", async () => {
  const url = "/api/wiki/decision-inbox?wiki=recover";
  globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
  loadInbox(url);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(inboxHtml(() => "", Date.now())).toContain("couldn’t load");
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ wiki: "w", cards: [card({ id: "O1" })] }) })) as unknown as typeof fetch;
  loadInbox(url);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(inboxHtml(() => "", Date.now())).not.toContain("couldn’t load");
});

test("a 200 that is not an inbox says the server answered, not that it was silent", async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("<html>"); } })) as unknown as typeof fetch;
  loadInbox("/api/wiki/decision-inbox?wiki=html");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const html = inboxHtml(() => "", Date.now());
  expect(html).toContain("couldn’t load: HTTP 200, not an inbox");
  expect(html).not.toContain("did not answer");
});

test("a load repaints passively, so the card's selection and pointer hold apply", async () => {
  const calls: unknown[][] = [];
  initInbox((...args: unknown[]) => { calls.push(args); });
  try {
    await load({ wiki: "w", cards: [card({ id: "O1" })] });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((a) => a[1] === true)).toBe(true);
  } finally {
    initInbox(() => {});
  }
});

test("every repaint after an await is passive: an answer's reply and a copy's result", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "default", recommendation: "A", choices: ["A"] }), card({ id: "O2", lane: "pass", targets: ["Fag"] })] });
  const calls: { sel: unknown; passive: unknown }[] = [];
  initInbox((sel?: string, passive?: boolean) => { calls.push({ sel, passive }); });
  const g2 = globalThis as { location?: unknown; navigator?: unknown };
  const savedNav = g2.navigator, savedLoc = g2.location;
  try {
    globalThis.fetch = ((url: string) =>
      url === "/api/wiki/answers" ? Promise.resolve({ ok: true, status: 201, json: async () => ({}) }) : new Promise(() => {})) as unknown as typeof fetch;
    click("take", "plans/a.mdx#O1");
    const synchronous = calls.length;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    Object.defineProperty(globalThis, "location", { value: { href: "http://x/wiki" }, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });
    click("copy", "plans/a.mdx#O2");
    const beforeCopy = calls.length;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(synchronous).toBeGreaterThan(0);
    expect(calls.slice(synchronous, beforeCopy).length).toBeGreaterThan(0);
    expect(calls.slice(synchronous).every((c) => c.passive === true)).toBe(true);
    expect(calls.length).toBeGreaterThan(beforeCopy);
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: savedNav, configurable: true });
    Object.defineProperty(globalThis, "location", { value: savedLoc, configurable: true });
    initInbox(() => {});
  }
});

test("a «Still open» card that leaves one load and comes back is still kept", async () => {
  const store: Record<string, string> = {};
  const g3 = globalThis as { localStorage?: unknown };
  const savedLs = g3.localStorage;
  g3.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  try {
    const kept = card({ id: "O9", lane: "close", answers: [{ author: "R", choice: "A", body: "", at: "2026-11-01T10:00:00Z", questionChanged: false }] });
    await load({ wiki: "w", cards: [kept] });
    click("keep", "plans/a.mdx#O9");
    // One load without it (its page unreadable for a moment), then the next with it.
    await load({ wiki: "w", cards: [] });
    await load({ wiki: "w", cards: [kept] });
    expect(inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now())).not.toContain('data-wi-key="plans/a.mdx#O9"');
  } finally {
    g3.localStorage = savedLs;
  }
});

test("a close lane whose cards are all kept open stays, so «Show kept» can bring them back", async () => {
  const store: Record<string, string> = {};
  const g3 = globalThis as { localStorage?: unknown };
  const savedLs = g3.localStorage;
  g3.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  try {
    await load({ wiki: "w", cards: [card({ id: "O9", lane: "close" }), card({ id: "O2", lane: "ask" })] });
    click("keep", "plans/a.mdx#O9");
    const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
    expect(html).not.toContain('data-wi-key="plans/a.mdx#O9"');
    expect(html).toContain('data-wi-lane="close"');
    expect(html).toContain("Show 1 kept open");
    expect(html).not.toContain("Nothing to close");
  } finally {
    g3.localStorage = savedLs;
  }
});

test("the kept-open store holds at most 200 cards, dropping the oldest", async () => {
  const store: Record<string, string> = {};
  const g3 = globalThis as { localStorage?: unknown };
  const savedLs = g3.localStorage;
  g3.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  try {
    const old: Record<string, string> = {};
    for (let i = 0; i < 200; i++) old[`w|plans/old.mdx#O${i}`] = "[]";
    store["muninn-inbox-kept"] = JSON.stringify(old);
    await load({ wiki: "w", cards: [card({ id: "O9", lane: "close" })] });
    click("keep", "plans/a.mdx#O9");
    const kept = JSON.parse(store["muninn-inbox-kept"]!) as Record<string, string>;
    expect(Object.keys(kept).length).toBe(200);
    expect(kept["w|plans/old.mdx#O0"]).toBeUndefined();
    expect(kept["w|plans/a.mdx#O9"]).toBeDefined();
  } finally {
    g3.localStorage = savedLs;
  }
});

test("«Still open» hands focus to the lane, not to the row it hid", async () => {
  const kept = card({ id: "O8", lane: "close", answers: [{ author: "R", choice: "A", body: "", at: "2026-11-02T10:00:00Z", questionChanged: false }] });
  await load({ wiki: "w", cards: [kept] });
  const calls: (string | undefined)[] = [];
  initInbox((sel?: string) => { calls.push(sel); });
  try {
    click("keep", "plans/a.mdx#O8");
    expect(calls.at(-1)).toBe('[data-wi-lane="close"] > summary');
  } finally {
    initInbox(() => {});
  }
});

test("a close says so in the lane after the closed row has left it", async () => {
  const closing = card({ id: "O6", lane: "close", answers: [{ author: "R", choice: "A", body: "", at: "2026-11-02T10:00:00Z", questionChanged: false }] });
  await load({ wiki: "w", cards: [closing] });
  globalThis.fetch = (async (url: string) =>
    url.endsWith("/close")
      ? { ok: true, status: 200, json: async () => ({ ok: true, preview: true, lines: ["- x"], warnings: [], baseHash: "b", rulingHash: "r", decision: "D3" }) }
      : { ok: true, status: 200, json: async () => ({ wiki: "w", cards: [] }) }) as unknown as typeof fetch;
  click("preview", "plans/a.mdx#O6");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  globalThis.fetch = (async (url: string) =>
    url.endsWith("/close")
      ? { ok: true, status: 200, json: async () => ({ ok: true, decision: "D3" }) }
      : { ok: true, status: 200, json: async () => ({ wiki: "w", cards: [] }) }) as unknown as typeof fetch;
  click("close", "plans/a.mdx#O6");
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
  expect(html).not.toContain('data-wi-key="plans/a.mdx#O6"');
  expect(html).toContain("Closed O6 (D3).");
  // The lane is empty now but stays, open, to say so.
  expect(html).toContain('data-wi-lane="close" open');
});

test("after a close, focus goes to the lane, and a later close's refusal does not sit beside the old «Closed»", async () => {
  const mk = (id: string) => card({ id, lane: "close", answers: [{ author: "R", choice: "A", body: "", at: "2026-11-02T10:00:00Z", questionChanged: false }] });
  await load({ wiki: "w", cards: [mk("O6"), mk("O7")] });
  const calls: (string | undefined)[] = [];
  initInbox((sel?: string) => { calls.push(sel); });
  const reply = (closeBody: unknown, status = 200) =>
    (async (url: string) =>
      url.endsWith("/close") ? { ok: status === 200, status, json: async () => closeBody } : { ok: true, status: 200, json: async () => ({ wiki: "w", cards: [mk("O7")] }) }) as unknown as typeof fetch;
  const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  try {
    globalThis.fetch = reply({ ok: true, preview: true, lines: ["- x"], warnings: [], baseHash: "b", rulingHash: "r", decision: "D3" });
    click("preview", "plans/a.mdx#O6");
    await tick();
    globalThis.fetch = reply({ ok: true, decision: "D3" });
    click("close", "plans/a.mdx#O6");
    await tick();
    expect(calls).toContain('[data-wi-lane="close"] > summary');
    globalThis.fetch = reply({ error: "refused" }, 409);
    click("preview", "plans/a.mdx#O7");
    await tick();
    const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
    expect(html).toContain("Couldn’t close: refused.");
    expect(html).not.toContain("Closed O6 (D3).");
  } finally {
    initInbox(() => {});
  }
});

test("a preview's warnings show above its lines, escaped, and a close's line sits in the «close?» lane", async () => {
  const mk = (id: string) => card({ id, lane: "close", answers: [{ author: "R", choice: "A", body: "", at: "2026-11-02T10:00:00Z", questionChanged: false }] });
  await load({ wiki: "w", cards: [mk("O6"), card({ id: "O1", lane: "ask" })] });
  const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, preview: true, lines: ["- x"], warnings: [`${XSS} answered B.`], baseHash: "b", rulingHash: "r", decision: "D3" }) })) as unknown as typeof fetch;
  click("row", "plans/a.mdx#O6");
  click("preview", "plans/a.mdx#O6");
  await tick();
  const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
  expect(html).toMatch(/<div class="wiki-wi-ev warn"><b>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; answered B\.<\/b><\/div><pre class="wiki-wi-pre"/);
  expect(html).not.toContain(XSS);
  globalThis.fetch = (async (url: string) =>
    url.endsWith("/close") ? { ok: true, status: 200, json: async () => ({ ok: true, decision: "D3" }) } : { ok: true, status: 200, json: async () => ({ wiki: "w", cards: [card({ id: "O1", lane: "ask" })] }) }) as unknown as typeof fetch;
  click("close", "plans/a.mdx#O6");
  await tick();
  const after = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
  const closeLane = /<details class="wiki-wi-lane" data-wi-lane="close"[\s\S]*?<\/details>/.exec(after)![0];
  expect(closeLane).toContain("Closed O6 (D3).");
});

test("keeping a card again makes it the newest entry, so the cap drops others first", async () => {
  const store: Record<string, string> = {};
  const g3 = globalThis as { localStorage?: unknown };
  const savedLs = g3.localStorage;
  g3.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  try {
    const c = card({ id: "O9", lane: "close" });
    await load({ wiki: "w", cards: [c] });
    click("keep", "plans/a.mdx#O9");
    const fill: Record<string, string> = JSON.parse(store["muninn-inbox-kept"]!);
    for (let i = 0; i < 199; i++) fill[`w|plans/old.mdx#O${i}`] = "[]";
    store["muninn-inbox-kept"] = JSON.stringify(fill);
    click("keep", "plans/a.mdx#O9");
    const before = Object.keys(JSON.parse(store["muninn-inbox-kept"]!));
    expect(before.at(-1)).toBe("w|plans/a.mdx#O9");
  } finally {
    g3.localStorage = savedLs;
  }
});

const STRUCTURED = {
  context: "Today every lane prints.",
  rows: [
    { letter: "A", label: "lanes", why: "the four lanes <code>stay</code>." },
    { letter: "B", label: "one list", why: "every card." },
  ],
  recommendation: { letter: "A", why: "It fixes both faults.", qualified: false },
};

test("an opened structured card prints a row per choice, the recommended one marked, and its why", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "ask", choices: ["A", "B"], recommendation: "A", structured: STRUCTURED, bodyHtml: "RAW-FALLBACK" })] });
  click("row", "plans/a.mdx#O1");
  const html = inboxHtml(() => "", Date.now());
  expect(html).toContain('<div class="wiki-wi-context wiki-wi-rendered">Today every lane prints.</div>');
  expect(html).toContain('<div class="wiki-wi-choice rec" data-wi-row="A"><button class="wiki-wi-letter" data-wi-act="pick" data-wi-choice="A" aria-pressed="false" aria-describedby="wi-plans_a_mdx_O1-A-t wi-plans_a_mdx_O1-A-r">A</button><span class="wiki-wi-choice-text" id="wi-plans_a_mdx_O1-A-t"><b>lanes</b> the four lanes <code>stay</code>.</span><span class="wiki-wi-rec" id="wi-plans_a_mdx_O1-A-r">Recommended</span></div>');
  // A row that is not recommended is described by its text alone.
  expect(html).toContain('data-wi-choice="B" aria-pressed="false" aria-describedby="wi-plans_a_mdx_O1-B-t">B</button><span class="wiki-wi-choice-text" id="wi-plans_a_mdx_O1-B-t">');
  expect(html).toContain('<div class="wiki-wi-choice" data-wi-row="B"><button class="wiki-wi-letter" data-wi-act="pick" data-wi-choice="B"');
  expect(html).toContain("<b>Why A</b> It fixes both faults.");
  expect(html).not.toContain("RAW-FALLBACK");
  // The rows carry the letters now: only Not sure is a wiki-wi-btn among the picks.
  expect(html.match(/class="wiki-wi-btn[^"]*" data-wi-act="pick"/g)!.length).toBe(1);
  expect(html).toContain('data-wi-choice="not-sure"');
});

test("clicking a structured row picks it, and Answer sends that choice", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "ask", choices: ["A", "B"], structured: STRUCTURED })] });
  click("row", "plans/a.mdx#O1");
  click("pick", "plans/a.mdx#O1", { "data-wi-choice": "B" });
  const html = inboxHtml(() => "", Date.now());
  expect(html).toContain('<div class="wiki-wi-choice on" data-wi-row="B"><button class="wiki-wi-letter" data-wi-act="pick" data-wi-choice="B" aria-pressed="true"');
  expect(html).toMatch(/data-wi-act="answer">Answer/);
  let sent: unknown = null;
  globalThis.fetch = ((url: string, init?: { body?: string }) => {
    if (url === "/api/wiki/answers") sent = JSON.parse(init!.body!);
    return new Promise(() => {});
  }) as unknown as typeof fetch;
  click("answer", "plans/a.mdx#O1");
  expect((sent as { choice: string } | null)?.choice).toBe("B");
});

test("a structured card in the close lane shows its rows without the pick control", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "close", choices: ["A", "B"], structured: STRUCTURED })] });
  click("row", "plans/a.mdx#O1");
  const html = inboxHtml(() => "", Date.now());
  expect(html).toContain('<div class="wiki-wi-choice rec" data-wi-row="A"><span class="wiki-wi-letter">A</span>');
  expect(html).not.toContain('data-wi-act="pick"');
  expect(html).toContain('data-wi-act="preview"');
});

test("a qualified recommendation is headed «Recommendation:», not «Why X» before its own letter", async () => {
  const q = { ...STRUCTURED, recommendation: { letter: "A", why: "A, with B meanwhile. It fixes both.", qualified: true } };
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "ask", choices: ["A", "B"], structured: q })] });
  click("row", "plans/a.mdx#O1");
  const html = inboxHtml(() => "", Date.now());
  expect(html).toContain("<b>Recommendation:</b> A, with B meanwhile. It fixes both.");
  expect(html).not.toContain("<b>Why A</b>");
});

test("a structured row's pick button is disabled while the answer sends, and its letter is escaped", async () => {
  const q = { ...STRUCTURED, rows: [{ letter: XSS, label: "x", why: "y" }, STRUCTURED.rows[1]!], recommendation: null };
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "ask", choices: [XSS, "B"], structured: q })] });
  click("row", "plans/a.mdx#O1");
  let html = inboxHtml(() => "", Date.now());
  expect(html).not.toContain("<img");
  expect(html).toContain('data-wi-row="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"');
  expect(html).toContain('data-wi-choice="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"');
  click("pick", "plans/a.mdx#O1", { "data-wi-choice": "B" });
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
  click("answer", "plans/a.mdx#O1");
  html = inboxHtml(() => "", Date.now());
  expect(html).toMatch(/data-wi-choice="B" aria-pressed="true" aria-describedby="[^"]+" disabled>B<\/button>/);
});

test("a link in a choice row sits outside the pick button", async () => {
  const linked = { ...STRUCTURED, rows: [{ letter: "A", label: "lanes", why: 'see <a href="https://example.org/x">the spec</a>.' }, STRUCTURED.rows[1]!] };
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "ask", choices: ["A", "B"], structured: linked })] });
  click("row", "plans/a.mdx#O1");
  const html = inboxHtml(() => "", Date.now());
  // The pick button closes on its letter; the link comes after, in the row's text.
  expect(html).toMatch(/<div class="wiki-wi-choice rec" data-wi-row="A"><button [^>]*data-wi-act="pick"[^>]*>A<\/button><span class="wiki-wi-choice-text" id="[^"]+"><b>lanes<\/b> see <a href="https:\/\/example\.org\/x">/);
  expect(html).not.toMatch(/<button [^>]*data-wi-act="pick"(?:(?!<\/button>).)*<a /s);
});

test("an unstructured card prints the server's rendered body and today's pick buttons", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "ask", body: "**Q?**\n\nA or **B**?", choices: ["A", "B"], bodyHtml: "A or <strong>B</strong>?" })] });
  click("row", "plans/a.mdx#O1");
  const html = inboxHtml(() => "", Date.now());
  expect(html).toContain('<div class="wiki-wi-body wiki-wi-rendered">A or <strong>B</strong>?</div>');
  expect(html).not.toContain("**");
  expect(html.match(/class="wiki-wi-btn[^"]*" data-wi-act="pick"/g)!.length).toBe(3);
});

test("a card with no choices gets no pick rows", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "ask", bodyHtml: "Free text." })] });
  click("row", "plans/a.mdx#O1");
  expect(inboxHtml(() => "", Date.now())).not.toContain('data-wi-act="pick"');
});

const statusBody = (over: Partial<TriageStatusBody> = {}): TriageStatusBody => ({
  wiki: "w",
  lastRun: { at: Date.UTC(2026, 10, 7, 5, 12), outcome: "ok", reason: null, cards: 7, model: "none", codeFacts: 1 },
  nights: [{ night: "2026-11-07", outcome: "ok", reason: null, cards: 7, codeFacts: 1, answered: 2, reposNotFound: [XSS] }],
  reposNotFound: [{ repo: XSS, reason: "no such folder" }],
  nextDueAt: Date.UTC(2026, 10, 8, 4),
  broken: 0,
  pass: { on: true, why: null, modelOff: true },
  ...over,
});

async function loadWithStatus(status: TriageStatusBody | null, code = 200): Promise<void> {
  globalThis.fetch = (async (url: string) =>
    url.includes("/api/wiki/decision-triage/status")
      ? { ok: code === 200, status: code, json: async () => status }
      : { ok: true, status: 200, json: async () => ({ wiki: "w", cards: [card({ id: "O1" })] }) }) as unknown as typeof fetch;
  loadInbox(`/api/wiki/decision-inbox?wiki=w${Math.random()}`);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("the status line sits above the lanes: checked, cards, code facts, repos not found, model off, next", async () => {
  await loadWithStatus(statusBody());
  const html = inboxHtml(() => "", Date.UTC(2026, 10, 7, 9));
  const line = /<div class="wiki-wi-tri"[\s\S]*?<\/div>/.exec(html)![0];
  expect(line).toContain("Triage checked <b>06:12</b> · 7 cards · 1 with code facts");
  expect(line).toContain("1 repo not found");
  expect(line).toContain("model off");
  expect(line).toContain("next ~08.11 05:00");
  expect(html.indexOf("wiki-wi-tri")).toBeLessThan(html.indexOf("wiki-wi-lane"));
  expect(html).not.toContain("<img");
  expect(html).not.toContain("wiki-wi-tri-stats");
});

test("Details opens the per-night table, escaped; Hide folds it", async () => {
  await loadWithStatus(statusBody());
  click("tri-details", "");
  const html = inboxHtml(() => "", Date.UTC(2026, 10, 7, 9));
  expect(html).toContain('data-wi-act="tri-details" aria-expanded="true">Hide</button>');
  expect(html).toMatch(/<tr><td>07\.11<\/td><td>ok<\/td><td>7<\/td><td>1<\/td><td>2<\/td><td>&lt;img/);
  expect(html).not.toContain("<img");
  click("tri-details", "");
  expect(inboxHtml(() => "", Date.now())).not.toContain("wiki-wi-tri-stats");
});

test("a pass that is off says so in place of the next time; no run yet says that", async () => {
  await loadWithStatus(statusBody({ lastRun: null, nights: [], reposNotFound: [], pass: { on: false, why: "DECISION_TRIAGE_REPO_ROOTS is not set", modelOff: true } }));
  const html = inboxHtml(() => "", Date.now());
  expect(html).toContain("Triage has not run on this wiki");
  expect(html).toContain('title="DECISION_TRIAGE_REPO_ROOTS is not set">pass off</span>');
  expect(html).not.toContain("next ~");
  expect(html).not.toContain('data-wi-act="tri-details"');
});

test("the e2e's checked-line pattern holds at 01:30 Oslo for a run 2 h earlier (yesterday's date)", async () => {
  const now = Date.UTC(2026, 10, 7, 0, 30); // 01:30 Oslo
  await loadWithStatus(statusBody({ lastRun: { at: now - 2 * 3_600_000, outcome: "ok", reason: null, cards: 3, model: "none", codeFacts: 1 } }));
  const line = /<div class="wiki-wi-tri"[\s\S]*?<\/div>/.exec(inboxHtml(() => "", now))![0].replace(/<[^>]+>/g, "");
  expect(line).toMatch(TRIAGE_CHECKED_3_CARDS);
});

test("a run line's cards that is not a number never reaches the markup raw", async () => {
  await loadWithStatus(statusBody({ lastRun: { at: Date.now(), outcome: "ok", reason: null, cards: XSS as unknown as number, model: "none", codeFacts: 1 } }));
  expect(inboxHtml(() => "", Date.now())).not.toContain("<img");
});

test("the last run's reason is the outcome word's tooltip, and each night's is its Details outcome cell's, escaped", async () => {
  const reason = "the model call is off (D19), 6 card(s) with no facts <b>";
  await loadWithStatus(statusBody({
    lastRun: { at: Date.now(), outcome: "partial", reason, cards: 6, model: "none", codeFacts: 0 },
    nights: [{ night: "2026-11-07", outcome: "partial", reason, cards: 6, codeFacts: 0, answered: 0, reposNotFound: [] }],
  }));
  const escaped = "the model call is off (D19), 6 card(s) with no facts &lt;b&gt;";
  expect(inboxHtml(() => "", Date.now())).toContain(`<span title="${escaped}">partial</span>`);
  click("tri-details", "");
  const html = inboxHtml(() => "", Date.now());
  expect(html).toContain(`<td title="${escaped}">partial</td>`);
  expect(html).not.toContain("facts <b>");
  click("tri-details", "");
});

test("an ok last run adds no outcome word to the line", async () => {
  await loadWithStatus(statusBody({ lastRun: { at: Date.now(), outcome: "ok", reason: "all cards read", cards: 3, model: "none", codeFacts: 1 } }));
  const line = /<div class="wiki-wi-tri"[\s\S]*?<\/div>/.exec(inboxHtml(() => "", Date.now()))![0];
  expect(line).not.toContain(">ok<");
  expect(line).not.toContain("all cards read");
});

test("a status that fails or is not a status leaves the line out and the inbox whole", async () => {
  for (const [body, code] of [[null, 500], [null, 404], [{ wiki: "w", cards: [] } as unknown as TriageStatusBody, 200]] as const) {
    await loadWithStatus(body, code);
    const html = inboxHtml(() => "", Date.now());
    expect(html).not.toContain("wiki-wi-tri");
    expect(html).toContain("Decisions · 1 open");
  }
});

const runBtn = (html: string) => /<button[^>]*data-wi-act="tri-run"[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? "";

test("Run now sits on the line; off or model on, it is aria-disabled with why, and a click sends nothing", async () => {
  await loadWithStatus(statusBody());
  expect(runBtn(inboxHtml(() => "", Date.now()))).toMatch(/^<button class="wiki-wi-btn small" data-wi-act="tri-run" title="[^"]+">Run now<\/button>$/);
  for (const [pass, why] of [
    [{ on: false, why: "SCHEDULER_ENABLED is off", modelOff: true }, "The pass is off: SCHEDULER_ENABLED is off"],
    [{ on: true, why: null, modelOff: false }, "The model call is on: Run now never calls the model"],
  ] as const) {
    await loadWithStatus(statusBody({ pass }));
    const btn = runBtn(inboxHtml(() => "", Date.now()));
    expect(btn).toContain(`title="${why}"`);
    expect(btn).toContain('aria-disabled="true"');
    const sent: string[] = [];
    const before = globalThis.fetch;
    globalThis.fetch = (async (url: string) => (sent.push(url), { ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    expect(click("tri-run", "")).toBe(true);
    globalThis.fetch = before;
    expect(sent).toEqual([]);
  }
});

test("a click: busy while the POST is out, then the status is fetched again; a refusal shows its text inline", async () => {
  await loadWithStatus(statusBody());
  const sent: { url: string; method?: string }[] = [];
  let answer!: (r: unknown) => void;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method });
    if (url.includes("/run")) return new Promise((r) => (answer = r));
    return Promise.resolve({ ok: true, status: 200, json: async () => statusBody({ lastRun: { at: Date.now(), outcome: "ok", reason: null, cards: 9, model: "none", codeFacts: 0 } }) });
  }) as unknown as typeof fetch;
  click("tri-run", "");
  expect(sent).toEqual([{ url: "/api/wiki/decision-triage/run?wiki=w", method: "POST" }]);
  const busy = runBtn(inboxHtml(() => "", Date.now()));
  expect(busy).toContain('aria-busy="true"');
  expect(busy).toContain("Running…");
  click("tri-run", "");
  expect(sent).toHaveLength(1);
  answer({ ok: true, status: 200, json: async () => ({ wiki: "w", outcome: "ok", cards: 9 }) });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(sent.map((s) => s.url)[1]).toContain("/api/wiki/decision-triage/status?wiki=w");
  const html = inboxHtml(() => "", Date.now());
  expect(runBtn(html)).toContain(">Run now<");
  expect(html).toContain("9 cards");
  expect(html).not.toContain("data-wi-run-msg");

  globalThis.fetch = (async (url: string) =>
    url.includes("/run") ? { ok: false, status: 409, json: async () => ({ error: "a triage pass is running: try again when it ends" }) } : { ok: true, status: 200, json: async () => statusBody() }) as unknown as typeof fetch;
  click("tri-run", "");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(inboxHtml(() => "", Date.now())).toContain('<div class="wiki-wi-msg warn" role="status" data-wi-run-msg>Couldn’t run the pass: a triage pass is running: try again when it ends.</div>');
});
