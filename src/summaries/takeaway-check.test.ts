import { test, expect, describe } from "bun:test";
import {
  TAKEAWAY_MARKER,
  buildTakeawayCheckPrompt,
  groundTakeaway,
  parseTakeawayVerdict,
  spliceClosingTakeaway,
  splitClosingTakeaway,
} from "./takeaway-check.ts";

const BODY = "*ingress*\n\n## Key takeaways\n- 🧱 Stopping the project was healthy.\n\n## Body\nOne line's rollout was delayed by the slide.\n";

describe("splitClosingTakeaway", () => {
  test("finds the closer block and returns its text without the marker", () => {
    const text = `${BODY}\n> 💬 **Takeaway:** Stopping it was healthy.\n`;
    const split = splitClosingTakeaway(text)!;
    expect(split.takeaway).toBe("Stopping it was healthy.");
    expect(split.before).toBe(BODY);
    expect(split.after).toBe("");
  });

  test("joins `>` continuation lines into one closer", () => {
    const text = `${BODY}\n> 💬 **Takeaway:** First sentence.\n> Second sentence.\n>\n> Third.`;
    expect(splitClosingTakeaway(text)!.takeaway).toBe("First sentence. Second sentence. Third.");
  });

  test("takes the LAST marker, so a body that quotes one still resolves the real closer", () => {
    // The earlier one is a whole LINE starting with the marker — a first-match
    // walk would stop there; only a last-match walk reaches the real closer.
    const text = `${TAKEAWAY_MARKER} Quoted earlier, in the body.\n\nMore body.\n\n> 💬 **Takeaway:** Real.`;
    const split = splitClosingTakeaway(text)!;
    expect(split.takeaway).toBe("Real.");
    expect(split.before).toContain("Quoted earlier");
    expect(split.before).toContain("More body.");
  });

  test("keeps whatever follows the closer block", () => {
    const text = `${BODY}\n> 💬 **Takeaway:** X.\n\nTrailing line.`;
    const split = splitClosingTakeaway(text)!;
    expect(split.after).toBe("\nTrailing line.");
  });

  test("returns null when there is no closer (a selection pass, a plain body)", () => {
    expect(splitClosingTakeaway("[3, 7, 11]")).toBeNull();
    expect(splitClosingTakeaway(BODY)).toBeNull();
  });
});

describe("spliceClosingTakeaway", () => {
  test("replaces the closer in place and flattens a multi-line rewrite", () => {
    const text = `${BODY}\n> 💬 **Takeaway:** Old.\n> More old.\n\nTrailing.`;
    const out = spliceClosingTakeaway(splitClosingTakeaway(text)!, "New one.\nNew two.");
    expect(out).toBe(`${BODY}\n> 💬 **Takeaway:** New one. New two.\n\nTrailing.`);
  });

  test("round-trips: splicing the original closer back reproduces the text", () => {
    const text = `${BODY}\n> 💬 **Takeaway:** Same.`;
    const split = splitClosingTakeaway(text)!;
    expect(spliceClosingTakeaway(split, split.takeaway)).toBe(text);
  });
});

describe("buildTakeawayCheckPrompt", () => {
  test("carries the body and the closer, names the three defect classes, and asks for the closer's language", () => {
    const p = buildTakeawayCheckPrompt(BODY, "The cancelled project was the most valuable.");
    expect(p).toContain("<body>\n" + BODY + "\n</body>");
    expect(p).toContain("<takeaway>\nThe cancelled project was the most valuable.\n</takeaway>");
    for (const cls of ["CAUSE", "RANKING", "REVERSAL"]) expect(p).toContain(cls);
    expect(p).toContain("SAME LANGUAGE");
    expect(p).toContain('"verdict": "grounded" | "ungrounded"');
  });
});

describe("parseTakeawayVerdict", () => {
  test("accepts a grounded verdict and drops any rewrite it carries", () => {
    expect(parseTakeawayVerdict('{"verdict":"grounded","issues":[],"rewrite":"ignored"}')).toEqual({
      verdict: "grounded",
      issues: [],
      rewrite: null,
    });
  });

  test("accepts an ungrounded verdict with issues and a rewrite, tolerating prose around the JSON", () => {
    const v = parseTakeawayVerdict('Here you go:\n{"verdict":"ungrounded","issues":["a","b"],"rewrite":" New. "}\nDone.');
    expect(v).toEqual({ verdict: "ungrounded", issues: ["a", "b"], rewrite: "New." });
  });

  test("refuses an ungrounded verdict with no rewrite — nothing to splice in", () => {
    expect(() => parseTakeawayVerdict('{"verdict":"ungrounded","issues":["a"],"rewrite":null}')).toThrow(/without a rewrite/);
    expect(() => parseTakeawayVerdict('{"verdict":"ungrounded","issues":["a"],"rewrite":"  "}')).toThrow(/without a rewrite/);
  });

  test("refuses an unknown verdict", () => {
    expect(() => parseTakeawayVerdict('{"verdict":"maybe"}')).toThrow(/verdict is "maybe"/);
  });
});

describe("groundTakeaway", () => {
  const answer = (v: Record<string, unknown>) => async () => ({
    result: JSON.stringify(v),
    model: "claude-sonnet-4-6",
    inputTokens: 1,
    outputTokens: 1,
    backend: "anthropic" as const,
  });
  const text = `${BODY}\n> 💬 **Takeaway:** The cancelled project was the most valuable.`;

  test("rewrites an ungrounded closer and reports the issues and the original", async () => {
    const r = await groundTakeaway(text, {
      botName: "t",
      call: answer({ verdict: "ungrounded", issues: ["reversal"], rewrite: "Stopping it was healthy." }),
    });
    expect(r.outcome).toBe("rewritten");
    expect(r.issues).toEqual(["reversal"]);
    expect(r.original).toBe("The cancelled project was the most valuable.");
    expect(r.text).toBe(`${BODY}\n> 💬 **Takeaway:** Stopping it was healthy.`);
    expect(r.usage).toMatchObject({ model: "claude-sonnet-4-6", backend: "anthropic" });
  });

  test("hands the call the body and the closer, not the whole text", async () => {
    let seen = "";
    await groundTakeaway(text, {
      botName: "t",
      call: async (p) => { seen = p; return (await answer({ verdict: "grounded" })()); },
    });
    expect(seen).toContain("<body>\n" + BODY);
    expect(seen).toContain("<takeaway>\nThe cancelled project was the most valuable.");
    expect(seen.indexOf("💬")).toBe(-1); // the marker line itself is not in the prompt
  });

  test("a grounded verdict returns the text unchanged", async () => {
    const r = await groundTakeaway(text, { botName: "t", call: answer({ verdict: "grounded" }) });
    expect(r.outcome).toBe("grounded");
    expect(r.text).toBe(text);
  });

  test("no closer ⇒ no call, outcome no-takeaway", async () => {
    let calls = 0;
    const r = await groundTakeaway("[1, 2]", { botName: "t", call: async () => { calls++; return answer({ verdict: "grounded" })(); } });
    expect(r.outcome).toBe("no-takeaway");
    expect(calls).toBe(0);
  });

  test("a throwing call or an unparseable answer keeps the text: check-failed", async () => {
    const thrown = await groundTakeaway(text, { botName: "t", call: async () => { throw new Error("down"); } });
    expect(thrown).toMatchObject({ outcome: "check-failed", text });
    const garbage = await groundTakeaway(text, {
      botName: "t",
      call: async () => ({ result: "not json at all", model: "m", inputTokens: 1, outputTokens: 1 }),
    });
    expect(garbage).toMatchObject({ outcome: "check-failed", text });
  });
});
