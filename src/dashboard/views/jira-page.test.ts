/**
 * What only a whole-page render can see.
 *
 * The archive's behaviour is unit-tested in
 * `views/components/jira-archive-pure.test.ts`; this file pins the things that
 * live in the SEAM between the page and everything it composes, each of which is
 * invisible to tsc and to every pure test:
 *
 *   1. the markdown is rendered SERVER-side — `curl /jira?draft=` is the whole
 *      page, which is what makes the archive readable with no JavaScript and
 *      what the acceptance sweep greps;
 *   2. the client bundle is actually inlined (a memoized `Bun.build` that threw
 *      would leave a page whose view switch and copy button do nothing);
 *   3. the nav entry, the three page shapes and the fallback.
 *
 * Synthetic keys and text only — muninn is a public repo.
 */

import { describe, expect, test } from "bun:test";
import { renderJiraPage, renderJiraFallback } from "./jira-page.ts";
import { JA_COPY_ID, JA_RAW_ID } from "./components/jira-archive-pure.ts";
import type { JiraDraftListRow, JiraDraftView } from "../../jira/wire.ts";

const listRow: JiraDraftListRow = {
  draftId: "11111111-1111-4111-8111-111111111111",
  bot: "melosys",
  source: "thread",
  template: "bug",
  depth: "skisse",
  status: "ready",
  title: "Feil i beregning av avgift",
  retrievalCoverage: "answer",
  coverage: "answer",
  threadId: "t-1",
  threadName: "avgift",
  savedAt: 1_700_000_000_000,
  createdAt: 1_699_999_000_000,
};

const draftView: JiraDraftView = {
  draftId: "22222222-2222-4222-8222-222222222222",
  bot: "melosys",
  status: "ready",
  template: "bug",
  depth: "full",
  notes: "møtenotat",
  extra: "",
  markdown:
    "# Feil i beregning\n\n- punkt\n\n## Referanser\n\n[MELOSYS-1](https://example.test/browse/MELOSYS-1)",
  citations: [],
  excludeDocIds: [],
  keyVerdicts: [{ key: "MELOSYS-1", state: "verified" }],
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
};

const listPage = await renderJiraPage({
  kind: "list",
  drafts: [listRow],
  savedOnly: true,
  limit: 50,
  limitParam: null,
  capped: false,
});
const draftPage = await renderJiraPage({ kind: "draft", draft: draftView });
const generatingPage = await renderJiraPage({
  kind: "draft",
  draft: { ...draftView, status: "generating", markdown: null },
});
/** A failed REGENERATE — the row keeps the previous turn's text, and the page
 *  refuses to show it. Neither the heading nor the bundle may forget that. */
const failedPage = await renderJiraPage({
  kind: "draft",
  draft: {
    ...draftView,
    status: "failed",
    markdown: "## Symptom\nSyntetisk forrige tekst",
    error: "modellen svarte ikke",
  },
});

describe("the shell", () => {
  test("marks Jira active inside the Tools dropdown, not the top-level row", () => {
    expect(listPage).toContain('<a href="/jira" class="nav-dropdown-item active">Jira</a>');
    // The top-level row must not have grown an eleventh link.
    expect(listPage).not.toContain('<a href="/jira" class="nav-link');
  });

  test("the client bundle is inlined — the view switch and copy need it", () => {
    expect(draftPage).toContain("addEventListener");
    expect(draftPage).toContain("clipboard");
    expect(draftPage).toContain(JA_RAW_ID);
  });

  test("a draft with no interactive target ships no bundle either", () => {
    // The bundle owns exactly the view switch and the copy button. A failed or
    // still-generating draft renders neither, so building and inlining ~3 KB
    // there is a `Bun.build` and a parse for nothing.
    for (const page of [failedPage, generatingPage]) {
      expect(page).not.toContain("clipboard");
      expect(page).not.toContain(JA_RAW_ID);
    }
  });

  test("the LIST page ships no bundle — it has no interactive target", () => {
    // Every row is a link. Shipping ~3 KB of view-switch and clipboard code to a
    // page with neither is a build and a parse for nothing.
    expect(listPage).not.toContain("clipboard");
    expect(listPage).not.toContain(JA_RAW_ID);
  });

  test("only a GENERATING draft refreshes itself", () => {
    // The chat's thread-level notice links here for a draft no bubble can carry;
    // a static "skrives fortsatt" page never became the finished draft.
    expect(generatingPage).toContain('<meta http-equiv="refresh" content="5">');
    expect(generatingPage).toContain("skrives fortsatt");
    expect(draftPage).not.toContain("http-equiv=\"refresh\"");
    expect(listPage).not.toContain("http-equiv=\"refresh\"");
  });

  test("no-JavaScript readers still reach the raw markdown", () => {
    expect(draftPage).toContain("<noscript>");
    expect(draftPage).toContain(".ja-raw[hidden]");
  });

  test("the composer is gone — nothing on the page starts a generation", () => {
    for (const page of [listPage, draftPage]) {
      expect(page).not.toContain("Skriv utkast");
      expect(page).not.toContain("Generer på nytt");
      expect(page).not.toContain("/api/jira/templates");
    }
  });
});

describe("the list", () => {
  test("renders its rows server-side, with the saved/all toggle", () => {
    expect(listPage).toContain("Feil i beregning av avgift");
    expect(listPage).toContain('href="/jira?draft=11111111-1111-4111-8111-111111111111"');
    expect(listPage).toContain('href="/jira?all=1"');
  });
});

describe("one draft", () => {
  test("the markdown is RENDERED into the page, not handed to a bundle", () => {
    // The heading contract: `formatWebHtml` emits `h${level+1}`, so `# ` is h2.
    expect(draftPage).toContain("<h2>Feil i beregning</h2>");
    expect(draftPage).toContain("<h3>Referanser</h3>");
    // …and the reference link resolves as a link, not as literal markdown.
    expect(draftPage).toContain('href="https://example.test/browse/MELOSYS-1"');
    expect(draftPage).toContain("<li>punkt</li>");
  });

  test("the raw markdown rides along for the copy button", () => {
    expect(draftPage).toContain(`id="${JA_COPY_ID}"`);
    expect(draftPage).toContain("## Referanser");
  });

  test("the title names the draft", () => {
    expect(draftPage).toContain("<title>Muninn - Feil i beregning</title>");
  });

  test("a FAILED draft is not named after the text the page refuses to show", () => {
    expect(failedPage).not.toContain("Syntetisk forrige tekst");
    expect(failedPage).toContain("<title>Muninn - Mislykket utkast</title>");
    expect(failedPage).toContain("Genereringen feilet");
  });

  test("an unknown draft is a named page, not a blank one", async () => {
    const html = await renderJiraPage({ kind: "missing", draftId: "not-a-uuid" });
    expect(html).toContain("Utkastet finnes ikke");
    expect(html).toContain("not-a-uuid");
    expect(html).toContain('href="/jira"');
  });
});

describe("the fallback", () => {
  test("names the failure and the API that reads the same rows", () => {
    const html = renderJiraFallback("bundle failed: <boom>");
    expect(html).toContain("bundle failed: &lt;boom&gt;");
    expect(html).toContain("GET /api/jira/archive");
    // It must NOT promise the API is unaffected: the page reads the DB now, so
    // the commonest reason this renders is a database the API shares.
    expect(html).not.toContain("upåvirket");
  });
});
