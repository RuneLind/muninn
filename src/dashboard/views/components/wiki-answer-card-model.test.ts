import { describe, expect, test } from "bun:test";
import {
  answerItemHtml,
  cardDisplayState,
  composerCanSave,
  composerHtml,
  draftChoiceFor,
  formatAnswerTime,
  isVersionConflict,
  mergeSavedAnswer,
  saveErrorText,
  savedAnswerOf,
  statePillText,
  unexportedCount,
  type AnswerWire,
} from "./wiki-answer-card-model.ts";
import * as cardModel from "./wiki-answer-card-model.ts";
import { QUESTION_LABELS } from "../../../format/question-labels.ts";
import { QUESTION_ANSWER_MAX as ANSWER_BODY_MAX, QUESTION_NOT_SURE } from "../../../format/question.ts";

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

describe("fix round 1", () => {
  test("a redacted answer is not new and does not make a card Answered", () => {
    expect(unexportedCount([answer({ redacted: true }), answer({ answerId: "a2", exported: true })])).toBe(0);
    expect(unexportedCount([answer({ redacted: true }), answer({ answerId: "a2" })])).toBe(1);
    expect(cardDisplayState("open", [answer({ redacted: true })])).toBe("open");
    expect(cardDisplayState("open", [answer({ redacted: true }), answer({ answerId: "a2", exported: true })])).toBe("copied");
    expect(cardDisplayState("open", [answer({ redacted: true }), answer({ answerId: "a2" })])).toBe("answered");
  });

  test("an edit starts from the stored choice only while the card still offers it", () => {
    expect(draftChoiceFor("A", ["A", "B"])).toBe("A");
    expect(draftChoiceFor("A", ["X", "Y"])).toBeNull();
    expect(draftChoiceFor(QUESTION_NOT_SURE, ["X"])).toBe(QUESTION_NOT_SURE);
    expect(draftChoiceFor(QUESTION_NOT_SURE, [])).toBeNull();
    expect(draftChoiceFor("A", [])).toBeNull();
    expect(draftChoiceFor(null, ["A"])).toBeNull();
  });

  test("over the cap, the composer says why Save is disabled; within it the line is hidden", () => {
    const view = { questionId: "O1", choices: [], editing: null, choice: null, body: "a".repeat(ANSWER_BODY_MAX + 3), sending: false };
    expect(composerHtml(view, en)).toContain('<p class="q-over" role="status">Too long: remove 3 characters to save.</p>');
    expect(composerHtml({ ...view, body: "a".repeat(ANSWER_BODY_MAX + 1) }, no)).toContain(">For langt: fjern 1 tegn for å lagre.</p>");
    expect(composerHtml({ ...view, body: "ok" }, en)).toContain('<p class="q-over" role="status" hidden></p>');
  });

  test("a picked choice can be cleared: the Clear choice button shows once one is picked", () => {
    const view = { questionId: "O1", choices: ["A", "B"], editing: "a1", choice: null, body: "x", sending: false };
    expect(composerHtml(view, en)).toContain('<button type="button" class="q-clear-choice" hidden>Clear choice</button>');
    expect(composerHtml({ ...view, choice: "A" }, en)).toContain('<button type="button" class="q-clear-choice">Clear choice</button>');
    expect(composerHtml({ ...view, choices: [] }, en)).not.toContain("q-clear-choice");
  });

  test("every separator in a by line rides inside the part it leads, never as a bare text node", () => {
    const html = answerItemHtml(
      answer({
        versionCount: 2,
        version: 2,
        earlier: [{ version: 1, authorName: "Y", choice: null, body: "first", createdAt: 0, exported: false, redacted: false }],
      }),
      en,
      "en",
      true,
    );
    const lines = [...html.matchAll(/<div class="q-by">([\s\S]*?)<\/div>/g)].map((m) => m[1]!);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      // Text outside every tag is white space only.
      expect(line.replace(/<span[^>]*>[^<]*<\/span>|<button[^>]*>[^<]*<\/button>/g, "").trim()).toBe("");
    }
    expect(html).toContain('<span class="q-time">· 2026-10-08 21:32</span>');
    expect(html).toContain('<span class="q-edited">· edited 1×</span>');
  });

  test("the log fold renders open when the reader left it open", () => {
    const a = answer({
      versionCount: 2,
      version: 2,
      earlier: [{ version: 1, authorName: "Y", choice: null, body: "first", createdAt: 0, exported: false, redacted: false }],
    });
    expect(answerItemHtml(a, en, "en", false, true)).toContain('<details class="q-log" data-answer-id="a1" open>');
    expect(answerItemHtml(a, en, "en", false)).toContain('<details class="q-log" data-answer-id="a1">');
  });

  test("a saved answer folds into the list: a new one is appended, an edit moves the old version into the log", () => {
    const saved = { answerId: "a9", questionId: "O1", version: 1, authorName: "Y", choice: null, body: "new", createdAt: 5, exported: false, redacted: false, mine: true };
    const added = mergeSavedAnswer([answer()], saved);
    expect(added.map((a) => [a.answerId, a.versionCount, a.firstCreatedAt, a.asked])).toEqual([
      ["a1", 1, answer().firstCreatedAt, true],
      ["a9", 1, 5, null],
    ]);
    const edited = mergeSavedAnswer([answer({ body: "old" })], { ...saved, answerId: "a1", version: 2, body: "v2" });
    expect(edited).toHaveLength(1);
    expect(edited[0]!.version).toBe(2);
    expect(edited[0]!.body).toBe("v2");
    expect(edited[0]!.versionCount).toBe(2);
    expect(edited[0]!.asked).toBe(true);
    expect(edited[0]!.earlier?.map((v) => [v.version, v.body])).toEqual([[1, "old"]]);
    // An older save never replaces a newer version already in the list.
    expect(mergeSavedAnswer([answer({ version: 3, versionCount: 3 })], { ...saved, answerId: "a1", version: 2 })[0]!.version).toBe(3);
  });

  test("only a body with the saved answer's shape is read as one", () => {
    expect(savedAnswerOf({ answerId: "a", questionId: "O1", version: 1, body: "", createdAt: 1 })).not.toBeNull();
    expect(savedAnswerOf({ answerId: "a" })).toBeNull();
    expect(savedAnswerOf(null)).toBeNull();
  });
});

describe("answer cards PR 5: Redact and the scanner", () => {
  test("Redact… renders only for a viewer who may redact, never on a redacted answer", () => {
    expect(answerItemHtml(answer(), en, "en", false)).not.toContain("q-redact");
    expect(answerItemHtml(answer(), en, "en", false, false, { can: false, confirming: false, working: false })).not.toContain("q-redact");
    // `q-redacted` is the redacted body's class, not the control.
    const html = answerItemHtml(answer(), en, "en", false, false, { can: true, confirming: false, working: false });
    expect(html).toContain('<button type="button" class="q-redact" data-answer-id="a1">Redact…</button>');
    expect(html).not.toContain("q-redact-confirm");
    expect(answerItemHtml(answer({ redacted: true }), en, "en", false, false, { can: true, confirming: true, working: false })).not.toMatch(/q-redact[ "-]/);
  });

  test("the inline confirm replaces the button, in the wiki's language; working disables both", () => {
    const html = answerItemHtml(answer(), no, "no", false, false, { can: true, confirming: true, working: false });
    expect(html).not.toContain('class="q-redact"');
    expect(html).toContain('class="q-redact-confirm" role="group"');
    expect(html).toContain(no.redact.prompt);
    expect(html).toContain(`<button type="button" class="q-redact-yes" data-answer-id="a1" aria-describedby="q-redact-prompt-a1">Fjern</button>`);
    expect(html).toContain(`<button type="button" class="q-redact-no" data-answer-id="a1">Avbryt</button>`);
    const busy = answerItemHtml(answer(), en, "en", false, false, { can: true, confirming: true, working: true });
    expect(busy).toContain(`class="q-redact-yes" data-answer-id="a1" aria-describedby="q-redact-prompt-a1" disabled>Redacting …</button>`);
    expect(busy).toContain(`class="q-redact-no" data-answer-id="a1" disabled>`);
  });

  test("a 422 scanner_refused shows the scanner's reasons; a 503 scanner_unavailable a fixed line", () => {
    const refused = { error: "scanner_refused", code: "scanner_refused", reasons: ["looks like an id", "a second <reason>"] };
    expect(saveErrorText(422, refused, en)).toBe("The answer was not saved. The scanner flagged: looks like an id; a second <reason>");
    expect(saveErrorText(422, refused, no)).toBe("Svaret ble ikke lagret. Skanneren fant: looks like an id; a second <reason>");
    expect(saveErrorText(503, { error: "x", code: "scanner_unavailable" }, en)).toBe(en.composer.scannerUnavailable);
    // Any other 422 keeps the server's own sentence.
    expect(saveErrorText(422, { error: "something else", code: "other" }, en)).toBe("The answer was not saved: something else");
  });
});

describe("answer cards PR 5 fix round 1", () => {
  test("a refusal with no reasons leaves no dangling colon", () => {
    for (const L of [en, no]) {
      const text = saveErrorText(422, { error: "scanner_refused", code: "scanner_refused", reasons: [] }, L);
      expect(text.trim().endsWith(":")).toBe(false);
    }
  });

  test("the reasons the server left out are counted after the ones it sent", () => {
    const refused = { error: "scanner_refused", code: "scanner_refused", reasons: ["a", "b"], moreReasons: 18 };
    expect(saveErrorText(422, refused, en)).toBe("The answer was not saved. The scanner flagged: a; b (+18 more)");
    expect(saveErrorText(422, refused, no)).toBe("Svaret ble ikke lagret. Skanneren fant: a; b (+18 til)");
  });

  test("the inline confirm's prompt describes the group and the Redact button", () => {
    const html = answerItemHtml(answer(), en, "en", false, false, { can: true, confirming: true, working: false });
    const id = /<span class="q-redact-prompt" id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`class="q-redact-confirm" role="group" aria-label="Redact" aria-describedby="${id}"`);
    expect(html).toMatch(new RegExp(`class="q-redact-yes"[^>]*aria-describedby="${id}"`));
  });

  test("a failed redact says why in the wiki's language, by status, never the server's English", () => {
    const text = (cardModel as unknown as { redactErrorText: (s: number, p: unknown, L: typeof en) => string }).redactErrorText;
    const english = { error: "only an admin may redact answers", code: "admin_only" };
    expect(text(403, english, en)).toBe("The answer was not redacted: you may not redact answers.");
    expect(text(403, english, no)).toBe("Svaret ble ikke fjernet: du har ikke lov til å fjerne svar.");
    expect(text(404, { error: "no such answer", code: "unknown_answer" }, no)).toBe("Svaret ble ikke fjernet: svaret finnes ikke lenger.");
    expect(text(0, null, no)).toBe("Svaret ble ikke fjernet: fikk ikke kontakt med serveren.");
    expect(text(500, { error: "answer not redacted" }, no)).toBe("Svaret ble ikke fjernet (HTTP 500).");
    for (const s of [403, 404, 0, 500, 413]) expect(text(s, english, no)).not.toContain("admin");
  });

  test("a 403 says which refusal it was: role (zone or handler), origin guard, or a generic line with the status", () => {
    const text = (cardModel as unknown as { redactErrorText: (s: number, p: unknown, L: typeof en) => string }).redactErrorText;
    // src/auth/zone-middleware.ts: the zone's admin refusal.
    expect(text(403, { error: "forbidden", reason: "admin-only route" }, en)).toBe(
      "The answer was not redacted: you may not redact answers.",
    );
    // src/auth/origin.ts: the origin guard is not a role refusal.
    expect(text(403, { error: "forbidden", reason: "cross-origin request" }, en)).toBe(
      "The answer was not redacted: the server refused a request from this page's address.",
    );
    expect(text(403, { error: "forbidden", reason: "cross-origin request" }, no)).toBe(
      "Svaret ble ikke fjernet: serveren avviste en forespørsel fra denne sidens adresse.",
    );
    // Anything else (src/auth/guard.ts answers an empty 403): the status, no claim about why.
    expect(text(403, null, en)).toBe("The answer was not redacted (HTTP 403).");
    expect(text(403, { error: "forbidden" }, en)).toBe("The answer was not redacted (HTTP 403).");
    expect(text(403, "not json", no)).toBe("Svaret ble ikke fjernet (HTTP 403).");
  });
});
