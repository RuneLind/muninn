/**
 * `parseShareRequestBody` — the body validation BOTH share routes run.
 *
 * It was ~50 duplicated lines before, error copy included, and the copy is the
 * contract: the route tests pin these strings, and a reader hitting /summaries
 * must not be told something different from a reader hitting /wiki for the same
 * malformed body. This file pins the shared rules once; each route test keeps
 * pinning its OWN field list and status codes, which is the half that genuinely
 * differs.
 */

import { test, expect, describe } from "bun:test";
import {
  parseShareRequestBody,
  SHARE_EXTRA_MAX,
  SHARE_PROMPT_OVERRIDE_MAX,
  type ShareBodySpec,
} from "./wire.ts";

/** The two live specs, so a change to either route's field list lands here. */
const WIKI: ShareBodySpec = {
  stringFields: ["wiki", "bot", "page", "preset", "promptOverride", "extra"],
  required: ["page", "preset"],
};
const SUMMARIES: ShareBodySpec = {
  stringFields: ["source", "docId", "preset", "promptOverride", "extra"],
  required: ["source", "docId", "preset"],
};

const okWiki = { page: "A Concept", preset: "default", lang: "en" };
const okSum = { source: "youtube", docId: "ai/T.md", preset: "default", lang: "en" };

function err(body: unknown, spec: ShareBodySpec): string {
  const r = parseShareRequestBody(body as Record<string, unknown>, spec);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.error;
}

describe("the happy path", () => {
  test("trims the identity fields and hands back the share layer's four values", () => {
    const r = parseShareRequestBody(
      { ...okSum, docId: "  ai/T.md  ", extra: " focus on risk " },
      SUMMARIES,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.values.docId).toBe("ai/T.md");
    expect(r.body.preset).toBe("default");
    expect(r.body.lang).toBe("en");
    // `extra`/`promptOverride` come back UNTRIMMED — their caps are measured on
    // what the reader typed, and the route trims at the point of use.
    expect(r.body.extra).toBe(" focus on risk ");
    expect(r.body.promptOverride).toBe("");
  });

  test("an absent optional string field is \"\", never undefined", () => {
    const r = parseShareRequestBody(okWiki, WIKI);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.values.wiki).toBe("");
    expect(r.body.values.bot).toBe("");
  });
});

describe("type checking runs first, over the surface's OWN field list", () => {
  test("a non-string field names itself", () => {
    expect(err({ ...okWiki, page: 3 }, WIKI)).toBe("page must be a string");
    expect(err({ ...okSum, docId: [] }, SUMMARIES)).toBe("docId must be a string");
    expect(err({ ...okSum, extra: false }, SUMMARIES)).toBe("extra must be a string");
  });

  test("it precedes every other check — a bad TYPE is not reported as a bad value", () => {
    // Without the ordering, a numeric `page` reaches the required check and is
    // reported as "page is required", which is a different (and wrong) fix.
    expect(err({ ...okWiki, page: 0, lang: "sv" }, WIKI)).toBe("page must be a string");
  });

  test("the first offending field in DECLARATION order wins", () => {
    expect(err({ ...okSum, source: 1, docId: 2 }, SUMMARIES)).toBe("source must be a string");
  });
});

describe("required fields, in the surface's report order", () => {
  test("missing or blank is the same failure", () => {
    expect(err({ ...okWiki, page: "" }, WIKI)).toBe("page is required");
    expect(err({ ...okWiki, page: "   " }, WIKI)).toBe("page is required");
    expect(err({ preset: "default", lang: "en" }, WIKI)).toBe("page is required");
  });

  test("the identity fields OUTRANK the preset — the reader's real mistake is named", () => {
    expect(err({ lang: "en" }, SUMMARIES)).toBe("source is required");
    expect(err({ source: "youtube", lang: "en" }, SUMMARIES)).toBe("docId is required");
    expect(err({ ...okSum, preset: " " }, SUMMARIES)).toBe("preset is required");
  });
});

describe("language and the two caps", () => {
  test("an unknown or missing lang names the accepted values", () => {
    for (const lang of [undefined, "", "sv", 3]) {
      expect(err({ ...okWiki, lang }, WIKI)).toBe("lang must be one of: en, nb");
    }
  });

  test("over-cap text is refused, never truncated — and AT the cap passes", () => {
    expect(err({ ...okWiki, promptOverride: "x".repeat(SHARE_PROMPT_OVERRIDE_MAX + 1) }, WIKI)).toBe(
      `promptOverride is longer than ${SHARE_PROMPT_OVERRIDE_MAX} characters`,
    );
    expect(err({ ...okWiki, extra: "x".repeat(SHARE_EXTRA_MAX + 1) }, WIKI)).toBe(
      `extra is longer than ${SHARE_EXTRA_MAX} characters`,
    );
    expect(
      parseShareRequestBody({ ...okWiki, extra: "x".repeat(SHARE_EXTRA_MAX) }, WIKI).ok,
    ).toBe(true);
  });

  test("a PRESENT but blank promptOverride is refused; an ABSENT one is the normal case", () => {
    // The model must never follow an instruction the screen is no longer
    // showing, reported as the preset's output.
    for (const blank of ["", "   ", "\n\t"]) {
      expect(err({ ...okWiki, promptOverride: blank }, WIKI)).toBe(
        "promptOverride is empty — omit it to use the preset",
      );
    }
    expect(parseShareRequestBody(okWiki, WIKI).ok).toBe(true);
  });
});
