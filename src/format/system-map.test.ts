/**
 * `<SystemMap>`: the parser (`system-map.ts`), the reader's view
 * (`system-map-view.ts`) and what every other surface prints (the table).
 * Synthetic names only.
 */

import { describe, expect, test } from "bun:test";
import { nodeKey, parseExternalList, parseGroups, readSystemMap, resolveSystemNode, type SystemMapTable } from "./system-map.ts";
import { layoutSystemMap, SYSTEM_MAP_CHROME_CLASSES, systemMapCss, systemMapViewHtml } from "./system-map-view.ts";
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
    expect(html).toContain('<section class="sm" role="figure" aria-label="System map: Systems">');
  });

  test("a wrong edge is marked and its title names the reason; ids carry the prefix", () => {
    expect(html).toContain('class="sm-edge sm-wrong"');
    expect(html).toContain("<title>api → Reg · SOAP · wrong · replaced by a queue</title>");
    expect(html).toContain('marker-end="url(#sm1-arr-wrong)"');
    expect(html).toContain('<marker id="sm1-arr-ok"');
  });

  test("a repo node is a reader link; an external and an unresolved node are not", () => {
    expect(html).toContain('<a class="sm-node sm-repo" href="/wiki?relPath=repos%2Fweb.md" data-relpath="repos/web.md" data-wiki-page="web"');
    expect(html).toMatch(/<g class="sm-node sm-external sm-nopage" data-sm-node="reg">/);
    expect(html).toMatch(/<g class="sm-node sm-unresolved" data-sm-node="typo"><title>typo — names no repos\/ page<\/title>/);
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

  test("a node's many edges leave its side at different points", () => {
    const starts = [...html.matchAll(/<path class="sm-edge [^"]*" d="M([\d.]+) ([\d.]+)[^"]*"[^>]*data-sm-from="api"/g)].map((m) => `${m[1]},${m[2]}`);
    expect(starts.length).toBe(services.length + externals.length + 3);
    expect(new Set(starts).size).toBe(starts.length);
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
    expect(html).toContain('<div class="sm-caption" data-reader-only="">Systems &amp; co</div><div class="sm-map"');
  });

  test("one name per level: the figure names the map, the scroll box is the drawing, the SVG repeats neither", () => {
    expect(html).toContain('<section class="sm" role="figure" aria-label="System map: Systems &amp; co">');
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
    expect(html).toContain('<g class="sm-node sm-external sm-nopage" data-sm-node="gone"><title>Gone — external, no page</title>');
    expect(html).toContain('<g class="sm-node sm-unresolved" data-sm-node="typo"><title>typo — names no repos/ page</title>');
  });

  test("the legend under the map names only the styles drawn on it", () => {
    const legend = /<ul class="sm-legend" data-reader-only="">(.*?)<\/ul>/.exec(html)![1]!;
    const items = [...legend.matchAll(/<\/svg>([^<]+)<\/li>/g)].map((m) => m[1]);
    expect(items).toEqual(["Repo, opens its page", "External, opens its page", "External, no page", "Names no repos/ page", "Edge: ok", "Edge: wrong"]);
    expect(html.indexOf("sm-legend")).toBeGreaterThan(html.indexOf("</svg></div>"));
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
