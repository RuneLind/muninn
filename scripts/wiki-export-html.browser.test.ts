/**
 * The exported file in real Chromium: layout facts happy-dom cannot compute.
 * Not in the `test` chains (it launches a browser); run it with
 * `bun test scripts/wiki-export-html.browser.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "@playwright/test";
import { buildStandaloneHtml, cleanExport, selfCheck } from "./wiki-export-html-lib.ts";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});
afterAll(async () => {
  await browser?.close();
});

const head = '<div class="wiki-article-head"><h1>T</h1></div>';
// The reader's own rules for the parts under test (stepsCss's sticky bar, the
// article table, the wiki-link underline), so the shell is tested against them.
const readerCss =
  ".wiki-article table { border-collapse: collapse; margin: 12px 0; width: 100%; }\n" +
  "section.stp > .stp-ctrl { position: sticky; top: 0; background: #fff; }\n" +
  ".wiki-link { border-bottom: 1px solid red; }";

function exported(inner: string): string {
  const cleaned = cleanExport({ headHtml: head, articleHtml: `<div class="wiki-article lens-all">${inner}</div>`, darkSvgs: [] });
  return buildStandaloneHtml({ title: "t", description: "", css: readerCss, ...cleaned, source: "w/p", date: "d" });
}

const tall = '<p style="height:1500px">filler</p>';
const wideTable = `<table><tr>${'<td style="min-width:200px">cell</td>'.repeat(5)}</tr></table>`;

describe("export layout in Chromium", () => {
  test("the Steps bar sticks to the top of the window while its block is on screen", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
    await page.setContent(exported(`${tall}<section class="stp"><div class="stp-ctrl">bar</div>${tall}</section>${tall}`));
    const top = await page.evaluate(() => {
      const s = document.querySelector("section.stp") as HTMLElement;
      window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY + 400);
      return Math.round((document.querySelector(".stp-ctrl") as HTMLElement).getBoundingClientRect().top);
    });
    expect(top).toBe(0);
    await page.close();
  });

  test("at 390 px a wide table scrolls in its own box and the page does not scroll sideways", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.setContent(exported(`<p>before</p>${wideTable}<p>after</p>`));
    const r = await page.evaluate(() => {
      const table = document.querySelector("table") as HTMLElement;
      const box = table.parentElement as HTMLElement;
      return {
        page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        boxScrolls: getComputedStyle(box).overflowX === "auto" && box.scrollWidth >= table.offsetWidth && box.clientWidth < table.offsetWidth,
      };
    });
    expect(r.page[0]).toBe(r.page[1]);
    expect(r.boxScrolls).toBe(true);
    await page.close();
  });

  test("the self-check passes a cleaned export whose SVGs hold styles and reader links, and quotes in prose", async () => {
    const page = await browser.newPage();
    await page.setContent(
      exported(
        '<svg class="sm"><style>.sm-node>rect{fill:red}</style><a class="sm-node" href="/wiki?wiki=mimir&amp;relPath=x.md"><rect/></a></svg>' +
          '<figure class="embed"><iframe title="E" src="/api/wiki/html?relPath=x.html"></iframe></figure><p>quotes src="http://localhost:3010/x"</p>',
      ),
    );
    expect(await page.evaluate<string[]>(`(${selfCheck.toString()})(document)`)).toEqual([]);
    await page.close();
  });

  test("a dead link loses the reader's link underline, border included", async () => {
    const page = await browser.newPage();
    await page.setContent(exported('<p><a class="wiki-link" href="/wiki?wiki=mimir&amp;relPath=x.md">x</a></p>'));
    const border = await page.evaluate(() => getComputedStyle(document.querySelector("a.wiki-link") as Element).borderBottomWidth);
    expect(border).toBe("0px");
    await page.close();
  });
});
