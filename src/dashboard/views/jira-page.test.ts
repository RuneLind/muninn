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
});
const draftPage = await renderJiraPage({ kind: "draft", draft: draftView });

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

  test("an unknown draft is a named page, not a blank one", async () => {
    const html = await renderJiraPage({ kind: "missing", draftId: "not-a-uuid" });
    expect(html).toContain("Utkastet finnes ikke");
    expect(html).toContain("not-a-uuid");
    expect(html).toContain('href="/jira"');
  });
});

describe("the fallback", () => {
  test("names the failure and points at the API that still works", () => {
    const html = renderJiraFallback("bundle failed: <boom>");
    expect(html).toContain("bundle failed: &lt;boom&gt;");
    expect(html).toContain("GET /api/jira/archive");
  });
});
