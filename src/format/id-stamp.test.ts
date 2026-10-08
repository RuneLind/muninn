/**
 * The renderer's final pass (D8, D12): `data-q-state` on every id-led
 * DecisionLog item and the id nouns before the DecisionLog and Query chips,
 * added after `uniqueLogAnchors` and `retargetQuestionLinks`. The reader's
 * pills count from the stamp; the browser half is `e2e/wiki-lens.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { formatWebHtml } from "../web/web-format.ts";
import type { QuestionRenderOptions } from "./question.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";

const LABELS = {
  S: { one: "Spørsmål", other: "spørsmål" },
  D: { one: "Beslutning", other: "beslutninger" },
  Q: { one: "Query", other: "queries" },
};
const opts: QuestionRenderOptions = { questionsTo: [], language: "no", answerable: false };
/** The reader path (`renderWikiHtml`): the stamps and the fold classes. */
const R = { reader: true } as const;

/** 11 D items (D1 repeated in a second log), S1 S2 S6 S7 S8 open, S5 closed
 *  with the canonical phrase, S3 struck, S4 with a non-canonical close. */
const ACCEPTANCE_4 = [
  "<DecisionLog>",
  "",
  ...Array.from({ length: 11 }, (_, i) => `- **D${i + 1}** — Beslutning nummer ${i + 1}.`),
  "- **S1** — Åpent spørsmål.",
  "- **S2** — Åpent spørsmål to.",
  "- ~~**S3** — Strøket.~~",
  "- **S5** — Lukket 07.10 (D10).",
  "- **S6** — Åpent.",
  "- **S7** — Åpent.",
  "- **S8** — Åpent.",
  "",
  "</DecisionLog>",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Gjentatt.",
  "",
  "</DecisionLog>",
].join("\n");

const items = (html: string) =>
  [...html.matchAll(/<li class="dl-item[^"]*"(?: value="\d+")? id="([^"]+)" data-q-state="(\w+)"(?: data-q-open)?>(?:<span class="id-noun" data-reader-only>[^<]*<\/span> )?<a class="dl-id" href="#\1">([^<]*)<\/a>/g)].map(
    (m) => ({ anchor: m[1]!, state: m[2]!, id: m[3]! }),
  );

describe("data-q-state (D8)", () => {
  test("acceptance 4: 11 unique decisions, 5 open, anchors unique", () => {
    const html = formatWebHtml(ACCEPTANCE_4, R);
    const all = items(html);
    expect(all).toHaveLength(19);
    // Every id-led item is stamped.
    expect((html.match(/<li class="dl-item(?! dl-noid)/g) ?? []).length).toBe(19);
    const decisions = new Set(all.filter((i) => /^D\d{1,4}$/.test(i.id)).map((i) => i.id));
    const open = new Set(all.filter((i) => !/^D\d{1,4}$/.test(i.id) && i.state === "open").map((i) => i.id));
    expect(decisions.size).toBe(11);
    expect([...open]).toEqual(["S1", "S2", "S6", "S7", "S8"]);
    expect(all.find((i) => i.id === "S3")!.state).toBe("closed");
    expect(all.find((i) => i.id === "S5")!.state).toBe("decided");
    const anchors = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(anchors).toContain("d1-2");
  });

  test("a non-canonical close stays open (plan review: S5's «Lukket 07.10: nei i prinsipp (D10)»)", () => {
    const html = formatWebHtml("<DecisionLog>\n\n- **D10** — Nei.\n- **S5** — Lukket 07.10: nei i prinsipp (D10).\n\n</DecisionLog>", R);
    expect(items(html).find((i) => i.id === "S5")!.state).toBe("open");
  });

  test("a page with no DecisionLog is untouched; chat does not stamp", () => {
    expect(formatWebHtml("Text with D1 in it.", R)).not.toContain("data-q-state");
    expect(formatWebHtml("<DecisionLog>\n\n- **D1** — x\n\n</DecisionLog>", R)).toContain('id="d1" data-q-state="open">');
    expect(formatWebHtml("<DecisionLog>\n\n- **D1** — x\n\n</DecisionLog>")).not.toContain("data-q-state");
  });
});

describe("the anchor passes on a stamped page", () => {
  // A Query card takes `s1` and `d7`, so `uniqueLogAnchors` renames the items,
  // and `retargetQuestionLinks` must still point the card's links at them.
  const md = [
    '<Query id="S1" question="A query holding the s1 anchor">',
    "",
    "Body.",
    "",
    "</Query>",
    "",
    '<Query id="D7" question="A query holding the d7 anchor" />',
    "",
    '<Question id="S1">',
    "",
    "Q?",
    "",
    "</Question>",
    "",
    "<DecisionLog>",
    "",
    "- **D7** — A decision.",
    "- **S1** — Q? Lukket 08.10 (D7).",
    "",
    "</DecisionLog>",
  ].join("\n");

  test("uniqueLogAnchors still renames, retargetQuestionLinks still follows, with and without labels", () => {
    for (const idLabels of [undefined, LABELS]) {
      const html = formatWebHtml(md, { ...R, question: opts, idLabels });
      const all = items(html);
      expect(all.map((i) => i.anchor)).toEqual(["d7-2", "s1-2"]);
      expect(html).toContain('<a class="q-id" href="#s1-2">S1</a>');
      expect(html).toContain('<a class="q-decision" href="#d7-2">D7</a>');
      expect(all.find((i) => i.id === "S1")!.state).toBe("decided");
    }
  });

  test("the stamp and the nouns are the only difference the final pass makes", () => {
    const bare = formatWebHtml(md, { ...R, question: opts });
    const labelled = formatWebHtml(md, { ...R, question: opts, idLabels: LABELS });
    expect(labelled.replace(/<span class="id-noun" data-reader-only>[^<]*<\/span> /g, "")).toBe(bare);
  });
});

describe("id nouns (D12)", () => {
  test("a DecisionLog chip and a Query chip get the noun before them; the chip keeps the bare id", () => {
    const html = formatWebHtml(
      '<Query id="Q-14" question="How many?" />\n\n<DecisionLog>\n\n- **S1** — Open?\n- **D2** — Yes.\n- **O9** — No label.\n\n</DecisionLog>',
      { ...R, idLabels: LABELS },
    );
    expect(html).toContain('<span class="id-noun" data-reader-only>Query</span> <a class="query-id" href="#q-14">Q-14</a>');
    expect(html).toContain('data-q-state="open" data-q-open><span class="id-noun" data-reader-only>Spørsmål</span> <a class="dl-id" href="#s1">S1</a>');
    expect(html).toContain('<span class="id-noun" data-reader-only>Beslutning</span> <a class="dl-id" href="#d2">D2</a>');
    expect(html).toContain('data-q-state="open" data-q-open><a class="dl-id" href="#o9">O9</a>');
  });

  test("a question card's id chip gets no noun: the card's lead word already names it", () => {
    const html = formatWebHtml('<Question id="S1">\n\nQ?\n\n</Question>\n\n<DecisionLog>\n\n- **S1** — Q?\n\n</DecisionLog>', {
      question: opts,
      idLabels: LABELS,
    });
    expect(html).toContain('<span class="q-label">Spørsmål</span><a class="q-id" href="#s1">S1</a>');
  });

  test("a page without a <Question> still renders byte-identically with or without the question option", () => {
    const md = "<DecisionLog>\n\n- **O3** — Closed 2026-10-08 (D99).\n\n</DecisionLog>\n\nText.";
    const html = formatWebHtml(md, R);
    expect(html).toContain('data-q-state="closed"');
    expect(formatWebHtml(md, { ...R, question: opts })).toBe(html);
  });
});

describe("<Fold for=…> and the agent-context titles (D5, D22)", () => {
  test("on the reader path for=\"dev\" and for=\"agent\" become a class, any case; anything else is dropped", () => {
    expect(formatWebHtml('<Fold title="Samtalen" for="dev">\n\nx\n\n</Fold>', R)).toContain('<details class="fold fold-for-dev">');
    expect(formatWebHtml('<Fold title="Log" for="Agent">\n\nx\n\n</Fold>', R)).toContain('<details class="fold fold-for-agent">');
    expect(formatWebHtml('<Fold title="Log" for="x y">\n\nx\n\n</Fold>', R)).toContain('<details class="fold">');
  });
  test("a fold titled with an agent-context name is marked", () => {
    expect(formatWebHtml('<Fold title="Nåtilstand">\n\nx\n\n</Fold>', R)).toContain('<details class="fold fold-agent-context">');
    expect(formatWebHtml('<Fold title="Spørringer">\n\nx\n\n</Fold>', R)).toContain('<details class="fold">');
  });
  test("the text renderers print a for= fold in full, as any fold", () => {
    const md = '<Fold title="Samtalen" for="dev">\n\nThe whole log.\n\n</Fold>';
    for (const out of [formatTelegramHtml(md), formatSlackMrkdwn(md), formatEmailHtml(md)]) {
      expect(out).toContain("Samtalen");
      expect(out).toContain("The whole log.");
      expect(out).not.toContain("dev");
    }
  });
});

describe("fix round 1", () => {
  test("D-1: on the reader path only `for=\"dev\"` and `for=\"agent\"` become a class", () => {
    expect(formatWebHtml('<Fold title="Log" for="dev">\n\nx\n\n</Fold>', R)).toContain('<details class="fold fold-for-dev">');
    expect(formatWebHtml('<Fold title="Log" for="agent">\n\nx\n\n</Fold>', R)).toContain('<details class="fold fold-for-agent">');
    expect(formatWebHtml('<Fold title="Log" for="ops">\n\nx\n\n</Fold>', R)).toContain('<details class="fold">');
  });

  test("D-1: chat stamps no state on a DecisionLog item", () => {
    expect(formatWebHtml("<DecisionLog>\n\n- **S1** — x\n\n</DecisionLog>")).not.toContain("data-q-state");
  });

  test("D-2: a fact mark over the close phrase leaves the item's state alone", () => {
    const plain = "<DecisionLog>\n\n- **D10** — Ja.\n- **S5** Skal vi? Lukket 07.10 (D10)\n\n</DecisionLog>";
    const marked = plain.replace("Lukket 07.10", '<Fact n="9" v="ok">Lukket 07.10</Fact>');
    const state = (html: string) => /id="s5" data-q-state="(\w+)"/.exec(html)?.[1];
    expect(state(formatWebHtml(plain, R))).toBe("decided");
    expect(state(formatWebHtml(marked, R))).toBe("decided");
  });

  test("D-7: an open item counts as an open question only with an S/O id or a <Question> of that id", () => {
    const md = [
      '<Question id="G1">',
      "",
      "Q?",
      "",
      "</Question>",
      "",
      "<DecisionLog>",
      "",
      "- **S1** — Open.",
      "- **O2** — Open.",
      "- **G1** — Open, asked by a card.",
      "- **R1** — A finding.",
      "- **BM10** — A benchmark row.",
      "- **O3** — Lukket 07.10 (D1).",
      "- **D1** — A decision.",
      "",
      "</DecisionLog>",
    ].join("\n");
    const html = formatWebHtml(md, { ...R, question: opts });
    const open = [...html.matchAll(/<li class="dl-item[^"]*"[^>]*id="[^"]+"[^>]*data-q-open[^>]*>(?:<span[^>]*>[^<]*<\/span> )?<a class="dl-id" href="#[^"]+">([^<]*)<\/a>/g)].map(
      (m) => m[1],
    );
    expect(open).toEqual(["S1", "O2", "G1"]);
  });
});
