import { describe, expect, test } from "bun:test";
import { clauseBoundaries, inferJiraIssues, titleKeys } from "./jira.ts";
import { inferIssues, isPlanTitle, parseTrackersConfig } from "./index.ts";
import type { IssueRef, TrackerConfig, TrackerPage } from "./types.ts";

/** Synthetic throughout: the `DEMO` project and the `example.invalid` host. */
const CONFIG: TrackerConfig = parseTrackersConfig(
  [
    {
      id: "jira",
      projects: ["DEMO"],
      hosts: ["example.invalid"],
      frontmatterKeys: ["issue", "tickets"],
      planTitle: "plan(er|en)?(?!\\p{L})",
      planTitleExclude: "testplan|review av",
      createdMarkers: ["opprettet", "created"],
    },
  ],
  () => {
    throw new Error("the fixture config must parse clean");
  },
)[0]!;

function page(over: Partial<TrackerPage>): TrackerPage {
  return {
    relPath: "notes/page.md",
    stem: "page",
    kind: "markdown",
    frontmatter: {},
    authoredTitle: undefined,
    tags: [],
    body: "",
    ...over,
  };
}

/** key → relations, for compact assertions. */
function rels(refs: IssueRef[]): Record<string, string[]> {
  return Object.fromEntries(refs.map((r) => [r.key, r.relations]));
}

const url = (k: string) => `https://example.invalid/browse/${k}`;

describe("stamped", () => {
  test("every key-shaped token in a list or a scalar, prose included", () => {
    const refs = inferJiraIssues(
      page({ frontmatter: { jira: "DEMO-101 (kilde), ny ticket under epic DEMO-102 (oppfølging)" } }),
      CONFIG,
    );
    expect(rels(refs)).toEqual({ "DEMO-101": ["stamped"], "DEMO-102": ["stamped"] });
    expect(rels(inferJiraIssues(page({ frontmatter: { jira: ["demo-103", "DEMO-104"] } }), CONFIG))).toEqual({
      "DEMO-103": ["stamped"],
      "DEMO-104": ["stamped"],
    });
  });

  test("is NOT project-bounded — the stamped line is the page's own claim", () => {
    expect(rels(inferJiraIssues(page({ frontmatter: { jira: ["OTHER-7"] } }), CONFIG))).toEqual({
      "OTHER-7": ["stamped"],
    });
  });
});

describe("declared", () => {
  test("keys in the configured frontmatterKeys, list or scalar, project-bounded", () => {
    const refs = inferJiraIssues(
      page({ frontmatter: { issue: "DEMO-110", tickets: ["DEMO-111", "OTHER-5"], epic: "DEMO-112" } }),
      CONFIG,
    );
    // `epic:` is not configured; `OTHER-5` is outside the project.
    expect(rels(refs)).toEqual({ "DEMO-110": ["declared"], "DEMO-111": ["declared"] });
  });
});

describe("title", () => {
  test("keys in the authored title, with both shorthands expanded", () => {
    expect(titleKeys("DEMO-145/174 — plan for splitting", CONFIG)).toEqual(["DEMO-145", "DEMO-174"]);
    expect(titleKeys("DEMO-158 + 169 — implementasjonsplan", CONFIG)).toEqual(["DEMO-158", "DEMO-169"]);
    // A two-digit shorthand is prose, not a key: "+ 2 andre saker".
    expect(titleKeys("DEMO-145 + 2 andre saker", CONFIG)).toEqual(["DEMO-145"]);
  });

  test("reads the authored title only — a page with no title line infers nothing from it", () => {
    const refs = inferJiraIssues(page({ stem: "notes", authoredTitle: undefined }), CONFIG);
    expect(refs).toEqual([]);
  });

  test("projects bound the title: an Oracle error, a case number and a repo tag are not keys", () => {
    const refs = inferJiraIssues(
      page({
        authoredTitle: "Pitfall (ORA-01407) seen on SAK-4711 in demo-api",
        tags: ["demo-api", "ora-01407"],
      }),
      CONFIG,
    );
    expect(refs).toEqual([]);
  });

  test("an .html page reads its <title> element", () => {
    const refs = inferJiraIssues(
      page({ kind: "html", relPath: "x/explainer.html", stem: "explainer", authoredTitle: "DEMO-150 explained" }),
      CONFIG,
    );
    expect(rels(refs)).toEqual({ "DEMO-150": ["title"] });
  });
});

describe("stem and tag", () => {
  test("stem: a project key in the filename, case-insensitive, uppercased", () => {
    const refs = inferJiraIssues(page({ stem: "2026-01-02-demo-160-rollout-plan" }), CONFIG);
    expect(rels(refs)).toEqual({ "DEMO-160": ["stem"] });
  });

  test("tag: a tag that IS a project key; a tag that merely starts like one is not", () => {
    const refs = inferJiraIssues(page({ tags: ["demo-170", "demo-api", "demo-171-notes"] }), CONFIG);
    expect(rels(refs)).toEqual({ "DEMO-170": ["tag"] });
  });
});

describe("link and created here", () => {
  test("link: browse/KEY on a configured host only", () => {
    const refs = inferJiraIssues(
      page({ body: `See [DEMO-180](${url("DEMO-180")}) and https://elsewhere.invalid/browse/DEMO-181.` }),
      CONFIG,
    );
    expect(refs.find((r) => r.key === "DEMO-180")!.relations).toContain("link");
    expect(refs.find((r) => r.key === "DEMO-181")?.relations ?? []).not.toContain("link");
  });

  // The anchor page's shape: three links 2, 70 and 138 raw characters after the
  // marker, one clause (a `·` on each side), a dotted host inside it and a
  // dotted date before it.
  const LINE =
    "Status: ferdig 2026-01-05 · grunnlag: kjørt 22.09 (**12 rader**) · Jira opprettet: " +
    `[DEMO-101](${url("DEMO-101")}) (A1 grunnfeil), ` +
    `[DEMO-102](${url("DEMO-102")}) (A2 følgefeil), ` +
    `[DEMO-103](${url("DEMO-103")}) (B) · neste steg: [DEMO-104](${url("DEMO-104")}).`;

  test("the fixture line really has the anchor page's 2/70/138 shape", () => {
    const end = LINE.indexOf("opprettet") + "opprettet".length;
    expect(["[DEMO-101]", "[DEMO-102]", "[DEMO-103]"].map((s) => LINE.indexOf(s) - end)).toEqual([2, 70, 138]);
  });

  test("all three links in the marker's clause are created here; a link after the next · is not", () => {
    const r = rels(inferJiraIssues(page({ body: LINE }), CONFIG));
    for (const k of ["DEMO-101", "DEMO-102", "DEMO-103"]) expect(r[k]!.slice(0, 2)).toEqual(["created", "link"]);
    expect(r["DEMO-104"]).not.toContain("created");
  });

  test("Jira markup: Opprettet som [KEY|url] — the pipe inside brackets does not end the clause", () => {
    const body = `| Sak | Opprettet som [DEMO-190|${url("DEMO-190")}] |\n| x | [DEMO-191|${url("DEMO-191")}] |`;
    const r = rels(inferJiraIssues(page({ body }), CONFIG));
    expect(r["DEMO-190"]).toContain("created");
    expect(r["DEMO-191"]).not.toContain("created");
  });

  test("clause boundaries: a table cell pipe ends a clause, a pipe outside a table row does not", () => {
    expect(clauseBoundaries("| a | b |").length).toBe(3);
    expect(clauseBoundaries("a | b")).toEqual([]);
    expect(clauseBoundaries("[[page|alias]] | x")).toEqual([]);
    const line = "host nav.example.invalid and 22.09 · end. Next";
    expect(clauseBoundaries(line)).toEqual([line.indexOf("·"), line.indexOf(". ")]);
  });

  test("the marker must come BEFORE the link in the clause", () => {
    const r = rels(inferJiraIssues(page({ body: `[DEMO-195](${url("DEMO-195")}) ble opprettet i går` }), CONFIG));
    expect(r["DEMO-195"]).not.toContain("created");
  });

  test("a plan page whose title carries a key it also created keeps both relations", () => {
    const r = rels(
      inferJiraIssues(
        page({ authoredTitle: "DEMO-120 — arbeidsplan", body: `Jira opprettet: [DEMO-120](${url("DEMO-120")})` }),
        CONFIG,
      ),
    );
    expect(r["DEMO-120"]).toEqual(["created", "title", "link", "mention"]);
  });
});

describe("mention", () => {
  test("a bare uppercase project key in the body; code, URLs and wikilink targets are masked", () => {
    const body = [
      "Relatert: DEMO-130 og demo-131.",
      "`DEMO-132` in code",
      "```",
      "DEMO-133 in a fence",
      "```",
      "[[notes/DEMO-134-page|the page]] and https://other.invalid/x/DEMO-135",
      "OTHER-136 is another project",
    ].join("\n");
    expect(rels(inferJiraIssues(page({ body }), CONFIG))).toEqual({ "DEMO-130": ["mention"] });
  });
});

describe("ordering", () => {
  test("refs come strongest first, relations strongest first", () => {
    const refs = inferJiraIssues(
      page({
        frontmatter: { jira: ["DEMO-199"] },
        tags: ["demo-101"],
        body: "DEMO-150 is mentioned.",
        authoredTitle: "DEMO-140 work",
      }),
      CONFIG,
    );
    expect(refs.map((r) => r.key)).toEqual(["DEMO-199", "DEMO-140", "DEMO-101", "DEMO-150"]);
  });
});

describe("registry", () => {
  test("inferIssues is undefined, not [], when a page carries nothing", () => {
    expect(inferIssues(page({}), [CONFIG])).toBeUndefined();
    expect(inferIssues(page({ tags: ["demo-101"] }), [])).toBeUndefined();
  });

  test("isPlanTitle: word-ending match, with the exclude list winning", () => {
    expect(isPlanTitle("DEMO-101 — arbeidsplan", CONFIG)).toBe(true);
    expect(isPlanTitle("Planer for neste kvartal", CONFIG)).toBe(true);
    expect(isPlanTitle("Planlegging", CONFIG)).toBe(false);
    expect(isPlanTitle("Manuell testplan", CONFIG)).toBe(false);
    expect(isPlanTitle("Review av arbeidsplan", CONFIG)).toBe(false);
  });
});
