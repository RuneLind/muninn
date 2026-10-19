/**
 * The Latest rail's fact-check badges (`sumFactcheckLoadBadges`) against a
 * stubbed fetch and a stubbed rail row. The route answers a failed lookup with
 * 200 `{badges: [], error}`; that must keep the badges already known, while a
 * plain empty list (a deleted check) still clears them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sumFactcheckBadgeHtml, sumFactcheckLoadBadges } from "./sum-factcheck-client.ts";

interface Row {
  dataset: { source: string; docId: string };
  meta: { html: string; querySelector: (s: string) => { remove: () => void } | null; insertAdjacentHTML: (p: string, h: string) => void };
  querySelector: (s: string) => Row["meta"] | null;
}

function railRow(source: string, docId: string): Row {
  const meta: Row["meta"] = {
    html: "",
    querySelector: (s) => (s === ".sum-fc-badge" && meta.html ? { remove: () => void (meta.html = "") } : null),
    insertAdjacentHTML: (_p, h) => void (meta.html += h),
  };
  return { dataset: { source, docId }, meta, querySelector: (s) => (s === ".sum-latest-meta" ? meta : null) };
}

const origFetch = globalThis.fetch;
const g = globalThis as { document?: unknown };
let row: Row;
let answer: unknown;

beforeEach(() => {
  row = railRow("youtube", "ai/A Talk.md");
  g.document = { querySelectorAll: () => [row] };
  globalThis.fetch = (async () => Response.json(answer)) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete g.document;
});

describe("sumFactcheckLoadBadges", () => {
  test("a lookup error keeps the drawn badges; an empty list without one clears them", async () => {
    answer = { badges: [{ source: "youtube", docId: "ai/A Talk.md", bad: 2, total: 3 }] };
    await sumFactcheckLoadBadges();
    const drawn = sumFactcheckBadgeHtml("youtube", "ai/A Talk.md");
    expect(drawn).not.toBe("");
    expect(row.meta.html).toBe(drawn);

    // A DB hiccup: the route's 200 with `error`. Nothing moves.
    answer = { badges: [], error: "badge lookup failed" };
    await sumFactcheckLoadBadges();
    expect(sumFactcheckBadgeHtml("youtube", "ai/A Talk.md")).toBe(drawn);
    expect(row.meta.html).toBe(drawn);

    // The check was deleted: an honest empty list clears the badge.
    answer = { badges: [] };
    await sumFactcheckLoadBadges();
    expect(sumFactcheckBadgeHtml("youtube", "ai/A Talk.md")).toBe("");
    expect(row.meta.html).toBe("");
  });
});
