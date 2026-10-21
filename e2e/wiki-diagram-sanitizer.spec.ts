/**
 * The `<Diagram>` picture over its whole input space, parsed by Chromium.
 *
 * The sanitizer (`src/wiki/diagram-svg.ts`) and the picture's parking in
 * `src/wiki/render.ts` are correct only if the string the browser parses means
 * what the sanitizer believes it wrote. A unit test can only re-read the string
 * with a model of HTML; this spec asks the real parser. Every case of
 * `src/test/diagram-svg-space.ts` (attribute values in every character-
 * reference form, every element in every parent position, text in every
 * reference form, NUL tokens in every page position, a seeded soup) is
 * rendered by the reader's `renderWikiHtml` under Bun
 * (`e2e/diagram-sanitizer-build.ts`), inserted the way the reader inserts a
 * page (`innerHTML` into `#articleWrap`), and checked:
 *   - each `.dgm-svg` holds one svg whose DOM equals the expected tree;
 *   - no svg sits anywhere else, and no picture is missing;
 *   - inside a picture, only kept SVG elements and allowlisted attributes;
 *     anywhere, no `data-probe` and no `on*` attribute;
 *   - the text after the Diagram block is present, outside any svg, visible;
 *   - no request leaves for any origin but the page's own (every request is
 *     routed and counted; a remote one is aborted, never fetched).
 *
 * No muninn is booted: the page is a static shell on a routed origin.
 */

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuiltCase } from "./diagram-sanitizer-build.ts";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const ORIGIN = "http://dgm-sanitizer.test";

/** Kept elements and attributes, as the parser names them (SVG camelCase). */
const KEPT_ELEMENTS = ["svg", "g", "defs", "marker", "pattern", "rect", "path", "line", "polygon", "circle", "ellipse", "text", "title", "desc"];
const KEPT_ATTRS = [
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "d", "points", "transform", "viewBox",
  "markerWidth", "markerHeight", "refX", "refY", "orient", "patternUnits", "preserveAspectRatio", "dx", "dy",
  "fill", "stroke", "marker-end", "marker-start", "stroke-dasharray", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "opacity", "fill-opacity", "stroke-opacity", "font-size", "font-weight", "font-family", "text-anchor", "dominant-baseline",
  "class", "id", "aria-labelledby", "aria-hidden", "data-node-id", "data-edge-from", "data-edge-to", "href", "xlink:href",
  "xmlns", "xmlns:xlink",
];
/** On the root only: `role` (kept there), and the size the renderer writes (`drawnSize`). */
const ROOT_EXTRA = ["role", "width", "height", "style"];

let cases: BuiltCase[] = [];
let work = "";

test.beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "muninn-dgm-space-"));
  const file = path.join(work, "cases.json");
  execFileSync("bun", ["e2e/diagram-sanitizer-build.ts", file], { cwd: REPO_ROOT, stdio: "pipe", timeout: 240_000 });
  cases = JSON.parse(readFileSync(file, "utf8")) as BuiltCase[];
});

test.afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

test("every case of the picture's input space parses in Chromium as the sanitizer intends", async ({ page }) => {
  test.setTimeout(600_000);
  expect(cases.length).toBeGreaterThan(5000);
  const offsite: string[] = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN + "/")) {
      return route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="articleWrap"></div></body></html>' });
    }
    offsite.push(url);
    return route.abort();
  });
  await page.goto(`${ORIGIN}/wiki`);

  const failures: { id: string; dim: string; reason: string; detail: string }[] = [];
  const BATCH = 60;
  for (let b = 0; b < cases.length; b += BATCH) {
    const batch = cases.slice(b, b + BATCH);
    const before = offsite.length;
    const found = await page.evaluate(
      ({ batch, keptEls, keptAttrs, rootExtra, afterMark }) => {
        const SVG_NS = "http://www.w3.org/2000/svg";
        const out: { id: string; dim: string; reason: string; detail: string }[] = [];
        const wrap = document.getElementById("articleWrap")!;
        // One fragment parse per case, as the reader does per page: a case that
        // breaks out of its picture cannot reach the next case's markup.
        wrap.replaceChildren();
        for (const c of batch) {
          const section = document.createElement("section");
          section.className = "case";
          section.innerHTML = `<div class="wiki-article">${c.html}</div>`;
          wrap.append(section);
        }
        const tree = (el: Element, root: boolean): unknown => ({
          tag: el.localName,
          attrs: Array.from(el.attributes)
            .filter((a) => !(root && ["width", "height", "style"].includes(a.name)))
            .map((a) => [a.name, a.value])
            .sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0)),
          kids: Array.from(el.childNodes).map((n) => (n.nodeType === 1 ? tree(n as Element, false) : n.nodeType === 3 ? (n as Text).data : `#node${n.nodeType}`)),
        });
        const strip = (t: { tag: string; attrs: [string, string][]; kids: unknown[] }): unknown => ({
          tag: t.tag,
          attrs: t.attrs.filter((a) => !["width", "height", "style"].includes(a[0])),
          kids: t.kids,
        });
        const sections = Array.from(wrap.children) as HTMLElement[];
        for (const [k, c] of batch.entries()) {
          const host = sections[k]!;
          const fail = (reason: string, detail: string) => out.push({ id: c.id, dim: c.dim, reason, detail: detail.slice(0, 600) });
          if (c.unreadable) fail("unreadable-output", c.unreadable);
          // Pictures: one svg per drawn slice, each the only child of its .dgm-svg, in order.
          const expected = c.pictures.filter((p) => p !== null);
          const boxes = Array.from(host.querySelectorAll(".dgm-svg"));
          if (boxes.length !== expected.length) fail("picture-count", `expected ${expected.length}, found ${boxes.length}`);
          for (const svg of Array.from(host.querySelectorAll("svg"))) {
            if (!(svg.parentElement?.classList.contains("dgm-svg") && svg.namespaceURI === SVG_NS && !svg.parentElement.closest("svg"))) {
              fail("picture-misplaced", `svg under <${svg.parentElement?.localName}> ${svg.parentElement?.outerHTML.slice(0, 200)}`);
            }
          }
          boxes.forEach((box, i) => {
            const want = expected[i];
            if (!want) return;
            if (box.childNodes.length !== 1 || box.firstElementChild?.localName !== "svg") {
              fail("picture-shape", box.innerHTML.slice(0, 300));
              return;
            }
            const got = JSON.stringify(tree(box.firstElementChild, true));
            const exp = JSON.stringify(strip(want as never));
            if (got !== exp) fail("dom-mismatch", `got ${got}\nexp ${exp}`);
          });
          // Allowlist inside pictures; no probe or handler anywhere.
          for (const el of Array.from(host.querySelectorAll("*"))) {
            const inPicture = !!el.closest(".dgm-svg svg");
            if (inPicture) {
              if (el.namespaceURI !== SVG_NS || !keptEls.includes(el.localName)) fail("element-outside-allowlist", `<${el.localName}> ns=${el.namespaceURI}`);
              const isRoot = el.localName === "svg" && el.parentElement?.classList.contains("dgm-svg");
              for (const a of Array.from(el.attributes)) {
                if (!keptAttrs.includes(a.name) && !(isRoot && rootExtra.includes(a.name))) fail("attr-outside-allowlist", `<${el.localName} ${a.name}="${a.value}">`);
              }
            }
            for (const a of Array.from(el.attributes)) {
              if (a.name === "data-probe" || a.name.startsWith("on")) fail("probe-or-handler", `<${el.localName} ${a.name}>`);
              if (!inPicture && /<svg|dgm\d+-/.test(a.value)) fail("picture-in-attribute", `<${el.localName} ${a.name}="${a.value.slice(0, 200)}">`);
            }
          }
          // The text after the block: present, outside any svg, visible.
          const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
          let after: Text | null = null;
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes(afterMark)) after = n as Text;
          if (!after) fail("after-missing", "no text node holds the after-mark");
          else if (after.parentElement!.closest("svg")) fail("after-swallowed", `after-mark inside <${after.parentElement!.localName}> in an svg`);
          else if (!after.parentElement!.checkVisibility() || after.parentElement!.getClientRects().length === 0) fail("after-hidden", after.parentElement!.localName);
          // Text the page itself wrote, shown outside any picture.
          const shown = Array.from(host.querySelectorAll(".wiki-article")).map((a) => {
            const clone = a.cloneNode(true) as Element;
            clone.querySelectorAll("svg").forEach((s) => s.remove());
            return clone.textContent ?? "";
          }).join("");
          for (const s of c.mustShow) if (!shown.includes(s)) fail("text-missing", s);
        }
        return out;
      },
      { batch, keptEls: KEPT_ELEMENTS, keptAttrs: KEPT_ATTRS, rootExtra: ROOT_EXTRA, afterMark: "AFTERMARK" },
    );
    failures.push(...found);
    // Let style, layout and paint run so any remote paint server or marker is requested.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
    if (offsite.length > before) {
      failures.push({ id: `${batch[0]!.id}..${batch[batch.length - 1]!.id}`, dim: "batch", reason: "offsite-request", detail: offsite.slice(before).join(" ") });
    }
  }

  // Name the case behind each offsite request: re-run a failing batch one case at a time.
  for (const f of failures.filter((x) => x.reason === "offsite-request")) {
    const [from, to] = f.id.split("..");
    const ids = cases.map((c) => c.id);
    for (const c of cases.slice(ids.indexOf(from!), ids.indexOf(to!) + 1)) {
      const before = offsite.length;
      await page.evaluate((html) => {
        document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article">${html}</div>`;
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))));
      }, c.html);
      if (offsite.length > before) failures.push({ id: c.id, dim: c.dim, reason: "offsite-request-case", detail: offsite.slice(before).join(" ") });
    }
  }

  const byReason = new Map<string, typeof failures>();
  for (const f of failures) byReason.set(`${f.dim}/${f.reason}`, [...(byReason.get(`${f.dim}/${f.reason}`) ?? []), f]);
  const counts = new Map<string, number>();
  for (const c of cases) counts.set(c.dim, (counts.get(c.dim) ?? 0) + 1);
  const summary = [
    `cases: ${[...counts].map(([d, n]) => `${d} ${n}`).join(", ")}; total ${cases.length}`,
    ...[...byReason].map(([k, fs]) => `${k}: ${fs.length} — first ${fs[0]!.id}: ${fs[0]!.detail}`),
  ].join("\n");
  console.log(summary);
  if (process.env.DGM_SPACE_FAILURES) writeFileSync(process.env.DGM_SPACE_FAILURES, JSON.stringify(failures, null, 1));
  expect(failures, summary).toEqual([]);
});
