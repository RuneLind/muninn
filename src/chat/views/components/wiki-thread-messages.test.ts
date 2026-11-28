import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Window } from "happy-dom";
import { threadKindScript } from "./thread-manager.ts";
import { wikiThreadBarScript } from "./wiki-thread-bar.ts";
import { formatWebHtml } from "../../../web/web-format.ts";
import { EXPLAIN_QUESTION, STORED_EDIT_MARKER } from "../../../wiki/discuss-bounds.ts";
import { EARLIER_EDIT_NOTE } from "../../../dashboard/views/components/wiki-discuss-state.ts";

/**
 * How /chat draws a wiki thread's stored answer (Discuss v2 PR 4, fix round 2).
 * A turn that proposed an edit is stored with `STORED_EDIT_MARKER` in place of
 * its edit block, pointing to the page's Discuss tab. On an open wiki thread
 * that is right (the pane shows the edit card); a closed one has no Apply
 * anywhere, so /chat says what «Earlier discussions» says instead.
 *
 * Harness: the REAL `appendMessage` (with the header and label helpers next to
 * it) lifted out of `views/page.ts`, plus the real `threadKindScript()`, over a
 * happy-dom document of its own (no globals) and the server's own
 * `formatWebHtml`, which the browser bundle shares. Invented threads only.
 */

async function appendBlockSource(): Promise<string> {
  const src = await Bun.file(path.join(import.meta.dir, "..", "page.ts")).text();
  const start = src.indexOf("  function peerLabelForMessage(msg) {");
  const end = src.indexOf("  // Remove all intermediate messages");
  if (start === -1 || end === -1 || end <= start) throw new Error("chat page markers moved — update this extraction");
  return src.slice(start, end);
}

async function harness(threads: Record<string, unknown>[], activeThreadId: string) {
  const win = new Window();
  const document = win.document;
  const chatMessages = document.createElement("div");
  document.body.appendChild(chatMessages);
  const bar = document.createElement("div");
  bar.id = "chatWikiBar";
  document.body.appendChild(bar);
  const body =
    "var document = ctx.document; var chatMessages = ctx.chatMessages; var threads = ctx.threads;" +
    "var formatWebHtml = ctx.formatWebHtml; var activeThreadId = ctx.activeThreadId;" +
    "var selectedBot = 'ivar'; var selectedUsername = 'Kari'; var bots = [];" +
    "var RESEARCH_MARKER = '<!-- research-card -->'; var isResearchThread = false; var devRun = null;" +
    "var pendingHandoffRoles = []; var pendingOrchestrate = false; var awaitingSpecReview = false;" +
    "var specGenerated = false; var specApproved = false; var researchIssueKey = null;" +
    "function sanitizeHtml(h){ return h; } function enhanceCodeTabs(){} function enhanceCodeBlocks(){}" +
    "function augmentIndexLinks(){} function augmentIssueLinks(){} function renderSlackMrkdwn(s){ return s; }" +
    "function avatarColor(){ return '#000'; } function formatTime(){ return ''; }" +
    "function escapeHtml(s){ return String(s); } function escapeAttr(s){ return String(s); }" +
    "function scrollToBottom(){} function attachFeedbackControls(){} function loadToolCallsFromTrace(){}" +
    "function peerDisplayName(n){ return n; }" +
    "var conversations = {}; var activeConvId = null; var navigator = {};" +
    "function authedFetch(){ return Promise.resolve({ ok: false, json: function(){ return Promise.resolve(null); } }); }" +
    "function lookUpLinkedThread(){ return Promise.resolve(); } function selectThread(){} function renderThreadList(){}" +
    threadKindScript() +
    wikiThreadBarScript() +
    (await appendBlockSource()) +
    "return { appendMessage: appendMessage, renderWikiBar: renderWikiBar, applyWikiTurns: applyWikiTurns };";
  const made = new Function("ctx", body)({ document, chatMessages, threads, formatWebHtml, activeThreadId }) as {
    appendMessage: (msg: Record<string, unknown>, convType: string, isLive: boolean) => void;
    renderWikiBar: (threadId: string | null, page: Record<string, unknown> | null, fromRead: boolean) => void;
    applyWikiTurns: (threadId: string, msgs: Record<string, unknown>[]) => void;
  };
  return {
    made,
    chatMessages,
    bar,
    /** A stored assistant row as `GET /chat/conversations/:id/messages` sends it to a web conversation. */
    showStored(threadId: string, content: string): string {
      chatMessages.innerHTML = "";
      made.appendMessage({ id: "m1", sender: "bot", text: formatWebHtml(content), timestamp: 1, threadId }, "web", false);
      return chatMessages.querySelector(".msg-body")?.textContent ?? "";
    },
  };
}

const ANSWER = `The page says six; the timetable says seven.\n\n${STORED_EDIT_MARKER}\n\nRead: notes/harbour.md`;
const closedWiki = { id: "t-closed", name: "wiki: harbour", kind: "wiki", wiki: "harbour", relPath: "notes/harbour.md", closedAt: 5 };
const openWiki = { id: "t-open", name: "wiki: harbour", kind: "wiki", wiki: "harbour", relPath: "notes/harbour.md" };
const chat = { id: "t-chat", name: "main", kind: "chat" };
const NOTE_TEXT = "(This answer proposed an edit; an earlier discussion cannot apply it.)";

describe("/chat on a wiki thread whose turn proposed an edit", () => {
  test("a closed one says the earlier discussion cannot apply it, not to preview and apply it in the Discuss tab", async () => {
    expect(EARLIER_EDIT_NOTE).toContain("earlier discussion cannot apply it");
    const h = await harness([chat, closedWiki], closedWiki.id);
    const text = h.showStored(closedWiki.id, ANSWER);
    expect(text).not.toContain("preview and apply");
    expect(text).toContain(NOTE_TEXT);
    // The rest of the answer stays.
    expect(text).toContain("The page says six; the timetable says seven.");
    expect(text).toContain("Read: notes/harbour.md");
  });

  test("an open one keeps the pointer: the page's Discuss tab has the edit card", async () => {
    const h = await harness([chat, openWiki], openWiki.id);
    const text = h.showStored(openWiki.id, ANSWER);
    expect(text).toContain("(Proposed edit: preview and apply it in the page's Discuss tab.)");
    expect(text).not.toContain("earlier discussion cannot apply");
  });

  test("a chat thread's message is left as it is", async () => {
    const h = await harness([chat, closedWiki], chat.id);
    const text = h.showStored(chat.id, ANSWER);
    expect(text).toContain("(Proposed edit: preview and apply it in the page's Discuss tab.)");
  });
});

const PAGE = { wiki: "harbour", relPath: "notes/harbour.md", traceKey: null, title: "Harbour note" };
const PASSAGE = "The harbour opens at six.";
const explainTurn = { id: "11111111-1111-4111-8111-111111111111", question: EXPLAIN_QUESTION, passage: PASSAGE };
/** The stored text of an Explain turn's user message (threadUserMessage's shape). */
const STORED_EXPLAIN = `> ${PASSAGE}\n\n${EXPLAIN_QUESTION}`;

describe("/chat's page bar, Explain chip and Continue on a wiki thread (Discuss v3 P4)", () => {
  test("an Explain turn's user message is the chip, linking to the page at its card", async () => {
    const h = await harness([chat, openWiki], openWiki.id);
    h.made.renderWikiBar(openWiki.id, PAGE, false);
    h.made.appendMessage({ id: "u1", sender: "user", text: STORED_EXPLAIN, timestamp: 1, threadId: openWiki.id, turn: explainTurn }, "web", false);
    const chip = h.chatMessages.querySelector(".msg-user .chat-explain-chip");
    expect(chip?.textContent).toBe(`\u2728 Explain \u00b7 \u00ab${PASSAGE}\u00bb`);
    expect(chip?.getAttribute("href")).toBe(`/wiki?wiki=harbour&relPath=notes%2Fharbour.md&turn=${explainTurn.id}`);
    // The stored text is not shown beside it.
    expect(h.chatMessages.querySelector(".msg-user .msg-body")?.textContent).not.toContain(EXPLAIN_QUESTION);
  });

  test("the chip comes from the turn's fields, never the stored text: no turn or another question stays plain", async () => {
    const h = await harness([chat, openWiki], openWiki.id);
    h.made.renderWikiBar(openWiki.id, PAGE, false);
    h.made.appendMessage({ id: "u1", sender: "user", text: STORED_EXPLAIN, timestamp: 1, threadId: openWiki.id }, "web", false);
    h.made.appendMessage({ id: "u2", sender: "user", text: "Who owns it?", timestamp: 2, threadId: openWiki.id, turn: { ...explainTurn, id: "t2", question: "Who owns it?" } }, "web", false);
    expect(h.chatMessages.querySelectorAll(".chat-explain-chip").length).toBe(0);
    expect(h.chatMessages.querySelectorAll(".msg-user .msg-body")[0]?.textContent).toBe(STORED_EXPLAIN);
  });

  test("the bar names the page, its wiki and the way back; Start over only on a live thread, the closed one says what starts the next", async () => {
    const h = await harness([chat, openWiki, closedWiki], openWiki.id);
    h.made.renderWikiBar(openWiki.id, PAGE, false);
    expect(h.bar.hidden).toBe(false);
    expect(h.bar.querySelector("[data-wiki-page-title]")?.textContent).toBe("Harbour note");
    expect(h.bar.querySelector(".chat-wiki-name")?.textContent).toBe("harbour");
    expect(h.bar.querySelector("[data-wiki-back]")?.getAttribute("href")).toBe("/wiki?wiki=harbour&relPath=notes%2Fharbour.md");
    expect(h.bar.querySelector("[data-wiki-start-over]")).not.toBeNull();
    expect(h.bar.querySelector("[data-wiki-closed]")).toBeNull();
    h.made.renderWikiBar(closedWiki.id, PAGE, false);
    expect(h.bar.querySelector("[data-wiki-start-over]")).toBeNull();
    expect(h.bar.querySelector("[data-wiki-closed]")?.textContent).toBe("Closed with Start over: the page's next question starts a new discussion.");
    expect(h.bar.querySelector("[data-wiki-back]")).not.toBeNull();
    // A chat thread hides it.
    h.made.renderWikiBar(chat.id, null, false);
    expect(h.bar.hidden).toBe(true);
  });

  test("Continue sits under the last answer, naming the newest turn; a live user bubble the read knows becomes its chip", async () => {
    const h = await harness([chat, openWiki], openWiki.id);
    h.made.renderWikiBar(openWiki.id, PAGE, false);
    h.made.appendMessage({ id: "u1", sender: "user", text: STORED_EXPLAIN, timestamp: 1, threadId: openWiki.id }, "web", true);
    h.made.appendMessage({ id: "b1", sender: "bot", text: "<p>It opens at six.</p>", timestamp: 2, threadId: openWiki.id }, "web", true);
    h.made.applyWikiTurns(openWiki.id, [{ id: "u1", sender: "user", turn: explainTurn, threadId: openWiki.id }, { id: "b1", sender: "bot" }]);
    const cont = h.chatMessages.querySelector(".chat-wiki-continue");
    expect(cont?.previousElementSibling?.classList.contains("msg-bot")).toBe(true);
    expect(cont?.querySelector("[data-chat-continue]")?.textContent).toBe("\u2318 Continue in Claude Code");
    expect(h.chatMessages.querySelector('.msg-user[data-user-message-id="u1"] .chat-explain-chip')).not.toBeNull();
    // Applied again (a later answer): still one control.
    h.made.applyWikiTurns(openWiki.id, [{ id: "u1", sender: "user", turn: explainTurn, threadId: openWiki.id }]);
    expect(h.chatMessages.querySelectorAll(".chat-wiki-continue").length).toBe(1);
  });

  test("no turn in the read: no Continue", async () => {
    const h = await harness([chat, openWiki], openWiki.id);
    h.made.renderWikiBar(openWiki.id, PAGE, false);
    h.made.appendMessage({ id: "b1", sender: "bot", text: "<p>x</p>", timestamp: 2, threadId: openWiki.id }, "web", false);
    h.made.applyWikiTurns(openWiki.id, [{ id: "b1", sender: "bot" }]);
    expect(h.chatMessages.querySelector(".chat-wiki-continue")).toBeNull();
  });
});
