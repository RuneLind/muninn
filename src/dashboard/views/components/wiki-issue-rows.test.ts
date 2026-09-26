import { describe, expect, test } from "bun:test";
import {
  draftPlanOffered,
  issueSectionHtml,
  ledgerLabel,
  linkAllKeys,
  linkOffered,
  linkRefusalHtml,
  type IssueSectionOptions,
} from "./wiki-issue-rows.ts";
import type { IssueRow } from "../../../wiki/trackers/types.ts";

const row = (key: string, relations: IssueRow["relations"], over: Partial<IssueRow> = {}): IssueRow => ({
  tracker: "jira",
  key,
  url: `https://example.invalid/browse/${key}`,
  field: "jira",
  relations,
  pageCount: 1,
  planPages: [],
  ...over,
});

const opts = (over: Partial<IssueSectionOptions> = {}): IssueSectionOptions => ({
  labelOf: () => "Jira",
  stampable: true,
  markdown: true,
  relPath: "notes/a.md",
  ...over,
});

describe("Link", () => {
  test("offered on an unstamped key of a writable markdown page — and on a link-only one, never a mention", () => {
    expect(linkOffered(row("DEMO-101", ["title"]), opts())).toBe(true);
    expect(linkOffered(row("DEMO-102", ["link"]), opts())).toBe(true);
    expect(linkOffered(row("DEMO-103", ["mention"]), opts())).toBe(false);
    expect(linkOffered(row("DEMO-104", ["stamped", "title"]), opts())).toBe(false);
    expect(linkOffered(row("DEMO-101", ["title"]), opts({ stampable: false }))).toBe(false);
    expect(linkOffered(row("DEMO-101", ["title"]), opts({ markdown: false }))).toBe(false);
  });

  test("Link all: declared, created, title and stem only — never tag, link or stamped", () => {
    const rows = [
      row("DEMO-101", ["created", "link"]),
      row("DEMO-102", ["title"]),
      row("DEMO-103", ["stem"]),
      row("DEMO-104", ["declared"]),
      row("DEMO-105", ["tag", "link"]),
      row("DEMO-106", ["link"]),
      row("DEMO-107", ["stamped", "title"]),
      row("DEMO-108", ["mention"]),
    ];
    expect(linkAllKeys(rows, opts())).toEqual(["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104"]);
    expect(linkAllKeys(rows, opts({ stampable: false }))).toEqual([]);
  });

  test("each named refusal has its sentence; anything else names the reason", () => {
    expect(linkRefusalHtml("not-inline-list", "jira")).toContain("is not an inline");
    expect(linkRefusalHtml("duplicate-key", "jira")).toContain("two <code>jira:</code> lines");
    expect(linkRefusalHtml("skip-list", "jira")).toContain("skip list");
    expect(linkRefusalHtml("not-markdown", "jira")).toContain("markdown");
    expect(linkRefusalHtml("lock-timeout", "jira")).toBe("not linked: lock-timeout");
    expect(linkRefusalHtml("<b>", "jira")).toBe("not linked: &lt;b&gt;");
  });
});

describe("Draft plan", () => {
  test("an uncovered counting key in todo or active — never review, done, unknown or covered", () => {
    expect(draftPlanOffered(row("DEMO-1", ["created"], { category: "todo" }))).toBe(true);
    expect(draftPlanOffered(row("DEMO-1", ["created"], { category: "active" }))).toBe(true);
    for (const category of ["review", "done", "unknown"] as const) {
      expect(draftPlanOffered(row("DEMO-1", ["created"], { category }))).toBe(false);
    }
    expect(draftPlanOffered(row("DEMO-1", ["created"]))).toBe(false);
    expect(draftPlanOffered(row("DEMO-1", ["created"], { category: "todo", planPages: [{ relPath: "p.md", title: "P" }] }))).toBe(false);
    expect(draftPlanOffered(row("DEMO-1", ["link"], { category: "todo" }))).toBe(false);
  });

  test("not rendered where the Discuss dialog cannot open", () => {
    const rows = [row("DEMO-1", ["created"], { category: "todo" })];
    expect(issueSectionHtml(rows, opts())).toContain('data-draft-plan="DEMO-1"');
    expect(issueSectionHtml(rows, opts({ discuss: false }))).not.toContain("data-draft-plan");
  });
});

describe("the ledger label", () => {
  test("priced, not tracked, and the unpriced reasons", () => {
    expect(ledgerLabel({ state: "priced", sessions: 3, totalCost: 12.5, costedSessions: 3, truncated: false })).toBe(
      "3 sessions mention it · $12.50",
    );
    expect(ledgerLabel({ state: "priced", sessions: 1, totalCost: 0, costedSessions: 1, truncated: false })).toBe(
      "1 session mentions it · $0.00",
    );
    expect(ledgerLabel({ state: "not-tracked" })).toBe("not tracked");
    expect(ledgerLabel({ state: "unpriced", reason: "demoted" })).toBe("");
    expect(ledgerLabel({ state: "unpriced", reason: "not-configured" })).toBe("");
    expect(ledgerLabel(undefined)).toBe("");
  });
});

describe("the section", () => {
  const rows = [
    row("DEMO-101", ["created", "link"], { category: "todo", status: "Til Utvikle", updated: "2026-01-02T03:04:05.000+0100" }),
    row("DEMO-120", ["tag"]),
    row("DEMO-190", ["link"]),
    row("DEMO-122", ["mention"]),
  ];

  test("counting keys are rows; link-only and mention-only keys get a line each", () => {
    const html = issueSectionHtml(rows, opts());
    expect(html).toContain("Jira (2)");
    expect(html).toMatch(/data-issue-row="DEMO-101"[\s\S]*created here/);
    expect(html).toMatch(/also linked:[\s\S]*DEMO-190[\s\S]*data-issue-link="DEMO-190"/);
    expect(html).toMatch(/mentioned:[\s\S]*DEMO-122/);
    expect(html).not.toContain('data-issue-link="DEMO-122"');
  });

  test("the status pill: raw text, its category, and Jira's date in the tooltip", () => {
    const html = issueSectionHtml(rows, opts());
    expect(html).toContain('class="wiki-issue-status cat-todo"');
    expect(html).toContain("Jira last updated 2026-01-02, as of huginn&#39;s last capture");
    expect(html).toContain(">Til Utvikle<");
  });

  test("a stamped row is solid, every other one dashed", () => {
    const html = issueSectionHtml([row("DEMO-1", ["stamped"]), row("DEMO-2", ["title"])], opts());
    expect(html).toContain('class="wiki-issue-row stamped" data-issue-row="DEMO-1"');
    expect(html).toContain('class="wiki-issue-row inferred" data-issue-row="DEMO-2"');
  });

  test("a row's refusal renders as its named state", () => {
    const states = new Map([["DEMO-120", { kind: "refused" as const, reason: "not-inline-list" }]]);
    expect(issueSectionHtml(rows, opts({ states }))).toContain('data-issue-state="not-inline-list"');
  });

  test("nothing to show ⇒ nothing rendered", () => {
    expect(issueSectionHtml([], opts())).toBe("");
    expect(issueSectionHtml(undefined, opts())).toBe("");
  });
});
