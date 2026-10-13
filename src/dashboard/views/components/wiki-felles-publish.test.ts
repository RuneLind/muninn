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
      "bun /n/muninn-nais/scripts/publiser-felles-wiki.ts --tillat-ident /Users/rune/source/nav/melosys-kode-wiki plans/2026-09-29-vedtaksmetadata-fagavklaring.mdx",
    );
  });

  test("quotes what a shell would split", () => {
    expect(fellesPublishCommand({ bin: "/b.ts", root: "/w w", relPath: "x/it's.md", allowIdent: false, dryRun: true })).toBe(
      "bun /b.ts --dry-run '/w w' 'x/it'\\''s.md'",
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

test("remove has its own line per exit code", () => {
  // The script's dry run never asks the bucket, so the line must not claim the object exists.
  expect(fellesOutcomeLine(0, true, "remove").text).toMatch(/does not check/);
  expect(fellesOutcomeLine(1, false, "remove").text).toMatch(/nothing was removed/);
  expect(fellesOutcomeLine(1, false, "remove").text).not.toMatch(/may/);
  expect(fellesOutcomeLine(3, false, "remove").text).toMatch(/gcloud needs a login/);
  expect(fellesOutcomeLine(0, false, "remove").text).toMatch(/^Removed/);
  for (const code of [1, 2, 3, 9]) expect(fellesOutcomeLine(code, false, "remove").ok).toBe(false);
  // Publish copy must never describe a delete.
  for (const code of [0, 1, 2, 3]) expect(fellesOutcomeLine(code, false, "remove").text).not.toMatch(/upload|Published/);
});

test("the dialog's remove confirmation starts hidden", () => {
  const html = fellesDialogHtml("plans/a.mdx");
  expect(html).toContain('data-felles="remove"');
  expect(html).toMatch(/<div class="wiki-felles-confirm" hidden>/);
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
    "FELLES_WIKI_BUCKET=b-1 bun /b.ts --tillat-ident /w a.md",
  );
});

test("the bucket prefix is shell-quoted", () => {
  expect(fellesPublishCommand({ bin: "/b.ts", root: "/w", relPath: "a.md", allowIdent: false, bucket: "x;rm -rf ~" })).toBe(
    "FELLES_WIKI_BUCKET='x;rm -rf ~' bun /b.ts /w a.md",
  );
});

test("a dash-led relPath is copied as a path", () => {
  expect(fellesPublishCommand({ bin: "/b.ts", root: "/w", relPath: "-x.md", allowIdent: false })).toBe(
    "bun /b.ts /w ./-x.md",
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

    test("a dry run's exit 1 with refused pages says what would be published", () => {
      expect(fellesSyncRunOutcome(1, true, after(2, 2))).toEqual({
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
