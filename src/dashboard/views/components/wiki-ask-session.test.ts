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
