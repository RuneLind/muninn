import { describe, expect, test } from "bun:test";
import { componentBlocks, parseBlocks } from "./markdown-ast.ts";
import { visibleText } from "./report-top.ts";
import { CASE_ID_RE, readRuleTree, ruleTreeNodes, type RuleNode } from "./rule-tree.ts";

/** Read the first `<RuleTree>` in `md`, the way the lint reads it. */
function read(md: string, boardIds?: ReadonlySet<string>) {
  const [block] = componentBlocks(parseBlocks(md), "RuleTree");
  if (!block) throw new Error("no RuleTree block");
  return readRuleTree(block.children, block.attrs, { text: visibleText, ...(boardIds ? { boardIds } : {}) });
}

const tree = (outcomes: string, body: string, title = "Can the book be renewed?") =>
  `<RuleTree title="${title}" outcomes="${outcomes}">\n\n${body}\n\n</RuleTree>\n`;

const leaves = (nodes: readonly RuleNode[]) => ruleTreeNodes(nodes).filter((n) => n.leaf);

describe("readRuleTree — the tree", () => {
  test("reads edge labels, leaves, outcomes, tones and cases", () => {
    const r = read(
      tree(
        "Renew=good;Return=muted;Ask staff=warn",
        [
          "- Is the book reserved by someone else?",
          "  - *Yes:* → Return (D2) — LIB-101, LIB-102",
          "  - _No_ Has it been renewed three times?",
          "    - *Yes:* → Ask staff — LIB-103",
          "    - *No:* → Renew — LIB-104",
        ].join("\n"),
      ),
    );
    expect(r.findings).toEqual([]);
    expect(r.nodes).toHaveLength(1);
    const [root] = r.nodes;
    expect(root?.lead).toBeNull();
    expect(root?.leaf).toBeNull();
    const ls = leaves(r.nodes);
    expect(ls.map((n) => n.lead?.label)).toEqual(["Yes", "Yes", "No"]);
    expect(ls.map((n) => n.leaf?.outcome)).toEqual(["Return", "Ask staff", "Renew"]);
    expect(ls.map((n) => n.leaf?.tone)).toEqual(["muted", "warn", "good"]);
    expect(ls.map((n) => n.leaf?.cases)).toEqual([["LIB-101", "LIB-102"], ["LIB-103"], ["LIB-104"]]);
    // The decision ref stays in the leaf text before the dash.
    expect(ls[0]?.leaf?.caseSplit?.body).toBe(" → Return (D2)");
    expect(r.cases).toEqual(["LIB-101", "LIB-102", "LIB-103", "LIB-104"]);
    const inner = root?.under[0];
    expect(inner?.kind === "list" && inner.nodes[1]?.lead?.label).toBe("No");
  });

  test("a block with no list is fatal and keeps its blocks", () => {
    const r = read(tree("Renew=good", "Just a paragraph."));
    expect(r.list).toBeNull();
    expect(r.before).toHaveLength(1);
    expect(r.findings).toEqual([{ message: "holds no list; it renders as written", level: "fatal" }]);
  });

  test("blocks before and after the list render in place", () => {
    const r = read(tree("Renew=good", "Intro line.\n\n- → Renew\n\nAfter line."));
    expect(r.before.map((b) => b.type)).toEqual(["text"]);
    expect(r.after.map((b) => b.type)).toEqual(["text"]);
  });
});

describe("readRuleTree — the leaf text", () => {
  const one = (item: string, outcomes = "Renew=good", boardIds?: ReadonlySet<string>) => {
    const r = read(tree(outcomes, `- ${item}`), boardIds);
    return { r, leaf: r.nodes[0]?.leaf ?? null };
  };

  test.each([
    ["→ Renew — LIB-1", "Renew", ["LIB-1"]],
    ["**→ Renew** — LIB-1", "Renew", ["LIB-1"]],
    ["→ ~~Return~~ Renew — LIB-1", "Renew", ["LIB-1"]],
    ["→ Renew — LIB-1", "Renew", ["LIB-1"]],
    ["→ Renew – LIB-1", "Renew – LIB-1", []],
    ["→ Renew - LIB-1", "Renew - LIB-1", []],
    ["→ Renew — `LIB-1`", "Renew", ["LIB-1"]],
    ["→ Renew `a — b` — LIB-1", "Renew `a — b`", ["LIB-1"]],
    ["→ Renew — see the notes", "Renew", []],
    ["→ Renew — LIB-1, ~~LIB-2~~", "Renew", ["LIB-1"]],
    ["→ Renew — LIB-1, LIB-1", "Renew", ["LIB-1"]],
    // A link reads as its text; a ( or , in its destination cuts nothing.
    ["→ [Renew](http://x) — LIB-1", "Renew", ["LIB-1"]],
    ["→ [Renew](http://x) (D2) — LIB-1", "Renew", ["LIB-1"]],
    ["→ Renew, see [the rule](http://x) — LIB-1", "Renew, see the rule", ["LIB-1"]],
    ["→ Renew — [LIB-1](http://x/?a=1,2), LIB-2", "Renew", ["LIB-1", "LIB-2"]],
    // An emphasis run around the arrow closes before the cases.
    ["*→ Renew*", "Renew", []],
    ["*→ Renew* — LIB-1", "Renew", ["LIB-1"]],
    ["_→ Renew_ — LIB-1", "Renew", ["LIB-1"]],
    ["*→ Renew*, later", "Renew", []],
    ["_→ Renew user_id_", "Renew user_id", []],
    ["*→ 2 * 3* — LIB-1", "2 * 3", ["LIB-1"]],
    ["**→ Renew**, later", "Renew", []],
  ])("%s", (item, outcome, cases) => {
    const { leaf } = one(item);
    expect(leaf?.cases).toEqual(cases);
    // The outcome is visible text; a code span keeps its content.
    expect(leaf?.outcome).toBe(visibleText(outcome));
  });

  test("an item that does not start with → is not a leaf", () => {
    expect(one("Renew → later").leaf).toBeNull();
  });

  test("a leaf with no outcome is a warning on that leaf", () => {
    const { r, leaf } = one("→ — LIB-1", "");
    expect(leaf?.outcome).toBe("");
    expect(r.findings.map((f) => [f.level, f.message])).toEqual([["warning", "leaf «→ — LIB-1» names no outcome after →"]]);
    expect(r.findings[0]?.node).toBe(r.nodes[0]);
  });

  test.each(["→ [Renew](http://x) — LIB-1", "*→ Renew* — LIB-1", "_→ Renew_ — LIB-1"])("%s takes its tone", (item) => {
    const { r, leaf } = one(item);
    expect(leaf?.tone).toBe("good");
    expect(r.findings).toEqual([]);
  });

  test("a wikilinked outcome reads as its link text", () => {
    const r = readRuleTree(componentBlocks(parseBlocks(tree("Renew=good", "- → \x00L0\x00 — LIB-1")), "RuleTree")[0]?.children ?? [], { outcomes: "Renew=good" }, {
      text: (raw) => visibleText(raw.replace(/\x00L0\x00/g, "Renew")),
    });
    expect(r.nodes[0]?.leaf?.outcome).toBe("Renew");
    expect(r.nodes[0]?.leaf?.tone).toBe("good");
  });
});

describe("the case-id grammar", () => {
  test.each([
    ["LIB-101", true],
    ["AB-1", true],
    ["lib-101", false],
    ["LIB101", false],
    ["LIB-101x", false],
    ["LIB-", false],
    ["-101", false],
    ["LIB-10-1", false],
  ])("%s → %p", (id, ok) => {
    expect(CASE_ID_RE.test(id)).toBe(ok);
  });

  test("an id outside the grammar counts when the page's CaseBoard holds it", () => {
    const item = "- → Renew — loan-7, LIB-1";
    expect(read(tree("Renew=good", item)).nodes[0]?.leaf?.cases).toEqual([]);
    expect(read(tree("Renew=good", item), new Set(["loan-7"])).nodes[0]?.leaf?.cases).toEqual(["loan-7", "LIB-1"]);
  });

  test("with a board it did not read, a leaf's grammar ids count and the others are left out", () => {
    const leafOf = (item: string) => {
      const [block] = componentBlocks(parseBlocks(tree("Renew=good", item)), "RuleTree");
      return readRuleTree(block?.children ?? [], block?.attrs ?? {}, { text: visibleText, boardUnread: true }).nodes[0]?.leaf;
    };
    expect(leafOf("- → Renew in 2024 — loan-7, LIB-1")?.cases).toEqual(["LIB-1"]);
    expect(leafOf("- → Renew in 2024 — loan-7, LIB-1")?.caseSplit?.body).toBe("→ Renew in 2024");
    expect(leafOf("- → Renew — loan-7")?.cases).toEqual([]);
    expect(leafOf("- → Renew — loan-7")?.caseSplit).toBeNull();
  });
});

describe("a case on two leaves", () => {
  const twoLeaves = (a: string, b: string) => read(tree("Renew=good;Return=muted", [`- *Yes:* ${a}`, `- *No:* ${b}`].join("\n")));
  const caseFindings = (r: ReturnType<typeof read>) => r.findings.filter((f) => f.message.startsWith("case "));

  test("warns, on the second leaf, when neither names a year", () => {
    const r = twoLeaves("→ Renew — LIB-1", "→ Return — LIB-1");
    const [f] = caseFindings(r);
    expect(f?.level).toBe("warning");
    expect(f?.message).toBe("case LIB-1 is on 2 leaves that do not each name a different year: «Yes: → Renew — LIB-1», «No: → Return — LIB-1»");
    expect(f?.node).toBe(r.nodes[1]);
  });

  test.each([
    ["each names a different year", "→ Renew in 2023 — LIB-1", "→ Return in 2024 — LIB-1", 0],
    ["the year sits in the edge label", "→ Renew — LIB-1", "→ Return — LIB-1", 1],
    ["both name the same year", "→ Renew in 2024 — LIB-1", "→ Return in 2024 — LIB-1", 1],
    ["only one names a year", "→ Renew in 2024 — LIB-1", "→ Return — LIB-1", 1],
    ["a year in a longer number is no year", "→ Renew 12024 — LIB-1", "→ Return 12023 — LIB-1", 1],
    ["a year glued to a word is no year", "→ Renew FY2023 — LIB-1", "→ Return FY2024 — LIB-1", 1],
    ["1899 and 2100 are no years", "→ Renew 1899 — LIB-1", "→ Return 2100 — LIB-1", 1],
    ["1900 and 2099 are years", "→ Renew 1900 — LIB-1", "→ Return 2099 — LIB-1", 0],
    ["a year before a hyphen counts", "→ Renew 2023-24 — LIB-1", "→ Return 2025 — LIB-1", 0],
    ["a struck year is no year", "→ Renew ~~2023~~ — LIB-1", "→ Return 2024 — LIB-1", 1],
  ])("%s", (_name, a, b, n) => {
    expect(caseFindings(twoLeaves(a, b))).toHaveLength(n);
  });

  test("a year in the edge label counts", () => {
    const r = read(tree("Renew=good;Return=muted", ["- *In 2023:* → Renew — LIB-1", "- *In 2024:* → Return — LIB-1"].join("\n")));
    expect(caseFindings(r)).toEqual([]);
  });
});

describe("outcomes=", () => {
  const body = ["- *Yes:* → Renew — LIB-1", "- *No:* → Return — LIB-2", "- *Maybe:* → Return — LIB-3"].join("\n");

  test("an untoned outcome warns once, with its leaf count, on its first leaf", () => {
    const r = read(tree("Renew=good", body));
    expect(r.findings.map((f) => f.message)).toEqual(['outcome "Return" has no tone in outcomes (2 leaves), first at leaf «No: → Return — LIB-2»']);
    expect(r.findings[0]?.node).toBe(r.nodes[1]);
  });

  test("accepts the StatusRows tones and yes/no/fix", () => {
    const r = read(tree("Renew=yes;Return=fix", body));
    expect(r.findings).toEqual([]);
    expect(leaves(r.nodes).map((n) => n.leaf?.tone)).toEqual(["good", "warn", "warn"]);
    expect(read(tree("Renew= info ;Return=no", body)).nodes.map((n) => n.leaf?.tone)).toEqual(["info", "muted", "muted"]);
  });

  test("reads the tone words case-sensitively", () => {
    expect(read(tree("Renew=Good;Return=YES", body)).findings.map((f) => f.message)[0]).toBe(
      'outcomes entry not read (use "Outcome=good|warn|info|muted|yes|no|fix"): Renew=Good; Return=YES',
    );
  });

  test("an entry it cannot read is a warning naming the accepted words", () => {
    const r = read(tree("Renew=green;Return=muted", body));
    expect(r.findings.map((f) => [f.level, f.message])).toEqual([
      ["warning", 'outcomes entry not read (use "Outcome=good|warn|info|muted|yes|no|fix"): Renew=green'],
      ["warning", 'outcome "Renew" has no tone in outcomes, first at leaf «Yes: → Renew — LIB-1»'],
    ]);
  });

  test("a label that names no leaf outcome is info", () => {
    const r = read(tree("Renew=good;Return=muted;Extend=warn", body));
    expect(r.findings.map((f) => [f.level, f.message])).toEqual([["info", "outcomes names no leaf outcome: Extend"]]);
  });

  test("labels match without emphasis or case", () => {
    expect(read(tree("renew=good;**Return**=muted", body)).findings).toEqual([]);
  });
});
