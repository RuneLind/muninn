import { describe, expect, test } from "bun:test";
import { railIssuePillsHtml } from "./wiki-issue-pills.ts";
import type { ListingIssueRef } from "./wiki-filter.ts";
import type { IssueRelation } from "../../../wiki/trackers/types.ts";

const ref = (key: string, ...relations: IssueRelation[]): ListingIssueRef => ({ tracker: "jira", key, relations });
const JIRA = (id: string) => (id === "jira" ? "Jira" : "");

describe("railIssuePillsHtml", () => {
  test("no issues ⇒ no markup at all", () => {
    expect(railIssuePillsHtml(undefined)).toBe("");
    expect(railIssuePillsHtml([])).toBe("");
  });

  test("one mark per row: solid when the strongest key is stamped, no count for one key", () => {
    const html = railIssuePillsHtml([ref("DEMO-101", "stamped")], JIRA);
    expect(html.match(/class="wiki-issue-pill[ "]/g)).toHaveLength(1);
    expect(html).toContain('class="wiki-issue-pill" role="img" data-issue-key="DEMO-101" data-issue-rel="stamped"');
    expect(html).toContain('title="Jira DEMO-101 — stamped"');
    expect(html).not.toContain("wiki-issue-count");
    // The key is on the hover, not painted.
    expect(html.replace(/<[^>]*>/g, "")).toBe("");
  });

  test("dashed when the strongest key is inferred", () => {
    const html = railIssuePillsHtml([ref("DEMO-102", "created", "link")], JIRA);
    expect(html).toContain('class="wiki-issue-pill inferred"');
    expect(html).toContain('title="Jira DEMO-102 — inferred (created here, link)"');
  });

  test("a stamped key's hover keeps its other relations", () => {
    const html = railIssuePillsHtml([ref("DEMO-101", "stamped", "title", "stem")], JIRA);
    expect(html).toContain('title="Jira DEMO-101 — stamped (also title, file name)"');
  });

  test("several keys: one mark with the count, every key on its hover AND in its accessible name", () => {
    const html = railIssuePillsHtml(
      [ref("DEMO-1", "stamped"), ref("DEMO-2", "tag"), ref("DEMO-3", "stem")],
      JIRA,
    );
    expect(html.match(/class="wiki-issue-pill[ "]/g)).toHaveLength(1);
    expect(html).toContain('data-issue-key="DEMO-1"');
    expect(html).toContain('data-issue-keys="DEMO-1 DEMO-2 DEMO-3"');
    expect(html).toContain('<span class="wiki-issue-count">3</span>');
    expect(html).toContain('title="Jira DEMO-1 — stamped\nJira DEMO-2 — inferred (tag)\nJira DEMO-3 — inferred (file name)"');
    expect(html).toContain('aria-label="Jira DEMO-1 — stamped; Jira DEMO-2 — inferred (tag); Jira DEMO-3 — inferred (file name)"');
  });

  test("keys are escaped", () => {
    expect(railIssuePillsHtml([ref('A-1"<b>', "stamped")])).not.toContain("<b>");
  });
});
