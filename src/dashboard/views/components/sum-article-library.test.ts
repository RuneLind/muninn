/**
 * The two pure client functions the article view uses to turn a Vimeo
 * capture's timestamps into clicks into the video. The REAL
 * `sumArticleLibraryScript()` source is evaluated (the sum-submit-form idiom),
 * with only the one global its top level touches (`document`) stubbed, so a
 * change to the transform is tested as it ships, not as a copy.
 */
import { describe, expect, test } from "bun:test";
import { sumArticleLibraryScript } from "./sum-article-library.ts";
import { appendTranscriptSection } from "../../../youtube/frames.ts";

interface FakeAnchor {
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

function anchor(href: string): FakeAnchor {
  return {
    attrs: { href },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
}

function load(): {
  linkVimeoTimestamps: (markdown: string, videoUrl: string) => string;
  vimeoVideoIdFromUrl: (url: unknown) => string | null;
  openVimeoLinksInNewTab: (container: { querySelectorAll(sel: string): FakeAnchor[] } | null, videoUrl: string) => void;
  splitTranscript: (markdown: string) => { body: string; transcript: string | null };
  renderArticleHtml: (cleaned: string) => string;
} {
  const ctx = { document: { addEventListener() {}, getElementById: () => null } };
  // renderMarkdown is the page's marked wrapper (sum-job-card.ts), a global
  // this script calls; a tagging stub is enough to see what went through it.
  return new Function(
    "ctx",
    `var document = ctx.document;\nvar renderMarkdown = function(t) { return '<md>' + t + '</md>'; };\n${sumArticleLibraryScript()}\n` +
      "return { linkVimeoTimestamps: linkVimeoTimestamps, vimeoVideoIdFromUrl: vimeoVideoIdFromUrl, openVimeoLinksInNewTab: openVimeoLinksInNewTab, splitTranscript: splitTranscript, renderArticleHtml: renderArticleHtml };",
  )(ctx);
}

describe("openVimeoLinksInNewTab", () => {
  const { openVimeoLinksInNewTab } = load();

  test("sets target + rel on the video's #t= links and leaves every other anchor alone", () => {
    const stamp = anchor("https://vimeo.com/1223444307#t=750s");
    const other = anchor("https://vimeo.com/1223444307");
    const elsewhere = anchor("https://example.com/#t=750s");
    openVimeoLinksInNewTab({ querySelectorAll: () => [stamp, other, elsewhere] }, "https://vimeo.com/1223444307");
    expect(stamp.attrs).toEqual({ href: "https://vimeo.com/1223444307#t=750s", target: "_blank", rel: "noopener" });
    expect(other.attrs).toEqual({ href: "https://vimeo.com/1223444307" });
    expect(elsewhere.attrs).toEqual({ href: "https://example.com/#t=750s" });
  });

  test("no container, or no video id, is a no-op", () => {
    const stamp = anchor("https://vimeo.com/1223444307#t=750s");
    openVimeoLinksInNewTab(null, "https://vimeo.com/1223444307");
    expect(stamp.attrs).toEqual({ href: "https://vimeo.com/1223444307#t=750s" });
    // The no-id half is only pinned by an anchor the id-less prefix WOULD
    // match: without the guard the prefix is the literal "…/null#t=".
    const nullish = anchor("https://vimeo.com/null#t=750s");
    openVimeoLinksInNewTab({ querySelectorAll: () => [nullish] }, "https://youtu.be/x");
    expect(nullish.attrs).toEqual({ href: "https://vimeo.com/null#t=750s" });
  });
});

describe("vimeoVideoIdFromUrl (client mirror)", () => {
  const { vimeoVideoIdFromUrl } = load();
  test("the two stored shapes resolve, hash suffix or not", () => {
    expect(vimeoVideoIdFromUrl("https://vimeo.com/1223444307")).toBe("1223444307");
    expect(vimeoVideoIdFromUrl("https://vimeo.com/1223444307/abcdef")).toBe("1223444307");
    expect(vimeoVideoIdFromUrl("https://player.vimeo.com/video/1223444307?h=x")).toBe("1223444307");
    expect(vimeoVideoIdFromUrl("http://www.vimeo.com/42#t=1s")).toBe("42");
  });
  test("anything else is null", () => {
    expect(vimeoVideoIdFromUrl("https://youtu.be/abc")).toBeNull();
    expect(vimeoVideoIdFromUrl("https://vimeo.com/javazone")).toBeNull();
    expect(vimeoVideoIdFromUrl("https://notvimeo.com/123")).toBeNull();
    expect(vimeoVideoIdFromUrl("")).toBeNull();
    expect(vimeoVideoIdFromUrl(undefined)).toBeNull();
  });
});

describe("linkVimeoTimestamps", () => {
  const { linkVimeoTimestamps } = load();
  const URL = "https://vimeo.com/1223444307";

  test("a window heading and a cited timestamp become links to that second, brackets kept as the label", () => {
    const md = "### [00:12:00]\n\nAt [12:30] the demo starts; see also [1:05:07].";
    expect(linkVimeoTimestamps(md, URL)).toBe(
      "### [\\[00:12:00\\]](https://vimeo.com/1223444307#t=720s)\n\n" +
        "At [\\[12:30\\]](https://vimeo.com/1223444307#t=750s) the demo starts; see also [\\[1:05:07\\]](https://vimeo.com/1223444307#t=3907s).",
    );
  });

  test("fenced code is left alone; an existing link is not re-wrapped", () => {
    const md = "See [00:01:00].\n```\nrun at [00:01:00]\n```\n~~~yaml\nat: [02:00]\n~~~\nalready [00:01:00](https://x) linked";
    const out = linkVimeoTimestamps(md, URL);
    expect(out).toContain("See [\\[00:01:00\\]](https://vimeo.com/1223444307#t=60s).");
    expect(out).toContain("```\nrun at [00:01:00]\n```");
    expect(out).toContain("~~~yaml\nat: [02:00]\n~~~");
    expect(out).toContain("already [00:01:00](https://x) linked");
  });

  test("fences are paired by their own marker — a ~~~ line inside a ``` block does not close it", () => {
    const md = "```\n~~~\n[02:00]\n```\n[03:00] after";
    const out = linkVimeoTimestamps(md, URL);
    expect(out).toContain("```\n~~~\n[02:00]\n```");
    expect(out).toContain("[\\[03:00\\]](https://vimeo.com/1223444307#t=180s) after");
    // And the mirror image.
    const md2 = "~~~\n```\n[02:00]\n~~~\n[03:00] after";
    expect(linkVimeoTimestamps(md2, URL)).toContain("~~~\n```\n[02:00]\n~~~\n[\\[03:00\\]]");
  });

  test("a url with no video id returns the markdown untouched", () => {
    const md = "### [00:12:00]\n";
    expect(linkVimeoTimestamps(md, "https://youtu.be/x")).toBe(md);
    expect(linkVimeoTimestamps(md, "")).toBe(md);
  });

  test("things that look like timestamps but are not stay as they are", () => {
    // Three-part with a 1-digit seconds field, or a footnote-style [1], are not times.
    const md = "[1] and [12:3] and [a:bc] and [123:45]";
    expect(linkVimeoTimestamps(md, URL)).toBe(md);
  });
});

describe("splitTranscript", () => {
  const { splitTranscript } = load();

  test("splits at the level-2 Transcript heading; the heading itself is dropped", () => {
    const md = "## Key takeaways\n- a\n\n## Transcript\n\n### [00:00:00]\nHei";
    expect(splitTranscript(md)).toEqual({
      body: "## Key takeaways\n- a\n",
      transcript: "\n### [00:00:00]\nHei",
    });
  });

  test("no heading ⇒ whole text is the body, transcript null", () => {
    const md = "## Summary\nText";
    expect(splitTranscript(md)).toEqual({ body: md, transcript: null });
  });

  test("a Transcript heading inside a fence is content, not the split point", () => {
    const md = "Intro\n```\n## Transcript\nnot it\n```\n## Transcript\nreal";
    expect(splitTranscript(md)).toEqual({ body: "Intro\n```\n## Transcript\nnot it\n```", transcript: "real" });
  });

  test("level 3 or a suffixed heading does not split", () => {
    expect(splitTranscript("### Transcript\nx").transcript).toBeNull();
    expect(splitTranscript("## Transcript notes\nx").transcript).toBeNull();
  });

  test("a YouTube frames capture's own document folds here — the writer and this reader agree", () => {
    // The coupling, not a second fixture: `appendTranscriptSection` is what the
    // YouTube ingest body is built with, and this is what the article view does
    // with the document that comes back. Spelling the heading twice by hand
    // would let the two drift and pass.
    const doc = appendTranscriptSection(
      "### Key takeaways\n- a",
      "### [00:00:00]\nhello there\n\n### [00:02:00]\nmore words",
    );
    const parts = splitTranscript(doc.text);
    expect(parts.body.trim()).toBe("### Key takeaways\n- a");
    expect(parts.transcript).toContain("### [00:02:00]");
    // The summary half keeps no trace of the transcript.
    expect(parts.body).not.toContain("[00:00:00]");
  });
});

describe("fences shared by both transforms (mapProseLines)", () => {
  const { splitTranscript, linkVimeoTimestamps } = load();
  const url = "https://vimeo.com/123";

  test("a four-backtick fence showing a three-backtick block is ONE fence", () => {
    const md = "Intro\n````md\n```\n## Transcript\n[00:10]\n```\n````\nAfter [00:20]";
    expect(splitTranscript(md).transcript).toBeNull();
    const linked = linkVimeoTimestamps(md, url);
    expect(linked).toContain("\n[00:10]\n");
    expect(linked).toContain("[\\[00:20\\]](https://vimeo.com/123#t=20s)");
  });

  test("an indented opener still opens a fence (the old loop's rule, kept)", () => {
    const md = "    ```\n[00:10]\n    ```\n## Transcript\nT";
    expect(linkVimeoTimestamps(md, url)).toBe(md);
    expect(splitTranscript(md)).toEqual({ body: "    ```\n[00:10]\n    ```", transcript: "T" });
  });

  test("the FIRST Transcript heading wins", () => {
    expect(splitTranscript("a\n## Transcript\nb\n## Transcript\nc")).toEqual({ body: "a", transcript: "b\n## Transcript\nc" });
  });

  test("a non-string input is coerced on both paths", () => {
    expect(splitTranscript(123 as unknown as string)).toEqual({ body: "123", transcript: null });
    expect(splitTranscript({ toString: () => "x\n## Transcript\ny" } as unknown as string)).toEqual({ body: "x", transcript: "y" });
    expect(linkVimeoTimestamps(123 as unknown as string, url)).toBe("123");
  });

  test("a fence is closed only by its own marker character", () => {
    const md = "```\n~~~\n[00:10]\n```\n[00:20]";
    expect(linkVimeoTimestamps(md, url)).toBe("```\n~~~\n[00:10]\n```\n[\\[00:20\\]](https://vimeo.com/123#t=20s)");
  });
});

describe("renderArticleHtml", () => {
  const { renderArticleHtml } = load();

  test("summary only ⇒ just the rendered markdown, no details", () => {
    expect(renderArticleHtml("## A\nx")).toBe("<md>## A\nx</md>");
  });

  test("a transcript renders inside a closed details after the summary", () => {
    expect(renderArticleHtml("## A\nx\n## Transcript\n### [00:00:00]\nHei")).toBe(
      "<md>## A\nx</md>" +
        '<details class="sum-transcript"><summary>Transcript</summary>' +
        '<div class="sum-transcript-body"><md>### [00:00:00]\nHei</md></div></details>',
    );
  });
});

/**
 * The `↻ Re-run ▾` menu, driven through the REAL script.
 *
 * A tiny fake DOM rather than a browser: what is worth pinning here is the
 * DECISIONS the client makes — which items it disables and why, what the copy
 * says, and the two guards that only fire on a race — and none of that needs
 * layout. The end-to-end behaviour is `e2e/summaries-rerun.spec.ts`.
 */

interface FakeNode {
  tag: string;
  className: string;
  textContent: string;
  title: string;
  disabled: boolean;
  hidden: boolean;
  innerHTML: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  classes: Set<string>;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeNode): FakeNode;
  addEventListener(): void;
  focus(): void;
  querySelectorAll(sel: string): FakeNode[];
  contains(): boolean;
}

function fakeNode(tag: string): FakeNode {
  const classes = new Set<string>();
  const node: FakeNode = {
    tag,
    className: "",
    textContent: "",
    title: "",
    disabled: false,
    hidden: false,
    innerHTML: "",
    attrs: {},
    children: [],
    classes,
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      toggle: (c, on) => void (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    appendChild(child) {
      // `textContent = ''` is how the script empties the popup, so the children
      // list has to be cleared with it or every render would stack.
      this.children.push(child);
      return child;
    },
    addEventListener() {},
    focus() {},
    querySelectorAll() { return []; },
    contains() { return false; },
  };
  return node;
}

interface RerunHarness {
  renderRerunMenu: (opts: Record<string, unknown>) => void;
  rerunSameLabel: (opts: Record<string, unknown>) => string;
  rerunPanelShows: (doc: unknown) => boolean;
  showRerunPrompt: () => void;
  startRerun: (extra: Record<string, unknown>) => void;
  resetRerunControl: (source: string) => void;
  setDoc: (doc: unknown) => void;
  setOpts: (opts: unknown) => void;
  menu: FakeNode;
  status: FakeNode;
  overlay: FakeNode;
  wrap: FakeNode;
  snapshots: unknown[];
  shownJobs: unknown[][];
  streams: string[];
}

function loadRerun(): RerunHarness {
  const menu = fakeNode("div");
  const status = fakeNode("div");
  const overlay = fakeNode("div");
  const wrap = fakeNode("span");
  const byId: Record<string, FakeNode> = {
    docPanelRerunMenu: menu,
    docPanelRerunStatus: status,
    docOverlay: overlay,
    docPanelRerunWrap: wrap,
  };
  const snapshots: unknown[] = [];
  const shownJobs: unknown[][] = [];
  const streams: string[] = [];
  const ctx = {
    document: {
      addEventListener() {},
      getElementById: (id: string) => byId[id] ?? null,
      createElement: (tag: string) => fakeNode(tag),
      activeElement: null,
    },
    SOURCES: {
      youtube: { apiBase: "/api/youtube", collection: "youtube-summaries", rerun: true },
      article: { apiBase: "/api/articles", collection: "article-summaries", rerun: false },
    },
    snapshots,
    shownJobs,
    streams,
  };
  const harness = new Function(
    "ctx",
    `var document = ctx.document;
     var SOURCES = ctx.SOURCES;
     var renderMarkdown = function(t) { return t; };
     var showPromptSnapshot = function(data, key, opts) { ctx.snapshots.push({ data: data, key: key, opts: opts }); };
     var showJob = function() { ctx.shownJobs.push(Array.prototype.slice.call(arguments)); };
     var connectSSE = function(jobId, source) { ctx.streams.push('shelf:' + jobId + ':' + source); };
     var sseClient = function(url) { ctx.streams.push('panel:' + url); return { close: function() {} }; };
     ${sumArticleLibraryScript()}
     return {
       renderRerunMenu: renderRerunMenu,
       rerunSameLabel: rerunSameLabel,
       rerunPanelShows: rerunPanelShows,
       showRerunPrompt: showRerunPrompt,
       startRerun: startRerun,
       resetRerunControl: resetRerunControl,
       setDoc: function(d) { _shareDoc = d; },
       setOpts: function(o) { _rerunOpts = o; },
     };`,
  )(ctx) as Omit<
    RerunHarness,
    "menu" | "status" | "overlay" | "wrap" | "snapshots" | "shownJobs" | "streams"
  >;
  return { ...harness, menu, status, overlay, wrap, snapshots, shownJobs, streams };
}

/** Every item, its label and whether it is offered. */
function menuItems(menu: FakeNode): Array<{ label: string; disabled: boolean; title: string }> {
  return menu.children
    .filter((c) => c.className === "doc-panel-menu-item")
    .map((c) => ({ label: c.textContent, disabled: c.disabled, title: c.title }));
}
function menuNotes(menu: FakeNode): string[] {
  return menu.children.filter((c) => c.className === "doc-panel-menu-note").map((c) => c.textContent);
}

const READY_OPTS = {
  hasTranscript: true,
  truncated: false,
  windowed: true,
  kinds: [
    { id: "standard", label: "Standard" },
    { id: "talk-notes", label: "Talk notes (timeline)" },
  ],
  storedKind: "standard",
  defaultKind: "standard",
  titleRoundTrip: { ok: true, reason: null },
  framesKept: 0,
  promptUrl: "https://www.youtube.com/watch?v=abcdefghijk",
  full: { supported: false, reason: "A full re-fetch is not available yet: …" },
};

describe("renderRerunMenu", () => {
  test("the stored kind is not offered twice, and the others are", () => {
    const h = loadRerun();
    h.renderRerunMenu({ ...READY_OPTS });
    const items = menuItems(h.menu);
    expect(items.map((i) => i.label)).toEqual([
      "Same settings again",
      "As Talk notes (timeline)",
      "Full re-fetch — download the source again",
      "Show prompt",
    ]);
    expect(items[0]!.disabled).toBe(false);
    expect(items[1]!.disabled).toBe(false);
  });

  test("a kind-less document names the kind that will run, and hides that kind's own item", () => {
    const h = loadRerun();
    h.renderRerunMenu({ ...READY_OPTS, storedKind: null });
    const items = menuItems(h.menu);
    expect(items[0]!.label).toBe("Same settings again (standard; written before kinds existed)");
    // `standard` IS "Same settings again" here, so offering it again would read
    // as two different actions.
    expect(items.map((i) => i.label)).not.toContain("As Standard");
  });

  test("no transcript disables every run item and says what is needed", () => {
    const h = loadRerun();
    h.renderRerunMenu({ ...READY_OPTS, hasTranscript: false });
    const items = menuItems(h.menu);
    expect(items[0]!.disabled).toBe(true);
    expect(items[1]!.disabled).toBe(true);
    const notes = menuNotes(h.menu).join(" ");
    expect(notes).toContain("This summary stored no transcript. Re-running needs one; a full re-fetch is a follow-up.");
    // The claim the old copy made — that a full re-fetch is the way out — while
    // that item is disabled everywhere.
    expect(notes).not.toContain("can only be re-run by downloading the source again");
  });

  test("a title that does not round-trip disables the run items and carries the reason", () => {
    const h = loadRerun();
    const reason = "This document's file name is 240 characters…";
    h.renderRerunMenu({ ...READY_OPTS, titleRoundTrip: { ok: false, reason } });
    const items = menuItems(h.menu);
    expect(items[0]).toEqual({ label: "Same settings again", disabled: true, title: reason });
    expect(items[1]!.disabled).toBe(true);
    expect(menuNotes(h.menu)).toContain(reason);
    // "Show prompt" is about the PREVIOUS run and is unaffected.
    expect(items[3]).toEqual({ label: "Show prompt", disabled: false, title: "" });
  });

  test("Full re-fetch is disabled and its reason rides ONE node, directly under it", () => {
    const h = loadRerun();
    h.renderRerunMenu({ ...READY_OPTS });
    const full = menuItems(h.menu).find((i) => i.label.startsWith("Full re-fetch"))!;
    expect(full.disabled).toBe(true);
    // It rode BOTH the item's tooltip and a note three nodes below it — the
    // same sentence twice, and the copy furthest from the item was the one a
    // reader saw, where it read as a statement about the whole menu.
    expect(full.title).toBe("");
    const idx = h.menu.children.findIndex((c) => c.textContent.startsWith("Full re-fetch"));
    expect(h.menu.children[idx + 1]!.textContent).toBe(READY_OPTS.full.reason);
    expect(h.menu.children.filter((c) => c.textContent === READY_OPTS.full.reason)).toHaveLength(1);
  });

  test("a document with no stored url disables Show prompt with the reason", () => {
    const h = loadRerun();
    h.renderRerunMenu({ ...READY_OPTS, promptUrl: "" });
    const show = menuItems(h.menu).find((i) => i.label === "Show prompt")!;
    expect(show.disabled).toBe(true);
    expect(show.title).toContain("stores no URL");
  });

  test("the visual-detail line says the answer is DERIVED, because it is", () => {
    const h = loadRerun();
    h.renderRerunMenu({ ...READY_OPTS, storedVisualDetail: "detailed" });
    const line = menuNotes(h.menu).find((n) => n.startsWith("Visual detail:"))!;
    expect(line).toBe("Visual detail: detailed (derived from the stored summary, not a field it carries).");
    expect(line).not.toContain("as stored");
  });

  test("the frames and truncation notes report what the run will actually have", () => {
    const h = loadRerun();
    h.renderRerunMenu({ ...READY_OPTS, framesKept: 5, truncated: true });
    const notes = menuNotes(h.menu).join(" ");
    expect(notes).toContain("only the 5 frame(s) the previous summary quoted");
    expect(notes).toContain("truncated at capture");
  });

  test("rules and notes are role=presentation, so role=menu holds only menuitems", () => {
    const h = loadRerun();
    h.renderRerunMenu({ ...READY_OPTS });
    for (const child of h.menu.children) {
      const role = child.getAttribute("role");
      expect([child.className, role]).toEqual([
        child.className,
        child.className === "doc-panel-menu-item" ? "menuitem" : "presentation",
      ]);
    }
  });
});

describe("the panel-still-visible check", () => {
  test("a closed panel is not reloaded into, and neither is one on another document", () => {
    const h = loadRerun();
    const doc = { docId: "ai/general/A.md", source: "youtube", title: "A", url: "", text: "old" };
    h.setDoc(doc);
    // Panel closed: `complete` used to call openSummaryDoc unconditionally, which
    // re-opened a scrim over a page the reader had left and locked its scroll.
    expect(h.rerunPanelShows(doc)).toBe(false);
    h.overlay.classList.add("visible");
    expect(h.rerunPanelShows(doc)).toBe(true);
    // Retargeted to a different document while the run was going.
    h.setDoc({ docId: "ai/general/B.md", source: "youtube", title: "B", url: "", text: "" });
    expect(h.rerunPanelShows(doc)).toBe(false);
  });
});

describe("showRerunPrompt after a retarget", () => {
  test("a superseded fetch bails silently instead of reading a nulled _rerunOpts", async () => {
    const h = loadRerun();
    h.overlay.classList.add("visible");
    h.setDoc({ docId: "ai/general/A.md", source: "youtube", title: "A", url: "", text: "" });
    h.setOpts({ promptUrl: "https://www.youtube.com/watch?v=abcdefghijk" });

    let resolveFetch: (v: unknown) => void = () => {};
    const pending = new Promise((r) => { resolveFetch = r; });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = () => pending;
    try {
      h.showRerunPrompt();
      // The reader retargets the panel mid-flight — exactly what
      // `resetRerunControl` does, `_rerunOpts` included.
      h.setDoc({ docId: "ai/general/B.md", source: "youtube", title: "B", url: "", text: "" });
      h.setOpts(null);
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({ systemPrompt: "s", userPrompt: "u", pass: "claude", createdAt: 0, traceExists: false }),
      });
      await new Promise((r) => setTimeout(r, 5));
      // Nothing painted: the modal belongs to a document no longer on screen.
      expect(h.snapshots).toEqual([]);
      // And nothing REPORTED either. Re-reading `_rerunOpts` in the continuation
      // threw `Cannot read properties of null`, which the promise chain's own
      // catch turned into an error line on a panel showing another document —
      // so "snapshots is empty" alone cannot tell the guard from the crash.
      expect(h.status.classes.has("err")).toBe(false);
      expect(h.status.textContent).not.toContain("Could not load the prompt");
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  test("the prompt modal is opened with the pass chip suppressed", async () => {
    const h = loadRerun();
    h.overlay.classList.add("visible");
    h.setDoc({ docId: "ai/general/A.md", source: "youtube", title: "A", url: "", text: "" });
    h.setOpts({ promptUrl: "https://www.youtube.com/watch?v=abcdefghijk" });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ systemPrompt: "s", userPrompt: "u", pass: "claude", createdAt: 0, traceExists: false }),
    });
    try {
      h.showRerunPrompt();
      await new Promise((r) => setTimeout(r, 5));
      expect(h.snapshots).toHaveLength(1);
      // The chip names one of a CAPTURE's two model calls, which this surface
      // never offers a choice between.
      expect((h.snapshots[0] as { opts: unknown }).opts).toEqual({ hidePass: true });
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });
});


/**
 * The four client behaviours the round-1 mutation survey found UNPINNED — each
 * one survived both this file and the e2e. Two more of the six (focus restore
 * on close, and the arrow keys) need a real focus model and are pinned in
 * `e2e/summaries-rerun.spec.ts` instead; the `aria-haspopup` markup is pinned
 * in `doc-panel.test.ts`.
 */
describe("the re-run client's unpinned halves", () => {
  const DOC = {
    docId: "ai/general/A.md",
    source: "youtube",
    title: "A talk",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    text: "the body on screen",
  };

  test("startRerun hands the shelf card the document's URL", () => {
    // Without it the live card's title links nowhere, where a capture's links
    // back to the source. `''` is the deliberate fallback for a doc with none —
    // `undefined` would render the string "undefined" as an href.
    const h = loadRerun();
    h.overlay.classList.add("visible");
    h.setDoc(DOC);
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ job_id: "job-1" }),
    });
    try {
      h.startRerun({});
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(h.shownJobs).toHaveLength(1);
          expect(h.shownJobs[0]).toEqual(["job-1", DOC.title, DOC.url, DOC.source]);
          resolve();
        }, 5);
      });
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  test("a doc with no stored url passes the empty string, never undefined", async () => {
    const h = loadRerun();
    h.overlay.classList.add("visible");
    h.setDoc({ ...DOC, url: "" });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ job_id: "job-2" }),
    });
    try {
      h.startRerun({});
      await new Promise((r) => setTimeout(r, 5));
      expect(h.shownJobs[0]![2]).toBe("");
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  test("ONE stream per re-run: the panel opens it, and the retarget hands it to the shelf", async () => {
    // Two failures, one property. Opening `connectSSE` at `startRerun` as well
    // puts TWO EventSources on one job — the card is behind a fixed scrim, so
    // the second is fan-out nobody can see. Dropping the hand-off leaves the
    // shelf card dead once the panel closes.
    const h = loadRerun();
    h.overlay.classList.add("visible");
    h.setDoc(DOC);
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ job_id: "job-3" }),
    });
    try {
      h.startRerun({});
      await new Promise((r) => setTimeout(r, 5));
      // While the panel is open: exactly the panel's own stream.
      expect(h.streams).toEqual(["panel:/api/youtube/stream/job-3"]);
      // Retargeting the panel is the hand-off — the job is real either way.
      h.resetRerunControl("youtube");
      expect(h.streams).toEqual(["panel:/api/youtube/stream/job-3", "shelf:job-3:youtube"]);
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  test("a superseded prompt fetch that REJECTS is silent too", async () => {
    // The `.then` half of this guard is pinned above. Dropping only the `.catch`
    // half survived that test: the panel then reports a network error against a
    // document the reader has already left.
    const h = loadRerun();
    h.overlay.classList.add("visible");
    h.setDoc(DOC);
    h.setOpts({ promptUrl: DOC.url });
    let rejectFetch: (e: unknown) => void = () => {};
    const pending = new Promise((_r, rej) => { rejectFetch = rej; });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = () => pending;
    try {
      h.showRerunPrompt();
      h.setDoc({ ...DOC, docId: "ai/general/B.md" });
      h.setOpts(null);
      rejectFetch(new Error("network went away"));
      await new Promise((r) => setTimeout(r, 5));
      expect(h.status.classes.has("err")).toBe(false);
      expect(h.status.textContent).not.toContain("network went away");
      expect(h.status.textContent).not.toContain("Could not load the prompt");
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  test("the ↻ control is hidden on a source the registry does not flag `rerun`", () => {
    // `rerunSupported` reads `SOURCES[source].rerun`, the projection the server
    // emits from the ONE registry the route asserts against at module load. A
    // control rendered on `article` could only ever 400.
    const h = loadRerun();
    h.setDoc(DOC);
    h.resetRerunControl("youtube");
    expect(h.wrap.hidden).toBe(false);
    h.resetRerunControl("article");
    expect(h.wrap.hidden).toBe(true);
    // An unregistered id is hidden too, rather than throwing on the lookup.
    h.resetRerunControl("bogus");
    expect(h.wrap.hidden).toBe(true);
    // …and with no document open there is nothing to re-run whatever the source.
    h.setDoc(null);
    h.resetRerunControl("youtube");
    expect(h.wrap.hidden).toBe(true);
  });
});
