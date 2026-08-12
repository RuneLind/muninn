import { test, expect, describe } from "bun:test";
import {
  canGenerate,
  copyPayloadFor,
  promptIsEdited,
  shareCapError,
  shareConflictCopy,
  shareDialogHtml,
  shareRequestBody,
  shareResultHtml,
  shouldCloseShareDialog,
  slackLengthWarning,
  SHARE_TABS,
  type ShareDialogState,
  type SharePresetOption,
} from "./wiki-share-dialog.ts";
import { SLACK_PASTE_MAX, SHARE_EXTRA_MAX, SHARE_PROMPT_OVERRIDE_MAX } from "../../../share/wire.ts";

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

describe("the dialog markup", () => {
  test("loading state says so, and a failed preset load says what went wrong", () => {
    expect(shareDialogHtml(state({ presets: null }))).toContain("Loading presets…");
    const failed = shareDialogHtml(state({ presets: null, error: "huginn is down" }));
    expect(failed).toContain("huginn is down");
  });

  test("the prompt panel is visible, editable and flagged once edited", () => {
    const clean = shareDialogHtml(state());
    expect(clean).toContain('id="wikiSharePrompt"');
    expect(clean).not.toContain("wiki-share-edited");
    const edited = shareDialogHtml(state({ prompt: "Mine." }));
    expect(edited).toContain("wiki-share-edited");
    expect(edited).toContain('id="wikiSharePromptReset"');
  });

  test("the live pane streams while running and gives way to the tabs on a result", () => {
    const streaming = shareDialogHtml(state({ running: true, streamed: "# Half a p" }));
    expect(streaming).toContain("wiki-share-live");
    expect(streaming).toContain("Generating…");
    expect(streaming).not.toContain("wiki-share-tabs");
    const done = shareDialogHtml(state({ streamed: "x", result: RESULT }), "<p>x</p>");
    expect(done).toContain("wiki-share-tabs");
    expect(done).not.toContain("wiki-share-live");
  });

  test("markup escapes the title, the prompt and the markdown pane", () => {
    const html = shareDialogHtml(
      state({
        title: '<img src=x onerror="boom">',
        prompt: "<script>alert(1)</script>",
        result: { ...RESULT, markdown: "<script>alert(2)</script>" },
        tab: "markdown",
      }),
      "",
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
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
});
