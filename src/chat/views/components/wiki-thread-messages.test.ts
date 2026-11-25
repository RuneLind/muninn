import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Window } from "happy-dom";
import { threadKindScript } from "./thread-manager.ts";
import { formatWebHtml } from "../../../web/web-format.ts";
import { STORED_EDIT_MARKER } from "../../../wiki/discuss-bounds.ts";
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
    threadKindScript() +
    (await appendBlockSource()) +
    "return { appendMessage: appendMessage };";
  const made = new Function("ctx", body)({ document, chatMessages, threads, formatWebHtml, activeThreadId }) as {
    appendMessage: (msg: Record<string, unknown>, convType: string, isLive: boolean) => void;
  };
  return {
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
