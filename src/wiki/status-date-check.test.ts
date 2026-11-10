/**
 * The status date check's pure rule, plus how a page's `prs:` reaches it
 * through the real index. Repos, numbers and dates are made up.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../test/temp-dir.ts";
import * as statusDateCheck from "./status-date-check.ts";
import { checkStatusDate, judgeStatusDate, readStatusDateInputs, unknownReasonOf, type StatusDateVerdict } from "./status-date-check.ts";
import { splitFrontmatter } from "./page-text.ts";
import { getWikiIndex, readWikiPage } from "./store.ts";
import type { PrFact, PrRef } from "./work-map/gh-check.ts";

const merged = (mergedAt: string): PrFact => ({ state: "MERGED", mergedAt });
const OPEN: PrFact = { state: "OPEN", mergedAt: null };

function inputs(prs: string[] | undefined, status_date: string | undefined = "2026-05-10") {
  const read = readStatusDateInputs({ prs, status_date });
  if (!read.ok) throw new Error(`not ok: ${JSON.stringify(read.verdict)}`);
  return read;
}

function judge(prs: string[], facts: Record<string, PrFact | null>, statusDate = "2026-05-10", reason?: (r: PrRef) => "no-state" | "budget" | "auth" | "no-gh"): StatusDateVerdict {
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
    test("with no known later merge: not checked, no-state", () => {
      expect(judge(["acme/gears#7", "acme/gears#8"], { "acme/gears#7": merged("2026-05-01T09:00:00Z") })).toEqual({ verdict: "notChecked", reason: "no-state" });
    });

    test("beside a known later merge: late all the same", () => {
      expect(judge(["acme/gears#7", "acme/gears#8"], { "acme/gears#7": merged("2026-05-20T09:00:00Z") }).verdict).toBe("late");
    });

    test("a merged PR with no merge date is unknown", () => {
      expect(judge(["acme/gears#7"], { "acme/gears#7": { state: "MERGED", mergedAt: null } })).toEqual({ verdict: "notChecked", reason: "no-state" });
    });

    test("carries the worst reason and its repos", () => {
      const reasons = unknownReasonOf({ overBudget: new Set(["acme/gears#8"]), failures: new Map([["acme/widgets", "sso"]]) });
      expect(judge(["acme/gears#8"], {}, "2026-05-10", reasons)).toEqual({ verdict: "notChecked", reason: "budget" });
      expect(judge(["acme/gears#8", "acme/widgets#1"], {}, "2026-05-10", reasons)).toEqual({ verdict: "notChecked", reason: "auth", repos: ["acme/widgets"] });
      const noGh = unknownReasonOf({ overBudget: new Set(), failures: new Map([["acme/gears", "no-gh"]]) });
      expect(judge(["acme/gears#8"], {}, "2026-05-10", noGh)).toEqual({ verdict: "notChecked", reason: "no-gh", repos: ["acme/gears"] });
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

  test("the only entries: unreadable-prs before any fetch, each entry once", () => {
    expect(readStatusDateInputs({ prs: ["#838"], status_date: "2026-05-10" })).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "unreadable-prs", unreadable: ["#838"] } });
    expect(readStatusDateInputs({ prs: ["TBD", "see later", "TBD"], status_date: "2026-05-10" })).toEqual({
      ok: false,
      verdict: { verdict: "notChecked", reason: "unreadable-prs", unreadable: ["TBD", "see later"] },
    });
  });
});

describe("checkStatusDate", () => {
  test("a page the card's check does not read is not-live and asks gh nothing", async () => {
    let spawns = 0;
    const gh = { index: async () => null, readBody: async () => null, runGh: async () => (spawns++, { exitCode: 0, stdout: "", stderr: "" }), disabled: () => false };
    const meta = { relPath: "blogs/b.mdx", prs: ["acme/gears#7"], status_date: "2026-05-10", plan_status: undefined, followups: undefined, culled: undefined };
    expect(await checkStatusDate({ wiki: "w", meta }, gh, () => 1)).toEqual({ wiki: "w", relPath: "blogs/b.mdx", at: 1, verdict: "notChecked", reason: "not-live" });
    expect(spawns).toBe(0);
  });
});

describe("prsKeyOf: the raw frontmatter's prs: key", () => {
  // Through the namespace, so the file still loads where the helper is missing.
  const prsKeyOf = (fm: string) => statusDateCheck.prsKeyOf(fm);
  const cases: [string, string, "absent" | "empty" | "present"][] = [
    ["no key", "title: A\nstatus_date: 2026-05-10\n", "absent"],
    ["a key only nested under another", "meta:\n  prs: [acme/gears#7]\n", "absent"],
    ["a longer key", "prs_note: x\n", "absent"],
    ["an empty value", "prs:\ntitle: A\n", "empty"],
    ["an empty flow list", "prs: []\n", "empty"],
    ["an empty flow list with a comment", "prs: [] # none yet\n", "empty"],
    ["an empty string", 'prs: ""\n', "empty"],
    ["a comment only", "prs: # later\n", "empty"],
    ["a block list", "prs:\n  - acme/gears#7\ntitle: A\n", "present"],
    ["a flow list", "prs: [acme/gears#7]\n", "present"],
    ["a CRLF block list", "prs:\r\n  - acme/gears#7\r\n", "present"],
  ];
  for (const [name, fm, want] of cases) test(name, () => expect(prsKeyOf(fm).state).toBe(want));

  test("carries the key's own lines, trimmed, and none of the next key's", () => {
    expect(prsKeyOf("prs:\n  - acme/gears#7\n  # a note\n  - acme/gears#8\ntitle: A\n").lines).toEqual(["prs:", "- acme/gears#7", "- acme/gears#8"]);
  });

  test("a page whose prs: key reads as nothing is unreadable-prs, not no-prs", () => {
    expect(readStatusDateInputs({ prs: undefined, status_date: "2026-05-10" }, "prs:\n  - acme/gears#7\n")).toEqual({
      ok: false,
      verdict: { verdict: "notChecked", reason: "unreadable-prs", unreadable: ["prs:", "- acme/gears#7"] },
    });
  });

  test("an empty or absent key stays no-prs", () => {
    for (const fm of ["prs: []\n", "prs:\n", "title: A\n", null]) {
      expect(readStatusDateInputs({ prs: undefined, status_date: "2026-05-10" }, fm)).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "no-prs" } });
    }
  });
});

describe("the inputs", () => {
  test("no prs: is no-prs", () => {
    expect(readStatusDateInputs({ prs: undefined, status_date: "2026-05-10" })).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "no-prs" } });
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
    const meta = index!.resolveRelPath("plans/a.mdx")!;
    const text = await readWikiPage(index!, meta);
    return { meta, frontmatter: splitFrontmatter(text!).frontmatter };
  }

  const readable: [string, string, string[]][] = [
    ["an inline array", "prs: [acme/gears#7, https://github.com/acme/widgets/pull/3]\n", ["acme/gears#7", "acme/widgets#3"]],
    ["a single scalar", "prs: acme/gears#7\n", ["acme/gears#7"]],
  ];
  for (const [name, fm, want] of readable) {
    test(name, async () => {
      const { meta, frontmatter } = await metaOf(fm);
      const read = readStatusDateInputs(meta, frontmatter);
      if (!read.ok) throw new Error(JSON.stringify(read.verdict));
      expect(read.refs.map((r) => r.key)).toEqual(want);
      expect(read.statusDate).toBe("2026-05-10");
    });
  }

  test("an empty key with a comment stays no-prs, though the parser reads the comment as a value", async () => {
    for (const fm of ["prs: [] # none yet\n", "prs: # later\n"]) {
      const { meta, frontmatter } = await metaOf(fm);
      expect(readStatusDateInputs(meta, frontmatter)).toEqual({ ok: false, verdict: { verdict: "notChecked", reason: "no-prs" } });
    }
  });

  // The shapes `parseFrontmatter` cannot read as a list: the author listed PRs,
  // so the page is never told it has none.
  const unreadable: [string, string][] = [
    ["a block list", "prs:\n  - acme/gears#7\n  - https://github.com/acme/widgets/pull/3\n"],
    ["a flow list with a trailing comment", "prs: [acme/gears#7] # landed\n"],
    ["a flow list over two lines", "prs: [acme/gears#7,\n  acme/gears#8]\n"],
    ["an unbracketed comma scalar", "prs: acme/gears#7, acme/gears#8\n"],
  ];
  for (const [name, fm] of unreadable) {
    test(`${name} is unreadable-prs`, async () => {
      const { meta, frontmatter } = await metaOf(fm);
      const read = readStatusDateInputs(meta, frontmatter);
      expect(read).toMatchObject({ ok: false, verdict: { verdict: "notChecked", reason: "unreadable-prs" } });
      if (!read.ok && read.verdict.verdict === "notChecked") expect(read.verdict.unreadable?.length).toBeGreaterThan(0);
    });
  }
});
