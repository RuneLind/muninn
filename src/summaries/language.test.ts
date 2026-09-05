import { describe, expect, test } from "bun:test";
import {
  CAPTURE_LANGS,
  DEFAULT_CAPTURE_LANG,
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
