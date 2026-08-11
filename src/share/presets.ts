/**
 * Share presets — the instruction set that turns a wiki page or a capture summary
 * into something pasteable (a Slack post, an email). The default set SHIPS IN THIS
 * REPO as typed string constants, for the same reason `DEFAULT_JIRA_ANALYSIS_PROMPT`
 * does in `research-routes.ts`: a per-bot-only feature would be dead on every bot
 * (jarvis has no `prompts/` dir at all; capra and melosys live in other repos).
 *
 * Per-bot files layer on top by id — `bots/<name>/prompts/share.md` replaces the
 * shipped DEFAULT preset, `share.<id>.md` overrides a shipped preset of the same
 * id or appends a new one. The loader (`src/bots/config.ts`) only DISCOVERS those
 * files; the merge lives here, because a bare `share.md` never reaches the loader's
 * variant branch (a stem in `SINGLE_PROMPT_KEYS` is matched first) and the
 * synthetic `default` entry is a presentation concern, exactly as
 * `DEFAULT_VARIANT_ID` is for the Jira flow.
 *
 * Pure + IO-free: everything here is testable without a model call or a filesystem.
 */

// `BotPrompts` is imported as a TYPE ONLY — under `verbatimModuleSyntax` an
// inline `{ type X }` still emits the import statement, which would load
// `bots/config.ts` (and its `node:fs`/db/hivemind graph) at runtime. The two
// value constants come from the dependency-free leaf instead, which is what keeps
// the "pure + IO-free" claim above true rather than aspirational (measured: the
// value import cost this module ~2ms → ~20ms).
import type { BotPrompts } from "../bots/config.ts";
import { DEFAULT_VARIANT_ID, DEFAULT_VARIANT_LABEL } from "../bots/prompt-defaults.ts";

/** Id of the synthetic entry that maps back to the bare `share.md` / the shipped
 *  default prompt. A VALUE RE-EXPORT of the loader's constant, not a second
 *  spelling of `"default"`: the loader refuses exactly this id as a variant
 *  (`share.default.md`), so if the two literals ever drifted, the id the picker
 *  reserves and the id the loader blocks would no longer be the same string. */
export const DEFAULT_SHARE_PRESET_ID = DEFAULT_VARIANT_ID;
export const DEFAULT_SHARE_PRESET_LABEL = DEFAULT_VARIANT_LABEL;

/** One resolved preset the picker offers and the share service runs. */
export interface SharePreset {
  id: string;
  label: string;
  content: string;
}

// ── Rules every shipped preset carries ───────────────────────────────────────
// Composed from ONE constant here, but interpolated into each preset so the rules
// appear VERBATIM in every rendered prompt — a per-bot override that copies a
// preset out of the picker takes the whole contract with it. The three that are
// NOT style preferences:
//
//   * markdown only — every consumer (Slack mrkdwn, the email renderer, the web
//     preview) converts FROM markdown; HTML or a code fence around the whole post
//     survives none of those conversions intact.
//   * no derived quantities — this lands in a company Slack under the user's name.
//     A count or a percentage the model computed rather than read is a claim the
//     sender is making, and nobody re-checks a summary.
//   * no literal English section headings — the source pages are English; the post
//     may not be. Quoting "Key findings" into a Norwegian post is the tell that
//     nobody wrote it.

const SHARED_PRESET_RULES = `Rules:
- Output MARKDOWN only. No HTML, no wrapping code fence, no preamble like "Here is the summary".
- Never state a number, count, percentage or date that is not written in the source. Do not add up, average or otherwise derive quantities. If the source does not give a figure, describe it in words instead.
- Do not copy the source document's section headings verbatim. Write your own headings in the language you are writing in.
- Keep every claim traceable to the source. If something is unclear in the source, leave it out rather than guessing.`;

/** The shipped DEFAULT preset — a neutral, medium-length summary. Overridden
 *  wholesale by a bot's `prompts/share.md`. */
export const DEFAULT_SHARE_PROMPT = `Summarize the source below as a short, self-contained post that someone can paste to a colleague.

Structure:
- One or two opening sentences saying what this is and why it matters.
- A handful of bullets with the concrete substance.
- A closing line with the takeaway.

${SHARED_PRESET_RULES}`;

/** Slack post, dev + security angle. Named in the campaign's acceptance test, so
 *  the id and label are a contract, not decoration. */
export const SLACK_DEV_SECURITY_PROMPT = `Summarize the source below as ONE Slack post for a channel of developers and security engineers.

Angle: what a developer or a security engineer would act on. Lead with the technical substance — mechanisms, versions, failure modes, attack surface, what changes in practice — not with why the topic is interesting.

Structure:
- One opening line saying what this is.
- 3-6 bullets with the concrete technical points.
- A short numbered closing section with what to do or watch next.

LENGTH BUDGET: the whole post must stay under 1200 characters. Slack turns a longer paste into a file snippet instead of a message, which nobody reads. Cut points rather than compressing every sentence into unreadable density.

${SHARED_PRESET_RULES}`;

/** Email body — prose-first, since a mail client renders it as a document rather
 *  than a chat message. */
export const EMAIL_SUMMARY_PROMPT = `Summarize the source below as the body of an email to a colleague.

Structure:
- A one-line subject suggestion on the first line, prefixed with "Subject: ".
- A short opening paragraph saying what this is and why you are sending it.
- Two to four short paragraphs, or a small bulleted list, with the substance.
- A closing line with the takeaway or the ask.

Prose over bullets where the point needs a sentence — this is a document, not a chat message.

${SHARED_PRESET_RULES}`;

/**
 * The shipped NON-default presets, in picker order. The default is synthesized
 * separately (from `prompts.share ?? DEFAULT_SHARE_PROMPT`) so a bot's `share.md`
 * can replace it without disturbing these.
 */
export const SHIPPED_SHARE_PRESETS: readonly SharePreset[] = [
  { id: "slack-dev-security", label: "Slack · dev + security", content: SLACK_DEV_SECURITY_PROMPT },
  { id: "email", label: "Email · summary", content: EMAIL_SUMMARY_PROMPT },
];

/**
 * Resolve the presets a given bot offers: the synthetic `default` entry first
 * (the bot's own `share.md` when it has one, else the shipped default), then the
 * shipped presets with any per-bot `share.<id>.md` of the same id REPLACING them
 * in place, then the bot's remaining new ids appended.
 *
 * Overriding in place rather than appending matters: a bot that re-writes
 * `slack-dev-security` must not end up offering two entries with the same label,
 * where which one runs depends on picker order.
 *
 * The result is never empty — a bot with no prompt files at all still gets the
 * whole shipped set, which is the point of shipping them here.
 *
 * BLANK IS ABSENT, at this layer too. The file loader already drops an empty
 * `share.md`, but a `??` here only catches `undefined`, so any OTHER producer of
 * a `BotPrompts` — a test, a future DB-backed or API-supplied prompt source —
 * handing over `""` or `"  \n "` would have replaced the shipped default with an
 * instruction-free prompt and sent whatever the model made of a bare document.
 * A guard that lives only in the loader is a guard on one caller, not on the
 * contract; the same trim applies to each variant's content.
 */
export function resolveSharePresets(prompts: BotPrompts | undefined): SharePreset[] {
  const overrides = new Map<string, SharePreset>();
  for (const v of prompts?.shareVariants ?? []) {
    // A blank variant is no variant: dropping it lets a shipped preset of the
    // same id survive intact, rather than being overridden by nothing.
    if (v.content.trim() === "") continue;
    overrides.set(v.id, { id: v.id, label: v.label, content: v.content });
  }

  const resolved: SharePreset[] = [
    {
      id: DEFAULT_SHARE_PRESET_ID,
      label: DEFAULT_SHARE_PRESET_LABEL,
      content: prompts?.share?.trim() ? prompts.share : DEFAULT_SHARE_PROMPT,
    },
  ];

  for (const shipped of SHIPPED_SHARE_PRESETS) {
    const override = overrides.get(shipped.id);
    resolved.push(override ?? shipped);
    overrides.delete(shipped.id);
  }
  // Whatever ids are left are genuinely new — append in the loader's (sorted) order.
  for (const extra of overrides.values()) resolved.push(extra);

  return resolved;
}

/** Look one preset up by id, falling back to the default entry — the shape a
 *  route needs when an unknown/absent id arrives from a client. */
export function findSharePreset(presets: SharePreset[], id: string | undefined): SharePreset {
  const wanted = id?.trim();
  const match = wanted ? presets.find((p) => p.id === wanted) : undefined;
  // `resolveSharePresets` always puts the default first and never returns empty.
  return match ?? presets[0]!;
}
