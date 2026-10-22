/**
 * `<SystemMap>`: the parser (`system-map.ts`), the reader's view
 * (`system-map-view.ts`) and what every other surface prints (the table).
 * Synthetic names only.
 */

import { describe, expect, test } from "bun:test";
import { nodeKey, parseExternalList, parseGroups, readSystemMap, resolveSystemNode, type SystemMapTable } from "./system-map.ts";
import { layoutSystemMap, SYSTEM_MAP_CHROME_CLASSES, systemMapViewHtml } from "./system-map-view.ts";
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
    expect(html).toMatch(/<g class="sm-node sm-external" data-sm-node="reg">/);
    expect(html).toMatch(/<g class="sm-node sm-unresolved" data-sm-node="typo"><title>typo — names no repos\/ page<\/title>/);
  });

  test("the map and the findings are reader-only and carry no newline (paragraphGaps)", () => {
    expect(html).toContain('<div class="sm-map" data-reader-only=""');
    expect(html).not.toContain("\n");
  });

  test("a map it cannot draw shows its findings over the table", () => {
    const fb = systemMapViewHtml({ read: readSystemMap({}, null), caption: "", tableHtml: "", beforeHtml: "<p>x</p>", afterHtml: "", prefix: "sm2-", resolveNode: () => ({ kind: "unresolved", link: null }) });
    expect(fb).toBe('<section class="sm sm-fallback"><p>x</p><ul class="sm-notes" data-reader-only=""><li>holds no pipe table</li></ul></section>');
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
