import { describe, expect, test } from "bun:test";
import {
  buildTranscriptCheckPrompt,
  capTranscript,
  checkClaimsAgainstTranscript,
  describeCut,
  parseTranscriptVerdicts,
  transcriptReading,
  transcriptRouterOptions,
  TRANSCRIPT_CHECK_MAX_CHARS,
  TRANSCRIPT_CHECK_MODEL,
  TRANSCRIPT_CHECK_TIMEOUT_MS,
} from "./transcript-check.ts";
import { TRANSCRIPT_FIXTURES } from "./__fixtures__/transcript-check-fixtures.ts";

const claims = [
  { index: 1, title: "A", quote: "a said" },
  { index: 2, title: "B" },
];

describe("capTranscript", () => {
  test("a transcript under the cap is sent whole and says nothing was cut", () => {
    const r = capTranscript("one\n\ntwo", 100);
    expect(r.text).toBe("one\n\ntwo");
    expect(r.cut).toEqual({ truncated: false, keptChars: 8, totalChars: 8 });
    expect(describeCut(r.cut)).toBeNull();
  });

  test("an over-cap transcript is cut at the last paragraph break, and the cut is stated", () => {
    const t = `${"a".repeat(60)}\n\n${"b".repeat(30)}\n\n${"c".repeat(30)}`;
    const r = capTranscript(t, 100);
    expect(r.text).toBe(`${"a".repeat(60)}\n\n${"b".repeat(30)}`);
    expect(r.cut.truncated).toBe(true);
    expect(r.cut.keptChars).toBe(92);
    expect(r.cut.totalChars).toBe(t.length);
    expect(describeCut(r.cut)).toContain("first 92 of 124 characters");
  });

  test("no paragraph break in the second half falls back to a line break, then a hard cut", () => {
    expect(capTranscript(`${"a".repeat(80)}\n${"b".repeat(80)}`, 100).text).toBe("a".repeat(80));
    expect(capTranscript("x".repeat(150), 100).text).toBe("x".repeat(100));
  });

  test("the long fixture passes the default cap and loses its last claim's support", () => {
    const long = TRANSCRIPT_FIXTURES.find((f) => f.id === "10-trams-long")!;
    expect(long.transcript.length).toBeGreaterThan(TRANSCRIPT_CHECK_MAX_CHARS);
    const r = capTranscript(long.transcript);
    expect(r.cut.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(TRANSCRIPT_CHECK_MAX_CHARS);
    expect(r.text).toContain("1894");
    expect(r.text).not.toContain("electrified in 1899");
  });
});

describe("fixtures", () => {
  test("ten fixtures, each with at least one known mismatch", () => {
    expect(TRANSCRIPT_FIXTURES).toHaveLength(10);
    for (const f of TRANSCRIPT_FIXTURES) expect(f.claims.some((c) => c.expected !== "supported")).toBe(true);
  });
});

describe("buildTranscriptCheckPrompt", () => {
  test("names every claim by index with its quote, fences the data, and states a cut only when there is one", () => {
    const whole = buildTranscriptCheckPrompt(claims, "T", { truncated: false, keptChars: 1, totalChars: 1 });
    expect(whole).toContain("[1] A\n    summary sentence: \"a said\"");
    expect(whole).toContain("[2] B");
    expect(whole).toContain("<transcript>\nT\n</transcript>");
    expect(whole).not.toContain("is CUT");
    const cut = buildTranscriptCheckPrompt(claims, "T", { truncated: true, keptChars: 1, totalChars: 9 });
    expect(cut).toContain("first 1 of 9 characters");
    expect(cut).toContain("beyond the cut");
  });
});

describe("parseTranscriptVerdicts", () => {
  test("parses one verdict per asked claim in claim order, normalizing spelling, dropping unasked indices", () => {
    const text = JSON.stringify({
      claims: [
        { index: 2, verdict: "Not_In_Transcript", note: "  nothing\n here " },
        { index: 1, verdict: "contradicts", note: "said 18" },
        { index: 9, verdict: "supported" },
      ],
    });
    expect(parseTranscriptVerdicts(`\`\`\`json\n${text}\n\`\`\``, claims)).toEqual([
      { index: 1, verdict: "contradicts transcript", note: "said 18" },
      { index: 2, verdict: "not in transcript", note: "nothing here" },
    ]);
  });

  test("a missing claim, a bad verdict or a duplicate throws rather than leaving a claim without a chip", () => {
    expect(() => parseTranscriptVerdicts(JSON.stringify({ claims: [{ index: 1, verdict: "supported" }] }), claims)).toThrow(/claim\(s\) 2/);
    expect(() =>
      parseTranscriptVerdicts(JSON.stringify({ claims: [{ index: 1, verdict: "true" }, { index: 2, verdict: "supported" }] }), claims),
    ).toThrow(/verdict/);
    expect(() =>
      parseTranscriptVerdicts(
        JSON.stringify({ claims: [{ index: 1, verdict: "supported" }, { index: 1, verdict: "supported" }, { index: 2, verdict: "supported" }] }),
        claims,
      ),
    ).toThrow(/twice/);
    expect(() => parseTranscriptVerdicts("{}", claims)).toThrow(/claims array/);
  });
});

describe("transcriptReading", () => {
  test("web ❌ plus transcript supported reads as the source's error", () => {
    expect(transcriptReading("❌", "supported")).toBe("the source got it wrong");
    expect(transcriptReading("⚠️", "supported")).toBe("the source is partly wrong");
    expect(transcriptReading("✅", "supported")).toBeNull();
    expect(transcriptReading("❌", "not in transcript")).toBe("the summary added it");
    expect(transcriptReading("✅", "not in transcript")).toBe("not from the source");
    expect(transcriptReading("✅", "contradicts transcript")).toBe("the summary misreports the source");
  });
});

describe("the call", () => {
  test("router options: Sonnet request, own timeout, its own source tag — and no model on vertex", () => {
    const o = transcriptRouterOptions({ botName: "b", connector: "claude-sdk" });
    expect(o.model).toBe(TRANSCRIPT_CHECK_MODEL);
    expect(o.timeoutMs).toBe(TRANSCRIPT_CHECK_TIMEOUT_MS);
    expect(o.source).toBe("transcript-check");
    expect(transcriptRouterOptions({ botName: "b", haikuBackend: "vertex" }).model).toBeUndefined();
  });

  test("one call for every claim, with the capped transcript, and the cut on the result", async () => {
    const prompts: string[] = [];
    const r = await checkClaimsAgainstTranscript(claims, `${"a".repeat(60)}\n\n${"b".repeat(60)}`, {
      botName: "b",
      maxChars: 100,
      call: async (p) => {
        prompts.push(p);
        return {
          result: JSON.stringify({ claims: [{ index: 1, verdict: "supported", note: "n" }, { index: 2, verdict: "not in transcript", note: "m" }] }),
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("b".repeat(60));
    expect(r.cut.truncated).toBe(true);
    expect(r.claims.map((c) => c.verdict)).toEqual(["supported", "not in transcript"]);
  });

  test("no claims is refused before any call", async () => {
    await expect(checkClaimsAgainstTranscript([], "t", { botName: "b", call: async () => { throw new Error("called"); } })).rejects.toThrow(/no claims/);
  });
});
