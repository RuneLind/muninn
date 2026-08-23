import { describe, expect, test } from "bun:test";
import {
  JE_BTN_ATTR,
  JE_CANCEL_BUSY_TITLE,
  JE_DEFAULT_DEPTH,
  JE_DRAFTING_ATTR,
  JE_DRAFTING_MESSAGE,
  initialJiraEntryState,
  jiraEntryButtonHtml,
  jiraEntryCanSubmit,
  jiraEntryDraftBody,
  jiraEntryDraftingHtml,
  jiraEntryFallbackMessage,
  jiraEntryOutcome,
  jiraEntryPanelHtml,
  jiraEntryVisible,
} from "./jira-entry-pure.ts";
import { JIRA_EXTRA_MAX } from "../../../jira/wire.ts";

const THREAD = "8f2b2f2e-0000-4000-8000-000000000001";

describe("jiraEntryVisible", () => {
  test("renders only on the Jira bot with a known thread", () => {
    expect(jiraEntryVisible({ selectedBot: "melosys", jiraBot: "melosys", threadId: THREAD })).toBe(true);
  });

  test("a non-Jira bot gets nothing — the route would 400 that thread", () => {
    expect(jiraEntryVisible({ selectedBot: "jarvis", jiraBot: "melosys", threadId: THREAD })).toBe(false);
  });

  test("case-insensitive, like resolveJiraBot", () => {
    expect(jiraEntryVisible({ selectedBot: "Melosys", jiraBot: "melosys", threadId: THREAD })).toBe(true);
  });

  test("no resolved Jira bot ⇒ no control (every /api/jira route 503s there)", () => {
    expect(jiraEntryVisible({ selectedBot: "melosys", jiraBot: null, threadId: THREAD })).toBe(false);
    expect(jiraEntryVisible({ selectedBot: "melosys", jiraBot: "  ", threadId: THREAD })).toBe(false);
  });

  test("no thread ⇒ no control", () => {
    expect(jiraEntryVisible({ selectedBot: "melosys", jiraBot: "melosys", threadId: null })).toBe(false);
    expect(jiraEntryVisible({ selectedBot: "melosys", jiraBot: "melosys", threadId: "" })).toBe(false);
  });

  test("no selected bot ⇒ no control", () => {
    expect(jiraEntryVisible({ selectedBot: "", jiraBot: "melosys", threadId: THREAD })).toBe(false);
  });
});

describe("jiraEntryDraftBody", () => {
  test("carries exactly what the route validates", () => {
    expect(jiraEntryDraftBody({ threadId: THREAD, template: "bug", depth: "skisse", extra: "fokus" })).toEqual({
      threadId: THREAD,
      template: "bug",
      depth: "skisse",
      extra: "fokus",
    });
  });

  test("a blank steer is OMITTED, not sent as an empty string", () => {
    expect(jiraEntryDraftBody({ threadId: THREAD, template: "task", depth: "ingen", extra: "   " })).toEqual({
      threadId: THREAD,
      template: "task",
      depth: "ingen",
    });
    expect(jiraEntryDraftBody({ threadId: THREAD, template: "task", depth: "ingen" })).toEqual({
      threadId: THREAD,
      template: "task",
      depth: "ingen",
    });
  });
});

describe("jiraEntryCanSubmit", () => {
  test("needs a resolved template", () => {
    const s = { ...initialJiraEntryState(), loading: false };
    expect(jiraEntryCanSubmit(s)).toBe(false);
    expect(jiraEntryCanSubmit({ ...s, template: "bug" })).toBe(true);
  });

  test("off while loading or sending", () => {
    const s = { ...initialJiraEntryState(), loading: false, template: "bug" };
    expect(jiraEntryCanSubmit({ ...s, loading: true })).toBe(false);
    expect(jiraEntryCanSubmit({ ...s, sending: true })).toBe(false);
  });

  test("off past the extra cap — the route 400s it", () => {
    const s = { ...initialJiraEntryState(), loading: false, template: "bug" };
    expect(jiraEntryCanSubmit({ ...s, extra: "x".repeat(JIRA_EXTRA_MAX) })).toBe(true);
    expect(jiraEntryCanSubmit({ ...s, extra: "x".repeat(JIRA_EXTRA_MAX + 1) })).toBe(false);
  });
});

describe("jiraEntryOutcome", () => {
  // No `url` any more: the draft's destination is the conversation, and the id
  // goes to the card poller rather than into a tab's location.
  test("200 with a draft id hands the id back and nothing else", () => {
    expect(jiraEntryOutcome(200, { draftId: "abc", status: "generating" })).toEqual({
      ok: true,
      draftId: "abc",
    });
  });

  test("200 without an id is a failure, not a silent no-op", () => {
    const out = jiraEntryOutcome(200, {});
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.message).toContain("uten utkast-id");
  });

  test("the SERVER's own bokmål sentence leads on every refusal", () => {
    // The 409 the from-thread route actually serves.
    const conflict = jiraEntryOutcome(409, {
      state: "running",
      expiresAtMs: 1,
      error: "Det skrives allerede en Jira-sak i denne samtalen.",
    });
    expect(conflict).toEqual({ ok: false, message: "Det skrives allerede en Jira-sak i denne samtalen." });

    const wrongBot = jiraEntryOutcome(400, { error: 'Samtalen tilhører boten "jarvis"…' });
    expect(wrongBot).toEqual({ ok: false, message: 'Samtalen tilhører boten "jarvis"…' });
  });

  test("falls back per status when there is no readable body", () => {
    expect(jiraEntryOutcome(409, null)).toEqual({ ok: false, message: jiraEntryFallbackMessage(409) });
    expect(jiraEntryOutcome(415, {})).toEqual({ ok: false, message: jiraEntryFallbackMessage(415) });
    expect(jiraEntryOutcome(0, null)).toEqual({ ok: false, message: jiraEntryFallbackMessage(0) });
    expect(jiraEntryOutcome(500, { error: "   " })).toEqual({ ok: false, message: jiraEntryFallbackMessage(500) });
  });

  test("every fallback is a distinct Norwegian sentence", () => {
    const msgs = [0, 400, 404, 409, 415, 503, 500].map(jiraEntryFallbackMessage);
    expect(new Set(msgs).size).toBe(msgs.length);
    for (const m of msgs) expect(m.length).toBeGreaterThan(10);
  });
});

describe("markup", () => {
  test("the button stamps its thread and escapes it", () => {
    const html = jiraEntryButtonHtml('x"><script>');
    expect(html).toContain("Lag Jira-sak");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;");
  });

  /**
   * The control is rendered once per finalized bot message, so it CANNOT carry an
   * id: a thread with 30 replies rendered 30 elements sharing one, which is
   * invalid HTML and makes `getElementById` and `#id` selectors name whichever
   * one the parser saw first. The hook is an attribute; the PANEL keeps its id,
   * which is legitimate because opening one closes any other.
   */
  test("carries NO id — it is rendered once per message", () => {
    const html = jiraEntryButtonHtml(THREAD);
    expect(html).toContain(`${JE_BTN_ATTR}`);
    expect(html).toContain("msg-jira-btn");
    expect(html).not.toMatch(/\sid=/);
  });

  test("the panel opens on skisse and offers all three depths", () => {
    const html = jiraEntryPanelHtml({ ...initialJiraEntryState(), loading: false, template: "bug" });
    expect(html).toContain('value="ingen"');
    expect(html).toContain('value="skisse" selected');
    expect(html).toContain('value="full"');
    expect(JE_DEFAULT_DEPTH).toBe("skisse");
  });

  /**
   * Avbryt while a POST is on the wire tore the panel down under the response
   * handler, and the handler then had nowhere to put a started draft — so the
   * turn ran, the row existed, the thread's flight slot was held, and the next
   * click 409'd about work the reader had never been shown. The button says so
   * instead of pretending the run can be called off.
   */
  test("Avbryt is disabled with a reason while a POST is in flight", () => {
    const sending = jiraEntryPanelHtml({
      ...initialJiraEntryState(),
      loading: false,
      template: "bug",
      sending: true,
    });
    expect(sending).toMatch(/id="jeCancel"[^>]*disabled/);
    expect(sending).toContain(JE_CANCEL_BUSY_TITLE);

    const idle = jiraEntryPanelHtml({ ...initialJiraEntryState(), loading: false, template: "bug" });
    expect(idle).not.toMatch(/id="jeCancel"[^>]*disabled/);
    expect(idle).not.toContain(JE_CANCEL_BUSY_TITLE);
  });

  test("no templates yet says so instead of rendering an empty picker", () => {
    expect(jiraEntryPanelHtml(initialJiraEntryState())).toContain("henter maler");
    expect(jiraEntryPanelHtml({ ...initialJiraEntryState(), loading: false })).toContain("ingen maler");
  });

  test("the note names the card, not a second page", () => {
    const html = jiraEntryPanelHtml({ ...initialJiraEntryState(), loading: false, template: "bug" });
    expect(html).toContain("kort under svaret");
    // Nothing opens a tab any more, so nothing may promise one.
    expect(html).not.toContain("Åpne utkastet");
  });

  test("the message line is always a node so a refusal has somewhere to land", () => {
    const html = jiraEntryPanelHtml({ ...initialJiraEntryState(), loading: false, template: "bug" });
    expect(html).toContain('class="je-msg" hidden');
  });

  test("no draft-url branch survives — the panel has ONE message line", () => {
    const html = jiraEntryPanelHtml({
      ...initialJiraEntryState(),
      loading: false,
      template: "bug",
      message: "noe gikk galt",
      messageTone: "err",
    });
    expect(html).toContain("je-msg-err");
    expect(html).not.toContain("<a ");
  });

  test("the reader's steer is escaped back into the field", () => {
    const html = jiraEntryPanelHtml({
      ...initialJiraEntryState(),
      loading: false,
      template: "bug",
      extra: '"><img onerror=x>',
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img");
  });
});

/**
 * The placeholder that stands between the 200 and the card.
 *
 * Keyed on the DRAFT id because the card lands under a different bubble — the
 * new turn's — so `attachJiraCard` cannot remove it by position.
 */
describe("jiraEntryDraftingHtml", () => {
  test("carries the draft id so the card can clear it by key", () => {
    const html = jiraEntryDraftingHtml("d-9");
    expect(html).toContain(`${JE_DRAFTING_ATTR}="d-9"`);
    expect(html).toContain(JE_DRAFTING_MESSAGE);
  });

  test("escapes the id — it is echoed into an attribute", () => {
    expect(jiraEntryDraftingHtml('"><img onerror=x>')).not.toContain("<img");
  });

  test("carries the archive link the docstring promises — a 200 means work is RUNNING", () => {
    // The note is the only pointer between the click and the card, and the card
    // may never come (a failed run, a bubble outside the replayed window). The
    // link is what the reader is left with when it does not.
    expect(jiraEntryDraftingHtml("d-9")).toContain('href="/jira?draft=d-9"');
  });
});
