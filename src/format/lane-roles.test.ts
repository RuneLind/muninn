/** The «Oppfølging» words D37–D39 added to `laneWords`, in both languages. */
import { describe, expect, test } from "bun:test";
import { laneWords } from "./lane-roles.ts";

describe("laneWords: D37–D39", () => {
  const no = laneWords("no");
  const en = laneWords("en");

  test("a lane's age: asked on a waiting lane, since elsewhere", () => {
    expect(no.age(true, "07.10", 3)).toBe("stilt 07.10 · 3 d");
    expect(no.age(false, "07.10", 3)).toBe("siden 07.10 · 3 d");
    expect(en.age(true, "07.10", 3)).toBe("asked 07.10 · 3 d");
    expect(en.age(false, "07.10", 0)).toBe("since 07.10 · 0 d");
  });

  test("the draft chip and its title", () => {
    expect(no.notSent(2)).toBe("ikke sendt · 2 d");
    expect(en.notSent(2)).toBe("not sent · 2 d");
    expect(no.drafted("29.09")).toBe("utkast 29.09");
    expect(en.drafted("29.09")).toBe("drafted 29.09");
  });

  test("progress over the cards a waiting lane names", () => {
    expect(no.progress(0, 4)).toBe("0 av 4 besvart");
    expect(en.progress(1, 4)).toBe("1 of 4 answered");
  });

  test("the five actions", () => {
    expect(no.action).toEqual({ answer: "Se og svar ▸", questions: "Se spørsmålene ▸", see: "Se ▸", seeAll: "Se alle ▸", hide: "Skjul ▴" });
    expect(en.action).toEqual({ answer: "Answer ▸", questions: "See questions ▸", see: "See ▸", seeAll: "See all ▸", hide: "Hide ▴" });
  });

  test("the merged stub line lists one, two or more ids", () => {
    expect(no.movedLink(["S2"], "↑")).toBe("Spørsmål S2 står under Oppfølging ↑");
    expect(no.movedLink(["S2", "S6"], "↑")).toBe("Spørsmål S2 og S6 står under Oppfølging ↑");
    expect(no.movedLink(["S2", "S6", "S7"], "↓")).toBe("Spørsmål S2, S6 og S7 står under Oppfølging ↓");
    expect(en.movedLink(["S2"], "↑")).toBe("Question S2 is under Follow-up ↑");
    expect(en.movedLink(["S2", "S6", "S7"], "↑")).toBe("Questions S2, S6 and S7 are under Follow-up ↑");
  });
});
