/**
 * The fact-check annotation pass vs `[[wikilinks]]`.
 *
 * The defect this file pins: a claim quote that resolves to text INSIDE a
 * wikilink used to be wrapped where it sat, so the mark landed inside the link
 * brackets — `[[<Fact n="4" v="ok">Some Page</Fact>]]`. The link target becomes
 * markup: the link is dead and the chrome renders inside the brackets. The
 * correct nesting is the inverse, over the ORIGINAL link:
 * `<Fact n="4" v="ok">[[Some Page]]</Fact>`.
 *
 * Kept out of `integrate-annotate.test.ts` so that file stays readable as the
 * regression gate for the newline/block-marker tiers.
 *
 * Every fixture here is invented. muninn is a PUBLIC repo — no wiki content.
 */

import { test, expect, describe } from "bun:test";
import {
  annotateEdits,
  applyEdits,
  repairNestedFactWrappers,
  type IntegrateEdit,
} from "./integrate-edits.ts";
import type { FactcheckClaimAnchor } from "../dashboard/views/components/wiki-integrate.ts";

const anchor = (index: number, verdict: string): FactcheckClaimAnchor => ({
  index,
  total: 4,
  verdict,
  title: "claim " + index,
  block: `### ${verdict} Claim ${index}/4 — claim ${index}`,
});

const correction = (over: Partial<IntegrateEdit> = {}): IntegrateEdit => ({
  claimIndex: 1,
  verdict: "❌",
  old: "",
  new: "",
  reason: "because",
  ...over,
});

function annotate(over: Partial<Parameters<typeof annotateEdits>[0]>) {
  return annotateEdits({
    body: "",
    isMdx: true,
    corrections: [],
    claims: [],
    quotes: [],
    maxEdits: 20,
    maxEditChars: 2000,
    ...over,
  });
}

/** One ✅ claim whose quote is `quote`, over `body`. */
function markOne(body: string, quote: string) {
  return annotate({ body, claims: [anchor(1, "✅")], quotes: [{ index: 1, quote }] });
}

describe("a span intersecting a wikilink expands to the link's full extent", () => {
  test("REPRO: a span WHOLLY inside a link wraps the WHOLE link, never the target", () => {
    // The shipped defect's shape: the checked passage is the link's own label.
    const body = "The guide sends [[Tidal Router]]-class engines to the hard problems.\n";
    const r = markOne(body, "Tidal Router");

    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.old).toBe("[[Tidal Router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router]]</Fact>');

    const spliced = applyEdits(body, r.edits, true).body;
    expect(spliced).toContain('<Fact n="1" v="ok">[[Tidal Router]]</Fact>');
    // The forbidden shape, stated directly: markup inside the brackets.
    expect(spliced).not.toContain("[[<Fact");
    // …and the link target survives byte-for-byte, so the link still resolves.
    expect(spliced).toContain("[[Tidal Router]]");
  });

  test("a span STARTING inside a link is expanded leftwards over the opener", () => {
    const body = "Route [[Tidal Router]] and its cousins to the slow queue.\n";
    const r = markOne(body, "Router]] and its cousins");
    expect(r.edits[0]!.old).toBe("[[Tidal Router]] and its cousins");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router]] and its cousins</Fact>');
    expect(applyEdits(body, r.edits, true).body).not.toContain("[[<Fact");
  });

  test("a span ENDING inside a link is expanded rightwards over the closer", () => {
    const body = "We route [[Tidal Router]] carefully these days.\n";
    const r = markOne(body, "route [[Tidal");
    expect(r.edits[0]!.old).toBe("route [[Tidal Router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">route [[Tidal Router]]</Fact>');
    expect(applyEdits(body, r.edits, true).body).not.toContain("[[<Fact");
  });

  test("a span EXACTLY wrapping a link is unchanged", () => {
    const body = "The engine [[Tidal Router]] is the default.\n";
    const r = markOne(body, "[[Tidal Router]]");
    expect(r.edits[0]!.old).toBe("[[Tidal Router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router]]</Fact>');
    expect(r.edits[0]!.reason).toBe("marks the checked passage");
  });

  test("a span CONTAINING a link plus prose is unchanged — nothing to expand over", () => {
    const body = "The guide sends [[Tidal Router]] to the hard problems every time.\n";
    const r = markOne(body, "sends [[Tidal Router]] to the hard problems");
    expect(r.edits[0]!.old).toBe("sends [[Tidal Router]] to the hard problems");
    expect(r.edits[0]!.reason).toBe("marks the checked passage");
  });

  test("a piped link expands as one unit, alias included", () => {
    const body = "The guide names [[Tidal Router|the router]] as the default engine.\n";
    const r = markOne(body, "the router");
    expect(r.edits[0]!.old).toBe("[[Tidal Router|the router]]");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">[[Tidal Router|the router]]</Fact>');
  });

  test("a span with NO link nearby is byte-identical to today", () => {
    const body = "The guide sends heavier engines to the hard problems.\n";
    const r = markOne(body, "heavier engines");
    expect(r.edits[0]!.old).toBe("heavier engines");
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">heavier engines</Fact>');
    expect(r.edits[0]!.reason).toBe("marks the checked passage");
  });

  test("expansion is reported in the edit's reason", () => {
    const body = "The guide sends [[Tidal Router]]-class engines to the hard problems.\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits[0]!.reason).toContain("wikilink");
  });
});

describe("column 0 — the expansion refusal is scoped to expanded spans", () => {
  test("a link at column 0 with the span inside it is REFUSED, never marked bare", () => {
    // Expanding leftwards puts the opening tag at the start of the line, where the
    // block parser claims it as a component — so the mark is refused outright.
    const body = "Intro paragraph.\n\n[[Tidal Router]] is the default engine here.\n\nTail.\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits).toHaveLength(0);
    expect(r.dropped.map((d) => d.reason).join(" ")).toContain("wikilink");
    const spliced = applyEdits(body, r.edits, true).body;
    expect(spliced).toBe(body);
    expect(spliced).not.toContain("[[<Fact");
    // Specifically: no bare inline `<Fact>` opening a line.
    expect(spliced.split("\n").some((l) => l.startsWith("<Fact"))).toBe(false);
  });

  test("a paragraph-initial span with NO link still takes the inline form (no churn)", () => {
    // The live corpus shape the refusal must not touch: an ordinary column-0
    // passage, marked inline exactly as it is today.
    const body = "Intro paragraph.\n\nTidal Router is the default engine here.\n\nTail.\n";
    const r = markOne(body, "Tidal Router is the default");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]!.new).toBe('<Fact n="1" v="ok">Tidal Router is the default</Fact>');
    expect(applyEdits(body, r.edits, true).body).toContain(
      '\n<Fact n="1" v="ok">Tidal Router is the default</Fact> engine here.\n',
    );
  });

  test("a link after a list marker expands fine — the marker still owns the line", () => {
    const body = "Intro.\n\n- Send [[Tidal Router]] to the slow queue.\n- Another bullet.\n\nTail.\n";
    const r = markOne(body, "Tidal Router");
    expect(r.edits).toHaveLength(1);
    expect(applyEdits(body, r.edits, true).body).toContain(
      '- Send <Fact n="1" v="ok">[[Tidal Router]]</Fact> to the slow queue.',
    );
  });
});

describe("corrections that cross a wikilink boundary are dropped WHOLE", () => {
  test("a correction rewriting a link's label is dropped, not applied unwrapped", () => {
    const body = "Route [[Tidal Router]] to the slow queue.\n";
    const r = annotate({
      body,
      corrections: [correction({ claimIndex: 1, old: "Tidal Router", new: "Tidal Router v2" })],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(0);
    const reason = r.dropped.map((d) => d.reason).join(" ");
    expect(reason).toContain("wikilink");
    // The correction is NOT applied unwrapped — the link target is untouched.
    expect(reason).not.toContain("the correction itself still applies");
    expect(applyEdits(body, r.edits, true).body).toBe(body);
  });

  test("a correction whose claim the answer does not carry is dropped too", () => {
    // The unwrapped path is exactly where a silent `[[X]]` → `[[Y]]` rewrite hid:
    // it never reaches the wrapper branch, so the refusal cannot live there.
    const body = "Route [[Tidal Router]] to the slow queue.\n";
    const r = annotate({
      body,
      corrections: [correction({ claimIndex: 7, old: "Tidal Router", new: "Tidal Router v2" })],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(0);
    expect(applyEdits(body, r.edits, true).body).toBe(body);
  });

  test("a correction CONTAINING a whole link still applies, link intact", () => {
    const body = "Route [[Tidal Router]] to the slow queue.\n";
    const r = annotate({
      body,
      corrections: [
        correction({
          claimIndex: 1,
          old: "Route [[Tidal Router]] to the slow queue.",
          new: "Route [[Tidal Router]] to the fast queue.",
        }),
      ],
      claims: [anchor(1, "❌")],
    });
    expect(r.edits).toHaveLength(1);
    expect(applyEdits(body, r.edits, true).body).toContain("[[Tidal Router]] to the fast queue.");
  });

  test("a wrapper whose span sits inside a correction's span is dropped, correction wins", () => {
    // The claimed-overlap gate, with the link in play: the correction owns the
    // whole sentence (link included), so the ✅ mark inside it has nowhere to go.
    const body = "Route [[Tidal Router]] to the slow queue today.\n";
    const r = annotate({
      body,
      corrections: [
        correction({
          claimIndex: 1,
          old: "Route [[Tidal Router]] to the slow queue",
          new: "Route [[Tidal Router]] to the fast queue",
        }),
      ],
      claims: [anchor(1, "❌"), anchor(2, "✅")],
      quotes: [{ index: 2, quote: "Tidal Router" }],
    });
    expect(r.edits).toHaveLength(1); // the correction only
    expect(r.dropped.map((d) => d.reason).join(" ")).toContain("overlaps a correction");
    expect(applyEdits(body, r.edits, true).body).not.toContain("[[<Fact");
  });
});

describe("repairNestedFactWrappers — the post-splice backstop", () => {
  test("re-nests a mark that landed inside a link", () => {
    const body = "- Send [[<Fact n=\"4\" v=\"ok\">Tidal Router</Fact>]]-class engines onward.\n";
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe('- Send <Fact n="4" v="ok">[[Tidal Router]]</Fact>-class engines onward.\n');
    expect(r.repaired).toHaveLength(1);
    expect(r.residual).toHaveLength(0);
  });

  test("a clean body is returned byte-for-byte with nothing reported", () => {
    const body = 'Send <Fact n="1" v="ok">[[Tidal Router]]</Fact> onward.\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.repaired).toHaveLength(0);
    expect(r.residual).toHaveLength(0);
  });

  test("a FENCED example of the broken shape is documentation — left alone", () => {
    const body = ["How the bug looked:", "", "```markdown", '[[<Fact n="4" v="ok">A Page</Fact>]]', "```", ""].join("\n");
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.repaired).toHaveLength(0);
    expect(r.residual).toHaveLength(0);
  });

  test("an INLINE CODE example is left alone too", () => {
    const body = 'The broken shape is `[[<Fact n="4" v="ok">A Page</Fact>]]` — do not ship it.\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.repaired).toHaveLength(0);
  });

  test("a line mixing a real nesting with a coded example is reported, not rewritten", () => {
    const body =
      'Live: [[<Fact n="1" v="ok">A Page</Fact>]] and coded: `[[<Fact n="2" v="ok">B Page</Fact>]]`.\n';
    const r = repairNestedFactWrappers(body);
    expect(r.body).toBe(body);
    expect(r.residual).toHaveLength(1);
  });
});
