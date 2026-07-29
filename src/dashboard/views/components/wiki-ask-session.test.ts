import { test, expect } from "bun:test";
import {
  serializeAskSession,
  deserializeAskSession,
  type StoredAskTurn,
} from "./wiki-ask-session.ts";

function turn(overrides: Partial<StoredAskTurn> = {}): StoredAskTurn {
  return {
    question: "q",
    answer: "a",
    citations: [{ n: 1, title: "t" }],
    cited: [1],
    html: "<p>a</p>",
    askedAt: 1000,
    ...overrides,
  };
}

test("round-trips a session through serialize → deserialize", () => {
  const turns = [turn({ question: "one" }), turn({ question: "two" })];
  const restored = deserializeAskSession(serializeAskSession(turns, 10));
  expect(restored).toEqual(turns);
});

test("serialize enforces the cap, keeping the newest turns", () => {
  const turns = Array.from({ length: 15 }, (_, i) => turn({ question: "q" + i, askedAt: i }));
  const restored = deserializeAskSession(serializeAskSession(turns, 10));
  expect(restored.length).toBe(10);
  expect(restored[0]!.question).toBe("q5"); // oldest kept
  expect(restored[9]!.question).toBe("q14"); // newest kept
});

test("quota-fallback cap of 5 keeps only the 5 newest turns", () => {
  const turns = Array.from({ length: 12 }, (_, i) => turn({ question: "q" + i }));
  const restored = deserializeAskSession(serializeAskSession(turns, 5));
  expect(restored.length).toBe(5);
  expect(restored.map((t) => t.question)).toEqual(["q7", "q8", "q9", "q10", "q11"]);
});

test("serialize with cap 0 yields an empty array", () => {
  expect(serializeAskSession([turn()], 0)).toBe("[]");
});

test("malformed JSON deserializes to an empty array", () => {
  expect(deserializeAskSession("{not json")).toEqual([]);
  expect(deserializeAskSession("")).toEqual([]);
  expect(deserializeAskSession(null)).toEqual([]);
  expect(deserializeAskSession(undefined)).toEqual([]);
});

test("a non-array JSON root deserializes to an empty array", () => {
  expect(deserializeAskSession('{"question":"q"}')).toEqual([]);
  expect(deserializeAskSession("42")).toEqual([]);
});

test("round-trips a fact-check turn's toolSources", () => {
  const fc = turn({
    question: "fact check",
    kind: "factcheck",
    baseHash: "abc123",
    page: "some-page",
    pageType: "note",
    toolSources: ["blog.google", "reuters.com"],
  });
  const restored = deserializeAskSession(serializeAskSession([fc], 10));
  expect(restored).toEqual([fc]);
  expect(restored[0]!.toolSources).toEqual(["blog.google", "reuters.com"]);
});

test("round-trips a fact-check turn's toolSourceUrls map (intentional persistence)", () => {
  const fc = turn({
    question: "fact check",
    kind: "factcheck",
    toolSources: ["reuters.com", "who.int"],
    toolSourceUrls: {
      "reuters.com": "https://www.reuters.com/world/a",
      "who.int": "https://www.who.int/news/b",
    },
  });
  const restored = deserializeAskSession(serializeAskSession([fc], 10));
  expect(restored).toEqual([fc]);
  expect(restored[0]!.toolSourceUrls).toEqual({
    "reuters.com": "https://www.reuters.com/world/a",
    "who.int": "https://www.who.int/news/b",
  });
});

test("a malformed toolSourceUrls is DROPPED but the turn is kept", () => {
  const raw = JSON.stringify([
    { ...turn(), question: "arr", toolSourceUrls: ["not", "a", "map"] }, // array → drop field
    { ...turn(), question: "nonstr", toolSourceUrls: { "a.com": 42 } }, // non-string value → drop field
    { ...turn(), question: "nullish", toolSourceUrls: null }, // null → drop field
  ]);
  const restored = deserializeAskSession(raw);
  // Every turn survives; the bad field is stripped.
  expect(restored.map((t) => t.question)).toEqual(["arr", "nonstr", "nullish"]);
  for (const t of restored) expect(t.toolSourceUrls).toBeUndefined();
});

test("a present-but-wrong-typed toolSources drops the turn", () => {
  const raw = JSON.stringify([
    { ...turn(), toolSources: "reuters.com" }, // string, not array → drop
    { ...turn(), toolSources: ["ok", 42] }, // non-string element → drop
    turn({ question: "clean", toolSources: ["reuters.com"] }), // valid
    turn({ question: "absent" }), // absent is valid
  ]);
  const restored = deserializeAskSession(raw);
  expect(restored.map((t) => t.question)).toEqual(["clean", "absent"]);
});

test("round-trips a fact-check turn's per-outcome claimOutcomes tally", () => {
  const fc = turn({
    question: "fact check",
    kind: "factcheck",
    claimCount: 6,
    claimOutcomes: { verified: 5, unverifiable: 1, skipped: 2 },
  });
  const restored = deserializeAskSession(serializeAskSession([fc], 10));
  expect(restored).toEqual([fc]);
  expect(restored[0]!.claimOutcomes).toEqual({ verified: 5, unverifiable: 1, skipped: 2 });
});

test("a present-but-wrong-typed claimOutcomes drops the turn", () => {
  const raw = JSON.stringify([
    { ...turn(), claimOutcomes: 5 }, // not an object → drop
    { ...turn(), claimOutcomes: { verified: "5" } }, // count not a number → drop
    turn({ question: "clean", claimOutcomes: { verified: 3 } }), // valid
    { ...turn({ question: "unknown-key-ok" }), claimOutcomes: { verified: 1, future: 9 } }, // unknown key tolerated
    turn({ question: "absent" }), // absent is valid
  ]);
  const restored = deserializeAskSession(raw);
  expect(restored.map((t) => t.question)).toEqual(["clean", "unknown-key-ok", "absent"]);
});

test("round-trips a fact-check turn's wrote flag + bodyLen (v4 integrate)", () => {
  const fc = turn({
    question: "fact check",
    kind: "factcheck",
    page: "notes/thing",
    pageType: "note",
    baseHash: "abc",
    wrote: "integrate",
    bodyLen: 4210,
  });
  const restored = deserializeAskSession(serializeAskSession([fc], 10));
  expect(restored).toEqual([fc]);
  // The whole point of persisting these: the derived disable + the page-too-long
  // gate both survive a reload.
  expect(restored[0]!.wrote).toBe("integrate");
  expect(restored[0]!.bodyLen).toBe(4210);
});

test("a present-but-wrong-typed wrote/bodyLen drops the turn", () => {
  const raw = JSON.stringify([
    { ...turn(), wrote: 1 }, // not a string → drop
    { ...turn(), bodyLen: "4210" }, // not a number → drop
    turn({ question: "clean", wrote: "append", bodyLen: 10 }), // valid
    turn({ question: "absent" }), // absent is valid
  ]);
  const restored = deserializeAskSession(raw);
  expect(restored.map((t) => t.question)).toEqual(["clean", "absent"]);
});

test("`wrote` is validated as the two-value union, not merely as a string", () => {
  // An unknown value falls through every render branch and would silently
  // re-enable BOTH write buttons against an already-staled baseHash.
  const raw = JSON.stringify([
    { ...turn({ question: "bogus" }), wrote: "appendd" },
    { ...turn({ question: "empty" }), wrote: "" },
    turn({ question: "append-ok", wrote: "append" }),
    turn({ question: "integrate-ok", wrote: "integrate" }),
  ]);
  expect(deserializeAskSession(raw).map((t) => t.question)).toEqual(["append-ok", "integrate-ok"]);
});

test("per-turn shape validation drops only the malformed entries", () => {
  const good = turn({ question: "good" });
  const raw = JSON.stringify([
    good,
    { question: "no answer" }, // missing fields
    { ...turn(), cited: ["1"] }, // cited not all numbers
    { ...turn(), html: 42 }, // html wrong type
    { ...turn(), citations: "nope" }, // citations not array
    { ...turn(), askedAt: "soon" }, // askedAt wrong type
    turn({ question: "also good", html: null }), // html null is valid
  ]);
  const restored = deserializeAskSession(raw);
  expect(restored.length).toBe(2);
  expect(restored.map((t) => t.question)).toEqual(["good", "also good"]);
});

test("round-trips claim quotes + annotatable (PR 2 — inline annotation)", () => {
  const fc = turn({
    question: "fact check",
    kind: "factcheck",
    page: "sources/Creatine.mdx",
    pageType: "source",
    baseHash: "abc",
    annotatable: true,
    claimQuotes: [
      { index: 1, quote: "Creatine loading uses 20 g/day for 5–7 days." },
      { index: 3, quote: "Older adults show smaller gains." },
    ],
  });
  const restored = deserializeAskSession(serializeAskSession([fc], 10));
  expect(restored).toEqual([fc]);
  // Index-keyed, NOT positional: claim 2 carried no quote and is simply absent.
  expect(restored[0]!.claimQuotes!.map((q) => q.index)).toEqual([1, 3]);
  expect(restored[0]!.annotatable).toBe(true);
});

test("a malformed claimQuotes list is dropped but the turn survives", () => {
  const raw = JSON.stringify([
    { ...turn({ question: "not-an-array" }), claimQuotes: { 1: "x" } },
    { ...turn({ question: "bad-entry" }), claimQuotes: [{ index: "1", quote: "x" }] },
    { ...turn({ question: "missing-quote" }), claimQuotes: [{ index: 1 }] },
    turn({ question: "clean", claimQuotes: [{ index: 2, quote: "ok" }] }),
  ]);
  const restored = deserializeAskSession(raw);
  expect(restored.map((t) => t.question)).toEqual([
    "not-an-array",
    "bad-entry",
    "missing-quote",
    "clean",
  ]);
  expect(restored[0]!.claimQuotes).toBeUndefined();
  expect(restored[1]!.claimQuotes).toBeUndefined();
  expect(restored[2]!.claimQuotes).toBeUndefined();
  expect(restored[3]!.claimQuotes).toEqual([{ index: 2, quote: "ok" }]);
});

test("a present-but-wrong-typed annotatable drops the FIELD, keeping the turn", () => {
  // Deliberate deviation from the `bodyLen` scalar precedent beside it: the flag is
  // advisory, and absent already means "not annotatable" — so dropping the hint
  // degrades to the pre-field behaviour instead of discarding a fact-check answer.
  const raw = JSON.stringify([
    { ...turn({ question: "bogus" }), annotatable: "yes" },
    turn({ question: "clean", annotatable: false }),
  ]);
  const restored = deserializeAskSession(raw);
  expect(restored.map((t) => t.question)).toEqual(["bogus", "clean"]);
  expect(restored[0]!.annotatable).toBeUndefined();
  expect(restored[1]!.annotatable).toBe(false);
});

test("claimQuotes entries the server would reject wholesale are not persisted", () => {
  // Parity with `validateClaimQuotes`: a non-positive / non-integer / huge index can
  // never name a `Claim n/m` heading, and a blank quote is dropped there too — so
  // keeping them would only persist a payload the next propose throws away.
  const raw = JSON.stringify([
    { ...turn({ question: "negative" }), claimQuotes: [{ index: -1, quote: "x" }] },
    { ...turn({ question: "zero" }), claimQuotes: [{ index: 0, quote: "x" }] },
    { ...turn({ question: "fractional" }), claimQuotes: [{ index: 1.5, quote: "x" }] },
    { ...turn({ question: "huge" }), claimQuotes: [{ index: 1e21, quote: "x" }] },
    { ...turn({ question: "blank" }), claimQuotes: [{ index: 1, quote: "   " }] },
    { ...turn({ question: "mixed" }), claimQuotes: [{ index: 1, quote: "ok" }, { index: 0, quote: "x" }] },
    turn({ question: "clean", claimQuotes: [{ index: 1, quote: "ok" }] }),
  ]);
  const restored = deserializeAskSession(raw);
  expect(restored.map((t) => t.question)).toEqual([
    "negative",
    "zero",
    "fractional",
    "huge",
    "blank",
    "mixed",
    "clean",
  ]);
  for (let i = 0; i < 6; i++) expect(restored[i]!.claimQuotes).toBeUndefined();
  expect(restored[6]!.claimQuotes).toEqual([{ index: 1, quote: "ok" }]);
});
