import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";
import { parseStatePhrases } from "../format/state-phrases.ts";

// Lint check 14 — state outside its home and state of a key another page owns
// (living-facts D10). Synthetic fixtures: an English phrase list and DEMO keys.

const BLOCK = {
  phrases: ["merged", "not merged", "in prod", "not in prod", "created", "is draft", "open as of"],
  taskWords: ["task", "PR", "PRs"],
};
let root: string;
const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-state-lint-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await mkdir(path.join(root, "archive"), { recursive: true });
  await write(".wiki-reader.json", JSON.stringify({ statePhrases: BLOCK }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function findings(check: string): Promise<LintFinding[]> {
  const index = await buildWikiIndex(root);
  return (await lintWiki(index)).findings.filter((f) => f.check === check);
}
const outside = () => findings("state-outside-home");
const notOwner = () => findings("state-not-owner");

const page = (body: string[], fm: string[] = []) =>
  ["---", "title: P", "type: plan", "plan_status: in-flight", "updated: 2026-10-01", ...fm, "---", "", "# P", "", ...body, ""].join("\n");
/** The 1-based line of body line `n` (0-based) in {@link page} with `fm` extra keys. */
const bodyLine = (n: number, fm = 0) => 10 + fm + n;

describe("parseStatePhrases", () => {
  test("absent is off with no warning; a good block parses, trimmed and deduplicated", () => {
    expect(parseStatePhrases(undefined)).toEqual({ config: null, warnings: [] });
    const r = parseStatePhrases({ phrases: [" merged ", "Merged", "in prod"], taskWords: ["PR"] });
    expect(r.config).toEqual({ phrases: ["merged", "in prod"], taskWords: ["PR"] });
    expect(r.warnings).toEqual([]);
  });

  test("a malformed block is off with a warning; a bad entry or taskWords drops alone", () => {
    for (const bad of [[], "merged", { phrases: "merged" }, { phrases: [] }, { phrases: [3, ""] }]) {
      const r = parseStatePhrases(bad);
      expect(r.config).toBeNull();
      expect(r.warnings.length).toBeGreaterThan(0);
    }
    const r = parseStatePhrases({ phrases: ["merged", 7], taskWords: "PR", extra: 1 });
    expect(r.config).toEqual({ phrases: ["merged"], taskWords: [] });
    expect(r.warnings).toHaveLength(3);
  });
});

describe("lint: state-outside-home", () => {
  test("a prose line with a state phrase and a Jira key warns, with its line", async () => {
    await write("plans/p.mdx", page(["Intro.", "", "The fix for DEMO-12 is merged and waits."]));
    const f = await outside();
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(bodyLine(2));
    expect(f[0]!.message).toContain("«merged»");
    expect(f[0]!.message).toContain("«DEMO-12»");
  });

  test("each anchor: a PR reference, a task word, the bare number of a jira:/owns: key", async () => {
    await write(
      "plans/p.mdx",
      page(
        [
          "See PR #31 — merged on Monday.",
          "",
          "The second task is not merged.",
          "",
          "So 12 can go in prod now.",
          "",
          "And 77 is draft still.",
          "",
          "And 99 is draft too.",
        ],
        ["jira: [DEMO-12]", "owns: [DEMO-77]"],
      ),
    );
    const lines = (await outside()).map((f) => f.line);
    expect(lines).toEqual([bodyLine(0, 2), bodyLine(2, 2), bodyLine(4, 2), bodyLine(6, 2)]);
  });

  test("a date qualifier is a state on its own; a bare date is not", async () => {
    await write(
      "plans/p.mdx",
      page(["DEMO-1 looked fine per 11.10.", "", "DEMO-2 looked fine per 1.9.2026.", "", "DEMO-3 looked fine (13.10).", "", "DEMO-4 looked at 13.10."]),
    );
    expect((await outside()).map((f) => f.line)).toEqual([bodyLine(0), bodyLine(2), bodyLine(4)]);
  });

  test("a domain verb in prose with no anchor passes, and so does a quote with an anchor", async () => {
    await write(
      "plans/p.mdx",
      page(["The case was created in 2024 and is merged into another.", "", "> The team said DEMO-5 was created by hand."]),
    );
    expect(await outside()).toEqual([]);
  });

  test("on a wiki whose trackers name projects, only those prefixes are keys", async () => {
    await write(
      ".wiki-reader.json",
      JSON.stringify({ statePhrases: BLOCK, trackers: [{ id: "jira", projects: ["DEMO"] }] }),
    );
    await write("plans/p.mdx", page(["Case CASE-600070 was created by hand.", "", "DEMO-1 was created."]));
    expect((await outside()).map((f) => f.line)).toEqual([bodyLine(2)]);
  });

  test("phrases match case-insensitively on word edges only", async () => {
    await write("plans/p.mdx", page(["DEMO-1 MERGED.", "", "DEMO-2 unmerged and premerged."]));
    expect((await outside()).map((f) => f.line)).toEqual([bodyLine(0)]);
  });

  test("frontmatter description is linted; status_note is a home", async () => {
    await write(
      "plans/p.mdx",
      ["---", "title: P", 'description: "Task 2 is not created yet."', "status_note: DEMO-1 merged", "plan_status: in-flight", "---", "", "# P", ""].join("\n"),
    );
    const f = await outside();
    expect(f.map((x) => x.line)).toEqual([3]);
    expect(f[0]!.message).toContain("«created»");
  });

  test("the homes are exempt: StatusRows, a **Status:** paragraph, a PR ledger table, by heading or label", async () => {
    await write(
      "plans/p.mdx",
      page([
        "<StatusRows>",
        "- **DEMO-1** — merged, in prod",
        "</StatusRows>",
        "",
        "**Status:** DEMO-2 created, PR #4 merged",
        "and not in prod per 11.10.",
        "",
        "- **Status:** task 3 is draft",
        "",
        "## PR ledger",
        "",
        "| PR | State |",
        "|---|---|",
        "| #5 | merged |",
        "",
        "**PR-oversikt:**",
        "| PR | State |",
        "|---|---|",
        "| #6 | merged |",
      ]),
    );
    expect(await outside()).toEqual([]);
  });

  test("history and quotes are exempt: Timeline, DecisionLog, Historic, blockquotes, fences, inline code", async () => {
    await write(
      "plans/p.mdx",
      page([
        "<Timeline>",
        "- 11.10 — PR #3 merged",
        "</Timeline>",
        "",
        "<DecisionLog>",
        "- **D1** — DEMO-1 goes in prod first.",
        "</DecisionLog>",
        "",
        '<Historic since="2026-10-01">',
        "DEMO-2 was not merged.",
        "</Historic>",
        "",
        "> DEMO-3 is merged, said the team.",
        "",
        "```markdown",
        "DEMO-4 merged per 11.10",
        "```",
        "",
        "Run `DEMO-5 merged` as the search.",
      ]),
    );
    expect(await outside()).toEqual([]);
  });

  test("lanes and plain tables are linted", async () => {
    await write(
      "plans/p.mdx",
      page([
        "<NextMoves>",
        '<Lane kind="you">',
        "- Wait until DEMO-1 is in prod.",
        "</Lane>",
        "</NextMoves>",
        "",
        "| Task | State |",
        "|---|---|",
        "| task 2 | merged |",
      ]),
    );
    expect((await outside()).map((f) => f.line)).toEqual([bodyLine(2), bodyLine(8)]);
  });

  test("a table under some other heading is not a ledger", async () => {
    await write("plans/p.mdx", page(["## Cases", "", "| PR | State |", "|---|---|", "| #5 | merged |"]));
    expect((await outside()).map((f) => f.line)).toEqual([bodyLine(4)]);
  });

  test("only live report pages: archived, shipped and reference pages are out", async () => {
    const line = "DEMO-1 is merged.";
    await write("archive/a.mdx", ["---", "title: A", "---", "", line, ""].join("\n"));
    await write("plans/s.mdx", ["---", "title: S", "plan_status: shipped", "---", "", line, ""].join("\n"));
    await write("concepts/c.md", ["---", "title: C", "---", "", line, ""].join("\n"));
    await write("plans/log.md", ["# Log", "", line, ""].join("\n"));
    expect(await outside()).toEqual([]);
  });

  test("a wiki with no statePhrases block runs neither check", async () => {
    await write(".wiki-reader.json", JSON.stringify({ language: "en" }));
    await write("plans/a.mdx", page(["**Status:** DEMO-1 merged", "", "DEMO-1 is merged."], ["owns: [DEMO-1]"]));
    await write("plans/b.mdx", page(["**Status:** DEMO-1 merged"]));
    expect(await outside()).toEqual([]);
    expect(await notOwner()).toEqual([]);
  });

  test("a malformed block runs neither check", async () => {
    await write(".wiki-reader.json", JSON.stringify({ statePhrases: { phrases: "merged" } }));
    await write("plans/a.mdx", page(["DEMO-1 is merged."]));
    expect(await outside()).toEqual([]);
  });
});

describe("lint: state-not-owner", () => {
  test("a home that states an owned key on a non-owner page warns; the owner and an unowned key do not", async () => {
    await write("plans/owner.mdx", page(["**Status:** DEMO-1 merged, in prod"], ["owns: [DEMO-1]"]));
    await write("plans/other.mdx", page(["**Status:** DEMO-1 merged; DEMO-9 merged"]));
    const f = await notOwner();
    expect(f).toHaveLength(1);
    expect(f[0]!.relPath).toBe("plans/other.mdx");
    expect(f[0]!.line).toBe(bodyLine(0));
    expect(f[0]!.message).toContain("DEMO-1");
    expect(f[0]!.message).toContain("plans/owner.mdx");
  });

  test("a clause with no key states the page's own work; a phrase belongs to the nearest key in its clause", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    await write(
      "plans/other.mdx",
      page(["**Status:** created 13.10 · waiting for DEMO-1 in prod", "", "**Status:** DEMO-2 merged, DEMO-1 too"], ["owns: [DEMO-2]"]),
    );
    const f = await notOwner();
    expect(f.map((x) => x.line)).toEqual([bodyLine(0, 1)]);
    expect(f[0]!.message).toContain("«in prod»");
  });

  test("every home is read: StatusRows, a PR ledger row, status_note; a bare owned number counts as the key", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    await write(
      "plans/other.mdx",
      page(
        ["<StatusRows>", "- 1 is merged", "</StatusRows>", "", "## PR ledger", "", "| PR | Key | State |", "|---|---|---|", "| #4 | DEMO-1 | merged |"],
        ["status_note: DEMO-1 in prod"],
      ),
    );
    expect((await notOwner()).map((x) => x.line)).toEqual([6, bodyLine(1, 1), bodyLine(8, 1)]);
  });

  test("a prose line is check 1's, not check 2's", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    await write("plans/other.mdx", page(["DEMO-1 is merged."]));
    expect(await notOwner()).toEqual([]);
    expect(await outside()).toHaveLength(1);
  });
});
