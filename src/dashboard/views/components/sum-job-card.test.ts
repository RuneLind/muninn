import { describe, expect, test } from "bun:test";
import { sumJobCardHtml, sumJobCardScript, sumJobCardStyles } from "./sum-job-card.ts";

/**
 * The Vimeo sentence map, driven out of the REAL injected script.
 *
 * Every route refusal and the one job-error code that is not a message
 * (`no_captions`) render as a sentence about the VIDEO rather than as a generic
 * failure, and all of them live in ONE map — a code spelled in two places drifts
 * into a card reporting "Error" for a video Vimeo simply declined to describe.
 * These cases are what makes removing an entry a test failure rather than a
 * silently generic card.
 *
 * The DOM is stubbed, not emulated (the `jira-entry.test.ts` precedent), so the
 * banner assertions read the text the script actually wrote.
 */

interface Harness {
  vimeoSentence: (code: string, data?: unknown) => string | null;
  showError: (message: string) => void;
  showCaptureOutcome: (url: string, opts: Record<string, unknown>) => void;
  setSource: (source: string) => void;
  bannerText: () => string;
  bannerClasses: () => string[];
  badgeHtml: () => string;
  appended: () => string[];
}

function harness(): Harness {
  const classes: Record<string, Set<string>> = {};
  const text: Record<string, string> = {};
  const html: Record<string, string> = {};
  const appended: string[] = [];

  const element = (id: string) => {
    classes[id] = new Set<string>();
    return {
      addEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      hasAttribute: () => false,
      appendChild(node: { text?: string }) {
        appended.push(node.text ?? "");
      },
      querySelectorAll: () => [],
      style: {},
      get className() {
        return [...classes[id]!].join(" ");
      },
      set className(v: string) {
        classes[id] = new Set(v.split(/\s+/).filter(Boolean));
      },
      get textContent() {
        return text[id] ?? "";
      },
      set textContent(v: string) {
        text[id] = v;
      },
      get innerHTML() {
        return html[id] ?? "";
      },
      set innerHTML(v: string) {
        html[id] = v;
      },
      classList: {
        add: (c: string) => classes[id]!.add(c),
        remove: (c: string) => classes[id]!.delete(c),
        toggle: (c: string, on?: boolean) => {
          if (on === undefined) {
            if (classes[id]!.has(c)) classes[id]!.delete(c);
            else classes[id]!.add(c);
          } else if (on) classes[id]!.add(c);
          else classes[id]!.delete(c);
        },
        contains: (c: string) => classes[id]!.has(c),
      },
    };
  };

  const nodes: Record<string, ReturnType<typeof element>> = {};
  const doc = {
    getElementById: (id: string) => (nodes[id] ??= element(id)),
    // The link half of a duplicate outcome — recorded as text so the assertion
    // can see the label without a real DOM.
    createElement: () => ({ href: "", text: "", set textContent(v: string) { this.text = v; } }),
    createTextNode: (t: string) => ({ text: t }),
  };

  const ctx = {
    document: doc,
    esc: (s: string) => s,
    marked: undefined,
    sseClient: () => ({ close() {} }),
    openSummaryDoc: () => {},
    SOURCES: { vimeo: { apiBase: "/api/vimeo" } },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  };

  const prelude = [
    "var document = ctx.document;",
    "var esc = ctx.esc;",
    "var marked = ctx.marked;",
    "var sseClient = ctx.sseClient;",
    "var openSummaryDoc = ctx.openSummaryDoc;",
    "var SOURCES = ctx.SOURCES;",
    "var fetch = ctx.fetch;",
  ].join("\n");

  const made = new Function(
    "ctx",
    `${prelude}\n${sumJobCardScript()}\n` +
      "return { vimeoSentence: vimeoSentence, showError: showError," +
      " showCaptureOutcome: showCaptureOutcome," +
      " setSource: function(s) { currentSource = s; } };",
  )(ctx) as Pick<Harness, "vimeoSentence" | "showError" | "showCaptureOutcome" | "setSource">;

  return {
    ...made,
    bannerText: () => text.errorBanner ?? "",
    bannerClasses: () => [...(classes.errorBanner ?? [])],
    badgeHtml: () => html.statusBadge ?? "",
    appended: () => appended,
  };
}

describe("sum-job-card: the Vimeo sentence map", () => {
  const h = harness();

  test("names every route refusal", () => {
    expect(h.vimeoSentence("bad_url")).toBe("Not a Vimeo video URL");
    expect(h.vimeoSentence("not_public")).toBe("Vimeo says this video is not public");
    expect(h.vimeoSentence("duration_unknown")).toBe(
      "Vimeo did not report a duration, so the 3 h cap cannot be checked",
    );
    expect(h.vimeoSentence("oembed_failed")).toBe("Vimeo did not answer");
  });

  test("names the two answers that are not refusals", () => {
    expect(h.vimeoSentence("duplicate")).toBe("Already captured");
    expect(h.vimeoSentence("in_flight")).toBe("Already being captured");
  });

  test("names the one job-error CODE, which is a fact about the video", () => {
    expect(h.vimeoSentence("no_captions")).toBe("This video has no caption track");
  });

  test("too_long carries the measurement the route reported", () => {
    expect(h.vimeoSentence("too_long", { durationSec: 20000 })).toBe(
      "Longer than the 3 h cap (5h 33m)",
    );
    expect(h.vimeoSentence("too_long", { durationSec: 10801 })).toBe(
      "Longer than the 3 h cap (3h 0m)",
    );
    // A duration the route did not report degrades to the cap alone rather than
    // to "NaNh NaNm".
    expect(h.vimeoSentence("too_long", {})).toBe("Longer than the 3 h cap");
    expect(h.vimeoSentence("too_long")).toBe("Longer than the 3 h cap");
  });

  test("an unknown code has no sentence, so the caller can fall back", () => {
    expect(h.vimeoSentence("something_else")).toBeNull();
  });
});

describe("sum-job-card: showError", () => {
  test("translates a vimeo job's error CODE into the sentence", () => {
    const h = harness();
    h.setSource("vimeo");
    h.showError("no_captions");
    expect(h.bannerText()).toBe("This video has no caption track");
  });

  test("leaves another vertical's error message alone", () => {
    const h = harness();
    h.setSource("youtube");
    h.showError("no_captions");
    expect(h.bannerText()).toBe("no_captions");
  });

  test("leaves a vimeo message that is not a code alone", () => {
    const h = harness();
    h.setSource("vimeo");
    h.showError("yt-dlp exited with code 1");
    expect(h.bannerText()).toBe("yt-dlp exited with code 1");
  });
});

describe("sum-job-card: showCaptureOutcome", () => {
  test("a refusal renders the sentence in the error tone", () => {
    const h = harness();
    h.showCaptureOutcome("https://vimeo.com/1", {
      status: "error",
      sentence: "Vimeo says this video is not public",
    });
    expect(h.bannerText()).toBe("Vimeo says this video is not public");
    expect(h.bannerClasses()).toContain("visible");
    expect(h.bannerClasses()).not.toContain("notice");
    expect(h.badgeHtml()).toContain("Error");
  });

  test("a duplicate renders the notice tone plus a link to the stored document", () => {
    const h = harness();
    h.showCaptureOutcome("https://vimeo.com/1", {
      status: "duplicate",
      tone: "notice",
      sentence: "Already captured",
      link: "/summaries?source=vimeo&doc=x&duplicate=1",
      linkLabel: "open the summary",
    });
    expect(h.bannerText()).toBe("Already captured");
    expect(h.bannerClasses()).toContain("notice");
    expect(h.appended()).toContain(" — ");
    expect(h.badgeHtml()).toContain("Already captured");
  });
});

describe("sum-job-card: the duplicate badge", () => {
  test("is terminal (no spinner) and has a tone of its own", () => {
    const h = harness();
    h.showCaptureOutcome("https://vimeo.com/1", {
      status: "duplicate",
      sentence: "Already captured",
    });
    expect(h.badgeHtml()).not.toContain("spinner");
    expect(sumJobCardStyles()).toContain(".status-duplicate");
  });

  test("the banner's tone is overridable — its border is no longer inline", () => {
    // An inline `style=` wins over every stylesheet rule, so the notice tone
    // could not repaint the red top border while it lived on the element.
    expect(sumJobCardHtml()).toContain('<div class="error-banner" id="errorBanner"></div>');
    expect(sumJobCardStyles()).toContain("#errorBanner.notice");
  });
});
