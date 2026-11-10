/**
 * The status date check's pure rule, plus how a page's `prs:` reaches it
 * through the real index. Repos, numbers and dates are made up.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../test/temp-dir.ts";
import { checkStatusDate, judgeStatusDate, readStatusDateInputs, unknownReasonOf, type StatusDateVerdict, type UnknownReason } from "./status-date-check.ts";
import { getWikiIndex } from "./store.ts";
import type { PrFact, PrRef } from "./work-map/gh-check.ts";

const merged = (mergedAt: string): PrFact => ({ state: "MERGED", mergedAt });
const OPEN: PrFact = { state: "OPEN", mergedAt: null };

function inputs(prs: string[] | undefined, status_date: string | undefined = "2026-05-10") {
  const read = readStatusDateInputs({ prs, status_date });
  if (!read.ok) throw new Error(`not ok: ${JSON.stringify(read.verdict)}`);
  return read;
}

function judge(prs: string[], facts: Record<string, PrFact | null>, statusDate = "2026-05-10", reason?: (r: PrRef) => UnknownReason): StatusDateVerdict {
  const read = inputs(prs, statusDate);
  return judgeStatusDate(read.statusDate, read.refs, new Map(Object.entries(facts).map(([k, v]) => [k.toLowerCase(), v])), reason, read.unreadable);
}

describe("the rule", () => {
  test("a merge on a later day than status_date is late, naming the PR and its day", () => {
    expect(judge(["acme/gears#7"], { "acme/gears#7": merged("2026-05-11T09:00:00Z") })).toEqual({
      verdict: "late",
      statusDate: "2026-05-10",
      newest: { pr: "acme/gears#7", repo: "acme/gears", n: 7, mergedAt: "2026-05-11T09:00:00Z", mergedDay: "2026-05-11" },
    });
  });

  test("a merge on the same day is clear", () => {
    expect(judge(["acme/gears#7"], { "acme/gears#7": merged("2026-05-10T09:00:00Z") }).verdict).toBe("clear");
  });

  test("a merge on an earlier day is clear, and names the newest merge", () => {
    const v = judge(["acme/gears#7", "acme/gears#8"], { "acme/gears#7": merged("2026-05-01T09:00:00Z"), "acme/gears#8": merged("2026-05-03T09:00:00Z") });
    expect(v).toMatchObject({ verdict: "clear", newest: { pr: "acme/gears#8", mergedDay: "2026-05-03" } });
  });

  test("the newest of several merges decides, not the first listed", () => {
    const v = judge(["acme/gears#7", "acme/gears#8"], { "acme/gears#7": merged("2026-05-09T09:00:00Z"), "acme/gears#8": merged("2026-05-12T09:00:00Z") });
    expect(v).toMatchObject({ verdict: "late", newest: { pr: "acme/gears#8" } });
  });

  test("a merge at 23:30 UTC is the next day in Oslo", () => {
    // 2026-05-10 23:30 UTC is 2026-05-11 01:30 in Oslo (summer time).
    const v = judge(["acme/gears#7"], { "acme/gears#7": merged("2026-05-10T23:30:00Z") });
    expect(v).toMatchObject({ verdict: "late", newest: { mergedDay: "2026-05-11" } });
    // And in winter (UTC+1) too.
    const w = judge(["acme/gears#7"], { "acme/gears#7": merged("2026-01-10T23:30:00Z") }, "2026-01-10");
    expect(w).toMatchObject({ verdict: "late", newest: { mergedDay: "2026-01-11" } });
  });

  test("an open or closed PR with no merge is clear when known", () => {
    expect(judge(["acme/gears#7", "acme/gears#8"], { "acme/gears#7": OPEN, "acme/gears#8": { state: "CLOSED", mergedAt: null } })).toEqual({ verdict: "clear", statusDate: "2026-05-10" });
  });

  describe("an unknown entry", () => {
    test("with no known later merge: not checked, not-asked", () => {
      expect(judge(["acme/gears#7", "acme/gears#8"], { "acme/gears#7": merged("2026-05-01T09:00:00Z") })).toEqual({ verdict: "notChecked", reason: "not-asked" });
    });

    test("beside a known later merge: late all the same", () => {
      expect(judge(["acme/gears#7", "acme/gears#8"], { "acme/gears#7": merged("2026-05-20T09:00:00Z") }).verdict).toBe("late");
    });

    test("a merged PR with no merge date is unknown", () => {
      expect(judge(["acme/gears#7"], { "acme/gears#7": { state: "MERGED", mergedAt: null } })).toEqual({ verdict: "notChecked", reason: "not-asked" });
    });

    test("carries the worst reason and its repos", () => {
      // What the card's check recorded per repo: a login refusal of any kind reads `auth`.
      for (const refusal of ["auth", "sso", "no-access"] as const) {
        const reasons = unknownReasonOf(new Map([["acme/widgets", refusal]]));
        expect(judge(["acme/gears#8"], {}, "2026-05-10", reasons)).toEqual({ verdict: "notChecked", reason: "not-asked" });
        expect(judge(["acme/gears#8", "Acme/Widgets#1"], {}, "2026-05-10", reasons)).toEqual({ verdict: "notChecked", reason: "auth", repos: ["Acme/Widgets"] });
      }
      const noGh = unknownReasonOf(new Map([["acme/gears", "no-gh"], ["acme/widgets", "auth"]]));
      expect(judge(["acme/gears#8", "acme/widgets#1"], {}, "2026-05-10", noGh)).toEqual({ verdict: "notChecked", reason: "no-gh", repos: ["acme/gears"] });
    });
  });

  describe("NOT_FOUND", () => {
    test("an entry GitHub says is no PR is left out of the comparison", () => {
      expect(judge(["acme/gears#7", "acme/gears#9"], { "acme/gears#7": merged("2026-05-01T09:00:00Z"), "acme/gears#9": null }).verdict).toBe("clear");
    });

    test("every entry NOT_FOUND is no-prs", () => {
      expect(judge(["acme/gears#9", "acme/gears#10"], { "acme/gears#9": null, "acme/gears#10": null })).toEqual({ verdict: "notChecked", reason: "no-prs" });
    });
  });
});

describe("an entry of no PR shape", () => {
  test("beside a known earlier merge: unreadable-prs, never clear, naming the entry", () => {
    expect(judge(["acme/gears#5", "#838"], { "acme/gears#5": merged("2026-05-01T09:00:00Z") })).toEqual({ verdict: "notChecked", reason: "unreadable-prs", unreadable: ["#838"] });
  });

  test("beside a known later merge: late still wins", () => {
    expect(judge(["acme/gears#5", "TBD"], { "acme/gears#5": merged("2026-05-20T09:00:00Z") }).verdict).toBe("late");
  });

  test("beside an unknown entry or an all-NOT_FOUND list: unreadable-prs", () => {
    expect(judge(["acme/gears#5", "TBD"], {})).toEqual({ verdict: "notChecked", reason: "unreadable-prs", unreadable: ["TBD"] });
    expect(judge(["acme/gears#5", "TBD"], { "acme/gears#5": null })).toEqual({ verdict: "notChecked", reason: "unreadable-prs", unreadable: ["TBD"] });
  });

  test("the only entries: unreadable-prs, each entry once", () => {
    expect(readStatusDateInputs({ prs: ["#838"], status_date: "2026-05-10" })).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "unreadable-prs", unreadable: ["#838"] } });
    expect(readStatusDateInputs({ prs: ["TBD", "see later", "TBD"], status_date: "2026-05-10" })).toEqual({
      ok: false,
      verdict: { verdict: "notChecked", reason: "unreadable-prs", unreadable: ["TBD", "see later"] },
    });
  });
});

describe("checkStatusDate", () => {
  const live = { relPath: "plans/a.mdx", prs: ["acme/gears#7"], status_date: "2026-05-10", plan_status: "in-flight" as const, followups: undefined, culled: undefined };

  test("a page the card's check does not read is not-live", () => {
    const meta = { ...live, relPath: "blogs/b.mdx", plan_status: undefined };
    expect(checkStatusDate({ wiki: "w", meta }, 1)).toEqual({ wiki: "w", relPath: "blogs/b.mdx", at: 1, verdict: "notChecked", reason: "not-live" });
  });

  test("a live page on a wiki whose cache holds nothing is not-asked", () => {
    expect(checkStatusDate({ wiki: "never-asked", meta: live }, 1)).toEqual({ wiki: "never-asked", relPath: "plans/a.mdx", at: 1, verdict: "notChecked", reason: "not-asked" });
  });

  test("no-prs and no-status-date are answered for a live page with nothing cached", () => {
    expect(checkStatusDate({ wiki: "never-asked", meta: { ...live, prs: undefined } }, 1)).toMatchObject({ verdict: "notChecked", reason: "no-prs" });
    expect(checkStatusDate({ wiki: "never-asked", meta: { ...live, status_date: undefined } }, 1)).toMatchObject({ verdict: "notChecked", reason: "no-status-date" });
  });
});

describe("the inputs", () => {
  test("no prs: is no-prs", () => {
    expect(readStatusDateInputs({ prs: undefined, status_date: "2026-05-10" })).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "no-prs" } });
  });

  test("no prs: and no status_date is no-prs: the prs: answer comes first", () => {
    expect(readStatusDateInputs({ prs: undefined, status_date: undefined })).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "no-prs" } });
    expect(readStatusDateInputs({ prs: ["TBD"], status_date: undefined })).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "unreadable-prs", unreadable: ["TBD"] } });
  });

  test("no status_date is no-status-date", () => {
    expect(readStatusDateInputs({ prs: ["acme/gears#7"], status_date: undefined })).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "no-status-date" } });
  });

  test("a malformed status_date is no-status-date", () => {
    for (const bad of ["2026-02-31", "10.05.2026", "2026-5-10", "soon"]) {
      expect(readStatusDateInputs({ prs: ["acme/gears#7"], status_date: bad })).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "no-status-date" } });
    }
  });

  test("a full URL and owner/repo#n are the same PR, read once", () => {
    const read = inputs(["https://github.com/acme/gears/pull/7", "acme/gears#7", "Acme/Gears#7", "acme/widgets#3"]);
    expect(read.refs.map((r) => r.key)).toEqual(["acme/gears#7", "acme/widgets#3"]);
  });
});

describe("prs: through the index", () => {
  async function metaOf(fm: string) {
    const root = testTempDirSync(path.join(tmpdir(), "status-date-"));
    mkdirSync(path.join(root, "plans"), { recursive: true });
    writeFileSync(path.join(root, "plans/a.mdx"), `---\ntitle: A\nstatus_date: 2026-05-10\n${fm}---\n\n# A\n`);
    const index = await getWikiIndex({ root, refresh: true });
    return index!.resolveRelPath("plans/a.mdx")!;
  }

  const readable: [string, string, string[]][] = [
    ["an inline array", "prs: [acme/gears#7, https://github.com/acme/widgets/pull/3]\n", ["acme/gears#7", "acme/widgets#3"]],
    ["a single scalar", "prs: acme/gears#7\n", ["acme/gears#7"]],
  ];
  for (const [name, fm, want] of readable) {
    test(name, async () => {
      const read = readStatusDateInputs(await metaOf(fm));
      if (!read.ok) throw new Error(JSON.stringify(read.verdict));
      expect(read.refs.map((r) => r.key)).toEqual(want);
      expect(read.statusDate).toBe("2026-05-10");
    });
  }

  // The check reads `prs:` as the index does and no other way. These pin what
  // that gives for the shapes the index does not read as a list of PRs.
  const limits: [string, string, object][] = [
    ["an empty flow list is no-prs", "prs: []\n", { reason: "no-prs" }],
    ["an empty key is no-prs", "prs:\n", { reason: "no-prs" }],
    ["a block list, which the index drops, is no-prs", "prs:\n  - acme/gears#7\n  - https://github.com/acme/widgets/pull/3\n", { reason: "no-prs" }],
    ["a flow list with a trailing comment is unreadable-prs", "prs: [acme/gears#7] # landed\n", { reason: "unreadable-prs", unreadable: ["[acme/gears#7] # landed"] }],
    ["an unbracketed comma scalar is unreadable-prs", "prs: acme/gears#7, acme/gears#8\n", { reason: "unreadable-prs", unreadable: ["acme/gears#7, acme/gears#8"] }],
    ["an empty flow list with a comment is unreadable-prs", "prs: [] # none yet\n", { reason: "unreadable-prs", unreadable: ["[] # none yet"] }],
  ];
  for (const [name, fm, want] of limits) {
    test(name, async () => {
      expect(readStatusDateInputs(await metaOf(fm))).toEqual({ ok: false, verdict: { verdict: "notChecked", ...want } } as never);
    });
  }
});
