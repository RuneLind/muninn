/**
 * The share flow's WIRE CONTRACT — the handful of values the route, the browser
 * dialog and the tests must all agree on.
 *
 * It is its own module, and dependency-free on purpose: the dialog is bundled for
 * the browser (`share-dialog-browser.ts`), so anything it imports is pulled into
 * that bundle. `presets.ts` is IO-free but reaches for `bots/config.ts` types;
 * `prompt.ts` reaches for the body-prep chain and the wiki store. Neither belongs
 * in a browser bundle, and neither is needed to state a cap or name a language.
 */

/** The two languages a share post can be written in. */
export type ShareLang = "en" | "nb";

/** Picker order + labels. `nb` is spelled the way the reader picks it, not the
 *  way the code spells it — "Norsk (bokmål)", never "nb". */
export const SHARE_LANGS: readonly { id: ShareLang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "nb", label: "Norsk (bokmål)" },
];

export function isShareLang(value: unknown): value is ShareLang {
  return value === "en" || value === "nb";
}

/**
 * Cap on a reader-EDITED prompt (chars).
 *
 * Sized well above the longest shipped preset (~1.2k) so a reader who rewrites one
 * wholesale is never stopped, and small enough that the field can't be used to
 * post a document. Over-cap is a **400, never a truncation**: a silently shortened
 * prompt changes what the model was asked without telling anyone, and the reader
 * would read the result as an answer to the instruction they wrote.
 */
export const SHARE_PROMPT_OVERRIDE_MAX = 8_000;

/** Cap on the free-text `extra` steer ("focus on the security angle"). Same
 *  400-not-truncate rule, same reason. */
export const SHARE_EXTRA_MAX = 2_000;

/**
 * The length at which a Slack PASTE stops being a message.
 *
 * Slack converts a paste longer than ~4000 characters into a file snippet, which
 * collapses in the channel and is read by nobody — so a post over this is a
 * delivery failure, not a long message. The dialog warns on it (client-side, at
 * render time, over the SERVER-rendered mrkdwn — the exact bytes that get pasted).
 * The `slack-dev-security` preset asks the model for <1200 chars; this is the
 * backstop for the presets that don't, and for a model that ignored the budget.
 */
export const SLACK_PASTE_MAX = 4_000;

/**
 * The `done` payload: three server-rendered strings, one per format tab.
 *
 * Telegram is deliberately absent (product decision, 2026-08-11) — there is no
 * Telegram tab in v1 and no send action, so shipping a fourth string nothing
 * renders would be a contract nobody honours.
 */
export interface ShareDonePayload {
  /** The model's own markdown — the source every other string is rendered from. */
  markdown: string;
  /** Slack mrkdwn (`formatSlackMrkdwn`). */
  slack: string;
  /** Email body HTML with inline styles (`formatEmailHtml`). */
  mailHtml: string;
}
