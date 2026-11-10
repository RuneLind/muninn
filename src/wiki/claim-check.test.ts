import { describe, expect, test } from "bun:test";
import { claimRefs, judgeClaims, readClaimFacts, repoOwners, type ClaimFacts } from "./claim-check.ts";
import type { PrFact } from "./work-map/gh-check.ts";

const MERGED: PrFact = { state: "MERGED", mergedAt: "2026-03-10T09:00:00Z", closedAt: "2026-03-10T09:00:00Z" };
const CLOSED: PrFact = { state: "CLOSED", mergedAt: null, closedAt: "2026-03-11T09:00:00Z" };
const OPEN: PrFact = { state: "OPEN", mergedAt: null, closedAt: null };

/** A page: frontmatter lines, then the body. */
const page = (fm: string[], body = "") => `---\ntitle: T\ntype: plan\n${fm.join("\n")}\n---\n\n# T\n\n${body}\n`;
const statusPage = (line: string, fm: string[] = []) => page(fm, `**Status:** ${line}\n`);

const facts = (content: string, owners: [string, string][] = []) => readClaimFacts(content, new Map(owners));
const prs = (f: ClaimFacts) => f.r1.map((x) => x.pr.key);
const judged = (content: string, states: Record<string, PrFact>, owners: [string, string][] = []) =>
  judgeClaims(facts(content, owners), new Map(Object.entries(states)), "UTC");

describe("R1 — a state word directly after the PR", () => {
  test("flags a word right after the PR, a merged PR on GitHub", () => {
    const j = judged(statusPage("acme/gears#12 open, waiting on review"), { "acme/gears#12": MERGED });
    expect(j.r1).toEqual([
      { line: 9, home: "status", text: "**Status:** acme/gears#12 open, waiting on review", pr: "acme/gears#12", says: "open", github: { state: "MERGED", at: MERGED.mergedAt } },
    ]);
    expect(j.compared).toBe(1);
    expect(j.contradicted).toBe(1);
  });

  test("a closed PR contradicts an open word, dated by its close", () => {
    const j = judged(statusPage("acme/gears#12 (draft)"), { "acme/gears#12": CLOSED });
    expect(j.r1.map((f) => f.github)).toEqual([{ state: "CLOSED", at: CLOSED.closedAt }]);
  });

  test("an open PR on GitHub agrees", () => {
    const j = judged(statusPage("acme/gears#12 open"), { "acme/gears#12": OPEN });
    expect(j.r1).toEqual([]);
    expect(j.compared).toBe(1);
    expect(j.contradicted).toBe(0);
  });

  test("a not-merged word agrees with a closed PR and contradicts a merged one", () => {
    expect(judged(statusPage("acme/gears#12 ikke merget"), { "acme/gears#12": CLOSED }).r1).toEqual([]);
    expect(judged(statusPage("acme/gears#12 not merged"), { "acme/gears#12": MERGED }).r1.map((f) => f.says)).toEqual(["not merged"]);
  });

  test("a state word elsewhere on the line does not count", () => {
    expect(facts(statusPage("open questions remain after acme/gears#12")).r1).toEqual([]);
    expect(facts(statusPage("acme/gears#12 landed; follow-ups are open")).r1).toEqual([]);
    expect(facts(statusPage("åpne PR-er fra før acme/gears#12 mangler sjekken")).r1).toEqual([]);
  });

  test("Norwegian words, «åpen» included, with Unicode edges", () => {
    for (const word of ["åpen", "åpne", "utkast", "til review", "ikke merget", "venter på review"]) {
      expect(facts(statusPage(`acme/gears#12 ${word}`)).r1.map((f) => f.says)).toEqual([word]);
    }
    // «åpenbart» is another word.
    expect(facts(statusPage("acme/gears#12 åpenbart ferdig")).r1).toEqual([]);
    // The gap allows a comma and a parenthesis: `(api #5, utkast)`.
    expect(prs(facts(statusPage("PR 4 (gears #12, utkast)", ["repos: [gears]"]), [["gears", "acme"]]))).toEqual(["acme/gears#12"]);
  });

  test("a full URL, a markdown link to one, owner/repo#n and repo#n", () => {
    const owners: [string, string][] = [["gears", "acme"]];
    expect(prs(facts(statusPage("https://github.com/acme/gears/pull/7 open"), owners))).toEqual(["acme/gears#7"]);
    expect(prs(facts(statusPage("[gears #7](https://github.com/acme/gears/pull/7) åpen"), owners))).toEqual(["acme/gears#7"]);
    expect(prs(facts(statusPage("acme/gears#7 open"), owners))).toEqual(["acme/gears#7"]);
    expect(prs(facts(statusPage("gears#7 open"), owners))).toEqual(["acme/gears#7"]);
    // A link to anything but a pull request names no PR.
    expect(prs(facts(statusPage("[#7](https://example.com/x#7) open"), owners))).toEqual([]);
  });

  test("repo#n takes the owner from the page's prs: before the wiki's", () => {
    const content = statusPage("gears#7 open", ["prs: [other/gears#3]"]);
    expect(prs(facts(content, [["gears", "acme"]]))).toEqual(["other/gears#7"]);
    // No owner anywhere: skipped, counted.
    const none = facts(statusPage("gears#7 open"));
    expect(none.r1).toEqual([]);
    expect(none.unresolved).toBe(1);
  });

  test("a bare #n with one repo reads through repos:", () => {
    expect(prs(facts(statusPage("#41 åpen", ["repos: [gears]"]), [["gears", "acme"]]))).toEqual(["acme/gears#41"]);
  });

  test("a bare #n with two repos is skipped", () => {
    const f = facts(statusPage("#41 åpen", ["repos: [gears, sprockets]"]), [["gears", "acme"], ["sprockets", "acme"]]);
    expect(f.r1).toEqual([]);
    expect(f.unresolved).toBe(1);
  });

  test("a bare #n with no repos is skipped", () => {
    const f = facts(statusPage("#41 åpen"), [["gears", "acme"]]);
    expect(f.r1).toEqual([]);
    expect(f.unresolved).toBe(1);
  });

  test("a bare #n is the prs: entry with that number first, whatever repos: says", () => {
    const content = statusPage("#41 åpen", ["repos: [gears, sprockets]", "prs: [acme/sprockets#41, acme/gears#40]"]);
    expect(prs(facts(content))).toEqual(["acme/sprockets#41"]);
  });

  test("a word before a bare #n naming one of the page's repos by a token picks that repo", () => {
    const content = statusPage("api #41 åpen", ["repos: [acme-api, acme-web]"]);
    expect(prs(facts(content, [["acme-api", "acme"], ["acme-web", "acme"]]))).toEqual(["acme/acme-api#41"]);
    // A word fitting two names picks none.
    const both = facts(statusPage("acme #41 åpen", ["repos: [acme-api, acme-web]"]), [["acme-api", "acme"], ["acme-web", "acme"]]);
    expect(both.r1).toEqual([]);
  });

  test("a PR in a line that is no home is ignored", () => {
    const content = page([], "Some prose: acme/gears#12 open.\n\n- a list item acme/gears#13 open\n\n| PR | State |\n|---|---|\n| acme/gears#14 open | open |\n");
    expect(facts(content).r1).toEqual([]);
  });

  test("each home: status_note, a <StatusRows> line, a Status item and a ledger row", () => {
    const content = page(
      ['status_note: "PR 2 (acme/gears#21, utkast) is next"'],
      [
        "<StatusRows>",
        "",
        "- **Review:** acme/gears#22 til review",
        "",
        "</StatusRows>",
        "",
        "- **Status:** acme/gears#23 open",
        "",
        "**PR ledger.**",
        "",
        "| PR | What | State | Landed |",
        "|---|---|---|---|",
        "| **4 — faster** | a thing | utkast | [gears #24](https://github.com/acme/gears/pull/24) |",
        "| **5 — later** | depends on [#9](https://github.com/acme/gears/pull/9) | merged | [gears #25](https://github.com/acme/gears/pull/25) |",
      ].join("\n"),
    );
    const f = facts(content);
    expect(f.r1.map((x) => [x.home, x.pr.key, x.says])).toEqual([
      ["status_note", "acme/gears#21", "utkast"],
      ["status-rows", "acme/gears#22", "til review"],
      ["status", "acme/gears#23", "open"],
      ["ledger", "acme/gears#24", "utkast"],
    ]);
    const lines = content.split("\n");
    for (const x of f.r1) expect(lines[x.line - 1]).toContain(`#${x.pr.n}`);
  });

  test("an R1 fact whose PR state is not known is unchecked, never compared", () => {
    const j = judged(statusPage("acme/gears#12 open"), {});
    expect(j.compared).toBe(0);
    expect(j.unchecked).toBe(1);
    expect(j.contradicted).toBeNull();
  });
});

describe("R2 — status_date older than the newest merge in prs:", () => {
  const r2Page = (fm: string[]) => page(fm);
  const two = ["prs: [acme/gears#1, acme/gears#2]"];

  test("an older date fires, naming the newest merge", () => {
    const j = judged(r2Page(["status_date: 2026-03-09", ...two]), { "acme/gears#1": { ...MERGED, mergedAt: "2026-03-08T10:00:00Z" }, "acme/gears#2": MERGED });
    expect(j.r2).toEqual({ state: "fires", statusDate: "2026-03-09", newest: { pr: "acme/gears#2", mergedAt: "2026-03-10T09:00:00Z" } });
    expect(j.contradicted).toBe(1);
  });

  test("the same day is clear", () => {
    const j = judged(r2Page(["status_date: 2026-03-10", ...two]), { "acme/gears#1": MERGED, "acme/gears#2": OPEN });
    expect(j.r2.state).toBe("clear");
    expect(j.compared).toBe(1);
    expect(j.contradicted).toBe(0);
  });

  test("a newer date is clear", () => {
    expect(judged(r2Page(["status_date: 2026-04-01", ...two]), { "acme/gears#1": MERGED, "acme/gears#2": MERGED }).r2.state).toBe("clear");
  });

  test("the day is the zone's: a late-evening UTC merge is the next day in Oslo", () => {
    const late = { "acme/gears#1": { ...MERGED, mergedAt: "2026-03-10T23:30:00Z" } };
    const f = facts(r2Page(["status_date: 2026-03-10", "prs: [acme/gears#1]"]));
    expect(judgeClaims(f, new Map(Object.entries(late)), "UTC").r2.state).toBe("clear");
    expect(judgeClaims(f, new Map(Object.entries(late)), "Europe/Oslo").r2.state).toBe("fires");
  });

  test("no prs: is not checked", () => {
    expect(judged(r2Page(["status_date: 2026-03-09"]), {}).r2).toEqual({ state: "not-checked", reason: "no-prs" });
  });

  test("no status_date is not checked", () => {
    expect(judged(r2Page(two), { "acme/gears#1": MERGED, "acme/gears#2": MERGED }).r2).toEqual({ state: "not-checked", reason: "no-status-date" });
  });

  test("a prs: entry with no known state is not checked, not a pass", () => {
    const j = judged(r2Page(["status_date: 2026-04-01", ...two]), { "acme/gears#1": MERGED });
    expect(j.r2).toEqual({ state: "not-checked", reason: "no-state" });
    expect(j.compared).toBe(0);
    expect(j.unchecked).toBe(1);
    expect(j.contradicted).toBeNull();
  });

  test("a known later merge fires even beside an unknown entry", () => {
    expect(judged(r2Page(["status_date: 2026-03-01", ...two]), { "acme/gears#1": MERGED }).r2.state).toBe("fires");
  });

  test("prs: entries in short form are normalized", () => {
    expect(claimRefs(facts(r2Page(["prs: [muninn#5]"]))).map((r) => r.key)).toEqual(["RuneLind/muninn#5"]);
  });
});

describe("repoOwners", () => {
  test("one owner per name; two owners for a name give none", () => {
    const m = repoOwners(["acme/gears#1", "acme/gears#2", "acme/web#3", "other/web#4", "not a ref"]);
    expect(m.get("gears")).toBe("acme");
    expect(m.get("web")).toBeNull();
  });
});
