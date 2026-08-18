/**
 * The fence-scoped priority upsert.
 *
 * The load-bearing case is the checked-in copy of
 * `plans/mimir-plan-status-lifecycle.mdx`, which carries `plan_status:` in its
 * frontmatter AND again inside a fenced ```yaml example (with its own `---`
 * lines) around line 145. A whole-file line upsert edits that example; the
 * assertions here are on BYTES after the closing fence, not on a re-parse.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { setPlanPriority, type PlanPriorityEdit } from "./frontmatter.ts";
import { planRecordFromContent } from "./source.ts";
import type { PlanPriority } from "./constants.ts";

/** The edited bytes, asserting the edit was a change and not a noop/refusal. */
function set(content: string, priority: PlanPriority | null): string {
  const edit = setPlanPriority(content, priority);
  if (edit.kind !== "changed") {
    throw new Error(`expected a changed edit, got ${edit.kind}: ${JSON.stringify(edit)}`);
  }
  return edit.content;
}

const kindOf = (edit: PlanPriorityEdit): string => edit.kind;

const LIFECYCLE = await Bun.file(
  path.join(import.meta.dir, "fixtures", "mimir-plan-status-lifecycle.mdx"),
).text();

/**
 * The fence boundaries as `parseFrontmatter` (`src/wiki/store.ts`) draws them —
 * open on a line STARTING with `---`, close at the first later line starting
 * with `---`. Spelled the reader's way on purpose: a helper using the stricter
 * `line === "---"` rule would agree with the bug these tests exist to catch.
 */
function closeIndex(content: string): number {
  return content.indexOf("\n---", 3);
}

/** Everything from the closing fence's newline on. */
function bodyAfterFence(content: string): string {
  const close = closeIndex(content);
  return close === -1 ? content : content.slice(close + 1);
}

function fenceLines(content: string): string[] {
  const close = closeIndex(content);
  const openEnd = content.indexOf("\n");
  if (close === -1 || openEnd === -1 || close <= openEnd) return [];
  return content.slice(openEnd + 1, close).split("\n");
}

describe("setPlanPriority on the real lifecycle plan", () => {
  test("inserts after plan_status and changes nothing outside the fence", () => {
    const out = set(LIFECYCLE, "p1");
    expect(out).not.toBeNull();
    expect(bodyAfterFence(out)).toBe(bodyAfterFence(LIFECYCLE));
    // The fenced ```yaml example's own plan_status line is untouched.
    expect(out.split("\n")[145]).toBe(LIFECYCLE.split("\n")[144]);
    expect(out).toContain("```yaml\n---\ntitle: …");

    const before = fenceLines(LIFECYCLE);
    const after = fenceLines(out);
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((l) => !before.includes(l))).toEqual(["priority: p1"]);
    // Anchored immediately after plan_status.
    expect(after[after.findIndex((l) => l.startsWith("plan_status:")) + 1]).toBe("priority: p1");
  });

  test("the board reads back the value that was written", () => {
    const out = set(LIFECYCLE, "p0");
    const rec = planRecordFromContent("plans/lifecycle.mdx", out, 1, [])!;
    expect(rec.priority).toBe("p0");
    expect(rec.planStatus).toBe("shipped");
  });

  test("changing and then clearing round-trips to the original bytes", () => {
    const first = set(LIFECYCLE, "p2");
    const changed = set(first, "p3");
    expect(changed).toContain("priority: p3");
    expect(fenceLines(changed).length).toBe(fenceLines(first).length);
    const cleared = set(changed, null);
    expect(cleared).toBe(LIFECYCLE);
  });

  test("re-setting the same value is a noop, as is clearing an absent one", () => {
    const withP1 = set(LIFECYCLE, "p1");
    expect(setPlanPriority(withP1, "p1")).toEqual({ kind: "noop" });
    expect(setPlanPriority(LIFECYCLE, null)).toEqual({ kind: "noop" });
  });
});

const PLAIN = `---
title: A plan
plan_status: proposed
---

# A plan

Body with a --- horizontal rule and a priority: p9 line in prose.
`;

describe("setPlanPriority fence handling", () => {
  test("a body line reading `priority:` is never the edit target", () => {
    const out = set(PLAIN, "p2");
    expect(bodyAfterFence(out)).toBe(bodyAfterFence(PLAIN));
    expect(out).toContain("priority: p9 line in prose");
    expect(out.split("\n").filter((l) => l === "priority: p2")).toHaveLength(1);
  });

  // A fence this cannot read is REFUSED, not silently reported as "nothing to
  // do": the two are different sentences to a reader whose click did nothing,
  // and the route maps them to 422 and 200 respectively.
  test("no line-1 fence ⇒ refused (fails closed)", () => {
    expect(kindOf(setPlanPriority(`# Title\n\n---\nplan_status: p\n---\n`, "p1"))).toBe("refused");
    expect(kindOf(setPlanPriority(`\n---\nplan_status: proposed\n---\n`, "p1"))).toBe("refused");
    expect(kindOf(setPlanPriority("", "p1"))).toBe("refused");
    expect(kindOf(setPlanPriority("---", "p1"))).toBe("refused");
  });

  test("an unterminated fence ⇒ refused (fails closed)", () => {
    const open = `---\nplan_status: proposed\n\n# Body\n`;
    expect(kindOf(setPlanPriority(open, "p1"))).toBe("refused");
    expect(kindOf(setPlanPriority(open, null))).toBe("refused");
  });

  test("no plan_status anchor ⇒ appended as the fence's last line", () => {
    const out = set(`---\ntitle: Anchorless\n---\n\nBody\n`, "p3");
    expect(fenceLines(out)).toEqual(["title: Anchorless", "priority: p3"]);
    expect(bodyAfterFence(out)).toBe("---\n\nBody\n");
  });

  test("a duplicate priority key is normalized to one line", () => {
    const dup = `---\nplan_status: ready\npriority: p0\ntitle: T\npriority: p3\n---\n\nBody\n`;
    expect(fenceLines(set(dup, "p2"))).toEqual([
      "plan_status: ready",
      "priority: p2",
      "title: T",
    ]);
    expect(fenceLines(set(dup, null))).toEqual(["plan_status: ready", "title: T"]);
  });

  test("an empty frontmatter fence still takes an insert", () => {
    expect(set(`---\n---\n\nBody\n`, "p1")).toBe(`---\npriority: p1\n---\n\nBody\n`);
  });
});

describe("setPlanPriority agrees with parseFrontmatter about where the fence is", () => {
  // `parseFrontmatter` opens on a line STARTING with `---` and closes at the
  // first later line starting with `---`. A writer requiring both fences to be
  // exactly `---` disagrees with it about which bytes are frontmatter, and the
  // disagreement is measured in body lines rewritten or deleted.
  const LOOSE_CLOSE =
    `---\ntitle: T\nplan_status: ready\n--- \n\npriority: DO-NOT-TOUCH\n\n---\n\n# Body\n`;

  test("a trailing space on the CLOSING fence never lets the edit reach body bytes", () => {
    const out = set(LOOSE_CLOSE, "p1");
    expect(out).not.toBeNull();
    expect(out).toContain("priority: DO-NOT-TOUCH");
    expect(bodyAfterFence(out)).toBe(bodyAfterFence(LOOSE_CLOSE));
    // The reader is the arbiter: it must read back exactly what was asked for.
    expect(planRecordFromContent("plans/loose.mdx", out, 1, [])!.priority).toBe("p1");
  });

  test("clearing under a loose closing fence deletes no body line", () => {
    const withP1 = set(LOOSE_CLOSE, "p1");
    const cleared = set(withP1, null);
    expect(cleared).toBe(LOOSE_CLOSE);
    expect(cleared).toContain("priority: DO-NOT-TOUCH");
  });

  test("a loose OPENING fence is editable, not permanently refused", () => {
    const loose = `--- \ntitle: T\nplan_status: ready\n---\n\n# Body\n`;
    // The board renders this file as a card (the reader opens on `startsWith`),
    // so a writer that cannot edit it is a card whose priority never sticks.
    expect(planRecordFromContent("plans/open.mdx", loose, 1, [])!.planStatus).toBe("ready");
    const out = set(loose, "p2");
    expect(out).not.toBeNull();
    expect(planRecordFromContent("plans/open.mdx", out, 1, [])!.priority).toBe("p2");
    expect(bodyAfterFence(out)).toBe(bodyAfterFence(loose));
  });

  test("a `----` opening fence is editable too", () => {
    const four = `----\ntitle: T\nplan_status: ready\n---\n\n# Body\n`;
    expect(planRecordFromContent("plans/four.mdx", four, 1, [])!.planStatus).toBe("ready");
    const out = set(four, "p0");
    expect(planRecordFromContent("plans/four.mdx", out, 1, [])!.priority).toBe("p0");
    expect(out.split("\n")[0]).toBe("----");
  });

  test("a body `---` rule is not the close when the real close comes first", () => {
    const ruled = `---\ntitle: T\nplan_status: ready\n---\n\nIntro\n\n---\n\n# After the rule\n`;
    const out = set(ruled, "p1");
    expect(out).toBe(
      `---\ntitle: T\nplan_status: ready\npriority: p1\n---\n\nIntro\n\n---\n\n# After the rule\n`,
    );
  });
});

describe("setPlanPriority on a CRLF file", () => {
  // `source.ts` normalizes only for PARSING and hashes as given, so the writer
  // must not rewrite terminators: the returned hash has to describe the bytes on
  // disk. The inserted line therefore copies the fence's own terminator and
  // every other byte is the file's.
  const CRLF = `---\r\ntitle: CRLF plan\r\nplan_status: ready\r\n---\r\n\r\n# Body\r\n`;

  test("keeps CRLF everywhere and inserts a CRLF line", () => {
    const out = set(CRLF, "p1");
    expect(out).toBe(`---\r\ntitle: CRLF plan\r\nplan_status: ready\r\npriority: p1\r\n---\r\n\r\n# Body\r\n`);
    expect(out.split("\n").every((l, i, all) => i === all.length - 1 || l.endsWith("\r"))).toBe(true);
    expect(planRecordFromContent("plans/crlf.mdx", out, 1, [])!.priority).toBe("p1");
  });

  test("clearing removes exactly that line, terminator included", () => {
    expect(set(set(CRLF, "p1"), null)).toBe(CRLF);
  });
});
