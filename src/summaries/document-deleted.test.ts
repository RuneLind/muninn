import { test, expect } from "bun:test";
import { notifySummaryDocumentDeleted, onSummaryDocumentDeleted } from "./document-deleted.ts";

test("a throwing listener neither stops the others nor reaches the caller", () => {
  // The delete route calls notify AFTER huginn confirmed the move; a listener
  // that throws must not turn a successful delete into a muninn 500, and must
  // not starve the listeners registered after it.
  const heard: string[] = [];
  const offA = onSummaryDocumentDeleted(() => { throw new Error("boom"); });
  const offB = onSummaryDocumentDeleted((e) => { heard.push(e.id); });
  try {
    expect(() => notifySummaryDocumentDeleted({ collection: "vimeo-summaries", id: "x.md" })).not.toThrow();
    expect(heard).toEqual(["x.md"]);
  } finally {
    offA();
    offB();
  }
});

test("unsubscribing during a notify is safe, and an unsubscribed listener hears nothing more", () => {
  const heard: string[] = [];
  const off = onSummaryDocumentDeleted((e) => { heard.push(e.id); off(); });
  notifySummaryDocumentDeleted({ collection: "c", id: "1" });
  notifySummaryDocumentDeleted({ collection: "c", id: "2" });
  expect(heard).toEqual(["1"]);
});

test("a listener that unsubscribes ANOTHER listener mid-notify does not silence it for this event", () => {
  // The fan-out iterates a snapshot. Iterating the live Set would skip a
  // not-yet-visited listener that an earlier one removed — and a registration
  // that arrives mid-notify would be called for an event it never subscribed to.
  const heard: string[] = [];
  let offB: () => void = () => {};
  const offA = onSummaryDocumentDeleted(() => { offB(); });
  offB = onSummaryDocumentDeleted((e) => { heard.push(`B:${e.id}`); });
  try {
    notifySummaryDocumentDeleted({ collection: "c", id: "1" });
    expect(heard).toEqual(["B:1"]);
    notifySummaryDocumentDeleted({ collection: "c", id: "2" });
    expect(heard).toEqual(["B:1"]);
  } finally {
    offA();
    offB();
  }
});
