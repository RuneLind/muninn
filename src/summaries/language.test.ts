import { describe, expect, test } from "bun:test";
import {
  CAPTURE_LANGS,
  DEFAULT_CAPTURE_LANG,
  detectTextLang,
  langFromCaptionTag,
  TEXT_LANG_MIN_HITS,
  isCaptureLang,
  isOutputLang,
  languageRider,
  resolveOutputLang,
} from "./language.ts";
import { languageRider as shareLanguageRider } from "../share/prompt.ts";

describe("resolveOutputLang", () => {
  test("`talk` reads the caption tag's base subtag: Norwegian ⇒ nb, anything else ⇒ en", () => {
    // The two real shapes on the mini's captures.
    expect(resolveOutputLang("talk", "no-x-autogen")).toBe("nb");
    expect(resolveOutputLang("talk", "en-x-autogen")).toBe("en");
    // Manual tracks carry the written standards.
    expect(resolveOutputLang("talk", "nb")).toBe("nb");
    expect(resolveOutputLang("talk", "nn-NO")).toBe("nb");
    expect(resolveOutputLang("talk", "NO")).toBe("nb");
    expect(resolveOutputLang("talk", "sv")).toBe("en");
    expect(resolveOutputLang("talk", "")).toBe("en");
    expect(resolveOutputLang("talk", "  ")).toBe("en");
  });

  test("an explicit pick wins over the captions, both ways", () => {
    expect(resolveOutputLang("en", "no-x-autogen")).toBe("en");
    expect(resolveOutputLang("nb", "en-x-autogen")).toBe("nb");
  });

  test("a subtag that merely STARTS with `no` is not Norwegian", () => {
    // `nob`/`nor` would be ISO 639-2 spellings nobody sends; the point is that
    // the match is on the whole base subtag, not a prefix.
    expect(resolveOutputLang("talk", "nor")).toBe("en");
  });
});

describe("the picker's value set", () => {
  test("the default is `talk`, and it is the first option", () => {
    expect(DEFAULT_CAPTURE_LANG).toBe("talk");
    expect(CAPTURE_LANGS[0]!.id).toBe("talk");
    expect(CAPTURE_LANGS.map((l) => l.id)).toEqual(["talk", "nb", "en"]);
  });

  test("the guards accept exactly the picker's values", () => {
    for (const l of CAPTURE_LANGS) expect(isCaptureLang(l.id)).toBe(true);
    expect(isCaptureLang("no")).toBe(false);
    expect(isCaptureLang("")).toBe(false);
    expect(isCaptureLang(undefined)).toBe(false);
    expect(isOutputLang("talk")).toBe(false);
    expect(isOutputLang("nb")).toBe(true);
  });
});

describe("languageRider", () => {
  test("names the text it is about, and the share flow's wording is unchanged", () => {
    expect(languageRider("nb", "summary")).toContain("write the summary in Norwegian (bokmål)");
    expect(languageRider("en", "summary")).toContain("write the summary in English");
    // The share flow imports the same function and gets the sentence it shipped with.
    expect(shareLanguageRider("nb")).toBe(
      "LANGUAGE: write the post in Norwegian (bokmål), whatever language the source is in. " +
        "Keep product names, proper nouns, code identifiers and quoted strings in their original form — " +
        "translate the prose around them, not them.",
    );
    expect(shareLanguageRider("en")).toBe(
      "LANGUAGE: write the post in English, whatever language the source is in.",
    );
    expect(shareLanguageRider).toBe(languageRider);
  });
});

// Placeholder prose, not corpus text: enough function words to clear the threshold.
const NB_TEXT = `Hei og velkommen. I dag skal vi snakke om hvordan vi kan skrive kode som er lett å lese, og hvorfor det
er viktig. Det er ikke så vanskelig som man skulle tro, og vi skal se på noen eksempler her. Da kan vi bare begynne
med det første. Jeg har med meg litt kode fra et prosjekt, og den skal vi se på sammen. Så er det veldig viktig at
vi ikke bare kopierer, men at vi også forstår hva som skjer.`;
const EN_TEXT = `So today I want to talk about how we can write code that is easy to read, and why that matters. It is
not as hard as you would think, and we are going to look at some examples here. Then we can just start with the
first one. I have brought some code from a project, and we will look at it together. So it is very important that
we do not just copy, but that we also understand what is going on.`;

describe("detectTextLang — the transcript's own language (v2 follow-up)", () => {
  test("Norwegian prose ⇒ nb, English prose ⇒ en", () => {
    expect(detectTextLang(NB_TEXT)).toBe("nb");
    expect(detectTextLang(EN_TEXT)).toBe("en");
  });

  test("too little text says nothing: below TEXT_LANG_MIN_HITS marker hits ⇒ null", () => {
    expect(detectTextLang("")).toBeNull();
    expect(detectTextLang("Hei og velkommen.")).toBeNull();
    // Exactly one hit short of the floor, all Norwegian.
    expect(detectTextLang(Array(TEXT_LANG_MIN_HITS - 1).fill("og").join(" "))).toBeNull();
    expect(detectTextLang(Array(TEXT_LANG_MIN_HITS).fill("og").join(" "))).toBe("nb");
  });

  test("a mixed text with no side at the share threshold ⇒ null, never a coin toss", () => {
    const mixed = Array(15).fill("og").concat(Array(15).fill("the")).join(" ");
    expect(detectTextLang(mixed)).toBeNull();
    // 70 % is the line: 14 nb / 6 en is nb; 13 / 7 is not.
    expect(detectTextLang(Array(14).fill("det").concat(Array(6).fill("the")).join(" "))).toBe("nb");
    expect(detectTextLang(Array(13).fill("det").concat(Array(7).fill("the")).join(" "))).toBeNull();
  });

  test("tokens are whole words, case-insensitive, split on any non-letter — markdown headings and timestamps are not words", () => {
    expect(detectTextLang(`### [00:02:00]\n${NB_TEXT.toUpperCase()}`)).toBe("nb");
    // `theory`/`android` contain `the`/`and` and must not count.
    expect(detectTextLang(Array(30).fill("theory android").join(" "))).toBeNull();
  });
});

describe("resolveOutputLang with a transcript — the text beats the tag", () => {
  test("the measured case: Norwegian speech under an `en-x-autogen` tag ⇒ nb", () => {
    expect(resolveOutputLang("talk", "en-x-autogen", NB_TEXT)).toBe("nb");
    expect(resolveOutputLang("talk", "no-x-autogen", EN_TEXT)).toBe("en");
  });

  test("an inconclusive transcript falls back to the tag rule; no transcript is the old rule verbatim", () => {
    expect(resolveOutputLang("talk", "no-x-autogen", "Hei.")).toBe("nb");
    expect(resolveOutputLang("talk", "en-x-autogen", "Hei.")).toBe("en");
    expect(resolveOutputLang("talk", "no-x-autogen")).toBe(langFromCaptionTag("no-x-autogen"));
    expect(langFromCaptionTag("nn-NO")).toBe("nb");
    expect(langFromCaptionTag("sv")).toBe("en");
  });

  test("an explicit pick still beats both", () => {
    expect(resolveOutputLang("en", "no-x-autogen", NB_TEXT)).toBe("en");
    expect(resolveOutputLang("nb", "en-x-autogen", EN_TEXT)).toBe("nb");
  });
});
