import { describe, expect, test } from "bun:test";
import type { TouchRecord } from "../git-dates.ts";
import type { WorkEvent } from "../work-focus.ts";
import { dailyActivity, linkifySigils, normalizeWorkMapAnswer, osloDay, slugifyEffortId, type NormalizeContext } from "./normalize.ts";
import { EFFORT_ID_RE, workMapAnswerSchema, type WorkMapAnswer, type WorkMapAnswerInput } from "./schema.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 86_400_000;

const rel = new Map([
  ["p1", "plans/alpha.mdx"],
  ["p2", "plans/beta.mdx"],
  ["p3", "archive/alpha-report.mdx"],
  ["p4", "blogs/alpha.mdx"],
]);

function ctx(over: Partial<NormalizeContext> = {}): NormalizeContext {
  return {
    rel,
    nowMs: NOW,
    sessionsSinceMs: NOW - 8 * DAY,
    gitTouches: new Map(),
    workEvents: () => undefined,
    ...over,
  };
}

type Effort = WorkMapAnswerInput["efforts"][number];
function effort(id: string, pages: Effort["pages"], over: Partial<Effort> = {}): Effort {
  return { id, name: id, aliases: [], oneLine: "", state: "active", pages, why: "", confidence: 0.8, next: "", related: [], ...over };
}
/** Built through the schema, as the runner does. */
function answer(efforts: Effort[], over: Partial<WorkMapAnswerInput> = {}): WorkMapAnswer {
  return workMapAnswerSchema.parse({ summary: "", needsYou: [], themes: [], efforts, loose: [], ...over });
}

describe("slugifyEffortId", () => {
  test("folds Norwegian letters, case, underscores and spaces", () => {
    expect(slugifyEffortId("årsavregning")).toBe("aarsavregning");
    expect(slugifyEffortId("Øvrig Arbeid_2025")).toBe("ovrig-arbeid-2025");
    expect(slugifyEffortId("Ærlig  test")).toBe("aerlig-test");
    expect(slugifyEffortId("café")).toBe("cafe");
  });
  test("numeric slugs pass EFFORT_ID_RE", () => {
    expect(EFFORT_ID_RE.test(slugifyEffortId("2025"))).toBe(true);
  });
});

describe("normalizeWorkMapAnswer, step by step", () => {
  test("1: an id like `årsavregning` is slugified, and so are its references", () => {
    const out = normalizeWorkMapAnswer(
      answer(
        [
          effort("årsavregning", [{ id: "p1", role: "plan" }]),
          effort("Under_Ar", [{ id: "p2", role: "plan" }], { parent: "årsavregning", related: [{ id: "årsavregning", why: "x" }] }),
        ],
        {
          themes: [{ name: "T", efforts: ["årsavregning"] }],
          needsYou: [{ title: "t", kind: "decision", why: "w", action: "a", pages: ["p1"], effort: "årsavregning" }],
        },
      ),
      ctx(),
    );
    expect(out.efforts.map((e) => e.id)).toEqual(["aarsavregning", "under-ar"]);
    expect(out.efforts[1]!.parent).toBe("aarsavregning");
    expect(out.efforts[1]!.related.map((r) => r.id)).toEqual(["aarsavregning"]);
    expect(out.themes[0]!.efforts).toEqual(["aarsavregning"]);
    expect(out.needsYou[0]!.effort).toBe("aarsavregning");
  });

  test("1: an id still invalid after slugifying is dropped", () => {
    const out = normalizeWorkMapAnswer(
      answer([effort("???", [{ id: "p1", role: "plan" }]), effort("x".repeat(80), [{ id: "p2", role: "plan" }]), effort("ok", [{ id: "p3", role: "report" }])]),
      ctx(),
    );
    expect(out.efforts.map((e) => e.id)).toEqual(["ok"]);
  });

  test("1: the pages of an effort dropped as invalid go to loose", () => {
    const out = normalizeWorkMapAnswer(
      answer([effort("日本", [{ id: "p1", role: "plan" }]), effort("x".repeat(80), [{ id: "p2", role: "plan" }, { id: "p3", role: "report" }]), effort("ok", [{ id: "p3", role: "report" }])]),
      ctx(),
    );
    expect(out.efforts.map((e) => [e.id, e.pages.map((p) => p.id)])).toEqual([["ok", ["archive/alpha-report.mdx"]]]);
    expect(out.loose).toEqual(["plans/alpha.mdx", "plans/beta.mdx"]);
  });

  test("2: a duplicate id keeps the first effort", () => {
    const out = normalizeWorkMapAnswer(
      answer([effort("a", [{ id: "p1", role: "plan" }], { name: "first" }), effort("A", [{ id: "p2", role: "plan" }], { name: "second" })]),
      ctx(),
    );
    expect(out.efforts.map((e) => [e.id, e.name])).toEqual([["a", "first"]]);
  });

  test("2: the pages of a dropped duplicate go to loose unless placed elsewhere", () => {
    const out = normalizeWorkMapAnswer(
      answer([effort("a", [{ id: "p1", role: "plan" }]), effort("A", [{ id: "p1", role: "plan" }, { id: "p2", role: "plan" }])], { loose: ["p4"] }),
      ctx(),
    );
    expect(out.efforts.map((e) => [e.id, e.pages.map((p) => p.id)])).toEqual([["a", ["plans/alpha.mdx"]]]);
    expect(out.loose).toEqual(["blogs/alpha.mdx", "plans/beta.mdx"]);
  });

  test("3: the id fields are remapped to relPaths; unknown page ids drop", () => {
    const out = normalizeWorkMapAnswer(
      answer([effort("a", [{ id: "p1", role: "plan" }, { id: "p3", role: "report", derivedFrom: "p1" }, { id: "p99", role: "log" }])], {
        needsYou: [{ title: "t", kind: "resume", why: "w", action: "a", pages: ["p3", "p42"], effort: "a" }],
        loose: ["p2", "p77"],
      }),
      ctx(),
    );
    expect(out.efforts[0]!.pages).toEqual([
      { id: "plans/alpha.mdx", role: "plan" },
      { id: "archive/alpha-report.mdx", role: "report", derivedFrom: "plans/alpha.mdx" },
    ]);
    expect(out.needsYou[0]!.pages).toEqual(["archive/alpha-report.mdx"]);
    expect(out.loose).toEqual(["plans/beta.mdx"]);
  });

  test("3: dangling effort references drop, including ones to an effort step 8 removed", () => {
    const out = normalizeWorkMapAnswer(
      answer(
        [
          effort("a", [{ id: "p1", role: "plan" }], { related: [{ id: "ghost", why: "x" }, { id: "empty", why: "y" }, { id: "a", why: "self" }] }),
          effort("empty", [{ id: "p99", role: "plan" }]),
          effort("child", [{ id: "p2", role: "plan" }], { parent: "empty" }),
        ],
        {
          themes: [{ name: "T", efforts: ["ghost", "empty"] }, { name: "U", efforts: ["a"] }],
          needsYou: [{ title: "t", kind: "blocked", why: "w", action: "a", pages: [], effort: "empty" }],
        },
      ),
      ctx(),
    );
    expect(out.efforts.map((e) => e.id)).toEqual(["a", "child"]);
    expect(out.efforts[0]!.related).toEqual([]);
    expect(out.efforts[1]!.parent).toBeUndefined();
    expect(out.themes).toEqual([{ name: "U", efforts: ["a"] }]);
    expect(out.needsYou[0]!.effort).toBeUndefined();
  });

  test("4: the declared-efforts hook runs after step 3 and before step 5", () => {
    const seen: string[][] = [];
    const out = normalizeWorkMapAnswer(answer([effort("a", [{ id: "p1", role: "plan" }]), effort("b", [{ id: "p1", role: "plan" }, { id: "p2", role: "plan" }])]), {
      ...ctx(),
      declared: (efforts) => {
        seen.push(efforts.flatMap((e) => e.pages.map((p) => p.id)));
        // Move p1 into b first: step 5 then keeps it in b only.
        return [efforts[1]!, efforts[0]!];
      },
    });
    expect(seen[0]).toEqual(["plans/alpha.mdx", "plans/alpha.mdx", "plans/beta.mdx"]);
    expect(out.efforts.map((e) => [e.id, e.pages.map((p) => p.id)])).toEqual([["b", ["plans/alpha.mdx", "plans/beta.mdx"]]]);
  });

  test("5: a page in two efforts stays in the first; loose loses placed pages", () => {
    const out = normalizeWorkMapAnswer(
      answer([effort("a", [{ id: "p1", role: "plan" }, { id: "p1", role: "plan" }]), effort("b", [{ id: "p1", role: "report" }, { id: "p2", role: "plan" }])], { loose: ["p1", "p4"] }),
      ctx(),
    );
    expect(out.efforts[0]!.pages.map((p) => p.id)).toEqual(["plans/alpha.mdx"]);
    expect(out.efforts[1]!.pages.map((p) => p.id)).toEqual(["plans/beta.mdx"]);
    expect(out.loose).toEqual(["blogs/alpha.mdx"]);
  });

  test("6: a derivedFrom outside its effort, on itself, or closing a cycle is cleared", () => {
    const out = normalizeWorkMapAnswer(
      answer([
        effort("a", [
          { id: "p1", role: "plan", derivedFrom: "p3" },
          { id: "p3", role: "report", derivedFrom: "p1" },
          { id: "p4", role: "explainer", derivedFrom: "p4" },
        ]),
        effort("b", [{ id: "p2", role: "plan", derivedFrom: "p1" }]),
      ]),
      ctx(),
    );
    const a = out.efforts[0]!.pages;
    expect(a[0]).toEqual({ id: "plans/alpha.mdx", role: "plan", derivedFrom: "archive/alpha-report.mdx" });
    expect(a[1]).toEqual({ id: "archive/alpha-report.mdx", role: "report" });
    expect(a[2]).toEqual({ id: "blogs/alpha.mdx", role: "explainer" });
    expect(out.efforts[1]!.pages[0]).toEqual({ id: "plans/beta.mdx", role: "plan" });
  });

  test("7: an orphan parent, a self parent and a parent cycle are cleared", () => {
    const out = normalizeWorkMapAnswer(
      answer([
        effort("a", [{ id: "p1", role: "plan" }], { parent: "nobody" }),
        effort("b", [{ id: "p2", role: "plan" }], { parent: "c" }),
        effort("c", [{ id: "p3", role: "plan" }], { parent: "b" }),
        effort("d", [{ id: "p4", role: "plan" }], { parent: "d" }),
      ]),
      ctx(),
    );
    const parents = Object.fromEntries(out.efforts.map((e) => [e.id, e.parent ?? null]));
    expect(parents).toEqual({ a: null, b: "c", c: null, d: null });
  });

  test("8: an effort left with no pages is dropped", () => {
    const out = normalizeWorkMapAnswer(answer([effort("a", [{ id: "p1", role: "plan" }]), effort("b", [{ id: "p1", role: "plan" }]), effort("c", [])]), ctx());
    expect(out.efforts.map((e) => e.id)).toEqual(["a"]);
  });

  test("9: one commit on three pages of an effort counts once that day", () => {
    const t = NOW - 2 * DAY;
    const rec = (path: string, commit: string, ts = t): TouchRecord => ({ ts, commit, path });
    const gitTouches = new Map<string, TouchRecord[]>([
      ["plans/alpha.mdx", [rec("plans/alpha.mdx", "c1"), rec("plans/alpha.mdx", "c2", t + 3_600_000)]],
      ["archive/alpha-report.mdx", [rec("archive/alpha-report.mdx", "c1")]],
      ["blogs/alpha.mdx", [rec("blogs/alpha.mdx", "c1"), rec("blogs/alpha.mdx", "old", NOW - 40 * DAY)]],
    ]);
    const events: Record<string, WorkEvent[]> = { "plans/alpha.mdx": [[t, 3, "focus"]], "blogs/alpha.mdx": [[t, 1, "touch"], [NOW - 20 * DAY, 1, "focus"]] };
    const out = normalizeWorkMapAnswer(
      answer([effort("a", [{ id: "p1", role: "plan" }, { id: "p3", role: "report" }, { id: "p4", role: "explainer" }])]),
      ctx({ gitTouches, workEvents: (r) => events[r] }),
    );
    expect(out.efforts[0]!.daily).toEqual([{ day: osloDay(t), commits: 2, sessions: 1 }]);
  });

  test("dailyActivity: one session on two pages counts once; an event with no session id counts alone", () => {
    const t = NOW - 2 * DAY;
    const events: Record<string, WorkEvent[]> = {
      "a.md": [[t, 3, "focus"]],
      "b.md": [[t + 60_000, 1, "touch"]],
      "c.md": [[t + 120_000, 1, "touch"]],
    };
    const refs = new Map([[`a.md\0${t}`, "claude-code:s1"], [`b.md\0${t + 60_000}`, "claude-code:s1"]]);
    const daily = dailyActivity(["a.md", "b.md", "c.md"], {
      nowMs: NOW,
      sessionsSinceMs: NOW - 8 * DAY,
      gitTouches: new Map(),
      workEvents: (r) => events[r],
      sessionOf: (r, lastMs) => refs.get(`${r}\0${lastMs}`),
    } as Parameters<typeof dailyActivity>[1]);
    expect(daily).toEqual([{ day: osloDay(t), commits: 0, sessions: 2 }]);
  });

  test("dailyActivity: days 9–28 count commits, sessions only inside the window", () => {
    const old = NOW - 15 * DAY;
    const daily = dailyActivity(["x.md"], {
      nowMs: NOW,
      sessionsSinceMs: NOW - 8 * DAY,
      gitTouches: new Map([["x.md", [{ ts: old, commit: "m", path: "x.md" }]]]),
      workEvents: () => [[old, 1, "focus"]],
    });
    expect(daily).toEqual([{ day: osloDay(old), commits: 1, sessions: 0 }]);
  });
});

describe("sigils", () => {
  test("only ⟨pN⟩ is rewritten; an unknown one loses its brackets; a bare p12 stays", () => {
    expect(linkifySigils("see ⟨p1⟩ and ⟨p99⟩, not p2", rel)).toBe("see ⟦plans/alpha.mdx⟧ and p99, not p2");
  });
  test("prose fields carry the marker, id fields do not", () => {
    const out = normalizeWorkMapAnswer(
      answer([effort("a", [{ id: "p1", role: "plan" }], { why: "⟨p1⟩ grew from ⟨p2⟩", next: "ship ⟨p1⟩", oneLine: "⟨p1⟩", related: [] })], {
        summary: "Mostly ⟨p1⟩.",
        needsYou: [{ title: "Decide ⟨p1⟩", kind: "decision", why: "⟨p1⟩ waits", action: "Answer ⟨p1⟩", pages: ["p1"], effort: "a" }],
      }),
      ctx(),
    );
    expect(out.summary).toBe("Mostly ⟦plans/alpha.mdx⟧.");
    expect(out.efforts[0]!.why).toBe("⟦plans/alpha.mdx⟧ grew from ⟦plans/beta.mdx⟧");
    expect(out.needsYou[0]!.title).toBe("Decide ⟦plans/alpha.mdx⟧");
    expect(out.needsYou[0]!.pages).toEqual(["plans/alpha.mdx"]);
  });
});

describe("workMapAnswerSchema", () => {
  test("rejects an unknown state or role; strips the prototype's extra fields", () => {
    const base = { summary: "s", needsYou: [], themes: [], loose: [], corrections: [{ x: 1 }], views: [] };
    const ok = workMapAnswerSchema.safeParse({ ...base, efforts: [effort("a", [{ id: "p1", role: "plan" }])] });
    expect(ok.success).toBe(true);
    expect(ok.success && "corrections" in ok.data).toBe(false);
    expect(workMapAnswerSchema.safeParse({ ...base, efforts: [effort("a", [{ id: "p1", role: "plan" }], { state: "done" as never })] }).success).toBe(false);
    expect(workMapAnswerSchema.safeParse({ ...base, efforts: [effort("a", [{ id: "p1", role: "draft" as never }])] }).success).toBe(false);
  });
  test("a null or missing optional field does not reject the answer", () => {
    const raw = {
      summary: null,
      needsYou: [
        { title: "Decide", kind: "decision", why: "w", action: "a", pages: ["p1"], effort: null },
        { title: "Resume", kind: "resume", why: null, action: "a" },
      ],
      themes: null,
      efforts: [{ id: "a", name: "A", state: "active", pages: [{ id: "p1", role: "plan" }], oneLine: null, why: null, next: null, confidence: null }],
    };
    const parsed = workMapAnswerSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    const out = normalizeWorkMapAnswer(parsed.success ? parsed.data : (null as never), ctx());
    expect(out.summary).toBe("");
    expect(out.themes).toEqual([]);
    expect(out.loose).toEqual([]);
    expect(out.needsYou.map((n) => [n.title, n.effort, n.pages, n.why])).toEqual([
      ["Decide", undefined, ["plans/alpha.mdx"], "w"],
      ["Resume", undefined, [], ""],
    ]);
    expect(out.efforts[0]).toMatchObject({ id: "a", aliases: [], related: [], oneLine: "", why: "", next: "", confidence: 0 });
    // Each field alone.
    const good = { summary: "s", needsYou: [{ title: "t", kind: "decision", why: "w", action: "a", pages: [], effort: "a" }], themes: [], efforts: [effort("a", [{ id: "p1", role: "plan" }])], loose: [] };
    const variants: [string, unknown][] = [
      ["null effort", { ...good, needsYou: [{ ...good.needsYou[0], effort: null }] }],
      ["missing effort", { ...good, needsYou: [{ ...good.needsYou[0], effort: undefined }] }],
      ["missing needsYou pages", { ...good, needsYou: [{ ...good.needsYou[0], pages: undefined }] }],
      ["missing related", { ...good, efforts: [{ ...good.efforts[0], related: undefined }] }],
      ["null related", { ...good, efforts: [{ ...good.efforts[0], related: null }] }],
      ["null themes", { ...good, themes: null }],
      ["null loose", { ...good, loose: null }],
      ["missing needsYou", { ...good, needsYou: undefined }],
    ];
    for (const [name, v] of variants) expect([name, workMapAnswerSchema.safeParse(v).success]).toEqual([name, true]);
    // Still required: the efforts list, an effort's id, name and pages.
    expect(workMapAnswerSchema.safeParse({ ...raw, efforts: null }).success).toBe(false);
    expect(workMapAnswerSchema.safeParse({ ...raw, efforts: [{ id: "a", name: "A", state: "active" }] }).success).toBe(false);
    expect(workMapAnswerSchema.safeParse({ ...raw, efforts: [{ name: "A", state: "active", pages: [] }] }).success).toBe(false);
  });
  test("a null parent or derivedFrom reads as absent", () => {
    const parsed = workMapAnswerSchema.parse({
      summary: "s",
      needsYou: [],
      themes: [],
      loose: [],
      efforts: [{ ...effort("a", [{ id: "p1", role: "plan" }]), parent: null, aliases: null, pages: [{ id: "p1", role: "plan", derivedFrom: null }] }],
    });
    expect(parsed.efforts[0]!.parent).toBeUndefined();
    expect(parsed.efforts[0]!.aliases).toEqual([]);
    expect(parsed.efforts[0]!.pages[0]!.derivedFrom).toBeUndefined();
  });
});
