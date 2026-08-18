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
import { setPlanPriority } from "./frontmatter.ts";
import { planRecordFromContent } from "./source.ts";

const LIFECYCLE = await Bun.file(
  path.join(import.meta.dir, "fixtures", "mimir-plan-status-lifecycle.mdx"),
).text();

/** Everything from the closing `---` of the frontmatter on. */
function bodyAfterFence(content: string): string {
  const lines = content.split("\n");
  const close = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, "") === "---");
  return lines.slice(close).join("\n");
}

function fenceLines(content: string): string[] {
  const lines = content.split("\n");
  const close = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, "") === "---");
  return lines.slice(1, close);
}

describe("setPlanPriority on the real lifecycle plan", () => {
  test("inserts after plan_status and changes nothing outside the fence", () => {
    const out = setPlanPriority(LIFECYCLE, "p1")!;
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
    const out = setPlanPriority(LIFECYCLE, "p0")!;
    const rec = planRecordFromContent("plans/lifecycle.mdx", out, 1, [])!;
    expect(rec.priority).toBe("p0");
    expect(rec.planStatus).toBe("shipped");
  });

  test("changing and then clearing round-trips to the original bytes", () => {
    const set = setPlanPriority(LIFECYCLE, "p2")!;
    const changed = setPlanPriority(set, "p3")!;
    expect(changed).toContain("priority: p3");
    expect(fenceLines(changed).length).toBe(fenceLines(set).length);
    const cleared = setPlanPriority(changed, null)!;
    expect(cleared).toBe(LIFECYCLE);
  });

  test("re-setting the same value is a noop, as is clearing an absent one", () => {
    const set = setPlanPriority(LIFECYCLE, "p1")!;
    expect(setPlanPriority(set, "p1")).toBeNull();
    expect(setPlanPriority(LIFECYCLE, null)).toBeNull();
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
    const out = setPlanPriority(PLAIN, "p2")!;
    expect(bodyAfterFence(out)).toBe(bodyAfterFence(PLAIN));
    expect(out).toContain("priority: p9 line in prose");
    expect(out.split("\n").filter((l) => l === "priority: p2")).toHaveLength(1);
  });

  test("no line-1 fence ⇒ noop (fails closed)", () => {
    expect(setPlanPriority(`# Title\n\n---\nplan_status: proposed\n---\n`, "p1")).toBeNull();
    expect(setPlanPriority(`\n---\nplan_status: proposed\n---\n`, "p1")).toBeNull();
    expect(setPlanPriority("", "p1")).toBeNull();
  });

  test("an unterminated fence ⇒ noop (fails closed)", () => {
    expect(setPlanPriority(`---\nplan_status: proposed\n\n# Body\n`, "p1")).toBeNull();
    expect(setPlanPriority(`---\nplan_status: proposed\n\n# Body\n`, null)).toBeNull();
  });

  test("no plan_status anchor ⇒ appended as the fence's last line", () => {
    const out = setPlanPriority(`---\ntitle: Anchorless\n---\n\nBody\n`, "p3")!;
    expect(fenceLines(out)).toEqual(["title: Anchorless", "priority: p3"]);
    expect(bodyAfterFence(out)).toBe("---\n\nBody\n");
  });

  test("a duplicate priority key is normalized to one line", () => {
    const dup = `---\nplan_status: ready\npriority: p0\ntitle: T\npriority: p3\n---\n\nBody\n`;
    expect(fenceLines(setPlanPriority(dup, "p2")!)).toEqual([
      "plan_status: ready",
      "priority: p2",
      "title: T",
    ]);
    expect(fenceLines(setPlanPriority(dup, null)!)).toEqual(["plan_status: ready", "title: T"]);
  });

  test("an empty frontmatter fence still takes an insert", () => {
    expect(setPlanPriority(`---\n---\n\nBody\n`, "p1")).toBe(`---\npriority: p1\n---\n\nBody\n`);
  });
});

describe("setPlanPriority on a CRLF file", () => {
  // `source.ts` normalizes only for PARSING and hashes as given, so the writer
  // must not rewrite terminators: the returned hash has to describe the bytes on
  // disk. The inserted line therefore copies the fence's own terminator and
  // every other byte is the file's.
  const CRLF = `---\r\ntitle: CRLF plan\r\nplan_status: ready\r\n---\r\n\r\n# Body\r\n`;

  test("keeps CRLF everywhere and inserts a CRLF line", () => {
    const out = setPlanPriority(CRLF, "p1")!;
    expect(out).toBe(`---\r\ntitle: CRLF plan\r\nplan_status: ready\r\npriority: p1\r\n---\r\n\r\n# Body\r\n`);
    expect(out.split("\n").every((l, i, all) => i === all.length - 1 || l.endsWith("\r"))).toBe(true);
    expect(planRecordFromContent("plans/crlf.mdx", out, 1, [])!.priority).toBe("p1");
  });

  test("clearing removes exactly that line, terminator included", () => {
    const set = setPlanPriority(CRLF, "p1")!;
    expect(setPlanPriority(set, null)).toBe(CRLF);
  });
});
