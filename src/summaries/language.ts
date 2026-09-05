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
export function resolveOutputLang(pick: CaptureLang, captionLang: string, transcript?: string): OutputLang {
  if (pick !== "talk") return pick;
  if (transcript !== undefined) {
    const heard = detectTextLang(transcript);
    if (heard !== null) return heard;
  }
  return langFromCaptionTag(captionLang);
}

/** The caption-tag half of the `talk` rule, alone: `no`/`nb`/`nn` ⇒ bokmål, anything else ⇒ English. */
export function langFromCaptionTag(captionLang: string): OutputLang {
  const base = captionBaseLang(captionLang);
  return base === "no" || base === "nb" || base === "nn" ? "nb" : "en";
}

/**
 * Function words that occur in one of the two languages and not the other.
 * Deliberately NO word that is spelled the same in both (`for`, `at`, `men`,
 * `over`, `under`, `en`), since a shared word counts for whichever side lists
 * it — and no `de`, the most frequent word of French/Spanish/Portuguese, which
 * alone read composed French as 100 % Norwegian. Matched as whole lowercase
 * tokens.
 */
export const NORWEGIAN_MARKERS: ReadonlySet<string> = new Set([
  "og", "ikke", "det", "er", "som", "på", "til", "et", "jeg", "vi", "å", "har", "med", "av", "den",
  "kan", "skal", "var", "også", "om", "så", "her", "da", "når", "hva", "hvordan", "litt",
  "veldig", "bare", "noe", "mye", "eller", "fra", "seg", "man", "denne", "dette", "være", "blir",
]);
export const ENGLISH_MARKERS: ReadonlySet<string> = new Set([
  "the", "and", "is", "to", "of", "that", "it", "in", "you", "this", "are", "was", "with", "have",
  "we", "be", "on", "not", "they", "what", "can", "so", "but", "do", "if", "about", "there", "just",
  "like", "which", "your", "from", "when", "how", "very", "really", "going", "these", "those",
]);

/** Enough marker hits to call it — below this the text is too short to say. */
export const TEXT_LANG_MIN_HITS = 20;
/**
 * The winning side must show at least this many DIFFERENT markers: one word
 * repeated is not a language. Measured (review of #525): French and Spanish
 * prose scored 100 % Norwegian through the single marker `de` (the most
 * frequent word in both), so a `fr`-tagged talk would have been summarized in
 * bokmål. `de` is dropped from the set too; this floor is the class fix.
 */
export const TEXT_LANG_MIN_DISTINCT = 6;
/** The winning side must carry at least this share of the hits. */
export const TEXT_LANG_MIN_SHARE = 0.7;
/** Tokens examined, from the front — a talk's language does not change at minute 40. */
const TEXT_LANG_MAX_TOKENS = 6000;

/**
 * The language the TRANSCRIPT is written in — bokmål or English — by counting
 * function words, or `null` when the text does not say (too short, or mixed).
 *
 * Exists because the caption TAG is not a reliable language signal: Vimeo
 * tagged a Norwegian lightning talk's auto-captions `en-x-autogen` (measured
 * 2026-09-05, the Kotlin talk), so `talk` produced an English summary of
 * Norwegian speech. The text itself cannot be mis-tagged. Nynorsk counts as
 * Norwegian here as in the tag rule (the rider knows one Norwegian); a Swedish
 * or Danish talk shares enough markers with bokmål to read as Norwegian, which
 * lands on the bokmål rider — the better of the two available outcomes. German
 * and Dutch measured `null` (the tag decides); French and Spanish are `null`
 * once `de` is out of the set and six distinct markers are required.
 * Deterministic, no model call. Pure.
 */
export function detectTextLang(text: string): OutputLang | null {
  const tokens = text.toLowerCase().split(/[^\p{L}]+/u).filter((t) => t.length > 0).slice(0, TEXT_LANG_MAX_TOKENS);
  let nb = 0;
  let en = 0;
  const nbSeen = new Set<string>();
  const enSeen = new Set<string>();
  for (const t of tokens) {
    if (NORWEGIAN_MARKERS.has(t)) {
      nb++;
      nbSeen.add(t);
    } else if (ENGLISH_MARKERS.has(t)) {
      en++;
      enSeen.add(t);
    }
  }
  const total = nb + en;
  if (total < TEXT_LANG_MIN_HITS) return null;
  if (nb / total >= TEXT_LANG_MIN_SHARE && nbSeen.size >= TEXT_LANG_MIN_DISTINCT) return "nb";
  if (en / total >= TEXT_LANG_MIN_SHARE && enSeen.size >= TEXT_LANG_MIN_DISTINCT) return "en";
  return null;
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
