import { describe, expect, test } from "bun:test";
import { componentBlocks, parseBlocks } from "./markdown-ast.ts";
import { visibleText } from "./report-top.ts";
import { RULE_TREE_CASE_ID_RE, readRuleTree, ruleTreeNodes, type RuleNode } from "./rule-tree.ts";

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
    // A dash inside a code span cuts no outcome and starts no case tail.
    ["→ Renew `a — b`", "Renew `a — b`", []],
    ["*Yes:* → Renew `x — LIB-1`", "Renew `x — LIB-1`", []],
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
    // The closer is the first one, outside code and link destinations.
    ["*→ Renew* and *more* — LIB-1", "Renew", ["LIB-1"]],
    ["*→ Renew `a* b` c* — LIB-1", "Renew `a* b` c", ["LIB-1"]],
    ["*→ [Renew](http://x/a*,b) c* — LIB-1", "Renew c", ["LIB-1"]],
    // A dash inside link text cuts no outcome and starts no case tail.
    ["→ [Renew — LIB-2](http://x)", "Renew — LIB-2", []],
    ["→ [Renew — more](http://x) — LIB-1", "Renew — more", ["LIB-1"]],
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
    expect(RULE_TREE_CASE_ID_RE.test(id)).toBe(ok);
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
    // Each piece carries the id it reads as; the unknown one and a struck one read as none.
    expect(leafOf("- → Renew — loan-7, LIB-1, ~~LIB-2~~, _LIB-7_ <!-- LIB-1 -->")?.caseSplit?.ids).toEqual([null, "LIB-1", null, "LIB-7"]);
    expect(leafOf("- → Renew — loan-7")?.cases).toEqual([]);
    expect(leafOf("- → Renew — loan-7")?.caseSplit).toBeNull();
  });
});

describe("a case on two leaves", () => {
  const caseFindings = (r: ReturnType<typeof read>) => r.findings.filter((f) => f.message.startsWith("case "));
  const warnsOn = (lines: readonly string[], title?: string) => caseFindings(read(tree("Renew=good;Return=muted", lines.join("\n"), title))).length > 0;
  /** Two root leaves sharing LIB-1, `a` and `b` their edge labels. */
  const twoLeaves = (a: string, b: string) => read(tree("Renew=good;Return=muted", [`- *${a}:* → Renew — LIB-1`, `- *${b}:* → Return — LIB-1`].join("\n")));

  test("warns, on the second leaf, when neither names a year", () => {
    const r = twoLeaves("Yes", "No");
    const [f] = caseFindings(r);
    expect(f?.level).toBe("warning");
    expect(f?.message).toBe("case LIB-1 is on 2 leaves that do not each name a different year: «Yes: → Renew — LIB-1», «No: → Return — LIB-1»");
    expect(f?.node).toBe(r.nodes[1]);
  });

  // The year grammar, read from an edge label's visible text.
  test.each([
    ["each names a different year", "In 2023", "In 2024", 0],
    ["no edge label names a year", "Yes", "No", 1],
    ["both name the same year", "In 2024", "In 2024", 1],
    ["only one names a year", "In 2024", "No", 1],
    ["a year in a longer number is no year", "Code 12024", "Code 12023", 1],
    ["a year glued to a word is no year", "FY2023", "FY2024", 1],
    ["1899 and 2100 are no years", "In 1899", "In 2100", 1],
    ["1900 and 2099 are years", "In 1900", "In 2099", 0],
    ["a year before a hyphen counts", "2023-24", "2025", 0],
    ["a lowercase id is no case id, so its year counts", "fy-2024", "fy-2025", 0],
    ["a year inside a case id is no year", "See FY-2024", "See FY-2025", 1],
    ["a year beside a case id counts", "In 2024, see LIB-9", "In 2025, see LIB-9", 0],
    ["a struck year is no year", "~~2023~~", "2024", 1],
    ["a struck year beside a kept one", "~~2024~~ 2025", "2024", 0],
    ["a year in a code span counts", "In `2024`", "In `2025`", 0],
    ["a year in a link destination is no year", "See [rule](loans/2024)", "See [rule](loans/2025)", 1],
    ["a year in link text counts", "See [rule 2024](loans)", "See [rule 2025](loans)", 0],
    ["a year inside a bare URL is no year", "See http://x/2024/a", "See http://x/2025/a", 1],
    ["a year inside a www URL is no year", "See www.x.no/2024/a", "See www.x.no/2025/a", 1],
  ])("edge labels: %s", (_name, a, b, n) => {
    expect(caseFindings(twoLeaves(a, b))).toHaveLength(n);
  });

  test("a year on the leaf's path counts: a tree that splits on the year above its leaves", () => {
    const r = read(tree("Renew=good;Return=muted", ["- *2024:*", "  - → Renew — LIB-1", "- *2025:*", "  - → Return — LIB-1"].join("\n")));
    expect(caseFindings(r)).toEqual([]);
    expect(leaves(r.nodes).map((n) => n.leaf?.years)).toEqual([["2024"], ["2025"]]);
  });

  test("a leaf's own edge label wins over its parent's", () => {
    const r = read(tree("Renew=good;Return=muted", ["- *2024:*", "  - *In 2025:* → Renew — LIB-1", "- *2025:*", "  - → Return — LIB-1"].join("\n")));
    expect(leaves(r.nodes).map((n) => n.leaf?.years)).toEqual([["2025"], ["2025"]]);
    expect(caseFindings(r)).toHaveLength(1);
  });

  test("a year-naming edge label's years pass through a node that names none", () => {
    const body = ["- *2024:*", "  - Is it reserved?", "    - → Renew — LIB-1", "- *2025:*", "  - Is it reserved?", "    - → Return — LIB-1"];
    const r = read(tree("Renew=good;Return=muted", body.join("\n")));
    expect(leaves(r.nodes).map((n) => n.leaf?.years)).toEqual([["2024"], ["2025"]]);
    expect(caseFindings(r)).toEqual([]);
  });

  test("an id in the case tail is no year, also one a board the lint did not read may hold", () => {
    const [block] = componentBlocks(parseBlocks(tree("Renew=good;Return=muted", "- → Renew — LIB-1, loan_2024\n- → Return — LIB-1, loan_2025")), "RuleTree");
    const r = readRuleTree(block?.children ?? [], block?.attrs ?? {}, { text: visibleText, boardUnread: true });
    expect(leaves(r.nodes).map((n) => n.leaf?.years)).toEqual([[], []]);
    expect(caseFindings(r)).toHaveLength(1);
  });

  test("a year on the path and on the leaf is named once", () => {
    const r = read(tree("Renew=good", ["- *2024:*", "  - *In 2024:* → Renew — LIB-1"].join("\n")));
    expect(leaves(r.nodes).map((n) => n.leaf?.years)).toEqual([["2024"]]);
  });

  test("a 2024 leaf under a 2024 parent and a 2024 leaf under a 2025 parent share 2024", () => {
    const r = read(tree("Renew=good;Return=muted", ["- *2024:*", "  - *In 2024:* → Renew — LIB-1", "- *2025:*", "  - *In 2024:* → Return — LIB-1"].join("\n")));
    expect(leaves(r.nodes).map((n) => n.leaf?.years)).toEqual([["2024"], ["2024"]]);
    expect(caseFindings(r)).toHaveLength(1);
  });

  // Named regressions: each tree is one a reader may write, its verdict the rule's.
  test.each([
    // An incidental year in a leaf's prose does not replace its parent's edge label.
    ["a prose year in a leaf under one year parent", ["- *2025:*", "  - → Renew (rule since 2019) — LIB-1", "  - → Return — LIB-1"], true],
    // An incidental year in prose below the split does not hide the split.
    ["a prose year below a year split", ["- *2024:*", "  - Applies since 2019?", "    - → Renew — LIB-1", "- *2025:*", "  - Applies since 2019?", "    - → Return — LIB-1"], false],
    ["a parent's prose names both years", ["- Rule changed between 2024 and 2025", "  - *2024:* → Renew — LIB-1", "  - *2025:* → Return — LIB-1"], false],
    ["a parent's edge label names an earlier year: the deepest wins", ["- *From 2024:*", "  - *2024:* → Renew — LIB-1", "  - *2025:* → Return — LIB-1"], false],
    // The rule's accepted cost: an edge label's incidental year counts.
    ["an incidental year in a leaf's edge label", ["- *2025:*", "  - *Yes (since 2019):* → Renew — LIB-1", "  - *No:* → Return — LIB-1"], false],
    ["a year only in an ancestor's prose", ["- Loans from 2024", "  - → Renew — LIB-1", "- Loans from 2025", "  - → Return — LIB-1"], true],
    ["a year only in the leaves' prose", ["- → Renew in 2023 — LIB-1", "- → Return in 2024 — LIB-1"], true],
    ["a case id in prose", ["- See FY-2024", "  - → Renew — LIB-1", "- See FY-2025", "  - → Return — LIB-1"], true],
    ["a lowercase id in prose", ["- See fy-2024", "  - → Renew — LIB-1", "- See fy-2025", "  - → Return — LIB-1"], true],
  ] as [string, string[], boolean][])("%s", (_name, lines, warns) => {
    expect(warnsOn(lines)).toBe(warns);
  });

  test("a year only in the title is on no path", () => {
    expect(warnsOn(["- *Yes:* → Renew — LIB-1", "- *No:* → Return — LIB-1"], "Renewals in 2024")).toBe(true);
  });

  test("two leaves under one year parent share that year", () => {
    const r = read(tree("Renew=good;Return=muted", ["- *2024:*", "  - *Yes:* → Renew — LIB-1", "  - *No:* → Return — LIB-1"].join("\n")));
    expect(caseFindings(r)).toHaveLength(1);
  });
});

// The rule, enumerated: leaves A and B share LIB-1, each three levels deep
// (grandparent, parent, leaf), every node carrying an edge label. A year sits in
// up to two places on each path; the title may hold one too. The oracle below
// states the rule on its own: a leaf names the years of the deepest edge label on
// its path that names any, and two leaves sharing a case warn unless both name
// years and none of A's is one of B's.
describe("a case on two leaves, every year placement", () => {
  const PLACES = ["leafEdge", "leafProse", "parentEdge", "parentProse", "gpEdge", "gpProse"] as const;
  type Place = (typeof PLACES)[number];
  type Spec = Partial<Record<Place, string>>;
  const YEARS = ["2024", "2025"];

  const specs: Spec[] = [{}];
  for (const p of PLACES) for (const y of YEARS) specs.push({ [p]: y });
  for (let i = 0; i < PLACES.length; i++) {
    for (let j = i + 1; j < PLACES.length; j++) {
      for (const y of YEARS) for (const z of YEARS) specs.push({ [PLACES[i] as Place]: y, [PLACES[j] as Place]: z });
    }
  }

  const edge = (name: string, y: string | undefined) => `*${name}${y ? ` ${y}` : ""}:*`;
  const gp = (s: Spec, name: string) => `- ${edge(name, s.gpEdge)} Is it a loan${s.gpProse ? ` since ${s.gpProse}` : ""}?`;
  const parent = (s: Spec, name: string) => `  - ${edge(name, s.parentEdge)} Is it reserved${s.parentProse ? ` since ${s.parentProse}` : ""}?`;
  const leaf = (s: Spec, name: string, outcome: string) =>
    `    - ${edge(name, s.leafEdge)} → ${outcome}${s.leafProse ? ` (rule since ${s.leafProse})` : ""} — LIB-1`;

  type Topology = "apart" | "shared grandparent" | "shared parent";
  const same = (a: Spec, b: Spec, ps: readonly Place[]) => ps.every((p) => a[p] === b[p]);
  function build(t: Topology, a: Spec, b: Spec): string[] | null {
    if (t === "apart") return [gp(a, "GA"), parent(a, "PA"), leaf(a, "LA", "Renew"), gp(b, "GB"), parent(b, "PB"), leaf(b, "LB", "Return")];
    if (!same(a, b, ["gpEdge", "gpProse"])) return null;
    if (t === "shared grandparent") return [gp(a, "G"), parent(a, "PA"), leaf(a, "LA", "Renew"), parent(b, "PB"), leaf(b, "LB", "Return")];
    if (!same(a, b, ["parentEdge", "parentProse"])) return null;
    return [gp(a, "G"), parent(a, "P"), leaf(a, "LA", "Renew"), leaf(b, "LB", "Return")];
  }

  // The oracle: THE RULE in a few lines, sharing nothing with the reader.
  const named = (s: Spec) => s.leafEdge ?? s.parentEdge ?? s.gpEdge;
  const oracleWarns = (a: Spec, b: Spec) => {
    const ya = named(a);
    const yb = named(b);
    return !(ya && yb && ya !== yb);
  };

  const caseFindingsOf = (r: ReturnType<typeof read>) => r.findings.filter((f) => f.message.startsWith("case "));
  // 73 specs a leaf; two titles. Apart: 2·73². Shared: only pairs that agree on the shared nodes.
  const TABLE_SIZE: Record<Topology, number> = { apart: 10658, "shared grandparent": 2834, "shared parent": 610 };

  const describeSpec = (s: Spec) => PLACES.filter((p) => s[p]).map((p) => `${p}=${s[p]}`).join("+") || "none";

  test.each(["apart", "shared grandparent", "shared parent"] as Topology[])("%s", (t) => {
    const wrong: string[] = [];
    let n = 0;
    for (const title of ["Can the book be renewed?", "Renewals in 2024"]) {
      for (const a of specs) {
        for (const b of specs) {
          const lines = build(t, a, b);
          if (!lines) continue;
          n++;
          const got = caseFindingsOf(read(tree("Renew=good;Return=muted", lines.join("\n"), title))).length > 0;
          const want = oracleWarns(a, b);
          if (got !== want) wrong.push(`A ${describeSpec(a)} | B ${describeSpec(b)} | title ${title.includes("2024") ? "2024" : "none"}: want ${want ? "warn" : "none"}`);
        }
      }
    }
    expect({ wrong: wrong.slice(0, 40), wrongCount: wrong.length }).toEqual({ wrong: [], wrongCount: 0 });
    expect(n).toBe(TABLE_SIZE[t]);
  });
});

describe("what drops silently is named", () => {
  const notLeaf = (r: ReturnType<typeof read>) => r.findings.filter((f) => f.message.includes("is not read as a leaf"));
  const noCases = (r: ReturnType<typeof read>) => r.findings.filter((f) => f.message.includes("reads as no case ids"));

  const ITALICS = "write the edge label in italics (*label:*)";
  const ARROW = "write the arrow as →";
  test.each([
    ["an ASCII arrow", "-> Yes", ARROW],
    ["an ASCII arrow after an edge label", "*Yes:* -> Renew", ARROW],
    ["a bold edge label", "**yes:** → Yes", ITALICS],
    ["a bold edge label with the colon outside", "**yes**: → Yes", ITALICS],
    ["a bold italic edge label", "***yes:*** → Yes", ITALICS],
    ["an underscore bold edge label", "__yes:__ → Yes", ITALICS],
    ["a bold edge label and an ASCII arrow", "**yes:** -> Yes", `${ITALICS}; ${ARROW}`],
    ["a bold italic arrow run", "***→ Yes***", 'the "***" before → is not read (write →, *→ or **→)'],
    ["an ASCII arrow in a bold run", "**-> Yes**", ARROW],
    ["a lead with * in a code span", "*`a*b`:* → Yes", "the text before → is not read as an edge label"],
    ["a bold lead with an arrow in a code span", "**`a->b`:** → Yes", ITALICS],
  ])("an item that starts like a leaf but is not one: %s", (_name, item, remedy) => {
    const r = read(tree("Yes=good;Renew=good", `- ${item}`));
    expect(leaves(r.nodes)).toEqual([]);
    const [f, ...more] = notLeaf(r);
    expect(more).toEqual([]);
    expect(f?.level).toBe("info");
    expect(f?.node).toBe(r.nodes[0]);
    expect(f?.message).toBe(`item «${visibleText(item)}» is not read as a leaf: ${remedy}`);
  });

  test.each([
    ["an arrow inside code", "- Is `a → b` true?"],
    ["no arrow", "- Is the book reserved?"],
    ["a leaf", "- *Yes:* → Renew"],
    ["an arrow in a link destination", "- See [the rule](http://x/→)"],
    ["an ASCII arrow inside the text", "- Is a -> b true?"],
    ["an arrow inside the text", "- Loan → reservation → return"],
    ["an arrow after text that follows an edge label", "- *Yes:* the loan → a return"],
    ["an arrow after text that follows a bold lead", "- **Note:** a loan → a return"],
    ["an arrow at the start of a code span", "- `→ Renew`"],
  ])("no finding for %s", (_name, item) => {
    expect(notLeaf(read(tree("Renew=good", item)))).toEqual([]);
  });

  test.each([
    ["a full stop after the id", "→ Renew — LIB-1."],
    ["a lowercase id", "→ Renew — lib-1"],
    ["ids joined by a word", "→ Renew — LIB-7 og LIB-8"],
    ["a board id the page has no board for", "→ Renew — LIB-1, loan-7"],
  ])("a case tail that reads as no ids: %s", (_name, item) => {
    const r = read(tree("Renew=good", `- ${item}`));
    expect(r.nodes[0]?.leaf?.cases).toEqual([]);
    const [f, ...more] = noCases(r);
    expect(more).toEqual([]);
    expect(f?.level).toBe("info");
    expect(f?.node).toBe(r.nodes[0]);
    expect(f?.message).toBe(`leaf «${visibleText(item)}»: the text after the last — reads as no case ids`);
  });

  test.each([
    ["cases", "→ Renew — LIB-1"],
    ["no dash", "→ Renew"],
    ["a struck tail", "→ Renew — ~~LIB-1~~"],
    ["a dash inside code", "→ Renew `a — b`"],
  ])("no tail finding for %s", (_name, item) => {
    expect(noCases(read(tree("Renew=good", `- ${item}`)))).toEqual([]);
  });

  test("on a page with a board it did not read, a tail of ids outside the grammar may be board ids", () => {
    const tailOf = (item: string) => {
      const [block] = componentBlocks(parseBlocks(tree("Renew=good", item)), "RuleTree");
      return readRuleTree(block?.children ?? [], block?.attrs ?? {}, { text: visibleText, boardUnread: true }).findings.filter((f) =>
        f.message.includes("reads as no case ids"),
      );
    };
    expect(tailOf("- → Renew — loan-7")).toEqual([]);
    expect(tailOf("- → Renew — lib-1")).toEqual([]);
  });

  test("with the board read, an id the board lacks is named", () => {
    const r = read(tree("Renew=good", "- → Renew — loan-8"), new Set(["loan-7"]));
    expect(noCases(r)).toHaveLength(1);
    expect(noCases(read(tree("Renew=good", "- → Renew — loan-7"), new Set(["loan-7"])))).toEqual([]);
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
