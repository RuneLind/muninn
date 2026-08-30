import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import {
  closeChatOptionsIfNavigatingAway,
  initChatOptions,
  type ChatOptTurn,
} from "./wiki-chat-options.ts";
import { CHAT_OPT_ESC_CONFIRM } from "./wiki-chat-target.ts";

/**
 * The repo has no browser test env (no jsdom/happy-dom), so — like the sibling
 * `wiki-start-cards.test.ts` / `wiki-factcheck-reader.test.ts` — the DOM here is a
 * minimal hand-rolled shim and the real render path is left to
 * `e2e/wiki-chat-dialog.spec.ts`.
 *
 * The shim diverges from a real document in exactly two ways, both deliberate and
 * both what makes this file assertable at all:
 *   • the panel's markup is an opaque STRING (nothing parses `innerHTML`), so the
 *     ids the dialog addresses inside its own panel — the question box, the thread
 *     name field — are pre-registered as INDEPENDENT elements, and `querySelector`
 *     hands out one stub per selector. On the live page those nodes come from the
 *     markup; behaviourally "a slot the dialog writes into" models it.
 *   • `closest()` matches the element itself only (no ancestor walk). Every target
 *     the delegate tests for is the button/chip itself in these cases.
 *
 * What is locked here is precisely what the extraction moved: that the module's
 * OWN document listeners are registered by `initChatOptions` (nothing else wires
 * them), that all four openers still reach the same panel through those listeners,
 * that the port — not a shared `let` — is what supplies the shown turn, the Ask
 * session and the open article, and that the Escape/tab/navigation rules survive
 * the move. The dialog's DERIVED strings (labels, defaults, thread-name preview)
 * are `wiki-chat-target.test.ts`'s and are not re-asserted here.
 */

// ── Minimal DOM ───────────────────────────────────────────────────────────────

class ShimEl {
  tagName = "DIV";
  className = "";
  innerHTML = "";
  value = "";
  disabled = false;
  scrollTop = 0;
  offsetParent: unknown = {};
  attached = true;
  focusCount = 0;
  lastFocusOpts: unknown = undefined;
  selection: [number, number] | null = null;
  attrs: Record<string, string> = {};
  /** Stubs handed out by `querySelector`, one per selector, created on demand. */
  parts = new Map<string, ShimEl>();
  /** What `querySelectorAll` answers (the tab trap's focusable list). */
  focusables: ShimEl[] = [];
  #id = "";

  constructor(id = "") {
    this.id = id;
  }

  get id(): string {
    return this.#id;
  }
  set id(next: string) {
    if (this.#id) registry.delete(this.#id);
    this.#id = next;
    if (next) registry.set(next, this);
  }

  focus(opts?: unknown): void {
    this.focusCount++;
    this.lastFocusOpts = opts;
    doc.activeElement = this;
  }
  setSelectionRange(start: number, end: number): void {
    this.selection = [start, end];
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return k in this.attrs ? this.attrs[k]! : null;
  }
  remove(): void {
    this.attached = false;
    if (this.#id) registry.delete(this.#id);
  }
  contains(el: unknown): boolean {
    return el === this || this.focusables.includes(el as ShimEl);
  }
  querySelector(sel: string): ShimEl | null {
    let part = this.parts.get(sel);
    if (!part) {
      part = new ShimEl();
      this.parts.set(sel, part);
    }
    return part;
  }
  querySelectorAll(): ShimEl[] {
    return this.focusables;
  }
  /** Self-match only — `#id` and `[attr]` selectors, the two the delegate uses. */
  closest(sel: string): ShimEl | null {
    if (sel.startsWith("#")) return this.id === sel.slice(1) ? this : null;
    if (sel.startsWith("[") && sel.endsWith("]")) {
      return sel.slice(1, -1) in this.attrs ? this : null;
    }
    return null;
  }
}

const registry = new Map<string, ShimEl>();
const handlers: Record<string, ((e: unknown) => void)[]> = {};

const doc = {
  activeElement: null as ShimEl | null,
  body: { appendChild: (_el: ShimEl) => {} },
  getElementById: (id: string): ShimEl | null => registry.get(id) ?? null,
  createElement: (): ShimEl => new ShimEl(),
  contains: (el: unknown): boolean => !!el && (el as ShimEl).attached !== false,
  addEventListener: (type: string, fn: (e: unknown) => void): void => {
    (handlers[type] ??= []).push(fn);
  },
};

function fire(type: string, event: Record<string, unknown>): void {
  for (const fn of handlers[type] ?? []) fn({ preventDefault: () => {}, ...event });
}
/** One tick past every await in `loadChatTarget`. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ── The shell port ────────────────────────────────────────────────────────────

type FakeTurn = ChatOptTurn;

const committedTurn: FakeTurn = {
  question: "How does the gardener cluster?",
  answer: "It clusters summaries into proposals.",
  citations: [{ title: "Wiki gardener", pageName: "Wiki gardener" }],
};
const declinedTurn: FakeTurn = {
  question: 'Explain: "the drain offers a bounded batch"',
  answer: "",
  citations: [],
  declined: "no_hits",
  explainPage: "Backlog drain",
};

const article = {
  name: "Wiki gardener",
  title: "Wiki gardener",
  relPath: "concepts/wiki-gardener.md",
  description: "How clustering works.",
  updated: "2026-07-30",
};

let shownTurn: FakeTurn | null = null;
let currentArticle: typeof article | null = null;
const fetched: string[] = [];
/** Per-test additions to the chat-target response (ok-path `bots`, `isJiraBot`). */
let chatTargetExtra: Record<string, unknown> = {};
/** When true, the next chat-target fetches answer 500 — the override-recovery path. */
let fetchFails = false;

const CHAT_TARGET = {
  botName: "jarvis",
  users: [{ id: "u1", name: "rune" }],
  defaultUserId: "u1",
  preferredForUserId: "u1",
  preferredConnectorId: null,
  connectors: [{ id: "c1", name: "sonnet", connectorType: "claude-cli", supportsWebTools: true }],
  botDefault: { connectorType: "claude-cli", supportsWebTools: true },
};

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.__WIKI_NAME__ = "probe";
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
  };
  g.fetch = (url: string) => {
    fetched.push(url);
    if (fetchFails) {
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "boom" }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...CHAT_TARGET, ...chatTargetExtra }),
    });
  };
  // The ONE call that wires the module's document listeners — everything below
  // reaches the dialog through them, exactly as the reader page does.
  initChatOptions({
    getShownTurn: () => shownTurn,
    getAskTurns: () => (shownTurn ? [shownTurn] : []),
    getCurrentArticle: () => currentArticle,
    getOutgoingTitles: () => ["Backlog drain"],
    postAskChat: () => Promise.resolve({ status: 200, ok: true, data: { chatUrl: "/chat?x=1" } }),
    refreshChatEscalateBar: () => {},
  });
});

beforeEach(() => {
  // Close anything a previous case left open (the click-away path), then reset the
  // page's own elements. The listeners are NOT re-registered — one wiring per page.
  fire("keydown", { key: "Escape" });
  fire("keydown", { key: "Escape" });
  registry.clear();
  fetched.length = 0;
  chatTargetExtra = {};
  fetchFails = false;
  shownTurn = null;
  currentArticle = null;
  doc.activeElement = null;
  new ShimEl("wikiAskInput");
  new ShimEl("wikiChatOptQ");
  new ShimEl("wikiChatOptName");
});

function panel(): ShimEl {
  const el = registry.get("wikiChatOpt");
  if (!el) throw new Error("no dialog is open");
  return el;
}

// ── Opening, in each mode ─────────────────────────────────────────────────────

describe("the chat-options dialog opens through its own click delegate", () => {
  test("direct: New chat prefills from the Ask box and focuses the question", async () => {
    registry.get("wikiAskInput")!.value = "  half-written thought  ";
    fire("click", { target: new ShimEl("wikiNewChatBtn") });

    const p = panel();
    expect(p.className).toBe("wiki-chatopt");
    expect(p.attrs["aria-modal"]).toBe("true");
    expect(p.attrs.role).toBe("dialog");
    expect(registry.has("wikiChatOptScrim")).toBe(true);
    expect(p.innerHTML).toContain("New chat from this wiki");
    // Prefilled ONCE, trimmed, into the dialog's own field…
    expect(p.innerHTML).toContain("half-written thought");
    // …and the Ask box is left exactly as it was.
    expect(registry.get("wikiAskInput")!.value).toBe("  half-written thought  ");
    // First paint puts the caret in the question box, without scrolling.
    const box = registry.get("wikiChatOptQ")!;
    expect(box.focusCount).toBe(1);
    expect(box.lastFocusOpts).toEqual({ preventScroll: true });

    // The one prefill fetch, on the active wiki — the module derives `?wiki=`
    // itself now, so an un-wired shell can't send it to the default wiki.
    await settle();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toBe("/api/wiki/chat-target?wiki=probe");
    // The target landed and the panel re-rendered from it: the summary line now
    // reports the resolved user + model, and Send is live.
    const resolved = panel().innerHTML;
    expect(resolved).toContain("as <b>rune</b>");
    expect(resolved).toContain("Bot default (claude-cli)");
    expect(resolved).toContain('id="wikiChatOptSend"');
    expect(resolved).not.toContain("Working out where this chat lands");
  });

  test("escalate: the ⚙ acts on the SHOWN turn, read-only", () => {
    shownTurn = committedTurn;
    fire("click", { target: new ShimEl("wikiChatEscOptBtn") });

    const html = panel().innerHTML;
    expect(html).toContain("Continue in chat");
    // The escalate question rides the POST with its answer + citations, so it is
    // pinned rather than editable.
    expect(html).toContain("wiki-chatopt-pinned");
    expect(html).toContain("How does the gardener cluster?");
  });

  test("escalate: no committed turn ⇒ no dialog at all", () => {
    shownTurn = null;
    fire("click", { target: new ShimEl("wikiChatEscOptBtn") });
    expect(registry.has("wikiChatOpt")).toBe(false);

    // …and neither does an uncommitted (answer-less) one.
    shownTurn = { question: "still streaming", answer: "", citations: [] };
    fire("click", { target: new ShimEl("wikiChatEscOptBtn") });
    expect(registry.has("wikiChatOpt")).toBe(false);
  });

  test("article: Discuss reads the open page through the port", () => {
    currentArticle = article;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });

    const html = panel().innerHTML;
    expect(html).toContain("Discuss this article");
    expect(html).toContain("Wiki gardener");
    expect(html).toContain("How clustering works.");
    // Always an EMPTY question box (the description is a hint, never a prefill)
    // plus page-derived starter chips, one of them naming the outgoing link.
    expect(html).toContain("Ask about this page");
    expect(html).toContain("Backlog drain");

    // No page open ⇒ no-op.
    fire("keydown", { key: "Escape" });
    currentArticle = null;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });
    expect(registry.has("wikiChatOpt")).toBe(false);
  });

  test("decline: the question is COMPOSED from the declined turn and pinned", () => {
    shownTurn = declinedTurn;
    fire("click", { target: new ShimEl("wikiChatDeclineBtn") });

    const html = panel().innerHTML;
    expect(html).toContain("wiki-chatopt-pinned");
    // The Explain label alone names neither the page nor the real question.
    expect(html).toContain("Backlog drain");
    expect(html).toContain("the drain offers a bounded batch");

    // A turn that was ANSWERED offers no decline opener.
    fire("keydown", { key: "Escape" });
    shownTurn = committedTurn;
    fire("click", { target: new ShimEl("wikiChatDeclineBtn") });
    expect(registry.has("wikiChatOpt")).toBe(false);
  });
});

// ── Escape, Tab, navigation ───────────────────────────────────────────────────

describe("the dialog's keyboard and navigation rules", () => {
  test("Escape confirms a TYPED question, typing disarms it, the second closes", () => {
    fire("click", { target: new ShimEl("wikiNewChatBtn") });
    const box = registry.get("wikiChatOptQ")!;
    box.value = "a question worth keeping";
    fire("input", { target: box });

    fire("keydown", { key: "Escape" });
    expect(registry.has("wikiChatOpt")).toBe(true);
    // Repainted in place — the status slot, not a whole re-render.
    expect(panel().querySelector("#wikiChatOptStatus")!.innerHTML).toContain(CHAT_OPT_ESC_CONFIRM);

    // Typing takes the arming back off, so a stale "press Esc again" can't discard
    // a question the reader had gone back to editing.
    box.value = "a question worth keeping, edited";
    fire("input", { target: box });
    expect(panel().querySelector("#wikiChatOptStatus")!.innerHTML).not.toContain(
      CHAT_OPT_ESC_CONFIRM,
    );

    fire("keydown", { key: "Escape" });
    expect(registry.has("wikiChatOpt")).toBe(true);
    fire("keydown", { key: "Escape" });
    expect(registry.has("wikiChatOpt")).toBe(false);
    // The scrim goes with it — left behind it would swallow every click.
    expect(registry.has("wikiChatOptScrim")).toBe(false);
  });

  test("a PREFILLED question is reproducible, so Escape closes at once", () => {
    registry.get("wikiAskInput")!.value = "a draft";
    fire("click", { target: new ShimEl("wikiNewChatBtn") });
    fire("keydown", { key: "Escape" });
    expect(registry.has("wikiChatOpt")).toBe(false);
  });

  test("Tab wraps at both ends and pulls escaped focus back in", () => {
    fire("click", { target: new ShimEl("wikiNewChatBtn") });
    const p = panel();
    const first = new ShimEl("first");
    const last = new ShimEl("last");
    p.focusables = [first, last];

    // Focus outside the dialog comes back to the top…
    doc.activeElement = new ShimEl("somewhere-else");
    fire("keydown", { key: "Tab" });
    expect(doc.activeElement).toBe(first);

    // …the end wraps to the start…
    doc.activeElement = last;
    fire("keydown", { key: "Tab" });
    expect(doc.activeElement).toBe(first);

    // …and Shift+Tab at the start wraps to the end.
    doc.activeElement = first;
    fire("keydown", { key: "Tab", shiftKey: true });
    expect(doc.activeElement).toBe(last);
  });

  test("navigating to another page closes an ARTICLE dialog — and only that", () => {
    currentArticle = article;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });

    // Re-rendering the breadcrumb for the SAME page is not a navigation.
    closeChatOptionsIfNavigatingAway(article.relPath);
    expect(registry.has("wikiChatOpt")).toBe(true);

    closeChatOptionsIfNavigatingAway("concepts/backlog-drain.md");
    expect(registry.has("wikiChatOpt")).toBe(false);

    // A direct-mode dialog is about no page, so navigation leaves it alone.
    fire("click", { target: new ShimEl("wikiNewChatBtn") });
    closeChatOptionsIfNavigatingAway("concepts/backlog-drain.md");
    expect(registry.has("wikiChatOpt")).toBe(true);
  });
});

// ── Resolved-wiki bot override + Jira chip ────────────────────────────────────

/** A click target standing in for the ⚙ Options toggle INSIDE the panel: the
 *  shim's `closest` is self-match only, so it answers both the toggle's id and
 *  the click-away's `#wikiChatOpt` in-panel probe. */
function advToggleTarget(): ShimEl {
  const el = new ShimEl("wikiChatOptAdv");
  (el as unknown as { closest: (sel: string) => ShimEl | null }).closest = (sel: string) =>
    sel === "#wikiChatOptAdv" || sel === "#wikiChatOpt" ? el : null;
  return el;
}

describe("the ok-path bot list feeds an override, never the mandatory picker", () => {
  const THREE_BOTS = [{ name: "jarvis" }, { name: "vertex-test" }, { name: "melosys" }];

  test("a resolved wiki with >1 bot reports the bot in the summary and offers the picker in ⚙", async () => {
    chatTargetExtra = { bots: THREE_BOTS };
    currentArticle = article;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });
    await settle();

    const html = panel().innerHTML;
    // The collapsed line names the bot FIRST — a re-pointed escalation must be
    // visible without expanding anything.
    expect(html).toContain("bot <b>jarvis</b>");
    // The mandatory needs-a-bot picker (with its empty "Pick a bot…" row) must
    // NOT appear: the wiki resolved.
    expect(html).not.toContain("Pick a bot…");

    // The override lives behind ⚙ Options. The shim's `closest` matches self
    // only, so the ⚙ target also answers the click-away's `#wikiChatOpt` probe —
    // on the live page the button IS inside the panel.
    fire("click", { target: advToggleTarget() });
    const open = panel().innerHTML;
    expect(open).toContain('id="wikiChatOptBot"');
    expect(open).toContain("vertex-test");
  });

  test("picking another bot refetches the target bot-keyed", async () => {
    chatTargetExtra = { bots: THREE_BOTS };
    currentArticle = article;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });
    await settle();
    fetched.length = 0;

    const sel = new ShimEl("wikiChatOptBot");
    sel.value = "vertex-test";
    fire("change", { target: sel });
    await settle();
    expect(fetched[0]).toBe("/api/wiki/chat-target?wiki=probe&bot=vertex-test");
  });

  test("the MANDATORY needs-a-bot picker still offers the empty row", async () => {
    // Round-2 pin: every other assertion on "Pick a bot…" is NEGATIVE, so
    // deleting the ternary that renders it stayed green (verify pass, mutation
    // D). Without the empty row an unresolved wiki opens with the first bot
    // DISPLAYED as picked while `state.botName` is "" — Send blocked, and no
    // `change` event can ever fire for that bot.
    chatTargetExtra = { botName: null, reason: "needs_bot", bots: THREE_BOTS };
    currentArticle = article;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });
    await settle();
    const html = panel().innerHTML;
    expect(html).toContain('id="wikiChatOptBot"');
    expect(html).toContain('<option value="">Pick a bot…</option>');
  });

  test("a FAILED override refetch keeps a picker — with no dead-end empty row", async () => {
    // Finding 1+2 of the PR review: the recovery picker rendered the mandatory
    // path's empty "Pick a bot…" option, and selecting it cleared the error and
    // the pick, leaving a body with no picker, no summary and no Send.
    chatTargetExtra = { bots: THREE_BOTS };
    currentArticle = article;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });
    await settle();

    fetchFails = true;
    const sel = new ShimEl("wikiChatOptBot");
    sel.value = "vertex-test";
    fire("change", { target: sel });
    await settle();

    const html = panel().innerHTML;
    expect(html).toContain("work out where this chat would go"); // apostrophe is esc()'d
    // The way back stays on screen…
    expect(html).toContain('id="wikiChatOptBot"');
    // …and offers only REAL bots: this path always has a current pick, so the
    // empty option is exactly a dead end here.
    expect(html).not.toContain("Pick a bot…");
  });

  test("the pick that started an override refetch stays on screen while it resolves", async () => {
    // Finding 3: the change handler nulls the target, so the loading body used to
    // drop the very <select> the reader just operated (and its focus with it).
    chatTargetExtra = { bots: THREE_BOTS };
    currentArticle = article;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });
    await settle();

    const sel = new ShimEl("wikiChatOptBot");
    sel.value = "vertex-test";
    fire("change", { target: sel });
    // BEFORE the fetch resolves: the loading paint must keep the picker.
    const html = panel().innerHTML;
    expect(html).toContain("Working out where this chat lands");
    expect(html).toContain('id="wikiChatOptBot"');
    await settle();
  });

  test("a single-bot install renders neither the bot line nor the picker", async () => {
    // The default CHAT_TARGET ships no `bots` — the pre-override wire shape.
    currentArticle = article;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });
    await settle();
    const html = panel().innerHTML;
    expect(html).not.toContain("bot <b>");
    fire("click", { target: advToggleTarget() });
    expect(panel().innerHTML).not.toContain('id="wikiChatOptBot"');
  });

  test("the Draft Jira task chip appears exactly when the target says isJiraBot", async () => {
    chatTargetExtra = { isJiraBot: true };
    currentArticle = article;
    fire("click", { target: new ShimEl("wikiDiscussBtn") });
    // Before the target lands the chip is absent (the flag is server-derived)…
    expect(panel().innerHTML).not.toContain("Draft Jira task");
    await settle();
    // …and the re-render on load adds it.
    expect(panel().innerHTML).toContain("Draft Jira task");
  });
});
