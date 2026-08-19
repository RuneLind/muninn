/**
 * Pure tests for the windowed acceptance block — the aggregation only. No database:
 * `summary-candidates.ts` calls `getDb()` inside its query functions, so importing the
 * module is side-effect-free. Co-located with the module (repo convention), which puts
 * it in the `test:db` glob; it needs no container of its own. The DB round-trip (window
 * filtering, dismissed_reason mapping, the float4 repackaging count against real Postgres
 * storage, the NaN window guard) is covered in `summary-candidates.test.ts`.
 *
 * The `?days=` clamp lives in `dashboard/routes/route-utils.ts` now (`clampIntQuery`,
 * shared with the claude-usage route) and is tested there.
 */
import { test, expect, describe } from "bun:test";
import {
  aggregateRecentRows,
  ACCEPTANCE_TARGET,
  type RecentRawRow,
} from "./summary-candidates.ts";
import { REPACKAGING_CLAMP_SHIPPED_AT } from "../watchers/repackaging-shape.ts";

const SHIPPED = REPACKAGING_CLAMP_SHIPPED_AT.getTime();

function row(over: Partial<RecentRawRow> = {}): RecentRawRow {
  return {
    source: "x",
    status: "new",
    dismissedReason: null,
    kind: "x-post",
    title: "@someone: an ordinary tweet about agents",
    score: 0.6,
    createdAt: SHIPPED + 60_000,
    ...over,
  };
}

/** Most tests don't care about the clamp floor — count every row in the window. */
const NO_FLOOR = 0;

describe("aggregateRecentRows", () => {
  test("every captured row lands in exactly one bucket; untriaged is separate from rejected", () => {
    const rows: RecentRawRow[] = [
      row({ status: "new" }),
      row({ status: "new" }),
      row({ status: "summarizing" }),
      row({ status: "summarized" }),
      row({ status: "dismissed", dismissedReason: "manual" }),
      row({ status: "dismissed", dismissedReason: "expired" }),
      row({ status: "dismissed", dismissedReason: "hype-dedup-sweep" }),
      row({ status: "dismissed", dismissedReason: null }),
      row({ status: "error" }),
    ];
    const [x] = aggregateRecentRows(rows, NO_FLOOR);
    expect(x!.source).toBe("x");
    expect(x!.captured).toBe(9);
    // new + summarizing — never looked at, NOT rejections.
    expect(x!.pending).toBe(3);
    expect(x!.triaged).toBe(6);
    expect(x!.summarized).toBe(1);
    expect(x!.dismissedManual).toBe(1);
    // expired + swept + unknown all fold into "auto" (bookkeeping, not judgements).
    expect(x!.dismissedAuto).toBe(3);
    expect(x!.error).toBe(1);
    // The buckets partition `captured` — nothing may fall out.
    expect(
      x!.pending + x!.summarized + x!.dismissedManual + x!.dismissedAuto + x!.error,
    ).toBe(x!.captured);
    // Rate is over judgements only: 1 / (1 + 1).
    expect(x!.acceptanceRate).toBeCloseTo(0.5, 5);
  });

  test("acceptanceRate is null when nothing was judged, even with rows captured", () => {
    // The exact shape the window is in today: everything captured, nothing triaged.
    const [x] = aggregateRecentRows([row(), row(), row()], NO_FLOOR);
    expect(x!.captured).toBe(3);
    expect(x!.pending).toBe(3);
    expect(x!.triaged).toBe(0);
    expect(x!.acceptanceRate).toBeNull();
  });

  test("splits per source, sorted, and only x carries the repackaging count", () => {
    const out = aggregateRecentRows(
      [
        row({ source: "x" }),
        row({ source: "anthropic", kind: "doc", title: "Tool use" }),
        row({ source: "anthropic", kind: "doc", title: "Tool use" }),
      ],
      NO_FLOOR,
    );
    expect(out.map((o) => o.source)).toEqual(["anthropic", "x"]);
    expect(out[0]!.captured).toBe(2);
    // The metric is X-vertical policy; other sources must not report a misleading 0.
    expect(out[0]!.repackagingShapedAbove08).toBeUndefined();
    expect(out[1]!.repackagingShapedAbove08).toBe(0);
  });

  test("repackaging count: shape on the handle-stripped title, score strictly above the cap", () => {
    const out = aggregateRecentRows(
      [
        // Shaped (ALL-CAPS run) + 0.9 ⇒ counted.
        row({ title: "@a: EVERYONE SHOULD SEE this thread", score: 0.9 }),
        // Shaped (leading 🚨) + 0.85 ⇒ counted.
        row({ title: "@b: 🚨 new agent framework", score: 0.85 }),
        // Shaped ("just released") but exactly AT the cap ⇒ not counted.
        row({ title: "@c: Anthropic just released a course", score: 0.8 }),
        // Shaped but below the cap ⇒ not counted.
        row({ title: "@d: BREAKINGNEWS from the lab", score: 0.7 }),
        // Unshaped at 0.95 ⇒ not counted.
        row({ title: "@e: a careful writeup of tool use", score: 0.95 }),
      ],
      NO_FLOOR,
    );
    expect(out[0]!.repackagingShapedAbove08).toBe(2);
  });

  test("only x-post rows are counted — x-link pointers are exempt from the clamp by design", () => {
    // `clampScores` in x.ts returns false for anything but `kind === 'x-post'`, so an
    // x-link row above the cap is not a row the clamp failed to reach; counting it would
    // make the target-0 metric permanently non-zero for a deliberate exemption.
    const out = aggregateRecentRows(
      [
        row({ kind: "x-link", title: "@a: 🚨 pointer to a launch", score: 0.95 }),
        row({ kind: null, title: "@b: 🚨 a pre-migration row", score: 0.95 }),
        row({ kind: "x-post", title: "@c: 🚨 the one the clamp owns", score: 0.95 }),
      ],
      NO_FLOOR,
    );
    expect(out[0]!.repackagingShapedAbove08).toBe(1);
  });

  test("the empty-first-line fallback shape is exempt (a SECOND @handle: survives the strip)", () => {
    // `candidateTitle` is `@handle: ` + (firstLine || text), and `text` is the compact
    // digest which carries its OWN `@handle:` prefix. x.ts refuses to clamp an empty
    // first line for exactly that reason, so the metric must refuse to count it: after
    // stripping one prefix the remainder still starts with `@\S+:`.
    const out = aggregateRecentRows(
      [
        row({ title: "@OPENAIDEVS: @OPENAIDEVS: https://x.com/i/1 SOMETHINGLOUD", score: 0.95 }),
        // The long-form digest carries the `[ARTICLE/NOTE] ` marker BEFORE its own
        // handle (`compactTweetText`), so the fallback shape is `@h: [ARTICLE/NOTE] @h: …`
        // on exactly the x-post population this metric counts — exempt as well.
        row({ title: "@alice: [ARTICLE/NOTE] @alice: Anthropic just released a 4-hour course", score: 0.9 }),
        row({ title: "@a: SOMETHINGLOUD in a real first line", score: 0.95 }),
      ],
      NO_FLOOR,
    );
    expect(out[0]!.repackagingShapedAbove08).toBe(1);
  });

  test("the handle prefix itself cannot trigger the shape", () => {
    // "@ALLCAPSHANDLE:" is a 13-letter caps run — if the prefix were left on, this
    // ordinary tweet would be counted as repackaging-shaped forever.
    const out = aggregateRecentRows(
      [row({ title: "@ALLCAPSHANDLE: a measured note on evals", score: 0.9 })],
      NO_FLOOR,
    );
    expect(out[0]!.repackagingShapedAbove08).toBe(0);
  });

  test("float4 read-back at the cap does not count (the rounding trap)", () => {
    // Postgres stores 0.8 as float4 and hands it back as 0.800000011920929. A raw
    // `> 0.8` counts that row; rounding to 2 dp first does not.
    const raw = 0.800000011920929;
    expect(raw > 0.8).toBe(true);
    const out = aggregateRecentRows([row({ title: "@f: 🚨 clamped to the cap", score: raw })], NO_FLOOR);
    expect(out[0]!.repackagingShapedAbove08).toBe(0);
  });

  test("rows captured BEFORE the clamp shipped are not counted (the ratchet floor)", () => {
    // The upsert keeps GREATEST(stored, incoming), so a pre-clamp high is permanent —
    // counting those rows measures the ratchet, not the clamp. Only the two other
    // buckets (captured, pending) still see them: the floor is repackaging-only.
    const out = aggregateRecentRows(
      [
        row({ title: "@a: 🚨 captured before the clamp", score: 0.95, createdAt: SHIPPED - 1 }),
        row({ title: "@b: 🚨 captured at the clamp instant", score: 0.95, createdAt: SHIPPED }),
        row({ title: "@c: 🚨 captured after the clamp", score: 0.95, createdAt: SHIPPED + 1 }),
      ],
      SHIPPED,
    );
    expect(out[0]!.captured).toBe(3);
    // `>=` the floor: the boundary row counts.
    expect(out[0]!.repackagingShapedAbove08).toBe(2);
  });

  test("no rows ⇒ no sources (an empty window is empty, not a row of zeros)", () => {
    expect(aggregateRecentRows([], NO_FLOOR)).toEqual([]);
  });

  test("the stated target is the floor heuristic's, not a second number", () => {
    expect(ACCEPTANCE_TARGET).toBe(0.5);
  });
});
