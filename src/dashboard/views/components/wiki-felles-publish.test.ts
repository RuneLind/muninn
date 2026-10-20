import { describe, expect, test } from "bun:test";
import {
  fellesBtnHtml,
  fellesDialogHtml,
  fellesOutcomeLine,
  fellesOutputHtml,
  fellesPublishCommand,
  fellesStateMap,
  fellesSyncChipHtml,
  fellesSyncDialogHtml,
  fellesSyncListHtml,
  fellesSyncOutcomeLine,
  FELLES_STALE_CLASS,
  FELLES_STALE_TITLE,
  shellQuote,
  type FellesSyncStatus,
} from "./wiki-felles-publish.ts";
// The names this fix round added, read off the namespace so each test fails on
// its own rather than the whole file failing to link.
import * as felles from "./wiki-felles-publish.ts";
const fellesSyncRunOutcome = (...a: Parameters<typeof felles.fellesSyncRunOutcome>) => felles.fellesSyncRunOutcome(...a);

describe("fellesPublishCommand", () => {
  test("reproduces the manual command", () => {
    expect(
      fellesPublishCommand({
        bin: "/n/muninn-nais/scripts/publiser-felles-wiki.ts",
        root: "/Users/rune/source/nav/melosys-kode-wiki",
        relPath: "plans/2026-09-29-vedtaksmetadata-fagavklaring.mdx",
        allowIdent: true,
      }),
    ).toBe(
      "bun --no-env-file /n/muninn-nais/scripts/publiser-felles-wiki.ts --tillat-ident /Users/rune/source/nav/melosys-kode-wiki plans/2026-09-29-vedtaksmetadata-fagavklaring.mdx",
    );
  });

  test("quotes what a shell would split", () => {
    expect(fellesPublishCommand({ bin: "/b.ts", root: "/w w", relPath: "x/it's.md", allowIdent: false, dryRun: true })).toBe(
      "bun --no-env-file /b.ts --dry-run '/w w' 'x/it'\\''s.md'",
    );
  });
});

test("shellQuote leaves plain tokens bare", () => {
  expect(shellQuote("plans/a-b_c.mdx")).toBe("plans/a-b_c.mdx");
  expect(shellQuote("a$b")).toBe("'a$b'");
});

test("each exit code has its own line", () => {
  expect(fellesOutcomeLine(0, true).ok).toBe(true);
  expect(fellesOutcomeLine(0, false).text).toMatch(/^Published/);
  for (const code of [1, 2, 3, 9]) expect(fellesOutcomeLine(code, false).ok).toBe(false);
});

test("the dialog's remove confirmation starts hidden", () => {
  const html = fellesDialogHtml("plans/a.mdx");
  expect(html).toContain('data-felles="remove"');
  expect(html).toMatch(/<div class="wiki-felles-confirm" hidden>/);
});

// Finding 11: the confirm row names every object the confirm deletes.
test("the remove confirm row lists the page's data files and the shared ones it keeps", () => {
  const html = felles.fellesRemoveConfirmHtml(["plans/case.mdx", "plans/case.yaml", "plans/runs.csv"], ["shared/<b>.csv"]);
  expect(html).toContain("Delete 3 objects from the bucket?");
  expect(html).toContain("<code>plans/case.yaml</code>");
  expect(html).toContain("<code>plans/runs.csv</code>");
  expect(html).toContain("another page reads it");
  expect(html).toContain("<code>shared/&lt;b&gt;.csv</code>");
  // A page with no data files keeps the plain question.
  expect(felles.fellesRemoveConfirmHtml(["plans/a.mdx"], [])).toBe(
    "Delete it from the bucket? The bucket keeps no copy; your local page stays.",
  );
});

test("the confirm row names the data files kept because the script refuses their name", () => {
  const html = felles.fellesRemoveConfirmHtml(["plans/case.mdx"], [], ["plans/a[1].csv", "plans/<x>*.csv"]);
  expect(html).toContain("the script refuses");
  expect(html).toContain("<code>plans/a[1].csv</code>");
  expect(html).toContain("<code>plans/&lt;x&gt;*.csv</code>");
  // Only the page goes, so the question counts one object.
  expect(html).toContain("Delete it from the bucket?");
});

// The decision table's OUTCOMES (src/wiki/CLAUDE.md, felles remove): one row
// per cell. `row` is what the confirm row offers; a retry row never names the
// page, and only a page proven gone offers it.
describe("fellesRemoveView: one row per outcome cell", () => {
  const PAGE = "plans/case.mdx";
  const DATA = ["plans/case.yaml", "plans/runs.csv"];
  const cmd = { bin: "/n/publiser.ts", relPath: PAGE };
  type Want = { text: RegExp; ok: boolean; row: "hidden" | "confirm" | "retry" | "none"; has?: string[]; lacks?: string[] };
  const real = (over: Record<string, unknown>) => ({ exitCode: 0, removes: [PAGE, ...DATA], dataFiles: DATA, retryDataFiles: false, ...over });
  const retry = (over: Record<string, unknown>) => ({ exitCode: 0, removes: DATA, dataFiles: DATA, dataFilesOnly: true, retryDataFiles: false, ...over });
  const ROWS: [string, "remove" | "remove-data", boolean, number, Record<string, unknown> | null, Want][] = [
    // Dry runs never ask the bucket.
    ["D1 dry run exit 0: the confirm row lists every object", "remove", true, 200, { exitCode: 0, removes: [PAGE, ...DATA], keptShared: [], keptRefused: [] }, { text: /does not check/, ok: true, row: "confirm", has: DATA }],
    ["D2 dry run exit 3", "remove", true, 200, { exitCode: 3 }, { text: /^Delete failed in a dry run/, ok: false, row: "hidden" }],
    ["D3 dry run exit 1", "remove", true, 200, { exitCode: 1 }, { text: /dry run deletes nothing/, ok: false, row: "hidden" }],
    ["D4 dry run exit 2", "remove", true, 200, { exitCode: 2 }, { text: /^Usage or environment error/, ok: false, row: "hidden" }],
    ["D5 dry run another code", "remove", true, 200, { exitCode: 9 }, { text: /exited with code 9/, ok: false, row: "hidden" }],
    // Page run deleted the page.
    ["P1 page deleted, no data files", "remove", false, 200, real({ pageRun: "deleted", dataFiles: [], removes: [PAGE] }), { text: /^Removed\. The pod drops the page/, ok: true, row: "hidden" }],
    ["P2 page deleted, data deleted", "remove", false, 200, real({ pageRun: "deleted", dataRun: "deleted", dataFilesExitCode: 0 }), { text: /^Removed the page and its data files/, ok: true, row: "hidden" }],
    ["P3 page deleted, data not-found only", "remove", false, 200, real({ pageRun: "deleted", dataRun: "missing", dataFilesExitCode: 3 }), { text: /^Removed the page\. Its data files are gone from the bucket too/, ok: true, row: "hidden" }],
    ["P4 page deleted, data exit 3 other", "remove", false, 200, real({ pageRun: "deleted", dataRun: "failed", dataFilesExitCode: 3, retryDataFiles: true }), { text: /^Removed the page\. At least one data-file delete failed with an error muninn does not read/, ok: false, row: "retry", has: DATA, lacks: [PAGE] }],
    ["P5 page deleted, data other code", "remove", false, 200, real({ pageRun: "deleted", dataRun: "error", dataFilesExitCode: 2 }), { text: /^Removed the page\. The data-file delete exited with code 2/, ok: false, row: "none", has: [`--fjern -- ${DATA.join(" ")}`], lacks: [PAGE] }],
    ["P6 page deleted, data timeout", "remove", false, 200, real({ pageRun: "deleted", dataRun: "timeout", dataFilesExitCode: null, retryDataFiles: true }), { text: /^Removed the page\. The data-file delete timed out/, ok: false, row: "retry", has: DATA, lacks: [PAGE] }],
    // Page run proved the page not in the bucket: no data run, since a page
    // published under another name (this one before a rename) may still show them.
    ["P7 page not found, no data files", "remove", false, 200, real({ exitCode: 3, pageRun: "missing", dataFiles: [], removes: [PAGE] }), { text: /^The page was not in the bucket .*Nothing was deleted/, ok: true, row: "hidden" }],
    ["P8 page not found, data files: kept, with their command", "remove", false, 200, real({ exitCode: 3, pageRun: "missing" }), { text: /^The page was not in the bucket .*Its data files were left in the bucket/, ok: true, row: "none", has: [`--fjern -- ${DATA.join(" ")}`, "no published page"], lacks: [PAGE] }],
    ["P9 an answer pairing a page not found with a failed data run offers no retry", "remove", false, 200, real({ exitCode: 3, pageRun: "missing", dataRun: "failed", dataFilesExitCode: 3, retryDataFiles: true }), { text: /left in the bucket/, ok: true, row: "none", lacks: [PAGE] }],
    // Page run left the page possibly published: no retry, ever, whatever the answer claims.
    ["P13 page exit 3 other (logged out)", "remove", false, 200, real({ exitCode: 3, pageRun: "failed", dataRun: "failed", retryDataFiles: true }), { text: /^The page delete failed .*may still be published/, ok: false, row: "none", has: [`--fjern -- ${PAGE} ${DATA.join(" ")}`] }],
    ["P14 page exit 1", "remove", false, 200, real({ exitCode: 1, pageRun: "error" }), { text: /refused the path or failed \(exit 1\)/, ok: false, row: "none", has: ["--fjern --"] }],
    ["P15 page exit 2", "remove", false, 200, real({ exitCode: 2, pageRun: "error" }), { text: /^Usage or environment error \(exit 2\)/, ok: false, row: "none" }],
    ["P16 page another code", "remove", false, 200, real({ exitCode: 9, pageRun: "error" }), { text: /exited with code 9\. The page may still be published/, ok: false, row: "none" }],
    ["P18 an answer that claims a retry without the page gone is not trusted", "remove", false, 504, { error: "The script did not return in time and was stopped.", pageRun: "timeout", dataRun: "timeout", retryDataFiles: true, dataFiles: DATA }, { text: /did not return in time/, ok: false, row: "hidden" }],
    ["P17 page run timed out (504)", "remove", false, 504, { error: "The script did not return in time and was stopped.", reason: "timeout", pageRun: "timeout", retryDataFiles: false, dataFiles: DATA }, { text: /did not return in time/, ok: false, row: "hidden" }],
    // Retry data files.
    ["T1 retry deleted all", "remove-data", false, 200, retry({ dataRun: "deleted", dataFilesExitCode: 0 }), { text: /^Removed the data files/, ok: true, row: "hidden" }],
    ["T2 retry not-found only", "remove-data", false, 200, retry({ exitCode: 3, dataRun: "missing", dataFilesExitCode: 3 }), { text: /^The data files are gone from the bucket/, ok: true, row: "hidden" }],
    ["T3 retry exit 3 other", "remove-data", false, 200, retry({ exitCode: 3, dataRun: "failed", dataFilesExitCode: 3, retryDataFiles: true }), { text: /^At least one data-file delete failed with an error muninn does not read/, ok: false, row: "retry", has: DATA, lacks: [PAGE, "others were deleted"] }],
    ["T4 retry other code", "remove-data", false, 200, retry({ exitCode: 2, dataRun: "error", dataFilesExitCode: 2 }), { text: /exited with code 2/, ok: false, row: "none", has: [`--fjern -- ${DATA.join(" ")}`], lacks: [PAGE] }],
    ["T5 retry timed out (504)", "remove-data", false, 504, { error: "The data-file delete did not return in time", reason: "timeout", dataFilesOnly: true, dataRun: "timeout", retryDataFiles: true, dataFiles: DATA }, { text: /did not return in time/, ok: false, row: "retry", lacks: [PAGE] }],
    ["T6 retry refused, page not proven gone (409)", "remove-data", false, 409, { error: "This instance has no recent record that the page is gone", reason: "page-not-gone" }, { text: /no recent record/, ok: false, row: "hidden" }],
    ["T7 a retry answer the route marks not retryable", "remove-data", false, 200, retry({ exitCode: 3, dataRun: "failed", retryDataFiles: false }), { text: /failed/, ok: false, row: "hidden" }],
    ["E1 no JSON", "remove", false, 500, null, { text: /^Request failed \(HTTP 500\)/, ok: false, row: "hidden" }],
  ];
  test.each(ROWS)("%s", (_name, action, dryRun, status, data, want) => {
    const view = felles.fellesRemoveView(action, dryRun, status, data as never, cmd);
    expect(view.text).toMatch(want.text);
    expect(view.ok).toBe(want.ok);
    expect(view.row.hidden ? "hidden" : (view.row as { button: string }).button).toBe(want.row);
    const html = view.row.hidden ? "" : (view.row as { html: string }).html;
    for (const s of want.has ?? []) expect(html).toContain(s);
    for (const s of want.lacks ?? []) expect(html).not.toContain(s);
  });
});

describe("the retry's request and the confirm row's paint", () => {
  test("Retry data files posts a real remove with dataFilesOnly, never a remove-data action", () => {
    const page = { wiki: "kode", relPath: "plans/case.mdx" };
    expect(felles.fellesRunBody(page, "remove-data", false, true)).toEqual({ ...page, dryRun: false, allowIdent: true, action: "remove", dataFilesOnly: true });
    expect(felles.fellesRunBody(page, "remove", false, true)).toEqual({ ...page, dryRun: false, allowIdent: true, action: "remove" });
    expect(felles.fellesRunBody(page, "publish", true, false)).toEqual({ ...page, dryRun: true, allowIdent: false, action: "publish" });
  });

  test("a retry row shows the row and the retry button only; a hidden row hides the row", () => {
    const els = () => ({ row: { hidden: true }, text: { innerHTML: "" }, confirm: { hidden: false }, retry: { hidden: true } });
    const a = els();
    felles.paintConfirmRow({ hidden: false, button: "retry", html: "R" }, a);
    expect(a).toEqual({ row: { hidden: false }, text: { innerHTML: "R" }, confirm: { hidden: true }, retry: { hidden: false } });
    const b = els();
    felles.paintConfirmRow({ hidden: false, button: "confirm", html: "C" }, b);
    expect([b.row.hidden, b.confirm.hidden, b.retry.hidden]).toEqual([false, false, true]);
    const c = els();
    felles.paintConfirmRow({ hidden: false, button: "none", html: "N" }, c);
    expect([c.row.hidden, c.confirm.hidden, c.retry.hidden]).toEqual([false, true, true]);
    const d = { ...els(), row: { hidden: false } };
    felles.paintConfirmRow({ hidden: true }, d);
    expect(d.row.hidden).toBe(true);
  });

  test("the retry text lists the data files and says a gone file counts as deleted", () => {
    expect(fellesDialogHtml("plans/a.mdx")).toContain('<button type="button" class="danger" data-felles="remove-data" hidden>Retry data files</button>');
    const html = felles.fellesDataRetryHtml(["plans/<x>.csv"]);
    expect(html).toContain("<code>plans/&lt;x&gt;.csv</code>");
    expect(html).toMatch(/already gone counts as deleted/);
  });

  test("the terminal command can name the data files after the page", () => {
    expect(felles.fellesRemoveCommand({ bin: "/b.ts", relPath: "p/a.mdx", alsoRemove: ["p/x y.csv"] })).toBe("bun --no-env-file /b.ts --fjern -- p/a.mdx 'p/x y.csv'");
  });
});

test("exit 1 claims nothing the code cannot know", () => {
  // Exit 1 is the scanner's refusal AND any crash of the script (an uncaught
  // exception, a missing module), which can land after an upload succeeded.
  const line = fellesOutcomeLine(1, false).text;
  expect(line).not.toMatch(/nothing was uploaded/);
  expect(line).toMatch(/failed/);
});

test("the copied command carries the bucket the button would use", () => {
  expect(fellesPublishCommand({ bin: "/b.ts", root: "/w", relPath: "a.md", allowIdent: true, bucket: "b-1" })).toBe(
    "FELLES_WIKI_BUCKET=b-1 bun --no-env-file /b.ts --tillat-ident /w a.md",
  );
});

test("the bucket prefix is shell-quoted", () => {
  expect(fellesPublishCommand({ bin: "/b.ts", root: "/w", relPath: "a.md", allowIdent: false, bucket: "x;rm -rf ~" })).toBe(
    "FELLES_WIKI_BUCKET='x;rm -rf ~' bun --no-env-file /b.ts /w a.md",
  );
});

test("a dash-led relPath is copied as a path", () => {
  expect(fellesPublishCommand({ bin: "/b.ts", root: "/w", relPath: "-x.md", allowIdent: false })).toBe(
    "bun --no-env-file /b.ts /w ./-x.md",
  );
});

test("output is escaped, and https addresses become links", () => {
  expect(fellesOutputHtml("<b> https://x.nav.no/wiki?wiki=a&relPath=b")).toBe(
    '&lt;b&gt; <a href="https://x.nav.no/wiki?wiki=a&amp;relPath=b" target="_blank" rel="noopener">https://x.nav.no/wiki?wiki=a&amp;relPath=b</a>',
  );
});

test("the button carries its page's relPath, escaped", () => {
  expect(fellesBtnHtml('a"b.md')).toContain('data-felles-relpath="a&quot;b.md"');
});

describe("the sync status", () => {
  const status: FellesSyncStatus = {
    bucket: "melosys-felles",
    changed: 1,
    pages: [
      { relPath: "plans/a<b>.mdx", masked: false, state: "changed", changedFiles: ["plans/a<b>.mdx", "plans/a.data.json"], refusals: [], warnings: ["w<1>"] },
      { relPath: "b.md", masked: false, state: "unchanged", changedFiles: [], refusals: [], warnings: [] },
      { relPath: "[skjult sti: 1 funn]", masked: true, state: "refused", changedFiles: [], refusals: ["fødselsnummer"], warnings: [] },
      { relPath: "gone.md", masked: false, state: "missing-locally", changedFiles: [], refusals: [], warnings: [] },
    ],
    orphans: [{ path: "old.data.json", masked: false }],
    maybeOrphans: [],
  };
  const href = (rel: string) => "/wiki?relPath=" + encodeURIComponent(rel);

  test("the chip names its state; loading is inert but keeps focus", () => {
    expect(fellesSyncChipHtml({ kind: "ok", changed: 3 })).toContain(">Felles: 3 changed<");
    // aria-disabled, not disabled: a disabled button drops keyboard focus to BODY.
    expect(fellesSyncChipHtml({ kind: "loading" })).toMatch(/data-state="loading" aria-disabled="true"/);
    expect(fellesSyncChipHtml({ kind: "loading" })).not.toMatch(/ disabled/);
    const err = fellesSyncChipHtml({ kind: "error", message: 'gcloud <"x">' });
    expect(err).toContain(">Felles: status failed<");
    expect(err).toContain("gcloud &lt;&quot;x&quot;&gt;");
  });

  test("changed pages link to the reader with their files; masked paths stay text", () => {
    const html = fellesSyncListHtml(status, href);
    expect(html).toContain(`<a href="/wiki?relPath=plans%2Fa%3Cb%3E.mdx" data-felles-open="plans/a&lt;b&gt;.mdx">plans/a&lt;b&gt;.mdx</a>`);
    expect(html).toContain("<li>plans/a.data.json</li>");
    expect(html).toContain("w&lt;1&gt;");
    expect(html).toContain(`<span class="wiki-felles-masked">[skjult sti: 1 funn]</span>`);
    expect(html).not.toContain('data-felles-open="[skjult');
    expect(html).toContain("<li>fødselsnummer</li>");
    expect(html).toContain("Missing locally (1)");
    expect(html).toContain("Orphans in the bucket (1)");
    expect(html).not.toContain('data-felles-open="b.md"');
  });

  test("a changed page does not list its own path among its files", () => {
    const html = fellesSyncListHtml(status, href);
    expect(html).not.toContain("<li>plans/a&lt;b&gt;.mdx</li>");
    expect(html).toContain('<ul class="wiki-felles-files"><li class="wiki-felles-self">page changed</li><li>plans/a.data.json</li></ul>');
    // Only a data file changed: no page line.
    const dataOnly = fellesSyncListHtml(
      { ...status, pages: [{ ...status.pages[0]!, changedFiles: ["plans/a.data.json"] }] },
      href,
    );
    expect(dataOnly).not.toContain("page changed");
    expect(dataOnly).toContain('<ul class="wiki-felles-files"><li>plans/a.data.json</li></ul>');
  });

  test("a page's own path is recognised in NFC when readdir answers NFD", () => {
    // The script names files in NFC; the page's relPath can arrive in NFD.
    const nfd = "plans/på.mdx";
    const html = fellesSyncListHtml(
      { ...status, pages: [{ ...status.pages[0]!, relPath: nfd, changedFiles: [nfd.normalize("NFC"), "plans/x.csv"] }] },
      href,
    );
    expect(html).toContain('<ul class="wiki-felles-files"><li class="wiki-felles-self">page changed</li><li>plans/x.csv</li></ul>');
  });

  test("possible orphans get their own section, with no removal hint", () => {
    const html = fellesSyncListHtml({ ...status, orphans: [], maybeOrphans: [{ path: "maybe.csv", masked: false }] }, href);
    expect(html).toContain('<section class="wiki-felles-section maybe-orphans">');
    expect(html).toContain("Possibly orphaned in the bucket (1)");
    expect(html).toContain("<li><span class=\"wiki-felles-masked\">maybe.csv</span></li>");
    expect(html).toMatch(/the published copy of such a page may still name them/);
    const section = html.slice(html.indexOf("maybe-orphans"));
    expect(section).not.toContain("--fjern");
  });

  test("the dialog offers Publish changed with its count, disabled at zero", () => {
    expect(fellesSyncDialogHtml(status, href)).toContain('data-felles="sync">Publish changed (1)</button>');
    expect(fellesSyncDialogHtml({ ...status, changed: 0, pages: [] }, href)).toContain(
      'data-felles="sync" disabled>Publish changed (0)</button>',
    );
  });

  test("the state map matches pages in NFC and skips masked paths", () => {
    const nfc = "plans/p\u00E5.md";
    const map = fellesStateMap({ ...status, pages: [{ ...status.pages[0]!, relPath: nfc }, status.pages[2]!] });
    expect(map.get("plans/pa\u030A.md".normalize("NFC"))).toBe("changed");
    expect(map.size).toBe(1);
  });

  test("each sync exit code has its own line", () => {
    expect(fellesSyncOutcomeLine(0, true)).toEqual({ text: "Dry run passed — nothing was uploaded.", ok: true });
    expect(fellesSyncOutcomeLine(0, false).text).toMatch(/^Published the changed pages/);
    expect(fellesSyncOutcomeLine(1, true).text).toMatch(/Nothing was uploaded/);
    expect(fellesSyncOutcomeLine(3, false).ok).toBe(false);
    expect(fellesSyncOutcomeLine(9, false).text).toBe("The script exited with code 9.");
  });

  test("a refused page gets its own marker, not the stale one", () => {
    const html = fellesBtnHtml("a.md", "refused");
    expect(html).toContain(`class="wiki-bc-share ${felles.FELLES_REFUSED_CLASS}"`);
    expect(html).not.toContain(FELLES_STALE_CLASS);
    expect(html).toContain('title="Local copy is refused by the scanner — the published copy is older"');
  });

  describe("the sync outcome reads the run and the status after it", () => {
    const after = (changed: number, refused: number): FellesSyncStatus => ({
      ...status,
      changed,
      pages: [
        ...Array.from({ length: changed }, (_, i) => ({ ...status.pages[0]!, relPath: `c${i}.md` })),
        ...Array.from({ length: refused }, (_, i) => ({ ...status.pages[2]!, relPath: `r${i}.md` })),
      ],
    });

    test("exit 1 with nothing changed afterwards and a refused page is not an error", () => {
      expect(fellesSyncRunOutcome(1, false, after(0, 1))).toEqual({
        text: "All changed pages were published. 1 refused page(s) were not — see Refused.",
        ok: true,
      });
    });

    /** The dry run's own summary, as `publiser-felles-wiki.ts` prints it last. */
    const drySummary = (refused: number) => `OK      c0.md\n\nOppsummering: 2 klar(e), ${refused} avvist, 0 mangler lokalt.`;

    test("a dry run's exit 1 with refused pages says what would be published", () => {
      expect(fellesSyncRunOutcome(1, true, after(2, 2), null, drySummary(2))).toEqual({
        text: "Dry run: all changed pages would be published. 2 refused page(s) would not — see Refused. Nothing was uploaded.",
        ok: true,
      });
    });

    test("genuine failures stay red", () => {
      // Still changed after a real run: something did not go up.
      expect(fellesSyncRunOutcome(1, false, after(1, 1)).ok).toBe(false);
      // Exit 1 and no refused page: the script crashed.
      expect(fellesSyncRunOutcome(1, false, after(0, 0)).ok).toBe(false);
      expect(fellesSyncRunOutcome(1, true, after(1, 0)).ok).toBe(false);
      // No fresh status to read: the exit code alone.
      expect(fellesSyncRunOutcome(1, false, null)).toEqual(fellesSyncOutcomeLine(1, false));
      for (const code of [2, 3, 9]) expect(fellesSyncRunOutcome(code, false, after(0, 1)).ok).toBe(false);
      expect(fellesSyncRunOutcome(0, false, after(0, 1))).toEqual(fellesSyncOutcomeLine(0, false));
    });

    // Fix round 1: the real wiki keeps a refused page, so the status before and
    // after a crashed dry run both hold one. Only the run's own summary, which a
    // crash never prints, says the refusal is what exited 1.
    test("a dry run's exit 1 reads ok only when its summary reports a refusal", () => {
      const crash = "error: Cannot read properties of undefined\n    at publiser (publiser-felles-wiki.ts:1500:3)";
      expect(fellesSyncRunOutcome(1, true, after(2, 1), after(2, 1), crash)).toEqual(fellesSyncOutcomeLine(1, true));
      expect(fellesSyncRunOutcome(1, true, after(2, 1), after(2, 1))).toEqual(fellesSyncOutcomeLine(1, true));
      // A summary that reports no refusal does not explain the 1 either.
      expect(fellesSyncRunOutcome(1, true, after(2, 1), after(2, 1), drySummary(0))).toEqual(fellesSyncOutcomeLine(1, true));
      // The status-only form of the summary (nothing changed) counts too.
      expect(fellesSyncRunOutcome(1, true, after(0, 1), null, "\nOppsummering: 0 klar(e), 1 avvist, 0 mangler lokalt.").ok).toBe(true);
      expect(fellesSyncRunOutcome(1, true, after(2, 1), after(2, 1), drySummary(1)).ok).toBe(true);
    });

    // Fix round 2: `--synk` prints the STATUS summary first (`skrivStatus`,
    // `Oppsummering: N uendret, N endret, N avvist, …`), then syncs. A crash
    // after that line carries an «N avvist» but no dry-run summary, so only the
    // `klar(e)` shape may explain the exit 1.
    test("a crash after the status summary is not read as the refusal", () => {
      const crashAfterStatus = [
        "Status for gs://felles: 3 fulgt(e) side(r)",
        "ENDRET         plans/c0.md",
        "    endret: plans/c0.md",
        "ENDRET         plans/c1.md",
        "    endret: plans/c1.md",
        "AVVIST         plans/r.mdx",
        "    avslag: NAVident på linje 3",
        "",
        "Oppsummering: 0 uendret, 2 endret, 1 avvist, 0 mangler lokalt, 0 foreldreløs(e) datafil(er).",
        "",
        "Synker 2 endret(e) side(r):",
        "",
        "error: Cannot read properties of undefined",
        "    at publiser (publiser-felles-wiki.ts:1500:3)",
      ].join("\n");
      expect(felles.fellesDrySummaryRefusals(crashAfterStatus)).toBeNull();
      expect(fellesSyncRunOutcome(1, true, after(2, 1), after(2, 1), crashAfterStatus)).toEqual(fellesSyncOutcomeLine(1, true));
    });

    // Finding 79: a failed real run claims pages were published only when the
    // status after it shows fewer changed pages than the run started from.
    test("a failed real run says pages went up only when changed dropped", () => {
      expect(fellesSyncOutcomeLine(1, false).text).not.toContain("published");
      expect(fellesSyncRunOutcome(1, false, after(2, 1), after(2, 1))).toEqual(fellesSyncOutcomeLine(1, false));
      expect(fellesSyncRunOutcome(1, false, after(1, 1), null)).toEqual(fellesSyncOutcomeLine(1, false));
      expect(fellesSyncRunOutcome(1, false, after(1, 1), after(3, 1))).toEqual({
        text: "A page is refused by the scanner, or the script failed. 2 changed page(s) were published. See the output.",
        ok: false,
      });
      // A dry run uploads nothing, so a drop there is no claim either.
      expect(fellesSyncRunOutcome(1, true, after(1, 0), after(3, 0))).toEqual(fellesSyncOutcomeLine(1, true));
    });
  });

  test("only a real run the route refused before spawning skips the status refresh", () => {
    const could = (dryRun: boolean, status: number | null) => felles.fellesRunCouldChangeBucket(dryRun, status);
    // The route's refusals before any spawn (its header lists them).
    for (const s of [400, 403, 404, 409, 415, 501]) expect(could(false, s)).toBe(false);
    // Ran, timed out, or an outcome the client cannot read: refresh.
    for (const s of [200, 500, 502, 503, 504]) expect(could(false, s)).toBe(true);
    expect(could(false, null)).toBe(true);
    // A dry run changes nothing, whatever came back.
    for (const s of [200, 504, null]) expect(could(true, s)).toBe(false);
  });

  test("a stale button carries the marker class and says why", () => {
    expect(fellesBtnHtml("a.md", "stale")).toContain(`class="wiki-bc-share ${FELLES_STALE_CLASS}"`);
    expect(fellesBtnHtml("a.md", "stale")).toContain(`title="${FELLES_STALE_TITLE}"`);
    expect(fellesBtnHtml("a.md")).not.toContain(FELLES_STALE_CLASS);
  });
});

// Architecture review 2026-10, finding 80: "Missing locally" listed published
// pages with no way to remove them. Read off the namespace, so a missing export
// fails these tests alone.
describe("finding 80 — a page missing locally carries its remove command", () => {
  const removeCmd = (o: { bin: string; relPath: string; bucket?: string }) => felles.fellesRemoveCommand(o);
  const bin = "/n/muninn-nais/scripts/publiser-felles-wiki.ts";

  test("the command is --fjern -- <relPath>, NFC, quoted, with no --ja and no ./", () => {
    expect(removeCmd({ bin, relPath: "plans/gone.mdx" })).toBe(`bun --no-env-file ${bin} --fjern -- plans/gone.mdx`);
    const nfd = "plans/på.mdx".normalize("NFD");
    expect(removeCmd({ bin, relPath: nfd })).toBe(`bun --no-env-file ${bin} --fjern -- '${"plans/på.mdx".normalize("NFC")}'`);
    expect(removeCmd({ bin, relPath: "it's.md" })).toBe(`bun --no-env-file ${bin} --fjern -- 'it'\\''s.md'`);
    expect(removeCmd({ bin, relPath: "--x.md" })).toBe(`bun --no-env-file ${bin} --fjern -- --x.md`);
    expect(removeCmd({ bin: "/a b/p.ts", relPath: "x y.md" })).toBe("bun --no-env-file '/a b/p.ts' --fjern -- 'x y.md'");
    expect(removeCmd({ bin, relPath: "a.md" })).not.toContain("--ja");
  });

  test("the bucket muninn targets is prefixed, as on ⧉ Copy command", () => {
    expect(removeCmd({ bin, relPath: "a.md", bucket: "melosys-felles" })).toBe(
      `FELLES_WIKI_BUCKET=melosys-felles bun --no-env-file ${bin} --fjern -- a.md`,
    );
  });

  const status: FellesSyncStatus = {
    bucket: "b",
    changed: 0,
    pages: [
      { relPath: "gone<x>.md", masked: false, state: "missing-locally", changedFiles: [], refusals: [], warnings: [] },
      { relPath: "[skjult sti: 1 funn]", masked: true, state: "missing-locally", changedFiles: [], refusals: [], warnings: [] },
    ],
    orphans: [],
    maybeOrphans: [],
  };
  const href = (rel: string) => "/wiki?relPath=" + rel;
  const cmdFor = (rel: string) => removeCmd({ bin, relPath: rel });

  test("an unmasked missing page shows its command and a copy button; a masked one shows neither", () => {
    const html = fellesSyncListHtml(status, href, cmdFor);
    expect(html).toContain(`<code>bun --no-env-file ${bin} --fjern -- &#39;gone&lt;x&gt;.md&#39;</code>`);
    expect(html).toContain('data-felles="copy-remove" data-felles-path="gone&lt;x&gt;.md"');
    expect(html.match(/data-felles="copy-remove"/g)?.length).toBe(1);
    expect(html.match(/--fjern/g)?.length).toBe(1);
    expect(html).toContain(
      '<p class="wiki-felles-hint">In the bucket, but not in this wiki. To remove one from the bucket, run its command in a terminal; the script asks before it deletes. A renamed page is tracked under its new name only after it is published once.</p>',
    );
  });

  test("without a command builder the section is unchanged", () => {
    const html = fellesSyncListHtml(status, href);
    expect(html).not.toContain("copy-remove");
    expect(html).not.toContain("--fjern");
    expect(html).toContain('<p class="wiki-felles-hint">In the bucket, but not in this wiki.</p>');
  });

  test("the dialog passes the builder through", () => {
    expect(fellesSyncDialogHtml(status, href, cmdFor)).toContain('data-felles="copy-remove"');
  });
});

// Batch H fix round 1, P: a copied line run from a muninn checkout would load
// that checkout's `.env`, whose variables can override the bucket or the
// credentials the line means. The route spawns with `--no-env-file`; so do these.
test("both copyable command lines tell bun not to load a .env", () => {
  const pub = fellesPublishCommand({ bin: "/b.ts", root: "/w", relPath: "a.md", allowIdent: false, bucket: "b-1" });
  const rem = felles.fellesRemoveCommand({ bin: "/b.ts", relPath: "a.md", bucket: "b-1" });
  for (const line of [pub, rem]) expect(line.split(" ").slice(1, 3)).toEqual(["bun", "--no-env-file"]);
});
