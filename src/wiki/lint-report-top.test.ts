import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";
import { testTempDir } from "../test/temp-dir.ts";

// Lint check 11 — a DecisionLog item's long first sentence and a long
// `<StatusRows>` row. Synthetic fixtures.

const NOW = Date.parse("2026-10-09T12:00:00Z");
let root: string;
const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

beforeEach(async () => {
  root = await testTempDir(path.join(tmpdir(), "wiki-report-top-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function findings(check: string): Promise<LintFinding[]> {
  const index = await buildWikiIndex(root);
  return (await lintWiki(index, { now: () => NOW })).findings.filter((f) => f.check === check);
}

const page = (body: string[]) =>
  ["---", "title: P", "type: plan", "updated: 2026-10-01", "---", "", ...body, ""].join("\n");

const LONG = "a".repeat(161);

describe("lint: decision-first-sentence", () => {
  test("a first sentence over 160 chars warns, with the item's line; a short one with a long rest does not", async () => {
    await write(
      "plans/p.mdx",
      page([
        "<DecisionLog>",
        "",
        `- **D1** — Kort beslutning. Og ${LONG} resten.`,
        `- **D2** — Lang ${LONG}. Resten.`,
        "",
        "</DecisionLog>",
      ]),
    );
    const f = await findings("decision-first-sentence");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("DecisionLog item D2");
    expect(f[0]!.message).toContain("max 160");
    expect(f[0]!.line).toBe(10);
    expect(f[0]!.severity).toBeUndefined();
  });

  test("the length is the visible text: a link counts its text, not its URL", async () => {
    const url = `https://example.com/${"x".repeat(200)}`;
    await write("plans/p.mdx", page(["<DecisionLog>", "", `- **D1** — Se [lenken](${url}) her. Resten.`, "", "</DecisionLog>"]));
    expect(await findings("decision-first-sentence")).toEqual([]);
  });

  test("a struck or superseded item is history and is skipped; a long item with no id too", async () => {
    await write(
      "plans/p.mdx",
      page([
        "<DecisionLog>",
        "",
        `- ~~**D1**~~ — ${LONG}.`,
        `- **D2** — ${LONG}, superseded by D3.`,
        `- Uten id ${LONG}.`,
        "- **D3** — Kort.",
        "",
        "</DecisionLog>",
      ]),
    );
    expect(await findings("decision-first-sentence")).toEqual([]);
  });

  test("a DecisionLog quoted in a fence is not read", async () => {
    await write("plans/p.mdx", page(["```markdown", "<DecisionLog>", "", `- **D1** — ${LONG}.`, "", "</DecisionLog>", "```"]));
    expect(await findings("decision-first-sentence")).toEqual([]);
  });
});

describe("lint: status-row-long", () => {
  test("a row over 160 chars warns with its line; a row of 160 does not", async () => {
    const ok = `- **Status:** ${"b".repeat(160 - "**Status:** ".length)}`;
    await write(
      "plans/p.mdx",
      page(["## Brief", "", "<StatusRows>", "", ok, `- **Jira:** ${LONG}`, "", "</StatusRows>"]),
    );
    const f = await findings("status-row-long");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("max 160");
    expect(f[0]!.message).toContain("**Jira:**");
    expect(f[0]!.line).toBe(12);
  });
});

describe("lint: decision-first-sentence reads the reader's split (fix round 1)", () => {
  test("a first sentence under 15 chars joins the next, so the long joined one warns", async () => {
    await write("plans/p.mdx", page(["<DecisionLog>", "", `- **D1** — High. Og ${LONG} resten. Mer.`, "", "</DecisionLog>"]));
    expect(await findings("decision-first-sentence")).toHaveLength(1);
  });
});

describe("lint: decision-first-sentence uses the guarded split (fix round 2, M16)", () => {
  test("a cut inside emphasis is no first sentence: the lint measures the split the reader takes", async () => {
    // Unguarded, the first sentence is «_Kort start her nå.» (short); the
    // reader's guard refuses that cut, so its first sentence runs past the `_`.
    await write("plans/p.mdx", page(["<DecisionLog>", "", `- **D1** — _Kort start her nå. Og ${LONG} slutt_ her. Resten.`, "", "</DecisionLog>"]));
    expect(await findings("decision-first-sentence")).toHaveLength(1);
  });
});

describe("lint: decision-first-sentence takes the struck lead for decisions only (fix round 2, item 1)", () => {
  test("a closed question's first sentence is its struck question, so a long one warns; a decision's struck lead is skipped", async () => {
    await write(
      "plans/p.mdx",
      page([
        "<DecisionLog>",
        "",
        `- **S1** — ~~Skal ${LONG} gjelde?~~ Lukket 07.10 (D1).`,
        `- **D1** — ~~Gammel ${LONG} regel.~~ Ny regel gjelder.`,
        "",
        "</DecisionLog>",
      ]),
    );
    const f = await findings("decision-first-sentence");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("DecisionLog item S1");
  });
});

describe("lint: missing-tldr / tldr-no-more (live report pages and .mdx reference pages)", () => {
  const BOX = ['<Tldr label="In short">', "", "Kort.", "", "<More>", "", "Mer.", "", "</More>", "", "</Tldr>"];
  const fm = (extra: string[]) => (body: string[]) =>
    ["---", "title: P", ...extra, "updated: 2026-10-01", "---", "", ...body, ""].join("\n");

  async function tldr() {
    const index = await buildWikiIndex(root);
    const all = (await lintWiki(index, { now: () => NOW })).findings;
    return all.filter((f) => f.check === "missing-tldr" || f.check === "tldr-no-more");
  }

  test("the unit table", async () => {
    const live = fm(["type: plan", "plan_status: in-flight", "status_date: 2026-10-01"]);
    await write("plans/with-box.mdx", live(["# P", "", ...BOX, "", "## Brief"]));
    await write("plans/without.mdx", live(["# P", "", "*Italic line.*", "", "## Brief"]));
    await write("plans/shipped.mdx", fm(["type: plan", "plan_status: shipped", "status_date: 2026-10-01"])(["# P", "", "## Brief"]));
    await write("flows/plain.md", fm([])(["# F", "", "Prose."]));
    await write("flows/ref.mdx", fm([])(["# F", "", "Prose."]));
    await write("flows/fenced.mdx", fm([])(["# F", "", "```", ...BOX, "```"]));
    await write("concepts/callout-first.mdx", fm([])(["# C", "", '<Callout type="note">', "", "x", "", "</Callout>", "", ...BOX]));
    await write("archive/old.mdx", fm([])(["# A", "", "Prose."]));
    await write("blogs/b.mdx", fm([])(["# B", "", "Prose."]));
    await write("plans/live-plain.md", live(["# P", "", "## Brief"]));

    const f = await tldr();
    expect(f.map((x) => `${x.check} ${x.relPath}`).sort()).toEqual([
      "missing-tldr concepts/callout-first.mdx",
      "missing-tldr flows/fenced.mdx",
      "missing-tldr flows/ref.mdx",
      "missing-tldr plans/without.mdx",
    ]);
  });

  test("every reference folder is in scope, and a live report page outside plans/ too", async () => {
    const dirs = ["flows", "concepts", "repos", "integrations", "projects", "reading"];
    for (const d of dirs) await write(`${d}/r.mdx`, fm([])(["# R", "", "Prose."]));
    await write("notes/r.mdx", fm([])(["# R", "", "Prose."]));
    await write("archive/live.mdx", fm(["plan_status: in-flight", "status_date: 2026-10-01"])(["# L", "", "Prose."]));
    const got = (await tldr()).map((x) => x.relPath).sort();
    expect(got).toEqual([...dirs.map((d) => `${d}/r.mdx`), "archive/live.mdx"].sort());
  });

  test("the finding names the first non-blank line after the H1, and is a warning", async () => {
    await write("plans/p.mdx", page(["# Title", "", "*Italic line.*", "", "## Brief"]));
    const [f] = await tldr();
    expect(f!.check).toBe("missing-tldr");
    expect(f!.line).toBe(9);
    expect(f!.severity).toBeUndefined();
  });

  test("a box with no <More> is an info finding, not missing-tldr; a nested <More> counts", async () => {
    await write("flows/a.mdx", page(["# A", "", '<Tldr label="In short">', "", "Kort.", "", "</Tldr>"]));
    await write("flows/b.mdx", page(["# B", "", "<Tldr>", "", '<Callout type="note">', "", "<More>", "", "x", "", "</More>", "", "</Callout>", "", "</Tldr>"]));
    const f = await tldr();
    expect(f).toHaveLength(1);
    expect(f[0]!).toMatchObject({ check: "tldr-no-more", relPath: "flows/a.mdx", severity: "info", line: 9 });
  });

  test("a page with no H1 is judged on its first block", async () => {
    await write("flows/no-h1.mdx", page(BOX));
    await write("flows/no-h1-bare.mdx", page(["Prose first."]));
    expect((await tldr()).map((x) => x.relPath)).toEqual(["flows/no-h1-bare.mdx"]);
  });

  test("reserved and culled pages are skipped, as in check 9", async () => {
    await write("plans/index.md", page(["# Index"]));
    await write("plans/retired.mdx", fm(["type: plan", "signal: none", "signal-reason: done"])(["# R", "", "Prose."]));
    await write("projects/muninn/CLAUDE.mdx", page(["# C"]));
    expect(await tldr()).toEqual([]);
  });
});
