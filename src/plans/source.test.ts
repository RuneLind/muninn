import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlanSource, planRecordFromContent } from "./source.ts";
import { sha256 } from "../gardener/util.ts";

const tmpRoots: string[] = [];

/** A throwaway wiki root with a `plans/` dir. Tests never touch real mimir. */
async function makeWiki(
  files: Record<string, string>,
  queue?: string,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "muninn-plans-"));
  tmpRoots.push(root);
  await mkdir(path.join(root, "plans"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, "plans", name), content);
  }
  if (queue !== undefined) await writeFile(path.join(root, "plans", "queue.yaml"), queue);
  return root;
}

afterAll(async () => {
  for (const root of tmpRoots) await rm(root, { recursive: true, force: true });
});

const PLAN_A = `---
title: "Plan A"
tags: [muninn, plan]
plan_status: shipped
status_date: 2026-07-31
followups: open
status_note: "A note, with a comma"
---

# Plan A
`;

const PLAN_B = `---
title: Plan B
plan_status: proposed
priority: p1
---

# Plan B
`;

describe("planRecordFromContent", () => {
  test("reads the fields the board renders", () => {
    const warnings: string[] = [];
    const rec = planRecordFromContent("plans/a.md", PLAN_A, 1234, warnings)!;
    expect(rec.slug).toBe("a");
    expect(rec.title).toBe("Plan A");
    expect(rec.planStatus).toBe("shipped");
    expect(rec.statusDate).toBe("2026-07-31");
    expect(rec.statusNote).toBe("A note, with a comma");
    expect(rec.followupsOpen).toBe(true);
    expect(rec.tags).toEqual(["muninn", "plan"]);
    expect(rec.mtimeMs).toBe(1234);
    expect(rec.hash).toBe(sha256(PLAN_A));
    expect(warnings).toEqual([]);
  });

  test("a file with no plan_status is not a plan", () => {
    const warnings: string[] = [];
    expect(planRecordFromContent("plans/x.md", "---\ntitle: X\n---\n", 0, warnings)).toBeNull();
    expect(planRecordFromContent("plans/x.md", "# no frontmatter\n", 0, warnings)).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("an invalid plan_status warns and leaves the status unknown, keeping the card", () => {
    const warnings: string[] = [];
    const rec = planRecordFromContent("plans/x.md", "---\nplan_status: doing\n---\n", 0, warnings)!;
    expect(rec.planStatus).toBeUndefined();
    expect(warnings.join()).toContain('plan_status "doing"');
  });

  test("an invalid priority and a malformed status_date are dropped with warnings", () => {
    const warnings: string[] = [];
    const rec = planRecordFromContent(
      "plans/x.md",
      "---\nplan_status: ready\npriority: urgent\nstatus_date: 2026-7-3\n---\n",
      0,
      warnings,
    )!;
    expect(rec.priority).toBeUndefined();
    expect(rec.statusDate).toBeUndefined();
    expect(warnings.length).toBe(2);
  });

  test("title falls back to the slug", () => {
    const rec = planRecordFromContent("plans/some-plan.mdx", "---\nplan_status: ready\n---\n", 0, [])!;
    expect(rec.slug).toBe("some-plan");
    expect(rec.title).toBe("some-plan");
  });

  test("followups is open ONLY for the literal value", () => {
    const mk = (v: string) =>
      planRecordFromContent("plans/x.md", `---\nplan_status: shipped\nfollowups: ${v}\n---\n`, 0, [])!;
    expect(mk("open").followupsOpen).toBe(true);
    expect(mk("none").followupsOpen).toBe(false);
  });

  test("the fence-scoped parse ignores a plan_status inside a fenced YAML example", async () => {
    // The real trap: mimir-plan-status-lifecycle.mdx carries `plan_status:` in
    // its frontmatter AND inside a ```yaml block ~140 lines down. A line grep
    // reads two statuses out of this file.
    const raw = await Bun.file(
      path.join(import.meta.dir, "fixtures", "mimir-plan-status-lifecycle.mdx"),
    ).text();
    expect(raw.match(/^plan_status:/gm)?.length).toBeGreaterThan(1);
    const warnings: string[] = [];
    const rec = planRecordFromContent("plans/mimir-plan-status-lifecycle.mdx", raw, 0, warnings)!;
    expect(rec.planStatus).toBe("shipped");
    expect(rec.statusDate).toBe("2026-07-31");
    expect(rec.followupsOpen).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe("loadPlanSource", () => {
  test("reads every plan, skips index.md and non-plans", async () => {
    const root = await makeWiki({
      "a.md": PLAN_A,
      "b.mdx": PLAN_B,
      "index.md": "# Plans\n",
      "notes.md": "---\ntitle: Not a plan\n---\n",
      "queue.yaml.bak": "proposed:\n  - a\n",
    });
    const res = await loadPlanSource({ root });
    expect(res.root).toBe(root);
    expect(res.plans.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(res.plans[1]!.priority).toBe("p1");
    expect(res.warnings).toEqual([]);
  });

  test("an absent queue.yaml gives the bootstrap sentinel hash", async () => {
    const root = await makeWiki({ "a.md": PLAN_A });
    const res = await loadPlanSource({ root });
    expect(res.queue).toEqual({ order: {}, hash: "" });
  });

  test("a present queue.yaml carries its own sha256 and is validated against disk", async () => {
    const queue = "proposed:\n  - b\n  - ghost\nready:\n  - a\n";
    const root = await makeWiki({ "a.md": PLAN_A, "b.mdx": PLAN_B }, queue);
    const res = await loadPlanSource({ root });
    expect(res.queue.hash).toBe(sha256(queue));
    expect(res.queue.order).toEqual({ proposed: ["b"], ready: ["a"] });
    expect(res.warnings.join()).toContain('"ghost" names no plan on disk');
  });

  test("a missing plans/ directory degrades to a warning, not a throw", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muninn-plans-empty-"));
    tmpRoots.push(root);
    const res = await loadPlanSource({ root });
    expect(res.plans).toEqual([]);
    expect(res.queue.hash).toBe("");
    expect(res.warnings.join()).toContain("unreadable");
  });
});
