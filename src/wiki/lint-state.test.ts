import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";
import { checkOwnsEntries, stateClauses, stateOwners } from "./lint-state.ts";
import { testTempDir } from "../test/temp-dir.ts";

// Lint check 14 — state outside its home and state of a key another page owns
// (living-facts D10). Synthetic fixtures: an English phrase list and DEMO keys.

const BLOCK = {
  phrases: ["merged", "not merged", "in prod", "not in prod", "created", "is draft", "open as of"],
  taskWords: ["task", "PR", "PRs"],
};
let root: string;
const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

beforeEach(async () => {
  root = await testTempDir(path.join(tmpdir(), "wiki-state-lint-"));
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
          "Task 2 is not merged.",
          "",
          "So 120 can go in prod now.",
          "",
          "And 770 is draft still.",
          "",
          "And 990 is draft too.",
        ],
        ["jira: [DEMO-120]", "owns: [DEMO-770]"],
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
    await write("plans/p.mdx", page(["## Cases", "", "| PR | State |", "|---|---|", "| #555 | merged |"]));
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
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1, DEMO-100]"]));
    await write(
      "plans/other.mdx",
      page(
        ["<StatusRows>", "- 100 is merged", "</StatusRows>", "", "## PR ledger", "", "| PR | Key | State |", "|---|---|---|", "| #4 | DEMO-1 | merged |"],
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

// ── Fix round 1 ──────────────────────────────────────────────────────────────

/** Write `plans/p.mdx` and answer the 0-based BODY lines check 1 flags. */
async function flaggedBody(body: string[], fm: string[] = []): Promise<number[]> {
  await write("plans/p.mdx", page(body, fm));
  return (await outside()).map((f) => f.line! - bodyLine(0, fm.length));
}

describe("check 14 block tracking follows the parser's own blocks", () => {
  // One probe line after each form: it is prose in every row, so it must flag.
  // `inside` is the row's verdict on the lines between the tags: exempt (a real
  // block) or linted (the parser renders the tags as text).
  const P = "DEMO-9 merged after.";
  const rows: { form: string; body: string[]; flagged: number[] }[] = [
    { form: "multi-line block", body: ["<Timeline>", "- DEMO-1 merged", "</Timeline>", P], flagged: [3] },
    { form: "indented opener at the top level", body: ["  <Timeline>", "  - DEMO-1 merged", "  </Timeline>", P], flagged: [3] },
    { form: "opener with a quoted attribute", body: ['<Timeline title="x">', "- DEMO-1 merged", "</Timeline>", P], flagged: [3] },
    { form: "single-line block", body: ["<Timeline>DEMO-1 merged</Timeline>", P], flagged: [1] },
    { form: "single-line block with trailing prose (text)", body: ["<Timeline>x</Timeline> trailing DEMO-1 merged", P], flagged: [0, 1] },
    { form: "close mid-line (text)", body: ["<Timeline>", "- DEMO-1 merged</Timeline>", P], flagged: [1, 2] },
    { form: "Historic closed mid-line (text)", body: ["<Historic>", "DEMO-1 merged.</Historic>", P], flagged: [1, 2] },
    { form: "multi-line opener (text)", body: ["<Timeline", '  title="x">', "- DEMO-1 merged", "</Timeline>", P], flagged: [2, 4] },
    { form: "opener with a bare attribute (text)", body: ["<Timeline foo>", "- DEMO-1 merged", "</Timeline>", P], flagged: [1, 3] },
    { form: "multi-line self-close (text)", body: ["<Timeline", "  items={[]}", "/>", P], flagged: [3] },
    { form: "self-close of a block that cannot self-close (text)", body: ['<Timeline title="x" />', P], flagged: [1] },
    { form: "opener after a list marker (text)", body: ["- <Timeline>", "- DEMO-1 merged", "</Timeline>", P], flagged: [1, 3] },
    { form: "nested inside a Fold", body: ["<Fold>", "<Timeline>", "- DEMO-1 merged", "</Timeline>", "</Fold>", P], flagged: [5] },
    {
      form: "same-name nesting",
      body: ["<Historic>", "<Historic>", "DEMO-1 merged", "</Historic>", "DEMO-2 merged", "</Historic>", P],
      flagged: [6],
    },
    { form: "an opener inside a fence opens nothing", body: ["```", "<Timeline>", "```", "DEMO-1 merged"], flagged: [3] },
    { form: "a fenced close does not close the block", body: ["<Timeline>", "```", "</Timeline>", "```", "- DEMO-1 merged", "</Timeline>", P], flagged: [6] },
  ];
  for (const row of rows) {
    test(row.form, async () => {
      expect(await flaggedBody(row.body)).toEqual(row.flagged);
    });
  }

  test("a StatusRows the parser does not make a block is no home", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    // Multi-line self-close, and a self-close followed by a comment: text, so
    // the next line is prose (check 1) and nothing is a home (check 2).
    expect(await flaggedBody(["<StatusRows", "  rows={[]}", "/>", "DEMO-1 merged"])).toEqual([3]);
    expect(await flaggedBody(['<StatusRows rows="x" /> {/* x */}', "DEMO-1 merged"])).toEqual([1]);
    expect(await notOwner()).toEqual([]);
    // A child self-close on the opener line: the parser renders it as text.
    expect(await flaggedBody(["<StatusRows><Row k=\"a\" />", "- DEMO-1 merged", "</StatusRows>"])).toEqual([1]);
  });
});

describe("check 14 PR references", () => {
  const noTask = async () => write(".wiki-reader.json", JSON.stringify({ statePhrases: { phrases: ["merged"] } }));

  test("link fragments, paths, versions, numerals and other trackers are not PR refs", async () => {
    await noTask();
    const lines = [
      "See [intro](#1-intro), merged.",
      "See [step](plan.mdx#3-steg), merged.",
      "See [[plans/foo#3]], merged.",
      "See [x](https://example.invalid/a#123), merged.",
      "Version v1.2#5 merged.",
      "File foo.md#2 merged.",
      "Our #1 priority is merged.",
      "The #3 cases are merged.",
      "Shipyard#697 merged.",
    ];
    expect(await flaggedBody(lines)).toEqual([]);
  });

  test("PR #n, repo #nnn, repo#n, owner/repo#n, a pull URL and a bare #nnn are", async () => {
    await noTask();
    const lines = [
      "PR #31 merged.",
      "api #3523 merged.",
      "melosys-api#12 merged.",
      "navikt/melosys-api#12 merged.",
      "https://github.com/o/r/pull/7 merged.",
      "#3538 merged.",
      "Only #12 merged.",
    ];
    expect(await flaggedBody(lines)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a pull URL in a link destination is a PR ref; a fragment or wiki path there is not", async () => {
    await noTask();
    const lines = [
      "Fixen [her](https://github.com/navikt/melosys-api/pull/3538) is merged.",
      "See [x](#1-intro) merged.",
      "See [x](plan.mdx#3-steg) merged.",
      "See [[plans/foo#3]] merged.",
      "See [x](https://github.com/o/r/pull/7#discussion_r1) merged.",
    ];
    expect(await flaggedBody(lines)).toEqual([0, 4]);
  });
});

describe("check 14 Jira keys", () => {
  test("generic shape: the shared key source and its denylist; no date-like run", async () => {
    expect(await flaggedBody(["UTF-8 merged.", "SHA-256 merged.", "ISO-8601 merged.", "DEMO-2026-09 merged.", "DEMO-12 merged."])).toEqual([4]);
  });

  test("tracker projects: no leading zero; an owned or named key counts whatever its prefix", async () => {
    await write(".wiki-reader.json", JSON.stringify({ statePhrases: BLOCK, trackers: [{ id: "jira", projects: ["DEMO"] }] }));
    await write("plans/owner.mdx", page(["Body."], ["owns: [FAG-8332]"]));
    expect(await flaggedBody(["DEMO-0145 merged.", "FAG-8332 merged.", "OTHER-5 merged.", "XYZ-77 merged."], ["jira: [XYZ-77]"])).toEqual([1, 3]);
  });
});

// The owns: form table. Twin: claude-skills plan-status-sweep/scripts/sweep-lib.test.ts
// carries the same rows in the same order; change both together.
const OWNS_FORMS: { form: string; fm: string[]; body?: string; crlf?: true; keys: string[]; warns: boolean }[] = [
  { form: "no owns key", fm: [], keys: [], warns: false },
  { form: "inline list", fm: ["owns: [DEMO-1, DEMO-2]"], keys: ["DEMO-1", "DEMO-2"], warns: false },
  { form: "inline list + comment", fm: ["owns: [DEMO-1, DEMO-2] # the two"], keys: ["DEMO-1", "DEMO-2"], warns: false },
  { form: "quoted entries, # inside quotes", fm: ["owns: [\"x # y\", 'DEMO-2']"], keys: ["DEMO-2"], warns: false },
  { form: "quoted entry with prose, repeated", fm: ['owns: ["DEMO-1 (kilde)", "DEMO-1 (kilde)"]'], keys: ["DEMO-1"], warns: false },
  { form: "comma string", fm: ["owns: DEMO-1, DEMO-2"], keys: ["DEMO-1", "DEMO-2"], warns: false },
  { form: "block indented", fm: ["owns:", "  - DEMO-1", "  - DEMO-2"], keys: ["DEMO-1", "DEMO-2"], warns: false },
  { form: "block zero-indent", fm: ["owns:", "- DEMO-1", "- TBD"], keys: ["DEMO-1"], warns: false },
  { form: "owns: # c + block", fm: ["owns:  # later", "  - DEMO-1"], keys: ["DEMO-1"], warns: false },
  { form: "  -DEMO-5 (a scalar, not an item)", fm: ["owns:", "  -DEMO-5"], keys: ["DEMO-5"], warns: false },
  { form: "multi-line flow list", fm: ["owns: [DEMO-1,", "  DEMO-2]"], keys: ["DEMO-1", "DEMO-2"], warns: false },
  { form: "inline list, # inside an entry", fm: ["owns: [DEMO-1, DEMO-2#x, DEMO-3]"], keys: ["DEMO-1", "DEMO-2", "DEMO-3"], warns: false },
  { form: "block item whose comment names a key", fm: ["owns:", "  - TBD # DEMO-1"], keys: [], warns: true },
  { form: "apostrophe in a plain scalar + comment", fm: ["owns: Rune's DEMO-1 # not DEMO-2"], keys: ["DEMO-1"], warns: false },
  { form: "lower case, repeated", fm: ["owns: [demo-1, DEMO-1]"], keys: ["DEMO-1"], warns: false },
  { form: "[TBD]", fm: ["owns: [TBD]"], keys: [], warns: true },
  { form: "[TBD, DEMO-1]", fm: ["owns: [TBD, DEMO-1]"], keys: ["DEMO-1"], warns: false },
  { form: "TBD", fm: ["owns: TBD"], keys: [], warns: true },
  { form: "~", fm: ["owns: ~"], keys: [], warns: true },
  { form: "null", fm: ["owns: null"], keys: [], warns: true },
  { form: "empty", fm: ["owns:"], keys: [], warns: true },
  { form: "[]", fm: ["owns: []"], keys: [], warns: true },
  { form: '""', fm: ['owns: ""'], keys: [], warns: true },
  { form: "comment only, nothing under", fm: ["owns:  # later"], keys: [], warns: true },
  { form: "CRLF", fm: ["owns: [DEMO-1]"], crlf: true, keys: ["DEMO-1"], warns: false },
  { form: "indented plain scalar on the next line", fm: ["owns:", "  DEMO-1"], keys: ["DEMO-1"], warns: false },
  { form: "a body line owns: X", fm: [], body: "owns: DEMO-1", keys: [], warns: false },
  { form: "tags: block after an empty owns:", fm: ["owns:", "tags:", "  - DEMO-9"], keys: [], warns: true },
  { form: "an alias", fm: ["base: &k DEMO-1", "owns: *k"], keys: ["DEMO-1"], warns: false },
  { form: "invalid YAML elsewhere, inline owns:", fm: ["summary: a: b", "owns: [DEMO-1]"], keys: ["DEMO-1"], warns: false },
  { form: "invalid YAML elsewhere, zero-indent block", fm: ["summary: a: b", "owns:", "- DEMO-1", "- DEMO-2"], keys: ["DEMO-1", "DEMO-2"], warns: false },
  { form: "invalid owns: value", fm: ["owns: [DEMO-1"], keys: [], warns: true },
  { form: "denylisted prefix, exact entry", fm: ["owns: [UTF-8]"], keys: [], warns: true },
  { form: "denylisted prefix in prose", fm: ["owns: uses UTF-8 for DEMO-1"], keys: ["DEMO-1"], warns: false },
  { form: "non-string list element", fm: ["owns: [12, DEMO-1]"], keys: ["DEMO-1"], warns: false },
  { form: "a mapping", fm: ["owns: {a: DEMO-1}"], keys: [], warns: true },
];
const ownsFormPage = (row: (typeof OWNS_FORMS)[number]) => {
  const text = ["---", "title: T", "type: plan", ...row.fm, "plan_status: in-flight", "---", "", "# T", "", row.body ?? "Body.", ""].join("\n");
  return row.crlf ? text.replace(/\n/g, "\r\n") : text;
};

describe("check 14 owns: forms", () => {
  for (const row of OWNS_FORMS) {
    test(`${row.form}: keys ${row.keys.join(", ") || "none"}${row.warns ? ", warns" : ""}`, () => {
      const pages = [{ relPath: "plans/p.mdx", content: ownsFormPage(row) }];
      expect([...stateOwners(pages).keys()]).toEqual(row.keys);
      expect(checkOwnsEntries(pages).length > 0).toBe(row.warns);
    });
  }
});

describe("check 14 owns: through the linter", () => {
  test("an owner's key is read off its page and a home elsewhere stating it is reported", async () => {
    await write("plans/owner.mdx", page(["Body."], ['owns: ["DEMO-100 (kilde)", "DEMO-100 (kilde)"]']));
    await write("plans/other.mdx", page(["**Status:** DEMO-100 merged"]));
    const f = await notOwner();
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("DEMO-100, which plans/owner.mdx owns");
  });

  test("an owns: that names no key is one warning on its line, quoting the value", async () => {
    await write("plans/a.mdx", page(["Body."], ["owns: [TBD, DEMO-1]"]));
    await write("plans/b.mdx", page(["Body."], ["owns:", "  - later  # soon"]));
    await write("plans/c.mdx", page(["Body."], ["owns: []"]));
    await write("plans/d.mdx", page(["Body."]));
    const f = await findings("state-owns-unread");
    expect(f.map((x) => [x.relPath, x.line, x.message.match(/^owns: (.*?) names no Jira key/)![1]])).toEqual([
      ["plans/b.mdx", 6, "«- later # soon»"],
      ["plans/c.mdx", 6, "«[]»"],
    ]);
  });

  test("a CRLF owner page owns its keys on an LF page's home", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]).replace(/\n/g, "\r\n"));
    await write("plans/other.mdx", page(["**Status:** DEMO-1 merged"]));
    expect((await notOwner()).map((f) => [f.relPath, f.line])).toEqual([["plans/other.mdx", bodyLine(0)]]);
  });
});

describe("check 14 bare numbers", () => {
  test("a bare number needs three digits, and not a date or a PR number", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-7, DEMO-120, DEMO-3538]"]));
    const body = ["Stays in prod 7 days.", "On 120. oktober it merged.", "So 120 merged.", "Ok."];
    expect(await flaggedBody(body, ["jira: [DEMO-7, DEMO-120]"])).toEqual([2]);
    await write("plans/other.mdx", page(["**Status:** PR 3538 merged", "", "**Status:** 3538 merged"]));
    expect((await notOwner()).filter((f) => f.relPath === "plans/other.mdx").map((f) => f.line)).toEqual([bodyLine(2)]);
  });

  test("a number two owned keys share is attributed to neither", async () => {
    await write("plans/a.mdx", page(["Body."], ["owns: [AAA-100]"]));
    await write("plans/b.mdx", page(["Body."], ["owns: [BBB-100]"]));
    await write("plans/c.mdx", page(["**Status:** 100 merged", "", "**Status:** BBB-100 merged"]));
    const f = await notOwner();
    expect(f.map((x) => [x.line, x.message.includes("BBB-100")])).toEqual([[bodyLine(2), true]]);
  });
});

describe("check 14 clauses", () => {
  test("a date's own period and a period inside brackets do not end a clause", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    await write("plans/other.mdx", page(["**Status:** waiting on DEMO-1 since 13.10. merged", "", "**Status:** [DEMO-1 notes. See](x) merged"]));
    expect((await notOwner()).map((f) => f.line)).toEqual([bodyLine(0), bodyLine(2)]);
  });

  test("check 1's anchor must sit in the state's own clause (D13); a table row is one clause", async () => {
    const body = [
      "A red run is owned by whoever merged it · see PR #345 for the history.",
      "It merged; PR #345 waits.",
      "PR #345 is merged.",
      "| PR #345 | merged |",
      "| PR #346 | done. Then merged |",
    ];
    expect(await flaggedBody(body)).toEqual([2, 3, 4]);
  });

  // Fix round 2, batch 3 — the clause splitter's state space, one row per
  // shape. A sentence end is `.`/`!`/`?`, then an optional run of `*`/`_`, then
  // whitespace or the end. `)`, `»` and `"` are not closers: an abbreviation
  // closing a parenthetical or a quote is mid-sentence.
  // `flags`, where given: whether check 1 flags the row as a body line.
  const CLAUSE_ROWS: { text: string; clauses: string[]; flags?: boolean }[] = [
    // An abbreviation or a period inside a parenthetical or a quote: no end.
    { text: "PR #45 (refaktorering, tester osv.) er merget.", clauses: ["PR #45 (refaktorering, tester osv.) er merget"], flags: true },
    { text: "MELOSYS-1234 (se tabellen over.) er i prod fra 13.10.", clauses: ["MELOSYS-1234 (se tabellen over.) er i prod fra 13.10."], flags: true },
    { text: "DEMO-1 (bl.a.) merget", clauses: ["DEMO-1 (bl.a.) merget"], flags: true },
    { text: "DEMO-1 (f.eks.) merget", clauses: ["DEMO-1 (f.eks.) merget"] },
    { text: "DEMO-1 (ca.) merget", clauses: ["DEMO-1 (ca.) merget"] },
    { text: "DEMO-1 (venter...) merget", clauses: ["DEMO-1 (venter...) merget"] },
    { text: "PR #45 (se «Status».) merget", clauses: ["PR #45 (se «Status».) merget"] },
    { text: "DEMO-1 (v26.279.) merget", clauses: ["DEMO-1 (v26.279.) merget"] },
    { text: "DEMO-1 «merget.» Neste", clauses: ["DEMO-1 «merget.» Neste"] },
    { text: "(Merged.) PR #45 waits", clauses: ["(Merged.) PR #45 waits"], flags: true },
    { text: '"Merged." PR #45 waits', clauses: ['"Merged." PR #45 waits'] },
    // Markup closers between the end and the space: an end.
    { text: "**Første natt (06.10).** 4 av 13 åpne PR-er", clauses: ["**Første natt (06.10)", "** 4 av 13 åpne PR-er"], flags: false },
    { text: "__Merged.__ PR #45 waits", clauses: ["__Merged", "__ PR #45 waits"], flags: false },
    { text: "_Merged._ PR #45 waits", clauses: ["_Merged", "_ PR #45 waits"] },
    { text: "*Merged!* PR #45 waits", clauses: ["*Merged", "* PR #45 waits"] },
    // A closer run followed by a non-space: no end.
    { text: "PR #45 merged.**x** too", clauses: ["PR #45 merged.**x** too"] },
    { text: "Merged.**x** PR #45 waits", clauses: ["Merged.**x** PR #45 waits"], flags: true },
    // `!`, `?`, an ellipsis, the end of the text.
    { text: "Merged! PR #45 waits", clauses: ["Merged", "PR #45 waits"] },
    { text: "Merged? PR #45 waits", clauses: ["Merged", "PR #45 waits"] },
    { text: "venter... DEMO-1 merget", clauses: ["venter..", "DEMO-1 merget"] },
    { text: "PR #45 merged.", clauses: ["PR #45 merged"] },
    // An abbreviation in running text ends a clause (the rule has no list).
    { text: "e.g. DEMO-1 merged", clauses: ["e.g", "DEMO-1 merged"] },
    { text: "nr. 3538 merget", clauses: ["nr", "3538 merget"] },
    { text: "kl. 14.30 merget", clauses: ["kl", "14.30 merget"] },
    { text: "DEMO-1 er bl.a. merget", clauses: ["DEMO-1 er bl.a", "merget"], flags: false },
    { text: "DEMO-1 er f.eks. merget", clauses: ["DEMO-1 er f.eks", "merget"] },
    { text: "DEMO-1 er ca. merget", clauses: ["DEMO-1 er ca", "merget"] },
    // A date's own period, a version, brackets: no end.
    { text: "waiting on DEMO-1 since 13.10. merged", clauses: ["waiting on DEMO-1 since 13.10. merged"] },
    { text: "DEMO-100 ble 12. oktober merget", clauses: ["DEMO-100 ble 12. oktober merget"] },
    { text: "**PR #45 is due 12.** oktober and merged", clauses: ["**PR #45 is due 12.** oktober and merged"] },
    { text: "PR #45 shipped as 26.279.140721 and merged", clauses: ["PR #45 shipped as 26.279.140721 and merged"] },
    { text: "[DEMO-1 notes. See](x) merged", clauses: ["[DEMO-1 notes. See](x) merged"] },
    // `·` and `;`.
    { text: "DEMO-1 waits · PR #45 merged; done", clauses: ["DEMO-1 waits", "PR #45 merged", "done"] },
  ];

  test("clause boundaries: every shape of a sentence end", async () => {
    const split = (t: string) => stateClauses(t).map(([s, e]) => t.slice(s, e).trim()).filter(Boolean);
    expect(CLAUSE_ROWS.map((r) => [r.text, split(r.text)])).toEqual(CLAUSE_ROWS.map((r) => [r.text, r.clauses]));
    await write(".wiki-reader.json", JSON.stringify({ statePhrases: { phrases: ["merged", "merget", "i prod"], taskWords: ["PR", "PR-er"] } }));
    const probes = CLAUSE_ROWS.filter((r) => r.flags !== undefined);
    const flagged = new Set(await flaggedBody(probes.map((r) => r.text)));
    expect(probes.map((r, i) => [r.text, flagged.has(i)])).toEqual(probes.map((r) => [r.text, r.flags!]));
  });

  test("the finding names the anchor nearest the state in its clause", async () => {
    await write("plans/p.mdx", page(["DEMO-1 waits for the fix, PR #45 merged."]));
    const f = await outside();
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("beside «PR #45»");
  });
});

describe("check 14 homes", () => {
  test("Status label variants are homes; other words are not", async () => {
    const body = [
      "**Status.** DEMO-1 merged",
      "",
      "**Status 28.09:** DEMO-1 merged",
      "",
      "**Status 12.10.2026** DEMO-1 merged",
      "",
      "**Status:** DEMO-1 merged",
      "",
      "**Statusen** DEMO-1 merged",
    ];
    expect(await flaggedBody(body)).toEqual([8]);
  });

  test("a ledger label must BE the label; a pipe-less table is text, not a ledger", async () => {
    // The reader renders `Key | State` rows without leading pipes as text, so
    // under a ledger label they are prose like any other line.
    const body = [
      "## Why PR-oversikt is missing:",
      "",
      "| Key | State |",
      "|---|---|",
      "| DEMO-1 | merged |",
      "",
      "## PR ledger (main)",
      "",
      "| Key | State |",
      "|---|---|",
      "| DEMO-2 | merged |",
      "",
      "PR ledger:",
      "Key | State",
      "---|---",
      "DEMO-3 | merged",
    ];
    expect(await flaggedBody(body)).toEqual([4, 15]);
  });

  test("a Status paragraph keeps a line opening with inline JSX; a quote ends it", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    expect(await flaggedBody(["**Status:** waits", "<Pill>x</Pill> DEMO-2 merged"])).toEqual([]);
    await write("plans/other.mdx", page(["**Status:** waits", "> a quote", "DEMO-1 merged"]));
    expect(await notOwner()).toEqual([]);
    // The line after the quote renders as its own text: prose, linted by check 1.
    expect((await outside()).filter((f) => f.relPath === "plans/other.mdx").map((f) => f.line)).toEqual([bodyLine(2)]);
  });
});

describe("check 14 exempt text", () => {
  test("only a `>` line is a quote: a lazy continuation and `- > x` are linted", async () => {
    // The reader renders the unprefixed line after a quote as a separate text
    // paragraph, and `- > x` as a list item holding a literal `>`.
    expect(await flaggedBody(["> The team said", "DEMO-1 is merged by now.", "", "- > DEMO-2 merged, said the team.", "", "> DEMO-3 merged."])).toEqual([1, 3]);
  });

  test("HTML and JSX comments are visible text in this reader, for both checks", async () => {
    // renderWikiHtml escapes `<!-- -->` and `{/* */}` and shows them, so they are prose.
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    // The blank line makes the Status line open its own paragraph (fix round 3).
    const body = ["<!-- DEMO-1 merged -->", "{/* DEMO-2 merged */}", "<!--", "DEMO-3 merged", "-->", "", "**Status:** waits {/* DEMO-1 merged */}", "", "DEMO-4 merged."];
    expect(await flaggedBody(body)).toEqual([0, 1, 3, 8]);
    expect((await notOwner()).filter((f) => f.relPath === "plans/p.mdx").map((f) => f.line)).toEqual([bodyLine(6)]);
  });

  test("a comment marker inside inline code hides nothing", async () => {
    expect(await flaggedBody(["Use `<!--` to hide.", "DEMO-1 merged.", "DEMO-2 merged.", "End `-->` here."])).toEqual([1, 2]);
  });

  test("a task word PR does not match a lowercase pr inside a file name", async () => {
    expect(await flaggedBody(["Runs in e2e-pr.yml and is merged.", "The e2e-pr 3 job merged.", "The api-PR 2 is merged."])).toEqual([2]);
  });
});

describe("check 14 page scope and owners", () => {
  test("an archive/ page is out even with a live plan_status", async () => {
    await write("archive/a.mdx", page(["DEMO-1 is merged."]));
    expect(await outside()).toEqual([]);
  });

  test("a culled page and a reserved page own nothing", async () => {
    await write("plans/gone.mdx", page(["Body."], ["owns: [DEMO-1]", "signal: none", "signal-reason: folded"]));
    await write("plans/index.md", ["---", "title: Index", "owns: [DEMO-2]", "---", "", "# Index", ""].join("\n"));
    await write("plans/other.mdx", page(["**Status:** DEMO-1 merged · DEMO-2 merged"]));
    expect(await notOwner()).toEqual([]);
  });
});

describe("check 14 frontmatter", () => {
  test("a CRLF page's description and status_note are read", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    await write(
      "plans/p.mdx",
      ["---", "title: P", "description: Task 2 is not created.", "status_note: DEMO-1 merged", "plan_status: in-flight", "---", "", "# P", ""].join("\r\n"),
    );
    expect((await outside()).map((f) => f.line)).toEqual([3]);
    expect((await notOwner()).map((f) => f.line)).toEqual([4]);
  });

  test("a CRLF page's fence is a fence", async () => {
    // The reader renders a CRLF fence as code; without the fold the closer
    // carries a `\r` and the fence is not one.
    const body = ["```", "DEMO-2 merged", "```", "", "DEMO-4 merged."];
    await write("plans/p.mdx", page(body).replace(/\n/g, "\r\n"));
    expect((await outside()).map((f) => f.line)).toEqual([bodyLine(4)]);
  });

  test("every continuation line of a multi-line description is linted, at its own line", async () => {
    const fmPage = (fm: string[]) => ["---", "title: P", ...fm, "plan_status: in-flight", "---", "", "# P", ""].join("\n");
    await write("plans/a.mdx", fmPage(['description: "Intro text', '  and DEMO-1 is merged."']));
    await write("plans/b.mdx", fmPage(["description: Intro", "  DEMO-2 merged"]));
    await write("plans/c.mdx", fmPage(["description: >", "  intro", "", "  DEMO-3 merged"]));
    await write("plans/d.mdx", fmPage(["description: |2", "  DEMO-4 merged"]));
    await write("plans/e.mdx", fmPage(["description: >-", "  DEMO-5 merged"]));
    expect((await outside()).map((f) => [f.relPath, f.line])).toEqual([
      ["plans/a.mdx", 4],
      ["plans/b.mdx", 4],
      ["plans/c.mdx", 6],
      ["plans/d.mdx", 4],
      ["plans/e.mdx", 4],
    ]);
  });
});

// ── Fix round 2, batch 3: edges whose mutants survived ───────────────────────

describe("check 14 pinned edges", () => {
  test("a repo-shaped PR ref does not start after `&` or `#` (an entity, a hashtag)", async () => {
    await write(".wiki-reader.json", JSON.stringify({ statePhrases: { phrases: ["merged"] } }));
    expect(await flaggedBody(["The &amp#45 entity merged.", "The #tag#45 merged.", "The api#45 merged."])).toEqual([2]);
  });

  test("a task word does not touch a `.` on its left or a `.x` on its right, in either case class", async () => {
    // The right-edge rows use the count form (`3 PR.yml`): the named form needs a
    // number after the word, so without the count a `.x` row passes for any reason.
    const body = ["The config.PR 1 merged.", "The 3 PR.yml merged.", "The PR 1 merged.", "The config.task 1 merged.", "The 3 task.yml merged.", "The task 1 merged.", "We merged PR 1."];
    expect(await flaggedBody(body)).toEqual([2, 5, 6]);
  });

  test("a home's `12. oktober` is one clause with its key", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-100]"]));
    await write("plans/other.mdx", page(["**Status:** DEMO-100 was due 12. oktober merged"]));
    const f = await notOwner();
    expect(f.map((x) => [x.relPath, x.line])).toEqual([["plans/other.mdx", bodyLine(0)]]);
  });

  test("a ledger row is one clause for check 2: key and state in different cells", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    await write("plans/other.mdx", page(["## PR ledger", "", "| Key | Note |", "|---|---|", "| DEMO-1 | Fixed the bug. Then merged |"]));
    const f = await notOwner();
    expect(f.map((x) => [x.relPath, x.line])).toEqual([["plans/other.mdx", bodyLine(4)]]);
  });
});

// ── Architecture review 2026-10, batch L (findings 77, 78) ───────────────────

describe("check 14 table header rows (finding 77)", () => {
  test("the row above a table's delimiter row is a header, not state; the body rows are linted", async () => {
    const body = ["| Fix for DEMO-1 | Merged |", "|---|---|", "| DEMO-2 | merged |"];
    expect(await flaggedBody(body)).toEqual([2]);
  });

  test("a header with no body row under it is text the reader shows, so it is linted", async () => {
    // A header and a delimiter row only: the parser's table needs three rows, so it renders as text.
    expect(await flaggedBody(["| Fix for DEMO-1 | Merged |", "|---|---|"])).toEqual([0]);
  });
});

describe("check 14 task words anchor only with a number (finding 77)", () => {
  test("a bare task word is generic prose; a numbered one names a piece of work", async () => {
    const body = [
      "The second task is not merged.",
      "Task 2 is not merged.",
      "Wait until the api-PR-en is merged.",
      "PR 1 is merged.",
      "PRs 1–4 are merged.",
      "The PRs merged through the queue.",
      "Task #3 is merged.",
    ];
    expect(await flaggedBody(body)).toEqual([1, 3, 4, 6]);
  });
});

describe("check 14 uses the reader's fence rule (finding 78)", () => {
  test("a tilde block is prose to the reader, so its lines are linted; a backtick fence is not", async () => {
    const body = ["~~~", "DEMO-1 is merged.", "~~~", "", "```", "DEMO-2 is merged.", "```"];
    expect(await flaggedBody(body)).toEqual([1]);
  });

  test("an unclosed backtick opener stays prose, and so does every line after it", async () => {
    expect(await flaggedBody(["```", "DEMO-1 is merged.", "", "DEMO-2 is merged."])).toEqual([1, 3]);
  });
});

// ── Batch L fix round 1: the reader's paragraph and table rules, count anchors ──

describe("check 14 Status paragraph ends where the reader's does (fix round 1)", () => {
  test("a tilde line or an unclosed backtick opener stays inside the paragraph", async () => {
    expect(await flaggedBody(["**Status:** DEMO-1 is merged", "~~~", "DEMO-2 is merged.", "~~~"])).toEqual([]);
    expect(await flaggedBody(["**Status:** DEMO-1 is merged", "```", "DEMO-2 is merged."])).toEqual([]);
  });

  test("a paired backtick fence ends the paragraph: the line after it is linted", async () => {
    expect(await flaggedBody(["**Status:** DEMO-1 is merged", "```", "x", "```", "DEMO-2 is merged."])).toEqual([4]);
  });
});

describe("check 14 table header is the parser's own header row (fix round 1)", () => {
  test("a pipe line above the header is text; the header under it is skipped", async () => {
    const table = ["| Fix for DEMO-1 | Merged |", "|---|---|", "| DEMO-2 | merged |"];
    expect(await flaggedBody(["| Note on DEMO-9 merged |", ...table])).toEqual([0, 3]);
    expect(await flaggedBody(["|junk DEMO-5 merged", ...table])).toEqual([0, 3]);
  });

  test("three or more pipe rows with no delimiter row are text, so every row is linted", async () => {
    expect(await flaggedBody(["| Fix for DEMO-1 | Merged |", "| DEMO-3 | merged |", "| DEMO-2 | merged |"])).toEqual([0, 1, 2]);
  });

  test("the header is found at its own line after a fence and inside a component", async () => {
    const table = ["| Fix for DEMO-1 | Merged |", "|---|---|", "| DEMO-2 | merged |"];
    expect(await flaggedBody(["```", "x", "```", ...table])).toEqual([5]);
    expect(await flaggedBody(["<ComparisonTable>", ...table, "</ComparisonTable>"])).toEqual([3]);
  });
});

describe("check 14 a counted task word anchors a state phrase (fix round 1)", () => {
  test("a number before the task word anchors a state phrase, not a date alone", async () => {
    const body = [
      "Per 06.10, 7 of 8 PRs are merged.",
      "2 PRs are merged.",
      "| fdea6907 (11.09) | 3 PRs in console | about $140 |",
      "The PRs are merged.",
      "Version 1.2 PRs are merged.",
      "The v2 PR is merged.",
    ];
    expect(await flaggedBody(body)).toEqual([0, 1]);
    const f = await outside();
    expect(f[0]!.message).toContain("beside «PRs»");
  });
});

// ── Batch L fix round 2: a Status list item is the parser's item, no more ──

describe("check 14 a Status list item ends where the reader's item does (fix round 2)", () => {
  test("a fence-shaped line after the item is outside it: the line after is linted", async () => {
    expect(await flaggedBody(["- **Status:** DEMO-1 is merged", "~~~", "DEMO-2 is merged."])).toEqual([2]);
    expect(await flaggedBody(["- **Status:** DEMO-1 is merged", "```", "DEMO-2 is merged."])).toEqual([2]);
    expect(await flaggedBody(["1. **Status:** DEMO-1 is merged", "```js", "x", "more DEMO-3 merged"])).toEqual([3]);
  });

  test("an unindented line after the item is its own paragraph; an indented one continues the item", async () => {
    expect(await flaggedBody(["- **Status:** DEMO-3 merged", "DEMO-4 is merged."])).toEqual([1]);
    expect(await flaggedBody(["- **Status:** DEMO-3 merged", "  DEMO-4 is merged."])).toEqual([]);
    expect(await flaggedBody(["- a", "- **Status:** DEMO-3 merged", "  DEMO-4 is merged.", "- DEMO-5 merged"])).toEqual([3]);
    expect(await flaggedBody(["- a", "  - **Status:** DEMO-3 merged", "    DEMO-4 is merged."])).toEqual([]);
    expect(await flaggedBody(["- a", "  - **Status:** DEMO-3 merged", "DEMO-4 is merged."])).toEqual([2]);
  });

  test("a list-marker line the parser keeps in a text Status paragraph stays in it", async () => {
    expect(await flaggedBody(["**Status:** waits", "  - DEMO-4 is merged"])).toEqual([]);
    expect(await flaggedBody(["**Status:** waits", "1) DEMO-4 is merged"])).toEqual([]);
    expect(await flaggedBody(["**Status:** waits", "- DEMO-4 is merged"])).toEqual([1]);
  });
});

// ── Batch L fix round 2 batch 2: the count anchor's edges ──

describe("check 14 count anchor edges (fix round 2 batch 2)", () => {
  // [line, flags]: one row per edge of the count form. A count anchors a state
  // phrase in its own clause only, and its number stands alone.
  const rows: [string, boolean][] = [
    ["#3 PRs are merged.", false],
    ["The run-8 PRs are merged.", false],
    ["v12 PRs are merged.", false],
    ["3 PRx is merged.", false],
    ["3 Task is merged.", true],
    ["Per 06.10 3 PRs in total; the fix is merged.", false],
    ["3 PRs remain; the fix is merged.", false],
    ["3\tPRs are merged.", true],
    ["3 PRs are merged.", true],
    ["1-3 PRs are merged.", true],
    ["1–3 PRs are merged.", true],
    ["At 14:30 PR is merged.", false],
    ["On 6/10 PR is merged.", false],
    ["About 1,5 PR is merged.", false],
    ["3 tasks are merged.", false],
  ];
  for (const [line, flags] of rows) {
    test(`${JSON.stringify(line)} ${flags ? "flags" : "does not flag"}`, async () => {
      expect(await flaggedBody([line])).toEqual(flags ? [0] : []);
    });
  }
});

// ── Batch L fix round 3, class check A: a Status home is the parser's block ──

describe("check 14 Status paragraph extent: every line-start class (fix round 3)", () => {
  // [line after `**Status:** waits`, does the reader keep the paragraph going].
  // The probe line under it states DEMO-3's state: linted (flagged) when the
  // paragraph ended, a home when it did not. Verdicts are the reader's
  // (`parseBlocks` + `paragraphGaps`), checked against the rendered HTML.
  const rows: [string, string[], boolean][] = [
    ["plain text", ["more"], true],
    ["indented text (2)", ["  more"], true],
    ["indented text (4)", ["    more"], true],
    ["a line of spaces", ["   "], true],
    ["empty line", [""], false],
    ["break ---", ["---"], false],
    ["break ----", ["----"], false],
    ["break * * *", ["* * *"], false],
    ["break - - -", ["- - -"], false],
    ["*** (no list marker space)", ["***"], true],
    ["___", ["___"], true],
    ["_ _ _", ["_ _ _"], true],
    ["indented *** ", [" ***"], true],
    ["indented ---", ["   ---"], true],
    ["--- with a trailing space", ["--- "], true],
    ["setext ===", ["==="], true],
    ["ATX #", ["# Heading"], false],
    ["ATX ######", ["###### Heading"], false],
    ["seven #", ["####### x"], true],
    ["# without a space", ["#x"], true],
    ["indented ATX", ["   # x"], true],
    ["paired ``` fence", ["```", "c", "```"], false],
    ["indented paired ``` fence", ["  ```", "c", "  ```"], false],
    ["unclosed ``` opener", ["```x"], true],
    ["paired ~~~", ["~~~", "c", "~~~"], true],
    ["quote at column 0", ["> x"], false],
    ["quote, 1 space", [" > x"], true],
    ["quote, 2 spaces", ["  > x"], true],
    ["quote, 3 spaces", ["   > x"], true],
    ["quote, 4 spaces", ["    > x"], true],
    ["- item", ["- x"], false],
    ["* item", ["* x"], false],
    ["1. item", ["1. x"], false],
    ["+ (never opens a list)", ["+ x"], true],
    ["1) (never opens a list)", ["1) x"], true],
    ["indented - mid-paragraph", ["  - x"], true],
    ["-x (no space)", ["-x"], true],
    ["html block", ["<div>x</div>"], true],
    ["html comment", ["<!-- x -->"], true],
    ["one pipe row", ["| x | b |"], true],
    ["a pipe table", ["| x | b |", "|---|---|", "| c | d |"], false],
    ["closed component", ["<Callout>", "x", "</Callout>"], false],
    ["unclosed component tag", ["<Callout> x"], true],
    ["stray close tag", ["</Callout>"], true],
    ["inline component", ['<Pill tone="good">p</Pill> x'], true],
  ];
  for (const [form, lines, continues] of rows) {
    test(`${form}: ${continues ? "continues" : "ends"} the paragraph`, async () => {
      // A line the paragraph keeps carries a state too: it must be a home.
      const kept = continues ? lines.map((l) => l.replace(/\bx\b/, "DEMO-2 is merged")) : lines;
      const body = ["**Status:** waits", ...kept, "DEMO-3 is merged."];
      expect(await flaggedBody(body)).toEqual(continues ? [] : [body.length - 1]);
    });
  }
});

describe("check 14 an indented quote line inside a Status paragraph is home text (fix round 3)", () => {
  test("check 2 reads it: the reader shows `  > x` as part of the paragraph", async () => {
    await write("plans/owner.mdx", page(["Body."], ["owns: [DEMO-1]"]));
    await write("plans/p.mdx", page(["**Status:** waits", "  > DEMO-1 is merged", "", "> DEMO-1 is merged"]));
    expect((await notOwner()).filter((f) => f.relPath === "plans/p.mdx").map((f) => f.line)).toEqual([bodyLine(1)]);
  });
});

describe("check 14 Status home starts where the reader's block starts (fix round 3)", () => {
  test("the label must open the paragraph or the parser's list item", async () => {
    // `+` and `1)` open no list here, so the label is not at the paragraph's start.
    expect(await flaggedBody(["+ **Status:** DEMO-1 is merged"])).toEqual([0]);
    expect(await flaggedBody(["1) **Status:** DEMO-1 is merged"])).toEqual([0]);
    // An indented marker after text continues that text: no item.
    expect(await flaggedBody(["intro", "  - **Status:** DEMO-1 is merged"])).toEqual([1]);
    // A label mid-paragraph opens nothing.
    expect(await flaggedBody(["intro", "**Status:** DEMO-1 is merged"])).toEqual([1]);
    // An item paragraph opening with the label is a home to its own end.
    expect(await flaggedBody(["- a", "", "  **Status:** DEMO-1 is merged", "  DEMO-2 is merged.", "", "  DEMO-3 is merged."])).toEqual([5]);
  });
});

describe("check 14 Status homes inside a component, below a fence (fix round 3)", () => {
  // The fence before the component makes the parser's line index and the
  // page's line differ, so a home read off the wrong line misses.
  const lead = ["```", "x", "y", "```", "", "<Callout>"];
  test("a Status list item and its continuation", async () => {
    expect(await flaggedBody([...lead, "- **Status:** DEMO-1 is merged", "  DEMO-2 is merged.", "- DEMO-3 is merged", "</Callout>"])).toEqual([8]);
  });
  test("a nested Status list item and its continuation", async () => {
    expect(await flaggedBody([...lead, "- a", "  - **Status:** DEMO-1 is merged", "    DEMO-2 is merged.", "- DEMO-3 is merged", "</Callout>"])).toEqual([9]);
  });
  test("a Status paragraph and an item paragraph", async () => {
    expect(await flaggedBody([...lead, "**Status:** DEMO-1 is merged", "DEMO-2 is merged.", "", "DEMO-3 is merged.", "</Callout>"])).toEqual([9]);
    expect(await flaggedBody([...lead, "- a", "", "  **Status:** DEMO-1 is merged", "  DEMO-2 is merged.", "</Callout>", "DEMO-3 is merged."])).toEqual([11]);
  });
});

// ── Batch L fix round 3, class check B: the count anchor's grammar ──

describe("check 14 count anchor grammar (fix round 3)", () => {
  // The spec, one row per case: COUNT SEP WORD, where COUNT is 1–3 ASCII digits
  // or a range of two such numbers joined by `-` or `–`, its left neighbour is
  // none of a letter, a digit of any script, `_ . , # : / - –`, SEP is one
  // space, tab or no-break space, and WORD is a listed task word followed by
  // none of a letter, a digit, `_`, `/` or `.`+letter-or-digit.
  const rows: [string, boolean, string][] = [
    ["3 PRs are merged.", true, "one digit"],
    ["10 PRs are merged.", true, "two digits"],
    ["999 PRs are merged.", true, "three digits"],
    ["1000 PRs are merged.", false, "four digits is no count"],
    ["2026 PRs are merged.", false, "a year is no count"],
    ["1-3 PRs are merged.", true, "range with -"],
    ["1–3 PRs are merged.", true, "range with –"],
    ["10-12 PRs are merged.", true, "multi-digit range start, -"],
    ["10–12 PRs are merged.", true, "multi-digit range start, –"],
    ["2026-10 PR is merged.", false, "ISO year-month"],
    ["1-2-3 PRs are merged.", false, "three-part run"],
    ["1–2–3 PRs are merged.", false, "three-part run, –"],
    ["14:30–16 PR is merged.", false, "time range"],
    ["1.5–3 PRs are merged.", false, "decimal range start"],
    ["6/10–12 PRs are merged.", false, "date range"],
    ["v1–3 PRs are merged.", false, "version range"],
    ["#1–3 PRs are merged.", false, "hash range"],
    ["1,5–3 PRs are merged.", false, "decimal-comma range, –"],
    ["1,5-3 PRs are merged.", false, "decimal-comma range, -"],
    ["x,3 PRs are merged.", false, "comma on the left"],
    ["_3 PRs are merged.", false, "underscore on the left"],
    ["(3 PRs are merged.)", true, "a bracket on the left"],
    ["²-3 PRs are merged.", false, "superscript range start"],
    ["Ⅻ-3 PRs are merged.", false, "roman-numeral range start"],
    ["３-3 PRs are merged.", false, "fullwidth range start"],
    ["３ PRs are merged.", false, "fullwidth digit"],
    ["٣ PRs are merged.", false, "Arabic-Indic digit"],
    ["²3 PRs are merged.", false, "a digit of another script on the left"],
    ["3PRs are merged.", false, "no separator"],
    ["3  PRs are merged.", false, "two spaces"],
    ["3 PRs are merged.", true, "no-break space"],
    ["3 PRs/tasks are merged.", false, "slash on the right"],
    ["3 PR_x is merged.", false, "underscore on the right"],
    ["3 PR-en is merged.", true, "a hyphen on the right continues the word"],
  ];
  for (const [line, flags, why] of rows) {
    test(`${why}: ${JSON.stringify(line)} ${flags ? "counts" : "does not count"}`, async () => {
      expect(await flaggedBody([line])).toEqual(flags ? [0] : []);
    });
  }
});
