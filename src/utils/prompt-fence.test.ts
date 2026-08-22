/**
 * Acceptance for the shared prompt-fence helpers.
 *
 * `stripWrappingFence` shipped as a BYTE COPY in `src/share/prompt.ts` and
 * `src/jira/prompt.ts`, and both copies required an EMPTY info string and a
 * closer of exactly the opener's length — so the single most likely wrapper a
 * model emits when told "markdown only", ```` ```markdown ````, was left on the
 * output. This file owns that contract now; the two callers only re-export.
 *
 * **The info string is allow-listed, not simply accepted.** A wrapper tagged
 * `ts`/`kotlin`/`bash` cannot be told apart from a post whose real content IS one
 * code block, and stripping it would splice the prose out of the block — the
 * failure the interior check already exists to prevent. Only a markdown/plaintext
 * tag is a wrapper by definition.
 */

import { test, expect, describe } from "bun:test";
import {
  MARKDOWN_WRAPPER_INFO_STRINGS,
  neutralizePromptFence,
  stripWrappingFence,
} from "./prompt-fence.ts";

describe("stripWrappingFence", () => {
  test("a bare fence around the whole text is dropped", () => {
    expect(stripWrappingFence("```\n# Sak\n\nBody.\n```")).toBe("# Sak\n\nBody.");
    expect(stripWrappingFence("~~~\nBody.\n~~~")).toBe("Body.");
  });

  test("a ```markdown wrapper is dropped — the case both byte copies missed", () => {
    expect(stripWrappingFence("```markdown\n## Symptom\n\nFeiler.\n```")).toBe("## Symptom\n\nFeiler.");
    expect(stripWrappingFence("```md\n## Symptom\n```")).toBe("## Symptom");
  });

  test("the DEFAULT set is markdown only — a ```text wrapper is left alone", () => {
    // The default is what share gets, and share's own contract before the two
    // copies were merged was "empty info string only". Widening it to plaintext
    // tags was never argued for that surface, so the default carries exactly the
    // ```markdown fix the merge existed for and nothing else. A caller that
    // wants more says so (see JIRA_WRAPPER_INFO_STRINGS).
    expect(stripWrappingFence("```text\nBody.\n```")).toBe("```text\nBody.\n```");
    expect(stripWrappingFence("~~~ text \nBody.\n~~~")).toBe("~~~ text \nBody.\n~~~");
    expect([...MARKDOWN_WRAPPER_INFO_STRINGS].sort()).toEqual(["", "markdown", "md", "mdx"]);
  });

  test("a caller may widen the allow-list, and only that caller's set applies", () => {
    const wide = new Set([...MARKDOWN_WRAPPER_INFO_STRINGS, "text", "jira"]);
    expect(stripWrappingFence("```text\nBody.\n```", wide)).toBe("Body.");
    expect(stripWrappingFence("~~~ TEXT \nBody.\n~~~", wide)).toBe("Body.");
    expect(stripWrappingFence("```jira\nh2. Sak\n```", wide)).toBe("h2. Sak");
    // Widening does not turn off the language rule.
    expect(stripWrappingFence("```ts\nconst a = 1;\n```", wide)).toBe("```ts\nconst a = 1;\n```");
  });

  test("a LANGUAGE-tagged fence is left alone — the text may really be code", () => {
    expect(stripWrappingFence("```ts\nconst a = 1;\n```")).toBe("```ts\nconst a = 1;\n```");
    expect(stripWrappingFence("```kotlin\nval x = 1\n```")).toBe("```kotlin\nval x = 1\n```");
  });

  test("a closer LONGER than the opener still closes it", () => {
    expect(stripWrappingFence("```\nhei\n`````")).toBe("hei");
  });

  test("a closer SHORTER than the opener does not close it", () => {
    const t = "````\nhei\n```";
    expect(stripWrappingFence(t)).toBe(t);
  });

  test("a text that merely BEGINS and ENDS with a code block keeps both fences", () => {
    const post = "```\nnpm i\n```\n\nprose\n\n```\nnpm run\n```";
    expect(stripWrappingFence(post)).toBe(post);
  });

  test("a genuine ````-wrapper around interior ``` blocks still unwraps", () => {
    const inner = "Intro.\n\n```bash\nls\n```\n\nOutro.";
    expect(stripWrappingFence(`\`\`\`\`\n${inner}\n\`\`\`\``)).toBe(inner);
  });

  test("an info string carrying a backtick is not a fence at all", () => {
    const t = "```js```\nprose\n```";
    expect(stripWrappingFence(t)).toBe(t);
  });

  test("no fence ⇒ trimmed only", () => {
    expect(stripWrappingFence("  plain text  ")).toBe("plain text");
  });
});

describe("neutralizePromptFence", () => {
  test('collapses a """ run to a single quote', () => {
    expect(neutralizePromptFence('a """ b')).toBe('a " b');
  });

  test("is idempotent", () => {
    const once = neutralizePromptFence('a """" b');
    expect(neutralizePromptFence(once)).toBe(once);
  });
});
