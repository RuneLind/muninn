/**
 * «🧾 Lag Jira-sak» — the DOM half, injected as a JS string INSIDE the
 * CHAT_SCRIPT IIFE (so it can read `selectedBot` / `chatMessages` and be read by
 * `attachFeedbackControls`). Every decision worth a test lives next door in
 * `jira-entry-pure.ts`, which the page bundles onto `globalThis` — the
 * `inspector-panel.ts` split, so there is no hand-ported copy of the logic here.
 *
 * The shape of the feature: a Jira task is DISCUSSED in the melosys thread first
 * (the conversation retrieves, argues, corrects), and the draft is a TURN in that
 * same thread — `POST /api/jira/draft/from-thread`, fire-and-forget, exactly like
 * `/draft/start`. **The draft never leaves the conversation:** the turn appears in
 * the chat like any other, and its FINALIZED text (fence stripped, `[n]` repaired,
 * `## Referanser` appended) arrives as a card under the reply — `jira-card.ts`.
 * There is no tab to open and no second page to hand the reader to; `/jira` stays
 * reachable by URL as the archive.
 *
 * Three rules are load-bearing:
 *
 *   · **`content-type: application/json` is mandatory** — the route 415s anything
 *     else, deliberately: it WRITES into a conversation, carries no CORS headers,
 *     and `text/plain` is a CORS *simple* request that would have landed two
 *     messages in someone's chat cross-origin.
 *   · **the thread id is stamped on the button at render time**, not read from
 *     the page's live `activeThreadId` at click time — the control belongs to the
 *     message it was rendered under.
 *   · **a second open while a POST is in flight RE-FOCUSES the panel** instead of
 *     rebuilding it. A rebuild resets \`sending\`, and the in-flight 200 then
 *     closed the panel the reader had just opened.
 *
 * And one rule about the response: **a started draft's id is never dropped.** The
 * POST is fire-and-forget, so by the time it answers the turn is running — a row
 * exists and the thread's single-flight slot is held — and the next attempt 409s
 * about work never shown if the id is lost. It goes straight to `seedJiraCard`,
 * which starts the card's poller on it; the card layer's own listing would find
 * it on the next `response_meta` anyway, but that is minutes later.
 */

import {
  JE_BTN_ATTR,
  JE_CANCEL_ID,
  JE_DEPTH_ID,
  JE_EXTRA_ID,
  JE_MSG_ID,
  JE_PANEL_ID,
  JE_SUBMIT_ID,
  JE_TEMPLATE_ID,
  JE_THREAD_ATTR,
} from "./jira-entry-pure.ts";

export function jiraEntryScript(): string {
  return `
  // ── «Lag Jira-sak» (from-thread draft entry) ─────────────────────────────
  // The composer's bot, from GET /chat/bots. Null until that lands and on any
  // install where JIRA_BOT names no discovered bot — in both cases the control
  // simply never renders, which is the correct answer: the route 503s.
  var jiraBotName = null;
  var jiraEntryState = null;      // the OPEN panel's state, or null
  var jiraEntryThreadId = null;   // the thread that panel drafts from
  // The feedback row the OPEN panel's control was clicked in. Captured at open
  // time and again as a LOCAL at submit time, so the response has somewhere to
  // put a started draft's link even after the panel is torn down.
  var jiraEntryRow = null;
  var jiraEntryTemplates = null;  // cached across opens — the list is per-bot
  var jiraEntryTemplatesErr = null;
  var jiraEntryWired = false;

  // Append the control to a finalized bot message's feedback row. Called from
  // attachFeedbackControls, so it covers BOTH paths that produce one: replayed
  // web history and the live turn (which only learns its message id at
  // response_meta time).
  function appendJiraEntryControl(wrap) {
    if (!wrap) return;
    if (!jiraEntryVisible({ selectedBot: selectedBot, jiraBot: jiraBotName, threadId: activeThreadId })) return;
    wrap.insertAdjacentHTML('beforeend', jiraEntryButtonHtml(activeThreadId));
    // The feedback row is hover-revealed (opacity 0 at rest) — right for a 👍/👎,
    // wrong for an action the reader has to FIND. The class un-hides the row for
    // exactly the messages that carry this button. Set here rather than with a
    // \`:has()\` rule so the reveal does not depend on selector support.
    wrap.classList.add('has-jira');
  }

  function closeJiraEntry() {
    var panel = document.getElementById('${JE_PANEL_ID}');
    if (panel) panel.remove();
    jiraEntryState = null;
    jiraEntryThreadId = null;
    jiraEntryRow = null;
  }

  // Repaint the panel in place. The extra field is the only control that can
  // hold a caret, so it is captured and restored — the same discipline the
  // composer's setHtml uses, for the same reason (a repaint mid-word).
  function renderJiraEntryPanel() {
    var panel = document.getElementById('${JE_PANEL_ID}');
    if (!panel || !jiraEntryState) return;
    var active = document.activeElement;
    var focusedId = active && panel.contains(active) && active.id ? active.id : '';
    var selStart = focusedId && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    panel.outerHTML = jiraEntryPanelHtml(jiraEntryState);
    if (!focusedId) return;
    var restored = document.getElementById(focusedId);
    if (!restored) return;
    restored.focus({ preventScroll: true });
    if (selStart !== null && typeof restored.setSelectionRange === 'function') {
      try { restored.setSelectionRange(selStart, selStart); } catch (e) { /* no selection API */ }
    }
  }

  // The template list. **Only SUCCESS is cached.** The list is a function of the
  // resolved bot, which cannot change without a reload — but a FAILURE is a
  // function of the server's state at one instant, and caching it latched the
  // picker dead for the life of the page: a 503 from a restarting muninn, or one
  // dropped fetch, and «Lag Jira-sak» never worked again in that tab. A retry
  // costs one round-trip on the reader's own next click.
  async function loadJiraEntryTemplates() {
    if (jiraEntryTemplates) { jiraEntryTemplatesErr = null; return; }
    jiraEntryTemplatesErr = null;
    try {
      var res = await fetch('/api/jira/templates');
      var body = await res.json();
      if (!res.ok) {
        jiraEntryTemplatesErr = (body && body.error) || ('Kunne ikke hente maler (HTTP ' + res.status + ').');
      } else {
        jiraEntryTemplates = Array.isArray(body.templates) ? body.templates : [];
      }
    } catch (err) {
      jiraEntryTemplatesErr = 'Kunne ikke hente maler: ' + (err && err.message ? err.message : String(err));
    }
  }

  function openJiraEntry(btn) {
    var threadId = btn.getAttribute('${JE_THREAD_ATTR}') || '';
    if (!threadId) return;
    var msg = btn.closest('.msg');
    if (!msg) return;
    // A POST is already on the wire for THIS thread: the panel standing there is
    // the one that will receive its answer, so it is RE-FOCUSED, never rebuilt.
    // Rebuilding reset \`sending\` (bringing Avbryt and Lag utkast back to life on
    // a turn that is already running) and, worse, the in-flight 200 then matched
    // \`jiraEntryThreadId === threadId\` and CLOSED the panel the reader had just
    // opened. No state is touched here — a second open is not a second attempt.
    if (jiraEntryState && jiraEntryState.sending && jiraEntryThreadId === threadId) {
      var open = document.getElementById('${JE_PANEL_ID}');
      if (open && typeof open.scrollIntoView === 'function') open.scrollIntoView({ block: 'nearest' });
      return;
    }
    closeJiraEntry();
    jiraEntryThreadId = threadId;
    // The control's own container. \`.msg\` is the fallback for a control rendered
    // outside a feedback row; either is a node that outlives the panel.
    jiraEntryRow = btn.closest('.msg-feedback') || msg;
    jiraEntryState = initialJiraEntryState();
    msg.insertAdjacentHTML('beforeend', jiraEntryPanelHtml(jiraEntryState));
    scrollToBottom();
    loadJiraEntryTemplates().then(function() {
      if (!jiraEntryState || jiraEntryThreadId !== threadId) return;
      jiraEntryState.loading = false;
      jiraEntryState.templates = jiraEntryTemplates || [];
      jiraEntryState.templatesError = jiraEntryTemplatesErr || undefined;
      if (!jiraEntryState.template && jiraEntryState.templates[0]) {
        jiraEntryState.template = jiraEntryState.templates[0].id;
      }
      renderJiraEntryPanel();
    });
  }

  async function submitJiraEntry() {
    if (!jiraEntryState || !jiraEntryThreadId) return;
    if (!jiraEntryCanSubmit(jiraEntryState)) return;
    var threadId = jiraEntryThreadId;
    // Captured NOW, as a local: \`closeJiraEntry\` clears the shared one, and this
    // is the container the «skrives i samtalen …» note goes into once the panel
    // is closed — including when a thread switch closed it first.
    var row = jiraEntryRow;
    jiraEntryState.sending = true;
    jiraEntryState.message = undefined;
    jiraEntryState.messageTone = undefined;
    renderJiraEntryPanel();

    var status = 0;
    var body = null;
    try {
      var res = await fetch('/api/jira/draft/from-thread', {
        method: 'POST',
        // NOT optional: the route 415s anything else. See the module header.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(jiraEntryDraftBody({
          threadId: threadId,
          template: jiraEntryState.template,
          depth: jiraEntryState.depth,
          extra: jiraEntryState.extra,
        })),
      });
      status = res.status;
      try { body = await res.json(); } catch (e) { body = null; }
    } catch (err) {
      status = 0;
    }

    var outcome = jiraEntryOutcome(status, body);

    // **ONE success branch.** The three the tab-and-fallback design needed
    // (navigate the pre-opened tab / render a link in the panel / render one in
    // the row) collapse to this: hand the id to the card poller, close the picker,
    // and leave a note where the reader clicked until the card lands. The panel
    // may already be gone — a thread switch wipes the message list; Avbryt cannot,
    // it is disabled while sending — and none of that matters here, because the
    // draft's destination is the conversation, not this panel.
    if (outcome.ok) {
      seedJiraCard(outcome.draftId);
      if (jiraEntryState && jiraEntryThreadId === threadId) closeJiraEntry();
      // The note goes in the feedback row the control was clicked in, which
      // \`has-jira\` already un-hides. \`attachJiraCard\` removes it by draft id when
      // the card lands — under a DIFFERENT bubble (the new turn's), which is why
      // the note is keyed rather than "the one next to me".
      if (row) row.insertAdjacentHTML('beforeend', jiraEntryDraftingHtml(outcome.draftId));
      return;
    }

    // A refusal needs somewhere to render and nothing survives it — there is no
    // draft to point at. If the panel is gone (or has been re-opened on another
    // message) it is dropped silently.
    if (!(jiraEntryState && jiraEntryThreadId === threadId)) return;
    jiraEntryState.sending = false;
    jiraEntryState.message = outcome.message;
    jiraEntryState.messageTone = 'err';
    renderJiraEntryPanel();
  }

  function wireJiraEntry() {
    if (jiraEntryWired) return;
    jiraEntryWired = true;

    document.addEventListener('click', function(ev) {
      var target = ev.target;
      if (!target || !target.closest) return;
      // An ATTRIBUTE selector: one control is rendered per finalized bot message,
      // so there are N of them in a replayed thread and an id would name only one.
      var open = target.closest('[${JE_BTN_ATTR}]');
      if (open) { ev.preventDefault(); openJiraEntry(open); return; }
      if (target.closest('#${JE_CANCEL_ID}')) {
        ev.preventDefault();
        // Dead while a POST is on the wire — there is nothing to cancel, and
        // closing the panel only threw away the draft id the response carries.
        // The button renders \`disabled\`; this is the belt to that suspenders.
        if (jiraEntryState && jiraEntryState.sending) return;
        closeJiraEntry();
        return;
      }
      if (target.closest('#${JE_SUBMIT_ID}')) {
        ev.preventDefault();
        // Nothing is pre-opened any more: the draft lands in this conversation,
        // so there is no tab whose synchronous creation Safari could block.
        submitJiraEntry();
      }
    });

    document.addEventListener('change', function(ev) {
      var target = ev.target;
      if (!target || !jiraEntryState) return;
      if (target.id === '${JE_TEMPLATE_ID}') { jiraEntryState.template = target.value; renderJiraEntryPanel(); return; }
      if (target.id === '${JE_DEPTH_ID}') { jiraEntryState.depth = target.value; }
    });

    // Typing does NOT re-render — the reader is inside the very node that would
    // be replaced. Only the submit button's derived disabled state is patched.
    document.addEventListener('input', function(ev) {
      var target = ev.target;
      if (!target || !jiraEntryState || target.id !== '${JE_EXTRA_ID}') return;
      jiraEntryState.extra = target.value;
      var btn = document.getElementById('${JE_SUBMIT_ID}');
      if (btn) btn.disabled = !jiraEntryCanSubmit(jiraEntryState);
      var msgWrap = document.getElementById('${JE_MSG_ID}');
      var line = msgWrap ? msgWrap.querySelector('.je-msg-err') : null;
      // Typing is the start of the next attempt, so a standing refusal is
      // cleared — it described the previous one.
      if (line) { jiraEntryState.message = undefined; jiraEntryState.messageTone = undefined; line.hidden = true; }
    });
  }

  wireJiraEntry();
`;
}
