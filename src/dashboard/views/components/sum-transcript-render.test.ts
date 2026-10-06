import { describe, expect, test } from "bun:test";
import { renderTranscriptCheckHtml } from "./sum-transcript-render.ts";

const check = (claims: { index: number; verdict: "supported" | "not in transcript" | "contradicts transcript"; note: string; beyondCut?: boolean }[], truncated = false) => ({
  claims,
  cut: { truncated, keptChars: 100, totalChars: truncated ? 400 : 100 },
  model: "m",
  botName: "b",
  checkedAt: 0,
});

describe("renderTranscriptCheckHtml", () => {
  test("one row per WEB claim, joined by index whatever order the check saved", () => {
    const html = renderTranscriptCheckHtml(
      [
        { index: 1, title: "one", verdict: "❌" },
        { index: 2, title: "two", verdict: "✅" },
        { index: 3, title: "three", verdict: "⚠" },
      ],
      check([
        { index: 3, verdict: "supported", note: "" },
        { index: 1, verdict: "supported", note: "said so" },
      ]),
    );
    const rows = [...html.matchAll(/<li data-claim-index="(\d)">(.*?)<\/li>/g)];
    expect(rows.map((r) => r[1])).toEqual(["1", "2", "3"]);
    expect(rows[0]![2]).toContain("the source got it wrong");
    expect(rows[1]![2]).toContain('data-tverdict="none"');
    expect(rows[2]![2]).toContain("⚠️");
    expect(rows[2]![2]).toContain("the source is partly wrong");
  });

  test("model notes and titles are escaped; the cut is stated only when there is one", () => {
    const html = renderTranscriptCheckHtml(
      [{ index: 1, title: "<b>t</b>", verdict: "✅" }],
      check([{ index: 1, verdict: "contradicts transcript", note: "<img src=x onerror=alert(1)>" }], true),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;t&lt;/b&gt;");
    expect(html).toContain("first 100 of 400 characters");
    expect(renderTranscriptCheckHtml([{ index: 1, title: "t", verdict: "✅" }], check([{ index: 1, verdict: "supported", note: "" }]))).not.toContain("sum-fc-tx-cut");
  });

  test("past a cut, a not-in-transcript row the check placed beyond it blames nobody", () => {
    const html = renderTranscriptCheckHtml(
      [{ index: 3, title: "electrified in 1899", verdict: "❌" }],
      check([{ index: 3, verdict: "not in transcript", note: "beyond the cut", beyondCut: true }], true),
    );
    expect(html).toContain("maybe said past the checked part");
    expect(html).not.toContain("the summary added it");
  });

  test("the claim index attribute is escaped like every other field", () => {
    const html = renderTranscriptCheckHtml(
      [{ index: '1" onmouseover="alert(1)' as unknown as number, title: "t", verdict: "✅" }],
      check([{ index: 1, verdict: "supported", note: "" }]),
    );
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot;");
  });
});

describe("fix round 2", () => {
  test("past a cut, only a row the check placed beyond the cut reads as maybe said later", () => {
    const html = renderTranscriptCheckHtml(
      [
        { index: 1, title: "invented about the opening", verdict: "❌" },
        { index: 2, title: "said only past the cut", verdict: "❌" },
      ],
      {
        ...check([], true),
        claims: [
          { index: 1, verdict: "not in transcript", note: "the opening is covered", beyondCut: false },
          { index: 2, verdict: "not in transcript", note: "beyond the cut", beyondCut: true },
        ],
      },
    );
    const row = (i: number) => new RegExp(`<li data-claim-index="${i}">(.*?)</li>`).exec(html)![1]!;
    expect(row(1)).toContain("the summary added it");
    expect(row(2)).toContain("maybe said past the checked part");
  });
});
