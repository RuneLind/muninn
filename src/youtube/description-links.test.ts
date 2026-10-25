/**
 * The description classifier, rule by rule and in rule order, over INVENTED
 * descriptions — one fixture per URL and heading shape the D17 survey found.
 * Real descriptions stay out of this public repo.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyDescriptionLinks,
  descriptionForPrompt,
  DESCRIPTION_PROMPT_MAX_CHARS,
  DESCRIPTION_TRUNCATION_NOTE,
  isHeadingLine,
  linkCandidates,
  trimUrl,
  uploaderKeys,
} from "./description-links.ts";

/** url → class, for compact assertions. */
function classes(description: string, uploader = "Sample Channel"): Record<string, string> {
  return Object.fromEntries(classifyDescriptionLinks(description, uploader).map((l) => [l.url, l.cls]));
}

function link(description: string, url: string, uploader = "Sample Channel") {
  const found = classifyDescriptionLinks(description, uploader).find((l) => l.url === url);
  if (!found) throw new Error(`no link ${url}`);
  return found;
}

describe("URL extraction", () => {
  test("trailing punctuation is stripped, balanced parentheses are kept", () => {
    expect(trimUrl("https://a.example/x.")).toBe("https://a.example/x");
    expect(trimUrl("https://a.example/x,")).toBe("https://a.example/x");
    expect(trimUrl("https://a.example/x?!")).toBe("https://a.example/x");
    expect(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar))")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(trimUrl("https://a.example/x)")).toBe("https://a.example/x");
  });

  test("a URL in prose parentheses loses the prose paren", () => {
    const d = "SOURCES\n• The report (see https://report.example/p1).";
    expect(Object.keys(classes(d))).toEqual(["https://report.example/p1"]);
  });

  test("two URLs on one line: the comma goes, and the second's title drops the first URL", () => {
    const d = "Links\n- Pat → https://x.com/patexample, https://patsite.example";
    expect(classes(d)).toEqual({ "https://x.com/patexample": "social", "https://patsite.example": "candidate" });
    expect(link(d, "https://patsite.example").title).toBe("Pat");
  });
});

describe("rule 1: social", () => {
  test("profiles on social hosts, with and without www., and profile tabs", () => {
    const d = [
      "X: https://x.com/someone",
      "Twitter: https://www.twitter.com/someone",
      "IG: https://www.instagram.com/someone/",
      "TT: https://www.tiktok.com/@someone",
      "FB: https://www.facebook.com/someone/",
      "Threads: https://www.threads.com/@someone",
      "Threads old: https://threads.net/@someone",
      "Twitch: https://www.twitch.tv/someone",
      "Tab: https://x.com/someone/about",
      "LinkedIn: https://www.linkedin.com/in/someone/",
      "Company: https://linkedin.com/company/acme",
      "Substack profile: https://substack.com/@someone",
      "Podcast: https://open.spotify.com/show/abc123?si=x",
      "Channel: https://www.youtube.com/@someone",
      "Members: https://www.youtube.com/channel/UCabc/join",
      "Playlist: https://www.youtube.com/playlist?list=PL1",
      "Patreon: https://patreon.com/someone",
      "Discord: https://discord.gg/abc",
      "Discord invite: https://discord.com/invite/abc",
      "Bio: https://linktr.ee/someone",
      "Community: https://www.skool.com/some-community/classroom",
      "Paid: https://whop.com/some-group/",
    ].join("\n");
    for (const [url, cls] of Object.entries(classes(d))) expect(`${url} ${cls}`).toBe(`${url} social`);
  });

  test("a post is never a profile", () => {
    const d = [
      "https://x.com/someone/status/123",
      "https://x.com/someone/article/456",
      "https://www.tiktok.com/@someone/video/789",
      "https://www.instagram.com/p/abc/",
      "https://www.instagram.com/reel/abc/",
      "https://www.linkedin.com/posts/someone_activity-1",
      "https://www.youtube.com/watch?v=abcdefghijk",
    ].join("\n");
    for (const cls of Object.values(classes(d))) expect(cls).toBe("candidate");
  });

  test("promo is decided before block membership: a profile in a source block stays social", () => {
    const d = "SOURCES\n• The author: https://x.com/someauthor\n• The paper: https://paper.example/p";
    expect(classes(d)).toEqual({ "https://x.com/someauthor": "social", "https://paper.example/p": "source" });
  });
});

describe("rule 2: creator", () => {
  test("shorteners are creator links, wherever they sit", () => {
    const d = "SOURCES\n• Report: https://bit.ly/abc\nCamera: https://amzn.to/xyz\nGuide: https://goo.gle/g\nSponsor: https://jb.gg/j";
    expect(Object.values(classes(d))).toEqual(["creator", "creator", "creator", "creator"]);
  });

  test("a funnel subdomain on the uploader's own domain is creator; the shortener ON that domain too", () => {
    const d = "Free → https://c.samplechannel.example/free\nCall → https://go.samplechannel.example/call";
    expect(Object.values(classes(d))).toEqual(["creator", "creator"]);
  });

  test("the uploader's own site that is not a funnel is a candidate with a hint", () => {
    const d = "Blog: https://samplechannel.example/blog/post-one";
    const l = link(d, "https://samplechannel.example/blog/post-one");
    expect(l.cls).toBe("candidate");
    expect(l.hint).toBe("uploader's own site");
  });

  test("an uploader's own blog post inside a source block is a candidate, by rule order", () => {
    const d = "SOURCES\n• Our write-up: https://samplechannel.example/blog/write-up\n• Theirs: https://other.example/a";
    expect(classes(d)).toEqual({
      "https://samplechannel.example/blog/write-up": "candidate",
      "https://other.example/a": "source",
    });
  });

  test("a company channel's own blog: content hosts never match the uploader", () => {
    expect(classes("Read: https://www.anthropic.com/news/a-post", "Anthropic")).toEqual({
      "https://www.anthropic.com/news/a-post": "candidate",
    });
    expect(link("Read: https://examplecorp.example/blog/launch", "https://examplecorp.example/blog/launch", "ExampleCorp").hint).toBe(
      "uploader's own site",
    );
  });

  test("an uploader name's parts are keys too (`Name | Topic`, `Name - Brand`)", () => {
    expect(uploaderKeys("Sam Doe | Agent Tips")).toEqual(["samdoeagenttips", "samdoe", "agenttips"]);
    expect(classes("Join → https://join.agenttips.example/x", "Sam Doe | Agent Tips")).toEqual({
      "https://join.agenttips.example/x": "creator",
    });
  });

  test("a FREE RESOURCES block over off-domain funnels: nothing becomes a source", () => {
    const d = "MORE FREE RESOURCES\n📘 Playbook → https://funnel-host.example/p1\n📗 Course → https://funnel-host.example/p2";
    const links = classifyDescriptionLinks(d, "Sample Channel");
    expect(links.map((l) => l.cls)).toEqual(["candidate", "candidate"]);
    expect(links.map((l) => l.hint)).toEqual(["repeated host", "repeated host"]);
  });
});

describe("rule 3: source blocks", () => {
  test("the reference shape: emoji heading, bullets, trailing parenthetical attribution", () => {
    const d = [
      "🎁 Free mod → https://c.samplechannel.example/free",
      "",
      "🔗 LINKS MENTIONED IN THIS VIDEO",
      "• Spending your tokens (Example Lab, Jo Writer): https://lab.example/blog/spending",
      "• Picking a model (Example Lab, Ann Other): https://lab.example/articles/picking",
      "",
      "🎬 CHAPTERS",
      "00:00 – Intro",
    ].join("\n");
    const links = classifyDescriptionLinks(d, "Sample Channel");
    expect(links.map((l) => [l.cls, l.title, l.attribution])).toEqual([
      ["creator", "Free mod", ""],
      ["source", "Spending your tokens", "Example Lab, Jo Writer"],
      ["source", "Picking a model", "Example Lab, Ann Other"],
    ]);
  });

  test("an Anthropic-channel description: content URLs in a source block are sources", () => {
    const d = "Further reading:\n- https://www.anthropic.com/research/one\n- https://www.anthropic.com/news/two";
    expect(Object.values(classes(d, "Anthropic"))).toEqual(["source", "source"]);
  });

  test("a status URL, an X article and a TikTok video inside a source block are sources", () => {
    const d = [
      "SOURCES:",
      "",
      "The warning thread:",
      "https://x.com/someone/status/2113325263157395456",
      "",
      "The long post:",
      "https://x.com/someone/article/1234567890",
      "",
      "The clip:",
      "https://www.tiktok.com/@someone/video/7000000000000000000",
    ].join("\n");
    const links = classifyDescriptionLinks(d, "Sample Channel");
    expect(links.map((l) => l.cls)).toEqual(["source", "source", "source"]);
    expect(links.map((l) => l.title)).toEqual(["The warning thread", "The long post", "The clip"]);
  });

  test("a colon-terminated title line over its URL is a title, not a heading", () => {
    const lines = ["SOURCES:", "", "Report one:", "https://r.example/1"];
    expect(isHeadingLine(lines, 0)).toBe(true);
    expect(isHeadingLine(lines, 2)).toBe(false);
  });

  test("a source heading ending in ' :' directly over a URL is still a heading (D17)", () => {
    const d = "Today’s Sources :\nhttps://lab.example/research/one\n\nhttps://lab.example/news/two\n\n\n\n#tag";
    const links = classifyDescriptionLinks(d, "Sample Channel");
    expect(links.map((l) => l.cls)).toEqual(["source", "source"]);
    // No usable text on the line or above it: the host and path.
    expect(links[0]!.title).toBe("lab.example/research/one");
  });

  test("a blank line between the heading and the first entry is skipped", () => {
    const d = "REFERENCES\n\n\n• One: https://one.example/a";
    expect(classes(d)).toEqual({ "https://one.example/a": "source" });
  });

  test("unbulleted Title / URL / blank entries stay in one block; the next heading ends it", () => {
    const d = [
      "SOURCES:",
      "Agency statement:",
      "https://gov.example/news/1",
      "",
      "Vendor advisory:",
      "https://vendor.example/adv",
      "",
      "CHAPTERS:",
      "00:00 Start",
      "Later: https://later.example/x",
    ].join("\n");
    expect(classes(d)).toEqual({
      "https://gov.example/news/1": "source",
      "https://vendor.example/adv": "source",
      "https://later.example/x": "candidate",
    });
  });

  test("bare URL lines separated by blank lines stay in one block", () => {
    const d = "Papers:\n\nhttps://p.example/1\n\nhttps://p.example/2\n\nThanks for watching";
    expect(Object.values(classes(d))).toEqual(["source", "source"]);
  });

  test("a sponsor line one blank line under a source block is not a source (D17)", () => {
    const d = [
      "SOURCES",
      "• The study: https://study.example/s",
      "",
      "This video is sponsored by Widget: https://widget.example/deal",
    ].join("\n");
    expect(classes(d)).toEqual({ "https://study.example/s": "source", "https://widget.example/deal": "candidate" });
  });

  test("a one-line `Org, title: URL` block ends at the first blank line", () => {
    const d = [
      "SOURCES",
      "Lab, the backdoor study: https://lab.example/a",
      "Vendor, the advisory: https://vendor.example/b",
      "",
      "Sponsor, a deal: https://sponsor.example/c",
    ].join("\n");
    expect(classes(d)).toEqual({
      "https://lab.example/a": "source",
      "https://vendor.example/b": "source",
      "https://sponsor.example/c": "candidate",
    });
  });

  test("a funnel block below a source block: the heading ends the source block", () => {
    const d = [
      "LINKS MENTIONED",
      "• Paper: https://paper.example/1",
      "WORK WITH ME",
      "• Call: https://booking.example/me",
    ].join("\n");
    expect(classes(d)).toEqual({ "https://paper.example/1": "source", "https://booking.example/me": "candidate" });
  });

  test("a separator line ends a source block (D17)", () => {
    const d = "SOURCES\n• Paper: https://paper.example/1\n━━━━━━━━━━\n• Shop: https://shop.example/x";
    expect(classes(d)).toEqual({ "https://paper.example/1": "source", "https://shop.example/x": "candidate" });
  });

  test("a prose line ends a source block, before its first URL too", () => {
    const before = "SOURCES\nThe study discussed is from a university.\nMore context here.\nRead the full write-up: https://write.example/up";
    expect(classes(before)).toEqual({ "https://write.example/up": "candidate" });
    const after = "SOURCES\n• Paper: https://paper.example/1\nThat is all for this week.\nShop: https://shop.example/x";
    expect(classes(after)).toEqual({ "https://paper.example/1": "source", "https://shop.example/x": "candidate" });
    // A title line over its URL and a URL-less bullet keep the block open.
    const kept = "SOURCES\n• The study, in short\nThe study:\nhttps://study.example/s";
    expect(classes(kept)).toEqual({ "https://study.example/s": "source" });
  });

  /**
   * The invariant: a URL goes in by rule only when its entry is unambiguous.
   * Every fixture's promo URL — a sponsor, a discount, a follow-me — is never a
   * source, whatever block it sits in or shape it takes.
   */
  test("a promo entry inside or beside a source block is never a source", () => {
    const fixtures: Array<[string, string]> = [
      ["SOURCES\nThe study discussed is from a university.\nMore context here.\nGet 20% off WidgetVPN: https://widgetvpn.example/deal", "https://widgetvpn.example/deal"],
      ["Links mentioned in this video:\n\nNothing this week, but thanks to our sponsor!\nTry Acme free: https://acme.example/promo", "https://acme.example/promo"],
      ["Papers:\nhttps://a.example/paper\nhttps://b.example/paper\nFollow me: https://example.net/me", "https://example.net/me"],
      ["SOURCES\n- Paper: https://p.example/1\n\n- Sponsor WidgetVPN: https://widgetvpn.example/x", "https://widgetvpn.example/x"],
      ["Links mentioned in this video:\nSpending your effort (Example Lab):\nhttps://lab.example/a\n\nTry my sponsor today\nhttps://sponsor.example/deal", "https://sponsor.example/deal"],
      ["REFERENCES\n• Study: https://study.example/1\n• Use code SAVE10 for a discount: https://store.example/s", "https://store.example/s"],
      ["SOURCES\n• Report: https://report.example/r\n• Join my newsletter: https://letters.example/me", "https://letters.example/me"],
    ];
    expect(fixtures.map(([d, promo]) => `${promo} ${link(d, promo).cls}`)).toEqual(fixtures.map(([, promo]) => `${promo} candidate`));
    // The real entries beside them stay sources.
    expect(link(fixtures[2]![0], "https://a.example/paper").cls).toBe("source");
    expect(link(fixtures[3]![0], "https://p.example/1").cls).toBe("source");
    expect(link(fixtures[4]![0], "https://lab.example/a").cls).toBe("source");
  });

  test("neither a bare «links» nor a «resources» heading starts a block", () => {
    const d = "🔗 My links\n• Site: https://a.example\n\nFREE RESOURCES\n• Guide: https://b.example/g\n\nLinks:\nhttps://c.example/post";
    expect(Object.values(classes(d))).toEqual(["candidate", "candidate", "candidate"]);
    // «Links:» over a URL is a label, not a title (D17).
    expect(link(d, "https://c.example/post").title).toBe("c.example/post");
  });
});

describe("rules 4 and 5: repo and candidate", () => {
  test("two github repos, a gist, huggingface and arxiv outside a block are repos", () => {
    const d = [
      "Code: https://github.com/acme/agent-harness",
      "Fork: https://github.com/other/agent-harness",
      "Gist: https://gist.github.com/someone/abc",
      "Model: https://huggingface.co/acme/model",
      "Paper: https://arxiv.org/abs/2501.00001",
      "Org page: https://github.com/acme",
    ].join("\n");
    expect(Object.values(classes(d))).toEqual(["repo", "repo", "repo", "repo", "repo", "candidate"]);
  });

  test("two posts on one blog host carry the `repeated host` hint", () => {
    const d = "Post one: https://blog.example/a\nPost two: https://blog.example/b\nOther: https://else.example/c";
    const links = classifyDescriptionLinks(d, "Sample Channel");
    expect(links.map((l) => l.hint ?? "")).toEqual(["repeated host", "repeated host", ""]);
  });

  test("a two-line entry takes the previous line as its title", () => {
    const d = "Some intro text.\n\nThe benchmark write-up\nhttps://bench.example/w";
    expect(link(d, "https://bench.example/w").title).toBe("The benchmark write-up");
  });

  test("a repeated URL is listed once, as its best class", () => {
    const d = "Study: https://study.example/x\n\nSOURCES\n• Study again: https://study.example/x";
    const links = classifyDescriptionLinks(d, "Sample Channel");
    expect(links).toHaveLength(1);
    expect(links[0]!.cls).toBe("source");
    expect(links[0]!.title).toBe("Study");
  });
});

describe("what the prompt carries", () => {
  test("candidates are numbered 1..n over source, repo and candidate links only", () => {
    const d = "X: https://x.com/me\nSOURCES\n• A: https://a.example/1\nCode: https://github.com/a/b";
    expect(linkCandidates(classifyDescriptionLinks(d, "Me")).map((c) => [c.id, c.url])).toEqual([
      [1, "https://a.example/1"],
      [2, "https://github.com/a/b"],
    ]);
  });

  test("creator and social lines are dropped; a mixed line keeps its other URL", () => {
    const d = "Intro words.\n\nFollow: https://x.com/me\nFree → https://c.meechannel.example/free\n\nPat → https://x.com/pat, https://pat.example";
    const text = descriptionForPrompt(d, classifyDescriptionLinks(d, "Mee Channel"));
    expect(text).toBe("Intro words.\n\nPat →, https://pat.example");
  });

  test("capped at 5,000 characters at a line boundary, with a note", () => {
    const d = Array.from({ length: 200 }, (_, i) => `Line ${i} ${"x".repeat(40)}`).join("\n");
    const text = descriptionForPrompt(d, []);
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_PROMPT_MAX_CHARS);
    expect(text.endsWith(`\n${DESCRIPTION_TRUNCATION_NOTE}`)).toBe(true);
    expect(text.split("\n").at(-2)!.endsWith("x")).toBe(true);
  });
});
