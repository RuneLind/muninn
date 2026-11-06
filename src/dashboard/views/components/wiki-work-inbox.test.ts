import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DecisionInboxBody, InboxCard } from "../../routes/wiki-decision-inbox.ts";
import { inboxHtml, initInbox, loadInbox } from "./wiki-work-inbox.ts";

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
  relPath: "plans/a.mdx", id: "O1", title: "A", body: "Which?", choices: [], recommendation: null, targets: [], added: null, laneSince: null, answers: [], hint: null, lane: "ask", ...over,
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
