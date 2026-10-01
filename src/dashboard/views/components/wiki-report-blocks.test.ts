import { test, expect, describe } from "bun:test";
import {
  LINE_REFS_KEY,
  daysSince,
  historicPillLabel,
  movesPillLabel,
  readLineRefsOn,
  SETTLED_SECTION_SELECTOR,
  writeLineRefsOn,
} from "./wiki-report-blocks.ts";
import { formatWebHtml } from "../../../web/web-format.ts";

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
