import { describe, expect, test } from "bun:test";
import {
  CAPTURE_LANGS,
  DEFAULT_CAPTURE_LANG,
  detectTextLang,
  ENGLISH_MARKERS,
  langFromCaptionTag,
  NORWEGIAN_MARKERS,
  TEXT_LANG_MIN_DISTINCT,
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

  test("too little text says nothing: below 20 marker hits ⇒ null (the constant IS 20 — a literal, so a drift is caught)", () => {
    expect(TEXT_LANG_MIN_HITS).toBe(20);
    expect(detectTextLang("")).toBeNull();
    expect(detectTextLang("Hei og velkommen.")).toBeNull();
    // Exactly one hit short of the floor, all Norwegian, six distinct markers.
    const six = ["og", "ikke", "det", "er", "som", "på"];
    const hits = (n: number) => Array.from({ length: n }, (_, i) => six[i % 6]).join(" ");
    expect(detectTextLang(hits(19))).toBeNull();
    expect(detectTextLang(hits(20))).toBe("nb");
  });

  test("fix round 1: one word repeated is not a language — fewer than 6 DISTINCT markers ⇒ null, and French/Spanish prose does not read as Norwegian", () => {
    expect(TEXT_LANG_MIN_DISTINCT).toBe(6);
    expect(detectTextLang(Array(40).fill("og").join(" "))).toBeNull();
    expect(detectTextLang(Array(40).fill("the").join(" "))).toBeNull();
    // Composed French and Spanish — the review measured both as `nb` through `de`.
    const fr = `Aujourd'hui je vais parler de la façon dont nous avons construit le système de recherche, et de ce que nous
avons appris. Le premier problème est que l'on ne peut pas savoir ce qui se passe dans le système si l'on n'a pas de
données, et c'est là que cela devient intéressant. Nous allons regarder trois choses, et à la fin de la présentation
je vous montrerai le code de la nouvelle version.`;
    const es = `Hoy quiero hablar de cómo construimos el sistema de búsqueda y de lo que aprendimos. El primer problema es que no
se puede saber lo que pasa en el sistema si no se tienen datos, y ahí es donde se pone interesante. Vamos a ver tres
cosas, y al final de la charla les mostraré el código de la nueva versión.`;
    expect(detectTextLang(fr)).toBeNull();
    expect(detectTextLang(es)).toBeNull();
    // The floor is the class fix; `de` is out of the set as hygiene, and no word sits in both sets.
    expect(NORWEGIAN_MARKERS.has("de")).toBe(false);
    expect([...NORWEGIAN_MARKERS].filter((w) => ENGLISH_MARKERS.has(w))).toEqual([]);
  });

  test("a mixed text with no side at the share threshold ⇒ null, never a coin toss", () => {
    const nbWords = ["og", "ikke", "det", "er", "som", "på"];
    const enWords = ["the", "and", "is", "to", "of", "that"];
    const nb = (n: number) => Array.from({ length: n }, (_, i) => nbWords[i % 6]);
    const en = (n: number) => Array.from({ length: n }, (_, i) => enWords[i % 6]);
    expect(detectTextLang(nb(15).concat(en(15)).join(" "))).toBeNull();
    // 70 % is the line: 14 nb / 6 en is nb; 13 / 7 is not.
    expect(detectTextLang(nb(14).concat(en(6)).join(" "))).toBe("nb");
    expect(detectTextLang(nb(13).concat(en(7)).join(" "))).toBeNull();
  });

  test("tokens are whole words, case-insensitive, split on any non-letter — markdown headings and timestamps are not words", () => {
    expect(detectTextLang(`### [00:02:00]\n${NB_TEXT.toUpperCase()}`)).toBe("nb");
    // `theory`/`android` contain `the`/`and` and must not count — against six real markers they would tip the share.
    expect(detectTextLang(Array(30).fill("theory android").join(" ") + " og ikke det er som på og ikke det er som på og ikke det er som på og ikke")).toBe("nb");
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
