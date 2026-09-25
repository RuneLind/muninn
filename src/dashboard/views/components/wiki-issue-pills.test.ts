import { describe, expect, test } from "bun:test";
import { railIssuePillsHtml } from "./wiki-issue-pills.ts";

const ref = (key: string, ...relations: string[]) => ({ tracker: "jira", key, relations });

describe("railIssuePillsHtml", () => {
  test("no issues ⇒ no markup at all", () => {
    expect(railIssuePillsHtml(undefined)).toBe("");
    expect(railIssuePillsHtml([])).toBe("");
  });

  test("a stamped key is solid, an inferred one dashed, and the hover names the relations", () => {
    const html = railIssuePillsHtml([ref("DEMO-101", "stamped"), ref("DEMO-102", "created", "link")]);
    expect(html).toContain('class="wiki-issue-pill" data-issue-key="DEMO-101"');
    expect(html).toContain('class="wiki-issue-pill inferred" data-issue-key="DEMO-102"');
    expect(html).toContain("DEMO-102 — inferred: created here, link");
  });

  test("two pills, then +N carrying the rest on its hover", () => {
    const html = railIssuePillsHtml([ref("DEMO-1", "title"), ref("DEMO-2", "tag"), ref("DEMO-3", "tag"), ref("DEMO-4", "link")]);
    expect(html.match(/data-issue-key=/g)).toHaveLength(2);
    expect(html).toContain(">+2</span>");
    expect(html).toContain("DEMO-3 — inferred: tag\nDEMO-4 — inferred: link");
  });

  test("keys are escaped", () => {
    expect(railIssuePillsHtml([ref('A-1"<b>', "stamped")])).not.toContain("<b>");
  });
});
