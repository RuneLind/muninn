import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import {
  projectAtlas,
  HUB_MIN_INBOUND,
  TYPE_CAP_FULL,
  TYPE_CAP_TOP,
  MONTH_CAP,
} from "./atlas.ts";

/** Write a wiki tree from a {relPath: content} map under a fresh temp dir. */
async function makeWiki(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wiki-atlas-"));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await Bun.write(path.join(root, rel), content);
  }
  return root;
}

function source(opts: { title?: string; created?: string; pubDate?: string; body?: string; links?: string[] }): string {
  const fm = ["---", "type: source"];
  if (opts.title) fm.push(`title: "${opts.title}"`);
  if (opts.created) fm.push(`created: ${opts.created}`);
  fm.push("---", "");
  const lines = [fm.join("\n"), "# Heading", ""];
  if (opts.pubDate) lines.push(`Source: YouTube, ${opts.pubDate} — https://x`, "");
  if (opts.body) lines.push(opts.body, "");
  for (const l of opts.links ?? []) lines.push(`Links [[${l}]].`);
  return lines.join("\n");
}

describe("projectAtlas", () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  });
  const track = (r: string) => (roots.push(r), r);

  test("all seven keys present; types in Atlas source-first order, note/explainer dropped", async () => {
    const root = track(
      await makeWiki({
        "sources/A.md": source({ title: "A", pubDate: "2026-03-25", body: "First source prose." }),
        "concepts/C.md": "---\ntype: concept\n---\n\nA concept blurb.",
        "entities/E.md": "---\ntype: entity\n---\n\nAn entity.",
        "analyses/An.md": "---\ntype: analysis\n---\n\nAn analysis.",
        "notes/N.md": "---\ntype: note\n---\n\nA note.",
        "explain.html": "<html><head><title>X</title></head><body>hi</body></html>",
      }),
    );
    const atlas = projectAtlas(await buildWikiIndex(root));
    // All seven keys.
    for (const k of ["types", "nodes", "monthKeys", "months", "topics", "trails", "omitted"]) {
      expect(atlas).toHaveProperty(k);
    }
    // Source-first order, note + explainer columns dropped.
    expect(atlas.types.map((t) => t.key)).toEqual(["source", "concept", "entity", "analysis"]);
    expect(atlas.types.find((t) => t.key === "source")!.label).toBe("Sources");
    // A note/explainer never becomes a node.
    const nodeTypes = new Set(Object.values(atlas.nodes).map((n) => n.t));
    expect(nodeTypes.has("note")).toBe(false);
    expect(nodeTypes.has("explainer")).toBe(false);
    // Desc + date flow through onto the node.
    const a = Object.values(atlas.nodes).find((n) => n.name === "A")!;
    expect(a.desc).toBe("First source prose.");
    expect(a.date).toBe("2026-03-25");
  });

  test("date-fallback chain: pubDate → created → mtime", async () => {
    const root = track(
      await makeWiki({
        // pubDate wins over created.
        "sources/Pub.md": source({ title: "Pub", created: "2026-01-01", pubDate: "2026-03-25" }),
        // no pubDate ⇒ created.
        "sources/Cre.md": source({ title: "Cre", created: "2026-02-10" }),
        // no pubDate, no created ⇒ mtime (whatever month the test runs in).
        "sources/Mt.md": source({ title: "Mt" }),
      }),
    );
    const atlas = projectAtlas(await buildWikiIndex(root));
    const byName = (n: string) => Object.values(atlas.nodes).find((x) => x.name === n)!;
    expect(byName("Pub").date).toBe("2026-03-25");
    expect(byName("Cre").date).toBe("2026-02-10");
    // Mt fell back to mtime — a real YYYY-MM-DD, just not one of the fixtures.
    expect(byName("Mt").date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Each dated source lands in the month matching its resolved date.
    expect(atlas.months["2026-03"]).toContain("sources/pub.md");
    expect(atlas.months["2026-02"]).toContain("sources/cre.md");
    expect(atlas.monthKeys).toEqual([...atlas.monthKeys].sort()); // ascending
  });

  test("generic caps: a column over TYPE_CAP_FULL shows TYPE_CAP_TOP, rest omitted", async () => {
    const files: Record<string, string> = {};
    const n = TYPE_CAP_FULL + 5;
    for (let i = 0; i < n; i++) {
      files[`entities/E${String(i).padStart(3, "0")}.md`] = `---\ntype: entity\n---\n\nEntity ${i}.`;
    }
    const root = track(await makeWiki(files));
    const atlas = projectAtlas(await buildWikiIndex(root));
    const entityNodes = Object.values(atlas.nodes).filter((x) => x.t === "entity");
    expect(entityNodes).toHaveLength(TYPE_CAP_TOP);
    expect(atlas.omitted.byType.entity).toBe(n - TYPE_CAP_TOP);

    // A column at/under the full cap shows everything, nothing omitted.
    const small: Record<string, string> = {};
    for (let i = 0; i < TYPE_CAP_FULL; i++) {
      small[`concepts/C${i}.md`] = `---\ntype: concept\n---\n\nConcept ${i}.`;
    }
    const root2 = track(await makeWiki(small));
    const atlas2 = projectAtlas(await buildWikiIndex(root2));
    expect(Object.values(atlas2.nodes).filter((x) => x.t === "concept")).toHaveLength(TYPE_CAP_FULL);
    expect(atlas2.omitted.byType.concept).toBeUndefined();
  });

  test("month cap: visible per month bounded, overflow in omitted.byMonth", async () => {
    const files: Record<string, string> = {};
    const n = MONTH_CAP + 4;
    for (let i = 0; i < n; i++) {
      files[`sources/S${String(i).padStart(3, "0")}.md`] = source({
        title: `S${i}`,
        pubDate: "2026-04-13",
      });
    }
    const root = track(await makeWiki(files));
    const atlas = projectAtlas(await buildWikiIndex(root));
    expect(atlas.months["2026-04"]).toHaveLength(MONTH_CAP);
    expect(atlas.omitted.byMonth["2026-04"]).toBe(n - MONTH_CAP);
  });

  test("hub flag: source with ≥ HUB_MIN_INBOUND inbound is a hub, others are not", async () => {
    const files: Record<string, string> = {
      "sources/Hub.md": source({ title: "Hub", pubDate: "2026-03-01" }),
      "sources/Lonely.md": source({ title: "Lonely", pubDate: "2026-03-01" }),
    };
    // HUB_MIN_INBOUND concept pages each link to Hub.
    for (let i = 0; i < HUB_MIN_INBOUND; i++) {
      files[`concepts/L${String(i).padStart(3, "0")}.md`] = `---\ntype: concept\n---\n\nLinks [[Hub]].`;
    }
    const root = track(await makeWiki(files));
    const atlas = projectAtlas(await buildWikiIndex(root));
    const hub = Object.values(atlas.nodes).find((x) => x.name === "Hub")!;
    const lonely = Object.values(atlas.nodes).find((x) => x.name === "Lonely")!;
    expect(hub.in).toBeGreaterThanOrEqual(HUB_MIN_INBOUND);
    expect(hub.hub).toBe(true);
    expect(lonely.hub).toBe(false);
    // Hubness is source-only: a heavily-linked concept is never a hub.
    expect(Object.values(atlas.nodes).every((n) => !n.hub || n.t === "source")).toBe(true);
  });

  test("topics: top concepts by linked-source count, perMonth aligned to monthKeys", async () => {
    const root = track(
      await makeWiki({
        "concepts/Skills.md": "---\ntype: concept\n---\n\nThe skills system.",
        "sources/S1.md": source({ title: "S1", pubDate: "2026-02-15", links: ["Skills"] }),
        "sources/S2.md": source({ title: "S2", pubDate: "2026-03-20", links: ["Skills"] }),
        "sources/S3.md": source({ title: "S3", pubDate: "2026-03-25", links: ["Skills"] }),
      }),
    );
    const atlas = projectAtlas(await buildWikiIndex(root));
    const skills = atlas.topics.find((t) => t.name === "Skills")!;
    expect(skills.count).toBe(3);
    expect(skills.desc).toBe("The skills system.");
    // perMonth aligns with monthKeys: one in 2026-02, two in 2026-03.
    expect(skills.perMonth).toHaveLength(atlas.monthKeys.length);
    const feb = atlas.monthKeys.indexOf("2026-02");
    const mar = atlas.monthKeys.indexOf("2026-03");
    expect(skills.perMonth[feb]).toBe(1);
    expect(skills.perMonth[mar]).toBe(2);
    expect(skills.perMonth.reduce((a, b) => a + b, 0)).toBe(3);
  });

  test("links on a node are filtered to other picked relPaths only", async () => {
    const root = track(
      await makeWiki({
        "concepts/A.md": "---\ntype: concept\n---\n\nLinks [[B]] and [[Nope]].",
        "concepts/B.md": "---\ntype: concept\n---\n\nB.",
      }),
    );
    const atlas = projectAtlas(await buildWikiIndex(root));
    const a = atlas.nodes["concepts/a.md"]!;
    expect(a.links).toEqual(["concepts/b.md"]); // [[Nope]] resolves to nothing → dropped
  });

  test("custom ontology (mimir typeMap) + colliding stems in different folders stay distinct", async () => {
    const root = track(
      await makeWiki({
        ".wiki-reader.json": JSON.stringify({
          typeMap: { projects: "subsystem", plans: "plan" },
          typeLabels: { subsystem: "Subsystems", plan: "Plans" },
        }),
        // Two DIFFERENT pages sharing the stem `architecture.md`.
        "projects/muninn/architecture.md": "---\ntype: subsystem\n---\n\nMuninn architecture.",
        "projects/huginn/architecture.md": "---\ntype: subsystem\n---\n\nHuginn architecture.",
        "plans/roadmap.md": "---\ntype: plan\n---\n\nThe roadmap.",
      }),
    );
    const atlas = projectAtlas(await buildWikiIndex(root));
    // Custom types become columns with their configured labels (no standard type present).
    const keys = atlas.types.map((t) => t.key);
    expect(keys).toContain("subsystem");
    expect(keys).toContain("plan");
    expect(atlas.types.find((t) => t.key === "subsystem")!.label).toBe("Subsystems");
    // Colliding stems keep DISTINCT relPath-keyed nodes, each with its own name+desc.
    expect(atlas.nodes["projects/muninn/architecture.md"]!.desc).toBe("Muninn architecture.");
    expect(atlas.nodes["projects/huginn/architecture.md"]!.desc).toBe("Huginn architecture.");
    expect(atlas.nodes["projects/muninn/architecture.md"]!.name).toBe("architecture");
    expect(atlas.nodes["projects/huginn/architecture.md"]!.name).toBe("architecture");
  });

  test("unresolved trail steps are kept and flagged resolved:false", async () => {
    const root = track(
      await makeWiki({
        "sources/Real.md": source({ title: "Real", pubDate: "2026-03-01" }),
        "trails.json": JSON.stringify([
          {
            title: "Start here",
            blurb: "A curated path.",
            steps: [
              { page: "Real", note: "read this" },
              { page: "Ghost", note: "does not exist" },
            ],
          },
        ]),
      }),
    );
    const atlas = projectAtlas(await buildWikiIndex(root));
    expect(atlas.trails).toHaveLength(1);
    const [real, ghost] = atlas.trails[0]!.steps;
    expect(real).toEqual({ page: "Real", note: "read this", resolved: true });
    expect(ghost).toEqual({ page: "Ghost", note: "does not exist", resolved: false });
    expect(atlas.trails[0]!.blurb).toBe("A curated path.");
  });

  test("wiki with no dates and no trails still returns a valid payload", async () => {
    // A frontmatter-less, source-less wiki: pages fall back to mtime for months.
    const root = track(
      await makeWiki({
        "concepts/A.md": "---\ntype: concept\n---\n\nConcept A.",
        "entities/B.md": "---\ntype: entity\n---\n\nEntity B.",
      }),
    );
    const atlas = projectAtlas(await buildWikiIndex(root));
    expect(atlas.trails).toEqual([]);
    expect(atlas.topics).toEqual([]); // no source links ⇒ no topics
    // No `source` type ⇒ months bucket the non-note population by mtime.
    expect(atlas.monthKeys.length).toBeGreaterThan(0);
    expect(atlas.types.map((t) => t.key)).toEqual(["concept", "entity"]);
  });

  test("projection purity: works from the cached index after the wiki dir is deleted", async () => {
    const root = await makeWiki({
      "sources/A.md": source({ title: "A", pubDate: "2026-03-25", body: "Prose." }),
      "concepts/C.md": "---\ntype: concept\n---\n\nConcept.",
    });
    const index = await buildWikiIndex(root);
    // Remove every page file — a pure projection must not touch disk.
    await rm(root, { recursive: true, force: true });
    const first = projectAtlas(index);
    const second = projectAtlas(index);
    expect(first).toEqual(second);
    expect(Object.keys(first.nodes).length).toBeGreaterThan(0);
    expect(first.types.map((t) => t.key)).toEqual(["source", "concept"]);
  });
});
