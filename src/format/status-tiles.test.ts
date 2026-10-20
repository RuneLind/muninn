import { describe, expect, test } from "bun:test";
import { COMPONENT_ATTRS, readStatusRowsView } from "./component-spec.ts";
import {
  normalizeTileLabel,
  parseStatusTones,
  STATUS_TILE_FIRST_MAX,
  statusRowBlocks,
  statusTileTone,
  statusToneWarnings,
} from "./report-top.ts";
import { parseBlocks } from "./markdown-ast.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import { checkPageText } from "../wiki/lint.ts";
import { PEEK_SKIP, PEEK_STRIP_SELECTOR } from "../dashboard/views/components/wiki-ref-links.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";

// `<StatusRows view="tiles" tones="…">` (MDX visual components PR 2): the
// spec attributes, the reader-only tile render, the tones and the two lint
// warnings. Synthetic fixtures only.

const ROWS = ["- **Score:** 42 · up from 30", "- **Gap:** 3 points · to the leader", "- **Next:** ship it"];
const block = (attrs: string, rows = ROWS) => ["<StatusRows" + attrs + ">", "", ...rows, "", "</StatusRows>"].join("\n");
const tags = (html: string) => html.replace(/<[^>]*>/g, "");

describe("spec: view and tones", () => {
  test("StatusRows lists view and tones", () => {
    expect(COMPONENT_ATTRS.StatusRows).toEqual(["view", "tones"]);
  });
  test("view parses tiles and rows, defaults to rows, and falls back on anything else", () => {
    expect(readStatusRowsView("tiles")).toEqual({ value: "tiles", fellBack: false });
    expect(readStatusRowsView("rows")).toEqual({ value: "rows", fellBack: false });
    expect(readStatusRowsView(undefined)).toEqual({ value: "rows", fellBack: false });
    expect(readStatusRowsView("")).toEqual({ value: "rows", fellBack: false });
    expect(readStatusRowsView("grid")).toEqual({ value: "rows", fellBack: true });
    expect(readStatusRowsView("Tiles")).toEqual({ value: "rows", fellBack: true });
  });
  test("statusRowBlocks carries each block's attributes", () => {
    const blocks = statusRowBlocks(parseBlocks(block(' view="tiles" tones="Gap=warn"')));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.attrs).toEqual({ view: "tiles", tones: "Gap=warn" });
    expect(blocks[0]!.rows.map((r) => r.label)).toEqual(["Score", "Gap", "Next"]);
  });
});

describe("tones", () => {
  test("parse: label=tone entries, any case, last wins, bad entries kept apart", () => {
    const t = parseStatusTones(" Gap = WARN ; Next=good; Score=red; =info; loose; Gap=info ");
    expect([...t.rows]).toEqual([
      ["gap", "info"],
      ["next", "good"],
    ]);
    expect(t.labels).toEqual(["Gap", "Next", "Gap"]);
    expect(t.bad).toEqual(["Score=red", "=info", "loose"]);
  });
  test("a label may hold `=`: the tone is read after the last one", () => {
    expect([...parseStatusTones("a=b=muted").rows]).toEqual([["a=b", "muted"]]);
  });
  test("labels match past emphasis, backticks, case and Unicode form", () => {
    expect(normalizeTileLabel("**Gap**")).toBe("gap");
    expect(normalizeTileLabel(" `P95` ")).toBe("p95");
    expect(normalizeTileLabel("Café")).toBe(normalizeTileLabel("Café"));
    const t = parseStatusTones("gap=warn");
    expect(statusTileTone(t, "Gap")).toBe("warn");
    expect(statusTileTone(t, null)).toBeUndefined();
    expect(statusTileTone(t, "Score")).toBeUndefined();
  });
  test("warnings: an unread entry, a row named twice, a label with no row", () => {
    const w = statusToneWarnings(parseStatusTones("Gap=warn; gap=good; Nope=info; Bad=red"), ["Score", "Gap", null]);
    expect(w).toHaveLength(3);
    expect(w[0]).toContain("Bad=red");
    expect(w[1]).toBe("tones names a row more than once: gap");
    expect(w[2]).toBe("tones names no row: Nope");
    expect(statusToneWarnings(parseStatusTones("Gap=warn"), ["Gap"])).toEqual([]);
  });
});

describe("render: tiles on the reader's page render only", () => {
  const md = block(' view="tiles" tones="Gap=warn;Next=good"');
  const plain = block("");

  test("without views the tile block is byte-identical to the plain rows block", () => {
    expect(formatWebHtml(md)).toBe(formatWebHtml(plain));
    expect(formatWebHtml(md, { reader: true })).toBe(formatWebHtml(plain, { reader: true }));
    expect(renderWikiHtml(md, () => undefined)).toBe(renderWikiHtml(plain, () => undefined));
  });
  test("view=rows and an unknown view render rows under views", () => {
    const rows = formatWebHtml(plain, { views: true });
    expect(formatWebHtml(block(' view="rows" tones="Gap=warn"'), { views: true })).toBe(rows);
    expect(formatWebHtml(block(' view="grid"'), { views: true })).toBe(rows);
    expect(rows).not.toContain("sr-tiles");
  });
  test("with views: sr-tiles on the section, the first part in sr-big, the tone on its row", () => {
    const html = formatWebHtml(md, { views: true });
    expect(html).toContain('<section class="status-rows sr-tiles">');
    expect(html.match(/class="sr-big"/g)).toHaveLength(3);
    expect(html).toContain('<span class="sr-big">42</span><span class="sr-sep"> · </span>up from 30');
    expect(html).toContain('<div class="sr-row sr-tone-warn"><span class="sr-label">');
    expect(html).toContain('<div class="sr-row sr-tone-good"><span class="sr-label">');
    // Score has no tone.
    expect(html.match(/class="sr-row"/g)).toHaveLength(1);
  });
  test("a tile keeps its state pills", () => {
    const html = formatWebHtml(block(' view="tiles"', ["- **Release:** in prod · since Monday"]), { views: true, language: "en" });
    expect(html).toContain('<span class="sr-big"><span class="sr-state sr-good">in prod</span></span>');
  });
  test("renderWikiHtml draws tiles only with views, as GET /api/wiki/page passes it", () => {
    expect(renderWikiHtml(md, () => undefined, { views: true })).toContain("sr-tiles");
    expect(renderWikiHtml(md, () => undefined)).not.toContain("sr-tiles");
  });
  test("other surfaces print the rows as today", () => {
    expect(formatTelegramHtml(md)).toBe(formatTelegramHtml(plain));
    expect(formatSlackMrkdwn(md)).toBe(formatSlackMrkdwn(plain));
    expect(formatEmailHtml(md)).toBe(formatEmailHtml(plain));
    for (const out of [formatTelegramHtml(md), formatSlackMrkdwn(md), formatEmailHtml(md)]) {
      expect(out).toContain("42 · up from 30");
      expect(out).not.toContain("sr-");
    }
  });
});

describe("peek and Explain read the source row", () => {
  const md = block(' view="tiles" tones="Gap=warn"');
  test("a tile's text is the rows view's text, separator included", () => {
    expect(tags(formatWebHtml(md, { views: true }))).toBe(tags(formatWebHtml(block(""), { views: true })));
  });
  test("tiles add no reader-only or peek-stripped markup", () => {
    const html = formatWebHtml(md, { views: true });
    expect(html).not.toContain(READER_ONLY_ATTR);
    for (const cls of ["sr-tiles", "sr-big", "sr-tone-warn", "status-rows"]) {
      expect(PEEK_STRIP_SELECTOR.split(", ")).not.toContain(`.${cls}`);
      expect(PEEK_SKIP).not.toContain(cls);
    }
  });
});

describe("lint: status-tones and status-tile-long via checkPageText", () => {
  const page = (body: string) => ["---", "title: P", "type: plan", "---", "", "# P", "", body, ""].join("\n");
  const run = (body: string, check: string) => checkPageText({ relPath: "plans/p.mdx" }, page(body), []).filter((f) => f.check === check);

  test("a tones label with no row warns, on the block's line", () => {
    const f = run(block(' view="tiles" tones="Gap=warn;Missing=good"'), "status-tones");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toBe("<StatusRows> tones names no row: Missing");
    expect(f[0]!.line).toBe(8);
  });
  test("an unusable tone warns in rows view too", () => {
    expect(run(block(' tones="Gap=red"'), "status-tones")).toHaveLength(1);
    expect(run(block(' view="tiles" tones="Gap=warn;Next=good"'), "status-tones")).toEqual([]);
  });
  test("a first part over the max warns in tile view only, at the boundary", () => {
    const at = "x".repeat(STATUS_TILE_FIRST_MAX);
    const over = "x".repeat(STATUS_TILE_FIRST_MAX + 1);
    const rows = [`- **A:** ${at} · note`, `- **B:** ${over} · note`, `- **C:** **${at}** · emphasis is not counted`];
    const f = run(block(' view="tiles"', rows), "status-tile-long");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain(`is ${STATUS_TILE_FIRST_MAX + 1} chars (max ${STATUS_TILE_FIRST_MAX})`);
    expect(f[0]!.line).toBe(11);
    expect(run(block("", rows), "status-tile-long")).toEqual([]);
  });
});
