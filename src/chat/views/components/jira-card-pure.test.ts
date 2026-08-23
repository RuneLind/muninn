import { describe, expect, test } from "bun:test";
import {
  JCARD_ATTR,
  JCARD_COPY_ATTR,
  JCARD_GAVE_UP_MESSAGE,
  JCARD_NOTICE_ID,
  JCARD_PENDING_MESSAGE,
  JCARD_RETRY_HINT,
  JCARD_SAVE_ATTR,
  jiraCardArchiveUrl,
  jiraCardBadges,
  jiraCardHtml,
  jiraCardNoticeHtml,
  jiraCardPollExpired,
  jiraCardSaveFailedMessage,
  jiraCardShouldPoll,
  jiraCardSignature,
  type JiraCardView,
} from "./jira-card-pure.ts";
import { JIRA_POLL_MAX_MS } from "../../../jira/wire.ts";

/**
 * The card's decisions, without a browser.
 *
 * Synthetic keys throughout (`ABC-123`) — muninn is a public repo, so no fixture
 * here may carry real corpus text.
 */
const READY: JiraCardView = {
  draftId: "d-1",
  status: "ready",
  template: "bug",
  depth: "skisse",
  markdown: "## Problem\nNoe er galt.\n\n## Referanser\n- [ABC-123](https://example.test/browse/ABC-123)",
  keyVerdicts: [{ key: "ABC-123", state: "verified" }],
  markdownFlags: [],
  savedAt: null,
  error: null,
  messageId: "m-1",
};

describe("jiraCardShouldPoll — the LOOP is gated, the read is not", () => {
  test("a generating row keeps polling", () => {
    expect(jiraCardShouldPoll({ status: "generating", messageId: "m-1" })).toBe(true);
  });

  test("a settled row with a message is DONE", () => {
    expect(jiraCardShouldPoll({ status: "ready", messageId: "m-1" })).toBe(false);
    expect(jiraCardShouldPoll({ status: "failed", messageId: "m-1" })).toBe(false);
  });

  test("a READY row with no message keeps polling — the stamp lands just after the turn", () => {
    expect(jiraCardShouldPoll({ status: "ready", messageId: null })).toBe(true);
  });

  test("a FAILED row is done even with no message — nothing is running to stamp one", () => {
    // The row is terminal, so the loop had nothing to wait for: it re-read the
    // same answer every 2.5 s for thirteen minutes, and started over on every
    // thread load. The thread-level notice reports it on the first read.
    expect(jiraCardShouldPoll({ status: "failed", messageId: null })).toBe(false);
  });
});

describe("jiraCardPollExpired", () => {
  test("gives up at the server's own ceiling, not before", () => {
    const t0 = 1_000_000;
    expect(jiraCardPollExpired(t0, t0 + JIRA_POLL_MAX_MS - 1, JIRA_POLL_MAX_MS)).toBe(false);
    expect(jiraCardPollExpired(t0, t0 + JIRA_POLL_MAX_MS, JIRA_POLL_MAX_MS)).toBe(true);
  });
});

describe("jiraCardBadges", () => {
  test("the three key states stay three badges — they mean different things", () => {
    const badges = jiraCardBadges({
      keyVerdicts: [
        { key: "ABC-1", state: "verified" },
        { key: "ABC-2", state: "verified" },
        { key: "ABC-3", state: "notes" },
        { key: "ABC-4", state: "unknown" },
      ],
      markdownFlags: [],
    });
    expect(badges.map((b) => b.tone)).toEqual(["ok", "warn", "err"]);
    expect(badges[0]!.label).toContain("2 nøkler bekreftet");
    expect(badges[0]!.detail).toBe("ABC-1, ABC-2");
    expect(badges[2]!.detail).toContain("ABC-4");
  });

  test("singular and plural are not the same word", () => {
    const one = jiraCardBadges({ keyVerdicts: [{ key: "ABC-1", state: "verified" }], markdownFlags: [] });
    expect(one[0]!.label).toBe("1 nøkkel bekreftet");
  });

  test("a draft that cites nothing renders NO key badge — there is nothing to check", () => {
    expect(jiraCardBadges({ keyVerdicts: [], markdownFlags: [] })).toEqual([]);
  });

  test("paste-subset flags are one badge naming the constructs and their lines", () => {
    const badges = jiraCardBadges({
      keyVerdicts: [],
      markdownFlags: [
        { kind: "task-list", line: 4, sample: "- [ ] gjør noe" },
        { kind: "html", line: 9, sample: "<br>" },
      ],
    });
    expect(badges).toHaveLength(1);
    expect(badges[0]!.tone).toBe("warn");
    expect(badges[0]!.label).toContain("2 konstruksjoner");
    expect(badges[0]!.detail).toContain("avkryssingsliste");
    expect(badges[0]!.detail).toContain("rå HTML");
    expect(badges[0]!.detail).toContain("4, 9");
  });

  test("a malformed row degrades to no badges rather than throwing", () => {
    const badges = jiraCardBadges({
      keyVerdicts: null as unknown as [],
      markdownFlags: undefined as unknown as [],
    });
    expect(badges).toEqual([]);
  });
});

describe("jiraCardHtml — ready", () => {
  test("carries the draft id on the root and on both controls", () => {
    const html = jiraCardHtml(READY, { bodyHtml: "<p>x</p>" });
    expect(html).toContain(`${JCARD_ATTR}="d-1"`);
    expect(html).toContain(`${JCARD_COPY_ATTR}="d-1"`);
    expect(html).toContain(`${JCARD_SAVE_ATTR}="d-1"`);
  });

  test("renders the body the CALLER passed — the module never formats markdown", () => {
    const html = jiraCardHtml(READY, { bodyHtml: "<h2>Problem</h2>" });
    expect(html).toContain("<h2>Problem</h2>");
    // The raw markdown is NOT in the card — Kopier markdown copies it from the
    // record, and dumping it here would double the payload.
    expect(html).not.toContain("## Problem");
  });

  test("an archive link to /jira rides along — the composer stays reachable", () => {
    expect(jiraCardHtml(READY, {})).toContain(`href="${jiraCardArchiveUrl("d-1")}"`);
  });

  test("savedAt turns the button into a mark — that is what survives a reload", () => {
    const unsaved = jiraCardHtml(READY, {});
    expect(unsaved).toContain(`${JCARD_SAVE_ATTR}="d-1"`);
    expect(unsaved).not.toContain("jira-card-saved");

    const saved = jiraCardHtml({ ...READY, savedAt: 1_700_000_000_000 }, {});
    expect(saved).toContain("jira-card-saved");
    expect(saved).not.toContain(`${JCARD_SAVE_ATTR}=`);
  });

  test("the inline message line is rendered when set and hidden when not", () => {
    expect(jiraCardHtml(READY, {})).toContain('class="jira-card-msg" hidden');
    const withMsg = jiraCardHtml(READY, { message: "Markdown kopiert.", messageTone: "ok" });
    expect(withMsg).toContain("jira-card-msg-ok");
    expect(withMsg).toContain("Markdown kopiert.");
  });

  test("everything the server supplies is escaped", () => {
    const html = jiraCardHtml(
      { ...READY, draftId: '"><img onerror=x>', template: "<script>" },
      { message: "<b>x</b>" },
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("jiraCardHtml — failed", () => {
  const FAILED: JiraCardView = {
    ...READY,
    status: "failed",
    markdown: null,
    keyVerdicts: [],
    error: "Utkastet kunne ikke skrives ferdig. Se muninn-loggen for detaljer, og prøv igjen.",
  };

  test("renders the SERVER's sentence and names the retry", () => {
    const html = jiraCardHtml(FAILED, {});
    expect(html).toContain("Utkastet kunne ikke skrives ferdig");
    expect(html).toContain(JCARD_RETRY_HINT);
  });

  test("NO Kopier and NO Lagre — there is nothing to copy or keep", () => {
    const html = jiraCardHtml(FAILED, {});
    expect(html).not.toContain(JCARD_COPY_ATTR);
    expect(html).not.toContain(JCARD_SAVE_ATTR);
  });

  test("a settled row with no markdown reads as failed even if the status says otherwise", () => {
    // The `ready`-with-null-markdown row should not render an empty card with a
    // copy button that copies nothing.
    const html = jiraCardHtml({ ...READY, markdown: null, error: null }, {});
    expect(html).toContain("jira-card-failed");
    expect(html).not.toContain(JCARD_COPY_ATTR);
  });
});

describe("jiraCardHtml — generating", () => {
  test("says it is being written, with no controls to press", () => {
    const html = jiraCardHtml({ ...READY, status: "generating", markdown: null }, {});
    expect(html).toContain(JCARD_PENDING_MESSAGE);
    expect(html).not.toContain(JCARD_COPY_ATTR);
    expect(html).not.toContain(JCARD_SAVE_ATTR);
  });

  test("a poller that gave up SAYS so rather than claiming work is still running", () => {
    const html = jiraCardHtml({ ...READY, status: "generating", markdown: null }, { gaveUp: true });
    expect(html).toContain(JCARD_GAVE_UP_MESSAGE);
    expect(html).not.toContain(JCARD_PENDING_MESSAGE);
  });
});

describe("jiraCardNoticeHtml", () => {
  test("nothing to say renders nothing at all", () => {
    expect(jiraCardNoticeHtml([])).toBe("");
  });

  test("names both reasons and links the archive for each", () => {
    const html = jiraCardNoticeHtml([
      { draftId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", reason: "unmapped" },
      { draftId: "11111111-2222-3333-4444-555555555555", reason: "offscreen" },
    ]);
    expect(html).toContain(`id="${JCARD_NOTICE_ID}"`);
    expect(html).toContain("ingen melding ble skrevet");
    expect(html).toContain("utenfor historikken");
    expect(html).toContain('href="/jira?draft=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"');
    expect(html).toContain('href="/jira?draft=11111111-2222-3333-4444-555555555555"');
  });

  test("the id is escaped — it is echoed into an href and a label", () => {
    expect(jiraCardNoticeHtml([{ draftId: '"><img onerror=x>', reason: "unmapped" }])).not.toContain("<img");
  });
});

describe("jiraCardSignature", () => {
  test("a save changes it — the card has to redraw", () => {
    expect(jiraCardSignature(READY)).not.toBe(jiraCardSignature({ ...READY, savedAt: 1 }));
  });

  test("generating → ready changes it", () => {
    expect(jiraCardSignature({ ...READY, status: "generating" })).not.toBe(jiraCardSignature(READY));
  });

  test("giving up changes it", () => {
    expect(jiraCardSignature(READY)).not.toBe(jiraCardSignature(READY, true));
  });

  test("a re-pointed messageId changes it — WHERE the card stands is visible too", () => {
    // A regenerate is another turn: the row keeps `ready` and moves its
    // `message_id`. Without the id in the signature the redraw was skipped and
    // the card stayed under the previous reply.
    expect(jiraCardSignature(READY)).not.toBe(jiraCardSignature({ ...READY, messageId: "m-2" }));
  });

  test("the same view twice is the same signature — a redraw throws away a standing note", () => {
    expect(jiraCardSignature(READY)).toBe(jiraCardSignature({ ...READY }));
  });
});

describe("jiraCardSaveFailedMessage", () => {
  test("every case is a distinct Norwegian sentence", () => {
    const msgs = [0, 404, 415, 500].map(jiraCardSaveFailedMessage);
    expect(new Set(msgs).size).toBe(msgs.length);
    for (const m of msgs) expect(m.length).toBeGreaterThan(10);
  });
});

describe("jiraCardArchiveUrl", () => {
  test("encodes the id", () => {
    expect(jiraCardArchiveUrl("a b/c")).toBe("/jira?draft=a%20b%2Fc");
  });
});
