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
 * `/draft/start`. This surface therefore starts the turn and hands the reader to
 * `/jira?draft=<id>`, which polls the row and is where the draft is finished. The
 * turn itself appears in the chat like any other, so nothing here renders it.
 *
 * Three rules are load-bearing:
 *
 *   · **`content-type: application/json` is mandatory** — the route 415s anything
 *     else, deliberately: it WRITES into a conversation, carries no CORS headers,
 *     and `text/plain` is a CORS *simple* request that would have landed two
 *     messages in someone's chat cross-origin.
 *   · **the new tab is opened SYNCHRONOUSLY in the click**, before any await.
 *     Safari blocks a `window.open` issued after one unconditionally; the
 *     wiki-chat-options precedent. A blocked popup renders an honest link rather
 *     than claiming a tab was opened.
 *   · **the thread id is stamped on the button at render time**, not read from
 *     the page's live `activeThreadId` at click time — the control belongs to the
 *     message it was rendered under.
 */

import {
  JE_BTN_ID,
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

  // The template list. Fetched once per page and reused: it is a function of the
  // resolved bot, which cannot change without a reload. A failed fetch is
  // remembered too — retrying it on every open would spend a round-trip per
  // click on an install where the route 503s.
  async function loadJiraEntryTemplates() {
    if (jiraEntryTemplates || jiraEntryTemplatesErr) return;
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
    closeJiraEntry();
    jiraEntryThreadId = threadId;
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

  // \`tab\` is the window opened SYNCHRONOUSLY by the click handler — see the
  // module header. It is closed on every failure path, so a refusal never leaves
  // a blank tab behind.
  async function submitJiraEntry(tab) {
    if (!jiraEntryState || !jiraEntryThreadId) { if (tab) tab.close(); return; }
    if (!jiraEntryCanSubmit(jiraEntryState)) { if (tab) tab.close(); return; }
    var threadId = jiraEntryThreadId;
    jiraEntryState.sending = true;
    jiraEntryState.message = undefined;
    jiraEntryState.messageTone = undefined;
    jiraEntryState.draftUrl = undefined;
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

    // The panel may have been closed (or re-opened on another message) while the
    // POST was in flight; the turn still ran, so a blocked-tab link would be the
    // only way back — but there is nothing left to render it into.
    if (!jiraEntryState || jiraEntryThreadId !== threadId) { if (tab) tab.close(); return; }

    var outcome = jiraEntryOutcome(status, body);
    jiraEntryState.sending = false;
    if (outcome.ok) {
      if (tab && !tab.closed) {
        tab.location.href = outcome.url;
        closeJiraEntry();
        return;
      }
      jiraEntryState.draftUrl = outcome.url;
      jiraEntryState.message = JE_POPUP_BLOCKED_MESSAGE;
      jiraEntryState.messageTone = 'ok';
      renderJiraEntryPanel();
      return;
    }
    if (tab) tab.close();
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
      var open = target.closest('#${JE_BTN_ID}');
      if (open) { ev.preventDefault(); openJiraEntry(open); return; }
      if (target.closest('#${JE_CANCEL_ID}')) { ev.preventDefault(); closeJiraEntry(); return; }
      if (target.closest('#${JE_SUBMIT_ID}')) {
        ev.preventDefault();
        // Opened here, before any await — Safari blocks a post-await open
        // unconditionally. A refusal closes it again.
        var tab = null;
        try { tab = window.open('', '_blank'); } catch (e) { tab = null; }
        submitJiraEntry(tab);
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
