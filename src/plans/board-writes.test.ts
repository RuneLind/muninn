/**
 * The write rules: the three modes, the draft-retirement decision, both gates,
 * the two request builders and the response/failure folding.
 */

import { describe, expect, test } from "bun:test";
import {
  admitPriorityEdit,
  applyPriorityResult,
  classifyWriteFailure,
  isRankableColumn,
  NUDGE_OFF_SORT,
  NUDGE_SAVING,
  NUDGE_TERMINAL_COLUMN,
  ORDER_STALE_MESSAGE,
  orderRequest,
  parseOrderResult,
  parsePriorityResult,
  PLAN_READONLY_ENV,
  PRIORITY_STALE_MESSAGE,
  priorityControlState,
  priorityRequest,
  nudgeBlockedReason,
  QUEUE_UNREADABLE_REASON,
  transportFailure,
  writeCapability,
  type WriteCapability,
} from "./board-writes.ts";
import { WIKI_READONLY_ENV } from "../wiki/readonly.ts";
import type { PlanPriority } from "./constants.ts";

const WRITE = writeCapability({ readonly: false, queueHash: "abc" });
const DRAFT = writeCapability({ readonly: true, queueHash: "abc" });
const OFF = writeCapability({ readonly: false, queueHash: null });

function gate(over: Partial<Parameters<typeof nudgeBlockedReason>[0]> = {}) {
  return nudgeBlockedReason({
    rankUi: true,
    column: "ready",
    capability: WRITE,
    diskRanked: false,
    busy: false,
    ...over,
  });
}

describe("writeCapability", () => {
  test("a writable instance owns both axes and retires the draft", () => {
    expect(WRITE).toMatchObject({
      orderMode: "write",
      priorityMode: "write",
      retireDraft: true,
      readonly: false,
    });
  });

  test("a readonly instance keeps the draft — the overlay is all a reader has there", () => {
    expect(DRAFT).toMatchObject({ orderMode: "draft", priorityMode: "draft", retireDraft: false });
  });

  test('an ABSENT queue.yaml ("") is writable — it is the bootstrap base, not a failure', () => {
    expect(writeCapability({ readonly: false, queueHash: "" }).orderMode).toBe("write");
  });

  test("an UNREADABLE queue.yaml turns ranking off and keeps priority writable", () => {
    expect(OFF.orderMode).toBe("off");
    expect(OFF.priorityMode).toBe("write");
    expect(OFF.orderOffReason).toBe(QUEUE_UNREADABLE_REASON);
    // The draft is the only ranking left, so it must NOT be retired.
    expect(OFF.retireDraft).toBe(false);
  });

  test("the readonly env name is the one src/wiki/readonly.ts uses", () => {
    expect(PLAN_READONLY_ENV).toBe(WIKI_READONLY_ENV);
  });
});

describe("nudgeBlockedReason", () => {
  test("off-sort beats every other reason", () => {
    expect(gate({ rankUi: false, capability: OFF })).toBe(NUDGE_OFF_SORT);
  });

  test("terminal columns have no queue.yaml key", () => {
    expect(gate({ column: "shipped" })).toBe(NUDGE_TERMINAL_COLUMN);
    expect(gate({ column: "followups" })).toBe(NUDGE_TERMINAL_COLUMN);
    expect(isRankableColumn("in-flight")).toBe(true);
  });

  test("a writable board allows the nudge, and blocks only while a write is in flight", () => {
    expect(gate()).toBeNull();
    expect(gate({ busy: true })).toBe(NUDGE_SAVING);
  });

  test("an unreadable queue blocks with its reason, in-flight or not", () => {
    expect(gate({ capability: OFF })).toBe(QUEUE_UNREADABLE_REASON);
  });

  test("readonly still drafts — except over a column queue.yaml already ranks", () => {
    expect(gate({ capability: DRAFT })).toBeNull();
    expect(gate({ capability: DRAFT, diskRanked: true })).toContain(PLAN_READONLY_ENV);
    // A disk-ranked column is fine to nudge on a WRITING board: that is the
    // whole point of the endpoint.
    expect(gate({ diskRanked: true })).toBeNull();
  });
});

describe("priorityControlState", () => {
  test("writable: enabled whatever is on disk", () => {
    expect(priorityControlState({ mode: "write", onDisk: true, busy: false }).disabled).toBe(false);
  });

  test("busy: disabled everywhere, so one card cannot double-POST", () => {
    expect(priorityControlState({ mode: "write", onDisk: false, busy: true })).toMatchObject({
      disabled: true,
      title: "saving…",
    });
  });

  test("draft mode: an on-disk priority is not editable, an absent one is", () => {
    expect(priorityControlState({ mode: "draft", onDisk: true, busy: false }).disabled).toBe(true);
    expect(priorityControlState({ mode: "draft", onDisk: false, busy: false }).disabled).toBe(false);
  });
});

describe("admitPriorityEdit", () => {
  test("drops a second click on a card already writing", () => {
    expect(admitPriorityEdit(new Set(), "a")).toBe(true);
    expect(admitPriorityEdit(new Set(["a"]), "a")).toBe(false);
    expect(admitPriorityEdit(new Set(["a"]), "b")).toBe(true);
  });
});

describe("priorityRequest", () => {
  const card = { slug: "alpha", priority: "p1" as const, hash: "h1" };

  test("a different priority sets it", () => {
    expect(priorityRequest(card, "p0")).toEqual({ slug: "alpha", priority: "p0", baseHash: "h1" });
  });

  test("clicking the one already on disk clears it, in the endpoint's one wire form", () => {
    expect(priorityRequest(card, "p1").priority).toBe("clear");
  });

  test("a plan with no priority never asks for a clear", () => {
    expect(priorityRequest({ ...card, priority: null }, "p3").priority).toBe("p3");
  });
});

describe("orderRequest", () => {
  test("posts exactly the one column that changed", () => {
    expect(orderRequest("ready", ["a", "b"], "q1")).toEqual({
      order: { ready: ["a", "b"] },
      baseHash: "q1",
    });
  });

  test("an empty list is a legal post — it un-ranks the column", () => {
    expect(orderRequest("ready", [], "q1")).toEqual({ order: { ready: [] }, baseHash: "q1" });
  });

  test('the bootstrap base ("") is sent as-is', () => {
    expect(orderRequest("ready", ["a"], "")?.baseHash).toBe("");
  });

  test("no base hash, or a terminal column, produces no request at all", () => {
    expect(orderRequest("ready", ["a"], null)).toBeNull();
    expect(orderRequest("shipped", ["a"], "q1")).toBeNull();
  });
});

describe("parsePriorityResult", () => {
  test("takes the contract", () => {
    expect(parsePriorityResult({ slug: "a", priority: "p2", hash: "h", written: true })).toEqual({
      slug: "a",
      priority: "p2",
      hash: "h",
      written: true,
    });
  });

  test("a cleared priority comes back as null", () => {
    expect(parsePriorityResult({ slug: "a", priority: null, hash: "h", written: true })?.priority).toBeNull();
  });

  test("refuses a shape whose hash could not be a CAS base", () => {
    expect(parsePriorityResult({ slug: "a", priority: "p2", hash: "" })).toBeNull();
    expect(parsePriorityResult({ slug: "", priority: "p2", hash: "h" })).toBeNull();
    expect(parsePriorityResult({ slug: "a", priority: "urgent", hash: "h" })).toBeNull();
    expect(parsePriorityResult(null)).toBeNull();
    expect(parsePriorityResult([{ slug: "a" }])).toBeNull();
  });
});

describe("parseOrderResult", () => {
  test("adopts the merged order and drops empty columns", () => {
    expect(
      parseOrderResult({
        order: { ready: ["a"], blocked: [] },
        hash: "q2",
        written: true,
        deleted: false,
        warnings: ["dropped x"],
      }),
    ).toEqual({ order: { ready: ["a"] }, hash: "q2", written: true, deleted: false, warnings: ["dropped x"] });
  });

  test('a delete answers hash "" — the bootstrap base, not a broken response', () => {
    const res = parseOrderResult({ order: {}, hash: "", written: false, deleted: true, warnings: [] });
    expect(res).toMatchObject({ hash: "", deleted: true });
    expect(res?.order).toEqual({});
  });

  test("missing warnings degrade to none", () => {
    expect(parseOrderResult({ order: {}, hash: "q" })?.warnings).toEqual([]);
  });

  test("refuses an off-contract body", () => {
    expect(parseOrderResult({ order: { shipped: ["a"] }, hash: "q" })).toBeNull();
    expect(parseOrderResult({ order: { ready: [1] }, hash: "q" })).toBeNull();
    expect(parseOrderResult({ order: {} })).toBeNull();
    expect(parseOrderResult("nope")).toBeNull();
  });
});

describe("applyPriorityResult", () => {
  const cards: Array<{ slug: string; priority: PlanPriority | null; hash: string }> = [
    { slug: "a", priority: null, hash: "h1" },
    { slug: "b", priority: "p3", hash: "h2" },
  ];

  test("replaces the card's priority AND its hash, leaving the rest identical", () => {
    const next = applyPriorityResult(cards, { slug: "a", priority: "p0", hash: "h9", written: true });
    expect(next[0]).toEqual({ slug: "a", priority: "p0", hash: "h9" });
    expect(next[1]).toBe(cards[1]!);
  });

  test("a slug this board no longer holds changes nothing", () => {
    expect(applyPriorityResult(cards, { slug: "zz", priority: "p0", hash: "h9", written: true })).toBe(
      cards,
    );
  });
});

describe("classifyWriteFailure", () => {
  test("409 is the surface's own sentence, with a reload offered", () => {
    expect(classifyWriteFailure(409, { error: "plans/a.mdx changed", stale: true }, "priority")).toEqual({
      kind: "stale",
      message: PRIORITY_STALE_MESSAGE,
      reload: true,
    });
    expect(classifyWriteFailure(409, {}, "order").message).toBe(ORDER_STALE_MESSAGE);
  });

  test("403 is the readonly flip, 422 keeps the server's text verbatim", () => {
    expect(classifyWriteFailure(403, { error: "no writes here", readonly: true }, "order")).toMatchObject({
      kind: "readonly",
      message: "no writes here",
    });
    expect(classifyWriteFailure(422, { error: "queue.yaml: unparseable YAML" }, "order")).toMatchObject({
      kind: "refused",
      message: "queue.yaml: unparseable YAML",
    });
  });

  test("anything else names its status when the body says nothing", () => {
    expect(classifyWriteFailure(500, null, "priority")).toEqual({
      kind: "error",
      message: "write failed (HTTP 500)",
      reload: false,
    });
    expect(classifyWriteFailure(400, { error: "  slug is required " }, "priority").message).toBe(
      "slug is required",
    );
    expect(transportFailure("network").kind).toBe("error");
  });
});

// A capability is exhaustive over its two inputs; this is the table the DOM
// branches on.
describe("the capability table", () => {
  const rows: Array<[boolean, string | null, WriteCapability["orderMode"], WriteCapability["priorityMode"]]> = [
    [false, "h", "write", "write"],
    [false, "", "write", "write"],
    [false, null, "off", "write"],
    [true, "h", "draft", "draft"],
    [true, null, "draft", "draft"],
  ];
  for (const [ro, hash, order, priority] of rows) {
    test(`readonly=${ro} queueHash=${JSON.stringify(hash)} ⇒ ${order}/${priority}`, () => {
      const cap = writeCapability({ readonly: ro, queueHash: hash });
      expect([cap.orderMode, cap.priorityMode]).toEqual([order, priority]);
    });
  }
});
