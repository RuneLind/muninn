import { test, expect, describe } from "bun:test";
import {
  botDefaultOptionLabel,
  chatUserStorageKey,
  chosenSupportsWebTools,
  conflictCopy,
  connectorOptionLabel,
  connectorStorageValue,
  pickConnectorId,
  pickUserId,
  previewThreadName,
  shouldCloseChatOptions,
  wikiConnectorStorageKey,
  WIKI_CONNECTOR_DEFAULT,
  type ChatOptClickContext,
  type ChatTarget,
  type ChatTargetConnector,
} from "./wiki-chat-target.ts";

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
