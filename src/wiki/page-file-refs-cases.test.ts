/**
 * Pins `page-file-refs.cases.json` to the reader's own rule. The fixture is
 * shared: navikt/melosys-muninn keeps a byte-identical copy and runs its
 * dependency-free port of this rule (the felles-wiki publish script, which
 * uploads the data files a page names) against it. When this test fails, the
 * reader's rule changed: update the fixture here, copy it there, and fix the port.
 */
import { describe, expect, test } from "bun:test";
import { parseBlocks } from "../format/markdown-ast.ts";
import { resolveEmbedRelPath } from "../format/embed.ts";
import { checkPageFileRef, pageFileRefKinds } from "../format/query-block.ts";
import { splitFrontmatter } from "./page-text.ts";
import fixture from "./page-file-refs.cases.json";

describe("page-file-refs.cases.json matches the reader's rule (loadPageFiles)", () => {
  test("the fixture has cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
  });
  for (const c of fixture.cases) {
    test(c.name, () => {
      const refs: unknown = [...pageFileRefKinds(parseBlocks(splitFrontmatter(c.markdown).body))].map(([ref, kinds]) => {
        const lexical = checkPageFileRef(ref, kinds);
        return { ref, kinds: [...kinds].sort(), lexical, rel: lexical === "ok" ? resolveEmbedRelPath(c.page, ref) : null };
      });
      expect(refs).toEqual(c.refs);
    });
  }
});
