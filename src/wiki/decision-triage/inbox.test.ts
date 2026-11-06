import { describe, expect, test } from "bun:test";
import { QUESTION_NOT_SURE } from "../../format/question.ts";
import { inboxBornMs, inboxLane, sortByAge, type LaneFacts } from "./inbox.ts";

const card = (over: Partial<LaneFacts> = {}): LaneFacts => ({ wiki: "mimir", answers: [], hinted: false, ownerAsked: true, ...over });

describe("inboxLane", () => {
  test("a choice answer goes to close", () => {
    expect(inboxLane(card({ answers: [{ choice: "A" }] }))).toBe("close");
  });
  test("a text-only answer goes to close (D22)", () => {
    expect(inboxLane(card({ answers: [{ choice: null }] }))).toBe("close");
  });
  test("a not-sure answer does not close: the card stays in its lane", () => {
    expect(inboxLane(card({ answers: [{ choice: QUESTION_NOT_SURE }] }))).toBe("default");
    expect(inboxLane(card({ wiki: "melosys-kode-wiki", answers: [{ choice: QUESTION_NOT_SURE }] }))).toBe("ask");
  });
  test("one author's not sure beside another's choice closes", () => {
    expect(inboxLane(card({ answers: [{ choice: QUESTION_NOT_SURE }, { choice: "B" }] }))).toBe("close");
  });
  test("a P1 hint goes to close, even for someone else", () => {
    expect(inboxLane(card({ hinted: true, ownerAsked: false }))).toBe("close");
  });
  test("targets that leave out the owner go to pass", () => {
    expect(inboxLane(card({ ownerAsked: false }))).toBe("pass");
    expect(inboxLane(card({ wiki: "melosys-kode-wiki", ownerAsked: false }))).toBe("pass");
  });
  test("a mixed target (the owner and someone) stays the owner's", () => {
    expect(inboxLane(card({ wiki: "melosys-kode-wiki", ownerAsked: true }))).toBe("ask");
    expect(inboxLane(card({ ownerAsked: true }))).toBe("default");
  });
  test("no targets at all (null) is not a pass", () => {
    expect(inboxLane(card({ ownerAsked: null }))).toBe("default");
  });
  test("melosys-kode-wiki asks, any other wiki defaults; the name is case-blind", () => {
    expect(inboxLane(card({ wiki: "Melosys-Kode-Wiki" }))).toBe("ask");
    expect(inboxLane(card({ wiki: "mimir" }))).toBe("default");
  });
});

describe("age order", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  test("the commit date first, then the lane's since, then now", () => {
    expect(inboxBornMs({ added: "2026-10-01T10:00:00+02:00", laneSince: "2026-09-01" }, now)).toBe(Date.parse("2026-10-01T08:00:00Z"));
    expect(inboxBornMs({ added: null, laneSince: "2026-09-01" }, now)).toBe(Date.parse("2026-09-01"));
    expect(inboxBornMs({ added: null, laneSince: null }, now)).toBe(now);
    expect(inboxBornMs({ added: "not a date", laneSince: null }, now)).toBe(now);
  });
  test("oldest first; a card with no commit sorts by its lane, else as today", () => {
    const cards = [
      { id: "today", added: null, laneSince: null },
      { id: "c-oct", added: "2026-10-15T00:00:00Z", laneSince: null },
      { id: "lane-sep", added: null, laneSince: "2026-09-20" },
      { id: "c-aug", added: "2026-08-01T00:00:00Z", laneSince: "2026-11-01" },
    ];
    expect(sortByAge(cards, now).map((c) => c.id)).toEqual(["c-aug", "lane-sep", "c-oct", "today"]);
  });
  test("ties keep their order", () => {
    const cards = [{ id: "a", added: null, laneSince: null }, { id: "b", added: null, laneSince: null }];
    expect(sortByAge(cards, now).map((c) => c.id)).toEqual(["a", "b"]);
  });
});
