import { test, expect } from "bun:test";
import { LINT_CHECKS } from "../../../wiki/lint.ts";
import { DRAFT_LANE_MAX_DAYS } from "../../../wiki/lint-drift-limits.ts";
import { LINT_LABELS, lintGroupLabel } from "./wiki-lint-labels.ts";

test("every engine check has a label, and no label hard-codes a severity", () => {
  for (const c of LINT_CHECKS) expect(LINT_LABELS[c]).toBeTruthy();
  for (const label of Object.values(LINT_LABELS)) expect(label).not.toContain("(info)");
});

test("the (info) suffix comes from the findings' severity", () => {
  // [check, severities of the group's findings, label]
  const rows: [string, ("info" | undefined)[], string][] = [
    ["long-page-no-fold", ["info", "info"], "Long pages with no <Fold> (info)"],
    ["long-page-no-fold", [undefined], "Long pages with no <Fold>"],
    ["loose-sql", [undefined], "SQL fences outside a <Query>"],
    ["loose-sql", ["info"], "SQL fences outside a <Query> (info)"],
    ["loose-sql", ["info", undefined], "SQL fences outside a <Query>"], // a mixed group is not info
  ];
  for (const [check, sev, want] of rows) {
    expect(lintGroupLabel(check as never, sev.map((severity) => ({ severity })))).toBe(want);
  }
});

test("the draft-lane label reads DRAFT_LANE_MAX_DAYS", () => {
  expect(LINT_LABELS["draft-lane-stale"]).toBe(`Draft lanes older than ${DRAFT_LANE_MAX_DAYS} days`);
});
