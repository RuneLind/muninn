import { describe, expect, test } from "bun:test";
import { proposalCategory } from "./category.ts";

const LIFE = "life/sources/X.mdx";
const page = (tags: string) => `---\ntitle: X\ntags: ${tags}\n---\n\n# X\n\nbody\n`;

describe("proposalCategory", () => {
  test("film and TV tags read as entertainment", () => {
    expect(proposalCategory(page("[film, action-movies, entertainment, countdown]"), LIFE)).toBe("entertainment");
    expect(proposalCategory(page("[apple-tv-plus, television, streaming, thriller]"), LIFE)).toBe("entertainment");
    expect(proposalCategory(page('["Netflix", "rankings"]'), LIFE)).toBe("entertainment");
  });

  test("a comma-separated tags string is read too", () => {
    expect(proposalCategory(page("film, tv"), LIFE)).toBe("entertainment");
  });

  test("everything else is uncategorized, including a plain streaming tag", () => {
    expect(proposalCategory(page("[claude-code, token-cost, streaming]"), LIFE)).toBeNull();
    expect(proposalCategory(page("[hardware, photography-gear, product-review]"), LIFE)).toBeNull();
    expect(proposalCategory("# no frontmatter\n", LIFE)).toBeNull();
    expect(proposalCategory("---\ntitle: X\n---\nbody", LIFE)).toBeNull();
  });
});

// Fix round 1 batch 2 (review findings 2, 3).
describe("proposalCategory — domain and wider tags", () => {
  test("an AI-domain page tagged entertainment is not entertainment: films and TV land under life/", () => {
    const draft = page("[entertainment, ai-industry, china, ai-content]");
    expect(proposalCategory(draft, "sources/AI-Generated Short Dramas in China.mdx")).toBeNull();
    expect(proposalCategory(page("[netflix, engineering-blog]"), "sources/Netflix Tech Blog.mdx")).toBeNull();
    expect(proposalCategory(page("[film, entertainment]"), "life/sources/Sci-Fi Films.mdx")).toBe("entertainment");
  });

  test("documentary, review and other platform tags count", () => {
    for (const tags of ["[film-review, history]", "[hulu, thriller]", "[movie-review]", "[k-drama]", "[paramount-plus]"]) {
      expect(proposalCategory(page(tags), "life/sources/X.mdx")).toBe("entertainment");
    }
  });

  test("a block-style tags list is read too", () => {
    const draft = "---\ntitle: X\ntags:\n  - film\n  - countdown\n---\n\n# X\n";
    expect(proposalCategory(draft, "life/sources/X.mdx")).toBe("entertainment");
  });
});

// Fix round 2 batch 3 (batch-2 verify findings 1, 4).
describe("proposalCategory — block lists and documentaries", () => {
  test("a zero-indent block list and one with a blank line inside are read", () => {
    expect(proposalCategory("---\ntitle: X\ntags:\n- film\n- countdown\n---\n\n# X\n", LIFE)).toBe("entertainment");
    expect(proposalCategory("---\ntitle: X\ntags:\n  - countdown\n\n  - film\nurl: u\n---\n\n# X\n", LIFE)).toBe("entertainment");
    expect(proposalCategory("---\ntitle: X\ntags:\n  - countdown\nurl: film\n---\n\n# X\n", LIFE)).toBeNull();
  });

  test("a documentary tag alone does not file a life/ page as entertainment: health and parenting documentaries live there too", () => {
    expect(proposalCategory(page("[documentary, longevity, health]"), LIFE)).toBeNull();
  });
});
