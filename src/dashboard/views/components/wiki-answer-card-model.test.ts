import { describe, expect, test } from "bun:test";
import {
  ANSWER_BODY_MAX,
  answerItemHtml,
  cardDisplayState,
  composerCanSave,
  composerHtml,
  formatAnswerTime,
  isVersionConflict,
  saveErrorText,
  statePillText,
  unexportedCount,
  type AnswerWire,
} from "./wiki-answer-card-model.ts";
import { QUESTION_LABELS } from "../../../format/question-labels.ts";
import { QUESTION_NOT_SURE } from "../../../format/question.ts";

const en = QUESTION_LABELS.en;
const no = QUESTION_LABELS.no;

const answer = (over: Partial<AnswerWire> = {}): AnswerWire => ({
  answerId: "a1",
  questionId: "O1",
  version: 1,
  versionCount: 1,
  authorName: "Yvonne Jacobs",
  choice: null,
  body: "Plain text.",
  createdAt: new Date(2026, 9, 8, 21, 32).getTime(),
  firstCreatedAt: new Date(2026, 9, 8, 21, 32).getTime(),
  exported: false,
  redacted: false,
  mine: false,
  asked: true,
  ...over,
});

describe("the five card states", () => {
  const cases: [string, Parameters<typeof cardDisplayState>[0], AnswerWire[], string][] = [
    ["no answers", "open", [], "open"],
    ["one unexported", "open", [answer()], "answered"],
    ["one exported, one not", "open", [answer({ exported: true }), answer({ answerId: "a2" })], "answered"],
    ["all exported", "open", [answer({ exported: true })], "copied"],
    ["decided wins over answers", "decided", [answer()], "decided"],
    ["closed wins over answers", "closed", [answer({ exported: true })], "closed"],
    ["closed with none", "closed", [], "closed"],
  ];
  for (const [name, server, answers, want] of cases) {
    test(name, () => expect(cardDisplayState(server, answers)).toBe(want as never));
  }

  test("the pill text follows the wiki's language; Decided/Closed keep the server's pill", () => {
    expect(["open", "answered", "copied"].map((s) => statePillText(s as never, no))).toEqual(["Åpent", "Besvart", "Kopiert"]);
    expect(statePillText("decided", en)).toBeNull();
    expect(statePillText("closed", en)).toBeNull();
  });

  test("the N new badge counts answers whose latest version is not exported", () => {
    expect(unexportedCount([answer(), answer({ exported: true }), answer()])).toBe(2);
  });
});

describe("an answer", () => {
  test("shows author, time, asked, edited N× and the choice; the body is escaped plain text", () => {
    const html = answerItemHtml(
      answer({ body: "<b>x</b>\nline 2", choice: "B", versionCount: 3, version: 3 }),
      en,
      "en",
      false,
    );
    expect(html).toContain('<span class="q-author">Yvonne Jacobs</span>');
    expect(html).toContain("2026-10-08 21:32");
    expect(html).toContain('<span class="q-asked q-asked-yes">asked</span>');
    expect(html).toContain("edited 2×");
    expect(html).toContain('<span class="q-pick">B</span>');
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;\nline 2");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain(`class="q-edit"`);
  });

  test("not asked, no label when nobody was named, and the not-sure choice in the wiki's language", () => {
    expect(answerItemHtml(answer({ asked: false }), no, "no", false)).toContain(">ikke spurt<");
    expect(answerItemHtml(answer({ asked: null }), en, "en", false)).not.toContain("q-asked");
    expect(answerItemHtml(answer({ choice: QUESTION_NOT_SURE }), no, "no", false)).toContain(">Vet ikke ennå<");
  });

  test("Edit only when the caller says so; the log fold only when earlier versions came", () => {
    const html = answerItemHtml(
      answer({
        versionCount: 2,
        version: 2,
        earlier: [{ version: 1, authorName: "Y", choice: "A", body: "first", createdAt: 0, exported: false, redacted: false }],
      }),
      en,
      "en",
      true,
    );
    expect(html).toContain('class="q-edit" data-answer-id="a1"');
    expect(html).toContain("<summary>Earlier versions (1)</summary>");
    expect(html).toContain("version 1");
    expect(html).toContain(">first<");
    expect(answerItemHtml(answer({ versionCount: 2 }), en, "en", false)).not.toContain("q-log");
  });

  test("a redacted answer says so and shows no body or choice", () => {
    const html = answerItemHtml(answer({ redacted: true, body: "", choice: null }), en, "en", false);
    expect(html).toContain("q-redacted");
    expect(html).toContain(">redacted<");
    expect(html).not.toContain("q-pick");
  });

  test("time is local, per language", () => {
    const ms = new Date(2026, 0, 5, 7, 4).getTime();
    expect(formatAnswerTime(ms, "en")).toBe("2026-01-05 07:04");
    expect(formatAnswerTime(ms, "no")).toBe("05.01.2026 07:04");
  });
});

describe("the composer", () => {
  const view = { questionId: "O1", choices: ["A", "B"], editing: null, choice: null, body: "", sending: false };

  test("radios for each choice plus Not sure yet; Save disabled until there is a body or a choice", () => {
    const html = composerHtml(view, en);
    expect([...html.matchAll(/type="radio"[^>]*value="([^"]+)"/g)].map((m) => m[1])).toEqual(["A", "B", QUESTION_NOT_SURE]);
    expect(html).toContain(">Not sure yet<");
    expect(html).toMatch(/class="q-save" disabled>Save answer</);
    expect(composerHtml({ ...view, choice: "B" }, en)).toMatch(/class="q-save">Save answer</);
  });

  test("a page that spells not-sure among its choices gets one radio for it", () => {
    const html = composerHtml({ ...view, choices: [QUESTION_NOT_SURE, "later"] }, en);
    expect([...html.matchAll(/type="radio"[^>]*value="([^"]+)"/g)].map((m) => m[1])).toEqual(["later", QUESTION_NOT_SURE]);
  });

  test("no choices, no radios; editing adds Cancel and says Save change; sending disables it all", () => {
    const html = composerHtml({ ...view, choices: [], editing: "a1", body: "x" }, en);
    expect(html).not.toContain("radio");
    expect(html).toContain(">Save change<");
    expect(html).toContain('class="q-cancel"');
    const busy = composerHtml({ ...view, body: "x", sending: true }, no);
    expect(busy).toMatch(/class="q-save" disabled>Lagrer …</);
  });

  test("the body cap is the route's, counted in code points", () => {
    // 8000 astral characters are 16000 UTF-16 units and still within the cap.
    expect(composerCanSave(null, "😀".repeat(ANSWER_BODY_MAX))).toBe(true);
    expect(composerCanSave(null, "a".repeat(ANSWER_BODY_MAX + 1))).toBe(false);
    expect(composerCanSave(null, "   ")).toBe(false);
    expect(composerCanSave("A", "")).toBe(true);
    expect(composerHtml({ ...view, body: "a".repeat(ANSWER_BODY_MAX + 1) }, en)).toContain("q-count-over");
  });
});

describe("a failed save", () => {
  test("shows the server's sentence when there is one", () => {
    expect(saveErrorText(409, { error: "question O1 is closed", code: "question_closed" }, en)).toBe(
      "The answer was not saved: question O1 is closed",
    );
    expect(saveErrorText(502, null, en)).toBe("The answer was not saved: HTTP 502");
    expect(saveErrorText(0, null, no)).toBe("Svaret ble ikke lagret");
  });

  test("only a 409 version_conflict is a conflict", () => {
    expect(isVersionConflict(409, { code: "version_conflict" })).toBe(true);
    expect(isVersionConflict(409, { code: "question_closed" })).toBe(false);
    expect(isVersionConflict(400, { code: "version_conflict" })).toBe(false);
  });
});
