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

// ── Request-body validation, shared by every share surface ───────────────────

/** Which fields a surface's POST body carries. */
export interface ShareBodySpec {
  /**
   * EVERY client-supplied string field, in the order they are type-checked —
   * the surface's own identity fields AND the three the share layer owns
   * (`preset`, `promptOverride`, `extra`). Order is part of the contract: the
   * first offending field is the one reported.
   */
  stringFields: readonly string[];
  /** Fields that must be present and non-blank, in REPORT order. `preset` is one
   *  of them on every surface — it is spelled here, not special-cased, so the
   *  surface decides whether its own identity fields outrank it. */
  required: readonly string[];
}

/** The validated body: the share layer's four values plus the surface's own. */
export interface ParsedShareBody {
  /**
   * TRIMMED value of every declared field except `promptOverride`/`extra`
   * (absent ⇒ `""`). Those two are returned below and UNTRIMMED, because their
   * caps are measured on what the reader actually typed.
   */
  values: Record<string, string>;
  /** Trimmed preset id — guaranteed non-empty. */
  preset: string;
  lang: ShareLang;
  /** Untrimmed; `""` when absent. Guaranteed non-blank when it WAS present. */
  promptOverride: string;
  /** Untrimmed; `""` when absent. */
  extra: string;
}

export type ShareBodyResult =
  | { ok: true; body: ParsedShareBody }
  | { ok: false; error: string };

/**
 * Validate one share POST body.
 *
 * Lives here, in the dependency-free wire module, because BOTH share routes ran
 * the same ~50 lines — the type-check loop, the required-field 400s, the language
 * check, both caps and the present-but-blank `promptOverride` rule — near
 * verbatim, error copy included. Two copies of a validation contract is two
 * copies to drift, and the copy IS the contract here: the route tests pin these
 * strings, and a reader hitting one surface must not be told something different
 * from a reader hitting the other.
 *
 * It returns an error rather than a `Response` so it stays dependency-free (no
 * Hono) and so each route keeps ownership of its own status code — every one of
 * these is a 400 today, but that is the route's decision to state.
 *
 * A caller must still hold the ORDERING rule the wiki route documents: these are
 * all body-shape checks and they run BEFORE anything resolution-dependent, and
 * long before `streamSSE` commits a 200.
 */
export function parseShareRequestBody(
  body: Record<string, unknown>,
  spec: ShareBodySpec,
): ShareBodyResult {
  // Body shape is client-controlled, so every field the route reads is
  // type-checked before any of them is used.
  for (const field of spec.stringFields) {
    const v = body[field];
    if (v !== undefined && typeof v !== "string") {
      return { ok: false, error: `${field} must be a string` };
    }
  }

  const values: Record<string, string> = {};
  for (const field of spec.stringFields) {
    if (field === "promptOverride" || field === "extra") continue;
    const v = body[field];
    values[field] = typeof v === "string" ? v.trim() : "";
  }

  for (const field of spec.required) {
    if (!values[field]) return { ok: false, error: `${field} is required` };
  }

  if (!isShareLang(body.lang)) {
    return {
      ok: false,
      error: `lang must be one of: ${SHARE_LANGS.map((l) => l.id).join(", ")}`,
    };
  }

  const promptOverride = typeof body.promptOverride === "string" ? body.promptOverride : "";
  if (promptOverride.length > SHARE_PROMPT_OVERRIDE_MAX) {
    return {
      ok: false,
      error: `promptOverride is longer than ${SHARE_PROMPT_OVERRIDE_MAX} characters`,
    };
  }
  // A PRESENT but blank override is refused, never a silent fall back to the
  // preset — the model would follow an instruction the screen is no longer
  // showing, reported as that preset's output. (ABSENT is the unedited case.)
  if (body.promptOverride !== undefined && promptOverride.trim() === "") {
    return { ok: false, error: "promptOverride is empty — omit it to use the preset" };
  }

  const extra = typeof body.extra === "string" ? body.extra : "";
  if (extra.length > SHARE_EXTRA_MAX) {
    return { ok: false, error: `extra is longer than ${SHARE_EXTRA_MAX} characters` };
  }

  return {
    ok: true,
    body: { values, preset: values.preset ?? "", lang: body.lang, promptOverride, extra },
  };
}
