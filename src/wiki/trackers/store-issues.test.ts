/**
 * Issue refs through the real index build, and the facet over them.
 *
 * Two temp wikis carrying the SAME pages, one with a `trackers` block in its
 * `.wiki-reader.json` and one without. The second pins the hard rule: on a
 * wiki with no tracker, no page carries `issues` and every facet consumer
 * answers exactly the stamped `jira:` lines, as before. Synthetic keys
 * (`DEMO`) and host (`example.invalid`) — muninn is a public repo.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetWikiCacheForTest, getWikiIndex, type WikiIndex } from "../store.ts";
import { jiraCounts } from "../provenance.ts";
import { compactIssues } from "./index.ts";
import {
  facetJiraKeys,
  filterPages,
  jiraChipCounts,
  jiraChipRow,
  type WikiFilters,
  type WikiListing,
} from "../../dashboard/views/components/wiki-filter.ts";

const url = (k: string) => `https://example.invalid/browse/${k}`;

const TRACKERS = {
  trackers: [
    {
      id: "jira",
      projects: ["DEMO"],
      hosts: ["example.invalid"],
      frontmatterKeys: ["issue"],
      createdMarkers: ["opprettet"],
    },
  ],
};

const PAGES: Record<string, string> = {
  // Stamped, as a list.
  "stamped.md": "---\ntitle: Stamped page\njira: [DEMO-101]\n---\n\nBody.\n",
  // Stamped, as a prose scalar: two keys on a tracker wiki, a typo today.
  "scalar.md": "---\ntitle: Scalar page\njira: DEMO-102 (kilde), epic DEMO-103\n---\n\nBody.\n",
  // Inferred only: title, tag, a created link, and a mention.
  "inferred.md":
    "---\ntitle: DEMO-104 notes\ntags: [demo-105]\n---\n\n" +
    `Opprettet: [DEMO-106](${url("DEMO-106")}). Also DEMO-107 in passing.\n`,
  // Declared and stem.
  "plans/2026-01-02-demo-108-plan.md": "---\ntype: plan\nissue: DEMO-109\n---\n\nBody.\n",
  // Mention only: carries `issues`, but the listing and the facet see nothing.
  "mention.md": "---\ntitle: Mention page\n---\n\nSee DEMO-101 elsewhere.\n",
  // No key at all.
  "plain.md": "---\ntitle: Plain page\n---\n\nNothing here. ORA-01407 is not ours.\n",
  // Bookkeeping: never inferred from.
  "index.md": "---\ntitle: DEMO-110 index\n---\n\n[DEMO-111](https://example.invalid/browse/DEMO-111)\n",
  // An explainer: its <title> counts, its body link never does.
  "explainer.html":
    "<!doctype html><html><head><title>DEMO-112 explained</title>" +
    '<meta name="keywords" content="demo-113, other"></head><body>' +
    `<a href="${url("DEMO-114")}">DEMO-114</a></body></html>`,
};

let tracked: WikiIndex;
let plain: WikiIndex;
const roots: string[] = [];

async function build(withTrackers: boolean): Promise<WikiIndex> {
  const root = await mkdtemp(path.join(tmpdir(), "tracker-store-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(PAGES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  }
  if (withTrackers) await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(TRACKERS));
  __resetWikiCacheForTest();
  return (await getWikiIndex({ root, refresh: true }))!;
}

beforeAll(async () => {
  tracked = await build(true);
  plain = await build(false);
});

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const issuesOf = (index: WikiIndex, rel: string) =>
  Object.fromEntries((index.resolveRelPath(rel)!.issues ?? []).map((r) => [r.key, r.relations]));

/** The listing rows the client holds: the compact `issues` form. */
function listing(index: WikiIndex): WikiListing[] {
  return index.pages.map((p) => {
    const { issues, ...rest } = p;
    const compact = compactIssues(issues);
    return { ...rest, ...(compact ? { issues: compact } : {}), linkCount: 0, backlinkCount: 0 } as WikiListing;
  });
}

const NO_FILTERS: WikiFilters = {
  q: "",
  domain: "",
  folder: "",
  type: "",
  tag: "",
  status: "",
  followups: "",
  project: "",
  jira: "",
};

describe("buildWikiIndex on a wiki with a tracker", () => {
  test("each page carries its refs, every relation kept", () => {
    expect(issuesOf(tracked, "stamped.md")).toEqual({ "DEMO-101": ["stamped"] });
    expect(issuesOf(tracked, "scalar.md")).toEqual({ "DEMO-102": ["stamped"], "DEMO-103": ["stamped"] });
    expect(issuesOf(tracked, "inferred.md")).toEqual({
      "DEMO-104": ["title"],
      "DEMO-105": ["tag"],
      "DEMO-106": ["created", "link", "mention"],
      "DEMO-107": ["mention"],
    });
    expect(issuesOf(tracked, "plans/2026-01-02-demo-108-plan.md")).toEqual({
      "DEMO-109": ["declared"],
      "DEMO-108": ["stem"],
    });
  });

  test("issues is ABSENT on a page with none, on a bookkeeping page, and never []", () => {
    for (const rel of ["plain.md", "index.md"]) {
      expect("issues" in tracked.resolveRelPath(rel)!).toBe(false);
    }
  });

  test("an .html page infers from its <head> only", () => {
    expect(issuesOf(tracked, "explainer.html")).toEqual({ "DEMO-112": ["title"], "DEMO-113": ["tag"] });
  });

  test("the stamped jira field itself is unchanged", () => {
    expect(tracked.resolveRelPath("scalar.md")!.jira).toEqual(plain.resolveRelPath("scalar.md")!.jira!);
  });
});

describe("the Jira facet over stamped and inferred", () => {
  test("a chip's count equals the rows left after clicking it", () => {
    const rows = listing(tracked);
    const known = jiraCounts(tracked.pages);
    const chips = jiraChipCounts(rows, known, "", "", "");
    expect(Object.keys(known).sort()).toEqual(
      ["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104", "DEMO-105", "DEMO-106", "DEMO-108", "DEMO-109", "DEMO-112", "DEMO-113"].sort(),
    );
    for (const key of Object.keys(known)) {
      const left = filterPages(rows, { ...NO_FILTERS, jira: key });
      expect({ key, rows: left.length }).toEqual({ key, rows: known[key]! });
      expect({ key, rows: chips[key] }).toEqual({ key, rows: known[key]! });
    }
    // A mention alone is not a facet key: DEMO-107 has no chip and no rows.
    expect(known["DEMO-107"]).toBeUndefined();
  });

  test("the compact listing field drops mention", () => {
    const row = listing(tracked).find((p) => p.relPath === "mention.md")!;
    expect(row.issues).toBeUndefined();
    expect(facetJiraKeys(row)).toEqual([]);
  });
});

describe("a wiki with NO trackers block keeps today's behaviour", () => {
  test("no page carries issues", () => {
    expect(plain.pages.some((p) => "issues" in p)).toBe(false);
  });

  test("the facet counts exactly the stamped, key-shaped jira values", () => {
    // What the facet counted before this change, restated: `p.jira`, shape-filtered.
    const before: Record<string, number> = {};
    for (const p of plain.pages) {
      for (const k of new Set(p.jira ?? [])) {
        if (/^[A-Z][A-Z0-9]*-[0-9]+$/.test(k)) before[k] = (before[k] ?? 0) + 1;
      }
    }
    expect(jiraCounts(plain.pages)).toEqual(before);
    expect(before).toEqual({ "DEMO-101": 1 });
    const rows = listing(plain);
    expect(filterPages(rows, { ...NO_FILTERS, jira: "DEMO-101" }).map((p) => p.relPath)).toEqual(["stamped.md"]);
    expect(jiraChipCounts(rows, before, "", "", "")).toEqual(before);
  });
});

describe("jiraChipRow", () => {
  const counts = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`DEMO-${150 + i}`, 20 - i]),
  ) as Record<string, number>;

  test("the top eight by count, then a +N", () => {
    const row = jiraChipRow(counts, "", false);
    expect(row.keys).toEqual(Array.from({ length: 8 }, (_, i) => `DEMO-${150 + i}`));
    expect(row.hidden).toBe(4);
  });

  test("a key selected from the URL outside the top eight is always shown", () => {
    const row = jiraChipRow(counts, "DEMO-161", false);
    expect(row.keys).toContain("DEMO-161");
    expect(row.keys).toHaveLength(9);
    expect(row.hidden).toBe(3);
  });

  test("expanded shows every key; a short row has no expander", () => {
    expect(jiraChipRow(counts, "", true)).toEqual({ keys: Object.keys(counts), hidden: 0 });
    expect(jiraChipRow({ "DEMO-150": 1 }, "", false)).toEqual({ keys: ["DEMO-150"], hidden: 0 });
  });
});
