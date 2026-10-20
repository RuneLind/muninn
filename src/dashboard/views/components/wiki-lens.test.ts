import { describe, expect, test } from "bun:test";
import {
  OVERVIEW_HIDDEN_HEAD,
  SWITCH_TITLE,
  lensCss,
  lensKeyToggles,
  lensSwitchClosesNoneFolds,
  lensSwitchWanted,
  newestFirstOrder,
} from "./wiki-lens.ts";

/** The rules of `lensCss()` that carry `needle`, one per line. */
function rulesWith(needle: string): string[] {
  return lensCss()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes(needle));
}

const LENSED = ".wiki-article:is(.lens-overview, .lens-all, .lens-agent)";

describe("newestFirstOrder", () => {
  test("reverses the decisions in their own slots and keeps every other item in place", () => {
    // d1 d2 d3 s0 d4 s1 → d4 d3 d2 s0 d1 s1
    expect(newestFirstOrder([true, true, true, false, true, false])).toEqual([4, 2, 1, 3, 0, 5]);
  });

  test("a list without decisions, or with one, keeps its order", () => {
    expect(newestFirstOrder([false, false])).toEqual([0, 1]);
    expect(newestFirstOrder([false, true, false])).toEqual([0, 1, 2]);
    expect(newestFirstOrder([])).toEqual([]);
  });
});

describe("lensCss: the compact lists are the same in every lens (D45)", () => {
  test("the five-cap, the date cell and the case line apply to an article in any lens", () => {
    expect(rulesWith(".dl-older").some((r) => r.startsWith(`${LENSED} .decision-log:not(.lens-show-all)`))).toBe(true);
    expect(rulesWith("> .dl-when {").some((r) => r.startsWith(`${LENSED} .dl-item.dl-decision`))).toBe(true);
    expect(rulesWith("> .cb-line").some((r) => r.startsWith(`${LENSED} .caseboard .cb-row > .cb-line`))).toBe(true);
    expect(rulesWith("> .cb-row.cb-folded").some((r) => r.startsWith(LENSED))).toBe(true);
  });

  test("a decision's rest folds behind «mer» in any lens", () => {
    expect(rulesWith(".dl-rest").some((r) => r.startsWith(`${LENSED} .dl-item:not(.dl-expanded)`))).toBe(true);
  });

  test("no rule hides the reader's toggles outside Overview", () => {
    // Any rule that names a toggle and hides something: Overview's alone may.
    const hides = lensCss()
      .split("}")
      .filter((r) => /display:\s*none/.test(r) && /dl-more|dl-all|cb-more|cb-okmore|cb-nonemore|dl-qstate/.test(r));
    expect(hides.filter((r) => !r.trim().startsWith(".wiki-article.lens-overview"))).toEqual([]);
  });

  test("the compact parts stay scoped to an article the lens set up", () => {
    const art = rulesWith(".dl-when").concat(rulesWith(".cb-line"));
    expect(art.filter((r) => r.startsWith(".wiki-article ") && /display: (block|inline)/.test(r))).toEqual([]);
  });

  test("Overview alone hides the none group whole and shows its count line", () => {
    expect(rulesWith('.cb-group[data-status="none"]').some((r) => r.startsWith(".wiki-article.lens-overview :is("))).toBe(true);
    // The squares' none group goes with its rows, so squares and rows agree.
    expect(rulesWith('.cb-dots-group[data-status="none"]').some((r) => r.startsWith(".wiki-article.lens-overview :is("))).toBe(true);
    expect(rulesWith(".cb-lens-note { display: none; }")).toEqual([".wiki-article:not(.lens-overview) .cb-lens-note { display: none; }"]);
  });

  test("D47: one rule folds the ok and none rows the reader marked, in every lens", () => {
    expect(rulesWith("> .cb-row")
      .filter((r) => r.endsWith("{ display: none; }"))).toEqual([
      `${LENSED} .cb-group:not(.lens-show-all) > .cb-row.cb-folded:not(.wiki-ref-peek *) { display: none; }`,
    ]);
  });
});

describe("lensSwitchClosesNoneFolds (D47)", () => {
  test("a switch into or out of Overview closes the none folds", () => {
    expect(lensSwitchClosesNoneFolds("all", "overview")).toBe(true);
    expect(lensSwitchClosesNoneFolds("overview", "all")).toBe(true);
    expect(lensSwitchClosesNoneFolds("agent", "overview")).toBe(true);
    expect(lensSwitchClosesNoneFolds("overview", "agent")).toBe(true);
  });

  test("a switch between two other lenses, or to the lens on screen, leaves them open", () => {
    expect(lensSwitchClosesNoneFolds("all", "agent")).toBe(false);
    expect(lensSwitchClosesNoneFolds("agent", "all")).toBe(false);
    expect(lensSwitchClosesNoneFolds("all", "all")).toBe(false);
    expect(lensSwitchClosesNoneFolds("overview", "overview")).toBe(false);
  });
});

describe("Overview in the article head: the series strip and the session cost", () => {
  const HEAD = ".wiki-article-head:has(~ .wiki-article.lens-overview) :is(";

  test("one rule hides the head list, reached from the article's sibling", () => {
    const rules = rulesWith(HEAD);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.endsWith("{ display: none !important; }")).toBe(true);
    for (const sel of OVERVIEW_HIDDEN_HEAD) expect(rules[0]!).toContain(sel);
  });

  test("the series head, the cost line and its chain are listed; the Jira row is not", () => {
    expect(OVERVIEW_HIDDEN_HEAD).toContain(".wiki-series-head");
    expect(OVERVIEW_HIDDEN_HEAD).toContain(".wiki-prov-line");
    expect(OVERVIEW_HIDDEN_HEAD).toContain(".wiki-prov-chain");
    expect(OVERVIEW_HIDDEN_HEAD).not.toContain(".wiki-prov-jira-row");
    expect(OVERVIEW_HIDDEN_HEAD).not.toContain(".wiki-prov-strip");
    // A strip goes whole only when it holds no Jira row.
    expect(OVERVIEW_HIDDEN_HEAD.filter((s) => s.startsWith(".wiki-prov-strip"))).toEqual([
      ".wiki-prov-strip:has(> .wiki-prov-line):not(:has(> .wiki-prov-jira-row))",
    ]);
  });

  test("no rule outside Overview hides a head block", () => {
    const hides = lensCss()
      .split("}")
      .filter((r) => /display:\s*none/.test(r) && /wiki-series-head|wiki-prov-/.test(r));
    expect(hides.map((r) => r.trim().startsWith(HEAD))).toEqual([true]);
  });

  test("the switch's tooltip names the series and the session cost", () => {
    expect(SWITCH_TITLE.en).toContain("the series and its timeline, the sessions' cost");
    expect(SWITCH_TITLE.no).toContain("serien og tidslinjen, sesjonenes kostnad");
  });
});

describe("lensSwitchWanted", () => {
  const none = { articleHides: false, headHides: false, opensFold: false, agentAvailable: false };

  test("a head block Overview hides is enough on its own", () => {
    expect(lensSwitchWanted({ ...none, headHides: true })).toBe(true);
  });

  test("each other reason still shows it, and a page with none shows no switch", () => {
    expect(lensSwitchWanted({ ...none, articleHides: true })).toBe(true);
    expect(lensSwitchWanted({ ...none, opensFold: true })).toBe(true);
    expect(lensSwitchWanted({ ...none, agentAvailable: true })).toBe(true);
    expect(lensSwitchWanted(none)).toBe(false);
  });
});

describe("lensKeyToggles", () => {
  test("v and V toggle", () => {
    expect(lensKeyToggles({ key: "v" })).toBe(true);
    expect(lensKeyToggles({ key: "V" })).toBe(true);
    expect(lensKeyToggles({ key: "g" })).toBe(false);
  });

  test("refused while typing, with a modifier or Shift, on repeat and in a dialog", () => {
    expect(lensKeyToggles({ key: "v", targetTag: "input" })).toBe(false);
    expect(lensKeyToggles({ key: "v", targetTag: "TEXTAREA" })).toBe(false);
    expect(lensKeyToggles({ key: "v", targetEditable: true })).toBe(false);
    expect(lensKeyToggles({ key: "v", metaKey: true })).toBe(false);
    expect(lensKeyToggles({ key: "v", ctrlKey: true })).toBe(false);
    expect(lensKeyToggles({ key: "V", shiftKey: true })).toBe(false);
    expect(lensKeyToggles({ key: "v", repeat: true })).toBe(false);
    expect(lensKeyToggles({ key: "v", targetInDialog: true })).toBe(false);
  });
});
