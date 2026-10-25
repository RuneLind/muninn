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

  test("a funnel subdomain on the uploader's own domain is creator", () => {
    const d = "Free → https://c.samplechannel.example/free\nCall → https://go.samplechannel.example/call";
    expect(Object.values(classes(d))).toEqual(["creator", "creator"]);
  });

  test("a shortener on the uploader's own host is creator, even inside a source block", () => {
    const d = "SOURCES\n• Report: https://l.samplechannel.example/r7\n• Paper: https://link.samplechannel.example/p2";
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
    expect(uploaderKeys("Sam Doe | Agent Tips")).toEqual({ whole: "samdoeagenttips", parts: ["samdoe", "agenttips"] });
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
      "https://x.com/someone/status/1234567890123456789",
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
    const d = "Tonight’s Sources :\nhttps://lab.example/research/one\n\nhttps://lab.example/news/two\n\n\n\n#tag";
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

describe("fix round 1 batch 2 — F2: real sources keep their by-rule placement", () => {
  test("bulleted and numbered title-over-URL entries after the first stay in the block", () => {
    const shapes = [
      "SOURCES\n• Report one\nhttps://r.example/1\n\n• Report two\nhttps://r.example/2",
      "Links mentioned in this video:\n\n- Spending your effort\nhttps://lab.example/blog/a\n\n- Effort levels\nhttps://lab.example/b",
      "SOURCES\n1. Paper one\nhttps://p.example/1\n\n2. Paper two\nhttps://p.example/2",
    ];
    for (const d of shapes) expect(`${d} → ${Object.values(classes(d)).join(",")}`).toBe(`${d} → source,source`);
  });

  test("a pointer-emoji line under the heading is skipped like a blank line", () => {
    const d = "Links mentioned in this video:\n👇👇👇\nhttps://lab.example/a\nhttps://lab.example/b";
    expect(Object.values(classes(d))).toEqual(["source", "source"]);
    expect(link(d, "https://lab.example/a").title).toBe("lab.example/a");
    // Over a one-line entry too, where the pointer is no title line.
    const inline = "Links mentioned in this video:\n👇\n• Paper: https://p.example/1";
    expect(classes(inline)).toEqual({ "https://p.example/1": "source" });
  });

  test("a heading ending in a pointer emoji, directly over its URL, starts a block", () => {
    const d = "📚 Links mentioned in this video 👇\nhttps://x.example/a";
    expect(classes(d)).toEqual({ "https://x.example/a": "source" });
  });

  test("dots and emoji are not separators; a rule line still is", () => {
    // A dots line is prose: it still ends the block, as a separator did.
    const dots = "SOURCES\n• Paper: https://p.example/1\n...\n• Shop: https://shop.example/x";
    expect(classes(dots)).toEqual({ "https://p.example/1": "source", "https://shop.example/x": "candidate" });
    const rule = "SOURCES\n• Paper: https://p.example/1\n▬▬▬▬▬▬\n• Shop: https://shop.example/x";
    expect(classes(rule)).toEqual({ "https://p.example/1": "source", "https://shop.example/x": "candidate" });
  });

  test("the promo invariant holds under the new shapes", () => {
    const d = "Links mentioned in this video 👇\n• Paper one\nhttps://p.example/1\n\n• Sponsor: get 20% off\nhttps://deal.example/x";
    expect(classes(d)).toEqual({ "https://p.example/1": "source", "https://deal.example/x": "candidate" });
  });
});

describe("fix round 1 batch 2 — F5: titles and URL extraction", () => {
  test("a markdown link gives its text as the title and its href as the URL", () => {
    const d = "Sources:\n- [The attention paper](https://arxiv.org/abs/1706.00001)\n- [Wiki](https://en.wikipedia.org/wiki/Foo_(bar))";
    const links = classifyDescriptionLinks(d, "Sample Channel");
    expect(links.map((l) => [l.url, l.title, l.cls])).toEqual([
      ["https://arxiv.org/abs/1706.00001", "The attention paper", "source"],
      ["https://en.wikipedia.org/wiki/Foo_(bar)", "Wiki", "source"],
    ]);
  });

  test("a generic markdown link text joins the words before it", () => {
    const d = "➡️ My [Website](https://pat.example/)\nRead the [write-up](https://pat.example/w)";
    expect(classifyDescriptionLinks(d, "Sample Channel").map((l) => l.title)).toEqual(["My Website", "Read the write-up"]);
  });

  test("a quoted title before a parenthesised URL loses the quotes and the paren", () => {
    const d = 'SOURCES\n• "The paper" (https://p.example/x)';
    expect(link(d, "https://p.example/x").title).toBe("The paper");
  });

  test("list numbers are stripped from titles", () => {
    const d = "SOURCES\n1. Spending your effort https://lab.example/a\n2) Other https://lab.example/b";
    expect(classifyDescriptionLinks(d, "Sample Channel").map((l) => l.title)).toEqual(["Spending your effort", "Other"]);
  });

  test("trailing emoji and full-width punctuation are not part of the URL", () => {
    expect(trimUrl("https://example.com/a👈")).toBe("https://example.com/a");
    expect(trimUrl("https://example.com/a👈🏽")).toBe("https://example.com/a");
    expect(trimUrl("https://example.com/b）")).toBe("https://example.com/b");
    expect(trimUrl("https://example.com/c。")).toBe("https://example.com/c");
    expect(trimUrl("https://example.com/d，")).toBe("https://example.com/d");
    expect(trimUrl("https://example.com/e」")).toBe("https://example.com/e");
    expect(trimUrl("https://example.com/（f）")).toBe("https://example.com/（f）");
  });

  test("dedup is by normalized URL; the first occurrence wins", () => {
    const d = "SOURCES\n- A https://lab.example/x\n- B https://www.lab.example/x/?utm_source=yt";
    const links = classifyDescriptionLinks(d, "Sample Channel");
    expect(links.map((l) => [l.url, l.title])).toEqual([["https://lab.example/x", "A"]]);
  });

  test("a promo URL's second spelling is still dropped from the prompt", () => {
    const d = "Intro.\nFollow: https://x.com/me\nAgain: https://www.x.com/me/?utm_source=yt";
    expect(descriptionForPrompt(d, classifyDescriptionLinks(d, "Me"))).toBe("Intro.");
  });
});

describe("fix round 1 batch 2 — F6: host rules", () => {
  test("a generic part of the uploader name is not a key; parts match a host label exactly", () => {
    expect(uploaderKeys("Pat Example - Podcast")).toEqual({ whole: "patexamplepodcast", parts: ["patexample"] });
    expect(uploaderKeys("Sam Doe | Agent Tips")).toEqual({ whole: "samdoeagenttips", parts: ["samdoe", "agenttips"] });
    const d = "SOURCES\n- Episode https://podcasts.apple.com/us/podcast/x/id1";
    expect(classes(d, "Pat Example - Podcast")).toEqual({ "https://podcasts.apple.com/us/podcast/x/id1": "source" });
    // A part matches a whole label, never inside one.
    expect(link("Read: https://samdoeblog.example/post", "https://samdoeblog.example/post", "Sam Doe | Agent Tips").hint).toBeUndefined();
    expect(link("Read: https://samdoe.example/post", "https://samdoe.example/post", "Sam Doe | Agent Tips").hint).toBe(
      "uploader's own site",
    );
  });

  test("post paths on Facebook and LinkedIn are not profiles", () => {
    const d = [
      "https://www.facebook.com/watch/?v=123",
      "https://www.linkedin.com/company/acme/posts",
      "https://www.linkedin.com/in/someone/recent-activity",
    ].join("\n");
    for (const cls of Object.values(classes(d))) expect(cls).toBe("candidate");
    expect(classes("https://www.linkedin.com/in/someone/details")).toEqual({ "https://www.linkedin.com/in/someone/details": "social" });
  });

  test("goo.gl is a shortener", () => {
    expect(classes("Check https://goo.gl/B3AWV5")).toEqual({ "https://goo.gl/B3AWV5": "creator" });
  });

  test("singular Source:, Paper: and Reference: headings start a block; OPEN SOURCE does not", () => {
    for (const h of ["Source:", "Paper:", "Reference:"]) {
      expect(`${h} ${link(`${h}\nhttps://p.example/x`, "https://p.example/x").cls}`).toBe(`${h} source`);
    }
    expect(classes("OPEN SOURCE TOOLS\n• Tool: https://tool.example/t")).toEqual({ "https://tool.example/t": "candidate" });
  });
});

describe("fix round 2 batch 1 — R2-2: by-rule placement narrowed back", () => {
  test("a trailing pointer is a heading's colon only after a source phrase, never a lone keyword", () => {
    expect(classes("Grab the cheat sheet I mentioned 👇\nhttps://leads.example/sheet")).toEqual({
      "https://leads.example/sheet": "candidate",
    });
    // No promo cue on this one: only the phrase rule keeps it out.
    expect(classes("Tools I mentioned 👇\nhttps://tool.example/t")).toEqual({ "https://tool.example/t": "candidate" });
    // The phrases still start a block, with or without a colon before the pointer.
    for (const h of ["📚 Links mentioned in this video 👇", "Sources: 👇", "Further reading ⬇️", "Mentioned in the video 👇"]) {
      expect(`${h} → ${link(`${h}\nhttps://x.example/a`, "https://x.example/a").cls}`).toBe(`${h} → source`);
    }
  });

  test("no other trailing decoration counts as a colon", () => {
    expect(classes("Sources: 📚\nhttps://s.example/1")).toEqual({ "https://s.example/1": "candidate" });
    expect(classes("Sources: 👉\nhttps://s.example/1")).toEqual({ "https://s.example/1": "candidate" });
  });

  test("a singular Source/Reference/Paper heading starts a block only as the whole heading", () => {
    expect(classes("Download our free white paper:\nhttps://leads.example/wp")).toEqual({ "https://leads.example/wp": "candidate" });
    expect(classes("Background music source:\nhttps://music.example/track/1")).toEqual({ "https://music.example/track/1": "candidate" });
    expect(classes("Data source:\nhttps://data.example/d")).toEqual({ "https://data.example/d": "candidate" });
    expect(classes("Source code:\nhttps://github.com/acme/tool")).toEqual({ "https://github.com/acme/tool": "repo" });
    for (const h of ["Source:", "📄 Paper:", "Reference:", "SOURCE"]) {
      expect(`${h} → ${link(`${h}\nhttps://p.example/x`, "https://p.example/x").cls}`).toBe(`${h} → source`);
    }
  });

  test("a pointer line after the block's first URL is prose and ends the block", () => {
    expect(classes("SOURCES\n- Paper https://p.example/1\n👇\n- Check out my merch https://m.example/x")).toEqual({
      "https://p.example/1": "source",
      "https://m.example/x": "candidate",
    });
    expect(classes("SOURCES\n- Paper https://p.example/1\n👇\n• Gear: https://gear.example/x")).toEqual({
      "https://p.example/1": "source",
      "https://gear.example/x": "candidate",
    });
    expect(classes("SOURCES\n- Paper https://p.example/1\n\n👇\n- Paper two https://p.example/2")).toEqual({
      "https://p.example/1": "source",
      "https://p.example/2": "candidate",
    });
  });

  test("lead-magnet cues (free, cheat sheet, download, grab) demote an entry in any heading shape", () => {
    expect(classes("Grab the cheat sheet I mentioned:\nhttps://leads.example/sheet")).toEqual({ "https://leads.example/sheet": "candidate" });
    expect(classes("SOURCES\n- Download the workbook https://leads.example/wb\n- Free guide https://leads.example/g")).toEqual({
      "https://leads.example/wb": "candidate",
      "https://leads.example/g": "candidate",
    });
  });

  test("F2's legitimate shapes stay sources", () => {
    expect(classes("📚 Links mentioned in this video 👇\nhttps://x.example/a")).toEqual({ "https://x.example/a": "source" });
    expect(Object.values(classes("Links mentioned in this video:\n👇👇👇\nhttps://anthropic.com/a\nhttps://anthropic.com/b"))).toEqual([
      "source",
      "source",
    ]);
  });
});

describe("fix round 2 batch 1 — R2-3: titles", () => {
  const title = (d: string, url: string) => {
    const l = link(d, url);
    return l.attribution === "" ? l.title : `${l.title} | ${l.attribution}`;
  };

  test("a markdown link's text is a title only when the words before it do not already name the entry", () => {
    expect(title("SOURCES\n- Attention Is All You Need [PDF](https://arxiv.org/pdf/x)", "https://arxiv.org/pdf/x")).toBe(
      "Attention Is All You Need",
    );
    expect(title("SOURCES\n- The scaling study: [paper](https://p.example/a)", "https://p.example/a")).toBe("The scaling study");
    expect(title("SOURCES\n- Scaling laws – [arXiv](https://arxiv.org/abs/2)", "https://arxiv.org/abs/2")).toBe("Scaling laws");
    expect(title("SOURCES\n- Scaling laws | [arXiv](https://arxiv.org/abs/3)", "https://arxiv.org/abs/3")).toBe("Scaling laws");
    // One word before: the word and the link text together.
    expect(title("➡️ My [Website](https://pat.example/)", "https://pat.example/")).toBe("My Website");
    expect(title("• Camera: [Sony A7iii](https://shop.example/cam)", "https://shop.example/cam")).toBe("Camera Sony A7iii");
    // Nothing before: the link text, its parenthetical included.
    expect(title("SOURCES\n- [X (Twitter)](https://x.com/someone/status/1)", "https://x.com/someone/status/1")).toBe("X (Twitter)");
    // A link text of three words or more is a title of its own.
    expect(title("To start reading: [Entry 1: What it means](https://news.example/1)", "https://news.example/1")).toBe(
      "Entry 1: What it means",
    );
    // A lead-in ending on an article runs on into the link text.
    expect(title("Read the [write-up](https://pat.example/w)", "https://pat.example/w")).toBe("Read the write-up");
    // Words before with their own parenthetical keep the attribution split.
    expect(title("SOURCES\n- Spending your effort (Example Lab) [blog](https://lab.example/b)", "https://lab.example/b")).toBe(
      "Spending your effort | Example Lab",
    );
  });

  test("only a 1–2 digit list number is stripped; a year is title text", () => {
    expect(title("SOURCES\n- 2024. Year in review https://y.example/r", "https://y.example/r")).toBe("2024. Year in review");
    expect(title("SOURCES\n12. Twelfth item https://y.example/12", "https://y.example/12")).toBe("Twelfth item");
  });

  test("quotes are unwrapped only when one pair wraps the whole title", () => {
    expect(title('SOURCES\n• "Foo" and "Bar" https://fb.example/x', "https://fb.example/x")).toBe('"Foo" and "Bar"');
    expect(title("SOURCES\n• “The paper” https://fb.example/y", "https://fb.example/y")).toBe("The paper");
  });
});

/** Pins for mutants the round-1 verify passes found surviving. */
describe("fix round 2 batch 1 — mutant pins (description-links)", () => {
  test("M17: a `Link:` label before the URL leaves the title line above it in the block", () => {
    const d = "SOURCES\nThe effort post\nLink: https://lab.example/a";
    expect([link(d, "https://lab.example/a").cls, link(d, "https://lab.example/a").title]).toEqual(["source", "The effort post"]);
  });

  test("M1b: a bullet title line over a BULLETED URL line is a bullet entry, not title-over-URL", () => {
    expect(classes("SOURCES\n- https://a.example/1\n\n- Report two\n- https://a.example/2")).toEqual({
      "https://a.example/1": "source",
      "https://a.example/2": "source",
    });
  });

  test("M1c: a bullet line that carries its own URL is a bullet entry, whatever is below it", () => {
    expect(classes("SOURCES\n- A https://a.example/1\nhttps://a.example/2\n\n- C https://a.example/3")).toEqual({
      "https://a.example/1": "source",
      "https://a.example/2": "source",
      "https://a.example/3": "source",
    });
  });

  test("M2b: the heading lookahead skips pointer lines", () => {
    expect(classes("SOURCES\n- See these:\n👇\nhttps://s.example/1")).toEqual({ "https://s.example/1": "source" });
  });

  test("M4b: a separator line alone ends the block, where prose would not", () => {
    expect(classes("SOURCES\n- Paper https://p.example/1\n━━━━━━\nhttps://shop.example/x")).toEqual({
      "https://p.example/1": "source",
      "https://shop.example/x": "candidate",
    });
  });

  test("M5c: URLs on one line come back in line order, a markdown link after a bare URL included", () => {
    const d = "See https://a.example/1 and [B](https://b.example/2)";
    expect(classifyDescriptionLinks(d, "Sample Channel").map((l) => l.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
  });

  test("M9b: a URL upgraded to source by a later spelling keeps the first spelling", () => {
    const d = "Read https://www.lab.example/x/?utm_source=yt\n\nSOURCES\n- A https://lab.example/x";
    expect(classifyDescriptionLinks(d, "Sample Channel").map((l) => [l.url, l.cls])).toEqual([
      ["https://www.lab.example/x/?utm_source=yt", "source"],
    ]);
  });
});
