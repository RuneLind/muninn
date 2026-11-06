import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DecisionInboxBody, InboxCard } from "../../routes/wiki-decision-inbox.ts";
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
  relPath: "plans/a.mdx", id: "O1", title: "A", body: "Which?", choices: [], recommendation: null, targets: [], added: null, laneSince: null, answers: [], hint: null, ownerAnswered: false, lane: "ask", ...over,
});

async function load(body: DecisionInboxBody | null, status = 200): Promise<void> {
  globalThis.fetch = (async () => ({ ok: status === 200, status, json: async () => body })) as unknown as typeof fetch;
  loadInbox(`/api/wiki/decision-inbox?wiki=w${Math.random()}`);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("four lanes, «close?» and «ask you» open, the other two folded, with their counts", async () => {
  await load({ wiki: "w", cards: [card({ id: "O1", lane: "close", answers: [{ author: "R", choice: "A", body: "", at: "2026-11-01T10:00:00Z", questionChanged: false }] }), card({ id: "O2" }), card({ id: "O3", lane: "default" }), card({ id: "O4", lane: "default" })] });
  const html = inboxHtml((rel) => `/wiki?relPath=${rel}`, Date.now());
  const lane = (l: string) => new RegExp(`<details class="wiki-wi-lane" data-wi-lane="${l}"( open)?>.*?wiki-wm-count">(\\d+)<`).exec(html)!;
  expect([lane("close")[1], lane("close")[2]]).toEqual([" open", "1"]);
  expect([lane("ask")[1], lane("ask")[2]]).toEqual([" open", "1"]);
  expect([lane("pass")[1], lane("pass")[2]]).toEqual([undefined, "0"]);
  expect([lane("default")[1], lane("default")[2]]).toEqual([undefined, "2"]);
  expect(html).toContain("Decisions · 4 open");
});

test("every page string is escaped", async () => {
  await load({ wiki: "w", cards: [card({ id: XSS, title: XSS, body: XSS, lane: "pass", targets: [XSS] })] });
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
  await load({ wiki: "w", cards: [card({ id: "O4", lane: "ask", choices: ["A", "B"], ownerAnswered: true, answers: [{ author: "R", choice: "not-sure", body: "", at: "2026-11-01T10:00:00Z", questionChanged: false }] })] });
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
