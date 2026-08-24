/**
 * Acceptance for the shipped template set and the per-bot merge.
 *
 * The thing only this file can see: **picker ORDER is a contract.** The variant
 * loader sorts discovered ids with `localeCompare`, so a set keyed by id would
 * render `bug, spike, story, task`. The shipped array's order is asserted
 * literally.
 */

import { test, expect, describe } from "bun:test";
import { findJiraTemplate, resolveJiraTemplates, SHIPPED_JIRA_TEMPLATES } from "./templates.ts";
import { JIRA_FULL_MCP_SERVERS } from "./tool-fence.ts";

describe("shipped templates", () => {
  test("four ids, in PICKER order — not alphabetical", () => {
    expect(SHIPPED_JIRA_TEMPLATES.map((t) => t.id)).toEqual(["bug", "story", "task", "spike"]);
  });

  test("every shipped template carries the measured paste subset and the no-references rule", () => {
    for (const t of SHIPPED_JIRA_TEMPLATES) {
      expect(t.content).toContain("ALDRI: HTML-tagger");
      expect(t.content).toContain("Ingen oppdiktede saksnumre");
      // `## Referanser` is server-appended; a model-written one would be the
      // fabricated-key surface all over again.
      expect(t.content).toContain("Ikke skriv en «## Referanser»-seksjon");
    }
  });

  test("acceptance criteria are PLAIN BULLETS — PR 0 measured task lists as non-converting", () => {
    const bug = SHIPPED_JIRA_TEMPLATES.find((t) => t.id === "bug")!;
    expect(bug.content).toContain("vanlige punkter (ikke avkryssingsbokser)");
    // `- [ ]` appears exactly ONCE, inside the prohibition — never as structure
    // the model is asked to produce.
    expect(bug.content.match(/- \[ \]/g)).toHaveLength(1);
    expect(bug.content).toContain("avkryssingsbokser (`- [ ]`)");
  });
});

describe("resolveJiraTemplates", () => {
  test("no bot prompts ⇒ the whole shipped set", () => {
    expect(resolveJiraTemplates(undefined).map((t) => t.id)).toEqual(["bug", "story", "task", "spike"]);
  });

  test("a same-id variant overrides IN PLACE, keeping picker order", () => {
    const out = resolveJiraTemplates({
      jiraTemplateVariants: [{ id: "bug", label: "Bug (NAV)", content: "EGEN BUG" }],
    });
    expect(out.map((t) => t.id)).toEqual(["bug", "story", "task", "spike"]);
    expect(out[0]!.label).toBe("Bug (NAV)");
    expect(out[0]!.content).toBe("EGEN BUG");
  });

  test("a new id APPENDS", () => {
    const out = resolveJiraTemplates({
      jiraTemplateVariants: [{ id: "epic", label: "Epic", content: "EPIC" }],
    });
    expect(out.map((t) => t.id)).toEqual(["bug", "story", "task", "spike", "epic"]);
  });

  test("BLANK IS ABSENT — a whitespace variant leaves the shipped one intact", () => {
    const out = resolveJiraTemplates({
      jiraTemplateVariants: [{ id: "bug", label: "Bug", content: "  \n " }],
    });
    expect(out[0]!.content).toContain("Skriv en BUG-sak");
  });
});

describe("findJiraTemplate", () => {
  test("an unknown id is UNDEFINED so the route can 400 — never a silent fallback", () => {
    expect(findJiraTemplate(resolveJiraTemplates(undefined), "epic")).toBeUndefined();
    expect(findJiraTemplate(resolveJiraTemplates(undefined), "")).toBeUndefined();
    expect(findJiraTemplate(resolveJiraTemplates(undefined), undefined)).toBeUndefined();
  });
});

describe("the Full pre-flight's server list", () => {
  test("is exactly the two NAV-source servers", () => {
    // `POST /api/jira/draft/from-thread` refuses `Full` with a 503 when either is
    // down — a Full draft written without them is a confident task about code
    // nobody opened.
    expect([...JIRA_FULL_MCP_SERVERS]).toEqual(["code", "yggdrasil"]);
  });
});
