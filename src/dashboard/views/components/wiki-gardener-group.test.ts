import { test, expect, describe } from "bun:test";
import { groupStatusSummary, groupChipTone, groupDriftNote, groupKindTag, groupNumber, kindMatches } from "./wiki-gardener-group.ts";
import { renderWikiGardenerPage } from "../wiki-gardener-page.ts";
import { themeTokenStyles } from "../shared-styles.ts";

describe("groupStatusSummary", () => {
  test("counts each status once, in the rows' own order of first appearance", () => {
    expect(groupStatusSummary(["applied", "stale", "draft"])).toBe("1 applied · 1 stale · 1 draft");
    expect(groupStatusSummary(["applied", "applied", "stale"])).toBe("2 applied · 1 stale");
    expect(groupStatusSummary(["draft"])).toBe("1 draft");
  });
});

describe("groupChipTone", () => {
  // The chip renders a status SET, so its colour has to be a function of the set.
  // Read off `rows[0]` it said `applied` over a card that still held a draft and
  // a stale row — the exact claim the summary text exists to deny.
  test("a group still holding a draft reads as a DRAFT, whatever else it holds", () => {
    expect(groupChipTone(["draft", "draft"])).toBe("draft");
    expect(groupChipTone(["applied", "stale", "draft"])).toBe("draft");
    expect(groupChipTone(["applied", "draft"])).toBe("draft");
  });

  test("no draft left and a stale row reads as STALE — the card is not done", () => {
    expect(groupChipTone(["applied", "stale"])).toBe("stale");
    expect(groupChipTone(["stale", "applied", "applied"])).toBe("stale");
  });

  test("only `applied` reads as applied", () => {
    expect(groupChipTone(["applied", "applied", "applied"])).toBe("applied");
  });

  /**
   * The WHOLE order, both directions, over every one of the 15 pairs.
   *
   * The three cases above pin the two ends and `stale` over `applied`, which
   * leaves the six pairs among `approved`/`error`/`stale`/`rejected` free: a
   * mutation survey swapped two of them and every test stayed green. The order
   * is spelled HERE as a literal on purpose — importing `CHIP_TONE_ORDER` would
   * permute the expectation with the source and pin nothing.
   */
  const ORDER = ["draft", "approved", "error", "stale", "rejected", "applied"] as const;

  test("every pair of statuses resolves to the earlier one, in both input orders", () => {
    const outcomes: string[] = [];
    for (let hi = 0; hi < ORDER.length; hi += 1) {
      for (let lo = hi + 1; lo < ORDER.length; lo += 1) {
        const [a, b] = [ORDER[hi]!, ORDER[lo]!];
        outcomes.push(`${a}+${b}=${groupChipTone([a, b])}`, `${b}+${a}=${groupChipTone([b, a])}`);
      }
    }
    // Asserted as ONE list so a failure names the pair that moved.
    expect(outcomes).toEqual([
      "draft+approved=draft", "approved+draft=draft",
      "draft+error=draft", "error+draft=draft",
      "draft+stale=draft", "stale+draft=draft",
      "draft+rejected=draft", "rejected+draft=draft",
      "draft+applied=draft", "applied+draft=draft",
      "approved+error=approved", "error+approved=approved",
      "approved+stale=approved", "stale+approved=approved",
      "approved+rejected=approved", "rejected+approved=approved",
      "approved+applied=approved", "applied+approved=approved",
      "error+stale=error", "stale+error=error",
      "error+rejected=error", "rejected+error=error",
      "error+applied=error", "applied+error=error",
      "stale+rejected=stale", "rejected+stale=stale",
      "stale+applied=stale", "applied+stale=stale",
      "rejected+applied=rejected", "applied+rejected=rejected",
    ]);
  });

  test("the other statuses keep their own tone, and an unknown one falls back", () => {
    expect(groupChipTone(["rejected", "rejected"])).toBe("rejected");
    expect(groupChipTone(["approved", "applied"])).toBe("approved");
    expect(groupChipTone(["error", "applied"])).toBe("error");
    expect(groupChipTone(["something-new"])).toBe("something-new");
    expect(groupChipTone([])).toBe("draft");
  });
});

describe("groupDriftNote", () => {
  test("no drifted draft row means no note", () => {
    expect(groupDriftNote([{ status: "draft", drifted: null }, { status: "stale", drifted: "x" }])).toBeNull();
  });
  // The preflight stops on ONE blocked row; the route marks it stale and returns
  // the others to draft. "Accept will … mark them stale" promised one click.
  test("one drifted page beside clean ones: a second Accept writes the rest", () => {
    expect(groupDriftNote([{ status: "draft", drifted: "x" }, { status: "draft" }, { status: "draft", drifted: null }])).toBe(
      "1 page changed since drafting — Accept writes nothing: it marks that page stale and returns the other 2 to draft, so a second Accept writes them.",
    );
  });
  test("one drifted page and nothing else", () => {
    expect(groupDriftNote([{ status: "draft", drifted: "x" }, { status: "applied" }])).toBe(
      "1 page changed since drafting — Accept writes nothing and marks it stale.",
    );
  });
  test("several drifted pages: one Accept per drifted page, then one more", () => {
    expect(
      groupDriftNote([{ status: "draft", drifted: "x" }, { status: "draft", drifted: "y" }, { status: "draft" }]),
    ).toBe(
      "2 pages changed since drafting — each Accept writes nothing and marks only one of them stale, returning the rest to draft. It takes 2 Accepts to mark all 2 stale, and one more to write the other 1.",
    );
    expect(groupDriftNote([{ status: "draft", drifted: "x" }, { status: "draft", drifted: "y" }])).toBe(
      "2 pages changed since drafting — each Accept writes nothing and marks only one of them stale, returning the rest to draft. It takes 2 Accepts to mark all 2 stale.",
    );
  });
});

describe("the kind filter and the card tag (PR 3, D28)", () => {
  test("«Stale check» is a kind, «Drafted pages» the model-drafted kinds, «All kinds» everything", () => {
    expect(["stale-check", "lint", "concept", "source"].filter((k) => kindMatches(k, "stale-check"))).toEqual(["stale-check"]);
    expect(["stale-check", "lint", "concept", "entity", "source", "synthesis"].filter((k) => kindMatches(k, "pages"))).toEqual(["concept", "entity", "source", "synthesis"]);
    expect(["stale-check", "lint"].filter((k) => kindMatches(k, ""))).toEqual(["stale-check", "lint"]);
  });

  test("the tag says «stale check» (CSS upper-cases it), and the group number is the key's tail", () => {
    expect(groupKindTag("stale-check")).toBe("stale check");
    expect(groupKindTag("lint")).toBe("lint");
    expect(groupNumber("stale-check:repos/x.md:12")).toBe("12");
    expect(groupNumber("lint:series-unnamed:abc")).toBe("");
  });
});

describe("the STALE CHECK tag's own look (fix round 1 batch 6)", () => {
  /** One rule's declarations as `prop → value`, read off the rendered page's CSS. */
  const rule = (css: string, selector: string): Record<string, string> => {
    const m = css.match(new RegExp(`\\n\\s*${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`));
    if (!m) throw new Error(`no rule for ${selector}`);
    return Object.fromEntries(m[1]!.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));
  };

  test("the tag shares neither its fill nor its text colour with the `stale` status chip, and every token it reads is in both themes", async () => {
    const css = await renderWikiGardenerPage();
    const tag = rule(css, ".badge-stale-check");
    const chip = rule(css, ".chip-stale");
    // A card's tag (its kind) and its status chip sit side by side: the same
    // colours read as the same thing, so a Stale check card looked stale.
    // Compared by the token each value resolves through first: `var(--x, fallback)` is `--x`.
    const token = (v: string | undefined) => v?.match(/var\((--[a-z0-9-]+)/)?.[1] ?? v;
    expect(token(tag.background)).not.toBe(token(chip.background));
    expect(token(tag.color)).not.toBe(token(chip.color));
    const vars = [...Object.values(tag).join(" ").matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!);
    expect(vars.length).toBeGreaterThan(0);
    const tokens = themeTokenStyles();
    for (const theme of ["dark", "light"]) {
      const block = tokens.match(new RegExp(`html\\[data-theme="${theme}"\\] \\{([^}]*)\\}`))![1]!;
      for (const v of vars) expect(`${theme}: ${v} ${block.includes(`${v}:`)}`).toBe(`${theme}: ${v} true`);
    }
  });
});
