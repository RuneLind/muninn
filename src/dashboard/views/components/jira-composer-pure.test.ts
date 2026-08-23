import { describe, expect, test } from "bun:test";
import {
  JC_BLOCKED_ID,
  JC_DEFAULT_DEPTH,
  JC_DIRTY_ID,
  JC_EXTRA_COUNT_ID,
  JC_GATE_CANCEL_ID,
  JC_GATE_DISCARD_ID,
  JC_GATE_SAVE_ID,
  JC_MARKDOWN_ID,
  JC_NOTES_ID,
  JC_NOTES_COUNT_ID,
  JC_REGEN_BLOCKED_ID,
  JC_REGEN_ID,
  JC_RIGHT_ERROR_ID,
  JC_SAVE_ID,
  beginActionPatch,
  canSubmit,
  charCountHtml,
  citationRows,
  gateAnswerPatch,
  initialJiraState,
  isDirty,
  isRegenerate,
  isThreadDraft,
  markdownEditDisabled,
  mergeDraftView,
  saveThenRunProceeds,
  jiraCitationsHtml,
  jiraConflictCopy,
  jiraCoverageNotice,
  jiraChatUrl,
  jiraDraftBody,
  jiraDraftHtml,
  jiraLeftHtml,
  keyVerdictChip,
  keyVerdictCounts,
  markdownFlagLine,
  needsDirtyGate,
  pollTickAction,
  retainedCount,
  safeExternalHref,
  shouldStopPolling,
  streamDropMessage,
  submitBlockedReason,
  threadDraftLabel,
  toggleExclusion,
  withTemplateOption,
  type JiraComposerState,
} from "./jira-composer-pure.ts";
import {
  JIRA_ALL_EXCLUDED_MESSAGE,
  JIRA_EXTRA_MAX,
  JIRA_LOW_CONFIDENCE_MESSAGE,
  JIRA_NO_HITS_MESSAGE,
  JIRA_NOTES_MAX,
  JIRA_UNREACHABLE_MESSAGE,
  type JiraCitation,
  type JiraDraftView,
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

  test("unreachable outranks every other reading — the corpus was never asked", () => {
    expect(jiraCoverageNotice("unreachable", "unreachable")).toEqual({
      tone: "bad",
      text: JIRA_UNREACHABLE_MESSAGE,
    });
    // Both halves of the pair carry it, so neither a stream-driven client nor a
    // poll-driven one can fall through to the corpus sentence. The `no_hits`
    // spelling is what a client running the pre-`effectiveCoverage`-passthrough
    // derivation would produce; it must still say "API unavailable".
    expect(jiraCoverageNotice("unreachable", "no_hits")?.text).toBe(JIRA_UNREACHABLE_MESSAGE);
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

// ── The action row's position ────────────────────────────────────────────────

describe("layout", () => {
  test("the action row is ABOVE the raw material — it was below the fold with 1.4 KB pasted", () => {
    const html = jiraLeftHtml(stateWith({ templates: [{ id: "bug", label: "Bug" }], notes: "n" }));
    expect(html.indexOf("jc-actions")).toBeLessThan(html.indexOf("jc-notes"));
    // The status line travels with the buttons, not with the bottom of the column.
    expect(html.indexOf('id="jcStatus"')).toBeLessThan(html.indexOf("jc-notes"));
  });
});

// ── The caps, both of them ───────────────────────────────────────────────────

describe("the `extra` cap gates the button on BOTH paths", () => {
  test("an over-cap extra blocks a first draft and NAMES the cap", () => {
    const state = stateWith({ notes: "n", extra: "x".repeat(JIRA_EXTRA_MAX + 1) });
    expect(canSubmit(state)).toBe(false);
    expect(submitBlockedReason(state)).toContain(String(JIRA_EXTRA_MAX));
  });

  test("a REGENERATE is gated too — it short-circuited past both caps", () => {
    // `isRegenerate` returned true before either length check ran, so the only
    // thing between an over-cap steer and a 400 was the server.
    const regen = stateWith({
      draftId: "d",
      citations: [cite(1, "a.md")],
      extra: "x".repeat(JIRA_EXTRA_MAX + 1),
    });
    expect(canSubmit(regen)).toBe(false);
    expect(submitBlockedReason(regen)).toContain(String(JIRA_EXTRA_MAX));
  });

  test("both counters render, and only the over-cap one is red", () => {
    const html = jiraLeftHtml(stateWith({ notes: "abc", extra: "x".repeat(JIRA_EXTRA_MAX + 1) }));
    expect(html).toContain(`id="${JC_NOTES_COUNT_ID}"`);
    expect(html).toContain(`id="${JC_EXTRA_COUNT_ID}"`);
    expect(charCountHtml(3, JIRA_NOTES_MAX)).not.toContain("jc-over");
    expect(charCountHtml(JIRA_EXTRA_MAX + 1, JIRA_EXTRA_MAX)).toContain("jc-over");
  });

  test("the blocked-reason line is a NODE, so a partial repaint can rewrite it", () => {
    // `syncLeftControls` repaints without re-rendering the column (the caret is
    // in the textarea); a conditionally-rendered line has nothing to write into.
    expect(jiraLeftHtml(stateWith({ notes: "n" }))).toContain(`id="${JC_BLOCKED_ID}"`);
  });
});

// ── Unsaved edits ────────────────────────────────────────────────────────────

describe("the unsaved-edits gate", () => {
  const dirty = stateWith({ draftId: "d", markdown: "ny tekst", savedMarkdown: "gammel" });

  test("dirty is edited-since-save, and only that", () => {
    expect(isDirty(dirty)).toBe(true);
    expect(isDirty(stateWith({ markdown: "a", savedMarkdown: "a" }))).toBe(false);
    // Never saved at all ⇒ nothing to lose that the server does not have.
    expect(isDirty(stateWith({ markdown: "a" }))).toBe(false);
  });

  test("a regenerate over a dirty draft asks first", () => {
    expect(needsDirtyGate(dirty)).toBe(true);
    expect(needsDirtyGate(stateWith({ markdown: "a", savedMarkdown: "a" }))).toBe(false);
  });

  test("the answer to the gate is not asked again — Forkast ran straight back into it", () => {
    // Measured in the browser: **Forkast og generer** cleared the flag and called
    // the run, which re-read `dirty` — still true, because discarding writes
    // nothing — and re-opened the gate. The click did nothing, forever.
    expect(needsDirtyGate(dirty, { answered: true })).toBe(false);
  });

  test("the gate renders three explicit choices — never a window.confirm", () => {
    const html = jiraDraftHtml({ ...dirty, dirtyGate: true });
    expect(html).toContain("Du har ulagrede endringer.");
    expect(html).toContain(`id="${JC_GATE_SAVE_ID}"`);
    expect(html).toContain(`id="${JC_GATE_DISCARD_ID}"`);
    expect(html).toContain(`id="${JC_GATE_CANCEL_ID}"`);
    expect(html).toContain("Lagre og generer");
    expect(html).toContain("Forkast og generer");
    expect(jiraDraftHtml(dirty)).not.toContain(`id="${JC_GATE_SAVE_ID}"`);
  });
});

// ── Errors the right column raises ───────────────────────────────────────────

describe("copy/save errors are shown where the button is", () => {
  test("a right-column error renders beside the buttons, not in the left column", () => {
    const html = jiraDraftHtml(stateWith({ draftId: "d", markdown: "x", rightError: "Lagring feilet." }));
    expect(html).toContain(`id="${JC_RIGHT_ERROR_ID}"`);
    expect(html).toContain("Lagring feilet.");
    expect(jiraLeftHtml(stateWith({ rightError: "Lagring feilet." }))).not.toContain("Lagring feilet.");
  });

  test("the error node is always present so a partial repaint can fill it", () => {
    expect(jiraDraftHtml(stateWith({ draftId: "d", markdown: "x" }))).toContain(
      `id="${JC_RIGHT_ERROR_ID}"`,
    );
  });

  test("every action clears BOTH errors and the conflict deadline", () => {
    expect(beginActionPatch()).toEqual({
      error: undefined,
      rightError: undefined,
      conflictExpiresAtMs: undefined,
      savedNote: undefined,
    });
  });
});

// ── Buttons while something is in flight ─────────────────────────────────────

describe("what is disabled while something is in flight", () => {
  const base = { draftId: "d", markdown: "x", savedMarkdown: "x", citations: [cite(1, "a.md")] };

  test("Save is disabled during a run — a late PUT of OLD text would land after it", () => {
    expect(jiraDraftHtml(stateWith({ ...base, running: true }))).toMatch(
      new RegExp(`id="${JC_SAVE_ID}"[^>]* disabled`),
    );
    expect(jiraDraftHtml(stateWith({ ...base, polling: true }))).toMatch(
      new RegExp(`id="${JC_SAVE_ID}"[^>]* disabled`),
    );
    expect(jiraDraftHtml(stateWith(base))).not.toMatch(new RegExp(`id="${JC_SAVE_ID}"[^>]* disabled`));
  });

  test("the regenerate button is off while saving, adopting or running", () => {
    const off = (over: Partial<JiraComposerState>) =>
      new RegExp(`id="${JC_REGEN_ID}"[^>]* disabled`).test(
        jiraCitationsHtml(stateWith({ ...base, ...over })),
      );
    expect(off({ running: true })).toBe(true);
    expect(off({ polling: true })).toBe(true);
    expect(off({ saving: true })).toBe(true);
    expect(off({})).toBe(false);
  });

  test("the retain checkboxes are DISABLED during a run — a mid-run toggle was discarded", () => {
    expect(jiraCitationsHtml(stateWith({ ...base, running: true }))).toMatch(
      /data-jc-doc="0"[^>]* disabled/,
    );
    expect(jiraCitationsHtml(stateWith(base))).not.toMatch(/data-jc-doc="0"[^>]* disabled/);
  });
});

// ── Poll ↔ stream ────────────────────────────────────────────────────────────

describe("a poll tick that does not answer 200", () => {
  test("a 4xx stops the loop — it polled a dead id until the 13-minute cap", () => {
    expect(pollTickAction(404)).toEqual({ stop: true, error: "ukjent utkast" });
    expect(pollTickAction(400).stop).toBe(true);
  });

  test("a 5xx or a transport failure keeps retrying — the row is the record", () => {
    expect(pollTickAction(500).stop).toBe(false);
    expect(pollTickAction(0).stop).toBe(false);
  });
});

describe("the dropped-stream copy is honest about what exists", () => {
  test("with a draft id it says the draft is being fetched", () => {
    expect(streamDropMessage(true)).toContain("henter utkastet");
  });

  test("with NO draft id it says nothing was started — there is nothing to fetch", () => {
    const msg = streamDropMessage(false);
    expect(msg).not.toContain("henter utkastet");
    expect(msg).toContain("før utkastet ble startet");
  });
});

// ── Small ones ───────────────────────────────────────────────────────────────

describe("a restored template id the route never served", () => {
  test("is added as an option so the picker shows what will be posted", () => {
    const opts = withTemplateOption([{ id: "bug", label: "Bug" }], "avvik");
    expect(opts.map((t) => t.id)).toEqual(["bug", "avvik"]);
    expect(opts[1]!.label).toBe("avvik");
    expect(withTemplateOption(opts, "bug")).toHaveLength(2);
    expect(withTemplateOption(opts, "")).toHaveLength(2);
  });
});

describe("only http(s) reaches an href", () => {
  test("a javascript: or data: url is dropped, http(s) passes", () => {
    expect(safeExternalHref("https://jira.adeo.no/browse/MELOSYS-1")).toBe(
      "https://jira.adeo.no/browse/MELOSYS-1",
    );
    expect(safeExternalHref("http://x.test/a")).toBe("http://x.test/a");
    expect(safeExternalHref("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalHref("  JavaScript:alert(1)")).toBeUndefined();
    expect(safeExternalHref("data:text/html,x")).toBeUndefined();
    expect(safeExternalHref(undefined)).toBeUndefined();
  });

  test("a citation and a key chip with a javascript: url render NO link", () => {
    const cites = jiraCitationsHtml(
      stateWith({ citations: [cite(1, "a.md", { url: "javascript:alert(1)" })] }),
    );
    expect(cites).not.toContain("href=");
    const chips = jiraDraftHtml(
      stateWith({
        draftId: "d",
        markdown: "x",
        keyVerdicts: [{ key: "MELOSYS-1", state: "verified", url: "javascript:alert(1)" }],
      }),
    );
    expect(chips).not.toContain("href=");
    expect(chips).toContain("MELOSYS-1");
  });
});

// ── The notes cap does not apply to a path that sends no notes ───────────────

describe("the notes cap is a FIRST-DRAFT cap", () => {
  const lockedNotes = {
    draftId: "d",
    citations: [cite(1, "a.md")],
    notes: "x".repeat(JIRA_NOTES_MAX + 1),
  };

  test("a regenerate over over-cap LOCKED notes is allowed — it sends no notes", () => {
    // `jiraDraftBody` omits `notes` on a regenerate (the route REFUSES new notes
    // there: the stored hit set was retrieved for the original raw material), so
    // gating on the field's length disabled the button over a value the request
    // could not carry — and the page tells the reader the notes are locked.
    const regen = stateWith(lockedNotes);
    expect(jiraDraftBody(regen).notes).toBeUndefined();
    expect(canSubmit(regen)).toBe(true);
    expect(submitBlockedReason(regen)).toBeUndefined();
  });

  test("the `extra` cap still gates the regenerate — that field IS sent", () => {
    const regen = stateWith({ ...lockedNotes, extra: "x".repeat(JIRA_EXTRA_MAX + 1) });
    expect(canSubmit(regen)).toBe(false);
    expect(submitBlockedReason(regen)).toContain(String(JIRA_EXTRA_MAX));
  });

  test("a FIRST draft is still gated on the notes cap", () => {
    const first = stateWith({ notes: "x".repeat(JIRA_NOTES_MAX + 1) });
    expect(canSubmit(first)).toBe(false);
    expect(submitBlockedReason(first)).toContain(String(JIRA_NOTES_MAX));
  });
});

// ── The middle column's own regenerate button ────────────────────────────────

describe("the middle-column Generer på nytt says why it is off", () => {
  const base = {
    draftId: "d",
    markdown: "x",
    savedMarkdown: "x",
    citations: [cite(1, "a.md")],
  };
  const disabled = (over: Partial<JiraComposerState>): boolean =>
    new RegExp(`id="${JC_REGEN_ID}"[^>]* disabled`).test(
      jiraCitationsHtml(stateWith({ ...base, ...over })),
    );

  test("it is gated on canSubmit, not just on busy — it was a live silent no-op", () => {
    // The left column's button reads `canSubmit`; this one read only
    // running/polling/saving, so an over-cap `extra` (or a template the picker
    // could not resolve) left it clickable and the click did nothing at all.
    expect(disabled({ extra: "x".repeat(JIRA_EXTRA_MAX + 1) })).toBe(true);
    expect(disabled({ template: "" })).toBe(true);
    expect(disabled({})).toBe(false);
  });

  test("the reason renders NEXT TO IT — #jcBlocked is in a different scroll region", () => {
    const html = jiraCitationsHtml(
      stateWith({ ...base, extra: "x".repeat(JIRA_EXTRA_MAX + 1) }),
    );
    expect(html).toContain(`id="${JC_REGEN_BLOCKED_ID}"`);
    expect(html).toContain(String(JIRA_EXTRA_MAX));
    // Present-but-hidden when there is nothing to say, like its left-column twin.
    expect(jiraCitationsHtml(stateWith(base))).toMatch(
      new RegExp(`id="${JC_REGEN_BLOCKED_ID}"[^>]* hidden`),
    );
  });
});

// ── Folding a stored row back into the page ──────────────────────────────────

describe("mergeDraftView — a poll tick must not clobber the reader", () => {
  const view = (over: Partial<JiraDraftView> = {}): JiraDraftView =>
    ({
      draftId: "d",
      status: "ready",
      template: "bug",
      depth: "skisse",
      notes: "n",
      extra: "",
      markdown: "fra serveren",
      citations: [cite(1, "a.md"), cite(2, "b.md")],
      excludeDocIds: ["b.md"],
      keyVerdicts: [],
      markdownFlags: [],
      coverage: "answer",
      retrievalCoverage: "answer",
      retrievalQuestion: "spm",
      ...over,
    }) as JiraDraftView;

  test("an EMPTY citation set never replaces a non-empty one", () => {
    // The same guard the `done` and `citations` handlers carry: a degraded row (or
    // a regenerate mid-flight) answering with `[]` would delete the very rows the
    // reader needs in order to switch one back on — and the exclusion set with it.
    const state = stateWith({ citations: [cite(1, "a.md")], excludeDocIds: ["a.md"] });
    const patch = mergeDraftView(state, view({ citations: [], excludeDocIds: [] }));
    expect(patch.citations).toHaveLength(1);
    expect(patch.excludeDocIds).toEqual(["a.md"]);
  });

  test("a non-empty set IS adopted, exclusions and all", () => {
    const patch = mergeDraftView(stateWith({ citations: [cite(1, "a.md")] }), view());
    expect(patch.citations).toHaveLength(2);
    expect(patch.excludeDocIds).toEqual(["b.md"]);
  });

  test("an unsaved edit is KEPT and the newer server version is only announced", () => {
    const dirty = stateWith({ draftId: "d", markdown: "min endring", savedMarkdown: "gammel" });
    const patch = mergeDraftView(dirty, view({ markdown: "fra serveren" }));
    expect(patch.markdown).toBeUndefined(); // untouched — the edit exists nowhere else
    expect(patch.savedMarkdown).toBe("fra serveren");
    expect(patch.serverNewerNote).toBeTruthy();
    // Still dirty afterwards, against the text the server actually holds.
    expect(isDirty({ ...dirty, ...patch })).toBe(true);
  });

  test("a clean draft adopts the server text and clears the note", () => {
    const clean = stateWith({ draftId: "d", markdown: "gammel", savedMarkdown: "gammel" });
    const patch = mergeDraftView(clean, view({ markdown: "fra serveren" }));
    expect(patch.markdown).toBe("fra serveren");
    expect(patch.serverNewerNote).toBeUndefined();
  });

  test("an edit the server already has is not announced as newer", () => {
    const same = stateWith({ draftId: "d", markdown: "fra serveren", savedMarkdown: "gammel" });
    const patch = mergeDraftView(same, view({ markdown: "fra serveren" }));
    expect(patch.serverNewerNote).toBeUndefined();
    expect(isDirty({ ...same, ...patch })).toBe(false);
  });

  test("the note renders in the right column, once", () => {
    const html = jiraDraftHtml(
      stateWith({ draftId: "d", markdown: "min", savedMarkdown: "gammel", serverNewerNote: "Nyere versjon." }),
    );
    expect(html).toContain("Nyere versjon.");
  });
});

describe("nothing to edit yet while a generating row is polled", () => {
  test("the draft textarea is DISABLED — the row is still being written", () => {
    const generating = stateWith({ draftId: "d", status: "generating", polling: true });
    expect(markdownEditDisabled(generating)).toBe(true);
    expect(jiraDraftHtml(generating)).toMatch(
      new RegExp(`id="${JC_MARKDOWN_ID}"[\\s\\S]*?disabled`),
    );
  });

  test("a settled row is editable again", () => {
    const ready = stateWith({ draftId: "d", status: "ready", markdown: "x" });
    expect(markdownEditDisabled(ready)).toBe(false);
    expect(jiraDraftHtml(ready)).not.toMatch(
      new RegExp(`id="${JC_MARKDOWN_ID}"[^>]*disabled`),
    );
  });
});

// ── The gate's own exits ─────────────────────────────────────────────────────

describe("answering the gate always closes it", () => {
  test("the answer patch closes the gate — every exit path renders it", () => {
    expect(gateAnswerPatch()).toEqual({ dirtyGate: false });
  });

  test("Lagre og generer runs ONLY when the save landed", () => {
    // A failed save must not be dropped on the floor by the very regenerate the
    // reader was warned about — and the gate has to be repainted either way, or
    // the panel stands over a page that is no longer waiting for an answer.
    expect(saveThenRunProceeds(stateWith({ draftId: "d" }))).toBe(true);
    expect(saveThenRunProceeds(stateWith({ draftId: "d", rightError: "Lagring feilet." }))).toBe(
      false,
    );
  });
});

// ── The thread-sourced draft (/jira as the finisher) ─────────────────────────

describe("thread-sourced drafts", () => {
  const threadState = (over: Partial<JiraComposerState> = {}): JiraComposerState =>
    stateWith({
      draftId: "d1",
      source: "thread",
      threadId: "t-1",
      threadName: "refinement torsdag",
      bot: "melosys",
      notes: "fra samtale: refinement torsdag",
      retrievalQuestion: "fra samtale: refinement torsdag",
      ...over,
    });

  test("mergeDraftView folds the three fields in", () => {
    const patch = mergeDraftView(stateWith(), {
      draftId: "d1",
      status: "ready",
      template: "bug",
      depth: "skisse",
      notes: "fra samtale: X",
      extra: "",
      markdown: "m",
      citations: [],
      excludeDocIds: [],
      keyVerdicts: [],
      markdownFlags: [],
      coverage: "answer",
      retrievalCoverage: "answer",
      retrievalQuestion: "fra samtale: X",
      source: "thread",
      threadId: "t-9",
      threadName: "X",
    } as unknown as JiraDraftView);
    expect(patch.source).toBe("thread");
    expect(patch.threadId).toBe("t-9");
    expect(patch.threadName).toBe("X");
  });

  test("a row with no source (legacy / degraded) reads as notes", () => {
    const patch = mergeDraftView(stateWith(), {
      draftId: "d1",
      status: "ready",
      template: "bug",
      depth: "skisse",
      notes: "n",
      extra: "",
      markdown: "m",
      citations: [],
      excludeDocIds: [],
      keyVerdicts: [],
      markdownFlags: [],
      coverage: "answer",
      retrievalCoverage: "answer",
      retrievalQuestion: "q",
    } as unknown as JiraDraftView);
    expect(patch.source).toBe("notes");
    expect(patch.threadId).toBeUndefined();
  });

  test("a citation-less thread draft still POSTs a REGENERATE, never new notes", () => {
    // The defect this pins: with `citations.length > 0` as the only regenerate
    // test, a conversation that had not retrieved anything fell through to the
    // first-draft shape and posted `notes: "fra samtale: …"` as raw material — a
    // brand-new notes draft over a nine-word placeholder.
    const state = threadState({ citations: [] });
    expect(isThreadDraft(state)).toBe(true);
    expect(isRegenerate(state)).toBe(true);
    const body = jiraDraftBody(state);
    expect(body.draftId).toBe("d1");
    expect(body).not.toHaveProperty("notes");
  });

  test("a notes draft with no citations is still a FIRST draft", () => {
    const state = stateWith({ draftId: "d1", citations: [], notes: "ekte råmateriale" });
    expect(isRegenerate(state)).toBe(false);
    expect(jiraDraftBody(state).notes).toBe("ekte råmateriale");
  });

  test("and the button stays live — the notes cap is a notes-path cap", () => {
    expect(canSubmit(threadState({ citations: [] }))).toBe(true);
    expect(submitBlockedReason(threadState({ citations: [] }))).toBeUndefined();
  });

  test("the left column leads with the provenance banner and a chat link", () => {
    const html = jiraLeftHtml(threadState());
    expect(html).toContain("Utkast fra samtalen «refinement torsdag»");
    expect(html).toContain("Juster i samtalen");
    expect(html).toContain('href="/chat?bot=melosys&amp;thread=t-1"');
  });

  test("the raw-material textarea is GONE — the placeholder is never editable", () => {
    const html = jiraLeftHtml(threadState());
    expect(html).not.toContain(`id="${JC_NOTES_ID}"`);
    expect(html).not.toContain(`id="${JC_NOTES_COUNT_ID}"`);
    // …and the `fra samtale:` bookkeeping line is not shown as raw material.
    expect(html).not.toContain("fra samtale:");
    expect(html).toContain("refinement torsdag");
  });

  test("a notes draft keeps its textarea", () => {
    const html = jiraLeftHtml(stateWith({ notes: "hei" }));
    expect(html).toContain(`id="${JC_NOTES_ID}"`);
    expect(html).not.toContain("Utkast fra samtalen");
  });

  test("the middle column renders a SOURCE line, not a search that never ran", () => {
    const html = jiraCitationsHtml(threadState({ citations: [cite(1, "a.md")] }));
    expect(html).toContain("Kilder fra samtalen «refinement torsdag»");
    expect(html).not.toContain("Søkte etter:");
    expect(html).not.toContain("fra samtale:");
  });

  test("a notes draft still says what it searched for", () => {
    const html = jiraCitationsHtml(stateWith({ retrievalQuestion: "hvordan beregnes trygdeavgift" }));
    expect(html).toContain("Søkte etter: hvordan beregnes trygdeavgift");
  });

  test("an empty hit set on a thread draft blames nothing on the corpus", () => {
    const html = jiraCitationsHtml(threadState({ citations: [] }));
    expect(html).toContain("Samtalen hentet ingen kilder");
  });

  test("jiraChatUrl refuses to build a link it cannot point anywhere", () => {
    expect(jiraChatUrl("melosys", "t-1")).toBe("/chat?bot=melosys&thread=t-1");
    expect(jiraChatUrl(undefined, "t-1")).toBeUndefined();
    expect(jiraChatUrl("melosys", undefined)).toBeUndefined();
    expect(jiraChatUrl("me los", "t/1")).toBe("/chat?bot=me%20los&thread=t%2F1");
  });

  test("a deleted thread row (no name) falls back to the id, never «samtalen «»»", () => {
    expect(threadDraftLabel(threadState({ threadName: undefined }))).toBe("t-1");
    expect(jiraLeftHtml(threadState({ threadName: undefined }))).toContain("«t-1»");
  });

  test("a thread name is escaped everywhere it renders", () => {
    const evil = threadState({ threadName: '<img src=x onerror=1>' });
    expect(jiraLeftHtml(evil)).not.toContain("<img");
    expect(jiraCitationsHtml(evil)).not.toContain("<img");
  });
});
