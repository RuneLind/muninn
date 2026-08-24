/**
 * Acceptance for the `## Referanser` append and the wrapping-fence strip — the
 * two pure steps `finalize.ts` runs over every draft, whatever produced it.
 *
 * **Every line of `## Referanser` resolves BY CONSTRUCTION**, which is the whole
 * reason it is server-appended rather than written by the model: PR 0 measured
 * that a bare URL becomes a Jira smart-link card and that a card for a
 * nonexistent issue renders "Can't find link". Dedup by key, the linked spelling
 * winning, and the no-section-at-all case are each a shipped defect.
 *
 * Synthetic keys only — muninn is a public repo.
 */

import { test, expect, describe } from "bun:test";
import {
  appendReferences,
  depthRider,
  neutralizeJiraFence,
  stripJiraWrappingFence,
} from "./prompt.ts";
import type { JiraCitation } from "./wire.ts";

const cite = (n: number, over: Partial<JiraCitation> = {}): JiraCitation => ({
  n,
  collection: "jira-issues",
  docId: `MELOSYS-${n}_slug.md`,
  title: `Sak ${n}`,
  url: `https://jira.adeo.no/browse/MELOSYS-${n}`,
  badge: "Jira",
  relevance: 0.9,
  key: `MELOSYS-${n}`,
  ...over,
});

describe("depthRider", () => {
  test("Ingen forbids files and classes even when the sources describe them", () => {
    expect(depthRider("ingen")).toContain("INGEN");
    expect(depthRider("ingen")).toContain("holdes utenfor");
  });
  test("Full inherits the jiraAnalysis.coder rule: no claim without opening the file", () => {
    expect(depthRider("full")).toContain("uten å ha åpnet filen");
  });
});

describe("appendReferences", () => {
  test("renders `[KEY](full-url)`, never a bare key", () => {
    const md = appendReferences("# Sak", [cite(1)]);
    expect(md).toContain("## Referanser");
    expect(md).toContain("- [MELOSYS-1](https://jira.adeo.no/browse/MELOSYS-1) — Sak 1");
    expect(md).not.toMatch(/^- MELOSYS-1$/m);
  });

  test("a source with no key renders `[title](url)`", () => {
    const md = appendReferences("# Sak", [
      cite(1, { key: undefined, title: "Lovvalg", url: "https://confluence.test/x" }),
    ]);
    expect(md).toContain("- [Lovvalg](https://confluence.test/x)");
  });

  test("a source with no URL renders plain text — a link to nowhere is worse", () => {
    const md = appendReferences("# Sak", [cite(1, { url: undefined })]);
    expect(md).toContain("- MELOSYS-1");
    expect(md).not.toContain("](");
  });

  test("a Jira title equal to the key is not printed twice", () => {
    const md = appendReferences("# Sak", [cite(1, { title: "MELOSYS-1" })]);
    expect(md).toContain("- [MELOSYS-1](https://jira.adeo.no/browse/MELOSYS-1)\n");
    expect(md).not.toContain("— MELOSYS-1");
  });

  test("NO section at all when nothing was retained — this is how the reader tells no_hits from low_confidence", () => {
    expect(appendReferences("# Sak\n", [])).toBe("# Sak");
  });
});

describe("stripJiraWrappingFence", () => {
  test("unwraps a whole-draft fence", () => {
    expect(stripJiraWrappingFence("```\n# Sak\n```")).toBe("# Sak");
  });
  test("leaves a draft that merely BEGINS and ENDS with code blocks alone", () => {
    const md = "```\nnpm i\n```\n\nprose\n\n```\nnpm run\n```";
    expect(stripJiraWrappingFence(md)).toBe(md);
  });
  test("leaves a language-tagged fence alone", () => {
    expect(stripJiraWrappingFence("```kotlin\nval x = 1\n```")).toBe("```kotlin\nval x = 1\n```");
  });
});

describe("neutralizeJiraFence", () => {
  test("is idempotent", () => {
    const once = neutralizeJiraFence('a """ b');
    expect(neutralizeJiraFence(once)).toBe(once);
  });
});

// ── `## Referanser` correctness ──────────────────────────────────────────────

describe("appendReferences — one resolvable line per source", () => {
  test("DE-DUPES by key — two doc ids for one issue rendered it twice, once bare", () => {
    const linked = cite(5);
    const bare: JiraCitation = { ...cite(6), docId: "MELOSYS-5_kopi.md", key: "MELOSYS-5", title: "Sak 5" };
    delete (bare as { url?: string }).url;
    const md = appendReferences("# Sak", [linked, bare]);
    expect(md.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    expect(md).toContain("- [MELOSYS-5](https://jira.adeo.no/browse/MELOSYS-5)");
  });

  test("prefers the LINKED spelling whichever order the two arrive in", () => {
    const bare: JiraCitation = { ...cite(7), docId: "MELOSYS-7_kopi.md", key: "MELOSYS-7" };
    delete (bare as { url?: string }).url;
    const md = appendReferences("# Sak", [bare, cite(7)]);
    expect(md).toContain("- [MELOSYS-7](https://jira.adeo.no/browse/MELOSYS-7)");
  });

  test("a keyed source with NO linkable url keeps its title — a bare key alone is unreadable", () => {
    const bare: JiraCitation = { ...cite(8), title: "Feil i årsavregning" };
    delete (bare as { url?: string }).url;
    expect(appendReferences("# Sak", [bare])).toContain("- MELOSYS-8 — Feil i årsavregning");
  });
});

describe("stripJiraWrappingFence — the info-string case", () => {
  test("a ```markdown wrapper is dropped", () => {
    expect(stripJiraWrappingFence("```markdown\n## Symptom\n```")).toBe("## Symptom");
  });

  test("the JIRA set also covers the plaintext family and this feature's own wrappers", () => {
    // A model told "markdown only, no wrapping fence" and handed a JIRA task
    // reaches for these; `jira`/`wiki`/`markup` are this surface's likeliest
    // hallucinated tags, and none of them can mean "the output IS a code block".
    for (const info of ["text", "txt", "plaintext", "plain", "jira", "wiki", "markup"]) {
      expect(stripJiraWrappingFence("```" + info + "\n## Symptom\n```")).toBe("## Symptom");
    }
    expect(stripJiraWrappingFence("~~~ Jira \n## Symptom\n~~~")).toBe("## Symptom");
  });

  test("a `Full` draft whose body really is one code excerpt is still left alone", () => {
    expect(stripJiraWrappingFence("```kotlin\nval x = 1\n```")).toBe("```kotlin\nval x = 1\n```");
  });
});
