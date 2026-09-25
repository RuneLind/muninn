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

  test("a stamped key is solid, an inferred one dashed, and the hover names the tracker and the relations", () => {
    const html = railIssuePillsHtml([ref("DEMO-101", "stamped"), ref("DEMO-102", "created", "link")], JIRA);
    expect(html).toContain('class="wiki-issue-pill" data-issue-key="DEMO-101"');
    expect(html).toContain('class="wiki-issue-pill inferred" data-issue-key="DEMO-102"');
    expect(html).toContain('title="Jira DEMO-101 — stamped"');
    expect(html).toContain('title="Jira DEMO-102 — inferred (created here, link)"');
  });

  test("a stamped key's hover keeps its other relations", () => {
    const html = railIssuePillsHtml([ref("DEMO-101", "stamped", "title", "stem")], JIRA);
    expect(html).toContain('title="Jira DEMO-101 — stamped (also title, file name)"');
  });

  test("two pills, then +N carrying the rest on its hover AND in its accessible name", () => {
    const html = railIssuePillsHtml(
      [ref("DEMO-1", "title"), ref("DEMO-2", "tag"), ref("DEMO-3", "tag"), ref("DEMO-4", "stem")],
      JIRA,
    );
    expect(html.match(/data-issue-key=/g)).toHaveLength(2);
    expect(html).toContain(">+2</span>");
    expect(html).toContain("Jira DEMO-3 — inferred (tag)\nJira DEMO-4 — inferred (file name)");
    expect(html).toContain('aria-label="2 more: Jira DEMO-3 — inferred (tag); Jira DEMO-4 — inferred (file name)"');
  });

  test("a key may wrap after its project's dash and nowhere else", () => {
    expect(railIssuePillsHtml([ref("DEMOPROSJEKT-123456", "tag")])).toContain(">DEMOPROSJEKT-<wbr>123456</span>");
  });

  test("keys are escaped", () => {
    expect(railIssuePillsHtml([ref('A-1"<b>', "stamped")])).not.toContain("<b>");
  });
});
