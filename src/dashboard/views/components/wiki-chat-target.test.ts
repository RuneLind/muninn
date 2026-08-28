import { test, expect, describe } from "bun:test";
import path from "node:path";
import {
  articleChatHint,
  articleChatContextHtml,
  ARTICLE_HINT_MAX,
  ARTICLE_QUESTION_PLACEHOLDER,
  botDefaultOptionLabel,
  captureChatOptFocus,
  chatEscBarHtml,
  chatOptConflictFootHtml,
  chatOptEscapeAction,
  chatOptNameChipsHtml,
  chatOptNameSource,
  chatOptQuestion,
  chatOptQuestionHtml,
  chatOptQuestionReadOnly,
  chatOptStatusLines,
  chatOptSuggestionsHtml,
  chatOptSummaryHtml,
  chatOptSummaryTextHtml,
  chatUserStorageKey,
  chosenSupportsWebTools,
  composeDeclineQuestion,
  conflictCopy,
  conflictStatusLine,
  connectorOptionLabel,
  connectorStorageValue,
  declineChatBarHtml,
  discussArticleBtnHtml,
  shouldCloseArticleChatOnNavigate,
  suggestedQuestions,
  threadNameSuggestions,
  CHAT_OPT_ADV_ID,
  CHAT_OPT_EMPTY_QUESTION,
  CHAT_OPT_NAME_CHIP_ATTR,
  CHAT_OPT_SUGGEST_ATTR,
  DIRECT_QUESTION_PLACEHOLDER,
  SUGGESTION_LABEL_MAX,
  CHAT_OPT_FORCE_ID,
  CHAT_OPT_QUESTION_ID,
  CHAT_OPT_SEND_THERE_ID,
  DECLINE_CHAT_BTN_ID,
  DISCUSS_ARTICLE_BTN_ID,
  pickConnectorId,
  pickUserId,
  previewThreadName,
  shouldCloseChatOptions,
  summaryThreadName,
  wikiConnectorStorageKey,
  WIKI_CONNECTOR_DEFAULT,
  type ChatEscTurn,
  type ChatOptArticle,
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

  test("the Ask box is an ordinary outside click — the dialog owns its question", () => {
    // Direct mode used to read its question from `#wikiAskInput`, so clicking
    // there (the recovery path from "Type a question first") had to be exempt. The
    // dialog has its own field in every mode now, so the exemption — and the
    // `mode`/`pinned`/`inQuestionBox` context it needed — is gone: a click in the
    // box is the reader moving on, and the dialog closes.
    expect(shouldCloseChatOptions(ctx())).toBe(true);
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
  const direct = { mode: "direct" as const, question: "typed in the dialog" };

  test("a PINNED question wins over the dialog's own field", () => {
    // The decline hook's whole point: the question belongs to the turn that
    // failed, so it is fixed at open and the field is not even rendered.
    expect(
      chatOptQuestion({ ...direct, pinnedQuestion: "  why did X fail?  " }),
    ).toBe("why did X fail?");
  });

  test("every un-pinned mode reads the dialog's OWN field", () => {
    // This is the collapse: direct mode used to re-read the live `#wikiAskInput`
    // at submit, which made opening the dialog on an empty box a dead end — it
    // asked for a question while covering the only field that could supply one.
    expect(chatOptQuestion(direct)).toBe("typed in the dialog");
    expect(chatOptQuestion({ mode: "escalate", question: "the turn's question" }))
      .toBe("the turn's question");
    expect(chatOptQuestion({ mode: "article", question: "  what changed in v4?  " }))
      .toBe("what changed in v4?");
  });

  test("an empty question stays empty — that is what keeps Send disabled", () => {
    // The route 400s an empty question, so the button must never be live on one.
    expect(chatOptQuestion({ mode: "direct", question: "   " })).toBe("");
    expect(chatOptQuestion({ mode: "article", question: "" })).toBe("");
  });
});

// ── Article mode ("💬 Discuss") ──────────────────────────────────────

describe("article popover prefill + hint", () => {
  const page = (over: Partial<ChatOptArticle> = {}): ChatOptArticle => ({
    name: "Wiki gardener",
    title: "Wiki gardener",
    relPath: "projects/muninn/wiki-gardener.md",
    ...over,
  });

  test("NEITHER summary prefills the question — both are hints", () => {
    // The authored `description` used to prefill, and it is exactly the failure
    // the `desc` demotion was written for: a description is a declarative
    // sentence (blog subtitles, sniffed <meta> descriptions — 98 mimir pages),
    // Send is ENABLED on whatever is in the box, so one click sent the page's own
    // subtitle as the reader's question — and the server appended the same string
    // to the seed as its parenthetical, so it arrived twice.
    const authored = page({ description: "How clustering works." });
    expect(articleChatHint(authored)).toBe("How clustering works.");
    expect(chatOptQuestionHtml("article", "")).toContain("></textarea>");

    // `desc` — the page's first prose LINE — behaves the same way.
    const prose = page({ desc: "The gardener clusters summaries every week." });
    expect(articleChatHint(prose)).toBe("The gardener clusters summaries every week.");
    // Neither summary reaches the question field — they render in the context row.
    expect(articleChatContextHtml(prose)).toContain("The gardener clusters summaries every week.");
    expect(chatOptQuestionHtml("article", "")).not.toContain("gardener clusters");

    // The authored one wins the hint slot on a page carrying both.
    expect(articleChatHint(page({ description: "Authored.", desc: "First line." })))
      .toBe("Authored.");
  });

  test("a page with neither renders no hint at all", () => {
    expect(articleChatHint(page())).toBe("");
    expect(articleChatContextHtml(page())).not.toContain("wiki-chatopt-says");
  });

  test("an unbounded summary is CLAMPED — it used to bury the Send button", () => {
    // mimir's longest is 1816 chars and 186 real pages exceed 400; rendered
    // whole, the hint pushed the panel's only action below the popover fold.
    const hint = articleChatHint(page({ desc: "x".repeat(1816) }));
    expect(hint.length).toBeLessThanOrEqual(ARTICLE_HINT_MAX + 1);
    expect(hint.endsWith("…")).toBe(true);
    // A summary that fits is rendered verbatim, ellipsis-free.
    expect(articleChatHint(page({ desc: "Short enough to read." })))
      .toBe("Short enough to read.");
  });

  test("the question field is EDITABLE, not a pinned line", () => {
    const html = chatOptQuestionHtml("article", "why the cap?");
    expect(html).toContain('id="' + CHAT_OPT_QUESTION_ID + '"');
    expect(html).toContain("<textarea");
    expect(html).toContain(">why the cap?</textarea>");
    expect(html).toContain(ARTICLE_QUESTION_PLACEHOLDER);
    // The pinned (decline-hook) treatment must NOT appear — that one is read-only.
    expect(html).not.toContain("wiki-chatopt-pinned");
  });

  test("direct mode gets the same field with a mode-appropriate placeholder", () => {
    const html = chatOptQuestionHtml("direct", "prefilled from the Ask box");
    expect(html).toContain('id="' + CHAT_OPT_QUESTION_ID + '"');
    expect(html).toContain(">prefilled from the Ask box</textarea>");
    expect(html).toContain(DIRECT_QUESTION_PLACEHOLDER);
    expect(html).not.toContain(ARTICLE_QUESTION_PLACEHOLDER);
  });

  test("escalate and pinned questions are READ-ONLY, article and direct are not", () => {
    // The seed carries the escalated turn's answer + citations VERBATIM, so an
    // edited question ships a quoted answer to a question nobody asked, cited to
    // sources that support the original. Before the dialog redesign this was
    // structural (only article mode rendered a textarea); widening the field to
    // every mode re-opened it, hence the explicit gate.
    expect(chatOptQuestionReadOnly("escalate", false)).toBe(true);
    expect(chatOptQuestionReadOnly("direct", true)).toBe(true);
    expect(chatOptQuestionReadOnly("article", true)).toBe(true);
    expect(chatOptQuestionReadOnly("direct", false)).toBe(false);
    expect(chatOptQuestionReadOnly("article", false)).toBe(false);
  });

  test("page text is escaped at every sink", () => {
    const html =
      articleChatContextHtml(page({ title: "<img src=x>", desc: '"><script>alert(1)</script>' })) +
      chatOptQuestionHtml("article", "<b>q</b>");
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>q</b>");
  });
});

// ── Suggestions: starter questions + thread names ────────────────────

describe("suggestedQuestions", () => {
  const page: ChatOptArticle = {
    name: "Wiki gardener",
    title: "Wiki gardener",
    relPath: "projects/muninn/wiki-gardener.md",
  };

  test("article mode asks about the page, and names it in every question", () => {
    const out = suggestedQuestions({ mode: "article", article: page });
    expect(out.length).toBeGreaterThanOrEqual(4);
    for (const s of out) {
      expect(s.label).toBeTruthy();
      expect(s.question).toContain("Wiki gardener");
    }
  });

  test("the link and date chips are offered ONLY when their data exists", () => {
    const bare = suggestedQuestions({ mode: "article", article: page });
    expect(bare.some((s) => s.label === "How it connects")).toBe(false);
    // "what changed since" with no since is not a question anyone can answer, so a
    // frontmatter-less wiki gets one chip fewer rather than a fabricated date.
    expect(bare.some((s) => s.label === "What changed since")).toBe(false);

    const rich = suggestedQuestions({
      mode: "article",
      article: { ...page, updated: "2026-07-31" },
      links: ["Backlog drain", "Source drafter", "A third one"],
    });
    const connects = rich.find((s) => s.label === "How it connects");
    expect(connects?.question).toContain("Backlog drain");
    expect(connects?.question).toContain("Source drafter");
    // At most TWO neighbours are named — three turns the question into a list.
    expect(connects?.question).not.toContain("A third one");
    expect(rich.find((s) => s.label === "What changed since")?.question).toContain("2026-07-31");
  });

  test("the page's own title is never offered as its own neighbour", () => {
    const out = suggestedQuestions({
      mode: "article",
      article: page,
      links: ["Wiki gardener", "Backlog drain"],
    });
    const connects = out.find((s) => s.label === "How it connects");
    expect(connects?.question).toContain("Backlog drain");
    expect((connects?.question.match(/Wiki gardener/g) || []).length).toBe(1);
  });

  test("direct mode asks about the WIKI, named when we know it", () => {
    const named = suggestedQuestions({ mode: "direct", wiki: "mimir" });
    expect(named.every((s) => s.question.includes('"mimir" wiki'))).toBe(true);
    // Bare /wiki has no name to use, and must not render a dangling quote pair.
    const unnamed = suggestedQuestions({ mode: "direct" });
    expect(unnamed.every((s) => s.question.includes("this wiki"))).toBe(true);
    expect(unnamed.some((s) => s.question.includes('""'))).toBe(false);
  });

  test("the session's last question becomes a continue chip, clipped in the LABEL only", () => {
    const long = "why does the gardener drop clusters below the minimum size every single week";
    const out = suggestedQuestions({ mode: "direct", wiki: "mimir", lastQuestion: long });
    const chip = out.find((s) => s.label.startsWith("Continue"));
    expect(chip).toBeTruthy();
    expect(chip!.label.length).toBeLessThan(long.length);
    // The QUESTION keeps the whole thing — the label is decoration, the question
    // is what gets sent.
    expect(chip!.question).toContain(long);
  });

  test("escalate mode and a pinned question get NO suggestions", () => {
    // The reader already asked something; a row of alternatives beside it is an
    // invitation to throw their own question away.
    expect(suggestedQuestions({ mode: "escalate", wiki: "mimir" })).toEqual([]);
    expect(suggestedQuestions({ mode: "direct", wiki: "mimir", pinned: true })).toEqual([]);
  });

  test("article mode with no article — or a title that flattens away — offers nothing", () => {
    expect(suggestedQuestions({ mode: "article" })).toEqual([]);
    expect(suggestedQuestions({ mode: "article", article: { ...page, title: "  " } })).toEqual([]);
  });

  test("the chips render as fill-the-box buttons, escaped, with the full question in title=", () => {
    const html = chatOptSuggestionsHtml(
      [{ label: "Summarise it", question: 'Summarise "<b>x</b>" & tell me' }],
      "Ask about this page",
    );
    expect(html).toContain(CHAT_OPT_SUGGEST_ATTR + "=");
    expect(html).toContain("Ask about this page");
    expect(html).toContain("title=");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&amp;");
    // A chip is a button, never a submit — the whole rule is "fills the box".
    expect(html).toContain('type="button"');
    // Nothing to suggest ⇒ no heading either (an empty labelled row reads broken).
    expect(chatOptSuggestionsHtml([], "Ask about this page")).toBe("");
  });

  test("a long chip label is clipped for the row", () => {
    const html = chatOptSuggestionsHtml(
      [{ label: "x".repeat(SUGGESTION_LABEL_MAX + 20), question: "q" }],
      "Or start from",
    );
    expect(html).not.toContain("x".repeat(SUGGESTION_LABEL_MAX + 1));
  });

  test("a title's quotes and markup are neutralised before they reach the prompt", () => {
    // Not an escaping issue (every HTML sink runs `esc`) — a PROMPT-quality one: the
    // templates wrap the title in "…", so a title carrying its own quotes produced
    // unbalanced nesting, and an .mdx title's tags were sent to the model verbatim.
    const out = suggestedQuestions({
      mode: "article",
      article: {
        name: "p", relPath: "p.md",
        title: 'Backlog "drain" <b>x</b>',
      },
    });
    for (const s of out) {
      expect(s.question).not.toContain('"drain"');
      expect(s.question).not.toContain("<b>");
      // Exactly the one quoted span the template opens, so the title's end is
      // unambiguous.
      expect((s.question.match(/"/g) || []).length).toBe(2);
    }
    expect(out[0]!.question).toContain("'drain'");
  });

  test("clipping never splits a surrogate pair", () => {
    // A title ending in an emoji clipped mid-pair renders as U+FFFD — the same bug
    // `ask-chat.ts`'s `truncateUnits` exists for, observed in real thread names.
    const emoji = "🎉".repeat(80);
    const out = suggestedQuestions({
      mode: "article",
      article: { name: "p", relPath: "p.md", title: emoji },
    });
    for (const s of out) {
      expect(s.question).not.toContain("�");
      // No lone surrogate survived the clip.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s.question))
        .toBe(false);
    }
    const chip = suggestedQuestions({ mode: "direct", wiki: "w", lastQuestion: emoji })
      .find((s) => s.label.startsWith("Continue"));
    expect(chip!.label).not.toContain("�");
  });
});

describe("threadNameSuggestions", () => {
  test("article mode offers the page name, the question name and a dated one", () => {
    const out = threadNameSuggestions({
      mode: "article",
      question: "Why is the cluster cap 3?",
      articleTitle: "Wiki gardener",
      today: "4 aug",
    });
    expect(out.map((s) => s.label)).toEqual(["from page", "from question", "dated"]);
    // Through the SAME derivation the field uses, so a chip can never offer a name
    // the route would then store differently.
    expect(out[0]!.value).toBe("wiki gardener");
    expect(out[1]!.value).toBe("why is the cluster cap 3?");
    expect(out[2]!.value).toBe("wiki gardener 4 aug");
  });

  test("no article ⇒ the question is the only source", () => {
    const out = threadNameSuggestions({ mode: "direct", question: "How does drain work?" });
    expect(out.map((s) => s.label)).toEqual(["from question"]);
  });

  test("nothing to derive from ⇒ no chips, never a generic fallback name", () => {
    // `deriveAskThreadTitle` would answer "wiki ask" here; offering that as a
    // CHOICE would let a reader pin a thread to the generic fallback on purpose.
    expect(threadNameSuggestions({ mode: "direct", question: "   " })).toEqual([]);
    expect(threadNameSuggestions({ mode: "article", question: "", articleTitle: " " }))
      .toEqual([]);
  });

  test("a question that derives the SAME name as the page isn't offered twice", () => {
    const out = threadNameSuggestions({
      mode: "article",
      question: "Wiki gardener",
      articleTitle: "Wiki gardener",
    });
    expect(out.map((s) => s.label)).toEqual(["from page"]);
  });

  test("the dated chip needs both a base and a day", () => {
    expect(
      threadNameSuggestions({ mode: "article", question: "q", articleTitle: "T" })
        .some((s) => s.label === "dated"),
    ).toBe(false);
  });

  test("the chip row marks the ACTIVE name and always offers the default", () => {
    const chips = [{ label: "from page", value: "wiki gardener" }];
    const active = chatOptNameChipsHtml(chips, "wiki gardener");
    expect(active).toContain(CHAT_OPT_NAME_CHIP_ATTR + '="wiki gardener"');
    expect(active).toContain("on");
    // The default chip is an EMPTY value — `threadName: ""` is exactly what makes
    // the route derive the name itself again.
    expect(active).toContain(CHAT_OPT_NAME_CHIP_ATTR + '=""');
    // With nothing typed, the default chip is the active one.
    expect(chatOptNameChipsHtml(chips, "")).toContain('=""');
    expect(chatOptNameChipsHtml([], "")).toBe("");
  });
});

describe("chatOptSummaryHtml", () => {
  test("reports all three collapsed choices, and the toggle states itself", () => {
    const html = chatOptSummaryHtml({
      userName: "rune",
      modelLabel: "Sonnet (CLI)",
      threadName: "wiki gardener",
      advOpen: false,
    });
    expect(html).toContain("rune");
    expect(html).toContain("Sonnet (CLI)");
    expect(html).toContain("wiki gardener");
    expect(html).toContain('id="' + CHAT_OPT_ADV_ID + '"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("⚙ Options");
    const open = chatOptSummaryHtml({
      userName: "rune", modelLabel: "m", threadName: "t", advOpen: true,
    });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("Hide options");
  });

  test("an unknown value is OMITTED, never rendered as a dangling separator", () => {
    // A single-user install has no user to name, and a still-resolving target has
    // no model — the line has to read as a sentence in both cases.
    const html = chatOptSummaryTextHtml({
      userName: "", modelLabel: "", threadName: "wiki gardener",
    });
    expect(html).toBe("thread <b>wiki gardener</b>");
    expect(chatOptSummaryTextHtml({ userName: "", modelLabel: "", threadName: "" })).toBe("");
  });

  test("the summary names no thread until there is something to name it after", () => {
    // `previewThreadName` answers the generic `wiki ask` for a blank question,
    // because `createThread` needs SOME name. Reporting that in the summary of a
    // dialog whose question box is still empty states a decision nothing has made —
    // and the name-chip row (which refuses to offer the fallback as a choice) is
    // empty at exactly the same moment, so the two disagreed.
    expect(summaryThreadName("", "")).toBe("");
    expect(summaryThreadName("", "   ")).toBe("");
    // Either source filling in is enough, and both go through the real derivation.
    expect(summaryThreadName("", "Why is the cap three?")).toBe("why is the cap three?");
    expect(summaryThreadName("My Thread", "")).toBe("my thread");
    // Sanity: this is a DIFFERENCE from the field's own derivation, not a rewrite
    // of it — the route really would store the fallback if it ever got that far.
    expect(previewThreadName("", "")).toBe("wiki ask");
  });

  test("every part is escaped", () => {
    const html = chatOptSummaryTextHtml({
      userName: "<img src=x>", modelLabel: "<b>m</b>", threadName: '"><script>',
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<b>m</b>");
    expect(html).not.toContain("<script>");
  });
});

describe("chatOptNameSource", () => {
  test("article mode names the thread after the PAGE, not the question", () => {
    // This is what makes every later question about the page land in the SAME
    // thread (409 → "Send there →") instead of minting a sibling per visit.
    expect(chatOptNameSource("article", "why the cap?", "Wiki gardener")).toBe("Wiki gardener");
    expect(previewThreadName("", chatOptNameSource("article", "why the cap?", "Wiki gardener")))
      .toBe("wiki gardener");
  });

  test("a title-less page falls back to the question, never to the generic name", () => {
    expect(chatOptNameSource("article", "why the cap?", "   ")).toBe("why the cap?");
    expect(chatOptNameSource("article", "why the cap?", undefined)).toBe("why the cap?");
  });

  test("'has a usable title' is the ROUTE's test, not .trim()", () => {
    // A control-character title is TRUTHY and survives `.trim()`, so the preview
    // used to derive from it and land on the generic `wiki ask` fallback — while
    // the route (which asks `deriveAskThreadTitleOrNull`) stored the
    // question-derived name. Two different names for one click.
    const control = "\u0001\u0002";
    expect(chatOptNameSource("article", "why the cap?", control)).toBe("why the cap?");
    expect(previewThreadName("", chatOptNameSource("article", "why the cap?", control)))
      .toBe("why the cap?");
    expect(previewThreadName("", chatOptNameSource("article", "why the cap?", control)))
      .not.toBe("wiki ask");
  });

  test("the other two modes are untouched", () => {
    expect(chatOptNameSource("direct", "why the cap?", "Wiki gardener")).toBe("why the cap?");
    expect(chatOptNameSource("escalate", "why the cap?", "Wiki gardener")).toBe("why the cap?");
  });
});

describe("the 409 in article mode reads as success, not as a clash", () => {
  test('"Send there →" is the PRIMARY action, "Start new thread" the ghost', () => {
    const foot = chatOptConflictFootHtml();
    const sendThere = foot.indexOf(CHAT_OPT_SEND_THERE_ID);
    const startNew = foot.indexOf("Start new thread");
    expect(sendThere).toBeGreaterThan(-1);
    expect(foot).toContain("Send there →");
    // Order (primary first) AND treatment: the Send-there button carries no
    // `ghost` modifier, the "start another" one does. Reversing them would make
    // every repeat visit to an article mint another thread.
    expect(sendThere).toBeLessThan(startNew);
    // The Send-there button's own tag carries no `ghost` modifier; the
    // "start another" one does.
    expect(foot.slice(sendThere, foot.indexOf("</button>", sendThere))).not.toContain("ghost");
    expect(foot.slice(startNew - 60, startNew)).toContain("ghost");
  });

  test("the status line states the DESIGNED outcome, not a name clash", () => {
    const line = conflictStatusLine(false, "article");
    expect(line).toContain("This article already has a chat thread");
    expect(line).toContain("send your question there");
    // Not the generic "a chat for this question already exists" — the reader
    // asked about a page, not about a question they'd asked before.
    expect(line).not.toContain("for this question");
  });

  test("a TYPED name still gets the honest name-clash copy in every mode", () => {
    for (const mode of ["article", "direct", "escalate"] as const) {
      expect(conflictStatusLine(true, mode)).toContain(conflictCopy(true));
    }
    // …and the other two modes keep exactly the copy they shipped with.
    expect(conflictStatusLine(false, "direct")).toBe(
      conflictCopy(false) + " Send this question there, or start another.",
    );
  });
});

/**
 * The OTHER 409: the name collided with a thread that is not this article's.
 *
 * `findThreadByName` is (user, bot, name)-scoped and article names are page
 * titles, so a collision proves nothing — 13 colliding title groups over 30
 * mimir+jarvis pages, cross-wiki collisions on one bot, and any `/topic` chat
 * thread can own the name. The route checks the colliding thread's description
 * tag; when it doesn't match, "Send there →" would cross-seed a conversation
 * about something else entirely.
 */
describe("nameTaken — the collision that is NOT this article's thread", () => {
  test("offers ONLY a new thread, and makes it the primary action", () => {
    const foot = chatOptConflictFootHtml({ nameTaken: true });
    expect(foot).not.toContain(CHAT_OPT_SEND_THERE_ID);
    expect(foot).not.toContain("Send there");
    expect(foot).toContain(CHAT_OPT_FORCE_ID);
    expect(foot).toContain("Start new thread");
    // Primary treatment: the sole action is no longer the ghost second choice.
    expect(foot).not.toContain("ghost");
  });

  test("says the name is taken by something unrelated — never that this is normal", () => {
    const line = conflictStatusLine(false, "article", true);
    expect(line).toContain("unrelated");
    expect(line).toContain("start a new thread");
    // The designed-outcome copy would be a lie here: this article has NO thread.
    expect(line).not.toContain("This article already has a chat thread");
    expect(line).not.toContain("Send");
    // A typed name gets its own honest phrasing.
    expect(conflictStatusLine(true, "article", true)).toContain("already uses that name");
  });

  test("the ordinary conflict foot is untouched", () => {
    expect(chatOptConflictFootHtml()).toContain(CHAT_OPT_SEND_THERE_ID);
    expect(chatOptConflictFootHtml({})).toContain("Send there →");
  });
});

/** M1 — an EMPTY question under conflict copy. */
describe("an empty question blocks the conflict actions and says so", () => {
  test("both buttons render disabled while the question is empty", () => {
    const blocked = chatOptConflictFootHtml({ disabled: true });
    // Two buttons, two `disabled` attributes — a live one fired a blank tab that
    // opened and closed with zero feedback.
    expect(blocked.match(/disabled/g)).toHaveLength(2);
    expect(chatOptConflictFootHtml({ nameTaken: true, disabled: true })).toContain("disabled");
    expect(chatOptConflictFootHtml()).not.toContain("disabled");
  });

  test('"Type a question first." survives conflict copy on the status line', () => {
    // The status used to RETURN early, so after a 409 the conflict copy owned the
    // line and the reader was told nothing about the empty box beside two live
    // buttons.
    const lines = chatOptStatusLines({
      status: conflictStatusLine(false, "article"),
      hasTarget: true,
      question: "   ",
      hasUser: true,
    });
    expect(lines.map((l) => l.text)).toEqual([
      conflictStatusLine(false, "article"),
      CHAT_OPT_EMPTY_QUESTION,
    ]);
    expect(lines.every((l) => !l.error)).toBe(true);
  });

  test("the ordinary guidance chain is unchanged", () => {
    const of = (over: Parameters<typeof chatOptStatusLines>[0]) =>
      chatOptStatusLines(over).map((l) => l.text);
    // No target yet ⇒ no guidance about it (and no status ⇒ nothing at all).
    expect(of({ hasTarget: false, question: "", hasUser: false })).toEqual([]);
    expect(of({ hasTarget: true, question: "", hasUser: false })).toEqual([
      CHAT_OPT_EMPTY_QUESTION,
    ]);
    // A question but no user ⇒ the user line, not both.
    expect(of({ hasTarget: true, question: "q", hasUser: false })).toEqual([
      "Pick who this chat belongs to.",
    ]);
    expect(of({ hasTarget: true, question: "q", hasUser: true })).toEqual([]);
    // An error status keeps its error flag.
    expect(
      chatOptStatusLines({ status: "boom", statusIsError: true, hasTarget: true, question: "q", hasUser: true }),
    ).toEqual([{ text: "boom", error: true }]);
  });
});

/** H2 — the panel is re-rendered from state while the reader is typing into it. */
describe("captureChatOptFocus", () => {
  test("captures the focused field and its caret", () => {
    expect(
      captureChatOptFocus(
        { id: CHAT_OPT_QUESTION_ID, selectionStart: 7, selectionEnd: 12 },
        true,
      ),
    ).toEqual({ id: CHAT_OPT_QUESTION_ID, start: 7, end: 12 });
  });

  test("focus OUTSIDE the panel is not restored into it", () => {
    // The Ask box, the page list, anything: re-focusing the panel would steal
    // focus the reader deliberately moved away.
    expect(captureChatOptFocus({ id: "wikiAskInput", selectionStart: 1, selectionEnd: 1 }, false))
      .toBeNull();
    expect(captureChatOptFocus(null, true)).toBeNull();
  });

  test("an id-less or selection-less element degrades instead of throwing", () => {
    // `<select>` has no selectionStart; `document.body` has no id.
    expect(captureChatOptFocus({ id: "wikiChatOptConn" }, true)).toEqual({
      id: "wikiChatOptConn",
      start: null,
      end: null,
    });
    expect(captureChatOptFocus({ id: "" }, true)).toBeNull();
    expect(captureChatOptFocus({}, true)).toBeNull();
  });
});

/** M2 — a question the reader typed exists ONLY inside the dialog. */
describe("chatOptEscapeAction", () => {
  test("a question the reader typed takes two Escapes to discard", () => {
    const state = { question: "why the cap?", dirty: true };
    expect(chatOptEscapeAction(state)).toBe("confirm");
    expect(chatOptEscapeAction({ ...state, escArmed: true })).toBe("close");
  });

  test("an emptied field just closes, even after editing", () => {
    expect(chatOptEscapeAction({ question: "   ", dirty: true })).toBe("close");
  });

  test("a SETTLED dialog closes at once — the question was sent, not lost", () => {
    // After a success (`doneUrl`) or an `alreadyQueued` 409 (`queuedUrl`), "press Esc
    // again to discard this question" warns about work the reader just completed.
    const typed = { question: "why the cap?", dirty: true };
    expect(chatOptEscapeAction({ ...typed, settled: true })).toBe("close");
    // Sanity: without the flag this exact state confirms.
    expect(chatOptEscapeAction(typed)).toBe("confirm");
  });

  test("a PREFILLED question closes at once — it is not unsaved work", () => {
    // The gate is `dirty`, not the mode (it used to be "article only", which was
    // right when article mode owned the only in-panel textarea). Escalate's turn
    // question, direct's copy of the Ask box and a pinned decline question are all
    // reproducible by re-opening, so prompting to discard them is noise.
    expect(chatOptEscapeAction({ question: "the turn's question" })).toBe("close");
    expect(chatOptEscapeAction({ question: "prefilled from the box", dirty: false }))
      .toBe("close");
  });
});

/** M7 — the pane navigated out from under an open popover. */
describe("shouldCloseArticleChatOnNavigate", () => {
  const open = { mode: "article" as const, article: { relPath: "projects/muninn/a.md" } };

  test("a different page closes it — the popover still targets the old one", () => {
    expect(shouldCloseArticleChatOnNavigate(open, "projects/muninn/b.md")).toBe(true);
  });

  test("re-rendering the SAME page leaves it open", () => {
    expect(shouldCloseArticleChatOnNavigate(open, "projects/muninn/a.md")).toBe(false);
  });

  test("no popover, or a non-article one, is never closed by navigation", () => {
    expect(shouldCloseArticleChatOnNavigate(null, "x.md")).toBe(false);
    expect(shouldCloseArticleChatOnNavigate({ mode: "direct" }, "x.md")).toBe(false);
    expect(shouldCloseArticleChatOnNavigate({ mode: "article" }, "x.md")).toBe(false);
  });
});

describe("discussArticleBtnHtml", () => {
  test("carries the shared id the click delegation and click-away both bind", () => {
    expect(discussArticleBtnHtml()).toContain('id="' + DISCUSS_ARTICLE_BTN_ID + '"');
    expect(discussArticleBtnHtml()).toContain("Discuss");
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

// ── Client call sites ────────────────────────────────────────────────
// Both client files run DOM code at module load and cannot be imported here, so
// the wiring facts that no pure helper can hold are pinned at the SOURCE level
// (the `research-page.test.ts` / `connector-selector.test.ts` precedent).
//
// The dialog's DOM half now lives in `wiki-chat-options.ts` (2026-08 cut 2), so
// most of these read THAT file; the two that are genuinely about the reader shell
// — the breadcrumb's Discuss button and the navigation seam — still read
// `wiki-browser.ts`. Behaviour of the module's own listeners is additionally
// driven end-to-end in `wiki-chat-options.test.ts`.

describe("wiki reader chat-dialog wiring", () => {
  const cached = new Map<string, string>();
  async function srcOf(file: string): Promise<string> {
    let text = cached.get(file);
    if (text === undefined) {
      text = await Bun.file(path.join(import.meta.dir, file)).text();
      cached.set(file, text);
    }
    return text;
  }
  /** The reader shell. */
  const browserSrc = () => srcOf("wiki-browser.ts");
  /** The dialog module — state, render, openers, its own document listeners. */
  const optionsSrc = () => srcOf("wiki-chat-options.ts");

  /** Every spelling a top-level function declaration takes in these two files.
   *  ONE list, read by BOTH the start scan and the terminator scan below —
   *  keeping two lists is exactly how this broke: the start list learned
   *  `export function` (the module's exported seams) while the terminator scan
   *  still stopped only at the two un-exported flavours, so a body ran straight
   *  through every exported function after it. Measured on the file this test
   *  reads: `fnBody(optionsSrc, "submitChatOptions")` returned 138 lines,
   *  swallowing the exported `closeChatOptionsIfNavigatingAway` — i.e. a
   *  `not.toContain` assertion about the submitter was silently being made
   *  about a neighbour's body too. */
  const FN_KEYWORDS = [
    "\nfunction ",
    "\nasync function ",
    "\nexport function ",
    "\nexport async function ",
  ];
  /** One top-level `[export] [async] function <name>(` body, up to the next
   *  top-level function of any flavour. */
  function fnBody(src: string, name: string): string {
    let start = -1;
    for (const kw of FN_KEYWORDS) {
      start = src.indexOf(kw + name + "(");
      if (start !== -1) break;
    }
    expect(start).toBeGreaterThan(-1);
    let next = -1;
    for (const kw of FN_KEYWORDS) {
      const at = src.indexOf(kw, start + 1);
      if (at !== -1 && (next === -1 || at < next)) next = at;
    }
    return src.slice(start, next === -1 ? undefined : next);
  }

  test("fnBody stops at an EXPORTED function too", async () => {
    // The terminator scan used to look only for `\nfunction ` / `\nasync function `,
    // so the submitter's body ran 138 lines on into the exported navigation seam.
    const body = fnBody(await optionsSrc(), "submitChatOptions");
    expect(body).not.toContain("closeChatOptionsIfNavigatingAway");
    // …and it still contains its own tail, so the fix trimmed the neighbour, not the body.
    expect(body).toContain("data.nameTaken");
  });

  test("the decline opener pins the question and NEVER writes the Ask box", async () => {
    const body = fnBody(await optionsSrc(), "openDeclineChat");
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
    // Carries the REASON now, not a boolean: `unreachable` must not tell the
    // seed the index was searched.
    expect(body).toContain("declineReason: turn.declined");
  });

  test("the panel shows the pinned question — it is nowhere else on screen", async () => {
    // Not in the Ask box (deliberately) and not the label shown on the turn (it is
    // composed), so without this row the only echo is the ≤50-char name preview.
    const body = fnBody(await optionsSrc(), "chatOptBodyHtml");
    expect(body).toContain("chatOptQuestionReadOnly");
    expect(body).toContain("wiki-chatopt-pinned");
    // Read-only, and escaped — a composed decline question carries the page title
    // and the selected passage.
    expect(body).toContain("esc(state.pinnedQuestion ?? state.question)");
    // …and the read-only branch is chosen INSTEAD of the editable field.
    expect(body.indexOf("wiki-chatopt-pinned")).toBeLessThan(
      body.indexOf("chatOptQuestionHtml(state.mode"),
    );
  });

  test("the click-away opener list includes the decline button", async () => {
    // Missing from `inOpener`, the button's own click reads as an outside click
    // and closes the panel it just opened.
    const src = await optionsSrc();
    const start = src.indexOf("inOpener:");
    expect(start).toBeGreaterThan(-1);
    // By identifier, not by literal — the id is shared with the render and the
    // click delegation precisely so the three can't drift.
    expect(src.slice(start, src.indexOf("sending:", start))).toContain("DECLINE_CHAT_BTN_ID");
  });

  test("the click-away opener list includes the Discuss button", async () => {
    // Same trap as the decline button: without it, the opening click reads as a
    // click-away and closes the panel it just opened.
    const src = await optionsSrc();
    const start = src.indexOf("inOpener:");
    expect(src.slice(start, src.indexOf("sending:", start))).toContain("DISCUSS_ARTICLE_BTN_ID");
  });

  test("the article opener NEVER touches the Ask box", async () => {
    // Article mode has nothing to do with the Ask tab — its question is typed in
    // the panel. (The decline hook's own regression, restated for this mode.)
    const body = fnBody(await optionsSrc(), "openArticleChat");
    expect(body).not.toContain("wikiAskInput");
    expect(body).not.toMatch(/\.value\s*=/);
    // It reads the page through the shell port (`currentArticle`, the single-page
    // payload) because that is the ONLY one carrying `desc` — the listing strips it.
    expect(body).toContain("deps.getCurrentArticle()");
    expect(body).toContain("desc: m.desc");
    expect(body).toContain('openChatOptions("article"');
  });

  test("the breadcrumb renders Discuss beside the whole-article fact check", async () => {
    // One row for the article-level actions: split across two, neither is findable.
    const body = fnBody(await browserSrc(), "renderBreadcrumb");
    expect(body).toContain("wikiFactcheckArticleBtn");
    expect(body).toContain("discussArticleBtnHtml()");
    // And it stamps the open page for the popover to read.
    expect(body).toContain("currentArticle = m");
  });

  test("the article POST sends the page as a REFERENCE, never a quoted summary", async () => {
    // The seed's title/path/description are re-resolved server-side against the
    // index; a stale client copy must not be able to put an unresolvable path in
    // front of the bot.
    const body = fnBody(await optionsSrc(), "submitChatOptions");
    expect(body).toContain('payload.mode = "article"');
    expect(body).toContain("payload.page = ");
    expect(body).toContain("payload.relPath = ");
    expect(body).not.toContain("payload.description");
  });

  test("the article opener prefills NOTHING into the question box", async () => {
    // The prefill chain is gone from the opener: an authored `description` is a
    // declarative sentence, Send is enabled on it, and one click sent the page's
    // own subtitle as the reader's question.
    const body = fnBody(await optionsSrc(), "openChatOptions");
    expect(body).not.toContain("articleChatQuestion");
    expect(body).toContain('question = ""');
  });

  test("the render preserves focus + caret across its innerHTML swap", async () => {
    // The article question box renders BEFORE the chat-target fetch settles (so
    // the reader can start typing), and that fetch's `finally` re-renders the
    // whole panel — replacing the textarea mid-word.
    const body = fnBody(await optionsSrc(), "renderChatOptions");
    expect(body).toContain("captureChatOptFocus");
    expect(body).toContain("restoreChatOptFocus");
    // Captured BEFORE the swap, restored after it.
    expect(body.indexOf("captureChatOptFocus")).toBeLessThan(body.indexOf("panel.innerHTML ="));
    expect(body.indexOf("panel.innerHTML =")).toBeLessThan(body.indexOf("restoreChatOptFocus("));
  });

  test("Escape asks before discarding a question the reader typed", async () => {
    // The question exists only inside the dialog now (in every mode), so a stray
    // Escape used to be the only copy of it gone.
    const src = await optionsSrc();
    const start = src.indexOf('if (e.key === "Escape")');
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, start + 900);
    expect(handler).toContain("chatOptEscapeAction");
    expect(handler).toContain("CHAT_OPT_ESC_CONFIRM");
    expect(handler).toContain("escArmed = true");
    // The confirm is gated on the reader's own edit, not on the mode.
    expect(handler).toContain("dirty: state.dirty");
  });

  test("⌘↵ submits through the SAME pre-opened-tab discipline as the button", async () => {
    // Safari blocks a `window.open` issued after an await unconditionally, so the
    // shortcut has to open the tab synchronously inside the keydown exactly as the
    // Send click does — and it must be gated like the button's disabled state, or
    // it fires a blank tab that opens and closes with no feedback.
    const src = await optionsSrc();
    const at = src.indexOf('if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;');
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, at + 900);
    expect(handler).toContain('window.open("", "_blank")');
    expect(handler).toContain("submitChatOptions");
    expect(handler).toContain("state.userId");
    expect(handler).toContain("currentChatOptQuestion(state)");
    // A conflict/queued/done state has no single primary action left to stand for.
    expect(handler).toContain("state.conflict");
    expect(handler).toContain("state.queuedUrl");
  });

  test("a suggestion chip FILLS the question box and never submits", async () => {
    // The `desc` prefill in #420 is the cautionary case: one click from "a
    // sentence the page wrote about itself" to "the reader's own question, sent".
    const src = await optionsSrc();
    const at = src.indexOf("CHAT_OPT_SUGGEST_ATTR + \"]\")) {");
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, at + 1600);
    expect(branch).toContain("chatOpt.question = q");
    expect(branch).toContain("chatOpt.dirty = true");
    // No CALL to the submitter (the prose above it names the function deliberately).
    expect(branch).not.toContain("submitChatOptions(");
    // Inert while a submit is in flight: a 409's "Send there →" is a SECOND submit
    // that re-reads the question, so a chip clicked mid-flight silently swapped the
    // question that then went into the EXISTING thread.
    expect(branch).toContain("!chatOpt.sending");
  });

  test("a thread-name chip clears the collision it was chosen against", async () => {
    // The 409 was against the OLD name; a foot still offering "Send there →" would
    // post a thread id the new name has nothing to do with.
    const src = await optionsSrc();
    const at = src.indexOf("CHAT_OPT_NAME_CHIP_ATTR + \"]\")) {");
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, at + 900);
    expect(branch).toContain("chatOpt.threadName =");
    expect(branch).toContain("chatOpt.conflict = undefined");
    expect(branch).toContain("chatOpt.queuedUrl = undefined");
  });

  test("the dialog is centred with a scrim — no anchor maths left", async () => {
    const body = fnBody(await optionsSrc(), "renderChatOptions");
    expect(body).toContain("wikiChatOptScrim");
    expect(body).toContain('setAttribute("aria-modal", "true")');
    // The anchored-popover positioning is gone, along with the clamping it needed.
    expect(body).not.toContain("getBoundingClientRect");
    expect(body).not.toContain("panel.style.top");
    // …and the scrim is removed with the panel, or it would swallow every click.
    expect(fnBody(await optionsSrc(), "closeChatOptions")).toContain("wikiChatOptScrim");
  });

  test("navigating the pane closes an article popover, and clears the open page", async () => {
    const src = await browserSrc();
    // It must run BEFORE `currentArticle` is re-stamped — the decision compares
    // the popover's page against the incoming one.
    const crumb = fnBody(src, "renderBreadcrumb");
    expect(crumb).toContain("closeChatOptionsIfNavigatingAway(m.relPath)");
    expect(crumb.indexOf("closeChatOptionsIfNavigatingAway")).toBeLessThan(
      crumb.indexOf("currentArticle = m"),
    );
    // …and with no page open there is nothing for Discuss to act on.
    expect(fnBody(src, "hideBreadcrumb")).toContain("currentArticle = null");
    // The seam is a one-line wrapper over the pure decision, which reads the
    // dialog state the shell no longer holds.
    const seam = fnBody(await optionsSrc(), "closeChatOptionsIfNavigatingAway");
    expect(seam).toContain("shouldCloseArticleChatOnNavigate(chatOpt, relPath)");
    expect(seam).toContain("closeChatOptions()");
  });

  test("a nameTaken 409 offers no Send-there at all", async () => {
    const body = fnBody(await optionsSrc(), "submitChatOptions");
    const at = body.indexOf("data.nameTaken");
    expect(at).toBeGreaterThan(-1);
    const branch = body.slice(at, at + 700);
    expect(branch).toContain("nameTaken: true");
    // The thread id is deliberately NOT carried: there is no thread to send to.
    expect(branch).toContain('existingThreadId: ""');
    expect(branch).toContain("conflictStatusLine(typedName, state.mode, true)");
    // …and it is decided BEFORE the ordinary threadExists branch.
    expect(at).toBeLessThan(body.indexOf("data.threadExists"));
  });

  test("the shell calls initChatOptions AFTER registering its own click delegate", async () => {
    // Load-bearing ordering, and the ONLY thing holding it is the position of one
    // call in a file: the dialog registers its click delegate inside
    // `initChatOptions`, and the click-away decision it runs at the end of that
    // listener reads `document.contains(target)`. A shell branch that
    // synchronously detaches its own target (`cancelFactcheckIntegrate`) must
    // therefore run BEFORE the dialog's listener, i.e. be registered first —
    // exactly as it was when both lived in one listener. Moving the call up would
    // close the dialog on the integrate panel's Cancel, which neither tsc nor the
    // module's own listener tests can see.
    const src = await browserSrc();
    const delegate = src.indexOf('document.addEventListener("click"');
    const detaching = src.indexOf('t.closest("#wikiFcIntCancel")');
    const init = src.indexOf("initChatOptions({");
    expect(delegate).toBeGreaterThan(-1);
    expect(detaching).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(-1);
    expect(delegate).toBeLessThan(init);
    expect(detaching).toBeLessThan(init);
  });

  test("the shell wires every port member to its real binding", async () => {
    // The port is six callbacks to module-scoped `let`s the dialog can no longer
    // reach. Each one has an inert default (`() => null`, `() => []`, a rejected
    // POST), so a member wired to the WRONG `let` degrades SILENTLY: the
    // suggestion chips lose the page's outgoing links, the "Continue …" chip loses
    // the session, the escalate bar stops repainting — and tsc sees a well-typed
    // object. (A member DROPPED from the literal is caught by tsc: all six are
    // required on `ChatOptionsDeps`. The mis-wire is the silent half this pins.)
    const src = await browserSrc();
    const at = src.indexOf("initChatOptions({");
    expect(at).toBeGreaterThan(-1);
    const literal = src.slice(at, src.indexOf("});", at));
    expect(literal).toMatch(/getShownTurn:\s*\(\)\s*=>\s*askShownTurn\b/);
    expect(literal).toMatch(/getAskTurns:\s*\(\)\s*=>\s*askTurns\b/);
    expect(literal).toMatch(/getCurrentArticle:\s*\(\)\s*=>\s*currentArticle\b/);
    expect(literal).toMatch(/getOutgoingTitles:\s*\(\)\s*=>\s*currentOutgoingTitles\b/);
    // The last two are the shell's own functions, passed by shorthand.
    expect(literal).toMatch(/postAskChat(,|:\s*postAskChat\b)/);
    expect(literal).toMatch(/refreshChatEscalateBar(,|:\s*refreshChatEscalateBar\b)/);
  });
});
