/**
 * The `/jira` ARCHIVE's pure half.
 *
 * Three groups matter here, and the first two are carried over from the deleted
 * `jira-composer-pure.test.ts` because the logic moved rather than changed:
 *
 *   1. `jiraCoverageNotice` — the PAIR rule. `retrieval_coverage` is historical
 *      data on rows this page renders and `toView` casts the stored string
 *      unchecked, so all FOUR readings have to render, and a derived `no_hits`
 *      has to be told apart from a reader who switched every source off.
 *   2. the key/flag chips, whose three states are the point of the verification.
 *   3. the archive's own markup: which rows link where, what the saved/all
 *      toggle does, and the four things a thread draft renders differently.
 *
 * Every key and every sentence here is SYNTHETIC (`MELOSYS-1`, `ARK-2`) — muninn
 * is a public repo.
 */

import { describe, expect, test } from "bun:test";
import {
  JA_COPY_ID,
  JA_COPY_LABEL,
  JA_PREVIEW_ID,
  JA_RAW_ID,
  JA_UNTITLED,
  deriveDraftHeading,
  depthLabel,
  formatArchiveTime,
  jiraArchiveListHtml,
  jiraArchiveMissingHtml,
  jiraArchiveRowHtml,
  jiraBackLinkHtml,
  jiraChatUrl,
  jiraCoverageNotice,
  jiraDraftViewHtml,
  keyVerdictChip,
  markdownFlagLine,
  parseArchiveAll,
  safeExternalHref,
  threadDraftLabel,
} from "./jira-archive-pure.ts";
import {
  JIRA_ALL_EXCLUDED_MESSAGE,
  JIRA_LOW_CONFIDENCE_MESSAGE,
  JIRA_NO_HITS_MESSAGE,
  JIRA_UNREACHABLE_MESSAGE,
  jiraArchiveUrl,
  jiraDraftUrl,
  type JiraDraftListRow,
  type JiraDraftView,
} from "../../../jira/wire.ts";

function row(over: Partial<JiraDraftListRow> = {}): JiraDraftListRow {
  return {
    draftId: "11111111-1111-4111-8111-111111111111",
    bot: "melosys",
    source: "notes",
    template: "bug",
    depth: "skisse",
    status: "ready",
    title: "Feil i beregning av avgift",
    retrievalCoverage: "answer",
    coverage: "answer",
    threadId: null,
    threadName: null,
    savedAt: 1_700_000_000_000,
    createdAt: 1_699_999_000_000,
    ...over,
  };
}

function draft(over: Partial<JiraDraftView> = {}): JiraDraftView {
  return {
    draftId: "22222222-2222-4222-8222-222222222222",
    bot: "melosys",
    status: "ready",
    template: "bug",
    depth: "full",
    notes: "råmateriale fra et møte",
    extra: "",
    markdown: "# Feil i beregning\n\nNoe er galt.\n\n## Referanser\n\n[MELOSYS-1](https://example.test/browse/MELOSYS-1)",
    citations: [],
    excludeDocIds: [],
    keyVerdicts: [],
    markdownFlags: [],
    retrievalCoverage: "answer",
    coverage: "answer",
    retrievalQuestion: "hva er galt",
    error: null,
    source: "notes",
    threadId: null,
    threadName: null,
    threadUserId: null,
    messageId: null,
    savedAt: null,
    createdAt: 1_699_999_000_000,
    updatedAt: 1_699_999_500_000,
    ...over,
  };
}

describe("jiraCoverageNotice — the pair, not the derived verdict", () => {
  test("a grounded draft says nothing", () => {
    expect(jiraCoverageNotice("answer", "answer")).toBeNull();
  });

  test("retrieval found nothing ⇒ the corpus sentence", () => {
    expect(jiraCoverageNotice("no_hits", "no_hits")).toEqual({
      tone: "bad",
      text: JIRA_NO_HITS_MESSAGE,
    });
  });

  test("retrieval found hits the reader switched all off ⇒ the all-excluded sentence", () => {
    // The whole reason both halves ride the payload: this row's derived verdict
    // is `no_hits`, and saying jira-issues covered nothing would be a lie about
    // the corpus.
    expect(jiraCoverageNotice("answer", "no_hits")).toEqual({
      tone: "bad",
      text: JIRA_ALL_EXCLUDED_MESSAGE,
    });
  });

  test("weakly grounded ⇒ the low-confidence sentence, warn not bad", () => {
    expect(jiraCoverageNotice("low_confidence", "low_confidence")).toEqual({
      tone: "warn",
      text: JIRA_LOW_CONFIDENCE_MESSAGE,
    });
  });

  test("unreachable wins over everything, from either half", () => {
    expect(jiraCoverageNotice("unreachable", "unreachable")?.text).toBe(JIRA_UNREACHABLE_MESSAGE);
    // The stored half alone is enough: `effectiveCoverage` passes it through, but
    // a hand-edited or partially-migrated row must not degrade to `no_hits`.
    expect(jiraCoverageNotice("unreachable", "no_hits")?.text).toBe(JIRA_UNREACHABLE_MESSAGE);
  });

  test("a null verdict (retrieval never landed) renders nothing", () => {
    expect(jiraCoverageNotice(null, null)).toBeNull();
  });

  test("a THREAD draft suppresses the corpus sentence and nothing else", () => {
    // The corpus sentence names the three collections a `?q=` search covered —
    // a statement only the notes path can make.
    expect(jiraCoverageNotice("no_hits", "no_hits", "thread")).toBeNull();
    expect(jiraCoverageNotice("answer", "no_hits", "thread")?.text).toBe(JIRA_ALL_EXCLUDED_MESSAGE);
    expect(jiraCoverageNotice("unreachable", "unreachable", "thread")?.text).toBe(
      JIRA_UNREACHABLE_MESSAGE,
    );
    expect(jiraCoverageNotice("low_confidence", "low_confidence", "thread")?.text).toBe(
      JIRA_LOW_CONFIDENCE_MESSAGE,
    );
  });
});

describe("key verdicts", () => {
  test("verified, notes-only and unknown are three states with three colours", () => {
    expect(keyVerdictChip({ key: "MELOSYS-1", state: "verified" }).cls).toContain("ja-key-ok");
    expect(keyVerdictChip({ key: "MELOSYS-2", state: "notes" }).cls).toContain("ja-key-notes");
    expect(keyVerdictChip({ key: "MELOSYS-3", state: "unknown" }).cls).toContain("ja-key-unknown");
  });

  test("an unavailable lookup never reads as a fabrication verdict", () => {
    const hint = keyVerdictChip({ key: "MELOSYS-4", state: "notes" }).hint;
    expect(hint).toContain("utilgjengelig");
    expect(hint).not.toContain("finnes ikke");
    expect(keyVerdictChip({ key: "MELOSYS-5", state: "notes", resolved: false }).hint).toContain(
      "finnes ikke",
    );
  });

  test("a flag line names the line, the construct and the consequence", () => {
    const line = markdownFlagLine({ kind: "task-list", line: 12, sample: "- [ ] gjør noe" });
    expect(line).toContain("Linje 12");
    expect(line).toContain("avkryssingsliste");
    expect(line).toContain("Jira konverterer ikke");
  });
});

describe("urls", () => {
  test("the all-attempts toggle is linkable and forgiving", () => {
    expect(parseArchiveAll("1")).toBe(true);
    expect(parseArchiveAll("")).toBe(true); // a bare `?all`
    expect(parseArchiveAll("true")).toBe(true);
    expect(parseArchiveAll(undefined)).toBe(false);
    expect(parseArchiveAll("0")).toBe(false);
    expect(parseArchiveAll("nei")).toBe(false);
  });

  test("the chat deep link carries the thread OWNER when the view served one", () => {
    expect(jiraChatUrl("melosys", "t-1", "u-1")).toBe("/chat?bot=melosys&user=u-1&thread=t-1");
    expect(jiraChatUrl("melosys", "t-1")).toBe("/chat?bot=melosys&thread=t-1");
    // A link that cannot be built is not rendered as `/chat?bot=&thread=`.
    expect(jiraChatUrl(undefined, "t-1")).toBeUndefined();
    expect(jiraChatUrl("melosys", null)).toBeUndefined();
  });

  test("only http(s) survives as an external href", () => {
    expect(safeExternalHref("https://example.test/x")).toBe("https://example.test/x");
    expect(safeExternalHref("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalHref(undefined)).toBeUndefined();
  });
});

describe("the list", () => {
  test("a row links to the draft and names origin, template, depth and bot", () => {
    const html = jiraArchiveRowHtml(row());
    expect(html).toContain(`href="/jira?draft=11111111-1111-4111-8111-111111111111"`);
    expect(html).toContain("Feil i beregning av avgift");
    expect(html).toContain("fra notater");
    expect(html).toContain("bug · Skisse");
    expect(html).toContain("melosys");
    expect(html).toContain("lagret");
  });

  test("a thread row names its conversation, falling back to the id", () => {
    expect(jiraArchiveRowHtml(row({ source: "thread", threadName: "avgift", threadId: "t-1" })))
      .toContain("fra samtalen «avgift»");
    expect(jiraArchiveRowHtml(row({ source: "thread", threadName: null, threadId: "t-1" })))
      .toContain("fra samtalen «t-1»");
  });

  test("a titleless row still says something", () => {
    expect(jiraArchiveRowHtml(row({ title: null }))).toContain(JA_UNTITLED);
  });

  test("a failed row is marked failed; a ready one carries no status chip", () => {
    expect(jiraArchiveRowHtml(row({ status: "failed", title: null }))).toContain("ja-chip-failed");
    expect(jiraArchiveRowHtml(row())).not.toContain("ja-chip-ready");
  });

  test("the coverage chip carries the SENTENCE as its title, not as row text", () => {
    const html = jiraArchiveRowHtml(row({ retrievalCoverage: "unreachable", coverage: "unreachable" }));
    expect(html).toContain("kunnskaps-API nede");
    expect(html).toContain(`title="${JIRA_UNREACHABLE_MESSAGE}"`);
    // A grounded row grows no chip at all.
    expect(jiraArchiveRowHtml(row())).not.toContain("ja-cov");
  });

  test("the toggle marks the active tab and links to the other state", () => {
    const saved = jiraArchiveListHtml([row()], { savedOnly: true, limit: 50, limitParam: null, capped: false });
    expect(saved).toContain(`<a class="ja-tab ja-tab-on" href="/jira">Lagrede</a>`);
    expect(saved).toContain(`<a class="ja-tab" href="/jira?all=1">Alle forsøk</a>`);

    const all = jiraArchiveListHtml([row()], { savedOnly: false, limit: 50, limitParam: null, capped: false });
    expect(all).toContain(`<a class="ja-tab" href="/jira">Lagrede</a>`);
    expect(all).toContain(`<a class="ja-tab ja-tab-on" href="/jira?all=1">Alle forsøk</a>`);
  });

  test("the empty state differs by which list is empty", () => {
    expect(jiraArchiveListHtml([], { savedOnly: true, limit: 50, limitParam: null, capped: false })).toContain("«Lagre»");
    expect(jiraArchiveListHtml([], { savedOnly: false, limit: 50, limitParam: null, capped: false })).toContain("🧾 Lag Jira-sak");
  });

  test("a listing that filled its clamp says the count is the newest N", () => {
    const rows = [row(), row(), row()];
    expect(
      jiraArchiveListHtml(rows, { savedOnly: true, limit: 3, limitParam: 3, capped: true }),
    ).toContain("(de nyeste 3)");
    // An EXACT-fit page is not a truncated one: three rows under a limit of
    // three claimed truncation while nothing was cut.
    expect(
      jiraArchiveListHtml(rows, { savedOnly: true, limit: 3, limitParam: 3, capped: false }),
    ).not.toContain("de nyeste");
  });
});

describe("one draft, read-only", () => {
  test("the body html is embedded and the raw markdown rides a read-only pane", () => {
    const html = jiraDraftViewHtml(draft(), "<h2>Feil i beregning</h2>");
    expect(html).toContain("<h2>Feil i beregning</h2>");
    expect(html).toContain(`id="${JA_PREVIEW_ID}"`);
    expect(html).toContain(`id="${JA_RAW_ID}"`);
    expect(html).toContain("readonly");
    expect(html).toContain(`id="${JA_COPY_ID}"`);
    // Read-only means read-only: none of the composer's write affordances.
    expect(html).not.toContain("Generer på nytt");
    expect(html).not.toContain("Lagre utkast");
  });

  test("a thread draft leads with its provenance banner and the chat deep link", () => {
    const html = jiraDraftViewHtml(
      draft({
        source: "thread",
        threadId: "t-9",
        threadName: "avgiftsfeil",
        threadUserId: "u-9",
        notes: "fra samtale: avgiftsfeil",
      }),
      "",
    );
    expect(html).toContain("Utkast fra samtalen «avgiftsfeil»");
    // `&` escaped, as it must be inside an attribute.
    expect(html).toContain("/chat?bot=melosys&amp;user=u-9&amp;thread=t-9");
    // The `fra samtale: …` placeholder is server bookkeeping, never offered as
    // the reader's own raw material.
    expect(html).not.toContain("fra samtale: avgiftsfeil</pre>");
  });

  test("a notes draft keeps its raw material, collapsed and secondary", () => {
    const html = jiraDraftViewHtml(draft({ notes: "møtenotat om avgift" }), "");
    expect(html).toContain("<summary>Råmateriale</summary>");
    expect(html).toContain("møtenotat om avgift");
  });

  test("a failed draft renders its error and offers no copy", () => {
    const html = jiraDraftViewHtml(
      draft({ status: "failed", markdown: null, error: "modellen svarte ikke" }),
      "",
    );
    expect(html).toContain("Genereringen feilet");
    expect(html).toContain("modellen svarte ikke");
    expect(html).not.toContain(`id="${JA_COPY_ID}"`);
  });

  test("the saved state is a chip either way — never an absent one", () => {
    expect(jiraDraftViewHtml(draft({ savedAt: 1_700_000_000_000 }), "")).toContain("ja-chip-saved");
    expect(jiraDraftViewHtml(draft({ savedAt: null }), "")).toContain("ja-chip-unsaved");
  });

  test("all four coverage readings reach the draft page", () => {
    expect(jiraDraftViewHtml(draft(), "")).not.toContain("ja-banner-bad");
    expect(
      jiraDraftViewHtml(draft({ retrievalCoverage: "no_hits", coverage: "no_hits" }), ""),
    ).toContain(JIRA_NO_HITS_MESSAGE);
    expect(
      jiraDraftViewHtml(draft({ retrievalCoverage: "low_confidence", coverage: "low_confidence" }), ""),
    ).toContain(JIRA_LOW_CONFIDENCE_MESSAGE);
    expect(
      jiraDraftViewHtml(draft({ retrievalCoverage: "unreachable", coverage: "unreachable" }), ""),
    ).toContain(JIRA_UNREACHABLE_MESSAGE);
  });

  test("key chips and markdown flags render", () => {
    const html = jiraDraftViewHtml(
      draft({
        keyVerdicts: [
          { key: "MELOSYS-1", state: "verified", url: "https://example.test/browse/MELOSYS-1" },
          { key: "ARK-2", state: "unknown" },
        ],
        markdownFlags: [{ kind: "html", line: 3, sample: "<b>x</b>" }],
      }),
      "",
    );
    expect(html).toContain("MELOSYS-1");
    expect(html).toContain(`href="https://example.test/browse/MELOSYS-1"`);
    expect(html).toContain("ARK-2");
    expect(html).toContain("Linje 3");
  });

  test("every draft page can get back to the list", () => {
    expect(jiraDraftViewHtml(draft(), "")).toContain(`href="/jira"`);
    expect(jiraArchiveMissingHtml("nope")).toContain(`href="/jira"`);
  });

  test("an unknown id is named, not swallowed", () => {
    const html = jiraArchiveMissingHtml("not-a-uuid");
    expect(html).toContain("finnes ikke");
    expect(html).toContain("not-a-uuid");
  });

  test("the heading is the draft's own, and the same derivation the row used", () => {
    expect(deriveDraftHeading({ markdown: "# Feil i beregning\n\ntekst" })).toBe("Feil i beregning");
    expect(deriveDraftHeading({ markdown: null })).toBe(JA_UNTITLED);
  });
});

describe("labels", () => {
  test("the depth renders its reader-facing name", () => {
    expect(depthLabel("skisse")).toBe("Skisse");
    expect(depthLabel("ingen")).toBe("Ingen");
    // A depth the union does not know still renders as itself.
    expect(depthLabel("dyp")).toBe("dyp");
  });

  test("the timestamp is local wall clock, zero-padded", () => {
    const ms = new Date(2026, 7, 23, 9, 5).getTime();
    expect(formatArchiveTime(ms)).toBe("2026-08-23 09:05");
  });

  test("a nameless thread falls back to its id, then to a word", () => {
    expect(threadDraftLabel("avgift", "t-1")).toBe("avgift");
    expect(threadDraftLabel(null, "t-1")).toBe("t-1");
    expect(threadDraftLabel(null, null)).toBe("samtalen");
  });
});

describe("list state survives every link", () => {
  const state = { all: true, limit: 200 };

  test("the toggle keeps the limit the reader typed", () => {
    const html = jiraArchiveListHtml([row()], {
      savedOnly: false, limit: 200, limitParam: 200, capped: false,
    });
    expect(html).toContain(`href="/jira?limit=200"`);
    expect(html).toContain(`href="/jira?all=1&amp;limit=200"`);
  });

  test("a row carries the list state it was opened from", () => {
    expect(jiraArchiveRowHtml(row(), state)).toContain(
      `href="/jira?draft=11111111-1111-4111-8111-111111111111&amp;all=1&amp;limit=200"`,
    );
    // No state ⇒ the plain link, unchanged.
    expect(jiraArchiveRowHtml(row())).toContain(
      `href="/jira?draft=11111111-1111-4111-8111-111111111111"`,
    );
  });

  test("the back link returns to the list, not to a different one", () => {
    expect(jiraBackLinkHtml(state)).toContain(`href="/jira?all=1&amp;limit=200"`);
    expect(jiraDraftViewHtml(draft(), "", state)).toContain(`href="/jira?all=1&amp;limit=200"`);
    expect(jiraArchiveMissingHtml("nope", state)).toContain(`href="/jira?all=1&amp;limit=200"`);
    expect(jiraBackLinkHtml()).toContain(`href="/jira"`);
  });
});

describe("a failed draft never offers text it will not show", () => {
  test("stored markdown does not resurrect the preview, the switch or the copy", () => {
    // `failJiraDraft` leaves `markdown` alone, so a failed REGENERATE carries the
    // previous turn's text. Rendering it under a "Genereringen feilet" banner
    // offers a draft the run did not produce — and Kopier would copy it.
    const html = jiraDraftViewHtml(
      draft({ status: "failed", markdown: "# Forrige forsøk\n\ntekst", error: "modellen svarte ikke" }),
      "<h2>Forrige forsøk</h2>",
    );
    expect(html).toContain("Genereringen feilet");
    expect(html).not.toContain(`id="${JA_COPY_ID}"`);
    expect(html).not.toContain(`id="${JA_PREVIEW_ID}"`);
    expect(html).not.toContain(`id="${JA_RAW_ID}"`);
    expect(html).not.toContain("<h2>Forrige forsøk</h2>");
    expect(html).not.toContain("Forhåndsvisning");
  });
});

describe("a generating draft", () => {
  test("says it is still being written, and offers no copy", () => {
    const html = jiraDraftViewHtml(draft({ status: "generating", markdown: null }), "");
    expect(html).toContain("skrives fortsatt");
    expect(html).toContain("ja-chip-generating");
    expect(html).not.toContain(`id="${JA_COPY_ID}"`);
  });
});

describe("an unparseable timestamp", () => {
  test("empties the stamp instead of taking the whole list down", () => {
    // `new Date(NaN).toISOString()` throws a RangeError, and the row is rendered
    // inside the page's try — one bad `created_at` took the archive to the
    // fallback.
    expect(() => jiraArchiveRowHtml(row({ createdAt: Number.NaN }))).not.toThrow();
    expect(jiraArchiveRowHtml(row({ createdAt: Number.NaN }))).not.toContain("datetime=");
    expect(() =>
      jiraDraftViewHtml(draft({ createdAt: Number.NaN, savedAt: Number.NaN }), ""),
    ).not.toThrow();
  });
});

describe("coverage words", () => {
  test("every reading that renders a notice renders its own chip word", () => {
    const word = (retrieval: "no_hits" | "low_confidence" | "answer", coverage: "no_hits" | "low_confidence") =>
      jiraArchiveRowHtml(row({ retrievalCoverage: retrieval, coverage }));
    expect(word("no_hits", "no_hits")).toContain("ingen kilder");
    expect(word("low_confidence", "low_confidence")).toContain("svak forankring");
    // The all-excluded reading keeps the `no_hits` word but the other sentence.
    expect(word("answer", "no_hits")).toContain("ingen kilder");
    expect(word("answer", "no_hits")).toContain(JIRA_ALL_EXCLUDED_MESSAGE);
  });
});

describe("the copy button's label", () => {
  test("is one constant, so the bundle's restore cannot drift from the render", () => {
    expect(jiraDraftViewHtml(draft(), "")).toContain(`>${JA_COPY_LABEL}<`);
  });
});
