import { describe, expect, test } from "bun:test";
import {
  JC_DEFAULT_DEPTH,
  JC_DIRTY_ID,
  canSubmit,
  citationRows,
  initialJiraState,
  isRegenerate,
  jiraCitationsHtml,
  jiraConflictCopy,
  jiraCoverageNotice,
  jiraDraftBody,
  jiraDraftHtml,
  jiraLeftHtml,
  keyVerdictChip,
  keyVerdictCounts,
  markdownFlagLine,
  retainedCount,
  shouldStopPolling,
  submitBlockedReason,
  toggleExclusion,
  type JiraComposerState,
} from "./jira-composer-pure.ts";
import {
  JIRA_ALL_EXCLUDED_MESSAGE,
  JIRA_LOW_CONFIDENCE_MESSAGE,
  JIRA_NO_HITS_MESSAGE,
  JIRA_NOTES_MAX,
  type JiraCitation,
} from "../../../jira/wire.ts";

function cite(n: number, docId: string, over: Partial<JiraCitation> = {}): JiraCitation {
  return {
    n,
    collection: "jira-issues",
    docId,
    title: `Sak ${n}`,
    badge: "Jira",
    relevance: 0.8,
    ...over,
  };
}

function stateWith(over: Partial<JiraComposerState> = {}): JiraComposerState {
  return { ...initialJiraState(), template: "bug", ...over };
}

describe("toggles → excludeDocIds", () => {
  test("a toggle off adds the docId, a second toggle removes it", () => {
    const first = toggleExclusion([], "a.md");
    expect(first).toEqual(["a.md"]);
    expect(toggleExclusion(first, "a.md")).toEqual([]);
  });

  test("rows report retained = NOT excluded, over the whole stored set", () => {
    const rows = citationRows([cite(1, "a.md"), cite(2, "b.md"), cite(3, "c.md")], ["b.md"]);
    expect(rows.map((r) => r.retained)).toEqual([true, false, true]);
    // The wide set is rendered unchanged — a switched-off row stays on screen so
    // it can be switched back on.
    expect(rows).toHaveLength(3);
    expect(retainedCount([cite(1, "a.md"), cite(2, "b.md")], ["b.md"])).toBe(1);
  });

  test("the regenerate body carries the exclusion set and NO notes", () => {
    const state = stateWith({
      draftId: "d1",
      citations: [cite(1, "a.md"), cite(2, "b.md")],
      excludeDocIds: ["b.md"],
      notes: "should not be sent",
      extra: "fokuser på migrering",
      depth: "full",
    });
    expect(isRegenerate(state)).toBe(true);
    expect(jiraDraftBody(state)).toEqual({
      draftId: "d1",
      template: "bug",
      depth: "full",
      extra: "fokuser på migrering",
      excludeDocIds: ["b.md"],
    });
  });

  test("a first draft carries the notes and no draftId", () => {
    const state = stateWith({ notes: "råmateriale", extra: "" });
    expect(isRegenerate(state)).toBe(false);
    expect(jiraDraftBody(state)).toEqual({
      notes: "råmateriale",
      template: "bug",
      depth: JC_DEFAULT_DEPTH,
      extra: "",
    });
  });

  test("a draft id whose retrieval never landed is NOT a regenerate", () => {
    // `citations: []` with a draft id is the row that died before
    // `saveJiraDraftRetrieval` ran. Posting a regenerate against it would
    // re-draft from an empty hit set; posting the notes re-retrieves.
    const state = stateWith({ draftId: "d1", citations: [], notes: "n" });
    expect(isRegenerate(state)).toBe(false);
    expect(jiraDraftBody(state)).not.toHaveProperty("draftId");
  });
});

describe("coverage copy selection", () => {
  test("answer says nothing", () => {
    expect(jiraCoverageNotice("answer", "answer")).toBeNull();
    expect(jiraCoverageNotice(null, null)).toBeNull();
  });

  test("low_confidence is a warn line", () => {
    expect(jiraCoverageNotice("low_confidence", "low_confidence")).toEqual({
      tone: "warn",
      text: JIRA_LOW_CONFIDENCE_MESSAGE,
    });
  });

  test("no_hits over a retrieval that DID find things = the reader switched them all off", () => {
    expect(jiraCoverageNotice("answer", "no_hits")).toEqual({
      tone: "bad",
      text: JIRA_ALL_EXCLUDED_MESSAGE,
    });
    // Weak retrieval, then everything toggled off — still the reader's doing.
    expect(jiraCoverageNotice("low_confidence", "no_hits")?.text).toBe(JIRA_ALL_EXCLUDED_MESSAGE);
  });

  test("no_hits over a no_hits (or absent) retrieval = the corpus had nothing", () => {
    expect(jiraCoverageNotice("no_hits", "no_hits")).toEqual({
      tone: "bad",
      text: JIRA_NO_HITS_MESSAGE,
    });
    expect(jiraCoverageNotice(null, "no_hits")?.text).toBe(JIRA_NO_HITS_MESSAGE);
  });
});

describe("key verdict chips", () => {
  test("the three states map to the three classes", () => {
    expect(keyVerdictChip({ key: "MELOSYS-1", state: "verified" }).cls).toContain("jc-key-ok");
    expect(keyVerdictChip({ key: "MELOSYS-2", state: "notes" }).cls).toContain("jc-key-notes");
    expect(keyVerdictChip({ key: "MELOSYS-3", state: "unknown" }).cls).toContain("jc-key-unknown");
  });

  test("the amber state carries the plan's own sentence", () => {
    expect(keyVerdictChip({ key: "MELOSYS-2", state: "notes" }).note).toBe(
      "fra notatene — ikke bekreftet",
    );
  });

  test("resolved is a separate axis and undefined never reads as fabricated", () => {
    const unavailable = keyVerdictChip({ key: "M-1", state: "notes" }).hint;
    const missing = keyVerdictChip({ key: "M-1", state: "notes", resolved: false }).hint;
    const exists = keyVerdictChip({ key: "M-1", state: "notes", resolved: true }).hint;
    expect(unavailable).toContain("utilgjengelig");
    expect(missing).toContain("skrivefeil");
    expect(exists).toContain("retrieval hentet den ikke");
    expect(unavailable).not.toBe(missing);
  });

  test("counts split the three states", () => {
    expect(
      keyVerdictCounts([
        { key: "A-1", state: "verified" },
        { key: "A-2", state: "verified" },
        { key: "A-3", state: "notes" },
        { key: "A-4", state: "unknown" },
      ]),
    ).toEqual({ verified: 2, notes: 1, unknown: 1 });
  });
});

describe("poll-stop rule", () => {
  test("terminal statuses stop the loop", () => {
    expect(shouldStopPolling("ready")).toBe(true);
    expect(shouldStopPolling("failed")).toBe(true);
  });

  test("generating and an absent status keep it running", () => {
    expect(shouldStopPolling("generating")).toBe(false);
    expect(shouldStopPolling(undefined)).toBe(false);
    // An unknown status must not silently stop the poller.
    expect(shouldStopPolling("queued")).toBe(false);
  });
});

describe("the 409 copy", () => {
  test("leads with the server's own sentence and appends the expiry", () => {
    const copy = jiraConflictCopy("Det skrives allerede et utkast.", 10_000, 0);
    expect(copy).toContain("Det skrives allerede et utkast.");
    expect(copy).toContain("~10 s");
  });

  test("falls back to its own lead when the body carried none", () => {
    expect(jiraConflictCopy(undefined, 5_000, 0)).toContain("likt utkast");
    expect(jiraConflictCopy("   ", 5_000, 0)).toContain("likt utkast");
  });

  test("an already-expired slot says so rather than counting down to a negative", () => {
    const copy = jiraConflictCopy("x", 1_000, 9_000);
    expect(copy).not.toContain("-");
    expect(copy).toContain("prøv igjen");
  });
});

describe("submit gating", () => {
  test("empty notes block a first draft, a regenerate needs none", () => {
    expect(canSubmit(stateWith({ notes: "   " }))).toBe(false);
    expect(submitBlockedReason(stateWith({ notes: "" }))).toContain("Lim inn råmateriale");
    expect(
      canSubmit(stateWith({ draftId: "d", citations: [cite(1, "a.md")], notes: "" })),
    ).toBe(true);
  });

  test("an over-cap note is refused client-side and NAMES the cap", () => {
    const state = stateWith({ notes: "x".repeat(JIRA_NOTES_MAX + 1) });
    expect(canSubmit(state)).toBe(false);
    expect(submitBlockedReason(state)).toContain(String(JIRA_NOTES_MAX));
  });

  test("a run in flight blocks a second submit", () => {
    expect(canSubmit(stateWith({ notes: "n", running: true }))).toBe(false);
    expect(canSubmit(stateWith({ notes: "n", polling: true }))).toBe(false);
  });

  test("no template resolved ⇒ no submit", () => {
    expect(canSubmit(stateWith({ template: "", notes: "n" }))).toBe(false);
  });
});

describe("markdown flags", () => {
  test("every flagged kind renders a line naming the line number", () => {
    expect(markdownFlagLine({ kind: "task-list", line: 12, sample: "- [ ] gjør noe" })).toContain(
      "Linje 12",
    );
    expect(markdownFlagLine({ kind: "emoji-shortcode", line: 3, sample: ":warning:" })).toContain(
      "emoji-kode",
    );
    expect(markdownFlagLine({ kind: "html", line: 1, sample: "<div>" })).toContain("rå HTML");
    expect(markdownFlagLine({ kind: "wiki-markup", line: 2, sample: "h2." })).toContain("wiki-markup");
  });
});

describe("markup", () => {
  test("the left column renders the templates IN THE ORDER SERVED", () => {
    const html = jiraLeftHtml(
      stateWith({
        templates: [
          { id: "bug", label: "Bug" },
          { id: "story", label: "Story" },
          { id: "task", label: "Task" },
          { id: "spike", label: "Spike" },
        ],
      }),
    );
    const order = [...html.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["bug", "story", "task", "spike"]);
  });

  test("the depth radios carry the plan's one-line descriptions, Skisse pre-selected", () => {
    const html = jiraLeftHtml(stateWith());
    expect(html).toContain("Problem, verdi, akseptansekriterier");
    expect(html).toContain("hvilke tjenester og klasser berøres");
    expect(html).toContain("ett kodeutdrag, risiko");
    expect(html).toMatch(/data-jc-depth="skisse"[^>]*checked/);
  });

  test("a switched-off citation renders as off but stays in the list", () => {
    const html = jiraCitationsHtml(
      stateWith({
        citations: [cite(1, "a.md"), cite(2, "b.md")],
        excludeDocIds: ["b.md"],
        retrievalQuestion: "Hva feiler i beregningen?",
        coverage: "answer",
        retrievalCoverage: "answer",
      }),
    );
    expect(html).toContain("Søkte etter: Hva feiler i beregningen?");
    expect(html).toContain("jc-cite-off");
    expect(html).toContain("1 av 2 på");
    // Both rows are still rendered — only one is checked.
    expect([...html.matchAll(/data-jc-doc="/g)]).toHaveLength(2);
  });

  test("a citation url is rendered VERBATIM — no host rewriting", () => {
    const html = jiraCitationsHtml(
      stateWith({ citations: [cite(1, "a.md", { url: "https://jira.adeo.no/browse/MELOSYS-1" })] }),
    );
    expect(html).toContain('href="https://jira.adeo.no/browse/MELOSYS-1"');
  });

  test("the draft head carries the id, the status and the verdict counts", () => {
    const html = jiraDraftHtml(
      stateWith({
        draftId: "11111111-2222-3333-4444-555555555555",
        status: "ready",
        markdown: "# Sak",
        keyVerdicts: [
          { key: "MELOSYS-1", state: "verified" },
          { key: "MELOSYS-9", state: "unknown" },
        ],
      }),
    );
    expect(html).toContain("11111111-2222-3333-4444-555555555555");
    expect(html).toContain("klar");
    expect(html).toContain("1 bekreftet · 0 fra notatene · 1 ukjent");
    expect(html).toContain("jc-key-unknown");
  });

  test("markdown flags render as a warn list ABOVE the draft", () => {
    const html = jiraDraftHtml(
      stateWith({
        markdown: "- [ ] noe",
        markdownFlags: [{ kind: "task-list", line: 1, sample: "- [ ] noe" }],
      }),
    );
    expect(html.indexOf("jc-banner-warn")).toBeLessThan(html.indexOf("jc-md"));
  });

  test("the unsaved-edits line is always a NODE, hidden when clean", () => {
    // Always present, never conditionally rendered: the draft textarea is typed
    // into without re-rendering its own column (that would eat the caret), so the
    // input handler needs a node to toggle rather than markup a render must emit.
    const clean = jiraDraftHtml(stateWith({ markdown: "a", savedMarkdown: "a", draftId: "d" }));
    const dirty = jiraDraftHtml(stateWith({ markdown: "b", savedMarkdown: "a", draftId: "d" }));
    expect(clean).toContain(`id="${JC_DIRTY_ID}" hidden`);
    expect(dirty).toContain(`id="${JC_DIRTY_ID}"`);
    expect(dirty).not.toContain(`id="${JC_DIRTY_ID}" hidden`);
    expect(dirty).toContain("Ulagrede endringer");
  });

  test("the citation title is escaped, not injected", () => {
    const html = jiraCitationsHtml(
      stateWith({ citations: [cite(1, "a.md", { title: '<img src=x onerror="boom">' })] }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
