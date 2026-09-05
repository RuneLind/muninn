import { describe, expect, test } from "bun:test";
import { isVimeoConferenceAccount, speakerFromTitle } from "./metadata.ts";

describe("speakerFromTitle", () => {
  test("a JavaZone title's last ` - ` segment is the speaker", () => {
    expect(speakerFromTitle("Understanding Buildpacks- Delving Deep - Kari Nordmann", "JavaZone")).toBe("Kari Nordmann");
    // A handle in the middle: still the LAST segment.
    expect(speakerFromTitle("Trust, But Verify - Handle - Ola Nordmann", "JavaZone")).toBe("Ola Nordmann");
    // Two speakers stay one string — the convention has no separator for them.
    expect(speakerFromTitle("Bra tools - Kari Nordmann og Ola Nordmann", "javazone")).toBe("Kari Nordmann og Ola Nordmann");
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
