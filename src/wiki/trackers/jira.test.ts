import { describe, expect, test } from "bun:test";
import { clauseBoundaries, inferJiraIssues, stampedKeys, stemKeys, titleKeys } from "./jira.ts";
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

describe("fix round 1: key shapes that are not keys", () => {
  const titled = (t: string) => rels(inferJiraIssues(page({ authoredTitle: t }), CONFIG));
  const stemmed = (stem: string) => rels(inferJiraIssues(page({ stem }), CONFIG));
  const stamped = (jira: string | string[]) => rels(inferJiraIssues(page({ frontmatter: { jira } }), CONFIG));

  test("a stamped prose value is scanned case-sensitively, with the denylist", () => {
    expect(stamped("DEMO-140 (kilde), se steg-2 og utf-8")).toEqual({ "DEMO-140": ["stamped"] });
    expect(stamped("DEMO-1-2")).toEqual({});
    expect(stamped("[FOO_X-7]")).toEqual({});
    // An entry that IS a key is kept whatever its case.
    expect(stamped(["demo-103", " DEMO-104 "])).toEqual({ "DEMO-103": ["stamped"], "DEMO-104": ["stamped"] });
  });

  test("a title shorthand needs the base key's digit count and to sit within 1000 of it", () => {
    expect(titleKeys("DEMO-145/2026 rapport", CONFIG)).toEqual(["DEMO-145"]);
    // The digit count alone: nothing but punctuation follows the year.
    expect(titleKeys("DEMO-145/2026 — rapport", CONFIG)).toEqual(["DEMO-145"]);
    // Same width, more than 1000 away: a year, not a key.
    expect(titleKeys("DEMO-8045/2026", CONFIG)).toEqual(["DEMO-8045"]);
    expect(titleKeys("DEMO-8045 + 2025-kjøringen", CONFIG)).toEqual(["DEMO-8045"]);
    // The accepted residual: a same-width count within 1000 still chains.
    expect(titleKeys("DEMO-145 + 300 saker", CONFIG)).toEqual(["DEMO-145", "DEMO-300"]);
    // The real forms.
    expect(titleKeys("DEMO-7588/7969 — Nullable sats", CONFIG)).toEqual(["DEMO-7588", "DEMO-7969"]);
    expect(titleKeys("DEMO-8045/8174 — plan for PR-splitt", CONFIG)).toEqual(["DEMO-8045", "DEMO-8174"]);
    expect(titleKeys("DEMO-7588 + 7969 — Implementeringsplan", CONFIG)).toEqual(["DEMO-7588", "DEMO-7969"]);
    // Bounded: at most five expansions per base key.
    expect(titleKeys("DEMO-101/102/103/104/105/106/107", CONFIG)).toHaveLength(6);
  });

  test("the title rule is uppercase only: a bot name is not a key", () => {
    expect(titleKeys("demo-2 bot-plan", CONFIG)).toEqual([]);
    expect(titled("demo-2 bot-plan")).toEqual({});
  });

  test("a lookalike letter never becomes a key, in any rule", () => {
    const kode = parseTrackersConfig([{ id: "jira", projects: ["KODE"] }], () => {
      throw new Error("must parse clean");
    })[0]!;
    const kelvin = "\u212AODE-12"; // the KELVIN SIGN, which folds to k
    const refs = inferJiraIssues(
      page({ authoredTitle: kelvin, stem: kelvin, tags: [kelvin.replace("ODE", "ode")], body: kelvin }),
      kode,
    );
    expect(refs).toEqual([]);
  });

  test("an ASCII letter or digit on the left ends a key", () => {
    expect(stemmed("xdemo-1")).toEqual({});
    expect(titled("ADEMO-1")).toEqual({});
  });

  test("stem: a date after the key is not a key; the two-key form yields both", () => {
    expect(stemmed("demo-2026-09-25-handover")).toEqual({});
    expect(stemmed("2026-05-04-demo-7588-7969-arbeidsdokument")).toEqual({
      "DEMO-7588": ["stem"],
      "DEMO-7969": ["stem"],
    });
    expect(stemmed("demo-12x")).toEqual({});
  });

  test("a leading-zero number is not a key in any inferred rule", () => {
    const refs = inferJiraIssues(
      page({
        authoredTitle: "DEMO-0145 notes",
        stem: "demo-0146",
        tags: ["demo-0147"],
        body: `DEMO-0148 and [x](${url("DEMO-0149")})`,
      }),
      CONFIG,
    );
    expect(refs).toEqual([]);
  });

  test("a markdown link DESTINATION is not a mention; an HTML comment is read by no body rule", () => {
    expect(rels(inferJiraIssues(page({ body: "[plan](plans/DEMO-120-plan.md)" }), CONFIG))).toEqual({});
    expect(
      rels(inferJiraIssues(page({ body: `<!-- Opprettet: [DEMO-805](${url("DEMO-805")})\nDEMO-806 -->` }), CONFIG)),
    ).toEqual({});
  });

  test("the created marker must end as a word", () => {
    for (const w of ["opprettelse", "opprettetdato", "createdby"]) {
      const r = rels(inferJiraIssues(page({ body: `${w}: [DEMO-196](${url("DEMO-196")})` }), CONFIG));
      expect({ w, rels: r["DEMO-196"] }).toEqual({ w, rels: ["link", "mention"] });
    }
  });

  test("a browse URL inside backticks is not a link", () => {
    expect(rels(inferJiraIssues(page({ body: "`https://example.invalid/browse/DEMO-197`" }), CONFIG))).toEqual({});
  });

  test("an unclosed [ does not swallow the later cells of a table row", () => {
    const body = `| a [ b | Opprettet i en annen celle | [DEMO-192](${url("DEMO-192")}) |`;
    expect(rels(inferJiraIssues(page({ body }), CONFIG))["DEMO-192"]).not.toContain("created");
  });

  test("many links on one line stay linear", () => {
    const line = Array.from({ length: 5000 }, (_, i) => `[DEMO-${1000 + i}](${url(`DEMO-${1000 + i}`)})`).join(" ");
    const t0 = performance.now();
    inferJiraIssues(page({ body: "opprettet: " + line }), CONFIG);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("fix round 2", () => {
  test("a title shorthand chains when a word follows it (N1)", () => {
    expect(titleKeys("DEMO-7588/7969 Nullable sats", CONFIG)).toEqual(["DEMO-7588", "DEMO-7969"]);
    expect(titleKeys("DEMO-7588 + 7969 implementeringsplan", CONFIG)).toEqual(["DEMO-7588", "DEMO-7969"]);
    expect(titleKeys("DEMO-7588/7969 og DEMO-8000", CONFIG)).toEqual(["DEMO-7588", "DEMO-7969", "DEMO-8000"]);
  });

  test("a chained number with a leading zero ends the chain (N3b)", () => {
    expect(titleKeys("DEMO-145/045", CONFIG)).toEqual(["DEMO-145"]);
    expect(stemKeys("x-demo-145-045-y", CONFIG)).toEqual([]);
  });

  test("a browse link ends like every other rule (N2)", () => {
    for (const k of ["DEMO-12-3", "DEMO-77abc"]) {
      const body = `Opprettet: [x](${url(k)})`;
      expect({ k, rels: rels(inferJiraIssues(page({ body }), CONFIG)) }).toEqual({ k, rels: {} });
    }
  });

  test("the scan flags carry no `u`: the long s does not fold into a project letter (N3a)", () => {
    const demos = parseTrackersConfig([{ id: "jira", projects: ["DEMOS"] }], () => {
      throw new Error("must parse clean");
    })[0]!;
    expect(stemKeys("demos-12-notes", demos)).toEqual(["DEMOS-12"]);
    expect(stemKeys("demo\u017F-12-notes", demos)).toEqual([]);
  });

  test("a stamped exact key must be ASCII before it is uppercased (N3c)", () => {
    expect(stampedKeys(["demo\u017F-12"])).toEqual([]); // LATIN SMALL LETTER LONG S → S
    expect(stampedKeys(["d\u0131ag-12"])).toEqual([]); // LATIN SMALL LETTER DOTLESS I → I
    expect(stampedKeys(["demos-12"])).toEqual(["DEMOS-12"]);
  });
});
