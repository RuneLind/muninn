/**
 * VTT parsing + windowing, pinned against a REAL caption file: the auto-captions
 * of a public JavaZone conference talk (53 min, Norwegian, 928 cues). A
 * hand-written fixture cannot pin the thing that actually broke — see the `21`
 * case below.
 */
import { describe, expect, test } from "bun:test";
import {
  detectCaptionKind,
  formatTimestamp,
  parseVttCues,
  segmentsToMarkdown,
  vttToSegments,
} from "./vtt.ts";

const fixture = await Bun.file(`${import.meta.dir}/fixtures/totto-trust-but-verify.vtt`).text();

describe("parseVttCues (real Vimeo auto-captions)", () => {
  const cues = parseVttCues(fixture);

  test("finds every cue in the file", () => {
    expect(cues.length).toBe(928);
  });

  test("first cue", () => {
    expect(cues[0]).toEqual({ startSec: 13.04, endSec: 13.3, text: "Hallo!" });
  });

  test("a cue whose TEXT is a bare number is kept, not read as an index", () => {
    // 00:36:44.238 — the speaker says a number. A parser that drops
    // `/^\d+$/` lines by SHAPE loses this cue and reports 927.
    const cue = cues.find((c) => c.startSec === 2204.238);
    expect(cue).toBeDefined();
    expect(cue!.text).toBe("21");
  });

  test("last cue is near the end of the talk", () => {
    const last = cues[cues.length - 1]!;
    expect(last.startSec).toBeCloseTo(3211.15, 2);
    expect(last.text).toBe("Takk for meg.");
  });

  test("no cue text carries its own identifier line", () => {
    // Every cue identifier in this file is its 1-based index, on the line ABOVE
    // the timing line. A parser that keeps "every line that is not the timing
    // line" prefixes each cue with its own number — cue 1 would read
    // "1 Hallo!" and cue 627 "627 21".
    const leaked = cues.filter((c, i) => c.text === String(i + 1) || c.text.startsWith(`${i + 1} `));
    expect(leaked).toEqual([]);
  });

  test("cue times are monotonic and bounded", () => {
    for (const cue of cues) expect(cue.endSec).toBeGreaterThanOrEqual(cue.startSec);
    const starts = cues.map((c) => c.startSec);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

describe("parseVttCues (structure)", () => {
  test("CRLF line endings", () => {
    const vtt = "WEBVTT\r\n\r\n1\r\n00:00:01.000 --> 00:00:02.000\r\nHei\r\n";
    expect(parseVttCues(vtt)).toEqual([{ startSec: 1, endSec: 2, text: "Hei" }]);
  });

  test("skips NOTE and STYLE blocks", () => {
    const vtt = [
      "WEBVTT - With metadata",
      "",
      "NOTE this is a comment",
      "and it spans two lines",
      "",
      "STYLE",
      "::cue { color: peachpuff }",
      "",
      "00:00:03.500 --> 00:00:04.000",
      "Ja",
    ].join("\n");
    expect(parseVttCues(vtt)).toEqual([{ startSec: 3.5, endSec: 4, text: "Ja" }]);
  });

  test("multi-line cue text joins on one line", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfirst line\nsecond line";
    expect(parseVttCues(vtt)[0]!.text).toBe("first line second line");
  });

  test("cue settings after the end timestamp are not text", () => {
    const vtt = "WEBVTT\n\nid-7\n00:01:00.000 --> 00:01:02.000 align:start position:50%\nOK";
    expect(parseVttCues(vtt)).toEqual([{ startSec: 60, endSec: 62, text: "OK" }]);
  });

  test("MM:SS.mmm timestamps (no hour field)", () => {
    const vtt = "WEBVTT\n\n02:03.500 --> 02:04.500\nkort";
    expect(parseVttCues(vtt)).toEqual([{ startSec: 123.5, endSec: 124.5, text: "kort" }]);
  });

  test("a non-numeric identifier line is not text", () => {
    const vtt = "WEBVTT\n\nintro-cue\n00:00:01.000 --> 00:00:02.000\nHei";
    expect(parseVttCues(vtt)).toEqual([{ startSec: 1, endSec: 2, text: "Hei" }]);
  });

  test("an arrow inside cue text does not start a second cue", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\na --> b";
    expect(parseVttCues(vtt)).toEqual([{ startSec: 1, endSec: 2, text: "a --> b" }]);
  });

  test("empty input yields no cues", () => {
    expect(parseVttCues("")).toEqual([]);
    expect(parseVttCues("WEBVTT\n")).toEqual([]);
  });

  test("a single-digit hour field parses", () => {
    // `1:02:03.000` is legal WebVTT and a two-digit-hours rule dropped the whole
    // cue silently — an hour into a talk, which is where a long recording lives.
    expect(parseVttCues("WEBVTT\n\n1:02:03.000 --> 1:02:04.000\nsent")).toEqual([
      { startSec: 3723, endSec: 3724, text: "sent" },
    ]);
    expect(parseVttCues("WEBVTT\n\n100:00:00.000 --> 100:00:01.000\nlangt")[0]!.startSec).toBe(360_000);
  });

  test("a blank separator line made of NBSP still separates two cues", () => {
    // The block splitter counted only space and tab as blank padding while the
    // line filter used `trim()`, which does not — so the two passes disagreed and
    // the second cue's TIMING LINE was injected into the first cue's prose.
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nførste\n \n00:00:03.000 --> 00:00:04.000\nandre";
    expect(parseVttCues(vtt)).toEqual([
      { startSec: 1, endSec: 2, text: "første" },
      { startSec: 3, endSec: 4, text: "andre" },
    ]);
  });

  test("a cue whose IDENTIFIER is NOTE/STYLE/REGION is still a cue", () => {
    // Non-cue blocks are the ones with NO timing line. Deciding by the first
    // line instead threw away a real cue whose identifier happened to be one of
    // those words — the same shape-over-position mistake as the `21` cue.
    for (const id of ["NOTE", "STYLE", "REGION nope"]) {
      expect(parseVttCues(`WEBVTT\n\n${id}\n00:00:05.000 --> 00:00:06.000\ninnhold`)).toEqual([
        { startSec: 5, endSec: 6, text: "innhold" },
      ]);
    }
  });
});

describe("vttToSegments", () => {
  test("the talk collapses to 27 two-minute windows", () => {
    expect(vttToSegments(fixture, 120).length).toBe(27);
  });

  test("windows sit on absolute boundaries and carry the cue text", () => {
    const segments = vttToSegments(fixture, 120);
    expect(segments.map((s) => s.startSec).slice(0, 4)).toEqual([0, 120, 240, 360]);
    expect(segments[0]!.text.startsWith("Hallo! Yes, det virker.")).toBe(true);
    expect(segments[segments.length - 1]!.startSec).toBe(3120);
    expect(segments[segments.length - 1]!.text.endsWith("Takk for meg.")).toBe(true);
  });

  test("every cue's text survives windowing", () => {
    const cues = parseVttCues(fixture);
    const windowed = vttToSegments(fixture, 120).map((s) => s.text).join(" ");
    expect(windowed).toBe(cues.map((c) => c.text).join(" "));
  });

  test("a window with no cues is not emitted", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\na\n\n00:10:00.000 --> 00:10:01.000\nb";
    expect(vttToSegments(vtt, 120)).toEqual([
      { startSec: 0, text: "a" },
      { startSec: 600, text: "b" },
    ]);
  });

  test("refuses a non-positive window", () => {
    expect(() => vttToSegments(fixture, 0)).toThrow();
    expect(() => vttToSegments(fixture, -120)).toThrow();
  });

  test("refuses a window that is not a finite number", () => {
    // `Infinity > 0` is true, so it walked past the guard and every header came
    // out `NaN:NaN:NaN`. NaN fails `> 0` already; it is pinned so the guard
    // cannot be weakened back to a bare comparison.
    expect(() => vttToSegments(fixture, Number.POSITIVE_INFINITY)).toThrow();
    expect(() => vttToSegments(fixture, Number.NaN)).toThrow();
  });

  test("cues out of time order are grouped by WINDOW, not by neighbour", () => {
    // The old loop compared each cue only with the LAST window, so a cue that
    // stepped back in time opened a second window with the same start — the same
    // `[00:00:00]` header printed twice, which a citation cannot resolve.
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "en",
      "",
      "00:02:30.000 --> 00:02:31.000",
      "to",
      "",
      "00:00:05.000 --> 00:00:06.000",
      "tre",
    ].join("\n");
    expect(vttToSegments(vtt, 120)).toEqual([
      { startSec: 0, text: "en tre" },
      { startSec: 120, text: "to" },
    ]);
  });

  test("windows come out in time order whatever order the cues arrived in", () => {
    const vtt = "WEBVTT\n\n00:04:00.000 --> 00:04:01.000\nsist\n\n00:00:01.000 --> 00:00:02.000\nførst";
    expect(vttToSegments(vtt, 120).map((s) => s.startSec)).toEqual([0, 240]);
  });
});

describe("segmentsToMarkdown", () => {
  test("the fixture renders [00:00:00] then [00:02:00]", () => {
    const md = segmentsToMarkdown(vttToSegments(fixture, 120));
    expect(md.startsWith("[00:00:00]\n")).toBe(true);
    expect(md.split("\n\n")[1]!.startsWith("[00:02:00]\n")).toBe(true);
  });

  test("one header per window", () => {
    const md = segmentsToMarkdown(vttToSegments(fixture, 120));
    expect(md.match(/^\[\d{2}:\d{2}:\d{2}\]$/gm)!.length).toBe(27);
  });
});

describe("formatTimestamp", () => {
  test("pads to HH:MM:SS", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(125.9)).toBe("00:02:05");
    expect(formatTimestamp(3661)).toBe("01:01:01");
  });
});

describe("detectCaptionKind", () => {
  test("-x-autogen is machine-generated", () => {
    expect(detectCaptionKind("no-x-autogen")).toBe("auto");
    expect(detectCaptionKind("en-US-x-autogen")).toBe("auto");
  });

  test("anything else is a human track", () => {
    expect(detectCaptionKind("no")).toBe("manual");
    expect(detectCaptionKind("en-US")).toBe("manual");
  });
});
