import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";

// Lint check 11 — a DecisionLog item's long first sentence and a long
// `<StatusRows>` row. Synthetic fixtures.

const NOW = Date.parse("2026-10-09T12:00:00Z");
let root: string;
const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-report-top-"));
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
