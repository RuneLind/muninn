/**
 * `<SystemMap>`: the parser (`system-map.ts`), the reader's view
 * (`system-map-view.ts`) and what every other surface prints (the table).
 * Synthetic names only.
 */

import { describe, expect, test } from "bun:test";
import { nodeKey, parseExternalList, parseGroups, readSystemMap, resolveSystemNode, type SystemMapTable } from "./system-map.ts";
import { layoutSystemMap, SYSTEM_MAP_CHROME_CLASSES, systemMapCss, systemMapViewHtml, textWidthPx } from "./system-map-view.ts";
import { PEEK_SYSTEM_MAP_CHROME } from "../dashboard/views/components/wiki-ref-links.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import type { WikiPageMeta } from "../wiki/store.ts";

const T = (headers: string[], rows: string[][]): SystemMapTable => ({ headers, rows });

describe("readSystemMap", () => {
  test("reads the columns in English and in Norwegian, any case", () => {
    for (const headers of [
      ["From", "To", "Protocol", "Status", "Evidence"],
      ["Fra", "Til", "Protokoll", "Status", "Bevis"],
      ["fra", "TIL", "protokoll", "STATUS", "bevis"],
    ]) {
      const r = readSystemMap({}, T(headers, [["a", "b", "REST", "OK", "seen"]]));
      expect(r.drawable).toBe(true);
      expect(r.rows).toEqual([{ row: 0, from: "a", to: "b", protocol: "REST", status: "ok", statusRaw: "OK", evidence: "seen" }]);
      expect(r.findings).toEqual([]);
    }
  });

  test("no table, or no From/To column, stops the map", () => {
    expect(readSystemMap({}, null)).toMatchObject({ drawable: false, findings: [{ message: "holds no pipe table", fatal: true }] });
    const r = readSystemMap({}, T(["Fra", "Status"], [["a", "ok"]]));
    expect(r.drawable).toBe(false);
    expect(r.findings.map((f) => f.message)).toEqual(["has no To/Til column"]);
  });

  test("a status that is not ok or wrong, and a wrong row with no evidence, are findings on their row", () => {
    const r = readSystemMap({}, T(["From", "To", "Status", "Evidence"], [["a", "b", "maybe", ""], ["b", "c", "wrong", ""], ["c", "d", "wrong", "gone since 2025"]]));
    expect(r.drawable).toBe(true);
    expect(r.rows.map((x) => x.status)).toEqual([null, "wrong", "wrong"]);
    expect(r.findings).toEqual([
      { message: 'row a → b has Status "maybe"; write ok or wrong', row: 0 },
      { message: "row b → c is wrong and gives no reason in the Evidence column", row: 1 },
    ]);
  });

  test("a missing Status column is a finding; rows read as no status", () => {
    const r = readSystemMap({}, T(["From", "To"], [["a", "b"]]));
    expect(r.rows[0]!.status).toBeNull();
    expect(r.findings.map((f) => f.message)).toEqual(["has no Status column; no row is ok or wrong, so drift is not checked"]);
  });

  test("nodes in first-appearance order, case-free; a [[repos/x]] cell reads as x", () => {
    const r = readSystemMap({}, T(["From", "To", "Status"], [["Web", "repos/api", "ok"], ["api", "WEB", "ok"], ["api.md", "db", "ok"]]));
    expect(r.nodes.map((n) => [n.key, n.name])).toEqual([["web", "Web"], ["api", "api"], ["db", "db"]]);
  });

  test("columns: groups= order first, then repos, then external; externals default to external", () => {
    const r = readSystemMap(
      { groups: "web=frontend;api=core;svc=core", external: "Reg" },
      T(["From", "To", "Status"], [["loose", "web", "ok"], ["web", "api", "ok"], ["api", "Reg", "ok"], ["api", "svc", "ok"]]),
    );
    expect(r.columns).toEqual(["frontend", "core", "repos", "external"]);
    expect(Object.fromEntries(r.nodes.map((n) => [n.name, n.group]))).toEqual({ loose: "repos", web: "frontend", api: "core", Reg: "external", svc: "core" });
    expect(r.nodes.find((n) => n.name === "Reg")!.external).toBe(true);
  });

  test("an external= or groups= entry naming no row, and a groups= entry with no =, are findings", () => {
    const r = readSystemMap({ external: "Ghost", groups: "a=x;nope;b2=y" }, T(["From", "To", "Status"], [["a", "b", "ok"]]));
    expect(r.findings.map((f) => f.message)).toEqual([
      'groups= entry "nope" is not name=group',
      'external= names "Ghost", which no row names',
      'groups= names "b2", which no row names',
    ]);
  });

  test("the list parsers", () => {
    expect(parseExternalList(" PDL ; ;Sigrun")).toEqual(["PDL", "Sigrun"]);
    const g = parseGroups("web=frontend; api = core ;x=");
    expect([...g.groups]).toEqual([["web", "frontend"], ["api", "core"]]);
    expect(g.order).toEqual(["frontend", "core"]);
    expect(g.bad).toEqual(["x="]);
    expect(nodeKey("  Melosys  API ")).toBe("melosys api");
  });
});

describe("resolveSystemNode", () => {
  const pages: Record<string, { relPath: string; name: string }> = {
    "repos/api": { relPath: "repos/api.md", name: "api" },
    "integrations/reg": { relPath: "integrations/reg.md", name: "reg" },
  };
  const resolve = (t: string) => pages[t.toLowerCase()];
  test("a repos page; a declared external with and without an integrations page; nothing", () => {
    expect(resolveSystemNode({ name: "API", external: false }, resolve)).toEqual({ kind: "repo", page: pages["repos/api"]! });
    expect(resolveSystemNode({ name: "Reg", external: true }, resolve)).toEqual({ kind: "external", page: pages["integrations/reg"]! });
    expect(resolveSystemNode({ name: "Other", external: true }, resolve)).toEqual({ kind: "external", page: null });
    expect(resolveSystemNode({ name: "typo", external: false }, resolve)).toEqual({ kind: "unresolved" });
  });
});

describe("systemMapViewHtml", () => {
  const read = readSystemMap(
    { groups: "web=frontend;api=core", external: "Reg" },
    T(["From", "To", "Protocol", "Status", "Evidence"], [["web", "api", "REST", "ok", ""], ["api", "Reg", "SOAP", "wrong", "replaced by a queue"], ["api", "typo", "", "ok", ""]]),
  );
  const html = systemMapViewHtml({
    read,
    caption: "Systems",
    tableHtml: "<table>T</table>",
    beforeHtml: "",
    afterHtml: "",
    prefix: "sm1-",
    resolveNode: (n) =>
      n.key === "typo"
        ? { kind: "unresolved", link: null }
        : n.external
          ? { kind: "external", link: null }
          : { kind: "repo", link: { href: `/wiki?relPath=repos%2F${n.key}.md`, relPath: `repos/${n.key}.md`, name: n.key } },
  });

  test("one node per name, one edge per row, the table after the map", () => {
    expect(html.match(/class="sm-node /g)!.length).toBe(4);
    expect(html.match(/<path class="sm-edge /g)!.length).toBe(3);
    expect(html.indexOf('class="sm-map"')).toBeLessThan(html.indexOf("<table>T</table>"));
    expect(html).toContain('<section class="sm" role="figure" aria-labelledby="sm1-caption">');
  });

  test("a wrong edge is marked and its title names the reason; ids carry the prefix", () => {
    expect(html).toContain('class="sm-edge sm-wrong"');
    expect(html).toContain("<title>api → Reg · SOAP · wrong · replaced by a queue</title>");
    expect(html).toContain('marker-end="url(#sm1-arr-wrong)"');
    expect(html).toContain('<marker id="sm1-arr-ok"');
  });

  test("a repo node is a reader link; an external and an unresolved node are not", () => {
    expect(html).toContain('<a class="sm-node sm-repo" href="/wiki?relPath=repos%2Fweb.md" data-relpath="repos/web.md" data-wiki-page="web"');
    expect(html).toMatch(/<g class="sm-node sm-external sm-nopage" role="img" aria-label="Reg — external, no page" data-sm-node="reg">/);
    expect(html).toMatch(/<g class="sm-node sm-unresolved" role="img" aria-label="typo — names no repos\/ page" data-sm-node="typo"><title>typo — names no repos\/ page<\/title>/);
  });

  test("the map and the findings are reader-only and carry no newline (paragraphGaps)", () => {
    expect(html).toContain('<div class="sm-map" data-reader-only=""');
    expect(html).not.toContain("\n");
  });

  test("a map it cannot draw shows its findings over the table", () => {
    const fb = systemMapViewHtml({ read: readSystemMap({}, null), caption: "", tableHtml: "", beforeHtml: "<p>x</p>", afterHtml: "", prefix: "sm2-", resolveNode: () => ({ kind: "unresolved", link: null }) });
    expect(fb).toBe('<section class="sm sm-fallback" role="figure" aria-label="System map"><p>x</p><ul class="sm-notes" data-reader-only=""><li>holds no pipe table</li></ul></section>');
  });

  test("layout: columns side by side, nodes stacked in order", () => {
    const { boxes } = layoutSystemMap(read.nodes, read.columns);
    expect(boxes.get("web")!.col).toBe(0);
    expect(boxes.get("api")!.col).toBe(1);
    expect(boxes.get("typo")!.col).toBe(2);
    expect(boxes.get("reg")!.col).toBe(3);
  });

  test("the peek strips exactly the view's chrome", () => {
    expect([...PEEK_SYSTEM_MAP_CHROME]).toEqual([...SYSTEM_MAP_CHROME_CLASSES]);
  });
});

const PAGE = [
  '<SystemMap caption="Systems" external="Reg">',
  "",
  "| Fra | Til | Protokoll | Status | Bevis |",
  "|---|---|---|---|---|",
  "| web | api | REST | ok | |",
  "| api | Reg | SOAP | wrong | replaced |",
  "",
  "</SystemMap>",
].join("\n");

describe("surfaces", () => {
  test("web chat, Telegram, Slack and email print the edge table, no map", () => {
    const web = formatWebHtml(PAGE);
    expect(web).toContain("<table");
    expect(web).not.toContain("sm-map");
    expect(web).not.toContain("<svg");
    for (const out of [formatTelegramHtml(PAGE), formatSlackMrkdwn(PAGE), formatEmailHtml(PAGE)]) {
      expect(out).toContain("replaced");
      expect(out).toContain("SOAP");
      expect(out).not.toContain("<svg");
      expect(out).not.toContain("SystemMap");
    }
  });

  test("the reader's page render draws the map with links resolved through the index", () => {
    const page = (relPath: string): WikiPageMeta => ({ relPath, name: relPath.replace(/^.*\//, "").replace(/\.md$/, "") }) as WikiPageMeta;
    const known: Record<string, WikiPageMeta> = { "repos/web": page("repos/web.md"), "repos/api": page("repos/api.md"), "integrations/reg": page("integrations/reg.md") };
    const html = renderWikiHtml(PAGE, (t) => known[t.toLowerCase()], { views: true, wiki: "w" });
    expect(html).toContain('href="/wiki?wiki=w&amp;relPath=repos%2Fweb.md" data-relpath="repos/web.md"');
    expect(html).toContain('<a class="sm-node sm-external" href="/wiki?wiki=w&amp;relPath=integrations%2Freg.md"');
    expect(html).toContain("<table");
    // Without views (the gardener preview, the digest) the table alone.
    expect(renderWikiHtml(PAGE, (t) => known[t.toLowerCase()])).not.toContain("sm-map");
  });
});

describe("node names on the reader", () => {
  const page = (relPath: string): WikiPageMeta => ({ relPath, name: relPath.replace(/^.*\//, "").replace(/\.md$/, "") }) as WikiPageMeta;
  const known: Record<string, WikiPageMeta> = {
    "repos/alpha-web": page("repos/alpha-web.md"),
    "repos/beta-api": page("repos/beta-api.md"),
    "integrations/joark-saf": page("integrations/joark-saf.md"),
    "integrations/id-porten-tokenx": page("integrations/id-porten-tokenx.md"),
    "integrations/pdl": page("integrations/pdl.md"),
    "plans/secret": page("plans/secret.md"),
  };
  // Like the index: a path form is normalized, so `..` collapses.
  const resolve = (t: string) => known[t.toLowerCase().replace(/^[^/]+\/\.\.\//, "")];
  const render = (rows: string[], attrs = "") =>
    renderWikiHtml(["<SystemMap" + attrs + ">", "", "| From | To | Status |", "|---|---|---|", ...rows, "", "</SystemMap>", ""].join("\n"), resolve, { views: true, wiki: "w" });

  test("a wikilink cell links its target and draws its label", () => {
    const html = render(["| [[repos/alpha-web|Alpha Web]] | [[repos/beta-api#api]] | ok |"]);
    expect(html).toContain('data-relpath="repos/alpha-web.md" data-wiki-page="alpha-web" data-sm-node="alpha-web" aria-label="Alpha Web');
    expect(html).toContain('data-relpath="repos/beta-api.md" data-wiki-page="beta-api" data-sm-node="beta-api"');
    expect(html).toContain(">Alpha Web</text>");
  });

  test("an external resolves by slug; external= written as a wikilink reads as its target", () => {
    const html = render(["| alpha-web | Joark/SAF | ok |", "| alpha-web | ID-porten/TokenX | ok |", "| alpha-web | PDL | ok |", "| alpha-web | Ørn | ok |"], ' external="Joark/SAF;ID-porten/TokenX;[[integrations/pdl|PDL]];Ørn"');
    expect(html).toContain('data-relpath="integrations/joark-saf.md"');
    expect(html).toContain('data-relpath="integrations/id-porten-tokenx.md"');
    expect(html).toContain('data-relpath="integrations/pdl.md"');
    expect(html).not.toContain("sm-unresolved");
  });

  test("a repo node must land under repos/", () => {
    expect(resolveSystemNode({ name: "../plans/secret", external: false }, resolve)).toEqual({ kind: "unresolved" });
    expect(resolve("repos/../plans/secret")).toBeDefined();
  });
});

/** The `<rect>` of every node in a rendered map, by node key. */
function nodeRects(html: string): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const m of html.matchAll(/data-sm-node="([^"]+)"[^>]*>(?:<title>[^<]*<\/title>)?<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    out.set(m[1]!, { x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) });
  }
  return out;
}

/** Points along an absolute `M/L/H/V/C/Q` path, every curve sampled 40 times. */
function samplePath(d: string): { x: number; y: number }[] {
  const toks = d.match(/[MLHVCQ]|-?[\d.]+/g)!;
  const pts: { x: number; y: number }[] = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  const num = () => Number(toks[i++]);
  const line = (nx: number, ny: number) => {
    for (let s = 1; s <= 40; s++) pts.push({ x: x + ((nx - x) * s) / 40, y: y + ((ny - y) * s) / 40 });
    x = nx;
    y = ny;
  };
  while (i < toks.length) {
    if (/[A-Z]/.test(toks[i]!)) cmd = toks[i++]!;
    if (cmd === "M") {
      x = num();
      y = num();
      pts.push({ x, y });
    } else if (cmd === "L") line(num(), num());
    else if (cmd === "H") line(num(), y);
    else if (cmd === "V") line(x, num());
    else if (cmd === "C" || cmd === "Q") {
      const c = cmd === "C" ? [num(), num(), num(), num()] : [num(), num()];
      const ex = num();
      const ey = num();
      for (let s = 1; s <= 40; s++) {
        const t = s / 40;
        const u = 1 - t;
        if (cmd === "C") {
          pts.push({ x: u ** 3 * x + 3 * u * u * t * c[0]! + 3 * u * t * t * c[2]! + t ** 3 * ex, y: u ** 3 * y + 3 * u * u * t * c[1]! + 3 * u * t * t * c[3]! + t ** 3 * ey });
        } else {
          pts.push({ x: u * u * x + 2 * u * t * c[0]! + t * t * ex, y: u * u * y + 2 * u * t * c[1]! + t * t * ey });
        }
      }
      x = ex;
      y = ey;
    } else throw new Error(`unsampled command ${cmd}`);
  }
  return pts;
}

describe("layout: routing and sizing", () => {
  // Shaped like a real hub: frontend → core → services → external, with most
  // core edges skipping the services column.
  const services = ["svc-a", "svc-b", "svc-c", "svc-d", "svc-e", "svc-f"];
  const externals = ["ext-a", "ext-b", "ext-c", "ext-d", "ext-e", "ext-f", "ext-g"];
  const rows: string[][] = [
    ["web-a", "api", "REST", "ok", ""],
    ["web-b", "api", "REST", "ok", ""],
    ...services.map((s) => ["api", s, "Kafka", "ok", ""]),
    ...externals.map((e) => ["api", e, "REST", "ok", ""]),
    ...externals.slice(0, 3).map((e) => ["api", e, "SOAP", "ok", ""]),
    ["web-a", "ext-a", "REST", "ok", ""],
    ["svc-b", "ext-c", "REST", "ok", ""],
  ];
  const groups = ["web-a=frontend", "web-b=frontend", "api=core", ...services.map((s) => `${s}=services`)].join(";");
  const read = readSystemMap({ groups, external: externals.join(";") }, T(["From", "To", "Protocol", "Status", "Evidence"], rows));
  const draw = (r = read) =>
    systemMapViewHtml({ read: r, caption: "", tableHtml: "", beforeHtml: "", afterHtml: "", prefix: "sm9-", resolveNode: (n) => ({ kind: n.external ? "external" : "repo", link: null }) });
  const html = draw();

  test("no edge passes under a box it does not end at", () => {
    const rects = nodeRects(html);
    expect(rects.size).toBe(2 + 1 + services.length + externals.length);
    const hits: string[] = [];
    for (const m of html.matchAll(/<path class="sm-edge [^"]*" d="([^"]+)"[^>]*data-sm-from="([^"]+)" data-sm-to="([^"]+)"/g)) {
      const [, d, from, to] = m;
      for (const [key, r] of rects) {
        if (key === from || key === to) continue;
        if (samplePath(d!).some((p) => p.x > r.x + 0.5 && p.x < r.x + r.w - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.h - 0.5)) hits.push(`${from}→${to} under ${key}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test("a node's many edges attach to its side at points at least 4px apart", () => {
    // api's 16 edges along its right side: 6 to the next column, 10 by one trunk.
    const ys = [...html.matchAll(/<path class="sm-edge [^"]*" d="M[\d.]+ ([\d.]+)[^"]*"[^>]*data-sm-from="api"/g)].map((m) => Number(m[1]));
    expect(ys.length).toBe(services.length + externals.length + 3);
    const points = [...new Set(ys)].sort((p, q) => p - q);
    expect(points.length).toBe(services.length + 1);
    for (let i = 1; i < points.length; i++) expect(points[i]! - points[i - 1]!).toBeGreaterThanOrEqual(4);
  });

  test("a column is as wide as its longest label; only a label past the cap is cut, by width", () => {
    const r = readSystemMap(
      { groups: "faktureringskomponenten=core" },
      T(["From", "To", "Status"], [["faktureringskomponenten", "WWWWWWWWWWWWWWWWWWWW", "ok"], ["faktureringskomponenten", "x".repeat(60), "ok"]]),
    );
    const out = draw(r);
    // 23 characters fit whole.
    expect(out).toContain(">faktureringskomponenten</text>");
    // Twenty wide letters do not fit a column: cut, the full name in the title.
    const w = /data-sm-node="wwwwwwwwwwwwwwwwwwww"[^>]*><title>([^<]*)<\/title><rect[^>]*\/><text[^>]*>([^<]*)<\/text>/.exec(out)!;
    expect(w[1]).toBe("WWWWWWWWWWWWWWWWWWWW — repo, opens its page");
    expect(w[2]!.endsWith("…")).toBe(true);
    expect(w[2]!.length).toBeLessThan(20);
    const long = new RegExp(`data-sm-node="${"x".repeat(60)}"[^>]*><title>[^<]*</title><rect[^>]*/><text[^>]*>([^<]*)</text>`).exec(out)!;
    expect(long[1]!.endsWith("…")).toBe(true);
  });

  test("a long group name is cut to its column, the full name in its title", () => {
    const r = readSystemMap({ groups: "a=frontend-and-integration-layer-services" }, T(["From", "To", "Status"], [["a", "b", "ok"]]));
    const head = /<text class="sm-col"[^>]*>(?:<title>([^<]*)<\/title>)?([^<]*)<\/text>/.exec(draw(r))!;
    expect(head[1]).toBe("frontend-and-integration-layer-services");
    expect(head[2]!.endsWith("…")).toBe(true);
  });

  test("the legibility floor is computed from the smallest font drawn (11px column heads)", () => {
    const m = /viewBox="0 0 ([\d.]+) [\d.]+" style="max-width:[\d.]+px;min-width:(\d+)px"/.exec(html)!;
    expect(Number(m[2])).toBe(Math.ceil((Number(m[1]) * 9) / 11));
  });

  test("print drops the inline min-width, so a printed map fits the page", () => {
    expect(systemMapCss(".a").replace(/\s+/g, " ")).toMatch(/@media print \{[^}]*\.a \.sm-svg \{ min-width: 0 !important; \}/);
  });
});

describe("names, caption and node kinds", () => {
  const read = readSystemMap(
    { groups: "web=frontend;api=core", external: "Reg;Gone" },
    T(["From", "To", "Status"], [["web", "api", "ok"], ["api", "Reg", "wrong"], ["api", "Gone", "ok"], ["api", "typo", "ok"]]),
  );
  const html = systemMapViewHtml({
    read,
    caption: "Systems & co",
    tableHtml: "<table>T</table>",
    beforeHtml: "",
    afterHtml: "",
    prefix: "sm3-",
    resolveNode: (n) =>
      n.key === "typo"
        ? { kind: "unresolved", link: null }
        : n.key === "gone"
          ? { kind: "external", link: null }
          : { kind: n.external ? "external" : "repo", link: { href: `/x/${n.key}`, relPath: `p/${n.key}.md`, name: n.key } },
  });

  test("the caption is visible text above the map, reader-only like the map", () => {
    expect(html).toContain('<div class="sm-caption" id="sm3-caption" aria-hidden="true" data-reader-only="">Systems &amp; co</div><div class="sm-map"');
  });

  test("one name per level: the caption names the figure once, the scroll box is the drawing, the SVG repeats neither", () => {
    // The figure is named by the caption and the caption is hidden from
    // assistive tech, so its words are announced once, not as name and text.
    expect(html).toContain('<section class="sm" role="figure" aria-labelledby="sm3-caption">');
    expect(html).not.toContain("System map: Systems");
    // No caption: the figure keeps its own label.
    const bare = systemMapViewHtml({ read: readSystemMap({}, T(["From", "To", "Status"], [["a", "b", "ok"]])), caption: "", tableHtml: "", beforeHtml: "", afterHtml: "", prefix: "sm6-", resolveNode: () => ({ kind: "repo", link: { href: "/", relPath: "r.md", name: "r" } }) });
    expect(bare).toContain('<section class="sm" role="figure" aria-label="System map">');
    expect(bare).not.toContain("sm-caption");
    expect(html).toContain('<div class="sm-map" data-reader-only="" role="region" tabindex="0" aria-label="Map drawing">');
    const svg = /<svg class="sm-svg"[^>]*>(<title>)?/.exec(html)!;
    expect(svg[0]).not.toContain("aria-label");
    expect(svg[0]).toContain(`role="group"`);
    expect(svg[1]).toBeUndefined();
  });

  test("a map it cannot draw is still a named figure", () => {
    const fb = systemMapViewHtml({ read: readSystemMap({}, null), caption: "Hub", tableHtml: "", beforeHtml: "", afterHtml: "", prefix: "sm4-", resolveNode: () => ({ kind: "unresolved", link: null }) });
    expect(fb.startsWith('<section class="sm sm-fallback" role="figure" aria-label="System map: Hub">')).toBe(true);
  });

  test("each node kind has its own class and says its kind in its name", () => {
    expect(html).toContain('<a class="sm-node sm-repo" href="/x/web"');
    expect(html).toContain('aria-label="web — repo, opens its page"');
    expect(html).toContain('<a class="sm-node sm-external" href="/x/reg"');
    expect(html).toContain('aria-label="Reg — external, opens its page"');
    // A node with no page is a named image: a <title> on a plain <g> gives
    // Chromium no name, so its kind would be read nowhere.
    expect(html).toContain('<g class="sm-node sm-external sm-nopage" role="img" aria-label="Gone — external, no page" data-sm-node="gone"><title>Gone — external, no page</title>');
    expect(html).toContain('<g class="sm-node sm-unresolved" role="img" aria-label="typo — names no repos/ page" data-sm-node="typo"><title>typo — names no repos/ page</title>');
    // Every node, linked or not, carries a name that says its kind.
    const named = [...html.matchAll(/<(a|g) class="sm-node [^"]*"[^>]*>/g)].map((m) => /aria-label="[^"]+ — [^"]+"/.test(m[0]));
    expect(named.length).toBe(5);
    expect(named.every(Boolean)).toBe(true);
  });

  test("the legend under the map names only the styles drawn on it", () => {
    const legend = /<ul class="sm-legend" data-reader-only="">(.*?)<\/ul>/.exec(html)![1]!;
    const items = [...legend.matchAll(/<\/svg>([^<]+)<\/li>/g)].map((m) => m[1]);
    expect(items).toEqual(["Repo, opens its page", "External, opens its page", "External, no page", "Names no repos/ page", "Edge: ok", "Edge: wrong"]);
    expect(html.indexOf("sm-legend")).toBeGreaterThan(html.indexOf("</svg></div>"));
    // Rendered order: map, legend, node list, then the edge table.
    expect(html.indexOf('class="sm-legend"')).toBeLessThan(html.indexOf('class="sm-list"'));
    expect(html.indexOf('class="sm-legend"')).toBeLessThan(html.indexOf("<table>T</table>"));
    // A map of repos alone has a one-node-style legend.
    const plain = systemMapViewHtml({ read: readSystemMap({}, T(["From", "To", "Status"], [["a", "b", "ok"]])), caption: "", tableHtml: "", beforeHtml: "", afterHtml: "", prefix: "sm5-", resolveNode: () => ({ kind: "repo", link: { href: "/", relPath: "r.md", name: "r" } }) });
    expect([...plain.matchAll(/<\/svg>([^<]+)<\/li>/g)].map((m) => m[1])).toEqual(["Repo, opens its page", "Edge: ok"]);
  });

  test("the text form lists every node by column with its kind", () => {
    const list = /<details class="sm-list" data-reader-only=""><summary>Systems by column<\/summary>(.*?)<\/details>/.exec(html)![1]!;
    expect(list).toBe(
      "<ul>" +
        "<li>frontend<ul><li>web — repo, opens its page</li></ul></li>" +
        "<li>core<ul><li>api — repo, opens its page</li></ul></li>" +
        "<li>repos<ul><li>typo — names no repos/ page</li></ul></li>" +
        "<li>external<ul><li>Reg — external, opens its page</li><li>Gone — external, no page</li></ul></li>" +
        "</ul>",
    );
  });

  test("the peek drops the caption, the legend and the node list with the map", () => {
    expect([...SYSTEM_MAP_CHROME_CLASSES]).toEqual(["sm-caption", "sm-map", "sm-legend", "sm-list", "sm-notes"]);
  });

  test("keyboard focus on a node is styled apart from hover", () => {
    const css = systemMapCss(".a").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    // Each rule's selector list and body; the first rule naming a selector.
    const decl = (sel: string) => [...css.matchAll(/(?<=^|\})([^{}]*)\{([^}]*)\}/g)].find((m) => m[1]!.split(",").map((s) => s.trim()).includes(sel))?.[2]!.trim();
    const hover = decl(".a a.sm-node:hover rect");
    const focus = decl(".a a.sm-node:focus-visible rect");
    expect(hover).toBeDefined();
    expect(focus).toBeDefined();
    expect(focus).not.toBe(hover);
  });
});

describe("loops: self-edges and edges within one column", () => {
  const draw = (r: ReturnType<typeof readSystemMap>) =>
    systemMapViewHtml({ read: r, caption: "", tableHtml: "", beforeHtml: "", afterHtml: "", prefix: "sm8-", resolveNode: () => ({ kind: "repo", link: null }) });
  const paths = (html: string) =>
    [...html.matchAll(/<path class="sm-edge [^"]*" d="([^"]+)"[^>]*data-sm-from="([^"]+)" data-sm-to="([^"]+)"/g)].map((m) => ({ d: m[1]!, from: m[2]!, to: m[3]!, pts: samplePath(m[1]!) }));
  const minDist = (p: { x: number; y: number }[], q: { x: number; y: number }[]) => Math.min(...p.flatMap((a) => q.map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
  const ends = (pts: { x: number; y: number }[]) => [pts[0]!, pts[pts.length - 1]!].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);

  test("a self-loop shares no point with the node's other edges", () => {
    // a has an outgoing edge and a loop; hub has edges on both sides and a loop.
    const r = readSystemMap(
      { groups: "a=one;up=one;hub=two;down=two;z=three;y=three" },
      T(["From", "To", "Status"], [["a", "hub", "ok"], ["a", "a", "ok"], ["up", "hub", "ok"], ["hub", "z", "ok"], ["hub", "y", "ok"], ["hub", "hub", "ok"], ["down", "z", "ok"]]),
    );
    const es = paths(draw(r));
    for (const key of ["a", "hub"]) {
      const loop = es.find((e) => e.from === key && e.to === key)!;
      const others = es.filter((e) => e !== loop);
      expect(minDist(loop.pts, others.flatMap((e) => e.pts))).toBeGreaterThan(2);
      const otherEnds = new Set(others.flatMap((e) => ends(e.pts)));
      expect(ends(loop.pts).filter((p) => otherEnds.has(p))).toEqual([]);
    }
    // a's left side is free, so its loop goes there.
    const aLoop = es.find((e) => e.from === "a" && e.to === "a")!;
    expect(Math.max(...aLoop.pts.map((p) => p.x))).toBeLessThanOrEqual(nodeRects(draw(r)).get("a")!.x);
  });

  test("a self-loop sits between a node's rising and falling edges", () => {
    // mid has edges in on the left and out on the right, rising and falling.
    const r = readSystemMap(
      { groups: "i1=one;i2=one;i3=one;f=two;g=two;h=two;mid=two;o1=three;o2=three;o3=three" },
      T(["From", "To", "Status"], [
        ["f", "o1", "ok"], ["g", "o1", "ok"], ["h", "o1", "ok"], ["i1", "mid", "ok"], ["i2", "mid", "ok"], ["i3", "mid", "ok"],
        ["mid", "o1", "ok"], ["mid", "o2", "ok"], ["mid", "o3", "ok"], ["mid", "mid", "ok"],
      ]),
    );
    const es = paths(draw(r));
    const loop = es.find((e) => e.from === "mid" && e.to === "mid")!;
    expect(minDist(loop.pts, es.filter((e) => e !== loop).flatMap((e) => e.pts))).toBeGreaterThan(2);
  });

  test("an edge within a column stays short of the trunk lanes in the gap after it", () => {
    // Four edges inside column one, and four trunks in the gap after it.
    const r = readSystemMap(
      { groups: "p=one;q=one;r=one;s=one;m=two;t=three;u=three" },
      T(["From", "To", "Status"], [
        ["p", "t", "ok"], ["q", "t", "ok"], ["r", "u", "ok"], ["s", "u", "ok"], ["p", "m", "ok"],
        ["p", "q", "ok"], ["q", "r", "ok"], ["r", "s", "ok"], ["p", "s", "ok"],
      ]),
    );
    const es = paths(draw(r));
    const one = new Set(["p", "q", "r", "s"]);
    const within = es.filter((e) => one.has(e.from) && one.has(e.to));
    const trunks = es.filter((e) => one.has(e.from) && (e.to === "t" || e.to === "u"));
    expect(within.length).toBe(4);
    expect(trunks.length).toBe(4);
    // A trunk's lane is the x of its first corner; the loops cross the trunks'
    // stubs from the side but never reach the band the lanes run down.
    const nearestLane = Math.min(...trunks.map((e) => Number(/ Q([\d.]+) /.exec(e.d)![1])));
    for (const w of within) expect(Math.max(...w.pts.map((p) => p.x))).toBeLessThan(nearestLane - 2);
  });
});

/**
 * The routing invariants, checked on any drawn map:
 * I1 no two edges with different ends run along one horizontal or vertical
 *    line, except edges sharing a source trunk (on its stub and trunk) or a
 *    target trunk (on its trunk and stub);
 * I2 no edge passes inside a box it does not end at, and every edge stays a
 *    stroke width inside the drawing;
 * I3 a side's attachment points sit inside it, at least 4px apart; a point is
 *    shared only by edges on one trunk, or by one direction of a side's
 *    merged edges to the next column.
 */
function routingViolations(html: string): string[] {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(html)!;
  const [W, H] = [Number(vb[1]), Number(vb[2])];
  const rects = nodeRects(html);
  const edges = [...html.matchAll(/<path class="sm-edge ([^"]*)" d="([^"]+)"[^>]*data-sm-from="([^"]+)" data-sm-to="([^"]+)"/g)].map((m, i) => {
    const d = m[2]!;
    // Corners are the Q control points; a curve (C) is one piece.
    const nums = (re: RegExp) => [...d.matchAll(re)].map((x) => ({ x: Number(x[1]), y: Number(x[2]) }));
    const start = nums(/^M([\d.]+) ([\d.]+)/g)[0]!;
    const end = nums(/([\d.]+) ([\d.]+)$/g)[0]!;
    const cubic = /C/.test(d);
    const verts = cubic ? [start, end] : [start, ...nums(/Q([\d.]+) ([\d.]+)/g), end];
    return { i, wrong: m[1]!.includes("sm-wrong"), d, from: m[3]!, to: m[4]!, cubic, verts, pts: samplePath(d) };
  });
  const out: string[] = [];
  // I1: straight pieces, by role on a routed (six-point) edge.
  const roles = ["stub-s", "trunk-s", "run", "trunk-t", "stub-t"];
  const segs = edges.flatMap((e) =>
    e.cubic
      ? e.verts[0]!.y === e.verts[1]!.y && /^M[\d.]+ ([\d.]+) C[\d.]+ \1 [\d.]+ \1 [\d.]+ \1$/.test(e.d)
        ? [{ e, role: "curve", h: true, c: e.verts[0]!.y, lo: Math.min(e.verts[0]!.x, e.verts[1]!.x), hi: Math.max(e.verts[0]!.x, e.verts[1]!.x) }]
        : []
      : e.verts.slice(1).flatMap((b, k) => {
          const a = e.verts[k]!;
          const role = e.verts.length === 6 ? roles[k]! : "other";
          if (a.y === b.y && a.x !== b.x) return [{ e, role, h: true, c: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) }];
          if (a.x === b.x && a.y !== b.y) return [{ e, role, h: false, c: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) }];
          return [];
        }),
  );
  for (let p = 0; p < segs.length; p++)
    for (let q = p + 1; q < segs.length; q++) {
      const [s, t] = [segs[p]!, segs[q]!];
      if (s.e === t.e || s.h !== t.h || Math.abs(s.c - t.c) >= 1 || Math.min(s.hi, t.hi) <= Math.max(s.lo, t.lo)) continue;
      if (s.e.from === t.e.from && s.e.to === t.e.to) continue;
      const src = (x: typeof s) => x.role === "stub-s" || x.role === "trunk-s";
      const tgt = (x: typeof s) => x.role === "stub-t" || x.role === "trunk-t";
      if ((s.e.from === t.e.from && src(s) && src(t)) || (s.e.to === t.e.to && tgt(s) && tgt(t))) continue;
      out.push(`I1 ${s.e.from}→${s.e.to} ${s.role} along ${t.e.from}→${t.e.to} ${t.role} at ${s.h ? "y" : "x"}=${s.c}`);
    }
  // I2
  for (const e of edges) {
    const sw = e.wrong ? 2 : 1.6;
    if (e.pts.some((p) => p.x < sw || p.y < sw || p.x > W - sw || p.y > H - sw)) out.push(`I2 ${e.from}→${e.to} leaves the drawing`);
    for (const [key, r] of rects) {
      if (key === e.from || key === e.to) continue;
      if (e.pts.some((p) => p.x > r.x + 0.5 && p.x < r.x + r.w - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.h - 0.5)) out.push(`I2 ${e.from}→${e.to} under ${key}`);
    }
  }
  // I3
  const sides = new Map<string, { y: number; kind: string }[]>();
  for (const e of edges) {
    for (const [end, pt] of [["s", e.verts[0]!], ["t", e.verts[e.verts.length - 1]!]] as const) {
      const key = end === "s" ? e.from : e.to;
      const r = rects.get(key)!;
      const side = pt.x === r.x ? "L" : pt.x === r.x + r.w ? "R" : "?";
      if (side === "?" || pt.y <= r.y || pt.y >= r.y + r.h) out.push(`I3 ${e.from}→${e.to} attaches off ${key}'s side`);
      const routed = !e.cubic && e.verts.length === 6;
      const kind = routed ? `trunk ${end} ${end === "s" ? e.verts[1]!.x : e.verts[4]!.x}` : e.cubic && rects.get(e.from)!.x !== rects.get(e.to)!.x ? `next-column ${end}` : `loop ${e.i}`;
      sides.set(`${key}|${side}`, [...(sides.get(`${key}|${side}`) ?? []), { y: pt.y, kind }]);
    }
  }
  for (const [side, list] of sides) {
    const ys = [...new Set(list.map((l) => l.y))].sort((p, q) => p - q);
    for (let i = 1; i < ys.length; i++) if (ys[i]! - ys[i - 1]! < 4) out.push(`I3 ${side} points ${(ys[i]! - ys[i - 1]!).toFixed(2)}px apart`);
    for (const y of ys) {
      const kinds = new Set(list.filter((l) => l.y === y).map((l) => l.kind));
      if (kinds.size > 1 || [...kinds][0]!.startsWith("loop") && list.filter((l) => l.y === y).length > 1) out.push(`I3 ${side} shares y=${y} across ${[...kinds].join(" / ")}`);
    }
  }
  return out;
}

describe("routing invariants", () => {
  const draw = (groups: string, rows: string[][], headers = ["From", "To", "Status"]) =>
    systemMapViewHtml({ read: readSystemMap({ groups }, T(headers, rows)), caption: "", tableHtml: "", beforeHtml: "", afterHtml: "", prefix: "sm7-", resolveNode: () => ({ kind: "repo", link: null }) });
  const n = <T,>(k: number, f: (i: number) => T): T[] => Array.from({ length: k }, (_, i) => f(i));
  const proto = ["REST", "Kafka", "SOAP", "gRPC"];
  // Two sources to two targets two columns away, over four protocols: sixteen
  // runs across, for two row gaps of five positions.
  const crowded = draw(
    "a=one;b=one;m=two;x=three;y=three",
    [...["a", "b"].flatMap((s) => ["x", "y"].flatMap((t) => proto.map((p) => [s, t, p, "ok"]))), ["a", "m", "", "ok"]],
    ["From", "To", "Protocol", "Status"],
  );
  const fivecols = (() => {
    const rows: string[][] = [];
    for (let k = 0; k < 5; k++) {
      rows.push([`n0${k}`, `n4${(k + 1) % 5}`, "ok"], [`n4${k}`, `n0${(k + 2) % 5}`, "ok"], [`n1${k}`, `n3${k}`, "ok"], [`n3${k}`, `n1${(k + 3) % 5}`, "ok"]);
      rows.push([`n0${k}`, `n2${k}`, "ok"], [`n2${k}`, `n4${k}`, "ok"], [`n4${k}`, `n2${(k + 1) % 5}`, "ok"], [`n0${k}`, `n1${k}`, "ok"], [`n1${(k + 1) % 5}`, `n0${k}`, "ok"]);
    }
    return draw(n(25, (i) => `n${Math.floor(i / 5)}${i % 5}=c${Math.floor(i / 5)}`).join(";"), rows);
  })();
  const maps: [string, string][] = [
    ["sixteen runs across two row gaps", crowded],
    ["65 edges to the next column", draw(["hub=one", ...n(65, (i) => `t${i}=two`)].join(";"), n(65, (i) => ["hub", `t${i}`, "ok"]))],
    [
      "65 edges by one trunk, 30 each way to the next column",
      draw(
        ["hub=one", ...n(30, (i) => `m${i}=two`), ...n(65, (i) => `t${i}=three`)].join(";"),
        [...n(65, (i) => ["hub", `t${i}`, "ok"]), ...n(30, (i) => ["hub", `m${i}`, "ok"]), ...n(30, (i) => [`m${i}`, "hub", "ok"])],
      ),
    ],
    ["five columns, forward, reverse and full spans", fivecols],
    ["stubs from both sides of one gap, level", draw("l=c0;m=c1;r=c2;q=c3", [["m", "q", "ok"], ["r", "l", "ok"], ["l", "r", "ok"], ["q", "m", "ok"]])],
    ["fourteen trunks in one gap", draw([...n(14, (i) => `s${i}=one`), "mid=two", "dst=three"].join(";"), [...n(14, (i) => [`s${i}`, "dst", "ok"]), ["s0", "mid", "ok"]])],
    [
      "a side with ten edges within its column",
      draw([...n(11, (i) => `w${i}=one`), "x=two", "y=two", "z=three"].join(";"), [...n(10, (i) => ["w0", `w${i + 1}`, "ok"]), ["w0", "x", "ok"], ["w0", "y", "ok"], ["x", "w0", "ok"], ["w0", "z", "ok"], ["w0", "w0", "ok"]]),
    ],
    ["one column", draw("a=one;b=one;c=one", [["a", "b", "ok"], ["b", "c", "ok"], ["a", "c", "ok"], ["c", "a", "ok"]])],
    ["two columns", draw("a=one;b=one;x=two;y=two", [["a", "x", "ok"], ["a", "y", "ok"], ["b", "x", "ok"], ["x", "a", "ok"], ["y", "b", "ok"]])],
  ];
  for (const [name, html] of maps) test(`I1–I3 hold: ${name}`, () => expect(routingViolations(html)).toEqual([]));

  const runs = (html: string) =>
    [...html.matchAll(/<path class="sm-edge [^"]*" d="([^"]+)"[^>]*data-sm-from="([^"]+)" data-sm-to="([^"]+)"/g)].flatMap((m) => {
      const q = [...m[1]!.matchAll(/Q([\d.]+) ([\d.]+)/g)].map((x) => ({ x: Number(x[1]), y: Number(x[2]) }));
      return q.length === 4 ? [{ from: m[2]!, to: m[3]!, y: q[1]!.y, lo: Math.min(q[1]!.x, q[2]!.x), hi: Math.max(q[1]!.x, q[2]!.x) }] : [];
    });

  test("runs past a row gap's five positions overflow under the last row, and the drawing grows to hold them", () => {
    const rects = [...nodeRects(crowded).values()];
    const lastRow = Math.max(...rects.map((r) => r.y + r.h));
    const height = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(crowded)![1]);
    const ys = runs(crowded).map((r) => r.y);
    expect(ys.length).toBe(16);
    expect(new Set(ys).size).toBe(16);
    // Two row gaps hold ten; six run under the last row's gap, 5px apart.
    const under = ys.filter((y) => y > lastRow + 14).sort((p, q) => p - q);
    expect(under.length).toBe(6);
    for (let i = 1; i < under.length; i++) expect(under[i]! - under[i - 1]!).toBe(5);
    expect(height).toBeGreaterThanOrEqual(under.at(-1)! + 12);
  });

  test("runs whose spans do not overlap share a row-gap position", () => {
    // a→c and d→f cross different gaps of one row gap, so they share a line.
    const html = draw("a=c0;b=c1;c=c2;d=c2;e=c3;f=c4", [["a", "c", "ok"], ["d", "f", "ok"], ["a", "b", "ok"], ["e", "f", "ok"]]);
    const r = runs(html);
    expect(r.length).toBe(2);
    expect(r[0]!.y).toBe(r[1]!.y);
    expect(Math.max(r[0]!.lo, r[1]!.lo)).toBeGreaterThan(Math.min(r[0]!.hi, r[1]!.hi));
  });

  test("a gap widens to keep every trunk lane 24px from the boxes either side", () => {
    const html = maps.find(([m]) => m === "fourteen trunks in one gap")![1];
    const rects = nodeRects(html);
    const lanes = [...html.matchAll(/data-sm-to="dst"/g)].length;
    expect(lanes).toBe(14);
    const xs = [...html.matchAll(/<path class="sm-edge [^"]*" d="M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ Q([\d.]+) /g)].map((m) => Number(m[1]));
    const [left, right] = [rects.get("s0")!.x + rects.get("s0")!.w, rects.get("mid")!.x];
    expect(Math.min(...xs) - left).toBeGreaterThanOrEqual(24);
    expect(right - Math.max(...xs)).toBeGreaterThanOrEqual(24);
  });

  test("a side over seven points merges its edges to the next column, one point each way, and no box grows", () => {
    // hub's right side: ten edges out to the next column, two back in.
    const html = draw(["hub=one", ...n(10, (i) => `t${i}=two`)].join(";"), [...n(10, (i) => ["hub", `t${i}`, "ok"]), ["t0", "hub", "ok"], ["t9", "hub", "ok"]]);
    const es = [...html.matchAll(/d="M([\d.]+) ([\d.]+) C[^"]*? ([\d.]+) ([\d.]+)"[^>]*data-sm-from="([^"]+)" data-sm-to="([^"]+)"/g)];
    const out = new Set(es.filter((m) => m[5] === "hub").map((m) => m[2]));
    const back = new Set(es.filter((m) => m[6] === "hub").map((m) => m[4]));
    expect([out.size, back.size]).toEqual([1, 1]);
    expect([...out][0]).not.toBe([...back][0]);
    expect(new Set([...nodeRects(html).values()].map((r) => r.h))).toEqual(new Set([34]));
  });

  test("a side that cannot hold its points 4px apart grows every box taller", () => {
    const html = maps.find(([m]) => m === "a side with ten edges within its column")![1];
    const hs = new Set([...nodeRects(html).values()].map((r) => r.h));
    expect(hs.size).toBe(1);
    expect([...hs][0]!).toBeGreaterThan(34);
  });
});

describe("label width estimate", () => {
  test("wide, fullwidth and emoji characters count at least their drawn width", () => {
    expect(textWidthPx("漢字テスト한국", 12)).toBeGreaterThanOrEqual(7 * 12);
    expect(textWidthPx("ＡＢＣ１２３", 12)).toBeGreaterThanOrEqual(6 * 12);
    expect(textWidthPx("🚀🎉", 12)).toBeGreaterThanOrEqual(2 * 1.25 * 12);
  });

  test("a grapheme counts once: a variation selector, a ZWJ sequence, a combining mark", () => {
    expect(textWidthPx("❤️", 12)).toBe(textWidthPx("❤", 12));
    expect(textWidthPx("👨‍👩‍👧", 12)).toBe(textWidthPx("👨", 12));
    expect(textWidthPx("e\u0301", 12)).toBe(textWidthPx("e", 12));
  });
});

/**
 * Loop invariants (self-loops and edges within one column), checked on any
 * drawn map. A loop on one side of a column is the interval between its two
 * attachment points:
 * L1 a loop inside another never crosses it and reaches strictly less far;
 * L2 two loops whose intervals partly overlap cross only when the map has no
 *    side left for them: the drawn crossings equal `layout.loopCrossings`, 0
 *    when the overlaps 2-colour;
 * L3 a loop stays 2px short of the trunk lanes, of the next column's boxes
 *    and of its loops on the facing side, and 12px inside the drawing;
 * L4 the routing invariants I1–I3 hold.
 */
type Pt = { x: number; y: number };
/** An absolute M/L/C/Q path as a polyline: lines by their ends, curves sampled. */
function polyline(d: string): Pt[] {
  const toks = d.match(/[MLCQ]|-?[\d.]+/g)!;
  const pts: Pt[] = [];
  let [i, cmd, x, y] = [0, "", 0, 0];
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[A-Z]/.test(toks[i]!)) cmd = toks[i++]!;
    if (cmd === "M" || cmd === "L") {
      [x, y] = [num(), num()];
      pts.push({ x, y });
    } else {
      const c = cmd === "C" ? [num(), num(), num(), num()] : [num(), num()];
      const [ex, ey] = [num(), num()];
      for (let s = 1; s <= 24; s++) {
        const t = s / 24;
        const u = 1 - t;
        pts.push(
          cmd === "C"
            ? { x: u ** 3 * x + 3 * u * u * t * c[0]! + 3 * u * t * t * c[2]! + t ** 3 * ex, y: u ** 3 * y + 3 * u * u * t * c[1]! + 3 * u * t * t * c[3]! + t ** 3 * ey }
            : { x: u * u * x + 2 * u * t * c[0]! + t * t * ex, y: u * u * y + 2 * u * t * c[1]! + t * t * ey },
        );
      }
      [x, y] = [ex, ey];
    }
  }
  return pts;
}
function segDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const [d1, d2, d3, d4] = [cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d)];
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const toSeg = (p: Pt, s: Pt, e: Pt) => {
    const l2 = (e.x - s.x) ** 2 + (e.y - s.y) ** 2;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - s.x) * (e.x - s.x) + (p.y - s.y) * (e.y - s.y)) / l2)) : 0;
    return Math.hypot(p.x - s.x - t * (e.x - s.x), p.y - s.y - t * (e.y - s.y));
  };
  return Math.min(toSeg(a, c, d), toSeg(b, c, d), toSeg(c, a, b), toSeg(d, a, b));
}
function lineDist(p: Pt[], q: Pt[]): number {
  let m = Infinity;
  for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) m = Math.min(m, segDist(p[i - 1]!, p[i]!, q[j - 1]!, q[j]!));
  return m;
}
const EDGE_RE = /<path class="sm-edge [^"]*" d="([^"]+)"[^>]*data-sm-from="([^"]+)" data-sm-to="([^"]+)"/g;
interface DrawnLoop { name: string; x: number; side: "L" | "R"; lo: number; hi: number; ext: number; pts: Pt[] }
function drawnLoops(html: string): DrawnLoop[] {
  const rects = nodeRects(html);
  return [...html.matchAll(EDGE_RE)].flatMap((m) => {
    const [a, b] = [rects.get(m[2]!)!, rects.get(m[3]!)!];
    if (a.x !== b.x) return [];
    const pts = polyline(m[1]!);
    const [s, e] = [pts[0]!, pts.at(-1)!];
    return [{ name: `${m[2]}→${m[3]}`, x: s.x, side: s.x === a.x ? ("L" as const) : ("R" as const), lo: Math.min(s.y, e.y), hi: Math.max(s.y, e.y), ext: Math.max(...pts.map((p) => Math.abs(p.x - s.x))), pts }];
  });
}
function loopReport(html: string): { violations: string[]; crossings: number; loops: DrawnLoop[] } {
  const W = Number(/viewBox="0 0 ([\d.]+) /.exec(html)![1]);
  const rects = [...nodeRects(html).values()];
  const loops = drawnLoops(html);
  const lanes = [...html.matchAll(EDGE_RE)].flatMap((m) => {
    const q = [...m[1]!.matchAll(/Q([\d.]+) /g)].map((x) => Number(x[1]));
    return q.length === 4 ? [q[0]!, q[3]!] : [];
  });
  const out = routingViolations(html);
  let crossings = 0;
  for (let p = 0; p < loops.length; p++)
    for (let q = p + 1; q < loops.length; q++) {
      const [s, t] = [loops[p]!, loops[q]!];
      const dist = lineDist(s.pts, t.pts);
      if (dist < 0.8) crossings++;
      if (s.x !== t.x || s.side !== t.side) continue;
      const [outer, inner] = s.lo < t.lo && t.hi < s.hi ? [s, t] : t.lo < s.lo && s.hi < t.hi ? [t, s] : [null, null];
      if (outer && inner && (inner.ext >= outer.ext || dist < 2)) out.push(`L1 ${inner.name} (${inner.ext}) inside ${outer.name} (${outer.ext}), ${dist.toFixed(1)}px apart`);
    }
  for (const l of loops) {
    const far = l.side === "R" ? l.x + l.ext : l.x - l.ext;
    if (Math.min(...l.pts.map((p) => p.x)) < 12 - 0.01 || Math.max(...l.pts.map((p) => p.x)) > W - 12 + 0.01) out.push(`L3 ${l.name} within 12px of the drawing's edge`);
    if (l.side === "R") {
      const next = Math.min(...rects.map((r) => r.x).filter((x) => x > l.x));
      const near = Math.min(next, ...lanes.filter((x) => x > l.x && x < next), ...loops.filter((o) => o.side === "L" && o.x === next).map((o) => o.x - o.ext));
      if (far > near - 2) out.push(`L3 ${l.name} reaches ${far}, next line at ${near}`);
    } else {
      const prev = Math.max(...rects.map((r) => r.x + r.w).filter((x) => x < l.x));
      const near = Math.max(prev, ...lanes.filter((x) => x < l.x && x > prev));
      if (far < near + 2) out.push(`L3 ${l.name} reaches ${far}, previous line at ${near}`);
    }
  }
  return { violations: out, crossings, loops };
}

describe("loop invariants", () => {
  // Nodes stack in groups= order here, not first appearance, so a probe says its rows.
  const read = (groups: string, rows: string[][]) => {
    const r = readSystemMap({ groups }, T(["From", "To", "Protocol", "Status"], rows.map((row, i) => [row[0]!, row[1]!, row[2] ?? `p${i}`, "ok"])));
    const at = groups.split(";").map((g) => g.split("=")[0]);
    r.nodes.sort((p, q) => at.indexOf(p.key) - at.indexOf(q.key));
    return r;
  };
  const draw = (r: ReturnType<typeof readSystemMap>) =>
    systemMapViewHtml({ read: r, caption: "", tableHtml: "", beforeHtml: "", afterHtml: "", prefix: "sm9-", resolveNode: () => ({ kind: "repo", link: null }) });
  const probes: [string, string, string[][]][] = [
    // R9: a hub's core column, both directions to two neighbours.
    ["two-way edges in a hub's core column", "web=frontend;api=core;skjema=core;eessi=core;ext=external", [["web", "api"], ["api", "skjema"], ["skjema", "api"], ["api", "eessi"], ["eessi", "api"], ["api", "ext"]]],
    ["nested loops sharing an end, last column", "x=one;p=two;q=two;r=two", [["x", "p"], ["p", "q"], ["q", "r"], ["p", "r"]]],
    // R10: a self-loop inside an edge within its column.
    ["a self-loop inside a loop", "p=one;q=one;r=one;m=two", [["p", "m"], ["q", "q"], ["r", "m"], ["p", "r"]]],
    ["three self-loops, one inside a loop", "p=one;q=one;r=one", [["p", "p"], ["q", "q"], ["r", "r"], ["p", "r"]]],
    // R11: six loops in one column, the longest around the five others.
    ["six loops in column one", "p=one;q=one;r=one;s=one;t=one;u=one", [["p", "q"], ["q", "r"], ["r", "s"], ["s", "t"], ["t", "u"], ["p", "u"]]],
    ["two protocols over one span, and back", "a=one;b=one;c=two", [["a", "b", "REST"], ["a", "b", "Kafka"], ["b", "a", "REST"], ["a", "c"]]],
    ["two self-loops on one node", "a=one;b=two", [["a", "b"], ["a", "a", "REST"], ["a", "a", "Kafka"]]],
    [
      "a nested chain six deep, with trunks in the gap after it",
      [...Array.from({ length: 12 }, (_, i) => `n${i}=one`), "m=two", "z=three"].join(";"),
      [["n0", "m"], ...Array.from({ length: 6 }, (_, i) => [`n${i}`, `n${11 - i}`]), ["n0", "z"], ["n11", "z"], ["n5", "z"]],
    ],
    ["ten loops from one node", [...Array.from({ length: 11 }, (_, i) => `w${i}=one`), "x=two"].join(";"), [...Array.from({ length: 10 }, (_, i) => ["w0", `w${i + 1}`]), ["w0", "x"], ["w0", "w0"]]],
    ["loops on facing sides of one gap", "a=one;b=one;c=one;d=one;p=two;q=two;r=two;s=two", [["a", "c"], ["b", "d"], ["p", "r"], ["q", "s"], ["a", "p"]]],
  ];
  for (const [name, groups, rows] of probes)
    test(`L1, L3, L4 hold and no loops cross: ${name}`, () => {
      const rep = loopReport(draw(read(groups, rows)));
      expect(rep.violations).toEqual([]);
      expect(rep.crossings).toBe(0);
    });

  test("partly overlapping loops take opposite sides; the first keeps the right", () => {
    const rep = loopReport(draw(read("p=one;q=one;r=one;s=one", [["p", "r"], ["q", "s"]])));
    expect(rep.loops.map((l) => [l.name, l.side])).toEqual([["p→r", "R"], ["q→s", "L"]]);
    expect(rep.crossings).toBe(0);
  });

  test("three loops overlapping pairwise: one crossing, declared by the layout", () => {
    const r = read("p=one;q=one;r=one;s=one;t=one;u=one", [["p", "s"], ["q", "t"], ["r", "u"]]);
    const rep = loopReport(draw(r));
    expect(rep.violations).toEqual([]);
    expect(rep.crossings).toBe(1);
    expect(layoutSystemMap(r.nodes, r.columns, r.rows).loopCrossings).toBe(1);
  });

  test("loops on both sides of one column fit the drawing with a 12px margin each side", () => {
    // r→u overlaps p→t and q→s, so it goes left; q→s nests inside p→t on the right.
    const html = draw(read("p=one;q=one;r=one;s=one;t=one;u=one", [["p", "t"], ["q", "s"], ["r", "u"]]));
    const rep = loopReport(html);
    expect(rep.loops.map((l) => l.side)).toEqual(["R", "R", "L"]);
    expect(rep.violations).toEqual([]);
    expect(rep.crossings).toBe(0);
  });

  test("a deep nest widens the gap after its column, and the lanes keep clear of it", () => {
    const [, groups, rows] = probes.find(([n]) => n.startsWith("a nested chain"))!;
    const html = draw(read(groups, rows));
    const reaches = loopReport(html).loops.map((l) => l.ext).sort((p, q) => p - q);
    expect(new Set(reaches).size).toBe(6);
    expect(reaches.at(-1)!).toBeGreaterThan(24);
  });

  // L1–L4 over random maps: loops within a column and on one node, nested
  // chains, overlapping pairs, identical spans, with edges across columns.
  test("L1–L4 hold over 240 random maps", () => {
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const failures: string[] = [];
    let [loopsSeen, declaredSeen, maxPerColumn] = [0, 0, 0];
    for (let seed = 1; seed <= 240; seed++) {
      const rand = rng(seed);
      const int = (n: number) => Math.floor(rand() * n);
      const cols = Array.from({ length: 1 + int(4) }, (_, c) => Array.from({ length: 2 + int(6) }, (_, k) => `c${c}n${k}`));
      const rows: string[][] = [];
      for (const [c, col] of cols.entries()) {
        const want = c === seed % cols.length ? int(13) : int(4);
        const loops: string[][] = [];
        const n = col.length;
        while (loops.length < want) {
          const kind = int(5);
          const [i, j] = [int(n), int(n)];
          if (kind === 0) loops.push([col[i]!, col[j]!]);
          else if (kind === 1) loops.push([col[i]!, col[i]!]);
          else if (kind === 2) for (let [a, b] = [Math.min(i, j), Math.max(i, j)]; a < b; a++, b--) loops.push([col[a]!, col[b]!]);
          else if (kind === 3 && n >= 4) {
            const a = int(n - 3);
            loops.push([col[a]!, col[a + 2]!], [col[a + 1]!, col[a + 3]!]);
          } else if (i !== j) loops.push([col[i]!, col[j]!], int(2) ? [col[j]!, col[i]!] : [col[i]!, col[j]!]);
        }
        rows.push(...loops.slice(0, want));
        maxPerColumn = Math.max(maxPerColumn, want);
      }
      for (let k = int(9); k > 0; k--) {
        const [a, b] = [int(cols.length), int(cols.length)];
        if (a !== b) rows.push([cols[a]![int(cols[a]!.length)]!, cols[b]![int(cols[b]!.length)]!]);
      }
      if (!rows.length) continue;
      const r = read(cols.flatMap((col, c) => col.map((k) => `${k}=c${c}`)).join(";"), rows);
      const html = draw(r);
      const rep = loopReport(html);
      loopsSeen += rep.loops.length;
      const declared = layoutSystemMap(r.nodes, r.columns, r.rows).loopCrossings;
      declaredSeen += declared ?? 0;
      // Whether every column's partly overlapping within-column loops 2-colour.
      const rects = nodeRects(html);
      const spans = r.rows.flatMap((row) => {
        const [a, b] = [rects.get(nodeKey(row.from))!, rects.get(nodeKey(row.to))!];
        return a.x === b.x && a !== b ? [{ x: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) }] : [];
      });
      const color = new Map<number, number>();
      let bipartite = true;
      for (let s = 0; s < spans.length; s++) {
        if (color.has(s)) continue;
        color.set(s, 0);
        const queue = [s];
        while (queue.length) {
          const u = queue.shift()!;
          for (let v = 0; v < spans.length; v++) {
            const [p, q] = [spans[u]!, spans[v]!];
            if (p.x !== q.x || !((p.lo < q.lo && q.lo < p.hi && p.hi < q.hi) || (q.lo < p.lo && p.lo < q.hi && q.hi < p.hi))) continue;
            if (!color.has(v)) {
              color.set(v, 1 - color.get(u)!);
              queue.push(v);
            } else if (color.get(v) === color.get(u)) bipartite = false;
          }
        }
      }
      const why = [...rep.violations];
      if (rep.crossings !== declared) why.push(`${rep.crossings} crossings drawn, ${declared} declared`);
      if (bipartite && rep.crossings !== 0) why.push(`${rep.crossings} crossings where the overlaps 2-colour`);
      if (why.length) failures.push(`seed ${seed}: ${why.slice(0, 3).join("; ")}`);
    }
    expect(failures.slice(0, 8)).toEqual([]);
    // The generator reaches the cases it is for.
    expect(loopsSeen).toBeGreaterThan(600);
    expect(declaredSeen).toBeGreaterThan(0);
    expect(maxPerColumn).toBe(12);
  });
});
