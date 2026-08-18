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
  NUDGE_RELOADING,
  NUDGE_RELOAD_FIRST,
  NUDGE_TERMINAL_COLUMN,
  ORDER_STALE_MESSAGE,
  orderDraftReason,
  orderRequest,
  parseBoardRefresh,
  parseOrderResult,
  parsePriorityResult,
  PLAN_READONLY_ENV,
  PRIORITY_STALE_MESSAGE,
  priorityControlState,
  priorityDraftReason,
  priorityRequest,
  prunedRankSlugs,
  prunedRankWarning,
  nudgeBlockedReason,
  QUEUE_UNREADABLE_REASON,
  retainDraft,
  transportFailure,
  unknownColumnWarning,
  writeCapability,
  writeModeSentence,
  type WriteCapability,
} from "./board-writes.ts";
import { ACTIVE_COLUMN_KEYS } from "./board-client-pure.ts";
import { QUEUE_COLUMNS } from "./queue.ts";
import { WIKI_READONLY_ENV } from "../wiki/readonly.ts";
import type { PlanPriority } from "./constants.ts";

const WRITE = writeCapability({ readonly: false, queueHash: "abc" });
const DRAFT = writeCapability({ readonly: true, queueHash: "abc" });
const OFF = writeCapability({ readonly: false, queueHash: null });
const RO_OFF = writeCapability({ readonly: true, queueHash: null });

function gate(over: Partial<Parameters<typeof nudgeBlockedReason>[0]> = {}) {
  return nudgeBlockedReason({
    rankUi: true,
    column: "ready",
    capability: WRITE,
    diskRanked: false,
    reloadPending: false,
    reloading: false,
    ...over,
  });
}

describe("writeCapability", () => {
  test("a writable instance owns both axes and retires the draft", () => {
    expect(WRITE).toMatchObject({
      orderMode: "write",
      priorityMode: "write",
      retirePriorityDraft: true,
      retireOrderDraft: true,
      readonly: false,
    });
  });

  test("a readonly instance keeps the draft — the overlay is all a reader has there", () => {
    expect(DRAFT).toMatchObject({
      orderMode: "draft",
      priorityMode: "draft",
      retirePriorityDraft: false,
      retireOrderDraft: false,
    });
  });

  test('an ABSENT queue.yaml ("") is writable — it is the bootstrap base, not a failure', () => {
    expect(writeCapability({ readonly: false, queueHash: "" }).orderMode).toBe("write");
  });

  test("an UNREADABLE queue.yaml turns ranking off and keeps priority writable", () => {
    expect(OFF.orderMode).toBe("off");
    expect(OFF.priorityMode).toBe("write");
    expect(OFF.orderOffReason).toBe(QUEUE_UNREADABLE_REASON);
    // The ORDER draft is the only ranking left, so it must not be retired —
    // but the priority axis is server-owned here, so that half must be.
    expect(OFF.retireOrderDraft).toBe(false);
    expect(OFF.retirePriorityDraft).toBe(true);
  });

  test("a READONLY instance with an unreadable queue turns ranking off too", () => {
    // The readonly branch used to short-circuit before it looked at the hash,
    // so this instance drafted an order over a column mimir really ranks and
    // never showed the banner saying why nothing could be saved.
    expect(RO_OFF.orderMode).toBe("off");
    expect(RO_OFF.orderOffReason).toBe(QUEUE_UNREADABLE_REASON);
    expect(RO_OFF.priorityMode).toBe("draft");
    expect(RO_OFF.retirePriorityDraft).toBe(false);
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

  test("a writable board allows the nudge", () => {
    expect(gate()).toBeNull();
  });

  // The precondition for both the queue chain and the focus restore: the button
  // that fired a write is still enabled when the board re-renders around it, so
  // a second click reaches the chain and `restoreNudgeFocus` has a live node to
  // hand focus back to. Disabling it here is what ate 2 of 5 rapid clicks and
  // dropped the keyboard to <body> after every write.
  test("a write in flight does NOT block the next nudge", () => {
    expect(gate()).toBeNull();
    expect(gate({ column: "proposed" })).toBeNull();
  });

  test("a standing reload-worthy failure blocks, and so does a refresh in flight", () => {
    expect(gate({ reloadPending: true })).toBe(NUDGE_RELOAD_FIRST);
    expect(gate({ reloading: true })).toBe(NUDGE_RELOADING);
    // A board mid-refresh says so even when a failure is also standing.
    expect(gate({ reloading: true, reloadPending: true })).toBe(NUDGE_RELOADING);
  });

  test("an unreadable queue blocks with its reason, on either kind of instance", () => {
    expect(gate({ capability: OFF })).toBe(QUEUE_UNREADABLE_REASON);
    expect(gate({ capability: RO_OFF })).toBe(QUEUE_UNREADABLE_REASON);
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

  test("a card whose hash a 4xx proved dead is disabled until Reload", () => {
    // Armed buttons over a known-dead base can only 409 again.
    expect(priorityControlState({ mode: "write", onDisk: true, busy: false, staleHash: true })).toMatchObject({
      disabled: true,
      title: NUDGE_RELOAD_FIRST,
    });
    expect(priorityControlState({ mode: "write", onDisk: false, busy: false, reloading: true })).toMatchObject({
      disabled: true,
      title: NUDGE_RELOADING,
    });
  });
});

describe("retainDraft", () => {
  const overlay = { priority: { alpha: "p0" as const }, order: { ready: ["alpha"] } };

  test("a writing board retires BOTH halves", () => {
    expect(retainDraft(overlay, WRITE)).toEqual({ priority: {}, order: {} });
  });

  test("a readonly board keeps both", () => {
    expect(retainDraft(overlay, DRAFT)).toEqual(overlay);
  });

  test("an unreadable queue keeps only the ORDER half", () => {
    // The bug this is the fix for: keeping the whole overlay left a stale draft
    // PRIORITY shadowing the server-owned priority axis — the chip rendered p0
    // off a draft with nothing on disk, and clicking p0 (the toggle-off
    // gesture) wrote p0 to the file with no visible change.
    expect(retainDraft(overlay, OFF)).toEqual({ priority: {}, order: { ready: ["alpha"] } });
  });

  test("the returned halves are copies — a later edit cannot reach the stored draft", () => {
    const kept = retainDraft(overlay, DRAFT);
    kept.priority.beta = "p1";
    expect(overlay.priority).toEqual({ alpha: "p0" });
  });
});

describe("the draft note's reasons", () => {
  test("each axis names its own", () => {
    expect(priorityDraftReason(DRAFT)).toContain("cannot write the wiki");
    // A priority draft on a writing board blamed on queue.yaml was the bug.
    expect(orderDraftReason(OFF)).toContain("queue.yaml");
    expect(orderDraftReason(DRAFT)).toContain("cannot write the wiki");
    expect(orderDraftReason(OFF)).not.toBe(priorityDraftReason(DRAFT));
  });
});

describe("writeModeSentence", () => {
  test("names what this board actually writes, per capability", () => {
    expect(writeModeSentence(WRITE)).toContain("plans/queue.yaml");
    expect(writeModeSentence(DRAFT)).toContain(PLAN_READONLY_ENV);
    const off = writeModeSentence(OFF);
    expect(off).toContain("Ranking is off");
    expect(off).not.toContain(PLAN_READONLY_ENV);
    // The masthead of a flipped board must stop claiming it writes anything.
    expect(writeModeSentence(DRAFT)).not.toContain("Setting a priority writes");
  });
});

describe("prunedRankSlugs", () => {
  test("names the disk-ranked slugs this write is about to drop", () => {
    expect(prunedRankSlugs(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
    expect(prunedRankSlugs(["a"], ["a"])).toEqual([]);
    expect(prunedRankWarning("b", "Ready")).toContain('"b"');
    expect(prunedRankWarning("b", "Ready")).toContain("Ready");
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
    ).toEqual({
      order: { ready: ["a"] },
      hash: "q2",
      written: true,
      deleted: false,
      warnings: ["dropped x"],
      unknownColumns: [],
    });
  });

  test("an unknown column in a SUCCESSFUL write is skipped, not fatal", () => {
    // It used to reject the whole 200 — a write that had already landed on
    // disk raised "a body this board does not understand — reload", and the
    // reader reloaded into the same key on the next write.
    const res = parseOrderResult({
      order: { ready: ["a"], shipped: ["b"] },
      hash: "q2",
      written: true,
      warnings: [],
    });
    expect(res?.order).toEqual({ ready: ["a"] });
    expect(res?.unknownColumns).toEqual(["shipped"]);
    expect(unknownColumnWarning("shipped")).toContain("shipped");
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
    // A mistyped list under a KNOWN key still refuses: that one arms the badges.
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

  test("400 and 404 offer Reload — both spell a board describing a corpus that moved", () => {
    // `no plan named "x"` is mimir's everyday lifecycle (a retired or renamed
    // plan): a 404 on the priority route, a 400 on the order route. Neither is
    // recoverable by clicking again, and both are fixed by a refetch.
    expect(classifyWriteFailure(404, { error: 'no plan named "gone"' }, "priority")).toEqual({
      kind: "stale",
      message: 'no plan named "gone"',
      reload: true,
    });
    expect(classifyWriteFailure(400, { error: 'no plan named "gone"' }, "order").reload).toBe(true);
    // 422 stays reload-free: a human has to go and fix a file by hand.
    expect(classifyWriteFailure(422, { error: "queue.yaml: unparseable YAML" }, "order").reload).toBe(false);
    // …and so does a transport failure, which says nothing about disk.
    expect(transportFailure("network").reload).toBe(false);
    expect(classifyWriteFailure(500, null, "order").reload).toBe(false);
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
    // The one row the readonly short-circuit got wrong.
    [true, null, "off", "draft"],
  ];
  for (const [ro, hash, order, priority] of rows) {
    test(`readonly=${ro} queueHash=${JSON.stringify(hash)} ⇒ ${order}/${priority}`, () => {
      const cap = writeCapability({ readonly: ro, queueHash: hash });
      expect([cap.orderMode, cap.priorityMode]).toEqual([order, priority]);
    });
  }
});

// The client rejects a nudge on any column outside `ACTIVE_COLUMN_KEYS`, and
// the server rejects any key outside `QUEUE_COLUMNS`. They were linked by a
// comment in each file; a column added to one and not the other would make the
// board draw a ▲▼ every press of which could only 400 (or, the other way, hide
// ranking on a column the file happily stores).
describe("the rankable column set", () => {
  test("is the same list the queue writer accepts", () => {
    expect([...ACTIVE_COLUMN_KEYS]).toEqual([...QUEUE_COLUMNS]);
  });
});

describe("parseBoardRefresh", () => {
  const card = {
    slug: "alpha",
    title: "Alpha",
    description: null,
    statusNote: null,
    planStatus: "ready",
    column: "ready",
    statusDate: "2026-08-01",
    ageDays: 3,
    mtimeMs: 1,
    priority: "p1",
    tags: ["x"],
    relPath: "plans/alpha.mdx",
    hash: "h1",
    followupsOpen: false,
    wikiUrl: "/wiki?wiki=mimir&relPath=plans/alpha.mdx",
    family: "muninn",
    familySource: "slug",
    familyConfident: false,
    mixedRepos: false,
    estimate: null,
    ledger: null,
  };
  const payload = {
    readonly: false,
    cards: [card],
    queue: { order: { ready: ["alpha"], shipped: ["alpha"] }, hash: "q1" },
    columns: [{ key: "ready", label: "Ready", scope: "active", hint: "h", tone: "--pb-ready" }],
    money: { available: false, reason: "the ledger is not answering" },
  };

  test("takes the contract, and skips a column key this board does not draw", () => {
    const fresh = parseBoardRefresh(payload);
    expect(fresh?.cards[0]).toMatchObject({ slug: "alpha", hash: "h1", priority: "p1" });
    expect(fresh?.queue).toEqual({ order: { ready: ["alpha"] }, hash: "q1" });
    expect(fresh?.money).toEqual({ available: false, reason: "the ledger is not answering" });
    expect(fresh?.columns[0]?.label).toBe("Ready");
  });

  test("an absent queue.yaml and an unreadable one both survive the parse", () => {
    expect(parseBoardRefresh({ ...payload, queue: { order: {}, hash: "" } })?.queue.hash).toBe("");
    expect(parseBoardRefresh({ ...payload, queue: { order: {}, hash: null } })?.queue.hash).toBeNull();
  });

  test("a status the enum does not know lands as null, exactly as the server files it", () => {
    expect(parseBoardRefresh({ ...payload, cards: [{ ...card, planStatus: "wat" }] })?.cards[0]?.planStatus).toBeNull();
  });

  // ALL of it or NONE of it: the caller commits the parsed board wholesale, so
  // a body that goes wrong halfway must leave the previous board standing
  // rather than a half-adopted one whose cards and CAS bases disagree.
  test("refuses a body that would half-adopt", () => {
    expect(parseBoardRefresh({ ...payload, cards: [{ ...card, hash: 7 }] })).toBeNull();
    expect(parseBoardRefresh({ ...payload, cards: [{ ...card, priority: "urgent" }] })).toBeNull();
    expect(parseBoardRefresh({ ...payload, cards: [{ ...card, column: "nowhere" }] })).toBeNull();
    expect(parseBoardRefresh({ ...payload, cards: [{ ...card, tags: [1] }] })).toBeNull();
    expect(parseBoardRefresh({ ...payload, queue: { order: { ready: [1] }, hash: "q" } })).toBeNull();
    expect(parseBoardRefresh({ ...payload, queue: { order: {} } })).toBeNull();
    expect(parseBoardRefresh({ ...payload, money: { available: "yes", reason: null } })).toBeNull();
    expect(parseBoardRefresh({ ...payload, readonly: undefined })).toBeNull();
    expect(parseBoardRefresh({ ...payload, columns: [{ key: "ready" }] })).toBeNull();
    expect(parseBoardRefresh(null)).toBeNull();
    expect(parseBoardRefresh([payload])).toBeNull();
  });
});
