import { describe, expect, test } from "bun:test";
import { streamingUiScript } from "./streaming-ui.ts";

/**
 * The two functions that decide WHICH bubble a finished turn belongs to — the
 * `jira-card.test.ts` harness pattern, driving the real `streamingUiScript()`
 * source with a stubbed DOM.
 *
 * Everything downstream hangs off this one answer: the model stamp, the 👍/👎
 * row, the «🧾 Lag Jira-sak» control, and — through the `data-message-id` this
 * stamps — the Jira draft card. A wrong bubble here is not a cosmetic slip; it
 * lands a draft's card under an unrelated reply.
 *
 * Synthetic ids throughout — muninn is a public repo.
 */

interface BubbleSpec {
  /** `data-client-id` — the server's throwaway id on a live turn, the ROW id on replay. */
  clientId?: string;
  /** `data-message-id`, as `attachFeedbackControls` stamps it. */
  messageId?: string;
  intermediate?: boolean;
}

interface FakeNode {
  className: string;
  dataset: Record<string, string>;
  children: FakeNode[];
  querySelector: (q: string) => FakeNode | null;
  appendChild: (n: FakeNode) => void;
}

function harness(specs: BubbleSpec[]) {
  const jiraControls: FakeNode[] = [];

  function makeEl(className = ""): FakeNode {
    const node: FakeNode = {
      className,
      dataset: {},
      children: [],
      querySelector: (q: string) => {
        const want = q.replace(/^\./, "");
        return node.children.find((c) => c.className.split(" ").includes(want)) ?? null;
      },
      appendChild: (c: FakeNode) => {
        node.children.push(c);
      },
    };
    return node;
  }

  const bubbles = specs.map((s) => {
    const node = makeEl("msg msg-bot" + (s.intermediate ? " msg-intermediate" : ""));
    if (s.clientId) node.dataset.clientId = s.clientId;
    if (s.messageId) node.dataset.messageId = s.messageId;
    return node;
  });

  const live = () => bubbles.filter((b) => !b.className.includes("msg-intermediate"));

  const chatMessages = {
    querySelector(q: string) {
      const m = /data-client-id="([^"]+)"/.exec(q);
      if (!m) return null;
      return live().find((b) => b.dataset.clientId === m[1]) ?? null;
    },
    querySelectorAll(_q: string) {
      return live();
    },
  };

  const ctx = {
    chatMessages,
    document: { createElement: (_tag: string) => makeEl() },
    fetch: async () => ({ ok: true }),
    appendJiraEntryControl: (wrap: FakeNode) => jiraControls.push(wrap),
  };

  const made = new Function(
    "ctx",
    "var chatMessages = ctx.chatMessages; var document = ctx.document; var fetch = ctx.fetch;" +
      "var appendJiraEntryControl = ctx.appendJiraEntryControl;" +
      streamingUiScript() +
      "return { botMessageForMeta: botMessageForMeta, attachFeedbackControls: attachFeedbackControls };",
  )(ctx) as {
    botMessageForMeta: (meta: { clientMessageId?: string; messageId?: string }) => FakeNode | null;
    attachFeedbackControls: (node: FakeNode, messageId: string) => void;
  };

  return { ...made, bubbles, jiraControls };
}

describe("botMessageForMeta", () => {
  test("prefers the bubble the server's own clientMessageId names", () => {
    const h = harness([{ clientId: "c-1" }, { clientId: "c-2" }]);
    expect(h.botMessageForMeta({ clientMessageId: "c-1", messageId: "m-1" })).toBe(h.bubbles[0]!);
  });

  test("falls back to the DB id — a REPLAYED bubble carries it in data-client-id", () => {
    // The second-tab / reconnect case: this tab rendered the thread from
    // history, so every bubble carries its ROW id (page.ts appendMessage), and
    // the meta's clientMessageId names a throwaway id this tab never rendered.
    // Going positional there landed the meta — and any draft binding hanging
    // off it — on whichever reply happened to be last.
    const h = harness([{ clientId: "m-1" }, { clientId: "m-2" }]);
    const target = h.botMessageForMeta({ clientMessageId: "c-9", messageId: "m-1" });
    expect(target).toBe(h.bubbles[0]!);
  });

  test("intermediate bubbles are never the answer", () => {
    const h = harness([{ clientId: "m-1" }, { clientId: "m-2", intermediate: true }]);
    expect(h.botMessageForMeta({ messageId: "zzz" })).toBe(h.bubbles[0]!);
  });

  test("the positional guess is refused when the last bubble is already BOUND elsewhere", () => {
    // `data-message-id` is a binding, not a decoration: `attachJiraCard`
    // resolves its host through it. Overwriting one bubble's binding with
    // another message's id is how a draft card ends up under a reply that has
    // nothing to do with it — so an already-bound candidate is not a guess we
    // are allowed to make.
    const h = harness([{ clientId: "c-1", messageId: "m-1" }]);
    expect(h.botMessageForMeta({ clientMessageId: "c-2", messageId: "m-2" })).toBeNull();
  });

  test("an UNBOUND last bubble is still the fallback — that was the whole behaviour", () => {
    const h = harness([{ clientId: "c-1" }]);
    expect(h.botMessageForMeta({ clientMessageId: "c-2", messageId: "m-2" })).toBe(h.bubbles[0]!);
  });
});

describe("attachFeedbackControls", () => {
  test("stamps the message id and renders the row once", () => {
    const h = harness([{ clientId: "c-1" }]);
    const bubble = h.bubbles[0]!;
    h.attachFeedbackControls(bubble, "m-1");
    h.attachFeedbackControls(bubble, "m-1");
    expect(bubble.dataset.messageId).toBe("m-1");
    expect(bubble.children.filter((c) => c.className === "msg-feedback")).toHaveLength(1);
    expect(h.jiraControls).toHaveLength(1);
  });

  test("never re-points a bubble already bound to a DIFFERENT message", () => {
    // The stamp used to happen BEFORE the `.msg-feedback` idempotency return, so
    // a second call — a positional fallback that picked the wrong bubble —
    // silently overwrote a binding that was already correct.
    const h = harness([{ clientId: "c-1" }]);
    const bubble = h.bubbles[0]!;
    h.attachFeedbackControls(bubble, "m-1");
    h.attachFeedbackControls(bubble, "m-2");
    expect(bubble.dataset.messageId).toBe("m-1");
  });
});
