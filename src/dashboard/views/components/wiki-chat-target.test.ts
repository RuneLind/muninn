import { test, expect, describe } from "bun:test";
import {
  botDefaultOptionLabel,
  chatUserStorageKey,
  chosenSupportsWebTools,
  conflictCopy,
  connectorOptionLabel,
  pickConnectorId,
  pickUserId,
  previewThreadName,
  wikiConnectorStorageKey,
  type ChatTarget,
} from "./wiki-chat-target.ts";

const target = (over: Partial<ChatTarget> = {}): ChatTarget => ({
  botName: "jarvis",
  needsBot: false,
  bots: [{ name: "jarvis" }, { name: "melosys" }],
  users: [{ id: "u1", name: "rune" }, { id: "u2", name: "other" }],
  defaultUserId: "u2",
  connectors: [
    { id: "c-cli", name: "Sonnet (CLI)", connectorType: "claude-cli", supportsWebTools: true },
    { id: "c-cop", name: "Copilot", connectorType: "copilot-sdk", supportsWebTools: false },
  ],
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
});

describe("option labels", () => {
  test("only the ABSENCE of web search is stated", () => {
    expect(connectorOptionLabel(target().connectors[0]!)).toBe("Sonnet (CLI)");
    expect(connectorOptionLabel(target().connectors[1]!)).toBe("Copilot · no web search");
  });

  test('"(bot default)" carries its resolved capability like every other option', () => {
    expect(botDefaultOptionLabel(target().botDefault)).toBe("Bot default (claude-sdk · sonnet)");
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
