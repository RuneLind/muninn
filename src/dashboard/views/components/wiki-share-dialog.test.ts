import { test, expect, describe } from "bun:test";
import {
  canGenerate,
  copyPayloadFor,
  promptIsEdited,
  shareBlockingError,
  shareCapError,
  shareConflictCopy,
  shareCopyOf,
  shareDialogHtml,
  sharePromptError,
  shareRequestBody,
  shareResultHtml,
  shouldCloseShareDialog,
  slackLengthWarning,
  shareLangChipId,
  shareTabId,
  shareTargetOf,
  summaryShareTarget,
  summaryShareTargetScript,
  wikiShareTarget,
  SUMMARY_SHARE_COPY,
  WIKI_SHARE_COPY,
  SHARE_PRESET_RETRY_ID,
  SHARE_PROMPT_TOGGLE_ID,
  SHARE_TABS,
  type ShareDialogState,
  type SharePresetOption,
} from "./wiki-share-dialog.ts";
import { escJsonScript } from "./escape.ts";
import {
  SHARE_LANGS,
  SLACK_PASTE_MAX,
  SHARE_EXTRA_MAX,
  SHARE_PROMPT_OVERRIDE_MAX,
} from "../../../share/wire.ts";

const PRESETS: SharePresetOption[] = [
  { id: "default", label: "Default", content: "Summarize the source." },
  { id: "slack-dev-security", label: "Slack · dev + security", content: "Slack post prompt." },
];

function state(over: Partial<ShareDialogState> = {}): ShareDialogState {
  return {
    wiki: "mimir",
    page: "Wiki gardener",
    title: "Wiki gardener",
    presets: PRESETS,
    presetId: "default",
    lang: "en",
    prompt: "Summarize the source.",
    extra: "",
    promptOpen: false,
    running: false,
    streamed: "",
    result: null,
    tab: "slack",
    ...over,
  };
}

const RESULT = { markdown: "# Post\n\nBody.", slack: "*Post*\n\nBody.", mailHtml: "<h2>Post</h2>" };

/** `shareDialogHtml` takes `now` as a parameter — the pure half never reads the
 *  clock (the `wiki-filter.ts` rule). Fixed here so the 409 countdown is stable. */
const NOW = 1_000_000;
const html = (s: ShareDialogState, slackHtml = ""): string => shareDialogHtml(s, slackHtml, NOW);

describe("the POST body", () => {
  test("carries the preset ID and the language, and NO promptOverride when unedited", () => {
    const body = shareRequestBody(state());
    expect(body).toEqual({ wiki: "mimir", page: "Wiki gardener", preset: "default", lang: "en" });
  });

  test("`page` is the page NAME the route resolves with index.resolve", () => {
    // Not a relPath: a relPath carries directories and an extension, and the
    // reader's client never holds one for the open page.
    expect(shareRequestBody(state({ page: "Nested Concept" })).page).toBe("Nested Concept");
  });

  test("an EDITED prompt rides along; whitespace-only differences do not", () => {
    expect(shareRequestBody(state({ prompt: "Write two bullets." })).promptOverride).toBe(
      "Write two bullets.",
    );
    expect(shareRequestBody(state({ prompt: "  Summarize the source.\n" })).promptOverride).toBe(
      undefined,
    );
  });

  test("a blank extra is omitted rather than sent as an empty string", () => {
    expect(shareRequestBody(state({ extra: "   " })).extra).toBeUndefined();
    expect(shareRequestBody(state({ extra: " focus on risk " })).extra).toBe("focus on risk");
  });

  test("a TARGET replaces the identity fields — and only those", () => {
    // The /summaries surface shares a capture document, identified by
    // `{source, docId}`; everything the share layer itself owns (preset, lang,
    // the two optional text fields) is unchanged.
    const body = shareRequestBody(
      state({
        target: summaryShareTarget("x-article", "ai/x/Some Post.md"),
        extra: "keep it short",
      }),
    );
    expect(body).toEqual({
      source: "x-article",
      docId: "ai/x/Some Post.md",
      preset: "default",
      lang: "en",
      extra: "keep it short",
    });
    // …and no trace of the wiki surface's own fields.
    expect(body.wiki).toBeUndefined();
    expect(body.page).toBeUndefined();
  });

  test("promptIsEdited is false while the preset list is still loading", () => {
    expect(promptIsEdited(state({ presets: null, prompt: "anything" }))).toBe(false);
  });
});

describe("caps are refused where the reader typed them", () => {
  test("an over-cap prompt or extra names the limit and blocks Generate", () => {
    const overPrompt = state({ prompt: "x".repeat(SHARE_PROMPT_OVERRIDE_MAX + 1) });
    expect(shareCapError(overPrompt)).toContain(String(SHARE_PROMPT_OVERRIDE_MAX));
    expect(canGenerate(overPrompt)).toBe(false);
    const overExtra = state({ extra: "x".repeat(SHARE_EXTRA_MAX + 1) });
    expect(shareCapError(overExtra)).toContain(String(SHARE_EXTRA_MAX));
    expect(canGenerate(overExtra)).toBe(false);
  });

  test("exactly at the cap is fine", () => {
    expect(shareCapError(state({ extra: "x".repeat(SHARE_EXTRA_MAX) }))).toBeNull();
  });

  test("Generate is blocked while running and while no preset resolved", () => {
    expect(canGenerate(state({ running: true }))).toBe(false);
    expect(canGenerate(state({ presetId: "gone" }))).toBe(false);
    expect(canGenerate(state())).toBe(true);
  });
});

describe("the Slack length budget", () => {
  test("nothing is said while the post fits", () => {
    expect(slackLengthWarning("x".repeat(SLACK_PASTE_MAX))).toBeNull();
  });

  test("over the budget it names the length and says what to do", () => {
    const warn = slackLengthWarning("x".repeat(SLACK_PASTE_MAX + 1))!;
    expect(warn).toContain(String(SLACK_PASTE_MAX + 1));
    expect(warn).toContain("snippet");
  });

  test("it is measured on the SLACK rendering, not the markdown", () => {
    // The two differ (headings become bold lines, links become `<url|label>`), and
    // the paste is the slack string — so the warning renders off `result.slack`.
    const slack = "x".repeat(SLACK_PASTE_MAX + 50);
    const html = shareResultHtml(state({ result: { ...RESULT, slack }, tab: "slack" }), "<p>x</p>");
    expect(html).toContain("wiki-share-warn");
    const short = shareResultHtml(state({ result: RESULT, tab: "slack" }), "<p>x</p>");
    expect(short).not.toContain("wiki-share-warn");
  });

  test("the warning is a SLACK-tab concern only", () => {
    const slack = "x".repeat(SLACK_PASTE_MAX + 50);
    const md = shareResultHtml(state({ result: { ...RESULT, slack }, tab: "markdown" }), "");
    expect(md).not.toContain("wiki-share-warn");
  });
});

describe("tabs and copy", () => {
  test("the tab set is Slack | Email | Markdown — no Telegram in v1", () => {
    expect(SHARE_TABS.map((t) => t.id)).toEqual(["slack", "email", "markdown"]);
    const html = shareResultHtml(state({ result: RESULT }), "");
    expect(html).not.toContain("Telegram");
  });

  test("only the email tab copies rich text; the others are plain", () => {
    expect(copyPayloadFor("slack", RESULT)).toEqual({ text: RESULT.slack });
    expect(copyPayloadFor("markdown", RESULT)).toEqual({ text: RESULT.markdown });
    expect(copyPayloadFor("email", RESULT)).toEqual({
      text: RESULT.markdown,
      html: RESULT.mailHtml,
    });
  });

  test("the copy button reports the copy back", () => {
    expect(shareResultHtml(state({ result: RESULT }), "")).toContain("Copy Slack");
    expect(shareResultHtml(state({ result: RESULT, copied: true }), "")).toContain("✓ Copied");
  });
});

describe("an EMPTIED prompt is refused, never a silent fall back to the preset", () => {
  // Blanking the textarea makes `promptIsEdited` true, so the POST carries
  // `promptOverride: ""` — which the route used to read as "no override" and run
  // the preset instruction while the screen showed an empty box.
  const blank = state({ prompt: "   " });

  test("it blocks Generate and says so", () => {
    expect(sharePromptError(blank)).toContain("empty");
    expect(shareBlockingError(blank)).toBe(sharePromptError(blank));
    expect(canGenerate(blank)).toBe(false);
    expect(html(blank)).toContain("The prompt is empty");
  });

  test("a cap error still wins the status line", () => {
    const both = state({ prompt: "", extra: "x".repeat(SHARE_EXTRA_MAX + 1) });
    expect(shareBlockingError(both)).toBe(shareCapError(both));
  });

  test("no preset resolved yet has its OWN copy, not this one", () => {
    expect(sharePromptError(state({ presetId: "gone", prompt: "" }))).toBeNull();
  });

  test("the result pane's Regenerate is disabled by the SAME derivation", () => {
    // `generate()` early-returns on `!canGenerate`, so gating this button on
    // `running` alone made an over-cap or emptied prompt a silent no-op click.
    const ok = shareResultHtml(state({ result: RESULT }), "");
    expect(/id="wikiShareGen"(?![^>]*disabled)/.test(ok)).toBe(true);
    for (const bad of [
      state({ result: RESULT, prompt: "" }),
      state({ result: RESULT, extra: "x".repeat(SHARE_EXTRA_MAX + 1) }),
      state({ result: RESULT, running: true }),
    ]) {
      expect(/id="wikiShareGen"[^>]*disabled/.test(shareResultHtml(bad, ""))).toBe(true);
    }
  });
});

describe("the dialog markup", () => {
  test("loading state says so, and a failed preset load says what went wrong", () => {
    expect(html(state({ presets: null }))).toContain("Loading presets…");
    const failed = html(state({ presets: null, error: "huginn is down" }));
    expect(failed).toContain("huginn is down");
  });

  test("a FAILED preset load offers a Retry — the loading branch is otherwise a dead end", () => {
    expect(html(state({ presets: null, error: "huginn is down" }))).toContain(
      SHARE_PRESET_RETRY_ID,
    );
    // …and the still-loading branch does not.
    expect(html(state({ presets: null }))).not.toContain(SHARE_PRESET_RETRY_ID);
  });

  test("the prompt panel is visible, editable and flagged once edited", () => {
    const clean = html(state());
    expect(clean).toContain('id="wikiSharePrompt"');
    expect(clean).not.toContain("wiki-share-edited");
    const edited = html(state({ prompt: "Mine." }));
    expect(edited).toContain("wiki-share-edited");
    expect(edited).toContain('id="wikiSharePromptReset"');
  });

  test("every focusable control carries a deterministic id — the focus contract, not decoration", () => {
    // `captureFocus`/`restoreFocus` re-find the focused element BY ID across the
    // wholesale innerHTML swap. Id-less chips escaped focus to `<body>`, outside a
    // panel that claims `aria-modal="true"`.
    const langs = html(state());
    for (const l of SHARE_LANGS) expect(langs).toContain(`id="${shareLangChipId(l.id)}"`);
    const tabs = shareResultHtml(state({ result: RESULT }), "");
    for (const t of SHARE_TABS) expect(tabs).toContain(`id="${shareTabId(t.id)}"`);
    // The prompt disclosure's `<summary>` is focusable too, and was the last
    // id-less control: a repaint while it held focus (the 1s 409 countdown, a
    // stream frame) sent the reader to `#wikiShareClose`, the destructive button.
    expect(langs).toContain(`<summary id="${SHARE_PROMPT_TOGGLE_ID}">`);
  });

  test("no focusable control in the panel is left without an id", () => {
    // The rule above, enforced over the WHOLE rendered panel rather than the three
    // controls someone remembered — a control added later without an id reopens
    // exactly the bug, and every existing assertion keeps passing.
    const panels = [
      html(state()),
      html(state({ prompt: "Mine." })), // adds "Reset to preset"
      shareResultHtml(state({ result: RESULT }), "<p>x</p>"),
      html(state({ presets: null, error: "huginn is down" })), // adds Retry
    ];
    for (const panel of panels) {
      for (const tag of panel.matchAll(/<(button|select|textarea|input|summary)\b[^>]*>/g)) {
        expect(tag[0]).toMatch(/\sid="/);
      }
    }
  });

  test("the live pane streams while running and gives way to the tabs on a result", () => {
    const streaming = html(state({ running: true, streamed: "# Half a p" }));
    expect(streaming).toContain("wiki-share-live");
    expect(streaming).toContain("Generating…");
    expect(streaming).not.toContain("wiki-share-tabs");
    const done = html(state({ streamed: "x", result: RESULT }), "<p>x</p>");
    expect(done).toContain("wiki-share-tabs");
    expect(done).not.toContain("wiki-share-live");
  });

  test("a REGENERATE shows the live stream over the kept result, and the result survives a failure", () => {
    // `generate()` no longer nulls `result`, so `running` has to outrank it in the
    // render — otherwise the reader watches a stale post while a new one streams.
    const rerunning = html(
      state({ running: true, streamed: "# New", result: RESULT }),
      "<p>x</p>",
    );
    expect(rerunning).toContain("wiki-share-live");
    expect(rerunning).not.toContain("wiki-share-tabs");
    // …and when that run fails, the old tabs + Copy are back, beside the error.
    const failed = html(
      state({ running: false, streamed: "# New", result: RESULT, error: "The share failed." }),
      "<p>x</p>",
    );
    expect(failed).toContain("wiki-share-tabs");
    expect(failed).toContain("wikiShareCopy");
    expect(failed).toContain("The share failed.");
  });

  test("markup escapes the title, the prompt and the markdown pane", () => {
    const out = html(
      state({
        title: '<img src=x onerror="boom">',
        prompt: "<script>alert(1)</script>",
        result: { ...RESULT, markdown: "<script>alert(2)</script>" },
        tab: "markdown",
      }),
    );
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<script>");
  });
});

describe("dismissal and conflict copy", () => {
  test("a click inside the panel or on its opener never dismisses", () => {
    expect(shouldCloseShareDialog({ inPanel: true, inOpener: false, running: false })).toBe(false);
    expect(shouldCloseShareDialog({ inPanel: false, inOpener: true, running: false })).toBe(false);
  });

  test("an outside click dismisses — unless a generation is in flight", () => {
    expect(shouldCloseShareDialog({ inPanel: false, inOpener: false, running: false })).toBe(true);
    // The reader has already spent the call and the result lands in this panel
    // and nowhere else.
    expect(shouldCloseShareDialog({ inPanel: false, inOpener: false, running: true })).toBe(false);
  });

  test("the 409 copy renders the holder's deadline in readable units", () => {
    const now = 1_000_000;
    expect(shareConflictCopy(now + 30_000, now)).toContain("~30s");
    expect(shareConflictCopy(now + 150_000, now)).toContain("~3 min");
    // A deadline already past reads as "0s", never as a negative.
    expect(shareConflictCopy(now - 5_000, now)).toContain("~0s");
  });

  test("`now` is a PARAMETER of the render — the pure half never reads the clock", () => {
    // A `Date.now()` inside the render makes the countdown untestable and the
    // function impure (the `wiki-filter.ts` rule).
    const s = state({ conflictExpiresAtMs: NOW + 30_000 });
    expect(shareDialogHtml(s, "", NOW)).toContain("~30s");
    expect(shareDialogHtml(s, "", NOW + 20_000)).toContain("~10s");
  });
});

describe("share targets", () => {
  test("the DEFAULT target is the /wiki surface, derived from wiki+page", () => {
    // Additive seam: a state with no target must post exactly where PR B posted.
    expect(shareTargetOf(state())).toEqual(wikiShareTarget("mimir", "Wiki gardener"));
    expect(shareTargetOf(state()).endpoint).toBe("/api/wiki/share");
    expect(shareTargetOf(state()).presetsUrl).toBe("/api/wiki/share/presets?wiki=mimir");
  });

  test("the bare /wiki (no registered name) asks for the preset list unqualified", () => {
    expect(shareTargetOf(state({ wiki: "" })).presetsUrl).toBe("/api/wiki/share/presets");
  });

  test("a wiki name is URL-encoded into the preset query", () => {
    expect(wikiShareTarget("my wiki/x", "p").presetsUrl).toBe(
      "/api/wiki/share/presets?wiki=my%20wiki%2Fx",
    );
  });

  test("an explicit target wins over wiki+page", () => {
    const target = summaryShareTarget("youtube", "ai/Some Title.md");
    expect(shareTargetOf(state({ target }))).toBe(target);
    expect(target.endpoint).toBe("/api/summaries/share");
    // No `?wiki=` — the summaries preset list is resolved for the summarizer
    // bot, which is a server-side role, not a client-supplied one.
    expect(target.presetsUrl).toBe("/api/summaries/share/presets");
  });
});

describe("surface copy", () => {
  test("the /wiki wording is what a target-less state renders — unchanged", () => {
    expect(shareCopyOf(state())).toEqual(WIKI_SHARE_COPY);
    expect(shareDialogHtml(state({ presets: [] }), "", NOW)).toContain(
      "This wiki offers no share presets.",
    );
    expect(shareConflictCopy(NOW + 30_000, NOW)).toBe(
      "A share is already running for this page. It frees up in at most ~30s.",
    );
  });

  test("a /summaries state says document and archive, never page and wiki", () => {
    // The three strings that NAME the surface. Everything else in the dialog is
    // the same sentence on both, which is why only these three are carried.
    const target = summaryShareTarget("youtube", "ai/Some Title.md");
    const s = state({ target, presets: [] });
    const empty = shareDialogHtml(s, "", NOW);
    expect(empty).toContain("This archive offers no share presets.");
    // Not the /wiki sentence — asserted on the copy itself, since the markup is
    // full of legitimate `wiki-share-*` class names.
    expect(empty).not.toContain(WIKI_SHARE_COPY.noPresets);
    const conflict = shareDialogHtml(state({ target, conflictExpiresAtMs: NOW + 30_000 }), "", NOW);
    expect(conflict).toContain("A share is already running for this document.");
    expect(conflict).not.toContain("for this page");
    expect(shareCopyOf(s).stopped).toContain("The document stays reserved");
  });
});

describe("summaryShareTargetScript", () => {
  test("emits the builder's OWN keys, with only the two values substituted", () => {
    // The point of the seam: the /summaries page script cannot import, and
    // hand-writing `fields: { source, docId }` there gave the field names a
    // second spelling that nothing pinned. A rename of either key must move this
    // string too.
    const js = summaryShareTargetScript("_shareDoc.source", "_shareDoc.docId");
    expect(js).toContain('"endpoint":"/api/summaries/share"');
    expect(js).toContain('"source":_shareDoc.source');
    expect(js).toContain('"docId":_shareDoc.docId');
    // No sentinel survives, and the surface copy rides along.
    expect(js).not.toContain("slot__");
    expect(js).toContain("A share is already running for this document.");
    // It is a JS object EXPRESSION: evaluating it reproduces the builder.
    const evaluated = new Function(
      "_shareDoc",
      "return " + js,
    )({ source: "youtube", docId: "ai/Some Title.md" }) as unknown;
    expect(evaluated).toEqual(summaryShareTarget("youtube", "ai/Some Title.md"));
  });

  test("substitution is ONE pass — an argument spelling a sentinel is not re-substituted", () => {
    // Two sequential split/joins re-scanned the text the first pass inserted, so
    // an argument containing the OTHER slot's sentinel got rewritten by the
    // second — silently swapping the two identity values.
    const js = summaryShareTargetScript('"__share_doc_id_slot__"', "_d");
    const evaluated = new Function("_d", "return " + js)("real-doc") as {
      fields: { source: string; docId: string };
    };
    expect(evaluated.fields.source).toBe("__share_doc_id_slot__");
    expect(evaluated.fields.docId).toBe("real-doc");
  });

  test("no raw `<` survives — the string is interpolated into a page <script>", () => {
    // Weak by construction (nothing in the target carries a `<` today), so it is
    // only the wiring pin: the escape ITSELF is exercised below, on a value that
    // actually contains one. Deleting `escJsonScript` from the builder still
    // passes this assertion — hence the pair.
    expect(summaryShareTargetScript("_a", "_b")).not.toContain("<");
  });

  test("escJsonScript neutralizes `</script>` and round-trips byte-for-byte", () => {
    // The builder's escape, tested where it can FAIL: the day a copy string
    // carries a `<`, this is what stops `</script>` ending the block the target
    // is emitted into — while the value the page evaluates must stay identical
    // to the one that was serialized.
    const target = {
      ...summaryShareTarget("youtube", "ai/Some Title.md"),
      copy: {
        ...SUMMARY_SHARE_COPY,
        conflictLead: 'A share is running </script><script>alert("x")</script>',
      },
    };
    const js = escJsonScript(target);
    expect(js).not.toContain("<");
    expect(js).toContain("\\u003c/script>");
    expect(new Function("return " + js)()).toEqual(target);
  });
});
