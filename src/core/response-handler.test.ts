import { test, expect, describe } from "bun:test";
import { extractChannelPosts } from "./response-handler.ts";

describe("extractChannelPosts", () => {
  test("extracts a complete tag and strips it from the reply", () => {
    const { cleanText, posts } = extractChannelPosts(
      'Done!\n<slack-post channel="#general">Hello team</slack-post>',
    );
    expect(posts).toEqual([{ channel: "#general", message: "Hello team" }]);
    expect(cleanText).toBe("Done!");
  });

  test("extracts multiple complete tags", () => {
    const { posts } = extractChannelPosts(
      '<slack-post channel="#a">one</slack-post>\n<slack-post channel="#b">two</slack-post>',
    );
    expect(posts).toEqual([
      { channel: "#a", message: "one" },
      { channel: "#b", message: "two" },
    ]);
  });

  test("second pass extracts an incomplete tag at the start of a line", () => {
    const { cleanText, posts } = extractChannelPosts(
      'Posting now:\n<slack-post channel="#general">the rest of this is the message',
    );
    expect(posts).toEqual([
      { channel: "#general", message: "the rest of this is the message" },
    ]);
    expect(cleanText).toBe("Posting now:");
  });

  test("second pass extracts an indented incomplete tag", () => {
    // Streamed/formatted LLM output may indent the directive.
    const { cleanText, posts } = extractChannelPosts(
      'Here:\n   <slack-post channel="#x">indented unclosed message',
    );
    expect(posts).toEqual([
      { channel: "#x", message: "indented unclosed message" },
    ]);
    expect(cleanText).toBe("Here:");
  });

  test("extracts an incomplete tag left after a complete tag is stripped before it", () => {
    // Pass 1 removes the complete #a tag, leaving a leading space before #b.
    const { posts } = extractChannelPosts(
      '<slack-post channel="#a">one</slack-post> <slack-post channel="#b">unclosed two',
    );
    expect(posts).toEqual([
      { channel: "#a", message: "one" },
      { channel: "#b", message: "unclosed two" },
    ]);
  });

  test("does NOT treat a mid-line prose mention of an unclosed tag as a directive", () => {
    // Regression: the second pass used to grab any `<slack-post …>` anywhere in
    // the text. A sentence describing the feature must stay in the reply.
    const text =
      'You can use the <slack-post channel="#x"> directive to post to a channel.';
    const { cleanText, posts } = extractChannelPosts(text);
    expect(posts).toEqual([]);
    expect(cleanText).toBe(text);
  });

  test("leaves plain text untouched", () => {
    const { cleanText, posts } = extractChannelPosts("just a normal reply");
    expect(posts).toEqual([]);
    expect(cleanText).toBe("just a normal reply");
  });
});
