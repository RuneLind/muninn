import { describe, expect, test } from "bun:test";
import { proposalCategory } from "./category.ts";

const page = (tags: string) => `---\ntitle: X\ntags: ${tags}\n---\n\n# X\n\nbody\n`;

describe("proposalCategory", () => {
  test("film and TV tags read as entertainment", () => {
    expect(proposalCategory(page("[film, action-movies, entertainment, countdown]"))).toBe("entertainment");
    expect(proposalCategory(page("[apple-tv-plus, television, streaming, thriller]"))).toBe("entertainment");
    expect(proposalCategory(page('["Netflix", "rankings"]'))).toBe("entertainment");
  });

  test("a comma-separated tags string is read too", () => {
    expect(proposalCategory(page("film, tv"))).toBe("entertainment");
  });

  test("everything else is uncategorized, including a plain streaming tag", () => {
    expect(proposalCategory(page("[claude-code, token-cost, streaming]"))).toBeNull();
    expect(proposalCategory(page("[hardware, photography-gear, product-review]"))).toBeNull();
    expect(proposalCategory("# no frontmatter\n")).toBeNull();
    expect(proposalCategory("---\ntitle: X\n---\nbody")).toBeNull();
  });
});
