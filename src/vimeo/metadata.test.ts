import { describe, expect, test } from "bun:test";
import { isVimeoConferenceAccount, speakerFromTitle } from "./metadata.ts";

describe("speakerFromTitle", () => {
  test("a JavaZone title's last ` - ` segment is the speaker", () => {
    expect(speakerFromTitle("Understanding Buildpacks- Delving Deep - Patrick Baumgartner", "JavaZone")).toBe("Patrick Baumgartner");
    // A handle in the middle: still the LAST segment.
    expect(speakerFromTitle("Trust, But Verify - Totto - Thor Henning Hetland", "JavaZone")).toBe("Thor Henning Hetland");
    // Two speakers stay one string — the convention has no separator for them.
    expect(speakerFromTitle("Bra tools - Bjørn Nordlund og Eirik Fagtun Kjærnli", "javazone")).toBe("Bjørn Nordlund og Eirik Fagtun Kjærnli");
  });

  test("an account outside the allowlist yields no speaker, whatever the title", () => {
    expect(speakerFromTitle("Kotlin - the good parts", "Some Person")).toBeUndefined();
    expect(speakerFromTitle("Kotlin - the good parts", "")).toBeUndefined();
    expect(isVimeoConferenceAccount("  ")).toBe(false);
  });

  test("a conference title with no separator, or an empty last segment, yields none", () => {
    expect(speakerFromTitle("Heis.fm LIVE", "JavaZone")).toBeUndefined();
    expect(speakerFromTitle("A talk - ", "JavaZone")).toBeUndefined();
    // A hyphen without spaces is not the separator.
    expect(speakerFromTitle("Build-your-own Game Boy", "JavaZone")).toBeUndefined();
  });
});
