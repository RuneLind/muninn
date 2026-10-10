import { test, expect, describe } from "bun:test";
import {
  answeredQuestionIds,
  bindLaneProgress,
  countPillLabel,
  laneAgeText,
  LINE_REFS_KEY,
  daysSince,
  historicPillLabel,
  movesPillLabel,
  readLineRefsOn,
  SETTLED_SECTION_SELECTOR,
  writeLineRefsOn,
} from "./wiki-report-blocks.ts";
import { formatWebHtml } from "../../../web/web-format.ts";
import { mergeSavedAnswer, type AnswerWire } from "./wiki-answer-card-model.ts";

describe("NextMoves ages and pills", () => {
  // Local-time constructor: `daysSince` counts the viewer's calendar days.
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

  test("whole local days since a date; today is 0; the future and bad dates null", () => {
    expect(daysSince("2026-09-30", at(2026, 10, 1, 0))).toBe(1);
    expect(daysSince("2026-09-30", at(2026, 10, 1, 23))).toBe(1);
    expect(daysSince("2026-09-30", at(2026, 9, 30))).toBe(0);
    // A future day has no age yet: the lane shows the date, not "0 d".
    expect(daysSince("2026-10-05", at(2026, 10, 1))).toBeNull();
    // Years below 100 are those years, not the 1900s.
    expect(daysSince("0099-12-31", at(100, 1, 1))).toBe(1);
    expect(daysSince("2026-08-31", at(2026, 10, 1))).toBe(31);
    expect(daysSince("2026-02-31", at(2026, 10, 1))).toBeNull();
    expect(daysSince("30.09.2026", at(2026, 10, 1))).toBeNull();
  });

  test("a DST change does not shift the count", () => {
    // Europe DST ends 2026-10-25, US DST 2026-11-01: a 25-hour day still counts one.
    expect(daysSince("2026-10-24", at(2026, 10, 26))).toBe(2);
    expect(daysSince("2026-10-31", at(2026, 11, 2))).toBe(2);
    // …and a 23-hour spring day (Europe 2026-03-29, US 2026-03-08) is not lost.
    expect(daysSince("2026-03-28", at(2026, 3, 30, 0))).toBe(2);
    expect(daysSince("2026-03-07", at(2026, 3, 9, 0))).toBe(2);
  });

  test("D37: a lane's age in the wiki's language; the date alone for a future day", () => {
    const now = at(2026, 10, 10);
    expect(laneAgeText("waiting", "2026-10-07", now, "no")).toBe("stilt 07.10 · 3 d");
    expect(laneAgeText("you", "2026-10-07", now, "no")).toBe("siden 07.10 · 3 d");
    expect(laneAgeText("waiting", "2026-10-07", now, "en")).toBe("asked 07.10 · 3 d");
    expect(laneAgeText("blocked", "2026-10-10", now, "en")).toBe("since 10.10 · 0 d");
    // Another year carries its year; a future day has no age yet.
    expect(laneAgeText("waiting", "2025-10-07", now, "no")).toBe("stilt 07.10.2025 · 368 d");
    expect(laneAgeText("waiting", "2026-10-20", now, "no")).toBe("20.10");
    expect(laneAgeText("waiting", "2026-02-31", now, "no")).toBe("2026-02-31");
  });

  test("D38: a card counts as answered by a live answer its question asked for", () => {
    const ids = answeredQuestionIds([
      { questionId: "S1", asked: true, redacted: false },
      { questionId: "S2", asked: false, redacted: false },
      { questionId: "S3", asked: null, redacted: false },
      { questionId: "S4", asked: true, redacted: true },
      // A provisional entry (a save the reload has not confirmed): the server
      // has not said whether its author was asked.
      { questionId: "S5", redacted: false },
    ]);
    expect([...ids].sort()).toEqual(["S1", "S3"]);
  });

  test("pill labels: the English default with no who", () => {
    expect(movesPillLabel("you", 3, null)).toBe("✋ 3 for you");
    expect(movesPillLabel("waiting", 2, 4)).toBe("⏳ waiting · 2");
    expect(movesPillLabel("draft", 2, 1)).toBe("✉ 2 not sent · 1 d");
    expect(movesPillLabel("draft", 1, null)).toBe("✉ 1 not sent");
  });

  test("pill labels: the lane's own who when it has one", () => {
    expect(movesPillLabel("you", 3, null, "Du")).toBe("✋ Du · 3");
    expect(movesPillLabel("waiting", 2, 4, "Venter på fag")).toBe("⏳ Venter på fag · 2");
    expect(movesPillLabel("draft", 2, 1, "Utkast, ikke sendt")).toBe("✉ Utkast, ikke sendt · 2 · 1 d");
    expect(movesPillLabel("draft", 2, null, "Utkast")).toBe("✉ Utkast · 2");
  });

  test("the settled-section selector matches the markup the web renderer gives Historic and a resolved Callout", () => {
    const html =
      formatWebHtml("<Historic>\n\nx\n\n</Historic>") + formatWebHtml('<Callout resolved="2026-09-01">\n\nx\n\n</Callout>');
    // Both settled sections, no more and no fewer.
    expect(SETTLED_SECTION_SELECTOR.split(",").map((p) => p.trim()).sort()).toEqual([
      "details.callout-resolved",
      "section.historic",
    ]);
    for (const part of SETTLED_SECTION_SELECTOR.split(",")) {
      const [tag, cls] = part.trim().split(".");
      expect(html).toMatch(new RegExp(`<${tag} class="[^"]*\\b${cls}\\b`));
    }
  });
});

describe("line refs preference", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  test("default is on", () => expect(readLineRefsOn(mem())).toBe(true));
  test("no storage reads as on", () => expect(readLineRefsOn(undefined)).toBe(true));
  test("a throwing storage reads as on and a write does not throw", () => {
    const boom = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(readLineRefsOn(boom)).toBe(true);
    expect(() => writeLineRefsOn(boom, false)).not.toThrow();
  });
  test("off round-trips under the versioned key", () => {
    const s = mem();
    writeLineRefsOn(s, false);
    expect(s.m.get(LINE_REFS_KEY)).toBe("off");
    expect(readLineRefsOn(s)).toBe(false);
    writeLineRefsOn(s, true);
    expect(readLineRefsOn(s)).toBe(true);
  });
});

test("historic pill label", () => expect(historicPillLabel(2)).toBe("↻ 2 historic"));

describe("counted pills (D8, D12)", () => {
  const LABELS = { D: { one: "Beslutning", other: "beslutninger" }, Q: { one: "Query", other: "queries" } };
  test("the wiki's language, singular and plural", () => {
    expect(countPillLabel("decisions", 11, "en")).toBe("11 decisions");
    expect(countPillLabel("decisions", 1, "en")).toBe("1 decision");
    expect(countPillLabel("open", 5, "no")).toBe("5 åpne");
    expect(countPillLabel("queries", 17, "no")).toBe("17 spørringer");
    expect(countPillLabel("cases", 11, "no")).toBe("11 saker");
  });
  test("idLabels name the decision and query counts, lower-cased", () => {
    expect(countPillLabel("decisions", 11, "no", LABELS)).toBe("11 beslutninger");
    expect(countPillLabel("decisions", 1, "no", LABELS)).toBe("1 beslutning");
    expect(countPillLabel("queries", 17, "en", LABELS)).toBe("17 queries");
    expect(countPillLabel("open", 5, "en", LABELS)).toBe("5 open");
  });
});

// ── Fix round 1 (#671 review) ───────────────────────────────────────────────

describe("fix round 1 (#671): lane progress", () => {
  test("a just-saved answer counts only once the server says its author was asked", () => {
    const saved = { answerId: "a1", questionId: "S1", mine: true, version: 1, authorName: "Kari", choice: "A", body: "", createdAt: 1, exported: false, redacted: false };
    const merged = mergeSavedAnswer([], saved);
    expect(merged[0]!.asked).toBeUndefined();
    expect([...answeredQuestionIds(merged)]).toEqual([]);
    // The reload's answer decides: «ikke spurt» stays out, a question naming
    // nobody (null) counts.
    expect([...answeredQuestionIds([{ ...merged[0]!, asked: false }])]).toEqual([]);
    expect([...answeredQuestionIds([{ ...merged[0]!, asked: null }])]).toEqual(["S1"]);
    expect([...answeredQuestionIds([{ ...merged[0]!, asked: true }])]).toEqual(["S1"]);
  });

  /** A progress slot as `bindLaneProgress` reads it: its chips, its block's
   *  language, and whether it sits in a settled section. */
  function slot(ids: string[], settled: boolean) {
    const chips = ids.map((id) => ({ textContent: id }));
    const block = { dataset: { lang: "no" } };
    const el = {
      textContent: "",
      dataset: { nmQids: JSON.stringify(ids) } as Record<string, string>,
      parentElement: { querySelectorAll: (sel: string) => (sel === ".nm-qid" ? chips : []) },
      closest: (sel: string) => (sel === ".next-moves" ? block : sel === SETTLED_SECTION_SELECTOR && settled ? {} : null),
    };
    return el;
  }

  test("a slot in a settled section is left alone; a live one counts its chips", () => {
    const live = slot(["S1", "S2"], false);
    const settled = slot(["S1"], true);
    const article = { querySelectorAll: () => [live, settled] };
    const answers: AnswerWire[] = [
      { answerId: "a1", questionId: "S1", mine: false, version: 1, versionCount: 1, firstCreatedAt: 1, authorName: "Kari", choice: null, body: "x", createdAt: 1, exported: false, redacted: false, asked: true },
    ];
    bindLaneProgress(article as never, { answers: () => answers, loaded: () => true, onChange: () => () => {} });
    expect(live.textContent).toBe("· 1 av 2 besvart");
    expect(settled.textContent).toBe("");
  });
});
