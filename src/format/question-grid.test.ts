import { describe, expect, test } from "bun:test";
import { analyzeDecisionChains } from "./decision-chain.ts";
import { parseBlocks } from "./markdown-ast.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import { QUESTION_GRID_TEXT_MAX, QUESTION_GRID_CAP, questionCardAnchor, questionGridHtml, questionGridRows, questionGridSlot } from "./question-grid.ts";

const rowsOf = (body: string, today?: string) => {
  const blocks = parseBlocks(body);
  return questionGridRows(blocks, analyzeDecisionChains(blocks, []), today);
};
const log = (...items: string[]) => ["<DecisionLog>", "", ...items, "", "</DecisionLog>", ""].join("\n");
const TODAY = "2026-11-01";

describe("questionGridRows: the state of a row", () => {
  test("a closed question carries its decision, the answer and who decided", () => {
    const [r] = rowsOf(log("- **S1** — ~~Keep this one for now?~~ Lukket 07.10 (D1).", "- **D1** — Keep it for now. It is cheap. Kari Nordmann, 07.10."));
    expect(r).toMatchObject({ id: "S1", label: "Keep this one for now?", state: "decided", decision: "D1", answer: "Keep it for now.", who: "Kari Nordmann", ageDays: null });
  });
  test("an open question has no answer", () => {
    const [r] = rowsOf(log("- **O1** — Keep it? Asked Rune, 30.10.2026."), TODAY);
    expect(r).toMatchObject({ state: "open", decision: null, answer: null, who: null, ageDays: 2 });
  });
  test("a struck question with no decision is closed, with no answer", () => {
    const [r] = rowsOf(log("- ~~**S1**~~ — Moved to the other page."));
    expect(r).toMatchObject({ state: "closed", decision: null, answer: null });
  });
  test("a close naming a decision the log lacks is closed, with no answer", () => {
    const [r] = rowsOf(log("- **S1** — Keep it? Lukket 07.10 (D9)."));
    expect(r).toMatchObject({ state: "closed", decision: null });
  });
  test("«Lukker S1» on a decision closes S1, as the chain reads it", () => {
    const [r] = rowsOf(log("- **S1** — Keep it?", "- **D1** — Keep this one for now. Lukker S1. Rune Lind, 07.10."));
    expect(r).toMatchObject({ state: "decided", decision: "D1", answer: "Keep this one for now." });
  });
  test("a question reopened after «Lukker» stays open", () => {
    const [r] = rowsOf(log("- **S1** — Keep it? Gjenåpnet 08.10.", "- **D1** — Keep it. Lukker S1. Rune Lind, 07.10."));
    expect(r).toMatchObject({ state: "open", decision: null, answer: null });
  });
  test("a reversed decision reads its struck sentence and says so", () => {
    const [r] = rowsOf(log("- **S1** — Keep this one for now? Lukket 07.10 (D1).", "- **D1** — ~~Keep this one for now.~~ Snudd 09.10: drop it. Rune Lind, 09.10."));
    expect(r).toMatchObject({ state: "decided", reversed: true, answer: "Keep this one for now." });
  });
  test("findings and decisions are no rows", () => {
    expect(rowsOf(log("- **F1** — A finding.", "- **D1** — A decision. Rune Lind, 07.10.", "- **H1** — A hypothesis."))).toEqual([]);
  });
  test("an id with a card counts whatever its letters", () => {
    const body = log("- **Q1** — Keep it?") + '\n<Question id="Q1">\n\nKeep it?\n\n</Question>\n';
    expect(rowsOf(body)[0]).toMatchObject({ id: "Q1", hasCard: true });
  });
  test("a card shows on an open row only when one exists", () => {
    const body = log("- **O1** — With a card?", "- **O2** — Without?") + '\n<Question id="O1">\n\nWith?\n\n</Question>\n';
    expect(rowsOf(body).map((r) => r.hasCard)).toEqual([true, false]);
  });
  test("open first, then by number, not as written", () => {
    const ids = rowsOf(log("- **S10** — Ten? Lukket 07.10 (D1).", "- **S2** — Two?", "- **S1** — One? Lukket 07.10 (D1).", "- **S11** — Eleven?", "- **D1** — Yes. Rune Lind, 07.10.")).map((r) => r.id);
    expect(ids).toEqual(["S2", "S11", "S1", "S10"]);
  });
});

describe("questionGridRows: what a row reads", () => {
  test("a short question keeps out its close phrase", () => {
    expect(rowsOf(log("- **O1** — Glossary? Closed 08.10 (D1).", "- **D1** — Use the glossary block here. Rune, 08.10."))[0]!.label).toBe("Glossary?");
  });
  test("a short question keeps out its asked phrase", () => {
    expect(rowsOf(log("- **O1** — Who? Asked Rune, 30.10.2026."))[0]!.label).toBe("Who?");
  });
  test("a short answer keeps out its date tail, so who shows once", () => {
    const [r] = rowsOf(log("- **O1** — How many shards should it run? Closed 13.10 (D1).", "- **D1** — Four shards. Rune, 13.10.2026."));
    expect(r).toMatchObject({ answer: "Four shards.", who: "Rune" });
  });
  test("an abbreviation does not cut a question", () => {
    const q = "Should the rule in art. 5 hold for this kind of store?";
    expect(rowsOf(log(`- **S1** — ${q} Asked Kari, 30.10.2026.`))[0]!.label).toBe(q);
  });
  test("an item with no question mark reads its first sentence", () => {
    expect(rowsOf(log("- ~~**S1**~~ — Moved to the other page for good. It waits there."))[0]!.label).toBe("Moved to the other page for good.");
  });
  test("a short item with no question mark keeps out its close phrase", () => {
    expect(rowsOf(log("- **S1** — Moved on. Closed 07.10 (D9)."))[0]!.label).toBe("Moved on.");
  });
  test("a row reads the log's first sentence, so a statement before a question stays out", () => {
    expect(rowsOf(log("- **O1** — The route reads the page key on every reload. Should it read the slug?"))[0]!.label).toBe("The route reads the page key on every reload.");
  });
  test("a question mark inside code does not end the row", () => {
    expect(rowsOf(log("- **O1** — Does `a?.b` hold for the store? Asked Kari, 30.10.2026."))[0]!.label).toBe("Does a?.b hold for the store?");
  });
  test("code keeps its text in a row, on both the question and the answer", () => {
    const [r] = rowsOf(log("- ~~**S1**~~ — The `List<T>` type moved to the other page. It waits there for good."));
    expect(r).toMatchObject({ label: "The List<T> type moved to the other page.", answer: "It waits there for good." });
  });
  test("a bookkeeping word in prose is no bookkeeping", () => {
    expect(rowsOf(log("- ~~**S1**~~ — The Closed state stays in the store for now."))[0]!.label).toBe("The Closed state stays in the store for now.");
  });
  test("a close with its answer after a colon reads that answer", () => {
    const [r] = rowsOf(log("- ~~**O2**~~ — Does the cache outlive a restart? Closed 08.10: the cache lives on disk, so it stays (D11).", "- **D11** — Keep the cache on disk. Kari, 08.10."));
    expect(r).toMatchObject({ state: "closed", answer: "the cache lives on disk, so it stays (D11)." });
  });
  test("a short own answer keeps out a close phrase and a date tail", () => {
    expect(rowsOf(log("- ~~**S1**~~ — Is this one still open? Yes, keep. Closed 07.10 (D9)."))[0]!.answer).toBe("Yes, keep.");
    expect(rowsOf(log("- ~~**S1**~~ — Is this one still open? Nei. Kari Nordmann, 06.10.2026."))[0]!.answer).toBe("Nei.");
  });
  test.each(["Closed 07.10 (D9).", "Lukket 07.10 (D9).", "Reopened 07.10.", "Gjenåpnet 07.10.", "Answered 2026-10-07.", "Besvart 07.10.", "Asked Kari, 07.10.", "Spurt Kari 07.10."])("the stamp «%s» stays out of a short item", (stamp) => {
    expect(rowsOf(log(`- **S1** — Moved on. ${stamp}`))[0]!.label).toBe("Moved on.");
  });
  test("a stamp inside a longer word is no stamp, and an item opening with a stamp keeps its text", () => {
    expect(rowsOf(log("- **S1** — ReClosed 07.10 is what the store logs."))[0]!.label).toBe("ReClosed 07.10 is what the store logs.");
    expect(rowsOf(log("- **S1** — Closed 07.10 (D9)."))[0]!.label).toBe("Closed 07.10 (D9).");
  });
  test("a closed row's own answer is clipped", () => {
    expect(rowsOf(log(`- ~~**S1**~~ — Is this one still open? Yes, ${"x".repeat(300)} here.`))[0]!.answer!.length).toBeLessThanOrEqual(QUESTION_GRID_TEXT_MAX);
  });
  test("a decision that holds only its tail has no answer", () => {
    expect(rowsOf(log("- **S1** — Is this one still open? Closed 07.10 (D1).", "- **D1** — Kari, 07.10."))[0]!.answer).toBeNull();
  });
  test("a closed row reads the answer its own item holds", () => {
    const [r] = rowsOf(log("- ~~**S1**~~ — Does the fault happen in prod? Yes: 3 runs in one week. The analysis has more."));
    expect(r).toMatchObject({ state: "closed", label: "Does the fault happen in prod?", answer: "Yes: 3 runs in one week.", decision: null });
  });
  test("a closed row keeps its close phrase out of the answer", () => {
    expect(rowsOf(log("- **S1** — Keep this one for now? Closed 07.10 (D9)."))[0]!.answer).toBeNull();
  });
  test("«superseded by Dn» names that decision and reads its answer", () => {
    const [r] = rowsOf(log("- **O1** — Which keys does the store use? Answered 2026-10-06, superseded by D7.", "- **D7** — The store keys on the group id. Rune, 06.10."));
    expect(r).toMatchObject({ decision: "D7", answer: "The store keys on the group id.", who: "Rune" });
  });
  test("«superseded by» a question is no decision", () => {
    const [r] = rowsOf(log("- **O1** — Which keys does the store use? Superseded by O2.", "- **O2** — Which keys does the new store use?"));
    expect(r).toMatchObject({ id: "O2", state: "open" });
    expect(rowsOf(log("- **O1** — Which keys does the store use? Superseded by O2.", "- **O2** — Which keys does the new store use?"))[1]).toMatchObject({ id: "O1", state: "closed", decision: null, answer: "Superseded by O2.", who: null });
  });
  test("a long question and a long answer are clipped", () => {
    const long = "x".repeat(300);
    const [r] = rowsOf(log(`- **O1** — Is ${long} fine? Closed 13.10 (D1).`, `- **D1** — It is ${long} fine. Rune, 13.10.`));
    expect(r!.label.length).toBeLessThanOrEqual(QUESTION_GRID_TEXT_MAX);
    expect(r!.label.endsWith("…")).toBe(true);
    expect(r!.answer!.length).toBeLessThanOrEqual(QUESTION_GRID_TEXT_MAX);
  });
});

describe("questionGridRows: the age of an open row", () => {
  const age = (body: string, today: string | undefined = TODAY) => rowsOf(body, today)[0]!.ageDays;
  const lane = (since: string, item = "- **S1**") => `<NextMoves>\n\n<Lane kind="waiting" since="${since}">\n\n${item}\n\n</Lane>\n\n</NextMoves>\n\n`;

  test("a waiting lane's since, ISO or house form", () => {
    expect(age(lane("2026-10-28") + log("- **S1** — Keep it?"))).toBe(4);
    expect(age(lane("28.10.2026") + log("- **S1** — Keep it?"))).toBe(4);
  });
  test("the lane beats the asked phrase", () => {
    expect(age(lane("2026-10-28") + log("- **S1** — Keep it? Asked Rune, 01.09.2026."))).toBe(4);
  });
  test("a lane of another kind or naming another id gives no age", () => {
    expect(age(`<NextMoves>\n\n<Lane kind="you" since="2026-10-28">\n\n- **S1**\n\n</Lane>\n\n</NextMoves>\n\n` + log("- **S1** — Keep it?"))).toBeNull();
    expect(age(lane("2026-10-28", "- **S2**") + log("- **S1** — Keep it?"))).toBeNull();
  });
  test("an asked phrase, with or without a year", () => {
    expect(age(log("- **S1** — Keep it? Spurt Kari 30.10."))).toBe(2);
    expect(age(log("- **S1** — Keep it? Asked Rune, 2026-10-30."))).toBe(2);
  });
  test("a date elsewhere in the question is no age", () => {
    expect(age(log("- **S1** — Should the backups from 12.03 stay?"))).toBeNull();
  });
  test("no render day, or a date after it, gives no age", () => {
    expect(rowsOf(log("- **S1** — Keep it? Asked Rune, 30.10.2026."))[0]!.ageDays).toBeNull();
    expect(age(log("- **S1** — Keep it? Asked Rune, 30.11.2026."))).toBeNull();
  });
});

describe("questionGridHtml", () => {
  const row = (id: string, state: "open" | "decided", extra = {}) => ({ id, label: `${id}?`, state, ageDays: null, hasCard: false, decision: state === "open" ? null : "D1", answer: state === "open" ? null : "Yes", who: null, reversed: false, ...extra });

  test("draws from 3 questions, and is reader-only", () => {
    expect(questionGridHtml([row("S1", "open"), row("S2", "open")], "en")).toBe("");
    expect(questionGridHtml([row("S1", "open"), row("S2", "open"), row("S3", "open")], "en")).toContain("data-reader-only");
  });
  test("counts in the wiki's language", () => {
    const rows = [row("S1", "open"), row("S2", "decided"), row("S3", "decided")];
    expect(questionGridHtml(rows, "en")).toContain("1 open of 3");
    expect(questionGridHtml(rows, "no")).toContain("1 åpen av 3");
    expect(questionGridHtml([row("S1", "open"), row("S2", "open"), row("S3", "decided")], "no")).toContain("2 åpne av 3");
    expect(questionGridHtml(rows.slice(1).concat(row("S4", "decided")), "no")).toContain("ingen åpne · 3");
  });
  test("with none open it folds to its title line, and holds every row", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`S${i + 1}`, "decided"));
    const html = questionGridHtml(rows, "en");
    expect(html).toContain('<details class="qg-settled"><summary class="dc-title">');
    expect(html).not.toContain("<details class=\"qg-settled\" open");
    expect(html.match(/class="qg-row /g)).toHaveLength(12);
    expect(html).not.toContain("qg-more");
    expect(html).toContain("none open · 12");
  });
  test("a reversed decision folds with the rest, its mark one click away", () => {
    const rows = rowsOf(log("- **O1** — Which store holds rows? Lukket 07.10 (D1).", "- **O2** — Which key? Lukket 07.10 (D2).", "- **O3** — Which view? Lukket 07.10 (D2).", "- **D1** — ~~Keep this one for now.~~ Snudd 09.10: nothing replaces it yet. Kari Nordmann, 09.10.", "- **D2** — Key by id. Kari Nordmann, 04.10."));
    expect(rows.some((r) => r.reversed)).toBe(true);
    const html = questionGridHtml(rows, "en");
    expect(html).toContain('<details class="qg-settled">');
    expect(html.indexOf("qg-chip-reversed")).toBeGreaterThan(html.indexOf("</summary>"));
  });
  test("one open question keeps the grid unfolded", () => {
    const html = questionGridHtml([row("S1", "open"), row("S2", "decided"), row("S3", "decided")], "en");
    expect(html).not.toContain("qg-settled");
    expect(html).toContain('<div class="dc-title">');
  });
  test("an open row links its card only when it has one, and shows its age", () => {
    const html = questionGridHtml([row("S1", "open", { hasCard: true, ageDays: 4 }), row("S2", "open", { ageDays: 0 }), row("S3", "open")], "no");
    expect(html).toContain(`href="#${questionCardAnchor("S1")}"`);
    expect(html).not.toContain(`href="#${questionCardAnchor("S2")}"`);
    expect(html).toContain("åpen · 4 d");
    expect(html).toContain("åpen · i dag");
  });
  test("escapes page text", () => {
    const html = questionGridHtml([row("S1", "decided", { label: "<b>?", answer: "<i>", who: "<u>" }), row("S2", "open"), row("S3", "open")], "en");
    expect(html).not.toMatch(/<b>|<i>|<u>/);
  });
  test(`the cap folds decided rows past ${QUESTION_GRID_CAP}, never an open one`, () => {
    const decided = Array.from({ length: 10 }, (_, i) => row(`S${i + 1}`, "decided"));
    const asked = row("O1", "open");
    const atCap = questionGridHtml([asked, ...decided.slice(0, QUESTION_GRID_CAP - 1)], "en");
    expect(atCap).not.toContain("qg-more");
    const html = questionGridHtml([asked, ...decided], "en");
    expect(html).toContain("3 more");
    expect(html.indexOf("qg-more")).toBeLessThan(html.indexOf(">S9<"));
    const open = Array.from({ length: 10 }, (_, i) => row(`O${i + 1}`, "open"));
    const many = questionGridHtml([...open, row("S1", "decided")], "en");
    expect(many.indexOf("qg-more")).toBeGreaterThan(many.indexOf(">O10<"));
    expect(many).toContain("1 more");
  });
});

describe("questionGridSlot", () => {
  test("after StatusRows, wherever NextMoves sits; else the views' slot", () => {
    const status = parseBlocks("<StatusRows>\n\n- **Status:** x\n\n</StatusRows>\n\n<NextMoves>\n\n</NextMoves>\n");
    expect(questionGridSlot(status, 2)).toBe(1);
    expect(questionGridSlot(parseBlocks("<NextMoves>\n\n</NextMoves>\n"), 1)).toBe(1);
  });
});

describe("on the page render", () => {
  const STATUS = "<StatusRows>\n\n- **Status:** in-flight\n\n</StatusRows>\n";
  const NEXT = '<NextMoves>\n\n<Lane kind="waiting">\n\n- **O1**\n\n</Lane>\n\n</NextMoves>\n';
  const CARD = '<Question id="O1" choices="A|B">\n\nWhich shape do the rows take?\n\n</Question>\n';
  const LOG = '<Fold title="Decisions">\n\n' + log(
    "- **O1** — Which shape do the rows take? Asked Rune, 30.10.2026.",
    "- **O2** — Which key groups the rows? Closed 2026-10-03 (D1).",
    "- **O3** — Who reads the groups at all? Closed 2026-10-04 (D1).",
    "- **D1** — The reader reads the groups by key. Rune Lind, 04.10.",
  ) + "\n</Fold>\n";
  const question = { questionsTo: [], language: "en" as const, answerable: false };
  const reader = (...parts: string[]) => renderWikiHtml(parts.join("\n"), () => undefined, { views: true, question });

  test("sits right after StatusRows, above NextMoves", () => {
    const html = reader(STATUS, NEXT, CARD, LOG);
    const at = (s: string) => html.indexOf(s);
    expect(at('class="status-rows')).toBeGreaterThanOrEqual(0);
    expect(at('class="dc-view qg"')).toBeGreaterThan(at('class="status-rows'));
    expect(at('class="dc-view qg"')).toBeLessThan(at('class="next-moves'));
  });
  test("with no StatusRows it comes first in the views' slot", () => {
    const html = reader(NEXT, CARD, LOG);
    const at = (s: string) => html.indexOf(s);
    expect(at('class="dc-view qg"')).toBeGreaterThan(at('class="next-moves'));
    expect(at('class="dc-view qg"')).toBeLessThan(at('class="dc-view dc-chain"') < 0 ? Infinity : at('class="dc-view dc-chain"'));
  });
  test("under the minimum the page renders with no grid", () => {
    expect(reader(STATUS, log("- **O1** — Which shape do the rows take?"))).not.toContain("qg-rows");
  });
  test("a page with neither block has no slot and no grid", () => {
    expect(reader(LOG)).not.toContain("qg-rows");
  });
  test("the card takes its anchor once, and the row links it", () => {
    const html = reader(STATUS, NEXT, CARD, LOG);
    expect(html).toContain(`href="#${questionCardAnchor("O1")}"`);
    expect(html.split(`id="${questionCardAnchor("O1")}"`)).toHaveLength(2);
  });
  test("the ids link the final anchors of their log items", () => {
    const html = reader(STATUS, CARD, LOG);
    expect(html).toMatch(/class="dc-go" href="#o2" data-dc-ref="O2"/);
    expect(html).toMatch(/class="dc-go" href="#d1" data-dc-ref="D1"/);
    expect(html).toMatch(/<li class="dl-item[^"]*"[^>]* id="o2"/);
  });
  test("a card named twice takes no anchor", () => {
    expect(reader(STATUS, CARD, CARD, LOG)).not.toContain(`id="${questionCardAnchor("O1")}"`);
  });
  test("every other surface has neither the grid nor the anchor", () => {
    const html = formatWebHtml([STATUS, CARD, LOG].join("\n"), { question });
    expect(html).not.toContain("qg-rows");
    expect(html).not.toContain(questionCardAnchor("O1"));
  });
});
