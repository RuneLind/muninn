/**
 * The output LANGUAGE of a generated text — the one spelling of the bokmål /
 * English rider, shared by the share flow and the capture verticals.
 *
 * Dependency-free on purpose: the share dialog's wire module and the summaries
 * page both name these values, and neither may drag a model, the filesystem or
 * `bots/config.ts` into a browser bundle or a page render. (`src/jira/prompt.ts`
 * keeps its own Norwegian-language rider: that one is written IN bokmål for a
 * bokmål-only surface, and is a different sentence, not a third copy of this one.)
 */

/** The two languages a generated text can be written in. */
export type OutputLang = "en" | "nb";

export function isOutputLang(value: unknown): value is OutputLang {
  return value === "en" || value === "nb";
}

/**
 * What a CAPTURE's picker offers: the two output languages plus `talk` — "the
 * language the talk is in", resolved per capture from the caption track's
 * language tag by {@link resolveOutputLang}. `talk` is the default, so a
 * Norwegian JavaZone talk gets a Norwegian summary and an English one stays
 * English, with no per-paste decision.
 */
export type CaptureLang = "talk" | OutputLang;

export const DEFAULT_CAPTURE_LANG: CaptureLang = "talk";

/** Picker order + labels. Spelled the way the reader picks them, never as tags. */
export const CAPTURE_LANGS: readonly { id: CaptureLang; label: string }[] = [
  { id: "talk", label: "Talk's language" },
  { id: "nb", label: "Norsk (bokmål)" },
  { id: "en", label: "English" },
];

export function isCaptureLang(value: unknown): value is CaptureLang {
  return value === "talk" || isOutputLang(value);
}

/**
 * The output language a capture WRITES in, from the picker's choice and the
 * caption track's BCP-47 tag.
 *
 * `talk` reads the tag's BASE subtag: `no`, `nb` and `nn` are Norwegian (Vimeo's
 * auto-captions tag Norwegian speech `no-x-autogen`, measured on two of three
 * real captures; `nb`/`nn` are the two written standards a MANUAL track may
 * carry), and everything else — including an empty or unparseable tag — is
 * English, the language the rest of the prompt is written in. Nynorsk speech
 * gets a bokmål summary: the rider only knows one Norwegian, and bokmål is what
 * the reader asked for on every other surface.
 */
export function resolveOutputLang(pick: CaptureLang, captionLang: string): OutputLang {
  if (pick !== "talk") return pick;
  const base = captionBaseLang(captionLang);
  return base === "no" || base === "nb" || base === "nn" ? "nb" : "en";
}

/**
 * `no-x-autogen` → `no`, `nn-NO` → `nn`: the BASE subtag of a caption track's
 * tag, ONE rule shared with `chooseTrack` (`src/vimeo/captions.ts`) so the
 * track chosen as "the talk's own language" and the language the summary is
 * written in can never disagree about what a tag means.
 */
export function captionBaseLang(lang: string): string {
  return lang.trim().toLowerCase().replace(/-x-autogen$/, "").split("-")[0] ?? "";
}

/**
 * The rider that pins the output language. English is stated as explicitly as
 * Norwegian — an unstated default is what a strongly-worded source overrides.
 *
 * `what` names the text being written ("post" for a share, "summary" for a
 * capture) so the sentence reads as an instruction about THIS output; the
 * default keeps the share flow's wording byte-identical to what shipped.
 */
export function languageRider(lang: OutputLang, what: string = "post"): string {
  if (lang === "nb") {
    return (
      `LANGUAGE: write the ${what} in Norwegian (bokmål), whatever language the source is in. ` +
      "Keep product names, proper nouns, code identifiers and quoted strings in their original form — " +
      "translate the prose around them, not them."
    );
  }
  return `LANGUAGE: write the ${what} in English, whatever language the source is in.`;
}
