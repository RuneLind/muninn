import { test, expect, describe } from "bun:test";
import path from "node:path";
import {
  botDefaultOptionLabel,
  chatEscBarHtml,
  chatOptQuestion,
  chatUserStorageKey,
  chosenSupportsWebTools,
  composeDeclineQuestion,
  conflictCopy,
  connectorOptionLabel,
  connectorStorageValue,
  declineChatBarHtml,
  DECLINE_CHAT_BTN_ID,
  pickConnectorId,
  pickUserId,
  previewThreadName,
  shouldCloseChatOptions,
  wikiConnectorStorageKey,
  WIKI_CONNECTOR_DEFAULT,
  type ChatEscTurn,
  type ChatOptClickContext,
  type ChatTarget,
  type ChatTargetConnector,
} from "./wiki-chat-target.ts";
import { explainLabel } from "./wiki-explain.ts";

const CONNECTORS: ChatTargetConnector[] = [
  { id: "c-cli", name: "Sonnet (CLI)", connectorType: "claude-cli", supportsWebTools: true },
  { id: "c-cop", name: "Copilot", connectorType: "copilot-sdk", supportsWebTools: false },
];

const target = (over: Partial<ChatTarget> = {}): ChatTarget => ({
  botName: "jarvis",
  users: [{ id: "u1", name: "rune" }, { id: "u2", name: "other" }],
  defaultUserId: "u2",
  connectors: CONNECTORS,
  botDefault: { connectorType: "claude-sdk", model: "sonnet", supportsWebTools: true },
  ...over,
});

describe("pickUserId", () => {
  test("a remembered user this bot still has wins", () => {
    expect(pickUserId(target(), "u1")).toBe("u1");
  });

  test("falls back to the bot_default_user mapping", () => {
    expect(pickUserId(target(), null)).toBe("u2");
  });

  test("a remembered user the bot no longer has does NOT win", () => {
    // The chat-page key is shared across bots, so a stale id from another bot is
    // the normal case, not an edge one.
    expect(pickUserId(target(), "someone-else")).toBe("u2");
  });

  test("a sole user is picked even with no mapping", () => {
    const t = target({ users: [{ id: "only", name: "rune" }], defaultUserId: null });
    expect(pickUserId(t, null)).toBe("only");
  });

  test("several users and no usable mapping resolves to nothing — never positional", () => {
    expect(pickUserId(target({ defaultUserId: null }), null)).toBe("");
  });
});

describe("pickConnectorId", () => {
  test("the wiki's last-used connector wins over the chat preference", () => {
    expect(pickConnectorId(target(), "c-cop", "c-cli")).toBe("c-cop");
  });

  test("falls back to the user+bot chat preference", () => {
    expect(pickConnectorId(target(), null, "c-cli")).toBe("c-cli");
  });

  test("falls back to bot default when neither is set", () => {
    expect(pickConnectorId(target(), null, null)).toBe("");
  });

  test("a remembered connector that no longer exists falls through", () => {
    expect(pickConnectorId(target(), "deleted-row", "c-cli")).toBe("c-cli");
    expect(pickConnectorId(target(), "deleted-row", "also-gone")).toBe("");
  });

  test('a remembered "(bot default)" is an ANSWER, and stops the chain', () => {
    // Storing "" was indistinguishable from storing nothing: the membership test
    // can never match it, so the reader's deliberate move OFF a named model was
    // silently undone by the chat preference on the very next open.
    expect(connectorStorageValue("")).toBe(WIKI_CONNECTOR_DEFAULT);
    expect(connectorStorageValue("c-cli")).toBe("c-cli");
    expect(pickConnectorId(target(), WIKI_CONNECTOR_DEFAULT, "c-cli")).toBe("");
    // Sanity: the old value really does fall through (the bug being fixed).
    expect(pickConnectorId(target(), "", "c-cli")).toBe("c-cli");
  });

  test("the failure branch's absent fields don't throw", () => {
    // The route ships bot/reason/error ONLY when it couldn't resolve a target.
    const failed: ChatTarget = { botName: null, reason: "needs_bot", bots: [{ name: "jarvis" }] };
    expect(pickConnectorId(failed, "c-cli", "c-cop")).toBe("");
    expect(pickUserId(failed, "u1")).toBe("");
    expect(chosenSupportsWebTools(failed, "c-cli")).toBe(false);
  });
});

describe("shouldCloseChatOptions", () => {
  const ctx = (over: Partial<ChatOptClickContext> = {}): ChatOptClickContext => ({
    open: true,
    attached: true,
    inPanel: false,
    inOpener: false,
    sending: false,
    inQuestionBox: false,
    pinned: false,
    mode: "escalate",
    ...over,
  });

  test("an ordinary outside click closes it", () => {
    expect(shouldCloseChatOptions(ctx())).toBe(true);
  });

  test("clicks inside the panel or on its openers never close it", () => {
    expect(shouldCloseChatOptions(ctx({ inPanel: true }))).toBe(false);
    expect(shouldCloseChatOptions(ctx({ inOpener: true }))).toBe(false);
  });

  test("a DETACHED target is not an outside click — the submit self-close", () => {
    // `submitChatOptions` sets `sending` and re-renders synchronously before its
    // first await, so the Send button the user just clicked is gone from the
    // document by the time this listener runs. Reading `closest("#wikiChatOpt")`
    // on it returns null, the panel closed, and the in-flight submit then saw
    // `chatOpt !== state` and closed the pre-opened tab — thread and seed created
    // server-side, nothing shown, retry hitting `alreadyQueued`.
    expect(shouldCloseChatOptions(ctx({ attached: false, inPanel: false }))).toBe(false);
    // Belt and braces: nothing closes it while a submit is in flight either.
    expect(shouldCloseChatOptions(ctx({ sending: true }))).toBe(false);
  });

  test("direct mode keeps the panel open while the reader types the question", () => {
    // The panel's own copy tells them to "Type a question first"; the Ask box is
    // the recovery path, so clicking into it must not dismiss the panel.
    expect(shouldCloseChatOptions(ctx({ mode: "direct", inQuestionBox: true }))).toBe(false);
    // In escalate mode the question comes from the turn, so the box is outside.
    expect(shouldCloseChatOptions(ctx({ mode: "escalate", inQuestionBox: true }))).toBe(true);
  });

  test("a PINNED question makes the Ask box an ordinary outside click again", () => {
    // The decline hook neither reads nor writes the box, so clicking into it is
    // the reader moving on to a new question — not part of this popover's flow.
    expect(
      shouldCloseChatOptions(ctx({ mode: "direct", inQuestionBox: true, pinned: true })),
    ).toBe(true);
  });

  test("a closed popover is never closed again", () => {
    expect(shouldCloseChatOptions(ctx({ open: false }))).toBe(false);
  });
});

describe("option labels", () => {
  test("only the ABSENCE of web search is stated", () => {
    expect(connectorOptionLabel(CONNECTORS[0]!)).toBe("Sonnet (CLI)");
    expect(connectorOptionLabel(CONNECTORS[1]!)).toBe("Copilot · no web search");
  });

  test('"(bot default)" carries its resolved capability like every other option', () => {
    expect(botDefaultOptionLabel(target().botDefault!)).toBe("Bot default (claude-sdk · sonnet)");
    expect(
      botDefaultOptionLabel({ connectorType: "openai-compat", supportsWebTools: false }),
    ).toBe("Bot default (openai-compat) · no web search");
  });
});

describe("chosenSupportsWebTools", () => {
  test("an empty pick means the bot default's capability, not a hardcoded true", () => {
    expect(chosenSupportsWebTools(target(), "")).toBe(true);
    expect(
      chosenSupportsWebTools(
        target({ botDefault: { connectorType: "copilot-sdk", supportsWebTools: false } }),
        "",
      ),
    ).toBe(false);
  });

  test("a named connector's own capability wins", () => {
    expect(chosenSupportsWebTools(target(), "c-cop")).toBe(false);
    expect(chosenSupportsWebTools(target(), "c-cli")).toBe(true);
  });
});

describe("previewThreadName", () => {
  test("mirrors the route: typed name wins, else the question", () => {
    expect(previewThreadName("My Notes Thread", "How does X work?")).toBe("my notes thread");
    expect(previewThreadName("   ", "How does X work?")).toBe("how does x work?");
  });

  test("a typed name that flattens to NOTHING falls back to the question", () => {
    // Not to the generic "wiki ask" — a name of only control characters carries
    // no name, and the route makes exactly this fallback.
    expect(previewThreadName("\u0000\u0007 \t", "How does X work?")).toBe("how does x work?");
  });

  test("shows the same lowercased, flattened, ≤50-char name createThread stores", () => {
    const out = previewThreadName("", "What\texactly happens when the gardener drains the backlog?");
    expect(out.length).toBeLessThanOrEqual(50);
    expect(/[\n\r\t]/.test(out)).toBe(false);
    expect(out).toBe(out.toLowerCase());
  });
});

describe("storage keys", () => {
  test("the user key is the chat page's own key — one answer, not two", () => {
    expect(chatUserStorageKey("jarvis")).toBe("muninn-chat-user-jarvis");
  });

  test("the connector key is scoped per WIKI and never collides with the chat sidebar's", () => {
    expect(wikiConnectorStorageKey("mimir")).toBe("muninn-wiki-chat-connector-mimir");
    expect(wikiConnectorStorageKey("")).toBe("muninn-wiki-chat-connector-__default__");
    expect(wikiConnectorStorageKey("jarvis")).not.toBe("muninn-connector-jarvis");
  });
});

describe("conflictCopy", () => {
  test("does not claim the question collided when the reader typed the name", () => {
    expect(conflictCopy(true)).toContain("that name");
    expect(conflictCopy(false)).toContain("this question");
  });
});

// ── Decline hook (PR B) ──────────────────────────────────────────────
// These live here rather than in `wiki-ask-session.test.ts`: the bar's markup, the
// question composition and the bar's branch ORDER are all this module's helpers.
// Only the PERSISTENCE of `declined`/`explainPage`/`originQuestion` belongs there.

describe("chatOptQuestion", () => {
  const direct = { mode: "direct" as const, question: "snapshot at open" };

  test("a PINNED question ignores the live Ask box entirely", () => {
    // The decline hook's whole point: the reader's own draft in the box is
    // untouched and irrelevant, and the failed question is what gets sent.
    expect(
      chatOptQuestion({ ...direct, pinnedQuestion: "why did X fail?" }, "a draft I was typing"),
    ).toBe("why did X fail?");
    // …including when the box is empty, or absent from the document altogether.
    expect(chatOptQuestion({ ...direct, pinnedQuestion: "why did X fail?" }, "")).toBe(
      "why did X fail?",
    );
    expect(chatOptQuestion({ ...direct, pinnedQuestion: "why did X fail?" }, null)).toBe(
      "why did X fail?",
    );
  });

  test("un-pinned direct mode still re-reads the live box (PR A's M9)", () => {
    expect(chatOptQuestion(direct, "  what I typed just now  ")).toBe("what I typed just now");
    expect(chatOptQuestion(direct, null)).toBe("");
  });

  test("escalate mode reads the turn's question, never the box", () => {
    expect(
      chatOptQuestion({ mode: "escalate", question: "the turn's question" }, "unrelated draft"),
    ).toBe("the turn's question");
  });
});

describe("composeDeclineQuestion", () => {
  test("a plain Ask question escalates verbatim", () => {
    expect(composeDeclineQuestion({ question: "How does the gardener cluster?" })).toBe(
      "How does the gardener cluster?",
    );
  });

  test("an Explain turn escalates as page + passage, not as its display label", () => {
    // `Explain: "…"` is a LABEL — the real question is built server-side from
    // `sel` and never comes back, so escalating the label sends a fragment naming
    // neither the page nor a question.
    const out = composeDeclineQuestion({
      question: explainLabel("the coverage gate declines rather than grounding an answer"),
      explainPage: "Wiki Gardener",
    });
    expect(out).toContain('About the wiki page "Wiki Gardener"');
    expect(out).toContain("explain this passage");
    expect(out).toContain("the coverage gate declines");
    expect(out).not.toContain('Explain: "');
  });

  test("an Explain turn whose question isn't a label still names the page", () => {
    expect(
      composeDeclineQuestion({ question: "what does this mean?", explainPage: "Atlas" }),
    ).toBe('About the wiki page "Atlas": what does this mean?');
  });

  test("a follow-up escalates with the question that opened the chain", () => {
    const out = composeDeclineQuestion({
      question: "and what about the second one?",
      originQuestion: "Which two gardeners write to the wiki?",
    });
    expect(out).toContain("Which two gardeners write to the wiki?");
    expect(out).toContain("Follow-up: and what about the second one?");
  });

  test("the origin is not re-stated when it IS the question", () => {
    const q = "Which two gardeners write to the wiki?";
    expect(composeDeclineQuestion({ question: q, originQuestion: q })).toBe(q);
    expect(composeDeclineQuestion({ question: q, originQuestion: "   " })).toBe(q);
  });

  test("stays third-person about the reader", () => {
    // Same rule as `buildDirectChatSeed`'s opening: a first-person line here is
    // prose the memory extractor records as a biographical fact about the user.
    const out = composeDeclineQuestion({
      question: "and the other one?",
      originQuestion: "How does X work?",
    });
    expect(out).not.toContain("I first asked");
    expect(out).not.toMatch(/\bI (asked|am|was)\b/);
  });
});

describe("declineChatBarHtml", () => {
  test("the two decline reasons render distinct copy", () => {
    // "nothing" would be a lie for low confidence — weak sources DID ride out and
    // are listed under the answer.
    expect(declineChatBarHtml("no_hits")).toContain("nothing on this");
    expect(declineChatBarHtml("no_hits")).not.toContain("nothing solid");
    expect(declineChatBarHtml("low_confidence")).toContain("nothing solid");
  });

  test("carries the shared button id the click delegation binds", () => {
    expect(declineChatBarHtml("no_hits")).toContain(DECLINE_CHAT_BTN_ID);
    expect(declineChatBarHtml("no_hits")).toContain("Ask in chat instead");
  });
});

describe("chatEscBarHtml", () => {
  const turn = (over: Partial<ChatEscTurn> = {}): ChatEscTurn => ({
    answer: "the wiki's answer",
    ...over,
  });

  test("an uncommitted or fact-check turn renders no bar at all", () => {
    expect(chatEscBarHtml(turn({ answer: "" }))).toBe("");
    expect(chatEscBarHtml(turn({ kind: "factcheck" }))).toBe("");
  });

  test("an ordinary answered turn offers the escalate button + gear", () => {
    const html = chatEscBarHtml(turn());
    expect(html).toContain("Continue in chat →");
    expect(html).toContain("wikiChatEscOptBtn");
  });

  test("a declined turn renders the decline hook instead of the ordinary button", () => {
    const html = chatEscBarHtml(turn({ declined: "no_hits" }));
    expect(html).toContain(DECLINE_CHAT_BTN_ID);
    expect(html).not.toContain("Continue in chat →");
  });

  test("a REALISED escalation outranks the decline hook — the link is never shadowed", () => {
    // The thread exists and this link is the reader's only way back to it. With
    // the decline check first the bar went on saying "Ask in chat instead →" and
    // the second click walked 409 recovery for a thread they couldn't reach.
    const done = chatEscBarHtml(
      turn({ declined: "low_confidence", chatEsc: { status: "done", chatUrl: "/chat?x=1", opened: true } }),
    );
    expect(done).toContain("/chat?x=1");
    expect(done).toContain("✓ Opened in chat →");
    expect(done).not.toContain(DECLINE_CHAT_BTN_ID);

    const exists = chatEscBarHtml(
      turn({ declined: "no_hits", chatEsc: { status: "exists", chatUrl: "/chat?x=2" } }),
    );
    expect(exists).toContain("/chat?x=2");
    expect(exists).toContain("Start new thread");
    expect(exists).not.toContain(DECLINE_CHAT_BTN_ID);
  });

  test("a blocked popup says so honestly rather than claiming a tab opened", () => {
    const html = chatEscBarHtml(turn({ chatEsc: { status: "done", chatUrl: "/chat?x=1" } }));
    expect(html).toContain("Chat thread created — open it →");
  });

  test("escapes the url and the error message", () => {
    expect(
      chatEscBarHtml(turn({ chatEsc: { status: "done", chatUrl: '"><script>' } })),
    ).not.toContain("<script>");
    expect(
      chatEscBarHtml(turn({ chatEsc: { status: "error", message: "<img onerror=1>" } })),
    ).not.toContain("<img");
  });
});

// ── wiki-browser call sites ──────────────────────────────────────────
// `wiki-browser.ts` runs DOM code at module load and cannot be imported here, so
// the two wiring facts that no pure helper can hold are pinned at the SOURCE
// level (the `research-page.test.ts` / `connector-selector.test.ts` precedent).

describe("wiki-browser wiring", () => {
  let cached: string | undefined;
  async function browserSrc(): Promise<string> {
    if (!cached) {
      cached = await Bun.file(path.join(import.meta.dir, "wiki-browser.ts")).text();
    }
    return cached;
  }

  /** One top-level `function <name>(` body, up to the next top-level function. */
  function fnBody(src: string, name: string): string {
    const start = src.indexOf("\nfunction " + name + "(");
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\nfunction ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  test("the decline opener pins the question and NEVER writes the Ask box", async () => {
    const body = fnBody(await browserSrc(), "openDeclineChat");
    // The bug this replaced: `input.value = turn.question` clobbered the reader's
    // draft, left the failed question armed in the box, and on the Connections tab
    // wrote into a hidden textarea.
    expect(body).not.toContain("wikiAskInput");
    expect(body).not.toMatch(/\.value\s*=/);
    expect(body).toContain("pinnedQuestion");
    expect(body).toContain("composeDeclineQuestion");
    // The turn rides along so a successful escalation mirrors onto its own bar
    // (`state.turn.chatEsc`) instead of being lost with the popover.
    expect(body).toContain("turn,");
    expect(body).toContain("askDeclined: true");
  });

  test("the panel shows the pinned question — it is nowhere else on screen", async () => {
    // Not in the Ask box (deliberately) and not the label shown on the turn (it is
    // composed), so without this row the only echo is the ≤50-char name preview.
    const body = fnBody(await browserSrc(), "chatOptBodyHtml");
    expect(body).toContain("state.pinnedQuestion");
    expect(body).toContain("wiki-chatopt-pinned");
    expect(body).toContain("esc(state.pinnedQuestion)");
  });

  test("the click-away opener list includes the decline button", async () => {
    // Missing from `inOpener`, the button's own click reads as an outside click
    // and closes the panel it just opened.
    const src = await browserSrc();
    const start = src.indexOf("inOpener:");
    expect(start).toBeGreaterThan(-1);
    // By identifier, not by literal — the id is shared with the render and the
    // click delegation precisely so the three can't drift.
    expect(src.slice(start, src.indexOf("sending:", start))).toContain("DECLINE_CHAT_BTN_ID");
  });
});
