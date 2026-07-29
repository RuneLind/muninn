import { test, expect } from "bun:test";
import {
  editChangedChars,
  INTEGRATE_STALE_COPY,
  INTEGRATE_STALE_COPY_EDIT,
  parseFactcheckClaims,
  correctableClaims,
  hasCorrectableClaims,
  integrateBarState,
  appendBlockedByIntegrate,
  editPreviewHtml,
  droppedListHtml,
  integratePreviewHtml,
  buildIntegrateApplyBody,
  selectedChangedChars,
  integrateSuccessCopy,
  INTEGRATE_BODY_MAX,
  type ProposedEdit,
} from "./wiki-integrate.ts";

const ANSWER = [
  "Mostly accurate, with one contradicted claim.",
  "",
  "### ✅ Claim 1/3 — Founded in 1998",
  "",
  "Confirmed by the company registry.",
  "",
  "Sources: [example.com](https://example.com/a)",
  "",
  "### ❌ Claim 2/3 — Ships 4M units",
  "",
  "The filing reports 2.1M units.",
  "",
  "Sources: [sec.gov](https://sec.gov/x)",
  "",
  "### ❓ Claim 3/3 — Will double next year",
  "",
  "A prediction — out of scope.",
].join("\n");

test("parseFactcheckClaims splits the answer into per-claim blocks", () => {
  const claims = parseFactcheckClaims(ANSWER);
  expect(claims.map((c) => c.index)).toEqual([1, 2, 3]);
  expect(claims.map((c) => c.verdict)).toEqual(["✅", "❌", "❓"]);
  expect(claims[1]!.title).toBe("Ships 4M units");
  expect(claims[1]!.block).toContain("The filing reports 2.1M units.");
  expect(claims[1]!.block).toContain("sec.gov");
  // The compose lede before the first heading is not part of any block.
  expect(claims[0]!.block).not.toContain("Mostly accurate");
});

test("parseFactcheckClaims tolerates a bare ⚠ (no VS16) and normalizes it", () => {
  const claims = parseFactcheckClaims("### ⚠ Claim 1/1 — Partly right\n\nNeeds a hedge.");
  expect(claims).toHaveLength(1);
  expect(claims[0]!.verdict).toBe("⚠️");
  expect(claims[0]!.title).toBe("Partly right");
});

test("parseFactcheckClaims tolerates en-dash, hyphen, and a title-less heading", () => {
  const claims = parseFactcheckClaims(
    ["### ❌ Claim 1/3 – En dash", "a", "### ⚠️ Claim 2/3 - Hyphen", "b", "### ✅ Claim 3/3", "c"].join("\n"),
  );
  expect(claims.map((c) => c.title)).toEqual(["En dash", "Hyphen", ""]);
  expect(claims.map((c) => c.verdict)).toEqual(["❌", "⚠️", "✅"]);
});

test("parseFactcheckClaims tolerates VS16 on ALL four emoji, a colon separator, and lowercase 'claim'", () => {
  const claims = parseFactcheckClaims(
    [
      "### ❌️ Claim 3/8", // VS16 on ❌, no title
      "a",
      "### ❌ Claim 4/8: Colon separator", // colon instead of a dash
      "b",
      "### ⚠️ claim 5/8 — Lowercase keyword", // lowercase `claim`
      "c",
      "### ✅️ Claim 6/8 — Also VS16", // VS16 on ✅
      "d",
      "### ❓️ Claim 7/8 — Unknown", // VS16 on ❓
      "e",
    ].join("\n"),
  );
  expect(claims.map((c) => c.index)).toEqual([3, 4, 5, 6, 7]);
  expect(claims.map((c) => c.verdict)).toEqual(["❌", "❌", "⚠️", "✅", "❓"]);
  expect(claims.map((c) => c.title)).toEqual([
    "",
    "Colon separator",
    "Lowercase keyword",
    "Also VS16",
    "Unknown",
  ]);
  // …and the VS16 + colon variants still reach the integrate flow.
  expect(correctableClaims("### ❌️ Claim 3/8: Title\n\nbody").map((c) => c.index)).toEqual([3]);
});

test("parseFactcheckClaims does NOT loosen the ### anchor", () => {
  expect(parseFactcheckClaims("## ❌ Claim 1/1 — Wrong level")).toEqual([]);
  expect(parseFactcheckClaims("#### ❌ Claim 1/1 — Wrong level")).toEqual([]);
});

test("parseFactcheckClaims returns [] for a malformed answer", () => {
  expect(parseFactcheckClaims("")).toEqual([]);
  expect(parseFactcheckClaims("Just prose, no headings at all.")).toEqual([]);
});

test("correctableClaims keeps only ❌ and ⚠️", () => {
  const answer = ANSWER + "\n\n### ⚠ Claim 4/4 — Loosely stated\n\nHedge it.";
  const claims = correctableClaims(answer);
  expect(claims.map((c) => c.index)).toEqual([2, 4]);
  expect(claims.map((c) => c.verdict)).toEqual(["❌", "⚠️"]);
});

// ── Render gate ──────────────────────────────────────────────────────────────

const ALL_CLEAN = [
  "Everything checks out — though one source was ⚠️ slow to load.",
  "",
  "### ✅ Claim 1/2 — Founded in 1998",
  "",
  "Confirmed. A ❌ would be surprising here.",
  "",
  "### ✅ Claim 2/2 — Ships 2.1M units",
  "",
  "Confirmed by the filing.",
].join("\n");

function fcTurn(over: Record<string, unknown> = {}) {
  return {
    kind: "factcheck",
    page: "notes/thing",
    pageType: "note",
    answer: ANSWER,
    bodyLen: 3000,
    ...over,
  };
}

test("hasCorrectableClaims parses claim headings, never a raw substring scan", () => {
  expect(hasCorrectableClaims(ANSWER)).toBe(true);
  // ⚠️ in the lede AND ❌ inside a ✅ claim's reasoning — both must be ignored.
  expect(hasCorrectableClaims(ALL_CLEAN)).toBe(false);
  expect(ALL_CLEAN).toContain("⚠️");
  expect(ALL_CLEAN).toContain("❌");
  expect(hasCorrectableClaims(undefined)).toBe(false);
});

test("integrateBarState: an all-✅ check renders no button", () => {
  expect(integrateBarState(fcTurn({ answer: ALL_CLEAN }))).toBe("hidden");
});

test("integrateBarState: non-factcheck / explainer / page-less turns are hidden", () => {
  expect(integrateBarState(fcTurn({ kind: undefined }))).toBe("hidden");
  expect(integrateBarState(fcTurn({ pageType: "explainer" }))).toBe("hidden");
  expect(integrateBarState(fcTurn({ page: undefined }))).toBe("hidden");
});

test("integrateBarState: an uncommitted turn is pending, a committed one is ready", () => {
  expect(integrateBarState(fcTurn({ answer: "" }))).toBe("pending");
  expect(integrateBarState(fcTurn())).toBe("ready");
});

test("integrateBarState: bodyLen over the cap renders the page-too-long state", () => {
  expect(integrateBarState(fcTurn({ bodyLen: INTEGRATE_BODY_MAX }))).toBe("ready");
  expect(integrateBarState(fcTurn({ bodyLen: INTEGRATE_BODY_MAX + 1 }))).toBe("too-long");
});

test("integrateBarState: an ABSENT bodyLen still renders the button (server 400 decides)", () => {
  expect(integrateBarState(fcTurn({ bodyLen: undefined }))).toBe("ready");
});

test("integrateBarState + appendBlockedByIntegrate: the two writes block each other", () => {
  expect(integrateBarState(fcTurn({ wrote: "integrate" }))).toBe("done");
  expect(integrateBarState(fcTurn({ wrote: "append" }))).toBe("blocked-append");
  expect(appendBlockedByIntegrate(fcTurn({ wrote: "integrate" }))).toBe(true);
  expect(appendBlockedByIntegrate(fcTurn({ wrote: "append" }))).toBe(false);
  expect(appendBlockedByIntegrate(fcTurn())).toBe(false);
});

// ── Diff-preview builders ────────────────────────────────────────────────────

function edit(over: Partial<ProposedEdit> = {}): ProposedEdit {
  return {
    claimIndex: 2,
    verdict: "❌",
    old: "Ships 4M units.",
    new: "Ships 2.1M units.",
    reason: "The filing reports 2.1M.",
    start: 100,
    end: 115,
    tier: "exact",
    resolvedText: "Ships 4M units.",
    beforeCtx: "In 2024 the company",
    afterCtx: "across all regions",
    ...over,
  };
}

test("editPreviewHtml diffs resolvedText — the raw span the server will replace", () => {
  // A tier-2 rescue widened the span: the model's `old` is NOT what gets spliced.
  const html = editPreviewHtml(
    edit({ old: "Ships 4M units.", resolvedText: "Ships   4M\nunits.", tier: "collapsed" }),
    0,
    true,
  );
  expect(html).toContain("- Ships   4M");
  expect(html).toContain("- units.");
  expect(html).toContain("+ Ships 2.1M units.");
  expect(html).toContain("collapsed match"); // tier chip
});

test("editPreviewHtml falls back to `old` when the server sent no resolvedText", () => {
  const html = editPreviewHtml(edit({ resolvedText: undefined }), 0, true);
  expect(html).toContain("- Ships 4M units.");
});

test("editPreviewHtml shows no tier chip for an exact match, and honors the checkbox", () => {
  expect(editPreviewHtml(edit(), 1, true)).not.toContain("collapsed match");
  expect(editPreviewHtml(edit(), 1, true)).toContain('data-edit-idx="1" checked');
  expect(editPreviewHtml(edit(), 1, false)).not.toContain("checked");
});

test("editPreviewHtml escapes model-supplied text", () => {
  const html = editPreviewHtml(edit({ reason: "<img src=x onerror=1>" }), 0, true);
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

test("droppedListHtml renders every rejection with its reason", () => {
  const html = droppedListHtml([
    { edit: { old: "unfindable text" }, reason: "no longer found in the page" },
    { edit: { old: "big one" }, reason: "over the page's 2000-char change budget" },
  ]);
  expect(html).toContain("2 not applied");
  expect(html).toContain("no longer found in the page");
  expect(html).toContain("over the page&#39;s 2000-char change budget");
  expect(droppedListHtml([])).toBe("");
});

test("integratePreviewHtml: zero edits renders the honest nothing-integrable panel", () => {
  const html = integratePreviewHtml(
    { edits: [], dropped: [{ edit: { old: "x" }, reason: "no longer found" }], note: "Nothing safe to change." },
    [],
    false,
  );
  expect(html).toContain("Nothing to integrate");
  expect(html).toContain("Nothing safe to change.");
  expect(html).toContain("no longer found");
  expect(html).not.toContain("wikiFcIntAccept"); // no accept button on an empty proposal
});

test("integratePreviewHtml: accept is disabled when nothing is selected", () => {
  const proposal = { edits: [edit(), edit()], dropped: [] };
  expect(integratePreviewHtml(proposal, [true, false], false)).toContain("Apply 1 edit<");
  const none = integratePreviewHtml(proposal, [false, false], false);
  expect(none).toContain('id="wikiFcIntAccept" class="wiki-fc-int-btn primary" disabled');
});

test("integratePreviewHtml: accept is disabled once the selection exceeds the budget", () => {
  const big = edit({ new: "x".repeat(500), resolvedText: "y".repeat(500) });
  const proposal = {
    edits: [big, big],
    dropped: [],
    budget: { bodyLen: 2000, maxEdits: 12, maxEditChars: 2000, maxChangedChars: 600 },
  };
  expect(selectedChangedChars(proposal.edits, [true, true])).toBe(1000);
  const both = integratePreviewHtml(proposal, [true, true], false);
  expect(both).toContain("1000 / 600 chars — over this page's change budget");
  expect(both).toContain('id="wikiFcIntAccept" class="wiki-fc-int-btn primary" disabled');
  // One edit fits.
  expect(integratePreviewHtml(proposal, [true, false], false)).not.toContain(
    'id="wikiFcIntAccept" class="wiki-fc-int-btn primary" disabled',
  );
});

test("integratePreviewHtml: the callout checkbox reflects the passed default", () => {
  const proposal = { edits: [edit()], dropped: [] };
  expect(integratePreviewHtml(proposal, [true], true)).toContain('id="wikiFcIntCallout" checked');
  expect(integratePreviewHtml(proposal, [true], false)).not.toContain('id="wikiFcIntCallout" checked');
});

// ── Apply-body construction ──────────────────────────────────────────────────

test("buildIntegrateApplyBody sends only the selected edits, verbatim", () => {
  const a = edit({ claimIndex: 1 });
  const b = edit({ claimIndex: 2 });
  const c = edit({ claimIndex: 3 });
  const body = buildIntegrateApplyBody({
    wiki: "jarvis",
    page: "notes/thing",
    baseHash: "h",
    edits: [a, b, c],
    selected: [true, false, true],
    appendCallout: false,
    answer: ANSWER,
  });
  expect(body!.edits).toEqual([a, c]);
  expect(body!.wiki).toBe("jarvis");
  expect(body!.baseHash).toBe("h");
  expect(body!.appendCallout).toBeUndefined();
  expect(body!.answer).toBeUndefined(); // no callout ⇒ no answer payload
});

test("buildIntegrateApplyBody pairs appendCallout with the answer", () => {
  const body = buildIntegrateApplyBody({
    page: "p",
    baseHash: "h",
    edits: [edit()],
    selected: [true],
    appendCallout: true,
    answer: ANSWER,
  });
  expect(body!.appendCallout).toBe(true);
  expect(body!.answer).toBe(ANSWER);
  // …and never asks for a callout it can't build.
  const noAnswer = buildIntegrateApplyBody({
    page: "p",
    baseHash: "h",
    edits: [edit()],
    selected: [true],
    appendCallout: true,
    answer: "",
  });
  expect(noAnswer!.appendCallout).toBeUndefined();
  expect(noAnswer!.answer).toBeUndefined();
});

test("buildIntegrateApplyBody returns null when nothing is selected", () => {
  expect(
    buildIntegrateApplyBody({
      page: "p",
      baseHash: "h",
      edits: [edit()],
      selected: [false],
      appendCallout: false,
    }),
  ).toBeNull();
});

test("integrateSuccessCopy branches on the commit outcome", () => {
  expect(integrateSuccessCopy({ applied: 3, committed: true })).toBe("✓ Integrated 3 edits");
  expect(integrateSuccessCopy({ applied: 1, committed: true })).toBe("✓ Integrated 1 edit");
  expect(integrateSuccessCopy({ applied: 2, committed: false, reason: "not-a-repo" })).toContain(
    "applied, but not committed (no git undo)",
  );
  expect(
    integrateSuccessCopy({ applied: 2, committed: false, reason: "not-default-branch" }),
  ).toContain("applied, but not committed (no git undo)");
  expect(integrateSuccessCopy({ applied: 2, committed: false, reason: "error" })).toContain(
    "not committed (error)",
  );
  expect(integrateSuccessCopy({ applied: 0 })).toContain("nothing was written");
});

// ── Review round: state-driven panel, honest copy, defensive shaping ─────────

test("integratePreviewHtml: an in-flight apply disables Apply, Cancel and every checkbox", () => {
  const proposal = { edits: [edit(), edit()], dropped: [] };
  const html = integratePreviewHtml(proposal, [true, true], false, { applying: true });
  expect(html).toContain(">Applying…</button>");
  expect(html).toContain('id="wikiFcIntAccept" class="wiki-fc-int-btn primary" disabled');
  expect(html).toContain('id="wikiFcIntCancel" class="wiki-fc-int-btn" disabled');
  // Both edit checkboxes are disabled, so a toggle can't re-render an enabled Apply.
  expect(html.split('class="wiki-fc-int-cb"').length - 1).toBe(2);
  expect(html.match(/wiki-fc-int-cb[^>]*disabled/g)).toHaveLength(2);
  expect(html).toContain('id="wikiFcIntCallout" disabled');
});

test("integratePreviewHtml: the panel message renders from state, with its severity", () => {
  const proposal = { edits: [edit()], dropped: [] };
  const err = integratePreviewHtml(proposal, [true], false, {
    message: "Couldn't apply — boom",
    messageError: true,
  });
  expect(err).toContain('class="wiki-fc-int-msg error"');
  expect(err).toContain("Couldn&#39;t apply — boom");
  const quiet = integratePreviewHtml(proposal, [true], false, {});
  expect(quiet).toContain('<div class="wiki-fc-int-msg" id="wikiFcIntMsg"></div>');
});

test("integratePreviewHtml: an applied:0 outcome blocks re-Apply and shows the server's reasons", () => {
  const proposal = { edits: [edit()], dropped: [] };
  const html = integratePreviewHtml(proposal, [true], false, {
    applyBlocked: true,
    applyDropped: [{ edit: { old: "Ships 4M units." }, reason: "no longer found in the page" }],
    message: "No edits could be applied (the page may have shifted) — nothing was written.",
    messageError: true,
  });
  expect(html).toContain('id="wikiFcIntAccept" class="wiki-fc-int-btn primary" disabled');
  // Cancel stays live — the panel must remain dismissible.
  expect(html).toContain('id="wikiFcIntCancel" class="wiki-fc-int-btn">Cancel');
  expect(html).toContain("1 could not be applied to the current page");
  expect(html).toContain("no longer found in the page");
});

test("integratePreviewHtml: the callout label names refresh-vs-add, and disables with no answer", () => {
  const clean = integratePreviewHtml({ edits: [edit()], dropped: [] }, [true], false);
  expect(clean).toContain("also add summary callout");
  const stale = integratePreviewHtml(
    { edits: [edit()], dropped: [], hasSentinelBlock: true },
    [true],
    true,
  );
  expect(stale).toContain("refresh the existing summary callout (replaces the previous one)");
  expect(stale).not.toContain("also add summary callout");
  const noAnswer = integratePreviewHtml({ edits: [edit()], dropped: [] }, [true], false, {
    calloutDisabled: true,
  });
  expect(noAnswer).toContain('id="wikiFcIntCallout" disabled');
  expect(noAnswer).toContain("no stored answer");
});

test("droppedListHtml honors the open state so a re-render can't snap the disclosure shut", () => {
  const rows = [{ edit: { old: "x" }, reason: "nope" }];
  expect(droppedListHtml(rows, false)).toContain('<details class="wiki-fc-int-dropped">');
  expect(droppedListHtml(rows, true)).toContain('<details class="wiki-fc-int-dropped" open>');
});

test("editPreviewHtml guards a non-numeric claimIndex and escapes it", () => {
  const weird = editPreviewHtml(
    { ...edit(), claimIndex: "2<script>" as unknown as number },
    0,
    true,
  );
  expect(weird).not.toContain("<script>");
  expect(weird).not.toContain("wiki-fc-int-claim"); // non-number ⇒ no claim chip at all
  expect(editPreviewHtml(edit({ claimIndex: 2 }), 0, true)).toContain(">Claim 2<");
});

test("editChangedChars never throws on a malformed proposal", () => {
  const broken = { claimIndex: 1, verdict: "❌", reason: "r" } as unknown as ProposedEdit;
  expect(editChangedChars(broken)).toBe(0);
  expect(
    editChangedChars({ ...edit(), resolvedText: undefined, old: undefined as unknown as string }),
  ).toBe("Ships 2.1M units.".length);
  expect(selectedChangedChars([broken], [true])).toBe(0);
});

test("integrateSuccessCopy states the callout outcome, including a requested-but-missing one", () => {
  expect(
    integrateSuccessCopy({ applied: 2, committed: true, calloutAdded: true, calloutRequested: true }),
  ).toBe("✓ Integrated 2 edits + summary callout added");
  expect(
    integrateSuccessCopy({
      applied: 1,
      committed: true,
      calloutAdded: true,
      calloutRequested: true,
      calloutReplaced: true,
    }),
  ).toBe("✓ Integrated 1 edit + summary callout refreshed");
  expect(
    integrateSuccessCopy({ applied: 1, committed: true, calloutAdded: false, calloutRequested: true }),
  ).toBe("✓ Integrated 1 edit (summary callout was NOT added)");
  // Never mentioned when it was never asked for.
  expect(integrateSuccessCopy({ applied: 1, committed: true })).toBe("✓ Integrated 1 edit");
});

test("the two stale-copy strings name their OWN next action", () => {
  expect(INTEGRATE_STALE_COPY).toContain("then add it");
  expect(INTEGRATE_STALE_COPY_EDIT).toContain("then integrate again");
  expect(INTEGRATE_STALE_COPY_EDIT).not.toContain("add it");
});
