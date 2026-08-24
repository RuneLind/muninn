/**
 * The Jira draft card — the DOM half, injected as a JS string INSIDE the
 * CHAT_SCRIPT IIFE (so it can read `activeThreadId` / `selectedBot` /
 * `chatMessages` and be called from `showResponseMeta`). Every decision worth a
 * test lives next door in `jira-card-pure.ts`, which the page bundles onto
 * `globalThis` — the `jira-entry.ts` split, so there is no hand-ported copy here.
 *
 * **The binding is one poller keyed on the DRAFT, never on "this tab clicked".**
 * A from-thread turn runs 60–600 s and broadcasts to every open tab, so a reload,
 * a second tab and a switch-away-and-back are all ordinary. Remembering a click
 * serves none of them. Instead, on thread load, on thread switch and on every
 * `response_meta` for the active thread, the client asks
 * `GET /api/jira/drafts?thread=<id>` for every draft on the thread and adopts
 * what it finds.
 *
 * Three rules underneath that, each of which cost a defect on the way here:
 *
 *   · **every listed row is READ ONCE on adopt.** The listing carries the binding
 *     and nothing else; the markdown, the verdicts, the flags and `savedAt` are
 *     on the view. Gating the read on in-flight-ness left a FINISHED draft with
 *     nothing to render after a reload — the row was `ready`, so nothing fetched
 *     it. Only the POLL LOOP is gated (`jiraCardShouldPoll`).
 *   · **`attachJiraCard` is its own idempotent function**, not a branch inside
 *     `attachFeedbackControls`: that one early-returns the moment a feedback row
 *     exists, and a card arrives minutes after the row does.
 *   · **the bubble is resolved by `data-message-id`**, stamped by
 *     `attachFeedbackControls` — the only messageId → DOM lookup in the page.
 *
 * The clicking tab additionally SEEDS the loop with the id its 200 returned:
 * `from-thread` answers `{draftId, status:"generating"}` before the turn starts,
 * and the assistant message id does not exist until `response_meta` much later.
 *
 * A thread switch tears every timer down — no interval outlives its thread.
 */

import {
  JCARD_ATTR,
  JCARD_COPIED_MESSAGE,
  JCARD_COPY_ATTR,
  JCARD_COPY_FAILED_MESSAGE,
  JCARD_NOTICE_ID,
  JCARD_SAVE_ATTR,
} from "./jira-card-pure.ts";
import { JE_DRAFTING_ATTR } from "./jira-entry-pure.ts";
import { JIRA_POLL_INTERVAL_MS, JIRA_POLL_MAX_MS } from "../../../jira/wire.ts";

export function jiraCardScript(): string {
  return `
  // ── The Jira draft card ──────────────────────────────────────────────────
  // Per-draft record: { view, timer, pollStartedAt, gaveUp, reading, sig,
  //                     message, messageTone, orphan }
  var jiraCards = {};
  // The thread every record above belongs to. Every async continuation compares
  // against it before touching the DOM: a listing or a draft read that lands
  // after a thread switch describes a conversation the reader is no longer in.
  var jiraCardThread = null;
  // The thread whose listing is on the wire, or null. A THREAD rather than a
  // boolean: a plain flag was cleared only in the listing's own \`finally\`, so a
  // switch mid-flight left it standing and every refresh for the NEW thread —
  // its load, its switches, its every response_meta — returned early. The cards
  // of the conversation the reader had just opened never appeared.
  var jiraCardListing = null;
  var jiraCardWired = false;

  // Tear everything down. Called from loadThreadMessages beside closeJiraEntry
  // and from clearChat (a bot or user switch replaces the message list too):
  // every card node is going away and every timer would be polling for a thread
  // nobody is reading.
  function resetJiraCards() {
    for (var id in jiraCards) {
      if (jiraCards[id] && jiraCards[id].timer) clearTimeout(jiraCards[id].timer);
    }
    jiraCards = {};
    jiraCardThread = null;
    // A listing still on the wire describes the thread being left; it already
    // checks \`jiraCardThread\` before touching anything, so dropping the claim
    // here only means the next thread is free to ask immediately.
    jiraCardListing = null;
    var notice = document.getElementById('${JCARD_NOTICE_ID}');
    if (notice) notice.remove();
  }

  // Can a draft even exist on this thread? Exactly the condition under which the
  // 🧾 control renders — the from-thread route 400s any other bot's thread — so
  // reusing the predicate keeps one answer rather than two that can disagree.
  function jiraCardsPossible() {
    return jiraEntryVisible({ selectedBot: selectedBot, jiraBot: jiraBotName, threadId: activeThreadId });
  }

  // The listing. Fired on thread load, on thread switch and on every
  // response_meta for the active thread.
  async function refreshJiraCards() {
    if (!jiraCardsPossible()) return;
    var threadId = activeThreadId;
    // One listing per THREAD is enough; the next event re-asks. A listing for a
    // DIFFERENT thread must go through — see the declaration.
    if (jiraCardListing === threadId) return;
    if (jiraCardThread !== threadId) { resetJiraCards(); jiraCardThread = threadId; }
    jiraCardListing = threadId;
    try {
      var res = await fetch('/api/jira/drafts?thread=' + encodeURIComponent(threadId));
      if (!res.ok) return;
      var body = await res.json();
      if (jiraCardThread !== threadId || activeThreadId !== threadId) return;
      var rows = Array.isArray(body && body.drafts) ? body.drafts : [];
      for (var i = 0; i < rows.length; i++) adoptJiraCardRow(rows[i], threadId);
      renderJiraCardNotice();
    } catch (err) {
      // A dropped listing is not worth a message: the next response_meta or the
      // next thread load asks again, and nothing here is the reader's action.
    } finally {
      // Only if this listing is still the claimed one: a switch mid-flight
      // handed the claim to the new thread, whose own listing owns it now.
      if (jiraCardListing === threadId) jiraCardListing = null;
    }
  }

  // Adopt ONE listed row. Idempotent: a settled row already rendered at the same
  // status is left alone, and a row that was \`generating\` is re-read so the card
  // updates in place when it lands.
  function adoptJiraCardRow(row, threadId) {
    if (!row || !row.draftId) return;
    var rec = jiraCards[row.draftId];
    // Is the listing describing exactly the row we already hold? The STATUS is
    // not the whole binding: \`message_id\` is stamped after the turn, so a row
    // can be listed \`generating\` with no bubble and then \`ready\` with one, and a
    // status-only test strands the card. The id is compared as well as the
    // status — cheap, and it also holds if a row's message ever moves under us.
    var settled = rec && rec.view && rec.view.status === row.status
      && (rec.view.messageId || null) === (row.messageId || null) && !jiraCardShouldPoll(row);
    // Skip only a row that is settled AND already on screen. Keying the skip on
    // the STATUS alone stranded the ordinary case: a draft can go \`ready\` while
    // its bubble is still arriving over the WebSocket, so the first render found
    // no host and marked it an orphan — and every later listing then agreed with
    // itself that there was nothing to do.
    if (settled && rec.attached) return;
    // Settled, read, and waiting for a bubble that is outside the replayed
    // window (or still arriving). The listing is telling us what we already
    // hold, so the READ buys nothing — but a re-render does, because the bubble
    // may have landed since. This is the hot path: every response_meta re-asks.
    // Both orphan kinds: \`unmapped\` is a terminal failed row, which the listing
    // would otherwise re-read on every response_meta for the life of the tab.
    if (settled && !rec.attached) { renderJiraCardRecord(row.draftId); return; }
    if (!rec) {
      rec = jiraCards[row.draftId] = { pollStartedAt: Date.now() };
    }
    // **The read is NOT gated on in-flight-ness** — see the module header. The
    // listing has no content; this is where the card's content comes from.
    readJiraCardDraft(row.draftId, threadId);
  }

  // The clicking tab's own seed. \`from-thread\` returns before the turn starts, so
  // this is the earliest the id exists anywhere in the browser — and the listing
  // would find it on the next response_meta anyway, minutes later.
  //
  // \`threadId\` is the thread the 🧾 click was SUBMITTED from, handed over by
  // \`submitJiraEntry\`, never the page's live \`activeThreadId\`: the POST answers
  // while the reader may have moved on, and seeding off the live value then reset
  // the records of whatever conversation they had switched to.
  function seedJiraCard(draftId, threadId) {
    if (!draftId || !threadId) return;
    if (activeThreadId !== threadId) return;
    if (jiraCardThread !== threadId) { resetJiraCards(); jiraCardThread = threadId; }
    if (!jiraCards[draftId]) jiraCards[draftId] = { pollStartedAt: Date.now() };
    readJiraCardDraft(draftId, threadId);
  }

  async function readJiraCardDraft(draftId, threadId) {
    var rec = jiraCards[draftId];
    if (!rec || rec.reading) return;
    rec.reading = true;
    try {
      var res = await fetch('/api/jira/draft/' + encodeURIComponent(draftId));
      if (jiraCardThread !== threadId || activeThreadId !== threadId) return;
      if (!res.ok) {
        // A 404 is TERMINAL — the row is gone, and nothing will bring it back.
        if (res.status === 404) {
          stopJiraCardPoll(draftId);
          delete jiraCards[draftId];
          removeJiraDraftingNote(draftId); // the note must not outlive the row
          renderJiraCardNotice();
          return;
        }
        // Anything else is the server blinking, not an answer about the draft:
        // treated exactly like a transport throw, so the loop stays alive to the
        // cap and the give-up line eventually renders. Stopping here was silent
        // — the card said «Skriver utkastet …» for the life of the page.
        scheduleJiraCardPoll(draftId, threadId);
        return;
      }
      var view = await res.json();
      if (jiraCardThread !== threadId || activeThreadId !== threadId) return;
      rec = jiraCards[draftId];
      if (!rec) return;
      rec.view = view;
      renderJiraCardRecord(draftId);
      // The notice is refreshed HERE, not only at the end of the listing pass:
      // the reads are fire-and-forget, so the listing's own call runs before any
      // of them have decided whether their draft has a bubble, and an orphan
      // would have stayed invisible until the NEXT listing.
      renderJiraCardNotice();
      scheduleJiraCardPoll(draftId, threadId);
    } catch (err) {
      // Transport failure: keep the loop alive — the server is the thing that
      // just blinked, and the draft is still being written on the other side.
      scheduleJiraCardPoll(draftId, threadId);
    } finally {
      if (jiraCards[draftId]) jiraCards[draftId].reading = false;
    }
  }

  function scheduleJiraCardPoll(draftId, threadId) {
    var rec = jiraCards[draftId];
    if (!rec) return;
    var row = { status: rec.view ? rec.view.status : 'generating', messageId: rec.view ? rec.view.messageId : null };
    if (!jiraCardShouldPoll(row)) { stopJiraCardPoll(draftId); return; }
    if (jiraCardPollExpired(rec.pollStartedAt, Date.now(), ${JIRA_POLL_MAX_MS})) {
      // Give up and SAY so, in the card if there is one and in the thread-level
      // notice if there is not. Polling a dead row forever tells the reader
      // nothing; the archive still holds whatever landed.
      rec.gaveUp = true;
      stopJiraCardPoll(draftId);
      renderJiraCardRecord(draftId);
      renderJiraCardNotice();
      return;
    }
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(function() {
      if (jiraCardThread !== threadId || activeThreadId !== threadId) return;
      readJiraCardDraft(draftId, threadId);
    }, ${JIRA_POLL_INTERVAL_MS});
  }

  function stopJiraCardPoll(draftId) {
    var rec = jiraCards[draftId];
    if (!rec) return;
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
  }

  // The markdown → HTML pass. The SAME pair the chat uses for every bot bubble
  // and the composer uses for its preview, so the card cannot drift from
  // muninn's own renderer. \`sanitizeHtml\`'s second argument is not optional: the
  // one-argument form selects the TELEGRAM tag list, which silently replaces
  // every heading, list and table with its own text.
  function jiraCardBodyHtml(view) {
    if (!view || !view.markdown) return '';
    return sanitizeHtml(formatWebHtml(view.markdown), true);
  }

  /**
   * Attach (or update) the card for one draft under the bubble it came from.
   *
   * Its own function, deliberately, and NOT a branch inside
   * attachFeedbackControls: that one early-returns as soon as a feedback row
   * exists, and the card arrives long after the row does.
   *
   * Idempotent — a card already standing for this draftId is REPLACED in place
   * rather than appended beside itself, which is what makes the
   * generating → ready transition a redraw instead of two cards.
   */
  function attachJiraCard(messageId, draftId, view) {
    if (!messageId || !draftId || !view) return false;
    var host = chatMessages.querySelector('.msg-bot[data-message-id="' + cssAttrValue(messageId) + '"]');
    if (!host) return false;
    var rec = jiraCards[draftId] || {};
    var html = jiraCardHtml(view, {
      bodyHtml: jiraCardBodyHtml(view),
      message: rec.message,
      messageTone: rec.messageTone,
      gaveUp: rec.gaveUp,
    });
    var existing = host.querySelector('[${JCARD_ATTR}="' + cssAttrValue(draftId) + '"]');
    // A card for this draft standing under ANOTHER bubble. Defensive now that a
    // re-run mints its own row (this draft's \`message_id\` is stamped once and
    // never moves), but the cost is one query and the failure it prevents is two
    // cards for one draft, the older holding the older text. Scoped to the
    // document rather than the host, because a stray is by definition not in it.
    var strays = document.querySelectorAll('[${JCARD_ATTR}="' + cssAttrValue(draftId) + '"]');
    for (var i = 0; i < strays.length; i++) {
      if (host.contains && host.contains(strays[i])) continue;
      strays[i].remove();
    }
    if (existing) existing.outerHTML = html;
    else host.insertAdjacentHTML('beforeend', html);
    removeJiraDraftingNote(draftId);
    return true;
  }

  // The «Utkastet skrives i samtalen …» placeholder the 🧾 click left in ITS
  // feedback row — a DIFFERENT bubble from the card's, which is why it is keyed
  // on the draft id rather than removed relative to the card. It is cleared both
  // when the card lands and when nothing can ever land (see
  // renderJiraCardRecord): the note claims a draft is being written, and left
  // standing on a dead one it says so for the life of the page.
  function removeJiraDraftingNote(draftId) {
    var note = document.querySelector('[${JE_DRAFTING_ATTR}="' + cssAttrValue(draftId) + '"]');
    if (note) note.remove();
  }

  // Render one record wherever it belongs: under its bubble, or — when there is
  // no bubble to hang it under — as a row in the thread-level notice.
  function renderJiraCardRecord(draftId) {
    var rec = jiraCards[draftId];
    if (!rec || !rec.view) return;
    // A redraw is not free: it replaces the node, throwing away a standing
    // «Markdown kopiert.» and any focus inside the card. So nothing is rewritten
    // unless something a reader can SEE has changed — and a poll tick on an
    // unchanged row changes nothing.
    var sig = jiraCardSignature(rec.view, rec.gaveUp) + '|' + (rec.message || '');
    if (rec.attached && rec.sig === sig) return;
    var attached = rec.view.messageId ? attachJiraCard(rec.view.messageId, draftId, rec.view) : false;
    if (attached) {
      rec.sig = sig;
      rec.attached = true;
      rec.orphan = null;
      return;
    }
    rec.attached = false;
    // No bubble. A row with no message at all is only reportable once nothing
    // more is coming — while the turn is still running the stamp is simply not
    // there yet, and announcing it would flash a notice on every ordinary draft.
    rec.orphan = !rec.view.messageId
      ? (rec.view.status === 'failed' || rec.gaveUp ? 'unmapped' : null)
      : 'offscreen';
    // Nothing will replace the «skrives i samtalen …» note here: the run failed,
    // the poller gave up, or the bubble is unreachable. Clear it rather than
    // leave it claiming the draft is still being written — the thread-level
    // notice this record now feeds carries the archive link instead.
    if (rec.orphan || rec.view.status === 'failed' || rec.gaveUp) removeJiraDraftingNote(draftId);
  }

  function renderJiraCardNotice() {
    var orphans = [];
    for (var id in jiraCards) {
      var rec = jiraCards[id];
      if (rec && rec.orphan) orphans.push({ draftId: id, reason: rec.orphan });
    }
    var existing = document.getElementById('${JCARD_NOTICE_ID}');
    if (orphans.length === 0) { if (existing) existing.remove(); return; }
    var html = jiraCardNoticeHtml(orphans);
    if (existing) existing.outerHTML = html;
    else chatMessages.insertAdjacentHTML('beforeend', html);
  }

  // A transient line under the card's buttons — «Markdown kopiert.», a refused
  // save. It goes through the record so a poll tick that redraws the card does
  // not silently swallow it.
  function setJiraCardMessage(draftId, message, tone) {
    var rec = jiraCards[draftId];
    if (!rec) return;
    rec.message = message;
    rec.messageTone = tone;
    renderJiraCardRecord(draftId);
  }

  async function copyJiraCard(draftId) {
    var rec = jiraCards[draftId];
    if (!rec || !rec.view || !rec.view.markdown) return;
    try {
      // The RAW markdown, byte for byte — that is what the Jira editor converts
      // on paste, and the rendered body is muninn's renderer, not Jira's.
      await navigator.clipboard.writeText(rec.view.markdown);
      setJiraCardMessage(draftId, ${JSON.stringify(JCARD_COPIED_MESSAGE)}, 'ok');
    } catch (err) {
      setJiraCardMessage(draftId, ${JSON.stringify(JCARD_COPY_FAILED_MESSAGE)}, 'err');
    }
  }

  async function saveJiraCard(draftId) {
    var rec = jiraCards[draftId];
    if (!rec || !rec.view) return;
    var threadId = jiraCardThread;
    var status = 0;
    var body = null;
    try {
      var res = await fetch('/api/jira/draft/' + encodeURIComponent(draftId) + '/save', {
        method: 'POST',
        // NOT optional: the route 415s anything else. A body-less POST is a CORS
        // *simple* request, which executes whatever the response headers say.
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      status = res.status;
      try { body = await res.json(); } catch (e) { body = null; }
    } catch (err) {
      status = 0;
    }
    if (jiraCardThread !== threadId) return;
    rec = jiraCards[draftId];
    if (!rec) return;
    if (status === 200 && body && body.draftId) {
      // Adopt what the ROW now holds rather than drawing \`savedAt\` optimistically
      // — the PUT rule. \`savedAt\` is what makes «Lagret» survive a reload.
      rec.view = body;
      rec.message = undefined;
      rec.messageTone = undefined;
      renderJiraCardRecord(draftId);
      return;
    }
    var served = body && typeof body.error === 'string' ? body.error.trim() : '';
    setJiraCardMessage(draftId, served || jiraCardSaveFailedMessage(status), 'err');
  }

  function wireJiraCards() {
    if (jiraCardWired) return;
    jiraCardWired = true;
    document.addEventListener('click', function(ev) {
      var target = ev.target;
      if (!target || !target.closest) return;
      var copy = target.closest('[${JCARD_COPY_ATTR}]');
      if (copy) { ev.preventDefault(); copyJiraCard(copy.getAttribute('${JCARD_COPY_ATTR}')); return; }
      var save = target.closest('[${JCARD_SAVE_ATTR}]');
      if (save) { ev.preventDefault(); saveJiraCard(save.getAttribute('${JCARD_SAVE_ATTR}')); return; }
    });
  }

  wireJiraCards();
`;
}
